import logging

import aiosqlite

logger = logging.getLogger(__name__)


async def migrate(conn: aiosqlite.Connection) -> None:
    """Add last_rssi and last_snr columns to contacts for quick RSSI display."""
    cursor = await conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'"
    )
    if not await cursor.fetchone():
        await conn.commit()
        return
    for col, col_type in [("last_rssi", "REAL"), ("last_snr", "REAL")]:
        try:
            await conn.execute(f"ALTER TABLE contacts ADD COLUMN {col} {col_type}")
        except Exception as e:
            if "duplicate column name" in str(e).lower():
                logger.debug("contacts.%s already exists, skipping", col)
            else:
                raise
    await conn.commit()
