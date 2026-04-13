import logging

import aiosqlite

logger = logging.getLogger(__name__)


async def migrate(conn: aiosqlite.Connection) -> None:
    """Catch-up: ensure observed_hash_mode column exists on contacts.

    Idempotent re-application of migration 57 for databases that branched
    before the package migration numbering was aligned.
    """
    cursor = await conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'"
    )
    if not await cursor.fetchone():
        await conn.commit()
        return
    try:
        await conn.execute("ALTER TABLE contacts ADD COLUMN observed_hash_mode INTEGER")
    except Exception as e:
        if "duplicate column name" in str(e).lower():
            logger.debug("contacts.observed_hash_mode already exists, skipping")
        else:
            raise
    await conn.commit()
    logger.debug("Catch-up 75: contacts.observed_hash_mode ensured")
