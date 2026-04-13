import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    """Create the bot_detection_nodes table for per-node automation scoring."""
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS bot_detection_nodes (
            public_key          TEXT PRIMARY KEY,
            automation_score    REAL    DEFAULT 0.0,
            impact_score        REAL    DEFAULT 0.0,
            classification      TEXT    DEFAULT 'unknown',
            manual_tag          TEXT,
            message_count       INTEGER DEFAULT 0,
            last_seen           INTEGER,
            timing_cv           REAL,
            pattern_ratio       REAL,
            structured_ratio    REAL,
            avg_interval_seconds REAL,
            messages_per_hour   REAL    DEFAULT 0.0,
            avg_message_length  REAL    DEFAULT 0.0,
            insufficient_data   INTEGER DEFAULT 1,
            last_analyzed_at    INTEGER
        )
        """
    )
    await conn.commit()
