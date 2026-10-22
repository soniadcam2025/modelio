"""Builds the Telegram application and wires up all handlers."""

from telegram import Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    ChatMemberHandler,
    CommandHandler,
    MessageHandler,
    PreCheckoutQueryHandler,
    filters,
)

from . import handlers
from .config import Config
from .storage import Storage

ALLOWED_UPDATES = [
    Update.MESSAGE,
    Update.CALLBACK_QUERY,
    Update.PRE_CHECKOUT_QUERY,
    Update.CHAT_MEMBER,  # VIP channel joins/leaves; needs the bot to be a channel admin
]


def build_application(cfg: Config, store: Storage) -> Application:
    app = Application.builder().token(cfg.bot_token).build()
    app.bot_data["config"] = cfg
    app.bot_data["storage"] = store

    private = filters.ChatType.PRIVATE
    app.add_handler(CommandHandler("start", handlers.start, filters=private))
    app.add_handler(CommandHandler("subscribe", handlers.subscribe, filters=private))
    app.add_handler(CommandHandler("status", handlers.status, filters=private))
    app.add_handler(CommandHandler("rules", handlers.rules, filters=private))
    app.add_handler(CommandHandler("paysupport", handlers.paysupport, filters=private))
    app.add_handler(CallbackQueryHandler(handlers.menu_button))
    app.add_handler(PreCheckoutQueryHandler(handlers.pre_checkout))
    app.add_handler(MessageHandler(filters.SUCCESSFUL_PAYMENT, handlers.successful_payment))
    app.add_handler(ChatMemberHandler(handlers.channel_member_update, ChatMemberHandler.CHAT_MEMBER))
    app.add_error_handler(handlers.on_error)

    app.job_queue.run_repeating(handlers.expiry_job, interval=cfg.expiry_check_seconds, first=30)
    return app
