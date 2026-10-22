"""Decide how an asset is sent to Telegram, and download it safely."""

from urllib.parse import urlparse

import httpx

from .cloudinary_source import Asset
from .config import PosterConfig

PHOTO_FORMATS = {"jpg", "jpeg", "png", "webp"}
ANIMATION_FORMATS = {"gif"}
VIDEO_FORMATS = {"mp4"}  # Telegram plays MPEG-4 inline; other formats would arrive as plain files


class DownloadError(RuntimeError):
    pass


def classify(asset: Asset, cfg: PosterConfig) -> tuple[str | None, str]:
    """Return (kind, reason). kind is 'photo', 'video', 'animation', or None when the asset must be skipped."""
    if asset.delivery_type != "upload":
        return None, f"delivery type {asset.delivery_type!r} needs signed URLs"
    if not asset.secure_url.startswith("https://"):
        return None, "no https download URL"
    fmt = asset.format
    if asset.resource_type == "image" and fmt in PHOTO_FORMATS:
        kind, limit = "photo", cfg.max_photo_bytes
    elif asset.resource_type == "image" and fmt in ANIMATION_FORMATS:
        kind, limit = "animation", cfg.max_video_bytes
    elif asset.resource_type == "video" and fmt in VIDEO_FORMATS:
        kind, limit = "video", cfg.max_video_bytes
    else:
        return None, f"unsupported format {asset.resource_type}/{fmt or 'unknown'}"
    if asset.bytes <= 0:
        return None, "unknown file size"
    if asset.bytes > limit:
        return None, f"{asset.bytes} bytes is over the {limit}-byte limit for a {kind}"
    return kind, "ok"


def filename(asset: Asset) -> str:
    base = asset.public_id.rsplit("/", 1)[-1] or "media"
    return f"{base}.{asset.format}" if asset.format else base


def download(client: httpx.Client, asset: Asset, max_bytes: int) -> bytes:
    """Download the original file, refusing anything larger than max_bytes."""
    if urlparse(asset.secure_url).scheme != "https":
        raise DownloadError("refusing non-https URL")
    try:
        with client.stream("GET", asset.secure_url, follow_redirects=True) as response:
            if response.status_code != 200:
                raise DownloadError(f"download returned HTTP {response.status_code}")
            declared = response.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                raise DownloadError(f"file is {declared} bytes, over the {max_bytes}-byte limit")
            chunks, size = [], 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise DownloadError(f"file is over the {max_bytes}-byte limit")
                chunks.append(chunk)
    except httpx.HTTPError as exc:
        raise DownloadError(f"download failed: {type(exc).__name__}") from None
    if size == 0:
        raise DownloadError("downloaded file is empty")
    return b"".join(chunks)
