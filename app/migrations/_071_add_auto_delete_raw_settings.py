import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    """Add auto_delete_raw_enabled and auto_delete_raw_days columns to app_settings."""
    for col, default in [("auto_delete_raw_enabled", "0"), ("auto_delete_raw_days", "14")]:
        try:
            await conn.execute(
                f"ALTER TABLE app_settings ADD COLUMN {col} INTEGER DEFAULT {default}"
            )
        except Exception:
            pass  # Column already exists
    await conn.commit()
