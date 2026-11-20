"""Content scheduling, polls/quizzes, paid media, promotions, captions, reminders, admin actions,
join requests, moderation, reactions, profiles and the send-only worker. All with a fake bot."""

import asyncio
import json
from datetime import timedelta
from types import SimpleNamespace

import pytest
from telegram import ChatMember
from telegram.error import BadRequest, Forbidden, RetryAfter, TimedOut

from shakhira_bot import features, scheduler
from shakhira_bot.ops import FEATURES, OpsError, validate_content
from shakhira_bot.storage import Storage
from shakhira_bot.worker import ForbiddenCall, SendOnlyBot, run_worker

from .fakes import CHANNEL_ID, FakeBot, make_config, member

NOW = 1_800_000_000
DAY = 86400


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def store():
    s = Storage(":memory:")
    s.ops.clock = lambda: NOW
    for name in FEATURES:
        s.ops.set_feature(name, True, "test")
    return s


def ops_of(store):
    ops = store.ops
    ops.clock = lambda: NOW
    return ops


def scheduled(store, **data):
    ops = ops_of(store)
    item = ops.create_content({"target": "public", **data}, "admin")
    return ops.schedule_content(item["id"], NOW - 1, "admin")


# Validation


@pytest.mark.parametrize("data, message", [
    ({"kind": "text", "target": "public"}, "Write the message"),
    ({"kind": "photo", "target": "public", "media_url": "http://insecure"}, "https://"),
    ({"kind": "poll", "target": "public", "text": "Q?", "options": ["only one"]}, "2 to 10"),
    ({"kind": "poll", "target": "public", "text": "Q?", "options": ["a", "a"]}, "different"),
    ({"kind": "quiz", "target": "public", "text": "Q?", "options": ["a", "b"], "correct_option": 5}, "correct answer"),
    ({"kind": "paid_media", "target": "vip", "media_url": "https://x/a.jpg", "star_count": 0}, "1 to 10,000"),
    ({"kind": "poll", "target": "public", "text": "Q?", "options": ["a", "b"], "button_text": "x",
      "button_url": "https://x"}, "can't have a button"),
    ({"kind": "text", "target": "elsewhere", "text": "hi"}, "public or the VIP"),
    ({"kind": "text", "target": "public", "text": "x" * 5000}, "longer than 4096"),
    ({"kind": "text", "target": "public", "text": "hi", "button_text": "Go", "button_url": "javascript:alert(1)"},
     "https:// or t.me"),
])
def test_invalid_content_is_rejected_with_a_clear_message(data, message):
    with pytest.raises(OpsError, match=message):
        validate_content(data)


def test_everything_is_off_by_default():
    ops = Storage(":memory:").ops
    assert not any(f["enabled"] for f in ops.features().values())
    assert ops.join_policy("vip") == "manual"
    with pytest.raises(OpsError):
        ops.set_join_policy("vip", "approve_all", "admin")  # would give paid content away


def test_worker_does_nothing_while_features_are_off():
    store = Storage(":memory:")
    ops = ops_of(store)
    item = ops.create_content({"kind": "text", "target": "public", "text": "hello"}, "admin")
    ops.schedule_content(item["id"], NOW - 1, "admin")
    bot = FakeBot()
    run(scheduler.run_cycle(bot, store, make_config(), NOW))
    assert bot.calls == [] and ops.content(item["id"])["status"] == "scheduled"


# Publishing


def test_each_kind_is_sent_with_the_right_method(store):
    cfg, bot = make_config(), FakeBot()
    items = [
        scheduled(store, kind="text", text="Good morning", button_text="Open", button_url="https://t.me/yourshakhira"),
        scheduled(store, kind="photo", media_url="https://res.cloudinary.com/d/a.jpg", text="cap"),
        scheduled(store, kind="video", media_url="https://res.cloudinary.com/d/a.mp4"),
        scheduled(store, kind="animation", media_url="https://res.cloudinary.com/d/a.gif"),
        scheduled(store, kind="poll", text="Which look?", options=["Red", "Blue"], multiple_answers=True),
        scheduled(store, kind="quiz", text="Guess?", options=["A", "B", "C"], correct_option=2, explanation="C!"),
        scheduled(store, kind="paid_media", target="vip", media_url="https://res.cloudinary.com/d/b.mp4",
                  star_count=50, text="Exclusive"),
        scheduled(store, kind="promo", text="Join VIP today"),
    ]
    counts = run(scheduler.publish_due(bot, ops_of(store), cfg, NOW))
    assert counts["posted"] == len(items)
    assert [n for n, _ in bot.calls] == ["send_message", "send_photo", "send_video", "send_animation", "send_poll",
                                         "send_poll", "send_paid_media", "send_message"]
    poll, quiz = bot.called("send_poll")
    assert poll["is_anonymous"] is True and poll["allows_multiple_answers"] is True
    assert quiz["type"] == "quiz" and quiz["correct_option_id"] == 2 and quiz["explanation"] == "C!"
    paid = bot.called("send_paid_media")[0]
    assert paid["chat_id"] == CHANNEL_ID and paid["star_count"] == 50 and type(paid["media"][0]).__name__ == "InputPaidMediaVideo"
    promo = bot.called("send_message")[1]
    assert promo["reply_markup"].inline_keyboard[0][0].url == f"https://t.me/ShakhiraVIPBot?start=promo_{items[-1]['id']}"
    assert all(ops_of(store).content(i["id"])["status"] == "posted" for i in items)


def test_post_is_never_sent_twice(store):
    cfg, bot = make_config(), FakeBot()
    item = scheduled(store, kind="text", text="once")
    run(scheduler.publish_due(bot, ops_of(store), cfg, NOW))
    run(scheduler.publish_due(bot, ops_of(store), cfg, NOW + 60))
    assert len(bot.called("send_message")) == 1
    assert ops_of(store).content(item["id"])["message_id"] is not None


def test_future_posts_wait(store):
    ops = ops_of(store)
    item = ops.create_content({"kind": "text", "target": "public", "text": "later"}, "admin")
    ops.schedule_content(item["id"], NOW + 3600, "admin")
    bot = FakeBot()
    run(scheduler.publish_due(bot, ops, make_config(), NOW))
    assert bot.calls == []


def test_refused_post_fails_and_alerts(store):
    from shakhira_bot.alerts import AdminAlerts

    bot, alerts = FakeBot(), AdminAlerts([1], cooldown=0)
    bot.raise_on["send_photo"] = BadRequest("Wrong file identifier/http url specified")
    item = scheduled(store, kind="photo", media_url="https://x/broken.jpg")
    run(scheduler.publish_due(bot, ops_of(store), make_config(), NOW, alerts))
    row = ops_of(store).content(item["id"])
    assert row["status"] == "failed" and "Wrong file" in row["last_error"]
    assert "refused" in alerts.sent[-1]


def test_lost_confirmation_is_uncertain_and_never_retried(store):
    bot = FakeBot()
    bot.raise_on["send_message"] = TimedOut()
    item = scheduled(store, kind="text", text="maybe")
    run(scheduler.publish_due(bot, ops_of(store), make_config(), NOW))
    del bot.raise_on["send_message"]
    run(scheduler.publish_due(bot, ops_of(store), make_config(), NOW + 600))
    assert ops_of(store).content(item["id"])["status"] == "uncertain"
    assert len(bot.called("send_message")) == 1


@pytest.mark.filterwarnings("ignore::DeprecationWarning")  # raised inside PTB's own RetryAfter()
def test_rate_limit_reschedules(store):
    bot = FakeBot()
    bot.raise_on["send_message"] = RetryAfter(timedelta(seconds=30))
    item = scheduled(store, kind="text", text="busy")
    run(scheduler.publish_due(bot, ops_of(store), make_config(), NOW))
    row = ops_of(store).content(item["id"])
    assert row["status"] == "scheduled" and row["scheduled_at"] == NOW + 30


def test_crash_mid_send_becomes_uncertain(store):
    ops = ops_of(store)
    item = scheduled(store, kind="text", text="x")
    assert ops.claim_for_sending(item["id"], NOW - 3600)  # worker died after claiming
    bot = FakeBot()
    run(scheduler.publish_due(bot, ops, make_config(), NOW))
    assert ops.content(item["id"])["status"] == "uncertain" and bot.called("send_message") == []


def test_caption_library_rotates_evenly(store):
    ops = ops_of(store)
    for text in ("one", "two"):
        ops.add_caption(text, "admin")
    for i in range(4):
        scheduled(store, kind="photo", media_url=f"https://x/{i}.jpg", use_caption_library=True)
    bot = FakeBot()
    run(scheduler.publish_due(bot, ops, make_config(), NOW))
    assert [c["caption"] for c in bot.called("send_photo")] == ["one", "two", "one", "two"]
    assert ops.content_list(status="posted")[0]["text"] in ("one", "two")  # chosen caption saved


# Polls


def test_polls_close_on_time_and_keep_results(store):
    ops, bot = ops_of(store), FakeBot()
    item = scheduled(store, kind="poll", text="Q?", options=["a", "b"], close_after_minutes=60)
    run(scheduler.publish_due(bot, ops, make_config(), NOW))
    assert run(scheduler.close_due_polls(bot, ops, make_config(), NOW + 59 * 60)) == 0
    assert run(scheduler.close_due_polls(bot, ops, make_config(), NOW + 60 * 60)) == 1
    results = json.loads(ops.content(item["id"])["poll_results_json"])
    assert results["total_voters"] == 4 and results["options"][0]["votes"] == 3
    assert ops.analytics(NOW + 3600)["polls"][0]["total_voters"] == 4


# Admin actions


def test_admin_actions_are_carried_out_and_audited(store):
    ops, cfg = ops_of(store), make_config()
    req = ops.record_join_request(CHANNEL_ID, 55, "fan", "Fan", NOW)
    ops.queue_action("approve_join", {"request_id": req}, "admin")
    ops.queue_action("send_dm", {"user_id": 7, "text": "Hello"}, "admin")
    ops.queue_action("remove_member", {"user_id": 8}, "admin")
    ops.queue_action("unban_member", {"user_id": 9}, "admin")
    bot = FakeBot({8: member()})
    counts = run(scheduler.run_admin_actions(bot, store, ops, cfg, NOW))
    assert counts == {"done": 4, "failed": 0}
    assert ops.join_request(req)["status"] == "approved"
    assert bot.called("send_message")[0] == {"chat_id": 7, "text": "Hello"}
    assert bot.called("ban_chat_member")[0]["user_id"] == 8
    assert any(a["action"] == "action_done" for a in ops.audit_entries())


def test_admin_cannot_be_removed_from_the_dashboard(store):
    ops = ops_of(store)
    ops.queue_action("remove_member", {"user_id": 8}, "admin")
    bot = FakeBot({8: member(ChatMember.ADMINISTRATOR)})
    assert run(scheduler.run_admin_actions(bot, store, ops, make_config(), NOW)) == {"done": 0, "failed": 1}
    assert bot.called("ban_chat_member") == []
    assert "admin" in ops.actions()[0]["error"]


def test_action_validation():
    ops = Storage(":memory:").ops
    with pytest.raises(OpsError):
        ops.queue_action("approve_join", {"request_id": 99}, "admin")
    with pytest.raises(OpsError):
        ops.queue_action("send_dm", {"user_id": 7, "text": ""}, "admin")
    with pytest.raises(OpsError):
        ops.queue_action("format_disk", {}, "admin")


# Reminders


def test_trial_and_renewal_reminders_are_sent_once(store):
    cfg, ops = make_config(), ops_of(store)
    _, trial = store.record_trial_payment("c1", 7, "trial", 49, "XTR", "p", NOW - 2 * DAY - 100, accepted=True,
                                          trial_seconds=3 * DAY)
    store.conn.execute("UPDATE trials SET joined_at=? WHERE id=?", (NOW - DAY, trial.id))
    store.log_member_event(8, "joined_subscription", "VIP Monthly 499", NOW + 2 * DAY, NOW - 28 * DAY)
    store.log_member_event(9, "joined_subscription", "VIP Monthly 499", NOW + 2 * DAY, NOW - 28 * DAY)
    store.log_member_event(9, "left", None, None, NOW - DAY)  # left: no reminder
    bot = FakeBot()
    assert run(scheduler.send_reminders(bot, store, ops, cfg, NOW)) == 2
    assert run(scheduler.send_reminders(bot, store, ops, cfg, NOW + 60)) == 0
    assert sorted(c["chat_id"] for c in bot.called("send_message")) == [7, 8]
    assert bot.called("create_chat_subscription_invite_link") == []  # worker never creates links


def test_blocked_user_reminder_is_not_retried_forever(store):
    store.log_member_event(8, "joined_subscription", "VIP", NOW + DAY, NOW - 29 * DAY)
    bot = FakeBot()
    bot.raise_on["send_message"] = Forbidden("bot was blocked by the user")
    run(scheduler.send_reminders(bot, store, ops_of(store), make_config(), NOW))
    run(scheduler.send_reminders(bot, store, ops_of(store), make_config(), NOW + 60))
    assert len(bot.called("send_message")) == 1


# Join requests (full bot)


def user(uid=55):
    return SimpleNamespace(id=uid, username="fan", first_name="Fan")


def test_vip_join_request_manual_by_default(store):
    bot = FakeBot()
    outcome = run(features.decide_join_request(bot, ops_of(store), store, make_config(), "vip", CHANNEL_ID, user(), NOW))
    assert outcome == "pending" and bot.called("approve_chat_join_request") == []
    assert bot.called("send_message")[0]["chat_id"] == 55  # pointed to the paid plans
    assert ops_of(store).join_requests()[0]["user_id"] == 55


def test_vip_join_request_approved_only_for_paid_trial(store):
    ops = ops_of(store)
    ops.set_join_policy("vip", "approve_paid", "admin")
    bot = FakeBot()
    assert run(features.decide_join_request(bot, ops, store, make_config(), "vip", CHANNEL_ID, user(55), NOW)) == "pending"
    store.record_trial_payment("c1", 56, "trial", 49, "XTR", "p", NOW, accepted=True, trial_seconds=3 * DAY)
    assert run(features.decide_join_request(bot, ops, store, make_config(), "vip", CHANNEL_ID, user(56), NOW)) == "approved"
    assert [c["user_id"] for c in bot.called("approve_chat_join_request")] == [56]


def test_public_join_request_auto_approve(store):
    ops = ops_of(store)
    ops.set_join_policy("public", "approve_all", "admin")
    bot = FakeBot()
    assert run(features.decide_join_request(bot, ops, store, make_config(), "public", -1009, user(), NOW)) == "approved"


def test_channel_target_matching():
    cfg = make_config()
    assert features.channel_target(cfg, SimpleNamespace(id=CHANNEL_ID, username=None)) == "vip"
    assert features.channel_target(cfg, SimpleNamespace(id=-1, username="YourShakhira")) == "public"
    assert features.channel_target(cfg, SimpleNamespace(id=-2, username="other")) is None


# Moderation (full bot, existing discussion group only)


GROUP = -100777


def group_msg(text, uid=60, **extra):
    return SimpleNamespace(chat=SimpleNamespace(id=GROUP), from_user=SimpleNamespace(id=uid, is_bot=False,
                           first_name="Spammer"), text=text, caption=None, message_id=5, is_automatic_forward=False,
                           sender_chat=None, **extra)


def test_moderation_rules(store):
    ops, cfg = ops_of(store), make_config(discussion_group_id=GROUP)
    ops.add_moderation_rule("word", "scam", "delete_warn", "admin")
    ops.add_moderation_rule("link", "bit.ly", "delete", "admin")
    bot = FakeBot({60: member()})
    assert run(features.moderate_message(bot, ops, cfg, group_msg("hello friends"), NOW)) is None
    assert run(features.moderate_message(bot, ops, cfg, group_msg("not a scammer"), NOW)) is None  # whole words only
    assert run(features.moderate_message(bot, ops, cfg, group_msg("this is a SCAM!"), NOW)) == "warned"
    assert run(features.moderate_message(bot, ops, cfg, group_msg("see https://bit.ly/x"), NOW)) == "deleted"
    assert run(features.moderate_message(bot, ops, cfg, group_msg("scam again"), NOW)) == "muted"  # 3rd strike
    assert len(bot.called("delete_message")) == 3 and len(bot.called("restrict_chat_member")) == 1


def test_moderation_never_touches_admins_or_other_chats(store):
    ops = ops_of(store)
    ops.add_moderation_rule("word", "scam", "delete", "admin")
    bot = FakeBot({60: member(ChatMember.ADMINISTRATOR)})
    assert run(features.moderate_message(bot, ops, make_config(discussion_group_id=GROUP), group_msg("scam"), NOW)) is None
    assert run(features.moderate_message(bot, ops, make_config(), group_msg("scam"), NOW)) is None  # no group set
    assert bot.called("delete_message") == []


# Reactions and profiles


def test_reaction_counts_are_recorded(store):
    ops, cfg = ops_of(store), make_config()
    update = SimpleNamespace(chat=SimpleNamespace(id=CHANNEL_ID, username=None), message_id=42, reactions=[
        SimpleNamespace(type=SimpleNamespace(emoji="❤", type="emoji"), total_count=10),
        SimpleNamespace(type=SimpleNamespace(emoji=None, custom_emoji_id=None, type="paid"), total_count=2)])
    assert features.record_reaction_counts(ops, cfg, update, NOW)
    top = ops.analytics(NOW)["top_reactions"][0]
    assert top["total"] == 12 and json.loads(top["reactions_json"]) == {"❤": 10, "paid": 2}


def test_subscriber_profiles_combine_all_sources(store):
    ops = ops_of(store)
    ops.touch_profile(7, "fan7", "Seven", "promo_3", NOW - DAY)
    store.record_trial_payment("c1", 7, "trial", 49, "XTR", "p", NOW - 100, accepted=True, trial_seconds=3 * DAY)
    store.log_member_event(8, "joined_subscription", "VIP Monthly 499", NOW + 20 * DAY, NOW - 10 * DAY)
    ops.update_profile(7, "vip, loyal ,vip", "likes polls", "admin")
    people = {p["user_id"]: p for p in ops.subscribers(now=NOW)}
    assert people[7]["membership"] == "trial" and people[7]["stars_paid"] == 49 and people[7]["source"] == "promo_3"
    assert people[7]["tags"] == "loyal,vip"
    assert people[8]["membership"] == "monthly"
    assert [p["user_id"] for p in ops.subscribers("fan7", now=NOW)] == [7]
    detail = ops.subscriber(7, NOW)
    assert detail["payments"][0]["amount"] == 49 and detail["trials"]


# The worker never takes updates


def test_send_only_bot_refuses_update_calls():
    bot = SendOnlyBot("123456:TEST-TOKEN")
    for call in (bot.get_updates(), bot.delete_webhook(), bot.set_webhook("https://x")):
        with pytest.raises(ForbiddenCall):
            run(call)


def test_worker_loop_runs_and_stops(store):
    cfg = make_config(worker_interval_seconds=10)
    scheduled(store, kind="text", text="from worker")
    bot = FakeBot()

    async def go():
        stop = asyncio.Event()
        task = asyncio.create_task(run_worker(cfg, store, stop, bot=bot, clock=lambda: NOW))
        await asyncio.sleep(0.05)
        stop.set()
        return await task

    assert run(go()) == 1
    assert bot.called("send_message")[0]["text"] == "from worker"
    assert not [n for n, _ in bot.calls if n in ("get_updates", "delete_webhook", "set_webhook")]


def test_preview_mode_never_posts_to_channels(store):
    from shakhira_bot.config import Config, ConfigError

    cfg, bot = make_config(preview_chat_id=777), FakeBot()
    scheduled(store, kind="text", text="public?")
    scheduled(store, kind="paid_media", target="vip", media_url="https://x/a.jpg", star_count=5)
    run(scheduler.publish_due(bot, ops_of(store), cfg, NOW))
    assert {c["chat_id"] for _, c in bot.calls} == {777}
    base = {"BOT_TOKEN": "1:T", "VIP_CHANNEL_ID": "-1001"}
    with pytest.raises(ConfigError, match="never a channel"):
        Config.from_env({**base, "PREVIEW_CHAT_ID": "-1001234"})
    assert Config.from_env({**base, "PREVIEW_CHAT_ID": "777"}).preview_chat_id == 777


def test_preview_mode_skips_actions_and_reminders(store):
    ops = ops_of(store)
    ops.queue_action("send_dm", {"user_id": 7, "text": "hi"}, "admin")
    store.log_member_event(8, "joined_subscription", "VIP", NOW + DAY, NOW - 29 * DAY)
    bot = FakeBot()
    run(scheduler.run_cycle(bot, store, make_config(preview_chat_id=777), NOW))
    assert bot.calls == [] and ops.queued_actions()  # left for the real run
