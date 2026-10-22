import pytest

from shakhira_bot.config import Config, ConfigError

BASE = {"BOT_TOKEN": "123456:TEST-TOKEN", "VIP_CHANNEL_ID": "-1001234567890"}


def test_defaults_match_live_bot_prices():
    cfg = Config.from_env(BASE)
    assert cfg.monthly_price == 499
    assert cfg.trial_price == 49
    assert cfg.trial_days == 3
    assert cfg.trial_once_per_user is True
    assert cfg.public_channel == "@yourshakhira"
    assert cfg.public_channel_url == "https://t.me/yourshakhira"
    assert cfg.support_url is None


@pytest.mark.parametrize("token", ["", "put_your_bot_token_here"])
def test_missing_token_is_rejected(token):
    with pytest.raises(ConfigError, match="BOT_TOKEN"):
        Config.from_env({**BASE, "BOT_TOKEN": token})


@pytest.mark.parametrize("channel", ["", "@hotshakhira", "12345", "-12345"])
def test_channel_must_be_numeric_channel_id(channel):
    with pytest.raises(ConfigError, match="VIP_CHANNEL_ID"):
        Config.from_env({**BASE, "VIP_CHANNEL_ID": channel})


def test_bad_numbers_and_bools_are_rejected():
    with pytest.raises(ConfigError, match="TRIAL_PRICE"):
        Config.from_env({**BASE, "TRIAL_PRICE": "abc"})
    with pytest.raises(ConfigError, match="VIP_MONTHLY_PRICE"):
        Config.from_env({**BASE, "VIP_MONTHLY_PRICE": "0"})
    with pytest.raises(ConfigError, match="TRIAL_ONCE_PER_USER"):
        Config.from_env({**BASE, "TRIAL_ONCE_PER_USER": "maybe"})


def test_support_username_gets_at_sign():
    cfg = Config.from_env({**BASE, "SUPPORT_USERNAME": "helpdesk"})
    assert cfg.support_username == "@helpdesk"
    assert cfg.support_url == "https://t.me/helpdesk"


def test_telegram_bot_token_name_also_accepted():
    env = {"TELEGRAM_BOT_TOKEN": "123456:OTHER", "VIP_CHANNEL_ID": "-1001234567890"}
    assert Config.from_env(env).bot_token == "123456:OTHER"


def test_token_never_in_repr():
    assert "TEST-TOKEN" not in repr(Config.from_env(BASE))
