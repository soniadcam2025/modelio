"""Builds the Telegram application and wires up all handlers."""

from telegram import Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    ChatJoinRequestHandler,
    ChatMemberHandler,
    CommandHandler,
    MessageHandler,
    MessageReactionHandler,
    PreCheckoutQueryHandler,
    TypeHandler,
    filters,
)

from . import features, handlers
from .alerts import AdminAlerts
from .config import Config
from .storage import Storage

ALLOWED_UPDATES = [
    Update.MESSAGE,
    Update.CALLBACK_QUERY,
    Update.PRE_CHECKOUT_QUERY,
    Update.CHAT_MEMBER,  # VIP channel joins/leaves; needs the bot to be a channel admin
    Update.CHAT_JOIN_REQUEST,  # join requests to either channel (only acted on when the feature is on)
    Update.MESSAGE_REACTION_COUNT,  # anonymous reaction totals on channel posts
]


def build_application(cfg: Config, store: Storage) -> Application:
    app = Application.builder().token(cfg.bot_token).build()
    app.bot_data["config"] = cfg
    app.bot_data["storage"] = store
    app.bot_data["alerts"] = AdminAlerts(cfg.admin_chat_ids)

    private = filters.ChatType.PRIVATE
    app.add_handler(TypeHandler(Update, features.track_profile), group=-1)
    app.add_handler(CommandHandler("admin", features.admin_command, filters=private))
    app.add_handler(ChatJoinRequestHandler(features.join_request))
    app.add_handler(MessageReactionHandler(features.reaction_count,
                                           message_reaction_types=MessageReactionHandler.MESSAGE_REACTION_COUNT_UPDATED))
    if cfg.discussion_group_id is not None:
        app.add_handler(MessageHandler(filters.Chat(cfg.discussion_group_id) & ~filters.COMMAND,
                                       features.group_message))
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

    # Also runs once ~30 s after start, which finishes any unban or payment left over from a crash.
    app.job_queue.run_repeating(handlers.expiry_job, interval=cfg.expiry_check_seconds, first=30)
    app.job_queue.run_repeating(handlers.worker_job, interval=cfg.worker_interval_seconds, first=45)
    if cfg.backup_interval_hours:
        app.job_queue.run_repeating(handlers.backup_job, interval=cfg.backup_interval_hours * 3600, first=120)
    return app
