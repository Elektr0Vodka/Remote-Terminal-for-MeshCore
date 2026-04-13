import logging

import aiosqlite

logger = logging.getLogger(__name__)


async def migrate(conn: aiosqlite.Connection) -> None:
    """Add observed_hash_mode column to contacts.

    Tracks the highest path address width inferred from actual received packets
    (DMs, PATH packets) as opposed to advert_hash_mode which is declaration-based.
      0 = 1-byte hop identifiers observed
      1 = 2-byte hop identifiers observed
      2 = 3-byte hop identifiers observed
    NULL means no packet evidence yet collected.
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
    logger.debug("Added contacts.observed_hash_mode")
