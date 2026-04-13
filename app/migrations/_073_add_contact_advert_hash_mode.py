import logging

import aiosqlite

logger = logging.getLogger(__name__)


async def migrate(conn: aiosqlite.Connection) -> None:
    """Add contacts.advert_hash_mode and backfill from most recent advert path observation.

    This column stores the path address width (0=1B, 1=2B, 2=3B) as observed in
    the node's most recent advertisement, independently of direct_path_hash_mode
    which is only set when path discovery completes.
    """
    tbl_cursor = await conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'"
    )
    if not await tbl_cursor.fetchone():
        await conn.commit()
        return
    try:
        await conn.execute("ALTER TABLE contacts ADD COLUMN advert_hash_mode INTEGER")
    except Exception as e:
        if "duplicate column name" in str(e).lower():
            logger.debug("contacts.advert_hash_mode already exists, skipping add")
        else:
            raise
    # Backfill from most recent advert path with a known hash_mode.
    cursor = await conn.execute("PRAGMA table_info(contact_advert_paths)")
    cap_columns = {row[1] for row in await cursor.fetchall()}
    if "hash_mode" in cap_columns:
        await conn.execute(
            """
            UPDATE contacts
            SET advert_hash_mode = (
                SELECT hash_mode
                FROM contact_advert_paths
                WHERE public_key = contacts.public_key
                  AND hash_mode IS NOT NULL
                ORDER BY last_seen DESC
                LIMIT 1
            )
            WHERE EXISTS (
                SELECT 1 FROM contact_advert_paths
                WHERE public_key = contacts.public_key
                  AND hash_mode IS NOT NULL
            )
            """
        )
        logger.debug("Backfilled contacts.advert_hash_mode from contact_advert_paths")
    else:
        logger.debug(
            "Skipping advert_hash_mode backfill: contact_advert_paths.hash_mode not present"
        )
    await conn.commit()
    logger.debug("Added contacts.advert_hash_mode and backfilled from contact_advert_paths")
