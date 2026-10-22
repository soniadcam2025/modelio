"""One posting run: pick an unposted asset, claim it, publish it, then record it as posted.

Posting history lives in Cloudinary tags on each asset, so it survives between GitHub Actions runs:
  tgbot_posted              Telegram confirmed the post
  tgbot_uncertain           the upload may have gone through; skipped until you check and remove the tag
  tgbot_rejected            Telegram refused the file; skipped until you remove the tag
  tgbot_run_<run id>        which GitHub Actions run posted it (stops a re-run from posting again)
  tgbot_claim_<time>_<id>   short-lived lock while a run is posting the asset
Only these tags are added or removed; your own tags are never touched.
"""

import logging
import random
import secrets
import time
from dataclasses import dataclass, replace

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
MAX_CANDIDATES = 5


@dataclass(frozen=True)
class Result:
    status: str  # posted, dry_run, nothing_to_post, already_posted, failed, uncertain, unrecorded
    asset: str | None = None
    message_id: int | None = None
    detail: str = ""

    @property
    def exit_code(self) -> int:
        return 0 if self.status in ("posted", "dry_run", "nothing_to_post", "already_posted") else 1


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


def caption_for(asset: Asset, cfg: PosterConfig) -> str:
    text = (asset.caption or cfg.caption).strip()
    if len(text) > TELEGRAM_CAPTION_LIMIT:
        logger.warning("Caption for %s is too long; using the default caption", asset.name)
        text = cfg.caption
    return text


def run(cfg: PosterConfig, source: CloudinarySource, publisher: TelegramPublisher, http: httpx.Client, *,
        dry_run: bool = False, channel: str | None = None, clock=time.time, rng: random.Random | None = None) -> Result:
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
            return Result("already_posted", asset=done.name)

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
        logger.warning("Cloudinary folder %r is empty; nothing to post", cfg.folder)
        return Result("nothing_to_post", detail="folder empty")
    if not supported:
        logger.warning("No supported photos/videos in %r (skipped: %s)", cfg.folder, skipped)
        return Result("nothing_to_post", detail="no supported media")

    now = clock()

    def eligible_list():
        return [(a, k) for a, k in supported
                if not {POSTED_TAG, UNCERTAIN_TAG, REJECTED_TAG} & set(a.tags) and not fresh_claims(a.tags, now, ttl)]

    eligible = eligible_list()
    if not eligible:
        all_posted = [a for a, _ in supported if POSTED_TAG in a.tags]
        if cfg.when_exhausted == "restart" and all_posted and not dry_run and record_history:
            logger.info("All %s assets were posted; starting a new rotation", len(all_posted))
            try:
                source.remove_tag(POSTED_TAG, all_posted)
            except SourceError as exc:
                logger.error("Could not start a new rotation: %s", exc)
                return Result("failed", detail=str(exc))
            supported = [(_without_tag(a, POSTED_TAG), k) for a, k in supported]
            eligible = eligible_list()
        if not eligible:
            logger.warning("Every supported asset has already been posted (or is in use); nothing new to post")
            return Result("nothing_to_post", detail="all posted")

    if cfg.selection == "random":
        (rng or random.Random()).shuffle(eligible)
    else:
        eligible.sort(key=lambda pair: (pair[0].created_at, pair[0].public_id))
    logger.info("%s eligible asset(s); next: %s", len(eligible), eligible[0][0].name)

    if dry_run:
        return Result("dry_run", asset=eligible[0][0].name)

    for asset, kind in eligible[:MAX_CANDIDATES]:
        claim = make_claim_tag(now)
        try:
            source.add_tag(claim, [asset])
            current = source.get_tags(asset)
        except SourceError as exc:
            logger.error("Could not claim %s: %s", asset.name, exc)
            _release(source, claim, asset)
            return Result("failed", asset=asset.name, detail=str(exc))

        others = [t for t in fresh_claims(current, clock(), ttl) if t != claim]
        if {POSTED_TAG, UNCERTAIN_TAG, REJECTED_TAG} & set(current) or others:
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
            message_id = publisher.send_media(target, kind, media.filename(asset), content, caption_for(asset, cfg))
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
            return Result("failed", asset=asset.name, detail=str(exc))
        except PublishUncertain as exc:
            logger.error("Upload of %s may or may not have been published: %s", asset.name, exc)
            if record_history:
                try:
                    source.add_tag(UNCERTAIN_TAG, [asset])
                except SourceError:
                    logger.error("Could not tag %s as uncertain; its claim tag blocks it for %s minutes",
                                 asset.name, cfg.claim_ttl_minutes)
                    return Result("uncertain", asset=asset.name, detail=str(exc))
            _release(source, claim, asset)
            return Result("uncertain", asset=asset.name, detail=str(exc))

        logger.info("Posted %s to %s (message %s)", asset.name, target, message_id)
        if not record_history:
            _release(source, claim, asset)
            return Result("posted", asset=asset.name, message_id=message_id, detail="test target, not recorded")
        try:
            source.add_tag(POSTED_TAG, [asset])
            if cfg.run_id:
                source.add_tag(run_tag(cfg.run_id), [asset])
        except SourceError as exc:
            logger.error("POSTED %s but could not record it in Cloudinary: %s. Add the tag %r to it by hand.",
                         asset.name, exc, POSTED_TAG)
            return Result("unrecorded", asset=asset.name, message_id=message_id, detail=str(exc))
        _release(source, claim, asset)
        return Result("posted", asset=asset.name, message_id=message_id)

    logger.warning("No asset could be posted this run")
    return Result("nothing_to_post", detail="candidates unavailable")


def _without_tag(asset: Asset, tag: str) -> Asset:
    return replace(asset, tags=tuple(t for t in asset.tags if t != tag))


def _release(source: CloudinarySource, claim: str, asset: Asset) -> None:
    try:
        source.remove_tag(claim, [asset])
    except SourceError:
        logger.warning("Could not remove claim tag from %s; it expires on its own", asset.name)
