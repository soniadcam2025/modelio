"""Find out how the LIVE @ShakhiraVIPBot receives its updates, without disturbing it.

  TELEGRAM_BOT_TOKEN=... python tools/identify_live_bot.py [--vip-channel -100...] [--json]

Only read-only Bot API methods are called: getMe, getWebhookInfo, getMyCommands,
getMyDescription, getMyShortDescription, getChat, getChatMemberCount. It NEVER calls getUpdates
(that would steal updates from the live bot) and never changes anything.

What the answer means:
- A webhook URL is set  -> the live bot runs as a web service at that host. The host name (and the
  IP Telegram reports) point to where it is deployed: e.g. *.onrender.com = Render,
  *.up.railway.app = Railway, *.run.app / *.appspot.com = Google Cloud, a plain IP or own domain = a VPS.
- No webhook             -> the live bot uses long polling from some always-on machine. Look for it
  in your hosting accounts (VPS, Render/Railway workers, a home PC) and check which one is running.
"""

import argparse
import json
import os
import sys
from urllib.parse import urlparse

import httpx

READ_ONLY_METHODS = ("getMe", "getWebhookInfo", "getMyCommands", "getMyDescription", "getMyShortDescription",
                     "getChat", "getChatMemberCount")
HOST_HINTS = [
    (".onrender.com", "Render"), (".up.railway.app", "Railway"), (".railway.app", "Railway"),
    (".run.app", "Google Cloud Run"), (".appspot.com", "Google App Engine"), (".cloudfunctions.net", "Google Cloud Functions"),
    (".herokuapp.com", "Heroku"), (".fly.dev", "Fly.io"), (".vercel.app", "Vercel"), (".netlify.app", "Netlify"),
    (".pythonanywhere.com", "PythonAnywhere"), (".replit.app", "Replit"), (".repl.co", "Replit"),
    (".workers.dev", "Cloudflare Workers"), (".amazonaws.com", "AWS"), (".azurewebsites.net", "Azure"),
    (".koyeb.app", "Koyeb"), (".glitch.me", "Glitch"), ("ngrok", "ngrok tunnel (a developer's own computer)"),
]


class Inspector:
    def __init__(self, token: str, client: httpx.Client | None = None):
        self._base = f"https://api.telegram.org/bot{token}/"
        self._client = client or httpx.Client(timeout=20)

    def call(self, method: str, **params):
        if method not in READ_ONLY_METHODS:
            raise RuntimeError(f"{method} is not on the read-only list")
        try:
            body = self._client.post(self._base + method, data=params).json()
        except (httpx.HTTPError, ValueError) as exc:
            return None, f"{type(exc).__name__}"
        if not body.get("ok"):
            return None, str(body.get("description", "error"))
        return body.get("result"), None


def guess_host(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    for suffix, name in HOST_HINTS:
        if suffix in host:
            return name
    if host.replace(".", "").isdigit():
        return "a server reached by IP address (most likely a VPS)"
    return "your own domain (most likely a VPS or a custom-domain cloud service)"


def inspect(inspector: Inspector, public_channel: str = "@yourshakhira", vip_channel: str | None = None) -> dict:
    report: dict = {}
    me, err = inspector.call("getMe")
    if err:
        return {"error": f"Telegram rejected the token or is unreachable: {err}"}
    report["bot"] = {"username": me.get("username"), "id": me.get("id"),
                     "can_join_groups": me.get("can_join_groups"), "supports_inline": me.get("supports_inline_queries")}
    hook, _ = inspector.call("getWebhookInfo")
    hook = hook or {}
    url = hook.get("url") or ""
    report["delivery"] = {
        "mode": "webhook" if url else "long polling (no webhook set)",
        "webhook_host": urlparse(url).hostname if url else None,  # host only: the path can hold a secret
        "likely_hosting": guess_host(url) if url else "an always-on machine that polls Telegram (VPS, worker service or PC)",
        "ip_address": hook.get("ip_address"),
        "pending_updates": hook.get("pending_update_count"),
        "last_error": hook.get("last_error_message"),
        "last_error_date": hook.get("last_error_date"),
        "allowed_updates": hook.get("allowed_updates"),
        "max_connections": hook.get("max_connections"),
    }
    commands, _ = inspector.call("getMyCommands")
    report["commands"] = [f"/{c['command']} - {c['description']}" for c in (commands or [])]
    desc, _ = inspector.call("getMyDescription")
    short, _ = inspector.call("getMyShortDescription")
    report["description"] = (desc or {}).get("description")
    report["short_description"] = (short or {}).get("short_description")
    for label, chat_id in (("public_channel", public_channel), ("vip_channel", vip_channel)):
        if not chat_id:
            continue
        chat, err = inspector.call("getChat", chat_id=chat_id)
        count, _ = inspector.call("getChatMemberCount", chat_id=chat_id)
        report[label] = {"error": err} if err else {
            "id": chat.get("id"), "title": chat.get("title"), "username": chat.get("username"), "members": count,
            "has_linked_discussion_group": chat.get("linked_chat_id") is not None,
            "linked_chat_id": chat.get("linked_chat_id"), "join_by_request": chat.get("join_by_request"),
        }
    return report


def mask_ip(ip: str | None) -> str:
    """Keep only the network part of an IP for logs that others can read (e.g. a public repo's Actions logs)."""
    if not ip:
        return "unknown"
    if ":" in ip:  # IPv6
        return ":".join(ip.split(":")[:2]) + ":…"
    parts = ip.split(".")
    return ".".join(parts[:2] + ["x", "x"]) if len(parts) == 4 else "hidden"


def public_safe(report: dict) -> dict:
    """A copy without values that should not appear in a public log."""
    if "delivery" not in report:
        return report
    host = report["delivery"]["webhook_host"]
    if host and host.count(".") >= 2:  # keep the provider (e.g. workers.dev), hide the account-specific labels
        host = "…." + ".".join(host.split(".")[-2:])
    safe = {**report, "delivery": {**report["delivery"], "ip_address": mask_ip(report["delivery"]["ip_address"]),
                                   "webhook_host": host}}
    safe.pop("vip_channel", None)
    return safe


def render(report: dict) -> str:
    if "error" in report:
        return report["error"]
    d = report["delivery"]
    lines = [
        f"Bot: @{report['bot']['username']} (id {report['bot']['id']})",
        f"Receives updates by: {d['mode']}",
        f"Likely hosting: {d['likely_hosting']}",
    ]
    if d["webhook_host"]:
        lines.append(f"Webhook host: {d['webhook_host']}  (IP {d['ip_address'] or 'unknown'})")
    lines.append(f"Updates waiting: {d['pending_updates']}" + (f"  Last error: {d['last_error']}" if d["last_error"] else ""))
    if report["commands"]:
        lines.append("Commands: " + "; ".join(report["commands"]))
    for label in ("public_channel", "vip_channel"):
        if label in report:
            c = report[label]
            lines.append(f"{label}: " + (c["error"] if "error" in c else
                         f"{c['title']} ({c['id']}), {c['members']} members, discussion group: "
                         f"{'yes ' + str(c['linked_chat_id']) if c['has_linked_discussion_group'] else 'no'}"))
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--public-channel", default=os.getenv("PUBLIC_CHANNEL", "@yourshakhira"))
    parser.add_argument("--vip-channel", default=os.getenv("VIP_CHANNEL_ID"))
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--public-log", action="store_true",
                        help="mask the IP and leave out the VIP channel (for logs others can read)")
    args = parser.parse_args(argv)
    token = (os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("BOT_TOKEN") or "").strip()
    if not token:
        print("Set TELEGRAM_BOT_TOKEN (never paste it into a chat or a file in the repo).", file=sys.stderr)
        return 2
    report = inspect(Inspector(token), args.public_channel, None if args.public_log else args.vip_channel)
    if args.public_log:
        report = public_safe(report)
    print(json.dumps(report, indent=2) if args.json else render(report))
    return 1 if "error" in report else 0


if __name__ == "__main__":
    sys.exit(main())
