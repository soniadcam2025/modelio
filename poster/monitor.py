"""Make every run's outcome visible: GitHub annotations, the run summary page, and admin alerts.

- Annotations (::notice / ::warning / ::error lines) appear on the workflow run page, so a run that
  posted is distinguishable at a glance from one that did not.
- The job summary ($GITHUB_STEP_SUMMARY) shows a small table: status, asset, message ID, remaining.
- Admin alerts go to ADMIN_CHAT_ID (if set) by Telegram, but only for real runs against the public
  channel. Dry runs, checks, reports and test-channel posts never send alerts.
"""

import logging
from datetime import datetime, timedelta, timezone

from .config import PosterConfig
from .runner import Inventory, Result
from .slots import expected_slots, slot_time

logger = logging.getLogger(__name__)


def _escape(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def annotation(level: str, title: str, message: str) -> str:
    return f"::{level} title={_escape(title).replace(',', '%2C').replace(':', '%3A')}::{_escape(message)}"


def assess(result: Result, cfg: PosterConfig) -> list[tuple[str, str, str]]:
    """(level, title, message) for this result. level is notice, warning or error."""
    out = []
    where = f" Slot {result.slot}." if result.slot else ""
    if result.status == "posted":
        out.append(("notice", "Posted", f"Posted {result.asset} (message {result.message_id}).{where}"))
        if result.remaining is not None and result.remaining < cfg.low_stock_threshold:
            out.append(("warning", "Low content",
                        f"Only {result.remaining} unpublished asset(s) left in Cloudinary folder '{cfg.folder}'. "
                        "Upload more media soon, or posting will stop."))
    elif result.status == "already_posted":
        out.append(("notice", "Already posted", f"Nothing posted: {result.detail}.{where}"))
    elif result.status == "dry_run":
        out.append(("notice", "Dry run", f"Would post {result.asset}; {result.remaining} unpublished asset(s)."))
    elif result.status == "no_content":
        out.append(("error", "No content to post",
                    f"Nothing was posted: {result.detail}. Upload new media to Cloudinary folder '{cfg.folder}'. "
                    "Previously posted media is not reused unless you set POST_WHEN_EXHAUSTED=restart."))
    elif result.status == "unrecorded":
        out.append(("error", "Posted but not recorded",
                    f"{result.asset} WAS posted (message {result.message_id}) but the tag could not be saved: "
                    f"{result.detail}. Add the tag tgbot_posted to it in Cloudinary by hand."))
    else:  # failed, uncertain, nothing_to_post
        out.append(("error", f"Post {result.status}", f"Nothing was posted: {result.detail or result.status}.{where}"))
    return out


def alert_text(result: Result, cfg: PosterConfig) -> str | None:
    """Text for the admin, or None when nothing needs attention."""
    problems = [(level, title, msg) for level, title, msg in assess(result, cfg) if level != "notice"]
    if not problems:
        return None
    lines = [f"{'❌' if level == 'error' else '⚠️'} {title}: {msg}" for level, title, msg in problems]
    return f"Channel poster ({cfg.public_channel})\n\n" + "\n\n".join(lines)


def summary_markdown(result: Result, cfg: PosterConfig, target: str) -> str:
    rows = [
        ("Result", f"**{result.status}**"),
        ("Channel", target),
        ("Slot", result.slot or "—"),
        ("Asset", result.asset or "—"),
        ("Telegram message", str(result.message_id) if result.message_id else "—"),
        ("Unpublished assets left", "—" if result.remaining is None else str(result.remaining)),
        ("Detail", result.detail or "—"),
    ]
    lines = ["### Channel poster", "", "| | |", "|---|---|"] + [f"| {k} | {v} |" for k, v in rows]
    for level, title, msg in assess(result, cfg):
        if level != "notice":
            lines += ["", f"> **{title}:** {msg}"]
    return "\n".join(lines) + "\n"


def report_markdown(inv: Inventory, cfg: PosterConfig, now: float, days: int = 7) -> str:
    """Folder inventory plus which scheduled slots in the last `days` days got a post."""
    lines = [
        "### Posting report", "",
        "| | |", "|---|---|",
        f"| Assets in '{cfg.folder}' | {inv.total} |",
        f"| Supported photos/videos | {inv.supported} |",
        f"| Posted | {inv.posted} |",
        f"| **Unpublished (left to post)** | **{inv.remaining}** |",
        f"| Uncertain (check by hand) | {inv.uncertain} |",
        f"| Rejected by Telegram | {inv.rejected} |",
        f"| Unsupported or too large | {inv.unsupported} |",
    ]
    if inv.remaining < cfg.low_stock_threshold:
        lines += ["", f"> **Low content:** only {inv.remaining} unpublished asset(s) left."]
    posted_slots = {slot for slot, _ in inv.slots}
    if posted_slots:
        until = datetime.fromtimestamp(now, tz=timezone.utc)
        # Slot tags exist only for posts made since slot tracking was added; don't report older slots.
        since = max(until - timedelta(days=days), slot_time(min(posted_slots)) - timedelta(seconds=1))
        expected = expected_slots(list(cfg.slot_times), since, until)
        missed = [s for s in expected if s not in posted_slots]
        lines += ["", f"**Scheduled slots in the last {days} days:** {len(expected)} expected, "
                  f"{len(expected) - len(missed)} posted, {len(missed)} missed."]
        if missed:
            lines += ["", "Missed slots (UTC): " + ", ".join(missed)]
        lines += ["", "| Slot (UTC) | Asset |", "|---|---|"] + [f"| {s} | {a} |" for s, a in inv.slots[:14]]
    else:
        lines += ["", "No slot-tagged posts yet (slot tracking starts with the first scheduled post after this update)."]
    return "\n".join(lines) + "\n"


def emit(lines: list[str], summary: str, env: dict, out=print) -> None:
    """Print annotations and append the summary to the GitHub job summary, if running in Actions."""
    for line in lines:
        out(line)
    path = env.get("GITHUB_STEP_SUMMARY")
    if path:
        try:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(summary)
        except OSError:
            logger.warning("Could not write the job summary")


def report_result(result: Result, cfg: PosterConfig, target: str, publisher, *, production: bool,
                  env: dict, out=print) -> None:
    """Show the outcome in GitHub, and alert the admin for real public-channel runs that need attention."""
    lines = [annotation(level, title, msg) for level, title, msg in assess(result, cfg)]
    emit(lines, summary_markdown(result, cfg, target), env, out)
    text = alert_text(result, cfg)
    if not (production and text and cfg.admin_chat_id):
        return
    try:
        publisher.send_message(cfg.admin_chat_id, text)
        logger.info("Admin alert sent")
    except Exception as exc:  # noqa: BLE001 - an alert must never change the run's outcome
        logger.warning("Could not send the admin alert: %s", type(exc).__name__)
