import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    """Catch-up: ensure noise_floor_samples table exists (idempotent re-application of migration 59)."""
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS noise_floor_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            noise_floor_dbm INTEGER NOT NULL
        )
        """
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_noise_floor_samples_timestamp ON noise_floor_samples(timestamp)"
    )
    await conn.commit()
