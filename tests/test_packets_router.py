"""Tests for the packets router.

Covers the historical channel decryption endpoint, background task,
undecrypted count endpoint, maintenance endpoint, timeseries endpoint,
historical-stats endpoint, mesh-health endpoint, and recent endpoint.
"""

import time
from unittest.mock import patch

import pytest

from app.database import Database
from app.models import ContactUpsert
from app.repository import (
    ChannelRepository,
    ContactAdvertPathRepository,
    ContactRepository,
    MessageRepository,
    RawPacketRepository,
)

# ── File-backed DB fixture ─────────────────────────────────────────────────────
# The timeseries / historical-stats / mesh-health endpoints open fresh
# aiosqlite connections via db.db_path.  An in-memory ":memory:" path creates
# a new, empty database on each open, so those tests need a real temp file.


@pytest.fixture
async def file_db(tmp_path):
    """File-backed test database whose path can be opened by additional connections."""
    import app.routers.packets as packets_module
    from app.repository import channels, contacts, messages, raw_packets, settings
    from app.repository import fanout as fanout_repo

    db_path = str(tmp_path / "test_packets.db")
    db = Database(db_path)
    await db.connect()

    submodules = [contacts, channels, messages, raw_packets, settings, fanout_repo]
    originals = [(mod, mod.db) for mod in submodules]
    original_packets_db = packets_module.db

    for mod in submodules:
        mod.db = db
    packets_module.db = db

    try:
        yield db
    finally:
        for mod, original in originals:
            mod.db = original
        packets_module.db = original_packets_db
        await db.disconnect()


async def _insert_raw_packets(count: int, decrypted: bool = False, age_days: int = 0) -> list[int]:
    """Insert raw packets and return their IDs."""
    ids = []
    base_ts = int(time.time()) - (age_days * 86400)
    for i in range(count):
        packet_id, _ = await RawPacketRepository.create(
            f"packet_data_{i}_{age_days}_{decrypted}".encode(), base_ts + i
        )
        if decrypted:
            # Create a message and link it
            msg_id = await MessageRepository.create(
                msg_type="CHAN",
                text=f"decrypted msg {i}",
                conversation_key="DEADBEEF" * 4,
                sender_timestamp=base_ts + i,
                received_at=base_ts + i,
            )
            if msg_id is not None:
                await RawPacketRepository.mark_decrypted(packet_id, msg_id)
        ids.append(packet_id)
    return ids


class TestUndecryptedCount:
    """Test GET /api/packets/undecrypted/count."""

    @pytest.mark.asyncio
    async def test_returns_zero_when_empty(self, test_db, client):
        response = await client.get("/api/packets/undecrypted/count")

        assert response.status_code == 200
        assert response.json()["count"] == 0

    @pytest.mark.asyncio
    async def test_counts_only_undecrypted(self, test_db, client):
        await _insert_raw_packets(3, decrypted=False)
        await _insert_raw_packets(2, decrypted=True)

        response = await client.get("/api/packets/undecrypted/count")

        assert response.status_code == 200
        assert response.json()["count"] == 3


class TestGetRawPacket:
    """Test GET /api/packets/{id}."""

    @pytest.mark.asyncio
    async def test_returns_404_when_missing(self, test_db, client):
        response = await client.get("/api/packets/999999")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_returns_linked_packet_details(self, test_db, client):
        channel_key = "DEADBEEF" * 4
        await ChannelRepository.upsert(key=channel_key, name="#ops", is_hashtag=False)
        packet_id, _ = await RawPacketRepository.create(b"\x09\x00test-packet", 1700000000)
        msg_id = await MessageRepository.create(
            msg_type="CHAN",
            text="Alice: hello",
            conversation_key=channel_key,
            sender_timestamp=1700000000,
            received_at=1700000000,
            sender_name="Alice",
        )
        assert msg_id is not None
        await RawPacketRepository.mark_decrypted(packet_id, msg_id)

        response = await client.get(f"/api/packets/{packet_id}")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == packet_id
        assert data["timestamp"] == 1700000000
        assert data["data"] == "0900746573742d7061636b6574"
        assert data["decrypted"] is True
        assert data["decrypted_info"] == {
            "channel_name": "#ops",
            "sender": "Alice",
            "channel_key": channel_key,
            "contact_key": None,
        }


class TestDecryptHistoricalPackets:
    """Test POST /api/packets/decrypt/historical."""

    @pytest.mark.asyncio
    async def test_channel_decrypt_with_hex_key(self, test_db, client):
        """Channel decryption with a valid hex key starts background task."""
        await _insert_raw_packets(5)

        response = await client.post(
            "/api/packets/decrypt/historical",
            json={
                "key_type": "channel",
                "channel_key": "0123456789abcdef0123456789abcdef",
            },
        )

        assert response.status_code == 202
        data = response.json()
        assert data["started"] is True
        assert data["total_packets"] == 5
        assert "background" in data["message"].lower()

    @pytest.mark.asyncio
    async def test_channel_decrypt_with_hashtag_name(self, test_db, client):
        """Channel decryption with a channel name derives key from hash."""
        await _insert_raw_packets(3)

        response = await client.post(
            "/api/packets/decrypt/historical",
            json={
                "key_type": "channel",
                "channel_name": "#general",
            },
        )

        assert response.status_code == 202
        data = response.json()
        assert data["started"] is True
        assert data["total_packets"] == 3

    @pytest.mark.asyncio
    async def test_channel_decrypt_invalid_hex(self, test_db, client):
        """Invalid hex string for channel key returns error."""
        response = await client.post(
            "/api/packets/decrypt/historical",
            json={
                "key_type": "channel",
                "channel_key": "not_valid_hex",
            },
        )

        assert response.status_code == 400
        data = response.json()
        assert "invalid" in data["detail"].lower()

    @pytest.mark.asyncio
    async def test_channel_decrypt_wrong_key_length(self, test_db, client):
        """Channel key with wrong length returns error."""
        response = await client.post(
            "/api/packets/decrypt/historical",
            json={
                "key_type": "channel",
                "channel_key": "aabbccdd",  # Only 4 bytes, need 16
            },
        )

        assert response.status_code == 400
        data = response.json()
        assert "16 bytes" in data["detail"]

    @pytest.mark.asyncio
    async def test_channel_decrypt_no_key_or_name(self, test_db, client):
        """Channel decryption without key or name returns error."""
        response = await client.post(
            "/api/packets/decrypt/historical",
            json={"key_type": "channel"},
        )

        assert response.status_code == 400
        data = response.json()
        assert "must provide" in data["detail"].lower()

    @pytest.mark.asyncio
    async def test_channel_decrypt_no_undecrypted_packets(self, test_db, client):
        """Channel decryption with no undecrypted packets returns not started."""
        response = await client.post(
            "/api/packets/decrypt/historical",
            json={
                "key_type": "channel",
                "channel_key": "0123456789abcdef0123456789abcdef",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["started"] is False
        assert data["total_packets"] == 0

    @pytest.mark.asyncio
    async def test_channel_decrypt_resolves_channel_name(self, test_db, client):
        """Channel decryption finds display name from DB when channel exists."""
        key_hex = "0123456789ABCDEF0123456789ABCDEF"
        await ChannelRepository.upsert(key=key_hex, name="#test-channel", is_hashtag=True)
        await _insert_raw_packets(1)

        response = await client.post(
            "/api/packets/decrypt/historical",
            json={
                "key_type": "channel",
                "channel_key": key_hex.lower(),
            },
        )

        assert response.status_code == 202
        assert response.json()["started"] is True

    @pytest.mark.asyncio
    async def test_contact_decrypt_missing_private_key(self, test_db, client):
        """Contact decryption without private key returns error."""
        response = await client.post(
            "/api/packets/decrypt/historical",
            json={
                "key_type": "contact",
                "contact_public_key": "aa" * 32,
            },
        )

        assert response.status_code == 400
        data = response.json()
        assert "private_key" in data["detail"].lower()

    @pytest.mark.asyncio
    async def test_contact_decrypt_missing_contact_key(self, test_db, client):
        """Contact decryption without contact public key returns error."""
        response = await client.post(
            "/api/packets/decrypt/historical",
            json={
                "key_type": "contact",
                "private_key": "aa" * 64,
            },
        )

        assert response.status_code == 400
        data = response.json()
        assert "contact_public_key" in data["detail"].lower()

    @pytest.mark.asyncio
    async def test_contact_decrypt_wrong_private_key_length(self, test_db, client):
        """Private key with wrong length returns error."""
        response = await client.post(
            "/api/packets/decrypt/historical",
            json={
                "key_type": "contact",
                "private_key": "aa" * 32,  # 32 bytes, need 64
                "contact_public_key": "bb" * 32,
            },
        )

        assert response.status_code == 400
        data = response.json()
        assert "64 bytes" in data["detail"]

    @pytest.mark.asyncio
    async def test_contact_decrypt_wrong_public_key_length(self, test_db, client):
        """Contact public key with wrong length returns error."""
        response = await client.post(
            "/api/packets/decrypt/historical",
            json={
                "key_type": "contact",
                "private_key": "aa" * 64,
                "contact_public_key": "bb" * 16,  # 16 bytes, need 32
            },
        )

        assert response.status_code == 400
        data = response.json()
        assert "32 bytes" in data["detail"]

    @pytest.mark.asyncio
    async def test_contact_decrypt_invalid_hex(self, test_db, client):
        """Invalid hex for private key returns error."""
        response = await client.post(
            "/api/packets/decrypt/historical",
            json={
                "key_type": "contact",
                "private_key": "zz" * 64,
                "contact_public_key": "bb" * 32,
            },
        )

        assert response.status_code == 400
        data = response.json()
        assert "invalid" in data["detail"].lower()

    @pytest.mark.asyncio
    async def test_invalid_key_type(self, test_db, client):
        """Invalid key_type returns error."""
        response = await client.post(
            "/api/packets/decrypt/historical",
            json={"key_type": "invalid"},
        )

        assert response.status_code == 400
        data = response.json()
        assert "key_type" in data["detail"].lower()


class TestRunHistoricalChannelDecryption:
    """Test the _run_historical_channel_decryption background task."""

    @pytest.mark.asyncio
    async def test_decrypts_matching_packets(self, test_db):
        """Background task decrypts packets that match the channel key."""
        from app.routers.packets import _run_historical_channel_decryption

        # Insert undecrypted packets
        await _insert_raw_packets(3)
        channel_key_hex = "AABBCCDDAABBCCDDAABBCCDDAABBCCDD"
        channel_key_bytes = bytes.fromhex(channel_key_hex)

        # Each packet must have unique content to avoid message deduplication
        call_count = 0

        def make_unique_result(*_args, **_kwargs):
            nonlocal call_count
            call_count += 1
            return type(
                "DecryptResult",
                (),
                {
                    "sender": f"User{call_count}",
                    "message": f"Hello {call_count}",
                    "timestamp": 1700000000 + call_count,
                },
            )()

        with (
            patch(
                "app.routers.packets.try_decrypt_packet_with_channel_key",
                side_effect=make_unique_result,
            ),
            patch(
                "app.routers.packets.parse_packet",
                return_value=None,
            ),
            patch("app.routers.packets.broadcast_success") as mock_success,
        ):
            await _run_historical_channel_decryption(channel_key_bytes, channel_key_hex, "#test")

        mock_success.assert_called_once()
        assert "3" in mock_success.call_args[0][1]  # "Decrypted 3 messages"

    @pytest.mark.asyncio
    async def test_skips_non_matching_packets(self, test_db):
        """Background task skips packets that don't match the channel key."""
        from app.routers.packets import _run_historical_channel_decryption

        await _insert_raw_packets(2)
        channel_key_hex = "AABBCCDDAABBCCDDAABBCCDDAABBCCDD"
        channel_key_bytes = bytes.fromhex(channel_key_hex)

        with (
            patch(
                "app.routers.packets.try_decrypt_packet_with_channel_key",
                return_value=None,  # No match
            ),
            patch("app.routers.packets.broadcast_success") as mock_success,
        ):
            await _run_historical_channel_decryption(channel_key_bytes, channel_key_hex, "#test")

        # No success broadcast when nothing was decrypted
        mock_success.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_packets_returns_early(self, test_db):
        """Background task returns early when no undecrypted packets exist."""
        from app.routers.packets import _run_historical_channel_decryption

        channel_key_hex = "AABBCCDDAABBCCDDAABBCCDDAABBCCDD"
        channel_key_bytes = bytes.fromhex(channel_key_hex)

        with patch("app.routers.packets.broadcast_success") as mock_success:
            await _run_historical_channel_decryption(channel_key_bytes, channel_key_hex)

        mock_success.assert_not_called()

    @pytest.mark.asyncio
    async def test_display_name_fallback(self, test_db):
        """Uses channel key prefix when no display name is provided."""
        from app.routers.packets import _run_historical_channel_decryption

        await _insert_raw_packets(1)
        channel_key_hex = "AABBCCDDAABBCCDDAABBCCDDAABBCCDD"
        channel_key_bytes = bytes.fromhex(channel_key_hex)

        mock_result = type(
            "DecryptResult",
            (),
            {
                "sender": "User",
                "message": "msg",
                "timestamp": 1700000000,
            },
        )()

        with (
            patch(
                "app.routers.packets.try_decrypt_packet_with_channel_key",
                return_value=mock_result,
            ),
            patch("app.routers.packets.parse_packet", return_value=None),
            patch("app.routers.packets.broadcast_success") as mock_success,
        ):
            await _run_historical_channel_decryption(
                channel_key_bytes,
                channel_key_hex,
                None,  # No display name
            )

        # Should use key prefix as display name
        call_msg = mock_success.call_args[0][0]
        assert channel_key_hex[:12] in call_msg


class TestMaintenanceEndpoint:
    """Test POST /api/packets/maintenance."""

    @pytest.mark.asyncio
    async def test_prune_old_undecrypted(self, test_db, client):
        """Prune deletes undecrypted packets older than threshold."""
        await _insert_raw_packets(3, decrypted=False, age_days=30)
        await _insert_raw_packets(2, decrypted=False, age_days=0)

        response = await client.post(
            "/api/packets/maintenance",
            json={"prune_undecrypted_days": 7},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["packets_deleted"] == 3

        # Verify only recent packets remain
        remaining = await RawPacketRepository.get_undecrypted_count()
        assert remaining == 2

    @pytest.mark.asyncio
    async def test_purge_linked_raw_packets(self, test_db, client):
        """Purge deletes raw packets that are linked to stored messages."""
        await _insert_raw_packets(3, decrypted=True)
        await _insert_raw_packets(2, decrypted=False)

        response = await client.post(
            "/api/packets/maintenance",
            json={"purge_linked_raw_packets": True},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["packets_deleted"] == 3

        # Undecrypted packets should remain
        remaining = await RawPacketRepository.get_undecrypted_count()
        assert remaining == 2

    @pytest.mark.asyncio
    async def test_both_prune_and_purge(self, test_db, client):
        """Both prune and purge can run in a single request."""
        await _insert_raw_packets(2, decrypted=True)
        await _insert_raw_packets(3, decrypted=False, age_days=30)
        await _insert_raw_packets(1, decrypted=False, age_days=0)

        response = await client.post(
            "/api/packets/maintenance",
            json={
                "prune_undecrypted_days": 7,
                "purge_linked_raw_packets": True,
            },
        )

        assert response.status_code == 200
        data = response.json()
        # 2 linked + 3 old undecrypted = 5 deleted
        assert data["packets_deleted"] == 5

    @pytest.mark.asyncio
    async def test_no_options_deletes_nothing(self, test_db, client):
        """No options specified means no deletions (only vacuum)."""
        await _insert_raw_packets(5)

        response = await client.post(
            "/api/packets/maintenance",
            json={},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["packets_deleted"] == 0

    @pytest.mark.asyncio
    async def test_vacuum_reports_status(self, test_db, client):
        """Maintenance endpoint reports vacuum status."""
        response = await client.post(
            "/api/packets/maintenance",
            json={},
        )

        assert response.status_code == 200
        data = response.json()
        # vacuumed is a boolean (may be True or False depending on DB state)
        assert isinstance(data["vacuumed"], bool)

    @pytest.mark.asyncio
    async def test_prune_days_validation(self, test_db, client):
        """prune_undecrypted_days must be >= 1."""
        response = await client.post(
            "/api/packets/maintenance",
            json={"prune_undecrypted_days": 0},
        )

        assert response.status_code == 422


# ── Helper ─────────────────────────────────────────────────────────────────────


async def _insert_contact(public_key: str, name: str, last_seen: int) -> None:
    await ContactRepository.upsert(
        ContactUpsert(
            public_key=public_key,
            name=name,
            last_seen=last_seen,
        )
    )


async def _insert_advert_path(public_key: str, timestamp: int) -> None:
    await ContactAdvertPathRepository.record_observation(
        public_key=public_key,
        path_hex="aabb",
        timestamp=timestamp,
    )


# ── GET /packets/recent ────────────────────────────────────────────────────────


class TestRecentPackets:
    """Test GET /api/packets/recent."""

    @pytest.mark.asyncio
    async def test_returns_empty_list_when_no_packets(self, file_db, client):
        response = await client.get("/api/packets/recent")

        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_returns_packets_oldest_first(self, file_db, client):
        await _insert_raw_packets(3)

        response = await client.get("/api/packets/recent")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 3
        # Oldest first
        assert data[0]["timestamp"] <= data[1]["timestamp"] <= data[2]["timestamp"]

    @pytest.mark.asyncio
    async def test_returns_expected_fields(self, file_db, client):
        await _insert_raw_packets(1)

        response = await client.get("/api/packets/recent")

        assert response.status_code == 200
        pkt = response.json()[0]
        assert "id" in pkt
        assert "observation_id" in pkt
        assert "timestamp" in pkt
        assert "data" in pkt
        assert "payload_type" in pkt
        assert "decrypted" in pkt

    @pytest.mark.asyncio
    async def test_limit_parameter_caps_results(self, file_db, client):
        await _insert_raw_packets(10)

        response = await client.get("/api/packets/recent?limit=3")

        assert response.status_code == 200
        assert len(response.json()) == 3

    @pytest.mark.asyncio
    async def test_limit_capped_at_2000(self, file_db, client):
        # Just verify it accepts large values without error
        response = await client.get("/api/packets/recent?limit=99999")

        assert response.status_code == 200


# ── GET /packets/timeseries ────────────────────────────────────────────────────


class TestPacketTimeseries:
    """Test GET /api/packets/timeseries."""

    @pytest.mark.asyncio
    async def test_rejects_inverted_range(self, file_db, client):
        response = await client.get("/api/packets/timeseries?start_ts=1000&end_ts=500")

        assert response.status_code == 400
        assert "end_ts" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_rejects_invalid_bin_count(self, file_db, client):
        response = await client.get("/api/packets/timeseries?start_ts=0&end_ts=3600&bin_count=0")

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_returns_correct_bin_count(self, file_db, client):
        now = int(time.time())
        response = await client.get(
            f"/api/packets/timeseries?start_ts={now - 3600}&end_ts={now}&bin_count=10"
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["bins"]) == 10
        assert data["bin_seconds"] > 0

    @pytest.mark.asyncio
    async def test_counts_packets_in_window(self, file_db, client):
        now = int(time.time())
        start = now - 3600
        end = now

        # Insert packets inside the window
        for i in range(5):
            await RawPacketRepository.create(f"pkt{i}".encode(), start + i * 60)

        response = await client.get(
            f"/api/packets/timeseries?start_ts={start}&end_ts={end}&bin_count=10"
        )

        assert response.status_code == 200
        data = response.json()
        assert data["total_packets"] == 5
        assert data["total_bytes"] > 0

    @pytest.mark.asyncio
    async def test_excludes_packets_outside_window(self, file_db, client):
        now = int(time.time())
        start = now - 3600
        end = now

        # Insert packets before the window
        for i in range(3):
            await RawPacketRepository.create(f"old{i}".encode(), start - 100 - i)

        response = await client.get(
            f"/api/packets/timeseries?start_ts={start}&end_ts={end}&bin_count=10"
        )

        assert response.status_code == 200
        assert response.json()["total_packets"] == 0

    @pytest.mark.asyncio
    async def test_response_fields_present(self, file_db, client):
        now = int(time.time())
        response = await client.get(f"/api/packets/timeseries?start_ts={now - 60}&end_ts={now}")

        assert response.status_code == 200
        data = response.json()
        for field in (
            "bins",
            "total_packets",
            "total_bytes",
            "start_ts",
            "end_ts",
            "bin_seconds",
            "has_signal_data",
            "has_type_data",
        ):
            assert field in data


# ── GET /packets/historical-stats ─────────────────────────────────────────────


class TestHistoricalStats:
    """Test GET /api/packets/historical-stats."""

    @pytest.mark.asyncio
    async def test_rejects_inverted_range(self, file_db, client):
        response = await client.get("/api/packets/historical-stats?start_ts=1000&end_ts=500")

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_empty_window_returns_zeroes(self, file_db, client):
        now = int(time.time())
        response = await client.get(
            f"/api/packets/historical-stats?start_ts={now - 3600}&end_ts={now}"
        )

        assert response.status_code == 200
        data = response.json()
        assert data["total_packets"] == 0
        assert data["total_bytes"] == 0
        assert data["neighbors_by_count"] == []

    @pytest.mark.asyncio
    async def test_counts_packets_in_window(self, file_db, client):
        now = int(time.time())
        start = now - 3600
        end = now

        for i in range(4):
            await RawPacketRepository.create(f"data{i}".encode(), start + i * 100)

        response = await client.get(f"/api/packets/historical-stats?start_ts={start}&end_ts={end}")

        assert response.status_code == 200
        data = response.json()
        assert data["total_packets"] == 4

    @pytest.mark.asyncio
    async def test_neighbors_from_advert_paths(self, file_db, client):
        now = int(time.time())
        start = now - 3600
        end = now

        pub_key = "aa" * 32
        await _insert_contact(pub_key, "Alice", now - 100)
        await _insert_advert_path(pub_key, now - 100)

        response = await client.get(f"/api/packets/historical-stats?start_ts={start}&end_ts={end}")

        assert response.status_code == 200
        data = response.json()
        assert len(data["neighbors_by_count"]) == 1
        neighbor = data["neighbors_by_count"][0]
        assert neighbor["public_key"] == pub_key
        assert neighbor["name"] == "Alice"
        assert neighbor["heard_count"] >= 1

    @pytest.mark.asyncio
    async def test_excludes_neighbors_outside_window(self, file_db, client):
        now = int(time.time())
        start = now - 3600
        end = now

        pub_key = "bb" * 32
        await _insert_contact(pub_key, "Bob", now - 7200)  # last_seen before window
        await _insert_advert_path(pub_key, now - 7200)

        response = await client.get(f"/api/packets/historical-stats?start_ts={start}&end_ts={end}")

        assert response.status_code == 200
        assert response.json()["neighbors_by_count"] == []

    @pytest.mark.asyncio
    async def test_response_fields_present(self, file_db, client):
        now = int(time.time())
        response = await client.get(
            f"/api/packets/historical-stats?start_ts={now - 60}&end_ts={now}"
        )

        assert response.status_code == 200
        data = response.json()
        for field in (
            "total_packets",
            "total_bytes",
            "packets_per_minute",
            "avg_rssi",
            "avg_snr",
            "best_rssi",
            "type_counts",
            "has_signal_data",
            "has_type_data",
            "neighbors_by_count",
            "neighbors_by_signal",
        ):
            assert field in data


# ── GET /packets/mesh-health ───────────────────────────────────────────────────


class TestMeshHealth:
    """Test GET /api/packets/mesh-health."""

    @pytest.mark.asyncio
    async def test_rejects_inverted_range(self, file_db, client):
        response = await client.get("/api/packets/mesh-health?start_ts=1000&end_ts=500")

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_empty_window_returns_empty_lists(self, file_db, client):
        now = int(time.time())
        response = await client.get(f"/api/packets/mesh-health?start_ts={now - 3600}&end_ts={now}")

        assert response.status_code == 200
        data = response.json()
        assert data["total_contacts"] == 0
        assert data["alerts"] == []
        assert data["contacts"] == []

    @pytest.mark.asyncio
    async def test_contact_appears_in_contacts_list(self, file_db, client):
        now = int(time.time())
        start = now - 3600
        end = now

        pub_key = "cc" * 32
        await _insert_contact(pub_key, "Charlie", now - 100)
        await _insert_advert_path(pub_key, now - 100)

        response = await client.get(f"/api/packets/mesh-health?start_ts={start}&end_ts={end}")

        assert response.status_code == 200
        data = response.json()
        assert data["total_contacts"] == 1
        assert data["contacts"][0]["public_key"] == pub_key

    @pytest.mark.asyncio
    async def test_high_advert_count_triggers_alert(self, file_db, client):
        now = int(time.time())
        start = now - 3600
        end = now

        pub_key = "dd" * 32
        await _insert_contact(pub_key, "Spammer", now - 10)
        # Record 9 observations → advert_count > 8 → HIGH alert
        for i in range(9):
            await ContactAdvertPathRepository.record_observation(
                public_key=pub_key,
                path_hex=f"{i:02x}{i:02x}",
                timestamp=now - 10 - i,
            )

        response = await client.get(f"/api/packets/mesh-health?start_ts={start}&end_ts={end}")

        assert response.status_code == 200
        data = response.json()
        assert data["high_alert_count"] >= 1
        high_alerts = [a for a in data["alerts"] if a["level"] == "HIGH"]
        assert len(high_alerts) >= 1
        assert high_alerts[0]["public_key"] == pub_key

    @pytest.mark.asyncio
    async def test_medium_advert_count_triggers_alert(self, file_db, client):
        now = int(time.time())
        start = now - 3600
        end = now

        pub_key = "ee" * 32
        await _insert_contact(pub_key, "Chatty", now - 10)
        # Record 3 unique paths → advert_count > 2 → MEDIUM alert
        for i in range(3):
            await ContactAdvertPathRepository.record_observation(
                public_key=pub_key,
                path_hex=f"ff{i:02x}",
                timestamp=now - 10 - i,
            )

        response = await client.get(f"/api/packets/mesh-health?start_ts={start}&end_ts={end}")

        assert response.status_code == 200
        data = response.json()
        assert data["medium_alert_count"] >= 1
        medium_alerts = [a for a in data["alerts"] if a["level"] == "MEDIUM"]
        assert len(medium_alerts) >= 1

    @pytest.mark.asyncio
    async def test_low_advert_count_no_alert(self, file_db, client):
        now = int(time.time())
        start = now - 3600
        end = now

        pub_key = "f0" * 32
        await _insert_contact(pub_key, "Quiet", now - 10)
        await _insert_advert_path(pub_key, now - 10)

        response = await client.get(f"/api/packets/mesh-health?start_ts={start}&end_ts={end}")

        assert response.status_code == 200
        data = response.json()
        assert data["total_contacts"] == 1
        assert data["alerts"] == []

    @pytest.mark.asyncio
    async def test_response_fields_present(self, file_db, client):
        now = int(time.time())
        response = await client.get(f"/api/packets/mesh-health?start_ts={now - 60}&end_ts={now}")

        assert response.status_code == 200
        data = response.json()
        for field in (
            "start_ts",
            "end_ts",
            "window_hours",
            "total_contacts",
            "high_alert_count",
            "medium_alert_count",
            "alerts",
            "contacts",
        ):
            assert field in data

    @pytest.mark.asyncio
    async def test_window_hours_computed_correctly(self, file_db, client):
        now = int(time.time())
        start = now - 7200  # 2 hours
        end = now

        response = await client.get(f"/api/packets/mesh-health?start_ts={start}&end_ts={end}")

        assert response.status_code == 200
        assert abs(response.json()["window_hours"] - 2.0) < 0.01
