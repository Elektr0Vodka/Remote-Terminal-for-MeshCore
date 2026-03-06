"""Integration tests: real MQTT capture broker + real fanout modules.

Spins up a minimal in-process MQTT 3.1.1 broker on a random port, creates
fanout configs in an in-memory DB, starts real MqttPrivateModule instances
via the FanoutManager, and verifies that PUBLISH packets arrive (or don't)
based on enabled/disabled state and scope settings.
"""

import asyncio
import json
import struct

import pytest

import app.repository.fanout as fanout_mod
from app.database import Database
from app.fanout.manager import FanoutManager
from app.repository.fanout import FanoutConfigRepository

# ---------------------------------------------------------------------------
# Minimal async MQTT 3.1.1 capture broker
# ---------------------------------------------------------------------------


class MqttCaptureBroker:
    """Tiny TCP server that speaks just enough MQTT to capture PUBLISH packets."""

    def __init__(self):
        self.published: list[tuple[str, dict]] = []
        self._server: asyncio.Server | None = None
        self.port: int = 0

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle_client, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self.port

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def wait_for(self, count: int, timeout: float = 5.0) -> list[tuple[str, dict]]:
        """Block until *count* messages captured, or timeout."""
        deadline = asyncio.get_event_loop().time() + timeout
        while len(self.published) < count:
            if asyncio.get_event_loop().time() >= deadline:
                break
            await asyncio.sleep(0.02)
        return list(self.published)

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            while True:
                first = await reader.readexactly(1)
                pkt_type = (first[0] & 0xF0) >> 4
                rem_len = await self._read_varlen(reader)
                payload = await reader.readexactly(rem_len) if rem_len else b""

                if pkt_type == 1:  # CONNECT -> CONNACK
                    writer.write(b"\x20\x02\x00\x00")
                    await writer.drain()
                elif pkt_type == 3:  # PUBLISH (QoS 0)
                    topic_len = struct.unpack("!H", payload[:2])[0]
                    topic = payload[2 : 2 + topic_len].decode()
                    body = payload[2 + topic_len :]
                    try:
                        data = json.loads(body)
                    except Exception:
                        data = {}
                    self.published.append((topic, data))
                elif pkt_type == 12:  # PINGREQ -> PINGRESP
                    writer.write(b"\xd0\x00")
                    await writer.drain()
                elif pkt_type == 14:  # DISCONNECT
                    break
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            writer.close()

    @staticmethod
    async def _read_varlen(reader: asyncio.StreamReader) -> int:
        value, shift = 0, 0
        while True:
            b = (await reader.readexactly(1))[0]
            value |= (b & 0x7F) << shift
            if not (b & 0x80):
                return value
            shift += 7


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
async def mqtt_broker():
    broker = MqttCaptureBroker()
    await broker.start()
    yield broker
    await broker.stop()


@pytest.fixture
async def integration_db():
    """In-memory DB with fanout_configs, wired into the repository module.

    Database.connect() runs all migrations which create the fanout_configs
    table, so no manual DDL is needed here.
    """
    test_db = Database(":memory:")
    await test_db.connect()

    original_db = fanout_mod.db
    fanout_mod.db = test_db
    try:
        yield test_db
    finally:
        fanout_mod.db = original_db
        await test_db.disconnect()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _wait_connected(manager: FanoutManager, config_id: str, timeout: float = 5.0):
    """Poll until the module reports 'connected'."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        entry = manager._modules.get(config_id)
        if entry and entry[0].status == "connected":
            return
        await asyncio.sleep(0.05)
    raise TimeoutError(f"Module {config_id} did not connect within {timeout}s")


def _private_config(port: int, prefix: str) -> dict:
    return {"broker_host": "127.0.0.1", "broker_port": port, "topic_prefix": prefix}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestFanoutMqttIntegration:
    """End-to-end: real capture broker <-> real fanout modules."""

    @pytest.mark.asyncio
    async def test_both_enabled_both_receive(self, mqtt_broker, integration_db):
        """Two enabled integrations with different prefixes both receive messages."""
        from unittest.mock import patch

        cfg_a = await FanoutConfigRepository.create(
            config_type="mqtt_private",
            name="Alpha",
            config=_private_config(mqtt_broker.port, "alpha"),
            scope={"messages": "all", "raw_packets": "all"},
            enabled=True,
        )
        cfg_b = await FanoutConfigRepository.create(
            config_type="mqtt_private",
            name="Beta",
            config=_private_config(mqtt_broker.port, "beta"),
            scope={"messages": "all", "raw_packets": "all"},
            enabled=True,
        )

        manager = FanoutManager()
        with (
            patch("app.mqtt_base._broadcast_health"),
            patch("app.websocket.broadcast_success"),
            patch("app.websocket.broadcast_error"),
            patch("app.websocket.broadcast_health"),
        ):
            try:
                await manager.load_from_db()
                await _wait_connected(manager, cfg_a["id"])
                await _wait_connected(manager, cfg_b["id"])

                await manager.broadcast_message(
                    {"type": "PRIV", "conversation_key": "pk1", "text": "hello"}
                )

                messages = await mqtt_broker.wait_for(2)
            finally:
                await manager.stop_all()

        topics = {m[0] for m in messages}
        assert "alpha/dm:pk1" in topics
        assert "beta/dm:pk1" in topics

    @pytest.mark.asyncio
    async def test_one_disabled_only_enabled_receives(self, mqtt_broker, integration_db):
        """Disabled integration must not publish any messages."""
        from unittest.mock import patch

        cfg_on = await FanoutConfigRepository.create(
            config_type="mqtt_private",
            name="Enabled",
            config=_private_config(mqtt_broker.port, "on"),
            scope={"messages": "all", "raw_packets": "all"},
            enabled=True,
        )
        await FanoutConfigRepository.create(
            config_type="mqtt_private",
            name="Disabled",
            config=_private_config(mqtt_broker.port, "off"),
            scope={"messages": "all", "raw_packets": "all"},
            enabled=False,
        )

        manager = FanoutManager()
        with (
            patch("app.mqtt_base._broadcast_health"),
            patch("app.websocket.broadcast_success"),
            patch("app.websocket.broadcast_error"),
            patch("app.websocket.broadcast_health"),
        ):
            try:
                await manager.load_from_db()
                await _wait_connected(manager, cfg_on["id"])

                # Only 1 module should be loaded
                assert len(manager._modules) == 1

                await manager.broadcast_message(
                    {"type": "PRIV", "conversation_key": "pk1", "text": "hello"}
                )

                await mqtt_broker.wait_for(1)
                await asyncio.sleep(0.2)  # extra time to catch stray messages
            finally:
                await manager.stop_all()

        assert len(mqtt_broker.published) == 1
        assert mqtt_broker.published[0][0] == "on/dm:pk1"

    @pytest.mark.asyncio
    async def test_both_disabled_nothing_published(self, mqtt_broker, integration_db):
        """Both disabled -> zero messages published."""
        from unittest.mock import patch

        await FanoutConfigRepository.create(
            config_type="mqtt_private",
            name="A",
            config=_private_config(mqtt_broker.port, "a"),
            scope={"messages": "all", "raw_packets": "all"},
            enabled=False,
        )
        await FanoutConfigRepository.create(
            config_type="mqtt_private",
            name="B",
            config=_private_config(mqtt_broker.port, "b"),
            scope={"messages": "all", "raw_packets": "all"},
            enabled=False,
        )

        manager = FanoutManager()
        with (
            patch("app.mqtt_base._broadcast_health"),
            patch("app.websocket.broadcast_success"),
            patch("app.websocket.broadcast_error"),
            patch("app.websocket.broadcast_health"),
        ):
            try:
                await manager.load_from_db()
                assert len(manager._modules) == 0

                await manager.broadcast_message(
                    {"type": "PRIV", "conversation_key": "pk1", "text": "hello"}
                )
                await asyncio.sleep(0.3)
            finally:
                await manager.stop_all()

        assert len(mqtt_broker.published) == 0

    @pytest.mark.asyncio
    async def test_disable_after_enable_stops_publishing(self, mqtt_broker, integration_db):
        """Disabling a live integration stops its publishing immediately."""
        from unittest.mock import patch

        cfg = await FanoutConfigRepository.create(
            config_type="mqtt_private",
            name="Toggle",
            config=_private_config(mqtt_broker.port, "toggle"),
            scope={"messages": "all", "raw_packets": "all"},
            enabled=True,
        )

        manager = FanoutManager()
        with (
            patch("app.mqtt_base._broadcast_health"),
            patch("app.websocket.broadcast_success"),
            patch("app.websocket.broadcast_error"),
            patch("app.websocket.broadcast_health"),
        ):
            try:
                await manager.load_from_db()
                await _wait_connected(manager, cfg["id"])

                # Publishes while enabled
                await manager.broadcast_message(
                    {"type": "PRIV", "conversation_key": "pk1", "text": "msg1"}
                )
                await mqtt_broker.wait_for(1)
                assert len(mqtt_broker.published) == 1

                # Disable via DB + reload
                await FanoutConfigRepository.update(cfg["id"], enabled=False)
                await manager.reload_config(cfg["id"])
                assert cfg["id"] not in manager._modules

                # Should NOT publish after disable
                await manager.broadcast_message(
                    {"type": "PRIV", "conversation_key": "pk2", "text": "msg2"}
                )
                await asyncio.sleep(0.3)
            finally:
                await manager.stop_all()

        # Only the first message
        assert len(mqtt_broker.published) == 1
        assert mqtt_broker.published[0][0] == "toggle/dm:pk1"

    @pytest.mark.asyncio
    async def test_scope_messages_only_no_raw(self, mqtt_broker, integration_db):
        """Module with raw_packets=none receives messages but not raw packets."""
        from unittest.mock import patch

        cfg = await FanoutConfigRepository.create(
            config_type="mqtt_private",
            name="Messages Only",
            config=_private_config(mqtt_broker.port, "msgsonly"),
            scope={"messages": "all", "raw_packets": "none"},
            enabled=True,
        )

        manager = FanoutManager()
        with (
            patch("app.mqtt_base._broadcast_health"),
            patch("app.websocket.broadcast_success"),
            patch("app.websocket.broadcast_error"),
            patch("app.websocket.broadcast_health"),
        ):
            try:
                await manager.load_from_db()
                await _wait_connected(manager, cfg["id"])

                await manager.broadcast_message(
                    {"type": "PRIV", "conversation_key": "pk1", "text": "hi"}
                )
                await manager.broadcast_raw({"data": "aabbccdd"})

                await mqtt_broker.wait_for(1)
                await asyncio.sleep(0.2)
            finally:
                await manager.stop_all()

        assert len(mqtt_broker.published) == 1
        assert "dm:pk1" in mqtt_broker.published[0][0]

    @pytest.mark.asyncio
    async def test_scope_raw_only_no_messages(self, mqtt_broker, integration_db):
        """Module with messages=none receives raw packets but not decoded messages."""
        from unittest.mock import patch

        cfg = await FanoutConfigRepository.create(
            config_type="mqtt_private",
            name="Raw Only",
            config=_private_config(mqtt_broker.port, "rawonly"),
            scope={"messages": "none", "raw_packets": "all"},
            enabled=True,
        )

        manager = FanoutManager()
        with (
            patch("app.mqtt_base._broadcast_health"),
            patch("app.websocket.broadcast_success"),
            patch("app.websocket.broadcast_error"),
            patch("app.websocket.broadcast_health"),
        ):
            try:
                await manager.load_from_db()
                await _wait_connected(manager, cfg["id"])

                await manager.broadcast_message(
                    {"type": "PRIV", "conversation_key": "pk1", "text": "hi"}
                )
                await manager.broadcast_raw({"data": "aabbccdd"})

                await mqtt_broker.wait_for(1)
                await asyncio.sleep(0.2)
            finally:
                await manager.stop_all()

        assert len(mqtt_broker.published) == 1
        assert "raw/" in mqtt_broker.published[0][0]


# ---------------------------------------------------------------------------
# Webhook capture HTTP server
# ---------------------------------------------------------------------------


class WebhookCaptureServer:
    """Tiny HTTP server that captures POST requests for webhook testing."""

    def __init__(self):
        self.received: list[dict] = []
        self._server: asyncio.Server | None = None
        self.port: int = 0

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self.port

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def wait_for(self, count: int, timeout: float = 5.0) -> list[dict]:
        deadline = asyncio.get_event_loop().time() + timeout
        while len(self.received) < count:
            if asyncio.get_event_loop().time() >= deadline:
                break
            await asyncio.sleep(0.02)
        return list(self.received)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            # Read HTTP request line
            request_line = await reader.readline()
            if not request_line:
                return

            # Read headers
            headers: dict[str, str] = {}
            while True:
                line = await reader.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
                decoded = line.decode("utf-8", errors="replace").strip()
                if ":" in decoded:
                    key, val = decoded.split(":", 1)
                    headers[key.strip().lower()] = val.strip()

            # Read body
            content_length = int(headers.get("content-length", "0"))
            body = b""
            if content_length > 0:
                body = await reader.readexactly(content_length)

            payload: dict = {}
            if body:
                try:
                    payload = json.loads(body)
                except Exception:
                    payload = {"_raw": body.decode("utf-8", errors="replace")}

            self.received.append(
                {
                    "method": request_line.decode().split()[0],
                    "headers": headers,
                    "body": payload,
                }
            )

            # Send 200 OK
            response = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK"
            writer.write(response)
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            writer.close()


@pytest.fixture
async def webhook_server():
    server = WebhookCaptureServer()
    await server.start()
    yield server
    await server.stop()


def _webhook_config(port: int, secret: str = "") -> dict:
    return {
        "url": f"http://127.0.0.1:{port}/hook",
        "method": "POST",
        "headers": {},
        "secret": secret,
    }


# ---------------------------------------------------------------------------
# Webhook integration tests
# ---------------------------------------------------------------------------


class TestFanoutWebhookIntegration:
    """End-to-end: real HTTP capture server <-> real WebhookModule."""

    @pytest.mark.asyncio
    async def test_webhook_receives_message(self, webhook_server, integration_db):
        """An enabled webhook receives message data via HTTP POST."""
        cfg = await FanoutConfigRepository.create(
            config_type="webhook",
            name="Test Hook",
            config=_webhook_config(webhook_server.port),
            scope={"messages": "all", "raw_packets": "none"},
            enabled=True,
        )

        manager = FanoutManager()
        try:
            await manager.load_from_db()
            await _wait_connected(manager, cfg["id"])

            await manager.broadcast_message(
                {"type": "PRIV", "conversation_key": "pk1", "text": "hello webhook"}
            )

            results = await webhook_server.wait_for(1)
        finally:
            await manager.stop_all()

        assert len(results) == 1
        assert results[0]["body"]["text"] == "hello webhook"
        assert results[0]["body"]["conversation_key"] == "pk1"
        assert results[0]["headers"].get("x-webhook-event") == "message"

    @pytest.mark.asyncio
    async def test_webhook_sends_secret_header(self, webhook_server, integration_db):
        """Webhook sends X-Webhook-Secret when configured."""
        cfg = await FanoutConfigRepository.create(
            config_type="webhook",
            name="Secret Hook",
            config=_webhook_config(webhook_server.port, secret="my-secret-123"),
            scope={"messages": "all", "raw_packets": "none"},
            enabled=True,
        )

        manager = FanoutManager()
        try:
            await manager.load_from_db()
            await _wait_connected(manager, cfg["id"])

            await manager.broadcast_message(
                {"type": "CHAN", "conversation_key": "ch1", "text": "secret test"}
            )

            results = await webhook_server.wait_for(1)
        finally:
            await manager.stop_all()

        assert len(results) == 1
        assert results[0]["headers"].get("x-webhook-secret") == "my-secret-123"

    @pytest.mark.asyncio
    async def test_webhook_disabled_no_delivery(self, webhook_server, integration_db):
        """Disabled webhook should not deliver any messages."""
        await FanoutConfigRepository.create(
            config_type="webhook",
            name="Disabled Hook",
            config=_webhook_config(webhook_server.port),
            scope={"messages": "all", "raw_packets": "none"},
            enabled=False,
        )

        manager = FanoutManager()
        try:
            await manager.load_from_db()
            assert len(manager._modules) == 0

            await manager.broadcast_message(
                {"type": "PRIV", "conversation_key": "pk1", "text": "nope"}
            )
            await asyncio.sleep(0.3)
        finally:
            await manager.stop_all()

        assert len(webhook_server.received) == 0

    @pytest.mark.asyncio
    async def test_webhook_scope_selective_channels(self, webhook_server, integration_db):
        """Webhook with selective scope only fires for matching channels."""
        cfg = await FanoutConfigRepository.create(
            config_type="webhook",
            name="Selective Hook",
            config=_webhook_config(webhook_server.port),
            scope={"messages": {"channels": ["ch-yes"], "contacts": "none"}, "raw_packets": "none"},
            enabled=True,
        )

        manager = FanoutManager()
        try:
            await manager.load_from_db()
            await _wait_connected(manager, cfg["id"])

            # Matching channel — should deliver
            await manager.broadcast_message(
                {"type": "CHAN", "conversation_key": "ch-yes", "text": "included"}
            )
            # Non-matching channel — should NOT deliver
            await manager.broadcast_message(
                {"type": "CHAN", "conversation_key": "ch-no", "text": "excluded"}
            )
            # DM — contacts is "none", should NOT deliver
            await manager.broadcast_message(
                {"type": "PRIV", "conversation_key": "pk1", "text": "dm excluded"}
            )

            await webhook_server.wait_for(1)
            await asyncio.sleep(0.3)  # wait for any stragglers
        finally:
            await manager.stop_all()

        assert len(webhook_server.received) == 1
        assert webhook_server.received[0]["body"]["text"] == "included"

    @pytest.mark.asyncio
    async def test_webhook_scope_selective_contacts(self, webhook_server, integration_db):
        """Webhook with selective scope only fires for matching contacts."""
        cfg = await FanoutConfigRepository.create(
            config_type="webhook",
            name="Contact Hook",
            config=_webhook_config(webhook_server.port),
            scope={
                "messages": {"channels": "none", "contacts": ["pk-yes"]},
                "raw_packets": "none",
            },
            enabled=True,
        )

        manager = FanoutManager()
        try:
            await manager.load_from_db()
            await _wait_connected(manager, cfg["id"])

            await manager.broadcast_message(
                {"type": "PRIV", "conversation_key": "pk-yes", "text": "dm included"}
            )
            await manager.broadcast_message(
                {"type": "PRIV", "conversation_key": "pk-no", "text": "dm excluded"}
            )

            await webhook_server.wait_for(1)
            await asyncio.sleep(0.3)
        finally:
            await manager.stop_all()

        assert len(webhook_server.received) == 1
        assert webhook_server.received[0]["body"]["text"] == "dm included"

    @pytest.mark.asyncio
    async def test_webhook_scope_all_receives_everything(self, webhook_server, integration_db):
        """Webhook with scope messages='all' receives DMs and channel messages."""
        cfg = await FanoutConfigRepository.create(
            config_type="webhook",
            name="All Hook",
            config=_webhook_config(webhook_server.port),
            scope={"messages": "all", "raw_packets": "none"},
            enabled=True,
        )

        manager = FanoutManager()
        try:
            await manager.load_from_db()
            await _wait_connected(manager, cfg["id"])

            await manager.broadcast_message(
                {"type": "CHAN", "conversation_key": "ch1", "text": "channel msg"}
            )
            await manager.broadcast_message(
                {"type": "PRIV", "conversation_key": "pk1", "text": "dm msg"}
            )

            results = await webhook_server.wait_for(2)
        finally:
            await manager.stop_all()

        assert len(results) == 2
        texts = {r["body"]["text"] for r in results}
        assert "channel msg" in texts
        assert "dm msg" in texts

    @pytest.mark.asyncio
    async def test_webhook_scope_none_receives_nothing(self, webhook_server, integration_db):
        """Webhook with scope messages='none' receives nothing."""
        cfg = await FanoutConfigRepository.create(
            config_type="webhook",
            name="None Hook",
            config=_webhook_config(webhook_server.port),
            scope={"messages": "none", "raw_packets": "none"},
            enabled=True,
        )

        manager = FanoutManager()
        try:
            await manager.load_from_db()
            await _wait_connected(manager, cfg["id"])

            await manager.broadcast_message(
                {"type": "PRIV", "conversation_key": "pk1", "text": "should not arrive"}
            )
            await asyncio.sleep(0.3)
        finally:
            await manager.stop_all()

        assert len(webhook_server.received) == 0

    @pytest.mark.asyncio
    async def test_two_webhooks_both_receive(self, webhook_server, integration_db):
        """Two enabled webhooks both receive the same message."""
        cfg_a = await FanoutConfigRepository.create(
            config_type="webhook",
            name="Hook A",
            config=_webhook_config(webhook_server.port, secret="a"),
            scope={"messages": "all", "raw_packets": "none"},
            enabled=True,
        )
        cfg_b = await FanoutConfigRepository.create(
            config_type="webhook",
            name="Hook B",
            config=_webhook_config(webhook_server.port, secret="b"),
            scope={"messages": "all", "raw_packets": "none"},
            enabled=True,
        )

        manager = FanoutManager()
        try:
            await manager.load_from_db()
            await _wait_connected(manager, cfg_a["id"])
            await _wait_connected(manager, cfg_b["id"])

            await manager.broadcast_message(
                {"type": "PRIV", "conversation_key": "pk1", "text": "multi"}
            )

            results = await webhook_server.wait_for(2)
        finally:
            await manager.stop_all()

        assert len(results) == 2
        secrets = {r["headers"].get("x-webhook-secret") for r in results}
        assert "a" in secrets
        assert "b" in secrets

    @pytest.mark.asyncio
    async def test_webhook_disable_stops_delivery(self, webhook_server, integration_db):
        """Disabling a webhook stops delivery immediately."""
        cfg = await FanoutConfigRepository.create(
            config_type="webhook",
            name="Toggle Hook",
            config=_webhook_config(webhook_server.port),
            scope={"messages": "all", "raw_packets": "none"},
            enabled=True,
        )

        manager = FanoutManager()
        try:
            await manager.load_from_db()
            await _wait_connected(manager, cfg["id"])

            await manager.broadcast_message(
                {"type": "PRIV", "conversation_key": "pk1", "text": "before disable"}
            )
            await webhook_server.wait_for(1)
            assert len(webhook_server.received) == 1

            # Disable
            await FanoutConfigRepository.update(cfg["id"], enabled=False)
            await manager.reload_config(cfg["id"])
            assert cfg["id"] not in manager._modules

            await manager.broadcast_message(
                {"type": "PRIV", "conversation_key": "pk2", "text": "after disable"}
            )
            await asyncio.sleep(0.3)
        finally:
            await manager.stop_all()

        assert len(webhook_server.received) == 1

    @pytest.mark.asyncio
    async def test_webhook_scope_except_channels(self, webhook_server, integration_db):
        """Webhook with except-mode excludes listed channels, includes others."""
        cfg = await FanoutConfigRepository.create(
            config_type="webhook",
            name="Except Hook",
            config=_webhook_config(webhook_server.port),
            scope={
                "messages": {
                    "channels": {"except": ["ch-excluded"]},
                    "contacts": {"except": []},
                },
                "raw_packets": "none",
            },
            enabled=True,
        )

        manager = FanoutManager()
        try:
            await manager.load_from_db()
            await _wait_connected(manager, cfg["id"])

            # Excluded channel — should NOT deliver
            await manager.broadcast_message(
                {"type": "CHAN", "conversation_key": "ch-excluded", "text": "nope"}
            )
            # Non-excluded channel — should deliver
            await manager.broadcast_message(
                {"type": "CHAN", "conversation_key": "ch-other", "text": "yes"}
            )
            # DM with empty except list — should deliver
            await manager.broadcast_message(
                {"type": "PRIV", "conversation_key": "pk1", "text": "dm yes"}
            )

            await webhook_server.wait_for(2)
            await asyncio.sleep(0.3)
        finally:
            await manager.stop_all()

        assert len(webhook_server.received) == 2
        texts = {r["body"]["text"] for r in webhook_server.received}
        assert "yes" in texts
        assert "dm yes" in texts
        assert "nope" not in texts
