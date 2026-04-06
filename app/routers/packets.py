import logging
from hashlib import sha256
from sqlite3 import OperationalError

import aiosqlite
from fastapi import APIRouter, BackgroundTasks, HTTPException, Response, status
from pydantic import BaseModel, Field

from app.database import db
from app.decoder import parse_packet, try_decrypt_packet_with_channel_key
from app.models import RawPacketDecryptedInfo, RawPacketDetail
from app.packet_processor import create_message_from_decrypted, run_historical_dm_decryption
from app.repository import (
    AppSettingsRepository,
    ChannelRepository,
    MessageRepository,
    RawPacketRepository,
)
from app.websocket import broadcast_success

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/packets", tags=["packets"])


class DecryptRequest(BaseModel):
    key_type: str = Field(description="Type of key: 'channel' or 'contact'")
    channel_key: str | None = Field(
        default=None, description="Channel key as hex (16 bytes = 32 chars)"
    )
    channel_name: str | None = Field(
        default=None, description="Channel name (for hashtag channels, key derived from name)"
    )
    private_key: str | None = Field(
        default=None,
        description="Our private key as hex (64 bytes = 128 chars, Ed25519 seed + pubkey)",
    )
    contact_public_key: str | None = Field(
        default=None, description="Contact's public key as hex (32 bytes = 64 chars)"
    )


class DecryptResult(BaseModel):
    started: bool
    total_packets: int
    message: str


class MaintenanceRequest(BaseModel):
    prune_undecrypted_days: int | None = Field(
        default=None, ge=1, description="Delete undecrypted packets older than this many days"
    )
    purge_linked_raw_packets: bool = Field(
        default=False,
        description="Delete raw packets already linked to a stored message",
    )


class MaintenanceResult(BaseModel):
    packets_deleted: int
    vacuumed: bool


# ─── Timeseries models ────────────────────────────────────────────────────────


class TimeseriesBin(BaseModel):
    start_ts: int
    packet_count: int
    byte_count: int
    avg_rssi: float | None = None
    avg_snr: float | None = None
    type_counts: dict[str, int] = Field(default_factory=dict)


class TimeseriesResponse(BaseModel):
    bins: list[TimeseriesBin]
    total_packets: int
    total_bytes: int
    start_ts: int
    end_ts: int
    bin_seconds: int
    has_signal_data: bool
    has_type_data: bool


class HistoricalNeighbor(BaseModel):
    public_key: str
    name: str | None
    heard_count: int
    first_seen: int | None
    last_seen: int | None
    lat: float | None
    lon: float | None
    min_path_len: int | None
    best_rssi: float | None = None


class HistoricalBusiestChannel(BaseModel):
    channel_key: str
    channel_name: str | None
    message_count: int


class HistoricalStatsResponse(BaseModel):
    start_ts: int
    end_ts: int
    # Packet totals
    total_packets: int
    total_bytes: int
    packets_per_minute: float
    # Signal (None if migration 47 columns not yet present)
    avg_rssi: float | None
    avg_snr: float | None
    best_rssi: float | None
    # Type breakdown (None if migration 47 columns not yet present)
    type_counts: dict[str, int]
    has_signal_data: bool
    has_type_data: bool
    # Neighbors from contact_advert_paths (always available)
    neighbors_by_count: list[HistoricalNeighbor]
    neighbors_by_signal: list[HistoricalNeighbor]
    # Busiest channels in the window (from messages table)
    busiest_channels: list[HistoricalBusiestChannel] = Field(default_factory=list)


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


async def _run_historical_channel_decryption(
    channel_key_bytes: bytes, channel_key_hex: str, display_name: str | None = None
) -> None:
    """Background task to decrypt historical packets with a channel key."""
    total = await RawPacketRepository.get_undecrypted_count()
    decrypted_count = 0

    if total == 0:
        logger.info("No undecrypted packets to process")
        return

    logger.info("Starting historical channel decryption of %d packets", total)

    async for (
        packet_id,
        packet_data,
        packet_timestamp,
    ) in RawPacketRepository.stream_all_undecrypted():
        result = try_decrypt_packet_with_channel_key(packet_data, channel_key_bytes)

        if result is not None:
            packet_info = parse_packet(packet_data)
            path_hex = packet_info.path.hex() if packet_info else None

            msg_id = await create_message_from_decrypted(
                packet_id=packet_id,
                channel_key=channel_key_hex,
                channel_name=display_name,
                sender=result.sender,
                message_text=result.message,
                timestamp=result.timestamp,
                received_at=packet_timestamp,
                path=path_hex,
                path_len=packet_info.path_length if packet_info else None,
                realtime=False,
            )

            if msg_id is not None:
                decrypted_count += 1

    logger.info(
        "Historical channel decryption complete: %d/%d packets decrypted", decrypted_count, total
    )

    if decrypted_count > 0:
        name = display_name or channel_key_hex[:12]
        broadcast_success(
            f"Historical decrypt complete for {name}",
            f"Decrypted {decrypted_count} message{'s' if decrypted_count != 1 else ''}",
        )


@router.get("/undecrypted/count")
async def get_undecrypted_count() -> dict:
    """Get the count of undecrypted packets."""
    count = await RawPacketRepository.get_undecrypted_count()
    return {"count": count}


@router.post("/decrypt/historical", response_model=DecryptResult)
async def decrypt_historical_packets(
    request: DecryptRequest, background_tasks: BackgroundTasks, response: Response
) -> DecryptResult:
    """
    Attempt to decrypt historical packets with the provided key.
    Runs in the background. Multiple decrypt jobs can run concurrently.
    """
    if request.key_type == "channel":
        if request.channel_key:
            try:
                channel_key_bytes = bytes.fromhex(request.channel_key)
                if len(channel_key_bytes) != 16:
                    raise _bad_request("Channel key must be 16 bytes (32 hex chars)")
                channel_key_hex = request.channel_key.upper()
            except ValueError:
                raise _bad_request("Invalid hex string for channel key") from None
        elif request.channel_name:
            channel_key_bytes = sha256(request.channel_name.encode("utf-8")).digest()[:16]
            channel_key_hex = channel_key_bytes.hex().upper()
        else:
            raise _bad_request("Must provide channel_key or channel_name")

        count = await RawPacketRepository.get_undecrypted_count()
        if count == 0:
            return DecryptResult(
                started=False, total_packets=0, message="No undecrypted packets to process"
            )

        channel = await ChannelRepository.get_by_key(channel_key_hex)
        display_name = channel.name if channel else request.channel_name

        background_tasks.add_task(
            _run_historical_channel_decryption, channel_key_bytes, channel_key_hex, display_name
        )
        response.status_code = status.HTTP_202_ACCEPTED

        return DecryptResult(
            started=True,
            total_packets=count,
            message=f"Started channel decryption of {count} packets in background",
        )

    elif request.key_type == "contact":
        if not request.private_key:
            raise _bad_request("Must provide private_key for contact decryption")
        if not request.contact_public_key:
            raise _bad_request("Must provide contact_public_key for contact decryption")

        try:
            private_key_bytes = bytes.fromhex(request.private_key)
            if len(private_key_bytes) != 64:
                raise _bad_request("Private key must be 64 bytes (128 hex chars)")
        except ValueError:
            raise _bad_request("Invalid hex string for private key") from None

        try:
            contact_public_key_bytes = bytes.fromhex(request.contact_public_key)
            if len(contact_public_key_bytes) != 32:
                raise _bad_request("Contact public key must be 32 bytes (64 hex chars)")
            contact_public_key_hex = request.contact_public_key.lower()
        except ValueError:
            raise _bad_request("Invalid hex string for contact public key") from None

        count = await RawPacketRepository.count_undecrypted_text_messages()
        if count == 0:
            return DecryptResult(
                started=False,
                total_packets=0,
                message="No undecrypted TEXT_MESSAGE packets to process",
            )

        from app.repository import ContactRepository

        contact = await ContactRepository.get_by_key(contact_public_key_hex)
        display_name = contact.name if contact else None

        background_tasks.add_task(
            run_historical_dm_decryption,
            private_key_bytes,
            contact_public_key_bytes,
            contact_public_key_hex,
            display_name,
        )
        response.status_code = status.HTTP_202_ACCEPTED

        return DecryptResult(
            started=True,
            total_packets=count,
            message=f"Started DM decryption of {count} TEXT_MESSAGE packets in background",
        )

    raise _bad_request("key_type must be 'channel' or 'contact'")


@router.post("/maintenance", response_model=MaintenanceResult)
async def run_maintenance(request: MaintenanceRequest) -> MaintenanceResult:
    """
    Run packet maintenance tasks and reclaim disk space.

    - Optionally deletes undecrypted packets older than the specified number of days
    - Optionally deletes raw packets already linked to stored messages
    - Runs VACUUM to reclaim disk space
    """
    deleted = 0

    if request.prune_undecrypted_days is not None:
        logger.info(
            "Running maintenance: pruning undecrypted packets older than %d days",
            request.prune_undecrypted_days,
        )
        pruned_undecrypted = await RawPacketRepository.prune_old_undecrypted(
            request.prune_undecrypted_days
        )
        deleted += pruned_undecrypted
        logger.info("Deleted %d old undecrypted packets", pruned_undecrypted)

    if request.purge_linked_raw_packets:
        logger.info("Running maintenance: purging raw packets linked to stored messages")
        purged_linked = await RawPacketRepository.purge_linked_to_messages()
        deleted += purged_linked
        logger.info("Deleted %d linked raw packets", purged_linked)

    vacuumed = False
    try:
        async with aiosqlite.connect(db.db_path) as vacuum_conn:
            await vacuum_conn.executescript("VACUUM;")
        vacuumed = True
        logger.info("Database vacuumed")
    except OperationalError as e:
        logger.warning("VACUUM skipped (database busy): %s", e)
    except Exception as e:
        logger.error("VACUUM failed unexpectedly: %s", e)

    return MaintenanceResult(packets_deleted=deleted, vacuumed=vacuumed)


@router.get("/recent")
async def get_recent_packets(
    limit: int = 500,
    after_ts: int | None = None,
    before_ts: int | None = None,
) -> list[dict]:
    """
    Return the most recent raw packets from the database in the same shape
    as the WebSocket raw_packet broadcast, so the frontend can seed the
    packet feed on mount and after reconnect without losing history.

    - limit: max packets to return (default 500, max 5000)
    - after_ts: optional Unix timestamp (seconds); only return packets with
      timestamp >= after_ts
    - before_ts: optional Unix timestamp (seconds); only return packets with
      timestamp <= before_ts
    - Ordered oldest-first so the frontend can append in natural order
    """
    limit = min(max(1, limit), 5000)

    # Build WHERE clause from optional timestamp filters
    conditions: list[str] = []
    params: list[int] = []
    if after_ts is not None:
        conditions.append("timestamp >= ?")
        params.append(after_ts)
    if before_ts is not None:
        conditions.append("timestamp <= ?")
        params.append(before_ts)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    async with aiosqlite.connect(db.db_path) as conn:
        conn.row_factory = aiosqlite.Row

        # Check whether signal columns exist (added in migration 47)
        async with conn.execute("PRAGMA table_info(raw_packets)") as cur:
            columns = {row[1] for row in await cur.fetchall()}
        has_signal_cols = "rssi" in columns and "snr" in columns and "payload_type" in columns

        if has_signal_cols:
            query = f"""
                SELECT id, timestamp, data, message_id, rssi, snr, payload_type
                FROM raw_packets
                {where}
                ORDER BY id DESC
                LIMIT ?
            """
        else:
            query = f"""
                SELECT id, timestamp, data, message_id,
                       NULL as rssi, NULL as snr, NULL as payload_type
                FROM raw_packets
                {where}
                ORDER BY id DESC
                LIMIT ?
            """

        async with conn.execute(query, (*params, limit)) as cursor:
            rows = await cursor.fetchall()

    # Reverse so oldest-first for natural append order on frontend
    packets = []
    for row in reversed(list(rows)):
        raw_hex = bytes(row["data"]).hex()
        payload_type = row["payload_type"] or "Unknown"
        packets.append(
            {
                "id": row["id"],
                # observation_id not meaningful for historical — use id as stand-in
                "observation_id": row["id"],
                "timestamp": row["timestamp"],
                "data": raw_hex,
                "payload_type": payload_type,
                "snr": row["snr"],
                "rssi": row["rssi"],
                "decrypted": row["message_id"] is not None,
                "decrypted_info": None,
            }
        )

    return packets


@router.get("/timeseries", response_model=TimeseriesResponse)
async def get_packet_timeseries(
    start_ts: int,
    end_ts: int,
    bin_count: int = 40,
) -> TimeseriesResponse:
    """
    Return time-binned packet counts, byte totals, signal averages, and type breakdowns
    from the raw_packets table.

    Used by MyNodeView for historical chart ranges longer than the live session.

    - start_ts / end_ts: Unix timestamps (seconds)
    - bin_count: number of chart bars to return (default 40)

    Returns per-bin:
    - packet_count, byte_count (always available)
    - avg_rssi, avg_snr (available for packets captured after migration 47)
    - type_counts: dict of payload_type -> count (available after migration 47)
    """
    if end_ts <= start_ts:
        raise HTTPException(status_code=400, detail="end_ts must be greater than start_ts")
    if bin_count < 1 or bin_count > 200:
        raise HTTPException(status_code=400, detail="bin_count must be 1–200")

    duration = end_ts - start_ts
    bin_seconds = max(1, duration // bin_count)

    async with aiosqlite.connect(db.db_path) as conn:
        # Check whether signal columns exist (added in migration 47)
        async with conn.execute("PRAGMA table_info(raw_packets)") as cur:
            columns = {row[1] for row in await cur.fetchall()}
        has_signal_cols = "rssi" in columns and "snr" in columns and "payload_type" in columns

        if has_signal_cols:
            # Rich query: group by bin AND payload_type to get type breakdown + signal averages
            async with conn.execute(
                """
                SELECT
                    (:start_ts + (timestamp - :start_ts) / :bin_seconds * :bin_seconds) AS bin_start,
                    payload_type,
                    COUNT(*) AS packet_count,
                    SUM(LENGTH(data)) AS byte_count,
                    AVG(rssi) AS avg_rssi,
                    AVG(snr) AS avg_snr
                FROM raw_packets
                WHERE timestamp >= :start_ts AND timestamp < :end_ts
                GROUP BY bin_start, payload_type
                ORDER BY bin_start
                """,
                {
                    "start_ts": start_ts,
                    "end_ts": end_ts,
                    "bin_seconds": bin_seconds,
                },
            ) as cursor:
                rows = await cursor.fetchall()
        else:
            # Legacy query: no signal columns yet
            async with conn.execute(
                """
                SELECT
                    (:start_ts + (timestamp - :start_ts) / :bin_seconds * :bin_seconds) AS bin_start,
                    NULL AS payload_type,
                    COUNT(*) AS packet_count,
                    SUM(LENGTH(data)) AS byte_count,
                    NULL AS avg_rssi,
                    NULL AS avg_snr
                FROM raw_packets
                WHERE timestamp >= :start_ts AND timestamp < :end_ts
                GROUP BY bin_start
                ORDER BY bin_start
                """,
                {
                    "start_ts": start_ts,
                    "end_ts": end_ts,
                    "bin_seconds": bin_seconds,
                },
            ) as cursor:
                rows = await cursor.fetchall()

    # Aggregate rows into bins (multiple rows per bin when grouping by payload_type)
    bin_map: dict[int, dict] = {}
    for row in rows:
        t = int(row[0])
        ptype = row[1]
        count = int(row[2])
        nbytes = int(row[3]) if row[3] else 0
        avg_rssi = float(row[4]) if row[4] is not None else None
        avg_snr = float(row[5]) if row[5] is not None else None

        if t not in bin_map:
            bin_map[t] = {
                "packet_count": 0,
                "byte_count": 0,
                "rssi_sum": 0.0,
                "rssi_count": 0,
                "snr_sum": 0.0,
                "snr_count": 0,
                "type_counts": {},
            }

        b = bin_map[t]
        b["packet_count"] += count
        b["byte_count"] += nbytes

        if avg_rssi is not None:
            # avg_rssi is already averaged over `count` packets in that type-bin
            b["rssi_sum"] += avg_rssi * count
            b["rssi_count"] += count

        if avg_snr is not None:
            b["snr_sum"] += avg_snr * count
            b["snr_count"] += count

        if ptype:
            b["type_counts"][ptype] = b["type_counts"].get(ptype, 0) + count

    # Build output bins — fill all bin_count slots
    bins: list[TimeseriesBin] = []
    total_packets = 0
    total_bytes = 0
    has_signal_data = False
    has_type_data = False

    for i in range(bin_count):
        t = start_ts + i * bin_seconds
        if t in bin_map:
            b = bin_map[t]
            avg_rssi_out: float | None = None
            avg_snr_out: float | None = None
            if b["rssi_count"] > 0:
                avg_rssi_out = b["rssi_sum"] / b["rssi_count"]
                has_signal_data = True
            if b["snr_count"] > 0:
                avg_snr_out = b["snr_sum"] / b["snr_count"]
                has_signal_data = True
            if b["type_counts"]:
                has_type_data = True

            bins.append(
                TimeseriesBin(
                    start_ts=t,
                    packet_count=b["packet_count"],
                    byte_count=b["byte_count"],
                    avg_rssi=avg_rssi_out,
                    avg_snr=avg_snr_out,
                    type_counts=b["type_counts"],
                )
            )
            total_packets += b["packet_count"]
            total_bytes += b["byte_count"]
        else:
            bins.append(TimeseriesBin(start_ts=t, packet_count=0, byte_count=0))

    return TimeseriesResponse(
        bins=bins,
        total_packets=total_packets,
        total_bytes=total_bytes,
        start_ts=start_ts,
        end_ts=end_ts,
        bin_seconds=bin_seconds,
        has_signal_data=has_signal_data,
        has_type_data=has_type_data,
    )


@router.get("/historical-stats", response_model=HistoricalStatsResponse)
async def get_historical_stats(
    start_ts: int,
    end_ts: int,
) -> HistoricalStatsResponse:
    """
    Return DB-computed stats for a time window, used by the My Node page for
    historical windows where session data is incomplete or unavailable.

    Unlike /timeseries this returns aggregate stats (not bins), including:
    - Packet/byte totals and rate
    - Signal averages (rssi/snr) if migration 47 columns are present
    - Payload type breakdown if migration 47 columns are present
    - Top neighbors by heard count and by signal, from contact_advert_paths

    Neighbors are sourced from contact_advert_paths which tracks every
    advertisement heard — no 500-packet limit, full history.
    """
    if end_ts <= start_ts:
        raise HTTPException(status_code=400, detail="end_ts must be greater than start_ts")

    duration_seconds = max(end_ts - start_ts, 1)

    async with aiosqlite.connect(db.db_path) as conn:
        conn.row_factory = aiosqlite.Row

        # Check which columns exist (migration 47)
        async with conn.execute("PRAGMA table_info(raw_packets)") as cur:
            columns = {row[1] for row in await cur.fetchall()}
        has_signal_cols = "rssi" in columns and "snr" in columns and "payload_type" in columns

        # ── Packet totals ──────────────────────────────────────────────────
        async with conn.execute(
            """
            SELECT
                COUNT(*) AS total_packets,
                SUM(LENGTH(data)) AS total_bytes
            FROM raw_packets
            WHERE timestamp >= ? AND timestamp < ?
            """,
            (start_ts, end_ts),
        ) as cur:
            row = await cur.fetchone()
            total_packets = int((row["total_packets"] if row else None) or 0)
            total_bytes = int((row["total_bytes"] if row else None) or 0)

        packets_per_minute = total_packets / max(duration_seconds / 60, 1 / 60)

        # ── Signal + type stats (migration 47) ────────────────────────────
        avg_rssi: float | None = None
        avg_snr: float | None = None
        best_rssi: float | None = None
        type_counts: dict[str, int] = {}
        has_signal_data = False
        has_type_data = False

        if has_signal_cols:
            async with conn.execute(
                """
                SELECT
                    AVG(rssi) AS avg_rssi,
                    AVG(snr)  AS avg_snr,
                    MAX(rssi) AS best_rssi
                FROM raw_packets
                WHERE timestamp >= ? AND timestamp < ?
                  AND rssi IS NOT NULL
                """,
                (start_ts, end_ts),
            ) as cur:
                row = await cur.fetchone()
                if row is not None and row["avg_rssi"] is not None:
                    avg_rssi = float(row["avg_rssi"])
                    avg_snr = float(row["avg_snr"]) if row["avg_snr"] is not None else None
                    best_rssi = float(row["best_rssi"])
                    has_signal_data = True

            async with conn.execute(
                """
                SELECT payload_type, COUNT(*) AS cnt
                FROM raw_packets
                WHERE timestamp >= ? AND timestamp < ?
                  AND payload_type IS NOT NULL
                GROUP BY payload_type
                ORDER BY cnt DESC
                """,
                (start_ts, end_ts),
            ) as cur:
                rows = await cur.fetchall()
                if rows:
                    type_counts = {row["payload_type"]: int(row["cnt"]) for row in rows}
                    has_type_data = True

        # ── Neighbors from contact_advert_paths ───────────────────────────
        # Sum heard_count per contact over all time (advert paths don't have
        # timestamps beyond first_seen/last_seen). Filter by last_seen in window.
        async with conn.execute(
            """
            SELECT
                c.public_key,
                c.name,
                c.last_seen,
                c.lat,
                c.lon,
                COALESCE(SUM(cap.heard_count), 0) AS heard_count,
                MIN(cap.first_seen) AS first_seen,
                MIN(cap.path_len) AS min_path_len,
                MAX(cap.best_rssi) AS best_rssi
            FROM contacts c
            LEFT JOIN contact_advert_paths cap ON cap.public_key = c.public_key
                AND cap.last_seen >= ? AND cap.last_seen < ?
            WHERE c.last_seen >= ? AND c.last_seen < ?
            GROUP BY c.public_key
            HAVING heard_count > 0
            ORDER BY heard_count DESC
            LIMIT 50
            """,
            (start_ts, end_ts, start_ts, end_ts),
        ) as cur:
            rows = await cur.fetchall()
            neighbors_by_count = [
                HistoricalNeighbor(
                    public_key=row["public_key"],
                    name=row["name"],
                    heard_count=int(row["heard_count"]),
                    first_seen=row["first_seen"],
                    last_seen=row["last_seen"],
                    lat=row["lat"],
                    lon=row["lon"],
                    min_path_len=row["min_path_len"],
                    best_rssi=float(row["best_rssi"]) if row["best_rssi"] is not None else None,
                )
                for row in rows
            ]

        # Top by signal — contacts with best RSSI from stored advert path signal data
        neighbors_by_signal: list[HistoricalNeighbor] = []
        async with conn.execute(
            """
            SELECT
                c.public_key,
                c.name,
                c.last_seen,
                c.lat,
                c.lon,
                COALESCE(SUM(cap.heard_count), 0) AS heard_count,
                MAX(cap.best_rssi) AS best_rssi
            FROM contacts c
            JOIN contact_advert_paths cap ON cap.public_key = c.public_key
                AND cap.last_seen >= ? AND cap.last_seen < ?
                AND cap.best_rssi IS NOT NULL
            WHERE c.last_seen >= ? AND c.last_seen < ?
            GROUP BY c.public_key
            HAVING heard_count > 0
            ORDER BY best_rssi DESC
            LIMIT 20
            """,
            (start_ts, end_ts, start_ts, end_ts),
        ) as cur:
            rows = await cur.fetchall()
            neighbors_by_signal = [
                HistoricalNeighbor(
                    public_key=row["public_key"],
                    name=row["name"],
                    heard_count=int(row["heard_count"]),
                    first_seen=None,
                    last_seen=row["last_seen"],
                    lat=row["lat"],
                    lon=row["lon"],
                    min_path_len=None,
                    best_rssi=float(row["best_rssi"]) if row["best_rssi"] is not None else None,
                )
                for row in rows
            ]

        # Busiest channels in the window (from messages table)
        busiest_channels: list[HistoricalBusiestChannel] = []
        async with conn.execute(
            """
            SELECT
                m.conversation_key,
                ch.name AS channel_name,
                COUNT(*) AS message_count
            FROM messages m
            LEFT JOIN channels ch ON ch.key = m.conversation_key
            WHERE m.type = 'CHAN'
              AND m.received_at >= ? AND m.received_at < ?
            GROUP BY m.conversation_key
            ORDER BY message_count DESC
            LIMIT 10
            """,
            (start_ts, end_ts),
        ) as cur:
            rows = await cur.fetchall()
            busiest_channels = [
                HistoricalBusiestChannel(
                    channel_key=row["conversation_key"],
                    channel_name=row["channel_name"],
                    message_count=int(row["message_count"]),
                )
                for row in rows
            ]

    return HistoricalStatsResponse(
        start_ts=start_ts,
        end_ts=end_ts,
        total_packets=total_packets,
        total_bytes=total_bytes,
        packets_per_minute=round(packets_per_minute, 2),
        avg_rssi=round(avg_rssi, 1) if avg_rssi is not None else None,
        avg_snr=round(avg_snr, 1) if avg_snr is not None else None,
        best_rssi=round(best_rssi, 1) if best_rssi is not None else None,
        type_counts=type_counts,
        has_signal_data=has_signal_data,
        has_type_data=has_type_data,
        neighbors_by_count=neighbors_by_count,
        neighbors_by_signal=neighbors_by_signal,
        busiest_channels=busiest_channels,
    )


# ─── Mesh Health models ───────────────────────────────────────────────────────


class MeshHealthContact(BaseModel):
    public_key: str
    name: str | None
    advert_count: int
    first_seen: int | None
    last_seen: int | None
    lat: float | None
    lon: float | None
    min_path_len: int | None
    hash_mode: int | None = None


class MeshHealthAlert(BaseModel):
    level: str  # "HIGH" | "MEDIUM"
    public_key: str
    name: str | None
    advert_count: int
    adverts_per_hour: float


class MeshHealthResponse(BaseModel):
    start_ts: int
    end_ts: int
    window_hours: float
    total_contacts: int
    high_alert_count: int
    medium_alert_count: int
    high_advert_threshold: int
    medium_advert_threshold: int
    alerts: list[MeshHealthAlert]
    contacts: list[MeshHealthContact]


@router.get("/mesh-health", response_model=MeshHealthResponse)
async def get_mesh_health(
    start_ts: int,
    end_ts: int,
) -> MeshHealthResponse:
    """
    Return advert-frequency health data for all contacts heard in the window.

    Contacts advertising too frequently are flagged based on configurable thresholds:
    - HIGH:   > configured high_advert_threshold (default 8) adverts per window
    - MEDIUM: > configured medium_advert_threshold (default 2) adverts per window

    Uses contact_advert_paths which tracks every unique path heard per contact.
    heard_count is summed only for paths whose last_seen falls within the window.
    """
    if end_ts <= start_ts:
        raise HTTPException(status_code=400, detail="end_ts must be greater than start_ts")

    settings = await AppSettingsRepository.get()
    window_hours = (end_ts - start_ts) / 3600.0

    async with aiosqlite.connect(db.db_path) as conn:
        conn.row_factory = aiosqlite.Row

        async with conn.execute(
            """
            SELECT
                c.public_key,
                c.name,
                c.lat,
                c.lon,
                MAX(cap.last_seen) AS last_seen,
                CASE WHEN MIN(cap.first_seen) < :start_ts THEN :start_ts ELSE MIN(cap.first_seen) END AS first_seen,
                MIN(cap.path_len) AS min_path_len,
                COALESCE(SUM(
                    CASE WHEN cap.first_seen >= :start_ts
                         THEN cap.heard_count
                         ELSE 1
                    END
                ), 0) AS advert_count,
                -- hash_mode from the shortest-hop path; falls back to any non-null mode
                (
                    SELECT cap2.hash_mode
                    FROM contact_advert_paths cap2
                    WHERE cap2.public_key = c.public_key
                      AND cap2.last_seen >= :start_ts
                      AND cap2.last_seen < :end_ts
                      AND cap2.hash_mode IS NOT NULL
                    ORDER BY cap2.path_len ASC, cap2.last_seen DESC
                    LIMIT 1
                ) AS hash_mode
            FROM contacts c
            JOIN contact_advert_paths cap ON cap.public_key = c.public_key
                AND cap.last_seen >= :start_ts
                AND cap.last_seen < :end_ts
            GROUP BY c.public_key
            ORDER BY advert_count DESC
            """,
            {"start_ts": start_ts, "end_ts": end_ts},
        ) as cur:
            rows = await cur.fetchall()

    contacts: list[MeshHealthContact] = []
    alerts: list[MeshHealthAlert] = []
    high_count = 0
    medium_count = 0

    for row in rows:
        advert_count = int(row["advert_count"])
        contacts.append(
            MeshHealthContact(
                public_key=row["public_key"],
                name=row["name"],
                advert_count=advert_count,
                first_seen=row["first_seen"],
                last_seen=row["last_seen"],
                lat=row["lat"],
                lon=row["lon"],
                min_path_len=row["min_path_len"],
                hash_mode=row["hash_mode"],
            )
        )

        adverts_per_hour = advert_count / max(window_hours, 0.01)
        if advert_count > settings.high_advert_threshold:
            level = "HIGH"
            high_count += 1
        elif advert_count > settings.medium_advert_threshold:
            level = "MEDIUM"
            medium_count += 1
        else:
            continue

        alerts.append(
            MeshHealthAlert(
                level=level,
                public_key=row["public_key"],
                name=row["name"],
                advert_count=advert_count,
                adverts_per_hour=round(adverts_per_hour, 2),
            )
        )

    return MeshHealthResponse(
        start_ts=start_ts,
        end_ts=end_ts,
        window_hours=round(window_hours, 2),
        total_contacts=len(contacts),
        high_alert_count=high_count,
        medium_alert_count=medium_count,
        high_advert_threshold=settings.high_advert_threshold,
        medium_advert_threshold=settings.medium_advert_threshold,
        alerts=alerts,
        contacts=contacts,
    )


@router.get("/first-timestamp")
async def get_first_packet_timestamp() -> dict:
    """Return the Unix timestamp of the very first packet ever stored in the DB.

    Used by the Packet Feed page to show a true 'Monitoring since' time
    instead of the current process/session start time.
    Returns { first_timestamp: int | null } — null when the DB is empty.
    """
    async with aiosqlite.connect(db.db_path) as conn:
        async with conn.execute("SELECT MIN(timestamp) FROM raw_packets") as cur:
            row = await cur.fetchone()
    first_ts = row[0] if row and row[0] is not None else None
    return {"first_timestamp": first_ts}


@router.get("/advert-warnings")
async def get_advert_warnings() -> dict:
    """Return a lightweight list of active advert-health warnings (last 1 h).

    Used by the top-bar warning ticker.  Only HIGH (> 8) and MEDIUM (> 2)
    advert-count nodes are included.  The query is intentionally cheap —
    a single aggregation over contact_advert_paths with a 1-hour lookback.
    """
    async with aiosqlite.connect(db.db_path) as conn:
        conn.row_factory = aiosqlite.Row
        end_ts = int(__import__("time").time())
        start_ts = end_ts - 3600  # last 1 hour
        async with conn.execute(
            """
            SELECT
                c.public_key,
                c.name,
                c.lat,
                c.lon,
                COALESCE(SUM(
                    CASE WHEN cap.first_seen >= :start_ts
                         THEN cap.heard_count
                         ELSE 1
                    END
                ), 0) AS advert_count
            FROM contacts c
            JOIN contact_advert_paths cap ON cap.public_key = c.public_key
                AND cap.last_seen >= :start_ts
                AND cap.last_seen < :end_ts
            GROUP BY c.public_key
            HAVING advert_count > 2
            ORDER BY advert_count DESC
            LIMIT 50
            """,
            {"start_ts": start_ts, "end_ts": end_ts},
        ) as cur:
            rows = await cur.fetchall()

    warnings = []
    for row in rows:
        advert_count = int(row["advert_count"])
        level = "HIGH" if advert_count > 8 else "MEDIUM"
        warnings.append(
            {
                "public_key": row["public_key"],
                "name": row["name"],
                "level": level,
                "advert_count": advert_count,
                "lat": row["lat"],
                "lon": row["lon"],
            }
        )
    return {"warnings": warnings, "generated_at": end_ts}


@router.get("/snr-rssi-scatter")
async def get_snr_rssi_scatter(
    start_ts: int | None = None,
    end_ts: int | None = None,
    limit: int = 2000,
) -> list[dict]:
    """Return up to `limit` {rssi, snr, timestamp} points for an SNR vs RSSI scatter plot.

    Only packets that carry both rssi and snr are included.
    Results are returned newest-first so callers can slice the most recent data.
    """
    now = int(__import__("time").time())
    effective_start = start_ts if start_ts is not None else now - 7 * 86400
    effective_end = end_ts if end_ts is not None else now
    async with aiosqlite.connect(db.db_path) as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            """
            SELECT rssi, snr, timestamp
            FROM raw_packets
            WHERE rssi IS NOT NULL
              AND snr IS NOT NULL
              AND timestamp >= :start_ts
              AND timestamp <= :end_ts
            ORDER BY timestamp DESC
            LIMIT :limit
            """,
            {"start_ts": effective_start, "end_ts": effective_end, "limit": min(limit, 5000)},
        ) as cur:
            rows = await cur.fetchall()
    return [
        {"rssi": int(r["rssi"]), "snr": float(r["snr"]), "ts": int(r["timestamp"])} for r in rows
    ]


@router.get("/hourly-heatmap")
async def get_hourly_heatmap(
    start_ts: int | None = None,
    end_ts: int | None = None,
) -> dict:
    """Return a 7×24 packet-count heatmap grouped by (day_of_week, hour_of_day).

    day_of_week: 0=Sunday … 6=Saturday (SQLite strftime('%w')).
    Returns { cells: [{dow, hour, count}], max_count, total }.
    """
    now = int(__import__("time").time())
    effective_start = start_ts if start_ts is not None else now - 30 * 86400
    effective_end = end_ts if end_ts is not None else now
    async with aiosqlite.connect(db.db_path) as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            """
            SELECT
                CAST(strftime('%w', datetime(timestamp, 'unixepoch')) AS INTEGER) AS dow,
                CAST(strftime('%H', datetime(timestamp, 'unixepoch')) AS INTEGER) AS hour,
                COUNT(*) AS count
            FROM raw_packets
            WHERE timestamp >= :start_ts AND timestamp <= :end_ts
            GROUP BY dow, hour
            """,
            {"start_ts": effective_start, "end_ts": effective_end},
        ) as cur:
            rows = await cur.fetchall()
    cells = [{"dow": int(r["dow"]), "hour": int(r["hour"]), "count": int(r["count"])} for r in rows]
    max_count = max((c["count"] for c in cells), default=0)
    total = sum(c["count"] for c in cells)
    return {"cells": cells, "max_count": max_count, "total": total}


@router.get("/relay-pairs")
async def get_relay_pairs(limit: int = 20) -> list[dict]:
    """Return the most frequent consecutive node-pair co-occurrences across advert paths.

    Pairs are extracted from contact_advert_paths where path_len >= 2.
    hop_a and hop_b are hex-encoded partial public-key prefixes (length varies by hash_mode).
    """
    async with aiosqlite.connect(db.db_path) as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            """
            SELECT cap.path_hex, cap.path_len, cap.hash_mode, cap.heard_count,
                   c.name AS c_name
            FROM contact_advert_paths cap
            LEFT JOIN contacts c ON c.public_key = cap.public_key
            WHERE cap.path_len >= 2 AND cap.path_hex IS NOT NULL AND cap.hash_mode IS NOT NULL
            """,
        ) as cur:
            rows = await cur.fetchall()

    pair_counts: dict[tuple[str, str], int] = {}
    for row in rows:
        path_hex: str = row["path_hex"] or ""
        path_len: int = row["path_len"]
        hash_mode: int = row["hash_mode"]
        heard: int = row["heard_count"] or 1
        hex_per_hop = (hash_mode + 1) * 2  # bytes→hex chars
        if len(path_hex) < path_len * hex_per_hop:
            continue
        hops = [
            path_hex[i : i + hex_per_hop] for i in range(0, path_len * hex_per_hop, hex_per_hop)
        ]
        for a, b in zip(hops, hops[1:], strict=False):
            pair_counts[(a, b)] = pair_counts.get((a, b), 0) + heard

    top = sorted(pair_counts.items(), key=lambda x: x[1], reverse=True)[: min(limit, 50)]
    return [{"hop_a": a, "hop_b": b, "count": count} for (a, b), count in top]


@router.get("/reachability-rings")
async def get_reachability_rings(
    start_ts: int | None = None,
    end_ts: int | None = None,
) -> list[dict]:
    """Return unique contact counts grouped by minimum hop distance (reachability rings).

    Returns [{hops: 0|1|2|3|null, count: int, label: str}] sorted by hop distance.
    Contacts with no known path are reported as hops=null.
    """
    now = int(__import__("time").time())
    effective_start = start_ts if start_ts is not None else 0
    effective_end = end_ts if end_ts is not None else now
    async with aiosqlite.connect(db.db_path) as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            """
            SELECT
                c.public_key,
                MIN(cap.path_len) AS min_hops
            FROM contacts c
            LEFT JOIN contact_advert_paths cap
                ON cap.public_key = c.public_key
                AND (:start_ts = 0 OR cap.last_seen >= :start_ts)
                AND cap.last_seen <= :end_ts
            WHERE c.last_seen >= :start_ts AND c.last_seen <= :end_ts
            GROUP BY c.public_key
            """,
            {"start_ts": effective_start, "end_ts": effective_end},
        ) as cur:
            rows = await cur.fetchall()

    buckets: dict[int | None, int] = {}
    for row in rows:
        h = row["min_hops"]
        if h is not None:
            h = int(h)
            if h >= 3:
                h = 3
        buckets[h] = buckets.get(h, 0) + 1

    label_map = {0: "Direct (0-hop)", 1: "1 hop", 2: "2 hops", 3: "3+ hops", None: "Unknown"}
    order = [0, 1, 2, 3, None]
    return [{"hops": h, "count": buckets[h], "label": label_map[h]} for h in order if h in buckets]


# NOTE: This route MUST remain last in the file. FastAPI matches routes in
# registration order — any literal-path GET routes above (e.g. /recent,
# /timeseries, /undecrypted/count) must be registered first or they will
# be swallowed by this catch-all integer parameter.
@router.get("/{packet_id}", response_model=RawPacketDetail)
async def get_raw_packet(packet_id: int) -> RawPacketDetail:
    """Fetch one stored raw packet by row ID for on-demand inspection."""
    packet_row = await RawPacketRepository.get_by_id(packet_id)
    if packet_row is None:
        raise HTTPException(status_code=404, detail="Raw packet not found")

    stored_packet_id, packet_data, packet_timestamp, message_id = packet_row
    packet_info = parse_packet(packet_data)
    payload_type_name = packet_info.payload_type.name if packet_info else "Unknown"

    decrypted_info: RawPacketDecryptedInfo | None = None
    if message_id is not None:
        message = await MessageRepository.get_by_id(message_id)
        if message is not None:
            if message.type == "CHAN":
                channel = await ChannelRepository.get_by_key(message.conversation_key)
                decrypted_info = RawPacketDecryptedInfo(
                    channel_name=channel.name if channel else None,
                    sender=message.sender_name,
                    channel_key=message.conversation_key,
                    contact_key=message.sender_key,
                )
            else:
                decrypted_info = RawPacketDecryptedInfo(
                    sender=message.sender_name,
                    contact_key=message.conversation_key,
                )

    return RawPacketDetail(
        id=stored_packet_id,
        timestamp=packet_timestamp,
        data=packet_data.hex(),
        payload_type=payload_type_name,
        decrypted=message_id is not None,
        decrypted_info=decrypted_info,
    )
