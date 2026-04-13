import logging

import aiosqlite

logger = logging.getLogger(__name__)


async def migrate(conn: aiosqlite.Connection) -> None:
    """Add show_warning_ticker column to app_settings (default: enabled).

    This column was previously tracked in the legacy monolith migrations as
    migration 48 (fork-local numbering).  It is re-applied here as an
    idempotent catch-up for databases that migrated via the package path.
    """
    try:
        await conn.execute(
            "ALTER TABLE app_settings ADD COLUMN show_warning_ticker INTEGER NOT NULL DEFAULT 1"
        )
        await conn.commit()
    except Exception:
        logger.debug("app_settings.show_warning_ticker already exists, skipping")
