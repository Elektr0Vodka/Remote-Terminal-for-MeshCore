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
from app.repository import ChannelRepository, MessageRepository, RawPacketRepository
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


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


async def _run_historical_channel_decryption(
    channel_key_bytes: bytes, channel_key_hex: str, display_name: str | None = None
) -> None:
    """Background task to decrypt historical packets with a channel key."""
    packets = await RawPacketRepository.get_all_undecrypted()
    total = len(packets)
    decrypted_count = 0

    if total == 0:
        logger.info("No undecrypted packets to process")
        return

    logger.info("Starting historical channel decryption of %d packets", total)

    for packet_id, packet_data, packet_timestamp in packets:
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

        packets = await RawPacketRepository.get_undecrypted_text_messages()
        count = len(packets)
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
async def get_recent_packets(limit: int = 500) -> list[dict]:
    """
    Return the most recent raw packets from the database in the same shape
    as the WebSocket raw_packet broadcast, so the frontend can seed the
    packet feed on mount and after reconnect without losing history.

    - limit: max packets to return (default 500, max 2000)
    - Ordered oldest-first so the frontend can append in natural order
    """
    limit = min(max(1, limit), 2000)

    async with aiosqlite.connect(db.db_path) as conn:
        conn.row_factory = aiosqlite.Row

        # Check whether signal columns exist (added in migration 47)
        async with conn.execute("PRAGMA table_info(raw_packets)") as cur:
            columns = {row[1] for row in await cur.fetchall()}
        has_signal_cols = "rssi" in columns and "snr" in columns and "payload_type" in columns

        if has_signal_cols:
            query = """
                SELECT id, timestamp, data, message_id, rssi, snr, payload_type
                FROM raw_packets
                ORDER BY id DESC
                LIMIT ?
            """
        else:
            query = """
                SELECT id, timestamp, data, message_id,
                       NULL as rssi, NULL as snr, NULL as payload_type
                FROM raw_packets
                ORDER BY id DESC
                LIMIT ?
            """

        async with conn.execute(query, (limit,)) as cursor:
            rows = await cursor.fetchall()

    # Reverse so oldest-first for natural append order on frontend
    packets = []
    for row in reversed(rows):
        raw_hex = bytes(row["data"]).hex()
        payload_type = row["payload_type"] or "Unknown"
        packets.append({
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
        })

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

            bins.append(TimeseriesBin(
                start_ts=t,
                packet_count=b["packet_count"],
                byte_count=b["byte_count"],
                avg_rssi=avg_rssi_out,
                avg_snr=avg_snr_out,
                type_counts=b["type_counts"],
            ))
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