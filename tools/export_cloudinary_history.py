"""Back up the channel poster's posting history (Cloudinary tags) to a JSON file. Read-only.

  CLOUDINARY_CLOUD_NAME=... CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=... \
  python tools/export_cloudinary_history.py backups/poster-history-YYYYMMDD.json

The poster keeps its history only as tgbot_* tags on the Cloudinary assets. This file lets you
see, or restore by hand, which assets were posted, for which slot, before any change.
"""

import json
import os
import sys
import time

from poster.cloudinary_source import CloudinarySource


def export(source, now: float) -> dict:
    assets = source.list_assets()
    return {
        "exported_at": int(now),
        "folder": source.folder,
        "assets": [{"public_id": a.public_id, "resource_type": a.resource_type, "format": a.format,
                    "created_at": a.created_at, "bytes": a.bytes,
                    "tgbot_tags": sorted(t for t in a.tags if t.startswith("tgbot_"))} for a in assets],
    }


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    missing = [n for n in ("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET") if not os.getenv(n)]
    if missing:
        print("Missing: " + ", ".join(missing), file=sys.stderr)
        return 2
    source = CloudinarySource(os.environ["CLOUDINARY_CLOUD_NAME"], os.environ["CLOUDINARY_API_KEY"],
                              os.environ["CLOUDINARY_API_SECRET"], os.getenv("CLOUDINARY_FOLDER", "tgpub"))
    data = export(source, time.time())
    os.makedirs(os.path.dirname(os.path.abspath(argv[0])), exist_ok=True)
    with open(argv[0], "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    posted = sum("tgbot_posted" in a["tgbot_tags"] for a in data["assets"])
    print(f"Saved {len(data['assets'])} assets ({posted} posted) to {argv[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
