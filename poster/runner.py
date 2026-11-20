"""One posting run: pick an unposted asset, claim it, publish it, then record it as posted.

Posting history lives in Cloudinary tags on each asset, so it survives between GitHub Actions runs:
  tgbot_posted              Telegram confirmed the post
  tgbot_uncertain           the upload may have gone through; skipped until you check and remove the tag
  tgbot_rejected            Telegram refused the file; skipped until you remove the tag
  tgbot_run_<run id>        which GitHub Actions run posted it (stops a re-run from posting again)
  tgbot_slot_<slot>         which scheduled slot it was posted for (stops a second post in the same slot)
  tgbot_at_<unix time>      when it was last posted successfully (only the latest is kept)

Rotation: new (never posted) assets always come first. When none are left, the asset whose last
post is the OLDEST is reused, but only once REUSE_COOLDOWN_DAYS (default 30) have passed since that
post. Posting-history tags are never removed to start a new round. If nothing qualifies, the run
posts nothing, fails, and the admin is alerted.
  tgbot_claim_<time>_<id>   short-lived lock while a run is posting the asset
Only these tags are added or removed; your own tags are never touched.
"""

import logging
import random
import secrets
import time
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone

import httpx

from . import media
from .cloudinary_source import Asset, CloudinarySource, SourceError
from .config import TELEGRAM_CAPTION_LIMIT, PosterConfig
from .telegram_publisher import PublishFailed, PublishUncertain, TelegramPublisher

logger = logging.getLogger(__name__)

POSTED_TAG = "tgbot_posted"
UNCERTAIN_TAG = "tgbot_uncertain"
REJECTED_TAG = "tgbot_rejected"
CLAIM_PREFIX = "tgbot_claim_"
RUN_PREFIX = "tgbot_run_"
SLOT_PREFIX = "tgbot_slot_"
AT_PREFIX = "tgbot_at_"
MAX_CANDIDATES = 5

# Exit codes. A green workflow run now means a post was made (or was correctly not needed).
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_NO_CONTENT = 3


@dataclass(frozen=True)
class Result:
    # posted, dry_run, already_posted          -> success
    # no_content                               -> nothing left to post (alert: add media)
    # nothing_to_post, failed, uncertain, unrecorded -> something went wrong
    status: str
    asset: str | None = None
    message_id: int | None = None
    detail: str = ""
    remaining: int | None = None  # unpublished assets left after this run
    slot: str | None = None
    reused: bool = False  # True when no new asset was left and an older post was repeated

    @property
    def exit_code(self) -> int:
        if self.status in ("posted", "dry_run", "already_posted"):
            return EXIT_OK
        if self.status == "no_content":
            return EXIT_NO_CONTENT
        return EXIT_FAILED


def make_claim_tag(now: float) -> str:
    return f"{CLAIM_PREFIX}{int(now)}_{secrets.token_hex(4)}"


def claim_time(tag: str) -> int | None:
    try:
        return int(tag[len(CLAIM_PREFIX):].split("_", 1)[0])
    except ValueError:
        return None


def fresh_claims(tags, now: float, ttl_seconds: int) -> list[str]:
    result = []
    for tag in tags:
        if tag.startswith(CLAIM_PREFIX):
            stamp = claim_time(tag)
            if stamp is not None and now - stamp < ttl_seconds:
                result.append(tag)
    return result


def run_tag(run_id: str) -> str:
    return RUN_PREFIX + "".join(c for c in run_id if c.isalnum())


def slot_tag(slot: str) -> str:
    return SLOT_PREFIX + "".join(c for c in slot if c.isalnum())


def is_blocked(asset: Asset) -> bool:
    return bool({POSTED_TAG, UNCERTAIN_TAG, REJECTED_TAG} & set(asset.tags))


def at_tag(timestamp: float) -> str:
    return f"{AT_PREFIX}{int(timestamp)}"


def tagged_time(tags) -> int | None:
    """The newest tgbot_at_ timestamp in these tags."""
    times = []
    for tag in tags:
        if tag.startswith(AT_PREFIX):
            try:
                times.append(int(tag[len(AT_PREFIX):]))
            except ValueError:
                pass
    return max(times) if times else None


def history_time(tags, run_time=None) -> tuple[int | None, str]:
    """When an asset was last posted, and how that is known.

    1. tgbot_at_<time> (written on every post since smart rotation),
    2. the newest tgbot_slot_<slot> (the scheduled time of a slot-guarded post),
    3. the GitHub run in tgbot_run_<id>, looked up with run_time(id) (posts made before either tag existed).
    Unknown -> (None, "unknown"): such an asset is never reused.
    """
    from .slots import slot_time

    at = tagged_time(tags)
    if at is not None:
        return at, "tag"
    slots = sorted(t[len(SLOT_PREFIX):] for t in tags if t.startswith(SLOT_PREFIX))
    if slots:
        try:
            return int(slot_time(slots[-1]).timestamp()), "slot"
        except ValueError:
            pass
    if run_time is not None:
        found = [run_time(t[len(RUN_PREFIX):]) for t in tags if t.startswith(RUN_PREFIX)]
        found = [f for f in found if f]
        if found:
            return max(found), "run"
    return None, "unknown"


def reusable(asset: Asset, now: float, cooldown_seconds: int, run_time=None) -> tuple[bool, int | None]:
    """(can be reposted now, last posted time). Uncertain/rejected assets are never reused."""
    if POSTED_TAG not in asset.tags or {UNCERTAIN_TAG, REJECTED_TAG} & set(asset.tags):
        return False, None
    last, _ = history_time(asset.tags, run_time)
    return (last is not None and now - last >= cooldown_seconds), last


@dataclass(frozen=True)
class Inventory:
    total: int
    supported: int
    unsupported: int
    posted: int
    uncertain: int
    rejected: int
    remaining: int  # supported and not posted, uncertain or rejected
    slots: tuple[tuple[str, str], ...]  # (slot ID, asset name), newest first
    reusable_now: int = 0  # posted assets past the reuse cooldown
    next_reuse_at: int | None = None  # when the next posted asset leaves its cooldown
    unknown_time: int = 0  # posted assets whose last posting time is unknown (never reused)


def inventory(cfg: PosterConfig, assets: list[Asset], now: float | None = None, run_time=None) -> Inventory:
    """Read-only summary of the folder: what was posted, what is left, and what can be reused when."""
    now = time.time() if now is None else now
    cooldown = cfg.reuse_cooldown_days * 86400
    supported = [a for a in assets if media.classify(a, cfg)[0] is not None]
    reuse_now, waiting, unknown = 0, [], 0
    for a in supported:
        ok, last = reusable(a, now, cooldown, run_time)
        if ok:
            reuse_now += 1
        elif POSTED_TAG in a.tags and not {UNCERTAIN_TAG, REJECTED_TAG} & set(a.tags):
            if last is None:
                unknown += 1
            else:
                waiting.append(last + cooldown)
    slots = sorted(
        ((t[len(SLOT_PREFIX):], a.name) for a in assets for t in a.tags if t.startswith(SLOT_PREFIX)),
        reverse=True,
    )
    return Inventory(
        total=len(assets),
        supported=len(supported),
        unsupported=len(assets) - len(supported),
        posted=sum(POSTED_TAG in a.tags for a in supported),
        uncertain=sum(UNCERTAIN_TAG in a.tags for a in supported),
        rejected=sum(REJECTED_TAG in a.tags for a in supported),
        remaining=sum(not is_blocked(a) for a in supported),
        slots=tuple(slots),
        reusable_now=reuse_now,
        next_reuse_at=min(waiting) if waiting else None,
        unknown_time=unknown,
    )


IST = timezone(timedelta(hours=5, minutes=30))
PRIORITY_TAG = "tgpriority"  # add this tag in Cloudinary to post an asset sooner (smart selection)


def render_caption(template: str, cfg: PosterConfig, now: float) -> str:
    """Fill the few supported placeholders. Unknown {words} are left as they are."""
    day = datetime.fromtimestamp(now, tz=IST)
    return (template.replace("{date}", day.strftime("%d %b %Y")).replace("{weekday}", day.strftime("%A"))
            .replace("{channel}", cfg.public_channel))


def caption_for(asset: Asset, cfg: PosterConfig, now: float | None = None, index: int = 0) -> str:
    """Caption priority: the asset's own Cloudinary caption, then the rotating POST_CAPTIONS pool,
    then POST_CAPTION. POST_FOOTER is appended if it fits in Telegram's 1,024 characters."""
    now = time.time() if now is None else now
    base = asset.caption or (cfg.caption_pool[index % len(cfg.caption_pool)] if cfg.caption_pool else "") or cfg.caption
    text = render_caption(base.strip(), cfg, now)
    footer = render_caption(cfg.footer, cfg, now).strip()
    if footer and len(text) + 2 + len(footer) <= TELEGRAM_CAPTION_LIMIT:
        text = f"{text}\n\n{footer}" if text else footer
    if len(text) > TELEGRAM_CAPTION_LIMIT:
        logger.warning("Caption for %s is too long; using the default caption", asset.name)
        text = render_caption(cfg.caption, cfg, now)
    return text


def last_posted_kind(supported: list[tuple[Asset, str]]) -> str | None:
    """The media kind of the most recent slot-tagged post, for smart selection."""
    latest = None
    for asset, kind in supported:
        for tag in asset.tags:
            if tag.startswith(SLOT_PREFIX) and (latest is None or tag > latest[0]):
                latest = (tag, kind)
    return latest[1] if latest else None


def smart_order(eligible: list[tuple[Asset, str]], last_kind: str | None) -> list[tuple[Asset, str]]:
    """Priority-tagged first, then a different media kind than the last post, then oldest first."""
    return sorted(eligible, key=lambda pair: (
        PRIORITY_TAG not in pair[0].tags,
        last_kind is not None and pair[1] == last_kind,
        pair[0].created_at, pair[0].public_id,
    ))


def run(cfg: PosterConfig, source: CloudinarySource, publisher: TelegramPublisher, http: httpx.Client, *,
        dry_run: bool = False, channel: str | None = None, clock=time.time, rng: random.Random | None = None,
        slot: str | None = None, run_time=None) -> Result:
    target = channel or cfg.public_channel
    record_history = target == cfg.public_channel
    ttl = cfg.claim_ttl_minutes * 60
    if not record_history:
        logger.info("Test target %s: posting history will NOT be recorded", target)

    problems = publisher.check_channel(target)
    if problems:
        for problem in problems:
            logger.error("Channel check failed: %s", problem)
        return Result("failed", detail="; ".join(problems))
    logger.info("Bot can post to %s", target)

    try:
        assets = source.list_assets()
    except SourceError as exc:
        logger.error("%s", exc)
        return Result("failed", detail=str(exc))

    if record_history and cfg.run_id:
        tag = run_tag(cfg.run_id)
        done = next((a for a in assets if tag in a.tags), None)
        if done:
            logger.info("This workflow run already posted %s; not posting again", done.name)
            return Result("already_posted", asset=done.name, detail="this run already posted")

    if record_history and slot:
        tag = slot_tag(slot)
        done = next((a for a in assets if tag in a.tags), None)
        if done:
            logger.info("Slot %s was already posted (%s); not posting again", slot, done.name)
            return Result("already_posted", asset=done.name, detail=f"slot {slot} already posted", slot=slot)

    supported: list[tuple[Asset, str]] = []
    skipped: dict[str, int] = {}
    for asset in assets:
        kind, reason = media.classify(asset, cfg)
        if kind is None:
            skipped[reason] = skipped.get(reason, 0) + 1
            logger.info("Skipping %s: %s", asset.name, reason)
        else:
            supported.append((asset, kind))
    if not assets:
        logger.error("Cloudinary folder %r is empty; nothing to post", cfg.folder)
        return Result("no_content", detail="folder empty", remaining=0, slot=slot)
    if not supported:
        logger.error("No supported photos/videos in %r (skipped: %s)", cfg.folder, skipped)
        return Result("no_content", detail="no supported media", remaining=0, slot=slot)

    now = clock()
    cooldown = cfg.reuse_cooldown_days * 86400
    writes = record_history and not dry_run

    # 1. New, never-posted content always comes first.
    eligible = [(a, k) for a, k in supported if not is_blocked(a) and not fresh_claims(a.tags, now, ttl)]
    reusing = False
    if eligible:
        if cfg.selection == "random":
            (rng or random.Random()).shuffle(eligible)
        elif cfg.selection == "smart":
            eligible = smart_order(eligible, last_posted_kind(supported))
        else:
            eligible.sort(key=lambda pair: (pair[0].created_at, pair[0].public_id))
    else:
        in_use = [a for a, _ in supported if not is_blocked(a)]
        if in_use:
            logger.error("All %s unpublished asset(s) are claimed by another run right now", len(in_use))
            return Result("nothing_to_post", detail="all remaining assets in use", slot=slot)
        if cfg.when_exhausted == "stop":
            logger.error("Every supported asset has already been posted; nothing new to post. "
                         "Upload new media to %r (reuse of old posts is off).", cfg.folder)
            return Result("no_content", detail="all posted", remaining=0, slot=slot)
        # 2. No new content: reuse the asset posted longest ago, once it is past the cooldown.
        if writes:
            _backfill_times(source, supported, run_time)
        timed = []
        waiting = []
        unknown = 0
        for a, k in supported:
            if fresh_claims(a.tags, now, ttl):
                continue
            ok, last = reusable(a, now, cooldown, run_time)
            if ok:
                timed.append((last, a, k))
            elif last is not None and POSTED_TAG in a.tags:
                waiting.append(last + cooldown)
            elif POSTED_TAG in a.tags and not {UNCERTAIN_TAG, REJECTED_TAG} & set(a.tags):
                unknown += 1
        if not timed:
            detail = f"all posted; none is past the {cfg.reuse_cooldown_days}-day reuse cooldown yet"
            if waiting:
                detail += "; next one qualifies " + datetime.fromtimestamp(min(waiting), tz=IST).strftime(
                    "%d %b %Y %H:%M IST")
            if unknown:
                detail += f"; {unknown} posted asset(s) have no known posting time and are never reused"
            logger.error("Nothing to post: %s. Upload new media to %r.", detail, cfg.folder)
            return Result("no_content", detail=detail, remaining=0, slot=slot)
        timed.sort(key=lambda t: (t[0], t[1].created_at, t[1].public_id))
        eligible = [(a, k) for _, a, k in timed]
        reusing = True
        logger.info("No new content left; reusing the oldest post past the %s-day cooldown",
                    cfg.reuse_cooldown_days)

    logger.info("%s eligible asset(s); next: %s%s", len(eligible), eligible[0][0].name,
                " (reuse)" if reusing else "")
    if dry_run:
        return Result("dry_run", asset=eligible[0][0].name, remaining=0 if reusing else len(eligible), slot=slot,
                      reused=reusing)
    remaining_after = 0 if reusing else len(eligible) - 1
    posted_count = sum(POSTED_TAG in a.tags for a, _ in supported)  # rotates the caption pool

    for asset, kind in eligible[:MAX_CANDIDATES]:
        claim = make_claim_tag(now)
        try:
            source.add_tag(claim, [asset])
            current = source.get_tags(asset)
            logger.info("Added claim tag %s to %s", claim, asset.name)
        except SourceError as exc:
            logger.error("Could not claim %s: %s", asset.name, exc)
            _release(source, claim, asset)
            return Result("failed", asset=asset.name, detail=str(exc), slot=slot)

        others = [t for t in fresh_claims(current, clock(), ttl) if t != claim]
        if reusing:
            # Re-check with fresh tags: another run may have reposted it, or it may be marked bad now.
            still_ok = reusable(replace(asset, tags=tuple(current)), clock(), cooldown, run_time)[0]
            taken = not still_ok
        else:
            taken = bool({POSTED_TAG, UNCERTAIN_TAG, REJECTED_TAG} & set(current))
        if taken or others:
            logger.info("%s is already posted or claimed by another run; trying the next asset", asset.name)
            _release(source, claim, asset)
            continue

        limit = cfg.max_photo_bytes if kind == "photo" else cfg.max_video_bytes
        try:
            content = media.download(http, asset, limit)
        except media.DownloadError as exc:
            logger.warning("Skipping %s: %s", asset.name, exc)
            _release(source, claim, asset)
            continue

        try:
            message_id = publisher.send_media(target, kind, media.filename(asset), content, caption_for(asset, cfg, now, posted_count))
        except PublishFailed as exc:
            logger.error("Telegram did not publish %s: %s", asset.name, exc)
            if exc.rejected_request and record_history:
                # Without this the same file would be picked, and refused, on every run.
                try:
                    source.add_tag(REJECTED_TAG, [asset])
                    logger.error("Tagged %s as %r; it will be skipped until you remove the tag", asset.name, REJECTED_TAG)
                except SourceError:
                    logger.error("Could not tag %s as rejected", asset.name)
            _release(source, claim, asset)
            return Result("failed", asset=asset.name, detail=str(exc), slot=slot)
        except PublishUncertain as exc:
            logger.error("Upload of %s may or may not have been published: %s", asset.name, exc)
            if record_history:
                try:
                    source.add_tag(UNCERTAIN_TAG, [asset])
                except SourceError:
                    logger.error("Could not tag %s as uncertain; its claim tag blocks it for %s minutes",
                                 asset.name, cfg.claim_ttl_minutes)
                    return Result("uncertain", asset=asset.name, detail=str(exc), slot=slot)
            _release(source, claim, asset)
            return Result("uncertain", asset=asset.name, detail=str(exc), slot=slot)

        logger.info("Posted %s to %s (message %s)", asset.name, target, message_id)
        if not record_history:
            _release(source, claim, asset)
            return Result("posted", asset=asset.name, message_id=message_id, detail="test target, not recorded",
                          remaining=remaining_after, reused=reusing)
        posted_at = int(clock())
        try:
            source.add_tag(POSTED_TAG, [asset])
            source.add_tag(at_tag(posted_at), [asset])
            if cfg.run_id:
                source.add_tag(run_tag(cfg.run_id), [asset])
            if slot:
                source.add_tag(slot_tag(slot), [asset])
            logger.info("Recorded %s as posted at %s (tag %r)", asset.name, posted_at, POSTED_TAG)
        except SourceError as exc:
            logger.error("POSTED %s but could not record it in Cloudinary: %s. Add the tag %r to it by hand.",
                         asset.name, exc, POSTED_TAG)
            return Result("unrecorded", asset=asset.name, message_id=message_id, detail=str(exc), slot=slot)
        # Keep only the newest posting time on the asset (older tgbot_at_ tags are superseded, not history).
        for old in {t for t in current if t.startswith(AT_PREFIX) and t != at_tag(posted_at)}:
            try:
                source.remove_tag(old, [asset])
            except SourceError:
                logger.warning("Could not remove the superseded tag %s from %s", old, asset.name)
        _release(source, claim, asset)
        return Result("posted", asset=asset.name, message_id=message_id, remaining=remaining_after, slot=slot,
                      detail="reused an older post (no new content left)" if reusing else "", reused=reusing)

    logger.error("No asset could be posted this run (downloads failed or assets were taken by another run)")
    return Result("nothing_to_post", detail="candidates unavailable", slot=slot)


def _backfill_times(source: CloudinarySource, supported: list[tuple[Asset, str]], run_time) -> None:
    """Save a tgbot_at_ tag on posted assets that don't have one yet (posts from before smart rotation).

    The time comes from their slot tag or from the GitHub run that posted them. Best effort: an asset
    whose time can't be found is left alone and is simply never reused.
    """
    by_time: dict[int, list[Asset]] = {}
    for asset, _ in supported:
        if POSTED_TAG in asset.tags and tagged_time(asset.tags) is None:
            last, how = history_time(asset.tags, run_time)
            if last is not None:
                by_time.setdefault(last, []).append(asset)
    for timestamp, assets in by_time.items():
        try:
            source.add_tag(at_tag(timestamp), assets)
        except SourceError as exc:
            logger.warning("Could not save posting times for %s asset(s): %s", len(assets), exc)
            continue
    if by_time:
        logger.info("Saved the last posting time on %s older asset(s)", sum(map(len, by_time.values())))


def _release(source: CloudinarySource, claim: str, asset: Asset) -> None:
    try:
        source.remove_tag(claim, [asset])
        logger.info("Removed claim tag %s from %s", claim, asset.name)
    except SourceError:
        logger.warning("Could not remove claim tag from %s; it expires on its own", asset.name)
