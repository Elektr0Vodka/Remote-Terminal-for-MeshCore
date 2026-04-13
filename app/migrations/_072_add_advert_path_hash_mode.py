import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    """Add hash_mode column to contact_advert_paths.

    Stores the path address width used when the advert was received:
      0 = 1-byte hop identifiers
      1 = 2-byte hop identifiers
      2 = 3-byte hop identifiers
    NULL means the row pre-dates this migration and the width is unknown.
    """
    cursor = await conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact_advert_paths'"
    )
    if not await cursor.fetchone():
        await conn.commit()
        return
    try:
        await conn.execute("ALTER TABLE contact_advert_paths ADD COLUMN hash_mode INTEGER")
    except Exception:
        pass  # Column already exists
    await conn.commit()
