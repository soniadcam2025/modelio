"""Run the admin dashboard.

  python -m dashboard hash-password     make DASHBOARD_PASSWORD_HASH (asks for the password, never echoes it)
  python -m dashboard make-secret       make a random DASHBOARD_SECRET
  python -m dashboard serve             start on DASHBOARD_HOST:DASHBOARD_PORT (default 127.0.0.1:8080)
"""

import argparse
import getpass
import os
import secrets
import sys

from dotenv import find_dotenv, load_dotenv


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m dashboard")
    parser.add_argument("command", choices=["serve", "hash-password", "make-secret"])
    args = parser.parse_args(argv)

    if args.command == "make-secret":
        print(secrets.token_urlsafe(48))
        return 0
    if args.command == "hash-password":
        from .auth import hash_password

        password = getpass.getpass("New dashboard password (12+ characters): ")
        if password != getpass.getpass("Repeat it: "):
            print("The passwords don't match.", file=sys.stderr)
            return 1
        try:
            print(hash_password(password))
        except ValueError as exc:
            print(exc, file=sys.stderr)
            return 1
        return 0

    load_dotenv(find_dotenv(usecwd=True))
    import uvicorn

    from .app import Settings, create_app

    try:
        settings = Settings.from_env()
    except ValueError as exc:
        print(f"Configuration problem: {exc}", file=sys.stderr)
        return 2
    host = os.getenv("DASHBOARD_HOST", "127.0.0.1")
    port = int(os.getenv("DASHBOARD_PORT", "8080"))
    uvicorn.run(create_app(settings), host=host, port=port, proxy_headers=True, server_header=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
