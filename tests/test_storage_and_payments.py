from shakhira_bot.payments import check_payment, make_payload, parse_payload
from shakhira_bot.storage import Storage

from .fakes import make_config


def test_duplicate_charge_id_is_recorded_once():
    store = Storage(":memory:")
    assert store.record_payment("charge-1", 7, "trial", 49, "XTR", "p", 100) is True
    assert store.record_payment("charge-1", 7, "trial", 49, "XTR", "p", 101) is False


def test_trial_lifecycle_queries():
    store = Storage(":memory:")
    store.record_payment("c1", 7, "trial", 49, "XTR", "p", 0)
    assert not store.has_used_trial(7)
    trial = store.create_trial(7, "c1", 0, 100)
    assert store.has_used_trial(7)
    assert store.active_trial(7, 50).id == trial.id
    assert store.active_trial(7, 100) is None
    assert store.due_trials(99) == []
    assert [t.id for t in store.due_trials(100)] == [trial.id]
    store.end_trial(trial.id, "ended", 100)
    assert store.due_trials(1000) == []


def test_trial_link_join_only_for_buyer():
    store = Storage(":memory:")
    store.record_payment("c1", 7, "trial", 49, "XTR", "p", 0)
    trial = store.create_trial(7, "c1", 0, 100)
    store.set_trial_link(trial.id, "https://t.me/+abc")
    assert store.mark_trial_joined("https://t.me/+abc", 8, 5) is False
    assert store.mark_trial_joined("https://t.me/+abc", 7, 5) is True
    assert store.active_trial(7, 6).joined_at == 5


def test_settings_roundtrip_and_reset():
    store = Storage(":memory:")
    store.set_setting("monthly_link:499", "a")
    store.set_setting("monthly_link:499", "b")
    assert store.get_setting("monthly_link:499") == "b"
    assert store.delete_settings_with_prefix("monthly_link:") == 1
    assert store.get_setting("monthly_link:499") is None


def test_payload_roundtrip_and_garbage():
    payload = make_payload("trial", 42)
    assert parse_payload(payload) == ("trial", 42)
    assert make_payload("trial", 42) != payload  # unique nonce
    assert parse_payload("nonsense") is None
    assert parse_payload("trial:abc:x") is None


def test_check_payment():
    cfg = make_config()
    good = make_payload("trial", 42)
    assert check_payment(cfg, "XTR", 49, good, 42) is None
    assert check_payment(cfg, "USD", 49, good, 42) is not None
    assert check_payment(cfg, "XTR", 48, good, 42) is not None
    assert check_payment(cfg, "XTR", 49, good, 43) is not None
    assert check_payment(cfg, "XTR", 49, make_payload("monthly", 42), 42) is not None
    assert check_payment(cfg, "XTR", 49, "junk", 42) is not None
