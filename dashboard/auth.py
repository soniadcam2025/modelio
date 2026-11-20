"""Dashboard sign-in: PBKDF2 password hash, signed session cookie, CSRF token, login rate limit."""

import base64
import hashlib
import hmac
import secrets
import time

PBKDF2_ITERATIONS = 600_000
SESSION_SECONDS = 12 * 3600
MAX_FAILURES = 5
FAILURE_WINDOW = 15 * 60


def hash_password(password: str, iterations: int = PBKDF2_ITERATIONS, salt: bytes | None = None) -> str:
    if len(password) < 12:
        raise ValueError("Use a password of at least 12 characters")
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    # ':' separators (not '$') so shells, docker-compose and .env loaders never try to expand the value.
    return f"pbkdf2_sha256:{iterations}:{base64.b64encode(salt).decode()}:{base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, iterations, salt, digest = stored.strip().replace("$", ":").split(":")
        if scheme != "pbkdf2_sha256":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt), int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


class Sessions:
    """Stateless signed sessions: '<expiry>.<nonce>.<signature>'. Logout revokes the nonce."""

    def __init__(self, secret: str, clock=time.time, lifetime: int = SESSION_SECONDS):
        if len(secret) < 32:
            raise ValueError("DASHBOARD_SECRET must be at least 32 characters")
        self._key = secret.encode()
        self._clock = clock
        self.lifetime = lifetime
        self._revoked: set[str] = set()

    def _sign(self, message: str) -> str:
        return hmac.new(self._key, message.encode(), hashlib.sha256).hexdigest()

    def issue(self) -> str:
        message = f"{int(self._clock()) + self.lifetime}.{secrets.token_urlsafe(16)}"
        return f"{message}.{self._sign(message)}"

    def valid(self, token: str | None) -> bool:
        if not token or token.count(".") != 2:
            return False
        expiry, nonce, signature = token.split(".")
        if not hmac.compare_digest(signature, self._sign(f"{expiry}.{nonce}")):
            return False
        if nonce in self._revoked:
            return False
        try:
            return int(expiry) > self._clock()
        except ValueError:
            return False

    def revoke(self, token: str | None) -> None:
        if token and token.count(".") == 2:
            self._revoked.add(token.split(".")[1])

    def csrf_for(self, token: str) -> str:
        """The CSRF token is derived from the session, so it can't be planted by another site."""
        return self._sign("csrf:" + token)[:40]


class LoginLimiter:
    def __init__(self, clock=time.time):
        self._clock = clock
        self._failures: dict[str, list[float]] = {}

    def blocked(self, client: str) -> bool:
        now = self._clock()
        recent = [t for t in self._failures.get(client, []) if now - t < FAILURE_WINDOW]
        self._failures[client] = recent
        return len(recent) >= MAX_FAILURES

    def failed(self, client: str) -> None:
        self._failures.setdefault(client, []).append(self._clock())

    def succeeded(self, client: str) -> None:
        self._failures.pop(client, None)
