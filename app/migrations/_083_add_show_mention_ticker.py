import logging

import aiosqlite

logger = logging.getLogger(__name__)


async def migrate(conn: aiosqlite.Connection) -> None:
    """Add show_mention_ticker column to app_settings (default: enabled)."""
    try:
        await conn.execute(
            "ALTER TABLE app_settings ADD COLUMN show_mention_ticker INTEGER NOT NULL DEFAULT 1"
        )
        await conn.commit()
    except Exception:
        logger.debug("app_settings.show_mention_ticker already exists, skipping")
