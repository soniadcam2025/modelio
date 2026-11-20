"""Phase 1 posting fixes: exhaustion and low-content alerts, monitoring, and once-per-slot posting.

Nothing here touches real Telegram or Cloudinary.
"""

import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

import poster.__main__ as cli
from poster import monitor, runner
from poster.config import ConfigError, PosterConfig
from poster.runner import POSTED_TAG, Result
from poster.slots import SlotError, cron_time, expected_slots, parse_times, resolve_slot

from .poster_fakes import NOW, FakePublisher, FakeSource, asset, make_cfg, media_http

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "post-to-channel.yml"


def ts(text: str) -> float:
    return datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp()


def go(source, publisher=None, cfg=None, **kw):
    return runner.run(cfg or make_cfg(), source, publisher or FakePublisher(), media_http(), clock=lambda: NOW, **kw)


def library(n_unposted: int, n_posted: int = 0):
    return FakeSource([asset(f"tgpub/new{i}", created=f"2{i:03}") for i in range(n_unposted)]
                      + [asset(f"tgpub/old{i}", created=f"1{i:03}", tags=[POSTED_TAG]) for i in range(n_posted)])


# The schedule itself must not change


def test_workflow_schedule_is_still_5am_and_10pm_ist():
    crons = re.findall(r'cron:\s*"([^"]+)"', WORKFLOW.read_text())
    assert crons == ["30 16 * * *", "30 23 * * *"]  # 22:00 and 05:00 IST
    assert sorted(cron_time(c) for c in crons) == list(make_cfg().slot_times)  # slot guard matches the cron


def test_workflow_never_recycles_unless_variable_is_set():
    text = WORKFLOW.read_text()
    assert "POST_WHEN_EXHAUSTED: ${{ vars.POST_WHEN_EXHAUSTED }}" in text
    assert "restart" not in text.split("POST_WHEN_EXHAUSTED")[1].split("\n")[0]
    assert PosterConfig.from_env({"TELEGRAM_BOT_TOKEN": "1:T", "CLOUDINARY_CLOUD_NAME": "c",
                                  "CLOUDINARY_API_KEY": "k", "CLOUDINARY_API_SECRET": "s",
                                  "POST_WHEN_EXHAUSTED": ""}).when_exhausted == "stop"


# Slots


def test_late_github_run_still_belongs_to_its_own_slot():
    # The 10 PM IST cron (16:30 UTC) started 6h40m late, as seen in production on 19 Nov.
    assert resolve_slot("30 16 * * *", "", [], ts("2026-11-19 23:10")) == "20261119T1630Z"
    # The 5 AM IST cron (23:30 UTC) started 4h39m late, the next morning.
    assert resolve_slot("30 23 * * *", "", [], ts("2026-11-20 04:09")) == "20261119T2330Z"


def test_auto_slot_for_external_trigger():
    times = parse_times("16:30,23:30")
    assert resolve_slot("", "auto", times, ts("2026-11-20 16:30")) == "20261120T1630Z"
    assert resolve_slot("", "auto", times, ts("2026-11-20 16:25")) == "20261120T1630Z"  # a few minutes early
    assert resolve_slot("", "auto", times, ts("2026-11-20 16:00")) == "20261119T2330Z"
    assert resolve_slot("", "auto", times, ts("2026-11-21 00:01")) == "20261120T2330Z"


def test_explicit_empty_and_invalid_slots():
    assert resolve_slot("", "", [(16, 30)], NOW) is None
    assert resolve_slot("", "20261120T1630Z", [(16, 30)], NOW) == "20261120T1630Z"
    for bad in ("tomorrow", "2026-11-20"):
        with pytest.raises(SlotError):
            resolve_slot("", bad, [(16, 30)], NOW)
    with pytest.raises(SlotError):
        resolve_slot("*/5 * * * *", "", [(16, 30)], NOW)
    with pytest.raises(SlotError):
        parse_times("25:00")


def test_each_slot_is_posted_once_even_with_two_triggers():
    source, pub = library(3), FakePublisher()
    first = go(source, pub, slot="20261120T1630Z")       # on-time external trigger
    second = go(source, pub, slot="20261120T1630Z")      # GitHub's late run for the same slot
    third = go(source, pub, slot="20261120T2330Z")       # the next slot posts normally
    assert [first.status, second.status, third.status] == ["posted", "already_posted", "posted"]
    assert second.exit_code == 0 and "slot 20261120T1630Z" in second.detail
    assert len(pub.sent) == 2
    assert "tgbot_slot_20261120T1630Z" in source.tags_of("tgpub/new0")


def test_test_channel_and_unslotted_runs_ignore_slots():
    source, pub = library(2), FakePublisher()
    go(source, pub, slot="20261120T1630Z", channel="@test")
    assert not any(t.startswith("tgbot_slot_") for t in source.tags_of("tgpub/new0"))
    assert go(source, pub).status == "posted"  # manual one-off post without a slot
    assert go(source, pub, slot="20261120T1630Z").status == "posted"


def test_expected_slots_window():
    since, until = datetime(2026, 11, 19, 12, tzinfo=timezone.utc), datetime(2026, 11, 20, 17, tzinfo=timezone.utc)
    assert expected_slots([(16, 30), (23, 30)], since, until) == [
        "20261119T1630Z", "20261119T2330Z", "20261120T1630Z"]


# Low content and exhaustion


def test_low_content_warning_below_threshold_only():
    cfg = make_cfg(low_stock_threshold=5)
    result = go(library(5), cfg=cfg)
    assert result.status == "posted" and result.remaining == 4
    assert ("warning", "Low content") in [(lvl, title) for lvl, title, _ in monitor.assess(result, cfg)]
    plenty = go(library(7), cfg=cfg)
    assert plenty.remaining == 6
    assert [lvl for lvl, _, _ in monitor.assess(plenty, cfg)] == ["notice"]
    assert monitor.alert_text(plenty, cfg) is None


def test_exhausted_folder_is_an_alert_not_a_silent_success():
    cfg = make_cfg(admin_chat_id="111")
    source, pub = library(0, n_posted=3), FakePublisher()
    result = go(source, pub, cfg=cfg)
    assert result.status == "no_content" and result.exit_code == 3
    printed = []
    monitor.report_result(result, cfg, cfg.public_channel, pub, production=True, env={}, out=printed.append)
    assert printed[0].startswith("::error title=No content to post::")
    assert pub.messages and pub.messages[0][0] == "111" and "No content to post" in pub.messages[0][1]
    assert all(POSTED_TAG in source.tags_of(f"tgpub/old{i}") for i in range(3))  # nothing recycled


def test_alerts_only_for_real_public_channel_runs():
    cfg = make_cfg(admin_chat_id="111")
    bad = Result("no_content", detail="all posted", remaining=0)
    pub = FakePublisher()
    monitor.report_result(bad, cfg, "@test", pub, production=False, env={}, out=lambda _: None)
    assert pub.messages == []  # dry runs and test channels never alert
    pub = FakePublisher()
    monitor.report_result(bad, make_cfg(), "@yourshakhira", pub, production=True, env={}, out=lambda _: None)
    assert pub.messages == []  # no ADMIN_CHAT_ID configured


def test_failed_alert_delivery_does_not_change_the_result():
    cfg = make_cfg(admin_chat_id="111")
    pub = FakePublisher(message_fails=True)
    monitor.report_result(Result("failed", detail="x"), cfg, "@yourshakhira", pub, production=True, env={},
                          out=lambda _: None)  # must not raise


def test_every_failure_kind_is_flagged():
    cfg = make_cfg()
    for status in ("failed", "uncertain", "unrecorded", "nothing_to_post"):
        levels = [lvl for lvl, _, _ in monitor.assess(Result(status, asset="a", detail="d"), cfg)]
        assert levels == ["error"], status
    assert Result("nothing_to_post").exit_code == 1


def test_all_remaining_claimed_is_not_reported_as_exhausted():
    claim = f"{runner.CLAIM_PREFIX}{NOW}_beef"
    result = go(FakeSource([asset("tgpub/a", tags=[claim])]))
    assert result.status == "nothing_to_post" and result.exit_code == 1


# Monitoring output


def test_job_summary_and_annotations(tmp_path):
    summary = tmp_path / "summary.md"
    cfg = make_cfg(low_stock_threshold=5)
    result = Result("posted", asset="image:tgpub/a", message_id=39, remaining=2, slot="20261120T1630Z")
    printed = []
    monitor.report_result(result, cfg, "@yourshakhira", FakePublisher(), production=True,
                          env={"GITHUB_STEP_SUMMARY": str(summary)}, out=printed.append)
    assert printed[0].startswith("::notice title=Posted::Posted image:tgpub/a (message 39)")
    assert printed[1].startswith("::warning title=Low content::Only 2")
    text = summary.read_text()
    assert "| Telegram message | 39 |" in text and "| Unpublished assets left | 2 |" in text


def test_annotation_escapes_newlines():
    assert monitor.annotation("error", "a:b", "x\ny%") == "::error title=a%3Ab::x%0Ay%25"


def test_report_counts_and_missed_slots():
    cfg = make_cfg(low_stock_threshold=5)
    assets = [
        asset("tgpub/a", tags=[POSTED_TAG, "tgbot_slot_20261119T1630Z"]),
        asset("tgpub/b", tags=[POSTED_TAG, "tgbot_slot_20261120T1630Z"]),
        asset("tgpub/c", tags=[runner.UNCERTAIN_TAG]),
        asset("tgpub/d"),
        asset("tgpub/e", fmt="pdf"),
    ]
    inv = runner.inventory(cfg, assets)
    assert (inv.total, inv.supported, inv.posted, inv.uncertain, inv.remaining, inv.unsupported) == (5, 4, 2, 1, 1, 1)
    text = monitor.report_markdown(inv, cfg, ts("2026-11-20 17:00"))
    assert "3 expected, 2 posted, 1 missed" in text and "20261119T2330Z" in text
    assert "Low content" in text


# Config


def test_admin_chat_cannot_be_the_public_channel():
    env = {"TELEGRAM_BOT_TOKEN": "1:T", "CLOUDINARY_CLOUD_NAME": "c", "CLOUDINARY_API_KEY": "k",
           "CLOUDINARY_API_SECRET": "s"}
    with pytest.raises(ConfigError, match="ADMIN_CHAT_ID"):
        PosterConfig.from_env({**env, "ADMIN_CHAT_ID": "yourshakhira"})
    cfg = PosterConfig.from_env({**env, "ADMIN_CHAT_ID": "123456", "LOW_STOCK_THRESHOLD": "0"})
    assert cfg.admin_chat_id == "123456" and cfg.low_stock_threshold == 0
    with pytest.raises(ConfigError, match="POST_SLOTS_UTC"):
        PosterConfig.from_env({**env, "POST_SLOTS_UTC": "noon"})


# Command line, end to end with fakes


ENV = {"TELEGRAM_BOT_TOKEN": "111:TOKEN-SECRET", "CLOUDINARY_CLOUD_NAME": "demo", "CLOUDINARY_API_KEY": "KEY-SECRET",
       "CLOUDINARY_API_SECRET": "API-SECRET-VALUE", "ADMIN_CHAT_ID": "111"}


@pytest.fixture
def fakes(monkeypatch):
    source, pub = library(2), FakePublisher()
    monkeypatch.setattr(cli, "CloudinarySource", lambda *a, **k: source)
    monkeypatch.setattr(cli, "TelegramPublisher", lambda *a, **k: pub)
    monkeypatch.setattr(runner.media, "download", lambda http, a, limit: b"x" * 10)
    return source, pub


def test_cli_scheduled_runs_post_once_per_slot(fakes, capsys):
    source, pub = fakes
    env = {**ENV, "SCHEDULE_CRON": "30 16 * * *"}
    assert cli.main([], env=env) == 0
    assert cli.main([], env=env) == 0  # same slot again (e.g. external trigger + GitHub schedule)
    assert len(pub.sent) == 1
    assert "::notice title=Already posted::" in capsys.readouterr().out


def test_cli_exhausted_exits_3_and_alerts(fakes):
    source, pub = fakes
    for key in source.tags:
        source.tags[key].append(POSTED_TAG)
    assert cli.main([], env=ENV) == 3
    assert pub.sent == [] and len(pub.messages) == 1


def test_cli_dry_run_and_test_channel_send_no_alerts(fakes):
    source, pub = fakes
    for key in source.tags:
        source.tags[key].append(POSTED_TAG)
    assert cli.main(["--dry-run"], env=ENV) == 3
    assert cli.main(["--channel", "@my_test"], env=ENV) == 3
    assert pub.messages == [] and pub.sent == []


def test_cli_report_is_read_only(fakes, capsys):
    source, pub = fakes
    assert cli.main(["--report"], env=ENV) == 0
    assert "Unpublished (left to post)** | **2**" in capsys.readouterr().out
    assert source.log == [] and pub.sent == [] and pub.messages == []


def test_cli_bad_slot_is_a_config_error(fakes):
    assert cli.main(["--slot", "soon"], env=ENV) == 2
