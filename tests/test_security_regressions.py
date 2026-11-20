"""Regression tests for the Phase 0 security findings in the subscription bot.

H1  unlimited trial invite links / old links never revoked / joins via someone else's link kept forever
M1  payment saved but trial lost after a crash
M2  rejected payments not reported to the admin
M3  failed unban leaves a member permanently banned
     + admin alerts, backups, live-bot webhook protection
"""

import asyncio
import os
import sqlite3
import stat
from types import SimpleNamespace

import pytest
from telegram import ChatMember

from shakhira_bot import access, backup, handlers
from shakhira_bot.__main__ import RedactingFormatter, webhook_problem
from shakhira_bot.alerts import AdminAlerts
from shakhira_bot.app import build_application
from shakhira_bot.config import Config, ConfigError
from shakhira_bot.payments import make_payload
from shakhira_bot.storage import ACCEPTED, REJECTED, Storage

from .fakes import CHANNEL_ID, FakeBot, join_update, make_config, member

DAY = 86400
ADMIN = 999


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def store():
    s = Storage(":memory:")
    yield s
    s.close()


def alerts():
    return AdminAlerts([ADMIN], cooldown=0)


def payment(user_id, charge="charge-1", amount=49, currency="XTR", payload=None):
    return SimpleNamespace(currency=currency, total_amount=amount,
                           invoice_payload=payload or make_payload("trial", user_id), telegram_payment_charge_id=charge)


def buy_trial(store, cfg, user_id=7, charge="c1", now=0):
    _, trial = store.record_trial_payment(charge, user_id, "trial", 49, "XTR", "p", now,
                                          accepted=True, trial_seconds=cfg.trial_days * DAY)
    return trial


# H1: trial invite links


def test_reissue_is_capped_per_trial(store):
    cfg, bot = make_config(), FakeBot()
    trial = buy_trial(store, cfg)
    for _ in range(access.MAX_TRIAL_LINKS):
        text, markup = run(handlers.reissue_trial_link(bot, store, cfg, 7, now=10))
        assert markup.inline_keyboard[0][0].url.startswith("https://t.me/+trial")
    text, markup = run(handlers.reissue_trial_link(bot, store, cfg, 7, now=10))
    assert "maximum number of access links" in text and markup is None
    assert len(bot.called("create_chat_invite_link")) == access.MAX_TRIAL_LINKS
    assert store.trial_link_count(trial.id) == access.MAX_TRIAL_LINKS


def test_new_link_revokes_every_previous_link(store):
    cfg, bot = make_config(), FakeBot()
    trial = buy_trial(store, cfg)
    first = run(access.issue_trial_link(bot, store, cfg, trial, now=10))
    second = run(access.issue_trial_link(bot, store, cfg, trial, now=20))
    assert first != second
    assert [c["invite_link"] for c in bot.called("revoke_chat_invite_link")] == [first]
    assert [link.invite_link for link in store.unrevoked_trial_links(trial.id)] == [second]


def test_no_new_link_while_an_old_one_may_still_work(store):
    cfg = make_config()
    trial = buy_trial(store, cfg)
    run(access.issue_trial_link(FakeBot(), store, cfg, trial, now=10))
    bot = FakeBot(fail={"revoke_chat_invite_link"})
    text, markup = run(handlers.reissue_trial_link(bot, store, cfg, 7, now=20))
    assert "couldn't replace your old access link" in text and markup is None
    assert bot.called("create_chat_invite_link") == []


def test_expired_old_link_does_not_block_a_new_one(store):
    cfg = make_config()
    trial = buy_trial(store, cfg)
    run(access.issue_trial_link(FakeBot(), store, cfg, trial, now=10))
    later = 10 + access.TRIAL_LINK_TTL_SECONDS + 1  # the first link has expired on its own
    bot = FakeBot(fail={"revoke_chat_invite_link"})
    assert run(access.issue_trial_link(bot, store, cfg, trial, now=later)).startswith("https://t.me/+trial")


def test_no_reissue_for_buyer_already_in_channel(store):
    cfg = make_config()
    buy_trial(store, cfg)
    bot = FakeBot({7: member()})
    text, markup = run(handlers.reissue_trial_link(bot, store, cfg, 7, now=10))
    assert "trial is active" in text and markup is None
    assert bot.called("create_chat_invite_link") == []


def test_no_reissue_without_active_trial(store):
    bot = FakeBot()
    text, markup = run(handlers.reissue_trial_link(bot, store, make_config(), 7, now=10))
    assert "don't have an active" in text
    assert bot.called("create_chat_invite_link") == []


def test_buyer_joining_with_own_link_is_recorded(store):
    cfg, bot = make_config(), FakeBot()
    trial = buy_trial(store, cfg)
    link = run(access.issue_trial_link(bot, store, cfg, trial, now=10))
    event = run(handlers.process_member_change(bot, store, cfg, join_update(7, link, "trial 7"), now=20))
    assert event == "joined_trial"
    assert store.active_trial(7, 30).joined_at == 20
    assert bot.called("ban_chat_member") == []


def test_buyer_joining_with_an_older_link_still_counts(store):
    cfg, bot = make_config(), FakeBot()
    trial = buy_trial(store, cfg)
    old = run(access.issue_trial_link(bot, store, cfg, trial, now=10))
    run(access.issue_trial_link(bot, store, cfg, trial, now=20))
    assert run(handlers.process_member_change(bot, store, cfg, join_update(7, old, "trial 7"), now=30)) == "joined_trial"


def test_stranger_using_buyers_link_is_removed_and_admin_alerted(store):
    cfg, bot, al = make_config(), FakeBot(), alerts()
    trial = buy_trial(store, cfg)
    link = run(access.issue_trial_link(bot, store, cfg, trial, now=10))
    event = run(handlers.process_member_change(bot, store, cfg, join_update(8, link, "trial 7"), now=20, alerts=al))
    assert event == "unauthorized_removed"
    assert bot.called("ban_chat_member") == [{"chat_id": CHANNEL_ID, "user_id": 8}]
    assert bot.called("unban_chat_member")[0]["user_id"] == 8  # removed, not permanently banned
    assert link in [c["invite_link"] for c in bot.called("revoke_chat_invite_link")]
    assert store.active_trial(7, 30).joined_at is None  # the buyer's trial is untouched
    assert "Removed user 8" in al.sent[-1]
    row = store.conn.execute("SELECT event FROM member_events WHERE user_id = 8").fetchone()
    assert row["event"] == "unauthorized_removed"


def test_stranger_removal_failure_is_escalated(store):
    cfg, al = make_config(), alerts()
    trial = buy_trial(store, cfg)
    link = run(access.issue_trial_link(FakeBot(), store, cfg, trial, now=10))
    bot = FakeBot(fail={"ban_chat_member"})
    event = run(handlers.process_member_change(bot, store, cfg, join_update(8, link, "trial 7"), now=20, alerts=al))
    assert event == "unauthorized_remove_failed"
    assert "could NOT be removed" in al.sent[-1]


def test_joining_with_link_of_ended_trial_is_removed(store):
    cfg, bot = make_config(), FakeBot()
    trial = buy_trial(store, cfg)
    link = run(access.issue_trial_link(bot, store, cfg, trial, now=10))
    store.end_trial(trial.id, "ended", 3 * DAY)
    event = run(handlers.process_member_change(bot, store, cfg, join_update(7, link, "trial 7"), now=3 * DAY + 1))
    assert event == "unauthorized_removed"


def test_admin_joining_via_trial_link_is_left_alone(store):
    cfg, bot = make_config(), FakeBot()
    trial = buy_trial(store, cfg)
    link = run(access.issue_trial_link(bot, store, cfg, trial, now=10))
    update = join_update(8, link, "trial 7", status=ChatMember.ADMINISTRATOR)
    assert run(handlers.process_member_change(bot, store, cfg, update, now=20)) == "admin"
    assert bot.called("ban_chat_member") == []


def test_unknown_trial_link_from_older_bot_never_removes(store):
    cfg, bot, al = make_config(), FakeBot(), alerts()
    update = join_update(8, "https://t.me/+fromOldBot", "trial 8")
    assert run(handlers.process_member_change(bot, store, cfg, update, now=20, alerts=al)) == "unknown_trial_link"
    assert bot.called("ban_chat_member") == []
    assert "no record" in al.sent[-1]


def test_wrong_link_but_own_paid_trial_is_not_removed(store):
    cfg, bot = make_config(), FakeBot()
    trial7 = buy_trial(store, cfg, 7, "c1")
    buy_trial(store, cfg, 8, "c2")
    link = run(access.issue_trial_link(bot, store, cfg, trial7, now=10))
    assert run(handlers.process_member_change(bot, store, cfg, join_update(8, link, "trial 7"), now=20)) == "joined_trial"
    assert bot.called("ban_chat_member") == []


def test_other_channels_and_non_trial_joins_are_only_logged(store):
    cfg, bot = make_config(), FakeBot()
    assert run(handlers.process_member_change(bot, store, cfg, join_update(8, None, None, chat_id=-100555), 1)) is None
    sub = join_update(8, "https://t.me/+sub1", "VIP Monthly 499", subscription_period=2592000)
    assert run(handlers.process_member_change(bot, store, cfg, sub, 1)) == "joined_subscription"
    assert bot.calls == []


def test_expiry_revokes_all_unused_links(store):
    cfg, bot = make_config(), FakeBot()
    trial = buy_trial(store, cfg)
    link = run(access.issue_trial_link(bot, store, cfg, trial, now=10))
    assert run(access.expire_trials(bot, store, cfg, now=3 * DAY)) == [(7, "not_in_channel")]
    assert bot.called("revoke_chat_invite_link")[-1]["invite_link"] == link
    assert store.unrevoked_trial_links(trial.id) == []


# M1: payment + trial survive crashes


def test_payment_and_trial_are_saved_together(store, monkeypatch):
    cfg = make_config()

    def crash(*a, **k):
        raise sqlite3.OperationalError("disk I/O error (simulated crash)")

    monkeypatch.setattr(store, "_insert_trial", crash)
    with pytest.raises(sqlite3.OperationalError):
        run(handlers.process_trial_payment(FakeBot(), store, cfg, 7, payment(7), now=1000))
    assert store.payment("charge-1") is None  # rolled back: the payment is not half-saved
    monkeypatch.undo()

    # Telegram re-delivers the update after the restart: the buyer gets the trial in full.
    text, markup = run(handlers.process_trial_payment(FakeBot(), store, cfg, 7, payment(7), now=1100))
    assert "Payment received" in text
    assert store.payment("charge-1").status == ACCEPTED
    assert store.trial_for_charge("charge-1").user_id == 7


def test_redelivered_update_after_crash_before_link_sends_the_link(store):
    cfg = make_config()
    # Crash happened after the transaction committed but before the link was created.
    store.record_trial_payment("charge-1", 7, "trial", 49, "XTR", "p", 1000, accepted=True, trial_seconds=3 * DAY)
    bot = FakeBot()
    text, markup = run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7), now=1100))
    assert "Payment received" in text and markup is not None
    assert len(bot.called("create_chat_invite_link")) == 1
    # Any further duplicate stays silent and creates nothing.
    assert run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7), now=1200)) is None
    assert len(bot.called("create_chat_invite_link")) == 1


def test_duplicate_of_rejected_payment_stays_rejected(store):
    cfg, bot = make_config(), FakeBot()
    run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7, amount=1), now=1000))
    assert run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7, amount=1), now=1001)) is None
    assert store.payment("charge-1").status == REJECTED
    assert bot.called("create_chat_invite_link") == []


def test_legacy_payment_without_trial_is_recovered(store):
    cfg, bot, al = make_config(), FakeBot(), alerts()
    store.record_payment("old-ok", 7, "trial", 49, "XTR", make_payload("trial", 7), 0)  # pre-upgrade row
    store.record_payment("old-bad", 8, "trial", 1, "XTR", make_payload("trial", 8), 0)
    assert run(access.recover_unprocessed_payments(bot, store, cfg, now=500, alerts=al)) == [7]
    trial = store.active_trial(7, 501)
    assert trial.starts_at == 500 and trial.expires_at == 500 + 3 * DAY  # full trial from now
    assert bot.called("send_message")[0]["chat_id"] == 7
    assert store.payment("old-bad").status == REJECTED and store.active_trial(8, 501) is None
    assert any("Recovered a paid trial" in a for a in al.sent) and any("did not match" in a for a in al.sent)
    assert run(access.recover_unprocessed_payments(bot, store, cfg, now=600)) == []  # idempotent


# M2: admin hears about payments that granted nothing


def test_rejected_payment_alerts_admin(store):
    cfg, bot, al = make_config(), FakeBot(), alerts()
    run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7, amount=1), now=1000, alerts=al))
    assert "NO access was given" in al.sent[-1]
    assert [c["chat_id"] for c in bot.called("send_message")] == [ADMIN]


def test_link_failure_after_payment_alerts_admin(store):
    cfg, al = make_config(), alerts()
    bot = FakeBot(fail={"create_chat_invite_link"})
    text, _ = run(handlers.process_trial_payment(bot, store, cfg, 7, payment(7), now=1000, alerts=al))
    assert "couldn't create your access link" in text
    assert "invite link could not be created" in al.sent[-1]


# M3: failed unban recovery


def test_failed_unban_is_queued_and_retried_until_it_works(store):
    cfg = make_config()
    buy_trial(store, cfg)
    bot = FakeBot({7: member()}, fail={"unban_chat_member"})
    assert run(access.expire_trials(bot, store, cfg, now=3 * DAY)) == [(7, "removed")]
    assert store.due_trials(4 * DAY) == []  # trial ended: the member is out
    assert store.pending_unbans() == [(7, 1)]

    run(access.retry_pending_unbans(bot, store, cfg, now=3 * DAY + 300))
    assert store.pending_unbans() == [(7, 2)]
    bot.fail.clear()
    assert run(access.retry_pending_unbans(bot, store, cfg, now=3 * DAY + 600)) == [7]
    assert store.pending_unbans() == []


def test_admin_alerted_when_unban_keeps_failing(store):
    cfg, al = make_config(), alerts()
    store.add_pending_unban(7, 0)
    bot = FakeBot(fail={"unban_chat_member"})
    for i in range(access.UNBAN_ALERT_AFTER):
        run(access.retry_pending_unbans(bot, store, cfg, now=i, alerts=al))
    assert len([a for a in al.sent if "still BANNED" in a]) == 1


def test_failed_ban_keeps_trial_for_retry_and_queues_nothing(store):
    cfg = make_config()
    buy_trial(store, cfg)
    bot = FakeBot({7: member()}, fail={"ban_chat_member"})
    assert run(access.expire_trials(bot, store, cfg, now=3 * DAY)) == []
    assert len(store.due_trials(3 * DAY)) == 1 and store.pending_unbans() == []


def test_maintenance_runs_unbans_recovery_and_expiry(store):
    cfg = make_config()
    store.add_pending_unban(5, 0)
    buy_trial(store, cfg)
    bot = FakeBot({7: member()})
    run(handlers.run_maintenance(bot, store, cfg, now=3 * DAY))
    assert store.pending_unbans() == []
    assert {c["user_id"] for c in bot.called("unban_chat_member")} == {5, 7}
    assert bot.called("send_message")[0]["chat_id"] == 7  # trial-ended message with the monthly link


# Admin alerts


def test_alerts_are_throttled_and_never_raise():
    clock = [0]
    al = AdminAlerts([1, 2], cooldown=600, clock=lambda: clock[0])
    bot = FakeBot()
    assert run(al.send(bot, "x")) is True
    assert run(al.send(bot, "x")) is False  # same alert within cooldown
    clock[0] = 601
    assert run(al.send(bot, "x")) is True
    assert len(bot.called("send_message")) == 4  # two admins, twice
    assert run(AdminAlerts([]).send(bot, "y")) is False
    assert run(AdminAlerts([1], cooldown=0).send(FakeBot(fail={"send_message"}), "z")) is False


def test_error_handler_alerts_admin_without_leaking_token():
    cfg, bot, al = make_config(), FakeBot(), alerts()
    context = SimpleNamespace(
        application=SimpleNamespace(bot_data={"config": cfg, "storage": None, "alerts": al}),
        bot=bot, error=RuntimeError(f"request to /bot{cfg.bot_token}/getMe failed"),
    )
    run(handlers.on_error(None, context))
    assert cfg.bot_token not in al.sent[-1] and "[REDACTED]" in al.sent[-1]


def test_log_formatter_hides_token():
    import logging

    fmt = RedactingFormatter("%(message)s")
    fmt.secret = "123456:TEST-TOKEN"
    record = logging.LogRecord("x", logging.ERROR, "f", 1, "url /bot123456:TEST-TOKEN/x", None, None)
    assert "TEST-TOKEN" not in fmt.format(record)


def test_admin_chat_ids_config():
    base = {"BOT_TOKEN": "1:T", "VIP_CHANNEL_ID": "-1001"}
    assert Config.from_env({**base, "ADMIN_CHAT_IDS": "111, -100222"}).admin_chat_ids == (111, -100222)
    assert Config.from_env(base).admin_chat_ids == ()
    with pytest.raises(ConfigError, match="ADMIN_CHAT_IDS"):
        Config.from_env({**base, "ADMIN_CHAT_IDS": "@me"})
    cfg = Config.from_env(base)
    assert (cfg.monthly_price, cfg.trial_price, cfg.trial_days) == (499, 49, 3)  # prices untouched


# Backups


def test_backup_is_consistent_private_and_pruned(tmp_path):
    db = tmp_path / "bot.db"
    store = Storage(str(db))
    store.record_payment("c1", 7, "trial", 49, "XTR", "p", 0, status=ACCEPTED)
    backups = tmp_path / "backups"
    (backups).mkdir()
    (backups / "notes.txt").write_text("keep me")
    paths = [backup.make_backup(store, str(backups), keep=2, now=1_800_000_000 + i) for i in range(3)]
    store.close()

    remaining = backup.list_backups(str(backups))
    assert remaining == paths[1:]  # oldest pruned
    assert (backups / "notes.txt").exists()  # unrelated files untouched
    assert not [p for p in os.listdir(backups) if p.endswith(".partial")]
    assert stat.S_IMODE(os.stat(paths[-1]).st_mode) == 0o600
    copy = Storage(paths[-1])
    assert copy.payment("c1").user_id == 7
    copy.close()


def test_backup_job_failure_alerts_admin(tmp_path, monkeypatch):
    cfg, al, bot = make_config(backup_dir=str(tmp_path / "b")), alerts(), FakeBot()
    store = Storage(":memory:")

    def broken(path):
        raise sqlite3.DatabaseError("disk full")

    monkeypatch.setattr(store, "backup_to", broken)
    context = SimpleNamespace(application=SimpleNamespace(bot_data={"config": cfg, "storage": store, "alerts": al}),
                              bot=bot)
    run(handlers.backup_job(context))
    assert "backup failed" in al.sent[-1]
    assert backup.list_backups(cfg.backup_dir) == []
    store.close()


def test_old_database_is_upgraded_in_place(tmp_path):
    path = str(tmp_path / "old.db")
    old = sqlite3.connect(path)
    old.executescript("""
        CREATE TABLE payments (id INTEGER PRIMARY KEY, telegram_payment_charge_id TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL, plan TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL,
            payload TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE trials (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, charge_id TEXT NOT NULL UNIQUE,
            starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, invite_link TEXT, joined_at INTEGER,
            status TEXT NOT NULL DEFAULT 'active', ended_at INTEGER);
        INSERT INTO payments VALUES (1, 'c1', 7, 'trial', 49, 'XTR', 'p', 0);
        INSERT INTO trials VALUES (1, 7, 'c1', 0, 259200, 'https://t.me/+legacy', NULL, 'active', NULL);
    """)
    old.commit()
    old.close()
    store = Storage(path)
    assert store.payment("c1").status is None  # existing records kept as they were
    assert store.trial_for_link("https://t.me/+legacy").user_id == 7  # old link still recognised
    assert store.trial_payments_without_trial() == []
    store.close()


# Live bot protection


def test_refuses_to_start_when_token_has_a_webhook():
    assert "webhook" in run(webhook_problem(FakeBot(webhook_url="https://live-bot.example/hook")))
    assert run(webhook_problem(FakeBot())) is None


def test_application_wires_alerts_and_backup_job():
    store = Storage(":memory:")
    app = build_application(make_config(admin_chat_ids=(ADMIN,)), store)
    assert app.bot_data["alerts"].chat_ids == (ADMIN,)
    names = {job.callback.__name__ for job in app.job_queue.jobs()}
    assert {"expiry_job", "backup_job"} <= names
    app_no_backup = build_application(make_config(backup_interval_hours=0), store)
    assert "backup_job" not in {job.callback.__name__ for job in app_no_backup.job_queue.jobs()}
    store.close()
