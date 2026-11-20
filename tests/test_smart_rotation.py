"""Smart rotation requirements (owner's spec):

1. New, unpublished content always comes first.
2. When it runs out, the OLDEST eligible previously published asset is reused.
3. A configurable minimum cooldown (default 30 days) per asset.
4. Posting-history tags are never removed to restart a rotation.
5. The last successful posting time is persisted per asset (tgbot_at_<unix>).
6. Duplicate protection, history and the 5 AM / 10 PM IST slots are preserved.
7. If nothing qualifies: alert the admin and skip posting safely.
"""

import httpx
import pytest

import poster.__main__ as cli
from poster import monitor, runner
from poster.runner import AT_PREFIX, POSTED_TAG, REJECTED_TAG, UNCERTAIN_TAG

from .poster_fakes import NOW, FakePublisher, FakeSource, asset, make_cfg, media_http

DAY = 86400


def go(source, publisher=None, cfg=None, now=NOW, **kw):
    return runner.run(cfg or make_cfg(), source, publisher or FakePublisher(), media_http(), clock=lambda: now, **kw)


def posted(public_id, days_ago, created="2026-01-01", extra=()):
    return asset(public_id, created=created, tags=[POSTED_TAG, f"{AT_PREFIX}{NOW - days_ago * DAY}", *extra])


def history(source, public_id):
    return [t for t in source.tags_of(public_id) if t.startswith("tgbot_")]


# 1. New content first


def test_new_content_always_wins_over_reusable_old_posts():
    source = FakeSource([posted("tgpub/old", 90, created="2020"), asset("tgpub/new", created="2026-06-01")])
    result = go(source)
    assert result.asset == "image:tgpub/new" and not result.reused


# 2. Oldest eligible post is reused when nothing new is left


def test_reuses_the_asset_posted_longest_ago():
    source = FakeSource([
        posted("tgpub/a", 40, created="2026-03-01"),
        posted("tgpub/b", 75, created="2026-05-01"),  # posted longest ago -> first
        posted("tgpub/c", 31, created="2026-01-01"),
    ])
    pub = FakePublisher()
    first = go(source, pub)
    assert first.status == "posted" and first.reused and first.asset == "image:tgpub/b"
    assert first.exit_code == 0 and "reused" in first.detail
    second = go(source, pub, now=NOW + 60)
    assert second.asset == "image:tgpub/a"  # b was just reposted: back in its cooldown


# 3. Cooldown


def test_thirty_day_cooldown_is_enforced():
    assert go(FakeSource([posted("tgpub/a", 29)])).status == "no_content"
    assert go(FakeSource([posted("tgpub/a", 30)])).status == "posted"


def test_cooldown_is_configurable():
    cfg = make_cfg(reuse_cooldown_days=7)
    assert go(FakeSource([posted("tgpub/a", 6)]), cfg=cfg).status == "no_content"
    assert go(FakeSource([posted("tgpub/a", 7)]), cfg=cfg).reused


def test_stop_mode_never_reuses():
    result = go(FakeSource([posted("tgpub/a", 365)]), cfg=make_cfg(when_exhausted="stop"))
    assert result.status == "no_content" and result.detail == "all posted"


# 4 + 5. History kept; last posting time persisted


def test_reuse_keeps_all_history_and_updates_the_posting_time():
    old_at = f"{AT_PREFIX}{NOW - 45 * DAY}"
    source = FakeSource([asset("tgpub/a", tags=["mine", POSTED_TAG, old_at, "tgbot_run_111",
                                                "tgbot_slot_20261001T1630Z"])])
    result = go(source, cfg=make_cfg(run_id="222"), slot="20261120T1630Z")
    assert result.reused
    tags = source.tags_of("tgpub/a")
    assert {"mine", POSTED_TAG, "tgbot_run_111", "tgbot_slot_20261001T1630Z",  # nothing removed
            "tgbot_run_222", "tgbot_slot_20261120T1630Z", f"{AT_PREFIX}{NOW}"} <= set(tags)
    assert old_at not in tags  # only the superseded timestamp is replaced
    assert not any(op == "remove" and tag in (POSTED_TAG, "tgbot_run_111") for op, tag, _ in source.log)


def test_first_post_records_its_time():
    source = FakeSource([asset("tgpub/a")])
    go(source)
    assert f"{AT_PREFIX}{NOW}" in source.tags_of("tgpub/a")


def test_never_strips_posted_tags_even_with_old_restart_setting():
    source = FakeSource([posted("tgpub/a", 5), posted("tgpub/b", 10)])
    go(source, cfg=make_cfg(when_exhausted="restart"))
    assert not [entry for entry in source.log if entry[0] == "remove" and entry[1] == POSTED_TAG]


# Posts made before tgbot_at_ existed


def test_legacy_post_times_come_from_slot_or_github_run_and_are_saved():
    runs = {"39885711311": NOW - 35 * DAY, "40000000000": NOW - 33 * DAY}
    source = FakeSource([
        asset("tgpub/run_old", tags=[POSTED_TAG, "tgbot_run_39885711311"]),
        asset("tgpub/run_newer", tags=[POSTED_TAG, "tgbot_run_40000000000"]),
        asset("tgpub/slot", tags=[POSTED_TAG, "tgbot_slot_20261001T2330Z"]),  # 2026-10-01 23:30 UTC
        asset("tgpub/unknown", tags=[POSTED_TAG]),
    ])
    lookup = runs.get
    result = go(source, run_time=lookup)
    assert result.reused and result.asset == "image:tgpub/slot"  # 1 Oct is the oldest known post
    assert f"{AT_PREFIX}{NOW - 35 * DAY}" in source.tags_of("tgpub/run_old")  # backfilled and persisted
    assert f"{AT_PREFIX}{NOW - 33 * DAY}" in source.tags_of("tgpub/run_newer")
    assert not any(t.startswith(AT_PREFIX) for t in source.tags_of("tgpub/unknown"))
    # The next run uses the saved tags, no lookup needed.
    assert go(source, now=NOW + 60).asset == "image:tgpub/run_old"


def test_unknown_posting_time_is_never_reused():
    result = go(FakeSource([asset("tgpub/a", tags=[POSTED_TAG])]))
    assert result.status == "no_content" and "1 posted asset(s) have no known posting time" in result.detail


def test_dry_run_and_test_channel_write_nothing():
    source = FakeSource([asset("tgpub/a", tags=[POSTED_TAG, "tgbot_run_1"])])
    lookup = {"1": NOW - 40 * DAY}.get
    assert go(source, dry_run=True, run_time=lookup).reused
    pub = FakePublisher()
    assert go(source, pub, channel="@test", run_time=lookup).reused
    assert pub.sent[0]["channel"] == "@test"
    assert not [e for e in source.log if e[0] == "add" and not e[1].startswith("tgbot_claim_")]


# 6. Duplicate protection preserved


def test_slot_guard_and_rerun_guard_still_stop_a_second_reuse():
    source = FakeSource([posted("tgpub/a", 60), posted("tgpub/b", 50)])
    pub = FakePublisher()
    cfg = make_cfg(run_id="9")
    assert go(source, pub, cfg=cfg, slot="20261120T2330Z").reused
    assert go(source, pub, cfg=cfg, slot="20261120T2330Z").status == "already_posted"
    assert go(source, pub, cfg=make_cfg(run_id="10"), slot="20261120T2330Z").status == "already_posted"
    assert len(pub.sent) == 1


def test_uncertain_rejected_and_claimed_assets_are_never_reused():
    claim = f"{runner.CLAIM_PREFIX}{NOW}_beef"
    source = FakeSource([
        posted("tgpub/u", 90, extra=[UNCERTAIN_TAG]),
        posted("tgpub/r", 90, extra=[REJECTED_TAG]),
        posted("tgpub/c", 90, extra=[claim]),
        posted("tgpub/ok", 31),
    ])
    assert go(source).asset == "image:tgpub/ok"


def test_asset_reposted_by_another_run_meanwhile_is_skipped():
    source = FakeSource([posted("tgpub/a", 60), posted("tgpub/b", 40)])

    def reposted_elsewhere(src, a):
        if a.public_id == "tgpub/a":
            src.tags[a.key].append(f"{AT_PREFIX}{NOW - 5}")

    source.on_get_tags = reposted_elsewhere
    assert go(source).asset == "image:tgpub/b"


# 7. Nothing qualifies: alert and skip


def test_nothing_qualifies_alerts_admin_and_posts_nothing():
    cfg = make_cfg(admin_chat_id="111")
    source = FakeSource([posted("tgpub/a", 10), posted("tgpub/b", 20)])
    pub = FakePublisher()
    result = go(source, pub, cfg=cfg)
    assert result.status == "no_content" and result.exit_code == runner.EXIT_NO_CONTENT
    assert "next one qualifies" in result.detail  # tells the admin when posting can resume
    assert pub.sent == []
    monitor.report_result(result, cfg, cfg.public_channel, pub, production=True, env={}, out=lambda _: None)
    assert pub.messages and "No content to post" in pub.messages[0][1] and "cooldown" in pub.messages[0][1]


def test_reposted_runs_are_visible_and_still_warn_about_low_content():
    cfg = make_cfg()
    result = go(FakeSource([posted("tgpub/a", 60)]), cfg=cfg)
    levels = [(lvl, title) for lvl, title, _ in monitor.assess(result, cfg)]
    assert ("notice", "Reposted") in levels and ("warning", "Low content") in levels


# Reporting and the GitHub lookup


def test_inventory_shows_reuse_state():
    cfg = make_cfg()
    inv = runner.inventory(cfg, [posted("tgpub/a", 40), posted("tgpub/b", 10), asset("tgpub/c", tags=[POSTED_TAG]),
                                 asset("tgpub/new")], NOW)
    assert (inv.remaining, inv.reusable_now, inv.unknown_time) == (1, 1, 1)
    assert inv.next_reuse_at == NOW - 10 * DAY + 30 * DAY
    text = monitor.report_markdown(inv, cfg, NOW)
    assert "Reusable now (posted over 30 days ago) | 1" in text


def test_github_run_lookup_is_read_only_and_cached():
    seen = []

    def handler(request):
        seen.append((request.method, request.url.path, request.headers.get("authorization")))
        return httpx.Response(200, json={"run_started_at": "2026-10-23T01:44:37Z"})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    lookup = cli.github_run_time(http, "soniadcam2025/modelio", "ghs_TEST")
    assert lookup("39885711311") == 1792719877
    assert lookup("39885711311") == 1792719877 and len(seen) == 1
    assert seen[0] == ("GET", "/repos/soniadcam2025/modelio/actions/runs/39885711311", "Bearer ghs_TEST")
    assert lookup("not-a-number") is None
    assert cli.github_run_time(http, "", "") is None


def test_workflow_schedule_unchanged():
    import re
    from pathlib import Path

    text = (Path(__file__).resolve().parent.parent / ".github/workflows/post-to-channel.yml").read_text()
    assert re.findall(r'cron:\s*"([^"]+)"', text) == ["30 16 * * *", "30 23 * * *"]
    assert "actions: read" in text and "contents: read" in text and "write" not in text.split("permissions:")[1].split("\n\n")[0]
