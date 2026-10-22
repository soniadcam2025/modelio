import asyncio
from types import SimpleNamespace

from telegram import ChatMember

from shakhira_bot import access, handlers
from shakhira_bot.app import build_application
from shakhira_bot.payments import make_payload
from shakhira_bot.storage import Storage

from .fakes import CHANNEL_ID, FakeBot, make_config, member

DAY = 86400


def run(coro):
    return asyncio.run(coro)


def paid_trial(store, user_id, charge, start, cfg):
    store.record_payment(charge, user_id, "trial", 49, "XTR", "p", start)
    return store.create_trial(user_id, charge, start, start + cfg.trial_days * DAY)


def payment(user_id, charge="charge-1", amount=49, currency="XTR", payload=None):
    return SimpleNamespace(
        currency=currency,
        total_amount=amount,
        invoice_payload=payload or make_payload("trial", user_id),
        telegram_payment_charge_id=charge,
    )


# Monthly subscription link


def test_monthly_link_created_once_with_telegram_30_day_period():
    cfg, store, bot = make_config(), Storage(":memory:"), FakeBot()
    first = run(access.get_monthly_link(bot, store, cfg))
    second = run(access.get_monthly_link(bot, store, cfg))
    assert first == second
    (call,) = bot.called("create_chat_subscription_invite_link")
    assert call["chat_id"] == CHANNEL_ID
    assert call["subscription_period"] == 2592000
    assert call["subscription_price"] == 499


def test_monthly_button_for_subscriber_does_not_create_link():
    cfg, store = make_config(), Storage(":memory:")
    bot = FakeBot({7: member(until=10_000)})
    text, markup = run(handlers.monthly_reply(bot, store, cfg, 7, now=5_000))
    assert "already subscribed" in text
    assert markup is None
    assert bot.called("create_chat_subscription_invite_link") == []


def test_monthly_button_for_non_member_gives_subscribe_link():
    cfg, store, bot = make_config(), Storage(":memory:"), FakeBot()
    text, markup = run(handlers.monthly_reply(bot, store, cfg, 7, now=0))
    assert "499" in text
    assert markup.inline_keyboard[0][0].url.startswith("https://t.me/+sub")


# Trial purchase


def test_trial_payment_grants_single_use_link():
    cfg, store, bot = make_config(), Storage(":memory:"), FakeBot()
    text, markup = run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7), now=1000))
    assert "Payment received" in text
    assert markup.inline_keyboard[0][0].url.startswith("https://t.me/+trial")
    (call,) = bot.called("create_chat_invite_link")
    assert call["member_limit"] == 1
    assert call["chat_id"] == CHANNEL_ID
    trial = store.active_trial(7, 1001)
    assert trial.expires_at == 1000 + 3 * DAY


def test_duplicate_payment_update_does_nothing_second_time():
    cfg, store, bot = make_config(), Storage(":memory:"), FakeBot()
    assert run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7), now=1000)) is not None
    assert run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7), now=1001)) is None
    assert len(bot.called("create_chat_invite_link")) == 1


def test_mismatched_payment_is_recorded_but_grants_nothing():
    cfg, store, bot = make_config(), Storage(":memory:"), FakeBot()
    run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7, amount=1), now=1000))
    run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7, charge="c2", payload=make_payload("trial", 8)), now=1000))
    assert bot.called("create_chat_invite_link") == []
    assert store.active_trial(7, 1001) is None
    assert store.record_payment("charge-1", 7, "x", 1, "XTR", "p", 0) is False  # was stored


def test_trial_link_failure_keeps_paid_trial_for_retry():
    cfg, store = make_config(), Storage(":memory:")
    bot = FakeBot(fail={"create_chat_invite_link"})
    text, markup = run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7), now=1000))
    assert "couldn't create your access link" in text
    assert store.active_trial(7, 1001) is not None
    status_text, status_markup = run(handlers.build_status(FakeBot(), store, cfg, 7, now=1001))
    assert "haven't joined" in status_text
    assert status_markup.inline_keyboard[0][0].callback_data == "trial_link"


def test_trial_blocked_when_used_or_already_member():
    cfg, store = make_config(), Storage(":memory:")
    paid_trial(store, 7, "c1", 0, cfg)
    assert "already used" in run(handlers.trial_block_reason(FakeBot(), store, cfg, 7))
    assert "already in the VIP" in run(handlers.trial_block_reason(FakeBot({8: member()}), store, cfg, 8))
    assert run(handlers.trial_block_reason(FakeBot(), store, cfg, 9)) is None
    assert "couldn't check" in run(handlers.trial_block_reason(FakeBot(fail={"get_chat_member"}), store, cfg, 9))


def test_repeat_trial_extends_when_allowed():
    cfg, store, bot = make_config(trial_once_per_user=False), Storage(":memory:"), FakeBot()
    first = paid_trial(store, 7, "c1", 0, cfg)
    run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7, charge="c2"), now=DAY))
    assert store.active_trial(7, DAY).expires_at == first.expires_at + 3 * DAY


# Trial expiry


def test_expired_trial_member_is_removed_without_permanent_ban():
    cfg, store = make_config(), Storage(":memory:")
    paid_trial(store, 7, "c1", 0, cfg)
    bot = FakeBot({7: member()})
    assert run(access.expire_trials(bot, store, cfg, now=3 * DAY)) == [(7, "removed")]
    assert bot.called("ban_chat_member") == [{"chat_id": CHANNEL_ID, "user_id": 7}]
    assert bot.called("unban_chat_member") == [{"chat_id": CHANNEL_ID, "user_id": 7, "only_if_banned": True}]
    assert run(access.expire_trials(bot, store, cfg, now=4 * DAY)) == []


def test_trial_not_ended_early():
    cfg, store = make_config(), Storage(":memory:")
    paid_trial(store, 7, "c1", 0, cfg)
    bot = FakeBot({7: member()})
    assert run(access.expire_trials(bot, store, cfg, now=3 * DAY - 1)) == []
    assert bot.calls == []


def test_paying_subscriber_and_admin_are_never_removed():
    cfg, store = make_config(), Storage(":memory:")
    paid_trial(store, 7, "c1", 0, cfg)
    paid_trial(store, 8, "c2", 0, cfg)
    bot = FakeBot({7: member(until=10 * DAY), 8: member(ChatMember.ADMINISTRATOR)})
    results = dict(run(access.expire_trials(bot, store, cfg, now=3 * DAY)))
    assert results == {7: "converted", 8: "admin"}
    assert bot.called("ban_chat_member") == []


def test_newer_trial_prevents_removal():
    cfg, store = make_config(trial_once_per_user=False), Storage(":memory:")
    paid_trial(store, 7, "c1", 0, cfg)
    store.record_payment("c2", 7, "trial", 49, "XTR", "p", DAY)
    store.create_trial(7, "c2", 3 * DAY, 6 * DAY)
    bot = FakeBot({7: member()})
    assert run(access.expire_trials(bot, store, cfg, now=3 * DAY)) == [(7, "extended")]
    assert bot.called("ban_chat_member") == []


def test_api_failure_keeps_trial_for_retry():
    cfg, store = make_config(), Storage(":memory:")
    paid_trial(store, 7, "c1", 0, cfg)
    bot = FakeBot({7: member()}, fail={"ban_chat_member"})
    assert run(access.expire_trials(bot, store, cfg, now=3 * DAY)) == []
    assert len(store.due_trials(3 * DAY)) == 1


def test_unused_trial_link_is_revoked_on_expiry():
    cfg, store = make_config(), Storage(":memory:")
    trial = paid_trial(store, 7, "c1", 0, cfg)
    store.set_trial_link(trial.id, "https://t.me/+unused")
    bot = FakeBot()
    assert run(access.expire_trials(bot, store, cfg, now=3 * DAY)) == [(7, "not_in_channel")]
    assert bot.called("revoke_chat_invite_link")[0]["invite_link"] == "https://t.me/+unused"


# Status


def test_status_messages():
    cfg, store = make_config(), Storage(":memory:")
    assert "admin" in run(handlers.build_status(FakeBot({1: member(ChatMember.OWNER)}), store, cfg, 1, 0))[0]
    assert "VIP Monthly is active" in run(handlers.build_status(FakeBot({2: member(until=DAY)}), store, cfg, 2, 0))[0]
    paid_trial(store, 3, "c3", 0, cfg)
    assert "trial is active" in run(handlers.build_status(FakeBot({3: member()}), store, cfg, 3, 1))[0]
    text, markup = run(handlers.build_status(FakeBot(), store, cfg, 4, 0))
    assert "don't have an active" in text and markup is not None
    assert "couldn't check" in run(handlers.build_status(FakeBot(fail={"get_chat_member"}), store, cfg, 5, 0))[0]


# Wiring


def test_application_builds_without_network():
    app = build_application(make_config(), Storage(":memory:"))
    commands = {c for h in app.handlers[0] for c in getattr(h, "commands", ())}
    assert commands == {"start", "subscribe", "status", "rules", "paysupport"}
    assert app.job_queue is not None


def test_main_menu_has_required_buttons():
    rows = handlers.main_menu(make_config()).inline_keyboard
    labels = [row[0].text for row in rows]
    assert labels[0] == "💎 VIP Monthly — 499 ⭐"
    assert labels[1] == "⏳ 3-day trial — 49 ⭐"
    assert "My membership" in labels[2]
    assert rows[3][0].url == "https://t.me/yourshakhira"
