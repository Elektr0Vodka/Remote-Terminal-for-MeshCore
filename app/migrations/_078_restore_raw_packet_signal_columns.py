import logging

import aiosqlite

logger = logging.getLogger(__name__)


async def migrate(conn: aiosqlite.Connection) -> None:
    """Restore rssi, snr, payload_type columns to raw_packets if stripped by migration 62.

    Migration 62 rebuilt raw_packets for FK support but omitted these columns
    (added by migration 47) from the dynamic column list. This re-adds them.
    """
    tables_cursor = await conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    if "raw_packets" not in {row[0] for row in await tables_cursor.fetchall()}:
        await conn.commit()
        return
    col_cursor = await conn.execute("PRAGMA table_info(raw_packets)")
    existing = {row[1] for row in await col_cursor.fetchall()}
    for column, typedef in [("rssi", "INTEGER"), ("snr", "REAL"), ("payload_type", "TEXT")]:
        if column not in existing:
            await conn.execute(f"ALTER TABLE raw_packets ADD COLUMN {column} {typedef}")
            logger.debug("Restored raw_packets.%s", column)
    await conn.commit()
