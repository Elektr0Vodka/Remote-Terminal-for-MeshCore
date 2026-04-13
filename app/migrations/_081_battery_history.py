import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    """Create the battery_history table for persisted battery voltage samples."""
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS battery_history (
            timestamp   INTEGER NOT NULL,
            battery_mv  INTEGER NOT NULL
        )
        """
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_battery_history_timestamp ON battery_history(timestamp)"
    )
    await conn.commit()
