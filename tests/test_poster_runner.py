"""Posting run behaviour: selection, history, failures, empty folders and concurrent runs."""

from poster import runner
from poster.runner import CLAIM_PREFIX, POSTED_TAG, UNCERTAIN_TAG

from .poster_fakes import NOW, FakePublisher, FakeSource, asset, make_cfg, media_http


def go(source, publisher=None, cfg=None, **kw):
    return runner.run(cfg or make_cfg(), source, publisher or FakePublisher(), media_http(), clock=lambda: NOW, **kw)


# Selection


def test_posts_oldest_unposted_asset_and_records_it():
    source = FakeSource([
        asset("tgpub/new", created="2026-03-01"),
        asset("tgpub/old", created="2026-01-01"),
        asset("tgpub/done", created="2025-01-01", tags=[POSTED_TAG]),
    ])
    pub = FakePublisher()
    result = go(source, pub)
    assert result.status == "posted" and result.asset == "image:tgpub/old"
    assert pub.sent[0]["kind"] == "photo" and pub.sent[0]["name"] == "old.jpg"
    assert POSTED_TAG in source.tags_of("tgpub/old")
    assert not [t for t in source.tags_of("tgpub/old") if t.startswith(CLAIM_PREFIX)]  # claim released


def test_second_run_posts_the_next_asset_not_the_same_one():
    source = FakeSource([asset("tgpub/a", created="1"), asset("tgpub/b", created="2")])
    assert go(source).asset == "image:tgpub/a"
    assert go(source).asset == "image:tgpub/b"
    result = go(source)
    assert result.status == "nothing_to_post" and result.detail == "all posted"


def test_video_is_sent_as_video_and_gif_as_animation():
    source = FakeSource([asset("tgpub/clip", resource_type="video", fmt="mp4", created="1"),
                         asset("tgpub/loop", fmt="gif", created="2")])
    pub = FakePublisher()
    go(source, pub)
    go(source, pub)
    assert [s["kind"] for s in pub.sent] == ["video", "animation"]


def test_user_tags_are_preserved():
    source = FakeSource([asset("tgpub/a", tags=["favourite", "summer"])])
    go(source)
    assert source.tags_of("tgpub/a") == ["favourite", "summer", POSTED_TAG]


def test_caption_from_cloudinary_context_wins_over_default():
    pub = FakePublisher()
    go(FakeSource([asset("tgpub/a", caption="Asset caption")]), pub, cfg=make_cfg(caption="Default"))
    go(FakeSource([asset("tgpub/b")]), pub, cfg=make_cfg(caption="Default"))
    assert [s["caption"] for s in pub.sent] == ["Asset caption", "Default"]


def test_random_selection_only_picks_eligible():
    source = FakeSource([asset(f"tgpub/{i}", tags=[POSTED_TAG] if i else []) for i in range(5)])
    import random

    result = runner.run(make_cfg(selection="random"), source, FakePublisher(), media_http(),
                        clock=lambda: NOW, rng=random.Random(1))
    assert result.asset == "image:tgpub/0"


# Duplicate prevention across retries


def test_rerun_of_same_workflow_run_does_not_post_again():
    cfg = make_cfg(run_id="987654")
    source = FakeSource([asset("tgpub/a", created="1"), asset("tgpub/b", created="2")])
    pub = FakePublisher()
    assert go(source, pub, cfg=cfg).status == "posted"
    second = go(source, pub, cfg=cfg)
    assert second.status == "already_posted" and second.exit_code == 0
    assert len(pub.sent) == 1
    assert "tgbot_run_987654" in source.tags_of("tgpub/a")


def test_rotation_restart_only_when_configured():
    source = FakeSource([asset("tgpub/a", tags=[POSTED_TAG])])
    assert go(source).status == "nothing_to_post"
    result = go(source, cfg=make_cfg(when_exhausted="restart"))
    assert result.status == "posted"
    assert source.tags_of("tgpub/a") == [POSTED_TAG]


# Failures


def test_failed_upload_is_not_marked_posted():
    source = FakeSource([asset("tgpub/a")])
    result = go(source, FakePublisher(outcome="failed"))
    assert result.status == "failed" and result.exit_code == 1
    assert source.tags_of("tgpub/a") == []  # not posted, claim released
    assert go(source).status == "posted"  # still eligible next time


def test_file_refused_by_telegram_is_quarantined_so_queue_moves_on():
    source = FakeSource([asset("tgpub/bad", created="1"), asset("tgpub/good", created="2")])
    result = go(source, FakePublisher(outcome="rejected"))
    assert result.status == "failed"
    assert source.tags_of("tgpub/bad") == [runner.REJECTED_TAG]  # not marked posted
    assert go(source).asset == "image:tgpub/good"


def test_uncertain_upload_is_quarantined_not_marked_posted():
    source = FakeSource([asset("tgpub/a"), asset("tgpub/b", created="9")])
    result = go(source, FakePublisher(outcome="uncertain"))
    assert result.status == "uncertain" and result.exit_code == 1
    assert source.tags_of("tgpub/a") == [UNCERTAIN_TAG]
    assert go(source).asset == "image:tgpub/b"  # never retried automatically


def test_post_succeeded_but_recording_failed_is_reported():
    source = FakeSource([asset("tgpub/a")], fail={"record"})
    result = go(source)
    assert result.status == "unrecorded" and result.exit_code == 1
    claims = [t for t in source.tags_of("tgpub/a") if t.startswith(CLAIM_PREFIX)]
    assert claims  # claim kept so the asset is not re-posted straight away


def test_channel_permission_problem_stops_before_touching_cloudinary():
    source = FakeSource([asset("tgpub/a")], fail={"list_assets"})
    result = go(source, FakePublisher(problems=["not an admin"]))
    assert result.status == "failed" and "not an admin" in result.detail
    assert source.log == []


def test_cloudinary_error_fails_cleanly():
    result = go(FakeSource([], fail={"list_assets"}))
    assert result.status == "failed" and result.exit_code == 1


def test_download_failure_skips_to_next_asset():
    source = FakeSource([asset("tgpub/a", created="1"), asset("tgpub/b", created="2")])
    calls = []

    import httpx

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(404 if len(calls) == 1 else 200, content=b"data")

    result = runner.run(make_cfg(), source, FakePublisher(), httpx.Client(transport=httpx.MockTransport(handler)),
                        clock=lambda: NOW)
    assert result.asset == "image:tgpub/b"
    assert source.tags_of("tgpub/a") == []


# Empty and unsupported


def test_empty_folder():
    result = go(FakeSource([]))
    assert result.status == "nothing_to_post" and result.detail == "folder empty" and result.exit_code == 0


def test_only_unsupported_or_oversized_media():
    source = FakeSource([
        asset("tgpub/doc", fmt="pdf"),
        asset("tgpub/mov", resource_type="video", fmt="mov"),
        asset("tgpub/huge", size=11 * 1024 * 1024),
        asset("tgpub/zero", size=0),
    ])
    pub = FakePublisher()
    result = go(source, pub)
    assert result.status == "nothing_to_post" and result.detail == "no supported media"
    assert pub.sent == []


def test_dry_run_changes_nothing():
    source = FakeSource([asset("tgpub/a")])
    pub = FakePublisher()
    result = go(source, pub, dry_run=True)
    assert result.status == "dry_run" and result.asset == "image:tgpub/a"
    assert pub.sent == [] and source.log == []


def test_test_channel_posts_are_not_recorded():
    cfg = make_cfg(run_id="5")
    source = FakeSource([asset("tgpub/a")])
    pub = FakePublisher()
    result = go(source, pub, cfg=cfg, channel="@my_test_channel")
    assert result.status == "posted" and pub.sent[0]["channel"] == "@my_test_channel"
    assert source.tags_of("tgpub/a") == []


# Concurrent runs


def test_asset_claimed_by_another_run_is_skipped():
    other_claim = f"{CLAIM_PREFIX}{NOW - 60}_aaaa"
    source = FakeSource([asset("tgpub/a", created="1", tags=[other_claim]), asset("tgpub/b", created="2")])
    assert go(source).asset == "image:tgpub/b"
    assert source.tags_of("tgpub/a") == [other_claim]


def test_expired_claim_from_crashed_run_is_ignored():
    stale = f"{CLAIM_PREFIX}{NOW - 31 * 60}_dead"
    source = FakeSource([asset("tgpub/a", tags=[stale])])
    assert go(source).asset == "image:tgpub/a"


def test_race_lost_to_another_run_yields_the_asset():
    source = FakeSource([asset("tgpub/a", created="1"), asset("tgpub/b", created="2")])
    rival = f"{CLAIM_PREFIX}{NOW}_beef"

    def rival_claims_first_asset(src, a):
        if a.public_id == "tgpub/a" and rival not in src.tags[a.key]:
            src.tags[a.key].append(rival)

    source.on_get_tags = rival_claims_first_asset
    pub = FakePublisher()
    result = go(source, pub)
    assert result.asset == "image:tgpub/b"
    assert len(pub.sent) == 1
    assert source.tags_of("tgpub/a") == [rival]  # our claim removed, rival's left alone


def test_asset_posted_by_another_run_meanwhile_is_skipped():
    source = FakeSource([asset("tgpub/a", created="1"), asset("tgpub/b", created="2")])

    def posted_elsewhere(src, a):
        if a.public_id == "tgpub/a" and POSTED_TAG not in src.tags[a.key]:
            src.tags[a.key].append(POSTED_TAG)

    source.on_get_tags = posted_elsewhere
    assert go(source).asset == "image:tgpub/b"
