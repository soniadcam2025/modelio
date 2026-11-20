import pytest

from shakhira_bot.storage import Storage


@pytest.fixture(autouse=True)
def close_databases(monkeypatch):
    """Close every Storage a test opened, so no SQLite connection is left for the garbage collector."""
    opened = []
    original = Storage.__init__

    def tracking_init(self, *args, **kwargs):
        original(self, *args, **kwargs)
        opened.append(self)

    monkeypatch.setattr(Storage, "__init__", tracking_init)
    yield
    for store in opened:
        try:
            store.close()
        except Exception:  # noqa: BLE001 - already closed
            pass
