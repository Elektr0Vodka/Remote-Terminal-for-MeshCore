import logging

import aiosqlite

logger = logging.getLogger(__name__)


async def _count_packets(conn: aiosqlite.Connection) -> int:
    cursor = await conn.execute("SELECT COUNT(*) FROM raw_packets")
    row = await cursor.fetchone()
    return row[0] if row else 0


async def migrate(conn: aiosqlite.Connection) -> None:
    """Retroactively attribute observed_hash_mode to relay hops in stored packets.

    For every raw packet in the database, parse the path bytes and attempt to
    resolve each hop prefix to a unique contact.  If found, advance that
    contact's observed_hash_mode to match the path's byte-width.
    """
    from app.decoder import parse_packet as _parse_packet

    tbl_cursor = await conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    existing = {row[0] for row in await tbl_cursor.fetchall()}
    if "contacts" not in existing or "raw_packets" not in existing:
        await conn.commit()
        return

    cursor = await conn.execute("SELECT public_key, observed_hash_mode FROM contacts")
    contact_rows = await cursor.fetchall()

    prefix_index: dict[str, list[str]] = {}
    stored_modes: dict[str, int | None] = {}

    for row in contact_rows:
        pk: str = row[0]
        stored_modes[pk] = row[1]
        for prefix_len in (2, 4, 6):
            pfx = pk[:prefix_len]
            if pfx not in prefix_index:
                prefix_index[pfx] = []
            prefix_index[pfx].append(pk)

    updates: dict[str, int] = {}

    cursor = await conn.execute("SELECT data FROM raw_packets")
    async for row in cursor:
        raw = row[0]
        if not raw:
            continue
        try:
            pkt = _parse_packet(bytes(raw))
        except Exception:
            continue
        if pkt is None or not pkt.path or pkt.path_length <= 0:
            continue

        hop_size = pkt.path_hash_size
        hash_mode = hop_size - 1
        path = pkt.path
        prefix_hex_len = hop_size * 2

        for offset in range(0, len(path), hop_size):
            hop_bytes = path[offset : offset + hop_size]
            if len(hop_bytes) < hop_size:
                break
            prefix_hex = hop_bytes.hex().lower()
            if len(prefix_hex) != prefix_hex_len:
                continue
            matches = prefix_index.get(prefix_hex, [])
            if len(matches) != 1:
                continue
            pk = matches[0]
            current_best = updates.get(pk, stored_modes.get(pk))
            if current_best is None or hash_mode > current_best:
                updates[pk] = hash_mode

    for pk, hash_mode in updates.items():
        await conn.execute(
            """
            UPDATE contacts
            SET observed_hash_mode = CASE
                WHEN observed_hash_mode IS NULL OR ? > observed_hash_mode THEN ?
                ELSE observed_hash_mode
            END
            WHERE public_key = ?
            """,
            (hash_mode, hash_mode, pk),
        )
    await conn.commit()
    logger.info(
        "Migration 60: updated observed_hash_mode for %d contact(s) from %d stored packet(s)",
        len(updates),
        await _count_packets(conn),
    )
