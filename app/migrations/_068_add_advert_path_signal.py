import logging

import aiosqlite

logger = logging.getLogger(__name__)


async def migrate(conn: aiosqlite.Connection) -> None:
    """Add best_rssi and best_snr columns to contact_advert_paths.

    These track the strongest signal ever observed on each unique advert path,
    allowing historical signal quality analysis and map display.
    """
    cursor = await conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact_advert_paths'"
    )
    if not await cursor.fetchone():
        await conn.commit()
        return
    for col, col_type in [("best_rssi", "REAL"), ("best_snr", "REAL")]:
        try:
            await conn.execute(f"ALTER TABLE contact_advert_paths ADD COLUMN {col} {col_type}")
        except Exception as e:
            if "duplicate column name" in str(e).lower():
                logger.debug("contact_advert_paths.%s already exists, skipping", col)
            else:
                raise
    await conn.commit()
