"""Find media in the Cloudinary folder and manage the tags used as posting history."""

import logging
import time
from dataclasses import dataclass, field

import cloudinary
import cloudinary.api
import cloudinary.exceptions
import cloudinary.uploader

logger = logging.getLogger(__name__)

PAGE_SIZE = 500  # Admin API maximum
MAX_PAGES = 40  # safety stop: 20,000 assets per listing
TAG_BATCH = 1000  # tags API maximum public IDs per call


class SourceError(RuntimeError):
    """Cloudinary could not be reached or returned an error. The message is safe to log."""


@dataclass(frozen=True)
class Asset:
    public_id: str
    resource_type: str  # image or video
    delivery_type: str  # upload, private, authenticated...
    format: str
    bytes: int
    secure_url: str
    created_at: str
    tags: tuple[str, ...] = field(default_factory=tuple)
    caption: str = ""

    @property
    def key(self) -> tuple[str, str, str]:
        return self.resource_type, self.delivery_type, self.public_id

    @property
    def name(self) -> str:
        return f"{self.resource_type}:{self.public_id}"


def in_folder(raw: dict, folder: str) -> bool:
    """True if a listed asset sits directly in `folder` (not a subfolder), in either folder mode."""
    if raw.get("asset_folder") is not None:  # dynamic folder mode: folder is separate from the public ID
        return raw["asset_folder"] == folder
    if raw.get("folder") is not None:
        return raw["folder"] == folder
    public_id = raw.get("public_id", "")
    return (public_id.rsplit("/", 1)[0] if "/" in public_id else "") == folder


def parse_asset(raw: dict) -> Asset | None:
    """Turn an Admin API resource into an Asset, or None if the entry is malformed."""
    try:
        public_id = raw["public_id"]
        resource_type = raw["resource_type"]
        if not isinstance(public_id, str) or not public_id or resource_type not in ("image", "video", "raw"):
            return None
        context = raw.get("context") or {}
        custom = context.get("custom", context) if isinstance(context, dict) else {}
        caption = custom.get("caption", "") if isinstance(custom, dict) else ""
        tags = raw.get("tags") or []
        return Asset(
            public_id=public_id,
            resource_type=resource_type,
            delivery_type=str(raw.get("type") or "upload"),
            format=str(raw.get("format") or "").lower(),
            bytes=int(raw.get("bytes") or 0),
            secure_url=str(raw.get("secure_url") or ""),
            created_at=str(raw.get("created_at") or ""),
            tags=tuple(t for t in tags if isinstance(t, str)),
            caption=caption if isinstance(caption, str) else "",
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


class CloudinarySource:
    def __init__(self, cloud_name: str, api_key: str, api_secret: str, folder: str, mode: str = "auto",
                 sleep=time.sleep):
        self.folder = folder
        self.mode = mode
        self._sleep = sleep
        cloudinary.config(cloud_name=cloud_name, api_key=api_key, api_secret=api_secret, secure=True)

    # Calls with retries

    def _call(self, fn, *args, **kwargs):
        delays = [5, 20]
        while True:
            try:
                return fn(*args, **kwargs)
            except (cloudinary.exceptions.RateLimited, cloudinary.exceptions.GeneralError) as exc:
                if not delays:
                    raise SourceError(f"Cloudinary {fn.__name__} failed after retries: {type(exc).__name__}: {exc}") from None
                delay = delays.pop(0)
                logger.warning("Cloudinary %s failed (%s); retrying in %ss", fn.__name__, type(exc).__name__, delay)
                self._sleep(delay)
            except cloudinary.exceptions.Error as exc:
                raise SourceError(f"Cloudinary {fn.__name__} failed: {type(exc).__name__}: {exc}") from None

    def _paged(self, fn, *args, **kwargs) -> list[dict]:
        items: list[dict] = []
        cursor = None
        for _ in range(MAX_PAGES):
            page_kwargs = dict(kwargs, max_results=PAGE_SIZE, tags=True, context=True)
            if cursor:
                page_kwargs["next_cursor"] = cursor
            response = self._call(fn, *args, **page_kwargs)
            resources = response.get("resources") if isinstance(response, dict) else None
            if not isinstance(resources, list):
                raise SourceError(f"Cloudinary {fn.__name__} returned an unexpected response")
            items.extend(r for r in resources if isinstance(r, dict))
            cursor = response.get("next_cursor")
            if not cursor:
                return items
        logger.warning("Stopped listing after %s pages; some assets were not considered", MAX_PAGES)
        return items

    # Listing

    def _list_dynamic(self) -> list[dict]:
        return self._paged(cloudinary.api.resources_by_asset_folder, self.folder)

    def _list_fixed(self) -> list[dict]:
        items = []
        for resource_type in ("image", "video"):
            items += self._paged(cloudinary.api.resources, resource_type=resource_type, type="upload",
                                 prefix=self.folder + "/")
        return items

    def list_assets(self) -> list[Asset]:
        raws: list[dict] = []
        if self.mode in ("auto", "dynamic"):
            try:
                raws = self._list_dynamic()
            except SourceError:
                if self.mode == "dynamic":
                    raise
                logger.info("Listing by asset folder is not available; using public ID prefix instead")
        if self.mode == "fixed" or (self.mode == "auto" and not raws):
            raws = self._list_fixed()

        assets, seen, malformed = [], set(), 0
        for raw in raws:
            if not in_folder(raw, self.folder):
                continue
            asset = parse_asset(raw)
            if asset is None:
                malformed += 1
                continue
            if asset.key not in seen:
                seen.add(asset.key)
                assets.append(asset)
        if malformed:
            logger.warning("Ignored %s malformed asset entries from Cloudinary", malformed)
        logger.info("Found %s asset(s) in Cloudinary folder %r", len(assets), self.folder)
        return assets

    # Tags (posting history)

    def get_tags(self, asset: Asset) -> list[str]:
        response = self._call(cloudinary.api.resource, asset.public_id,
                              resource_type=asset.resource_type, type=asset.delivery_type)
        tags = response.get("tags") if isinstance(response, dict) else None
        if tags is None:
            return []
        if not isinstance(tags, list):
            raise SourceError("Cloudinary returned tags in an unexpected format")
        return [t for t in tags if isinstance(t, str)]

    def _tags_command(self, fn, tag: str, assets: list[Asset]) -> None:
        groups: dict[tuple[str, str], list[str]] = {}
        for asset in assets:
            groups.setdefault((asset.resource_type, asset.delivery_type), []).append(asset.public_id)
        for (resource_type, delivery_type), ids in groups.items():
            for start in range(0, len(ids), TAG_BATCH):
                # add_tag/remove_tag only touch this one tag; other tags are kept.
                self._call(fn, tag, ids[start:start + TAG_BATCH], resource_type=resource_type, type=delivery_type)

    def add_tag(self, tag: str, assets: list[Asset]) -> None:
        self._tags_command(cloudinary.uploader.add_tag, tag, assets)

    def remove_tag(self, tag: str, assets: list[Asset]) -> None:
        self._tags_command(cloudinary.uploader.remove_tag, tag, assets)
