import logging

import aiosqlite

logger = logging.getLogger(__name__)


async def migrate(conn: aiosqlite.Connection) -> None:
    """Add owner_id column to contacts for companion/owner radio identification.

    Stores the public key of the node that owns this contact (e.g. a companion
    app paired with a radio).  Used by the map to auto-resolve companion names.
    """
    cursor = await conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'"
    )
    if not await cursor.fetchone():
        await conn.commit()
        return
    try:
        await conn.execute("ALTER TABLE contacts ADD COLUMN owner_id TEXT")
    except Exception as e:
        if "duplicate column name" in str(e).lower():
            logger.debug("contacts.owner_id already exists, skipping")
        else:
            raise
    await conn.commit()
