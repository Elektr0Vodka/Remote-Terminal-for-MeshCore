"""Tests for fanout bus: manager, scope matching, repository, and modules."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from app.database import Database
from app.fanout.base import FanoutModule
from app.fanout.manager import (
    FanoutManager,
    _scope_matches_message,
    _scope_matches_raw,
)

# ---------------------------------------------------------------------------
# Scope matching unit tests
# ---------------------------------------------------------------------------


class TestScopeMatchesMessage:
    def test_all_matches_everything(self):
        assert _scope_matches_message({"messages": "all"}, {"type": "PRIV"})

    def test_none_matches_nothing(self):
        assert not _scope_matches_message({"messages": "none"}, {"type": "PRIV"})

    def test_missing_key_defaults_none(self):
        assert not _scope_matches_message({}, {"type": "PRIV"})

    def test_dict_channels_all(self):
        scope = {"messages": {"channels": "all", "contacts": "none"}}
        assert _scope_matches_message(scope, {"type": "CHAN", "conversation_key": "ch1"})

    def test_dict_channels_none(self):
        scope = {"messages": {"channels": "none"}}
        assert not _scope_matches_message(scope, {"type": "CHAN", "conversation_key": "ch1"})

    def test_dict_channels_list_match(self):
        scope = {"messages": {"channels": ["ch1", "ch2"]}}
        assert _scope_matches_message(scope, {"type": "CHAN", "conversation_key": "ch1"})

    def test_dict_channels_list_no_match(self):
        scope = {"messages": {"channels": ["ch1", "ch2"]}}
        assert not _scope_matches_message(scope, {"type": "CHAN", "conversation_key": "ch3"})

    def test_dict_contacts_all(self):
        scope = {"messages": {"contacts": "all"}}
        assert _scope_matches_message(scope, {"type": "PRIV", "conversation_key": "pk1"})

    def test_dict_contacts_list_match(self):
        scope = {"messages": {"contacts": ["pk1"]}}
        assert _scope_matches_message(scope, {"type": "PRIV", "conversation_key": "pk1"})

    def test_dict_contacts_list_no_match(self):
        scope = {"messages": {"contacts": ["pk1"]}}
        assert not _scope_matches_message(scope, {"type": "PRIV", "conversation_key": "pk2"})

    def test_dict_channels_except_excludes_listed(self):
        scope = {"messages": {"channels": {"except": ["ch1"]}, "contacts": "all"}}
        assert not _scope_matches_message(scope, {"type": "CHAN", "conversation_key": "ch1"})

    def test_dict_channels_except_includes_unlisted(self):
        scope = {"messages": {"channels": {"except": ["ch1"]}, "contacts": "all"}}
        assert _scope_matches_message(scope, {"type": "CHAN", "conversation_key": "ch2"})

    def test_dict_contacts_except_excludes_listed(self):
        scope = {"messages": {"channels": "all", "contacts": {"except": ["pk1"]}}}
        assert not _scope_matches_message(scope, {"type": "PRIV", "conversation_key": "pk1"})

    def test_dict_contacts_except_includes_unlisted(self):
        scope = {"messages": {"channels": "all", "contacts": {"except": ["pk1"]}}}
        assert _scope_matches_message(scope, {"type": "PRIV", "conversation_key": "pk2"})

    def test_dict_channels_except_empty_matches_all(self):
        scope = {"messages": {"channels": {"except": []}}}
        assert _scope_matches_message(scope, {"type": "CHAN", "conversation_key": "ch1"})


class TestScopeMatchesRaw:
    def test_all_matches(self):
        assert _scope_matches_raw({"raw_packets": "all"}, {})

    def test_none_does_not_match(self):
        assert not _scope_matches_raw({"raw_packets": "none"}, {})

    def test_missing_key_does_not_match(self):
        assert not _scope_matches_raw({}, {})


# ---------------------------------------------------------------------------
# FanoutManager dispatch tests
# ---------------------------------------------------------------------------


class StubModule(FanoutModule):
    """Minimal FanoutModule for testing dispatch."""

    def __init__(self):
        super().__init__("stub", {})
        self.message_calls: list[dict] = []
        self.raw_calls: list[dict] = []
        self._status = "connected"

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def on_message(self, data: dict) -> None:
        self.message_calls.append(data)

    async def on_raw(self, data: dict) -> None:
        self.raw_calls.append(data)

    @property
    def status(self) -> str:
        return self._status


class TestFanoutManagerDispatch:
    @pytest.mark.asyncio
    async def test_broadcast_message_dispatches_to_matching_module(self):
        manager = FanoutManager()
        mod = StubModule()
        scope = {"messages": "all", "raw_packets": "none"}
        manager._modules["test-id"] = (mod, scope)

        await manager.broadcast_message({"type": "PRIV", "conversation_key": "pk1"})

        assert len(mod.message_calls) == 1
        assert mod.message_calls[0]["conversation_key"] == "pk1"

    @pytest.mark.asyncio
    async def test_broadcast_message_skips_non_matching_module(self):
        manager = FanoutManager()
        mod = StubModule()
        scope = {"messages": "none", "raw_packets": "all"}
        manager._modules["test-id"] = (mod, scope)

        await manager.broadcast_message({"type": "PRIV", "conversation_key": "pk1"})

        assert len(mod.message_calls) == 0

    @pytest.mark.asyncio
    async def test_broadcast_raw_dispatches_to_matching_module(self):
        manager = FanoutManager()
        mod = StubModule()
        scope = {"messages": "none", "raw_packets": "all"}
        manager._modules["test-id"] = (mod, scope)

        await manager.broadcast_raw({"data": "aabbccdd"})

        assert len(mod.raw_calls) == 1

    @pytest.mark.asyncio
    async def test_broadcast_raw_skips_non_matching(self):
        manager = FanoutManager()
        mod = StubModule()
        scope = {"messages": "all", "raw_packets": "none"}
        manager._modules["test-id"] = (mod, scope)

        await manager.broadcast_raw({"data": "aabbccdd"})

        assert len(mod.raw_calls) == 0

    @pytest.mark.asyncio
    async def test_stop_all_stops_all_modules(self):
        manager = FanoutManager()
        mod1 = StubModule()
        mod1.stop = AsyncMock()
        mod2 = StubModule()
        mod2.stop = AsyncMock()
        manager._modules["id1"] = (mod1, {})
        manager._modules["id2"] = (mod2, {})

        await manager.stop_all()

        mod1.stop.assert_called_once()
        mod2.stop.assert_called_once()
        assert len(manager._modules) == 0

    @pytest.mark.asyncio
    async def test_module_error_does_not_halt_broadcast(self):
        manager = FanoutManager()
        bad_mod = StubModule()

        async def fail(data):
            raise RuntimeError("boom")

        bad_mod.on_message = fail
        good_mod = StubModule()

        manager._modules["bad"] = (bad_mod, {"messages": "all"})
        manager._modules["good"] = (good_mod, {"messages": "all"})

        await manager.broadcast_message({"type": "PRIV", "conversation_key": "pk1"})

        # Good module should still receive the message despite the bad one failing
        assert len(good_mod.message_calls) == 1

    def test_get_statuses(self):
        manager = FanoutManager()
        mod = StubModule()
        mod._status = "connected"
        manager._modules["test-id"] = (mod, {})

        with patch(
            "app.repository.fanout._configs_cache",
            {"test-id": {"name": "Test", "type": "mqtt_private"}},
        ):
            statuses = manager.get_statuses()

        assert "test-id" in statuses
        assert statuses["test-id"]["status"] == "connected"
        assert statuses["test-id"]["name"] == "Test"
        assert statuses["test-id"]["type"] == "mqtt_private"


# ---------------------------------------------------------------------------
# Repository tests
# ---------------------------------------------------------------------------


@pytest.fixture
async def fanout_db():
    """Create an in-memory database with fanout_configs table."""
    import app.repository.fanout as fanout_mod

    db = Database(":memory:")
    await db.connect()

    await db.conn.execute("""
        CREATE TABLE IF NOT EXISTS fanout_configs (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            config TEXT NOT NULL DEFAULT '{}',
            scope TEXT NOT NULL DEFAULT '{}',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0
        )
    """)
    await db.conn.commit()

    original_db = fanout_mod.db
    fanout_mod.db = db

    try:
        yield db
    finally:
        fanout_mod.db = original_db
        await db.disconnect()


class TestFanoutConfigRepository:
    @pytest.mark.asyncio
    async def test_create_and_get(self, fanout_db):
        from app.repository.fanout import FanoutConfigRepository

        cfg = await FanoutConfigRepository.create(
            config_type="mqtt_private",
            name="Test MQTT",
            config={"broker_host": "localhost", "broker_port": 1883},
            scope={"messages": "all", "raw_packets": "all"},
            enabled=True,
        )

        assert cfg["type"] == "mqtt_private"
        assert cfg["name"] == "Test MQTT"
        assert cfg["enabled"] is True
        assert cfg["config"]["broker_host"] == "localhost"

        fetched = await FanoutConfigRepository.get(cfg["id"])
        assert fetched is not None
        assert fetched["id"] == cfg["id"]

    @pytest.mark.asyncio
    async def test_get_all(self, fanout_db):
        from app.repository.fanout import FanoutConfigRepository

        await FanoutConfigRepository.create(
            config_type="mqtt_private", name="A", config={}, scope={}, enabled=True
        )
        await FanoutConfigRepository.create(
            config_type="mqtt_community", name="B", config={}, scope={}, enabled=False
        )

        all_configs = await FanoutConfigRepository.get_all()
        assert len(all_configs) == 2

    @pytest.mark.asyncio
    async def test_update(self, fanout_db):
        from app.repository.fanout import FanoutConfigRepository

        cfg = await FanoutConfigRepository.create(
            config_type="mqtt_private",
            name="Original",
            config={"broker_host": "old"},
            scope={},
            enabled=True,
        )

        updated = await FanoutConfigRepository.update(
            cfg["id"],
            name="Renamed",
            config={"broker_host": "new"},
            enabled=False,
        )

        assert updated is not None
        assert updated["name"] == "Renamed"
        assert updated["config"]["broker_host"] == "new"
        assert updated["enabled"] is False

    @pytest.mark.asyncio
    async def test_delete(self, fanout_db):
        from app.repository.fanout import FanoutConfigRepository

        cfg = await FanoutConfigRepository.create(
            config_type="mqtt_private", name="Doomed", config={}, scope={}, enabled=True
        )

        await FanoutConfigRepository.delete(cfg["id"])

        assert await FanoutConfigRepository.get(cfg["id"]) is None

    @pytest.mark.asyncio
    async def test_get_enabled(self, fanout_db):
        from app.repository.fanout import FanoutConfigRepository

        await FanoutConfigRepository.create(
            config_type="mqtt_private", name="On", config={}, scope={}, enabled=True
        )
        await FanoutConfigRepository.create(
            config_type="mqtt_community", name="Off", config={}, scope={}, enabled=False
        )

        enabled = await FanoutConfigRepository.get_enabled()
        assert len(enabled) == 1
        assert enabled[0]["name"] == "On"


# ---------------------------------------------------------------------------
# broadcast_event realtime=False test
# ---------------------------------------------------------------------------


class TestBroadcastEventRealtime:
    @pytest.mark.asyncio
    async def test_realtime_false_does_not_dispatch_fanout(self):
        """broadcast_event with realtime=False should NOT trigger fanout dispatch."""
        from app.websocket import broadcast_event

        with (
            patch("app.websocket.ws_manager") as mock_ws,
            patch("app.fanout.manager.fanout_manager") as mock_fm,
        ):
            mock_ws.broadcast = AsyncMock()

            broadcast_event("message", {"type": "PRIV"}, realtime=False)

            # Allow tasks to run
            import asyncio

            await asyncio.sleep(0)

            # WebSocket broadcast should still fire
            mock_ws.broadcast.assert_called_once()
            # But fanout should NOT be called
            mock_fm.broadcast_message.assert_not_called()

    @pytest.mark.asyncio
    async def test_realtime_true_dispatches_fanout(self):
        """broadcast_event with realtime=True should trigger fanout dispatch."""
        from app.websocket import broadcast_event

        with (
            patch("app.websocket.ws_manager") as mock_ws,
            patch("app.fanout.manager.fanout_manager") as mock_fm,
        ):
            mock_ws.broadcast = AsyncMock()
            mock_fm.broadcast_message = AsyncMock()

            broadcast_event("message", {"type": "PRIV"}, realtime=True)

            import asyncio

            await asyncio.sleep(0)

            mock_ws.broadcast.assert_called_once()
            mock_fm.broadcast_message.assert_called_once()


# ---------------------------------------------------------------------------
# Migration test
# ---------------------------------------------------------------------------


def _create_app_settings_table_sql():
    """SQL to create app_settings with all MQTT columns for migration testing."""
    return """
        CREATE TABLE IF NOT EXISTS app_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            max_radio_contacts INTEGER DEFAULT 200,
            favorites TEXT DEFAULT '[]',
            auto_decrypt_dm_on_advert INTEGER DEFAULT 0,
            sidebar_sort_order TEXT DEFAULT 'recent',
            last_message_times TEXT DEFAULT '{}',
            preferences_migrated INTEGER DEFAULT 0,
            advert_interval INTEGER DEFAULT 0,
            last_advert_time INTEGER DEFAULT 0,
            bots TEXT DEFAULT '[]',
            mqtt_broker_host TEXT DEFAULT '',
            mqtt_broker_port INTEGER DEFAULT 1883,
            mqtt_username TEXT DEFAULT '',
            mqtt_password TEXT DEFAULT '',
            mqtt_use_tls INTEGER DEFAULT 0,
            mqtt_tls_insecure INTEGER DEFAULT 0,
            mqtt_topic_prefix TEXT DEFAULT 'meshcore',
            mqtt_publish_messages INTEGER DEFAULT 0,
            mqtt_publish_raw_packets INTEGER DEFAULT 0,
            community_mqtt_enabled INTEGER DEFAULT 0,
            community_mqtt_iata TEXT DEFAULT '',
            community_mqtt_broker_host TEXT DEFAULT 'mqtt-us-v1.letsmesh.net',
            community_mqtt_broker_port INTEGER DEFAULT 443,
            community_mqtt_email TEXT DEFAULT '',
            flood_scope TEXT DEFAULT '',
            blocked_keys TEXT DEFAULT '[]',
            blocked_names TEXT DEFAULT '[]'
        )
    """


class TestMigration036:
    @pytest.mark.asyncio
    async def test_fanout_configs_table_created(self):
        """Migration 36 should create the fanout_configs table."""
        from app.migrations import _migrate_036_create_fanout_configs

        db = Database(":memory:")
        await db.connect()

        await db.conn.execute(_create_app_settings_table_sql())
        await db.conn.execute("INSERT OR IGNORE INTO app_settings (id) VALUES (1)")
        await db.conn.commit()

        try:
            await _migrate_036_create_fanout_configs(db.conn)

            cursor = await db.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='fanout_configs'"
            )
            row = await cursor.fetchone()
            assert row is not None
        finally:
            await db.disconnect()

    @pytest.mark.asyncio
    async def test_migration_creates_mqtt_private_from_settings(self):
        """Migration should create mqtt_private config from existing MQTT settings."""
        from app.migrations import _migrate_036_create_fanout_configs

        db = Database(":memory:")
        await db.connect()

        await db.conn.execute(_create_app_settings_table_sql())
        await db.conn.execute(
            """INSERT OR REPLACE INTO app_settings (id, mqtt_broker_host, mqtt_broker_port,
               mqtt_username, mqtt_password, mqtt_use_tls, mqtt_tls_insecure,
               mqtt_topic_prefix, mqtt_publish_messages, mqtt_publish_raw_packets)
               VALUES (1, 'broker.local', 1883, 'user', 'pass', 0, 0, 'mesh', 1, 0)"""
        )
        await db.conn.commit()

        try:
            await _migrate_036_create_fanout_configs(db.conn)

            cursor = await db.conn.execute(
                "SELECT * FROM fanout_configs WHERE type = 'mqtt_private'"
            )
            row = await cursor.fetchone()
            assert row is not None

            config = json.loads(row["config"])
            assert config["broker_host"] == "broker.local"
            assert config["username"] == "user"

            scope = json.loads(row["scope"])
            assert scope["messages"] == "all"
            assert scope["raw_packets"] == "none"
        finally:
            await db.disconnect()

    @pytest.mark.asyncio
    async def test_migration_creates_community_from_settings(self):
        """Migration should create mqtt_community config when community was enabled."""
        from app.migrations import _migrate_036_create_fanout_configs

        db = Database(":memory:")
        await db.connect()

        await db.conn.execute(_create_app_settings_table_sql())
        await db.conn.execute(
            """INSERT OR REPLACE INTO app_settings (id, community_mqtt_enabled, community_mqtt_iata,
               community_mqtt_broker_host, community_mqtt_broker_port, community_mqtt_email)
               VALUES (1, 1, 'DEN', 'mqtt-us-v1.letsmesh.net', 443, 'test@example.com')"""
        )
        await db.conn.commit()

        try:
            await _migrate_036_create_fanout_configs(db.conn)

            cursor = await db.conn.execute(
                "SELECT * FROM fanout_configs WHERE type = 'mqtt_community'"
            )
            row = await cursor.fetchone()
            assert row is not None
            assert bool(row["enabled"])

            config = json.loads(row["config"])
            assert config["iata"] == "DEN"
            assert config["email"] == "test@example.com"
        finally:
            await db.disconnect()

    @pytest.mark.asyncio
    async def test_migration_skips_when_no_mqtt_configured(self):
        """Migration should not create rows when MQTT was not configured."""
        from app.migrations import _migrate_036_create_fanout_configs

        db = Database(":memory:")
        await db.connect()

        await db.conn.execute(_create_app_settings_table_sql())
        await db.conn.execute("INSERT OR IGNORE INTO app_settings (id) VALUES (1)")
        await db.conn.commit()

        try:
            await _migrate_036_create_fanout_configs(db.conn)

            cursor = await db.conn.execute("SELECT COUNT(*) FROM fanout_configs")
            row = await cursor.fetchone()
            assert row[0] == 0
        finally:
            await db.disconnect()


async def _setup_db_with_fanout_table():
    """Create a DB with app_settings + fanout_configs tables for migration 37 tests."""
    from app.migrations import _migrate_036_create_fanout_configs

    db = Database(":memory:")
    await db.connect()

    await db.conn.execute(_create_app_settings_table_sql())
    await db.conn.execute("INSERT OR IGNORE INTO app_settings (id) VALUES (1)")
    await db.conn.commit()
    await _migrate_036_create_fanout_configs(db.conn)
    return db


class TestMigration037:
    @pytest.mark.asyncio
    async def test_migration_creates_bot_from_settings(self):
        """Migration should create a fanout_configs row for each bot in app_settings."""
        from app.migrations import _migrate_037_bots_to_fanout

        db = await _setup_db_with_fanout_table()
        try:
            bots_json = json.dumps(
                [
                    {
                        "id": "bot-1",
                        "name": "EchoBot",
                        "enabled": True,
                        "code": "def bot(**k): return 'echo'",
                    },
                    {
                        "id": "bot-2",
                        "name": "Quiet",
                        "enabled": False,
                        "code": "def bot(**k): pass",
                    },
                ]
            )
            await db.conn.execute("UPDATE app_settings SET bots = ? WHERE id = 1", (bots_json,))
            await db.conn.commit()

            await _migrate_037_bots_to_fanout(db.conn)

            cursor = await db.conn.execute(
                "SELECT * FROM fanout_configs WHERE type = 'bot' ORDER BY sort_order"
            )
            rows = await cursor.fetchall()
            assert len(rows) == 2

            # First bot
            assert rows[0]["name"] == "EchoBot"
            assert bool(rows[0]["enabled"])
            config0 = json.loads(rows[0]["config"])
            assert config0["code"] == "def bot(**k): return 'echo'"
            scope0 = json.loads(rows[0]["scope"])
            assert scope0["messages"] == "all"
            assert scope0["raw_packets"] == "none"
            assert rows[0]["sort_order"] == 200

            # Second bot
            assert rows[1]["name"] == "Quiet"
            assert not bool(rows[1]["enabled"])
            assert rows[1]["sort_order"] == 201
        finally:
            await db.disconnect()

    @pytest.mark.asyncio
    async def test_migration_skips_when_no_bots(self):
        """Migration should not create rows when there are no bots."""
        from app.migrations import _migrate_037_bots_to_fanout

        db = await _setup_db_with_fanout_table()
        try:
            await _migrate_037_bots_to_fanout(db.conn)

            cursor = await db.conn.execute("SELECT COUNT(*) FROM fanout_configs WHERE type = 'bot'")
            row = await cursor.fetchone()
            assert row[0] == 0
        finally:
            await db.disconnect()

    @pytest.mark.asyncio
    async def test_migration_handles_empty_bots_array(self):
        """Migration handles bots=[] gracefully."""
        from app.migrations import _migrate_037_bots_to_fanout

        db = await _setup_db_with_fanout_table()
        try:
            await db.conn.execute("UPDATE app_settings SET bots = '[]' WHERE id = 1")
            await db.conn.commit()

            await _migrate_037_bots_to_fanout(db.conn)

            cursor = await db.conn.execute("SELECT COUNT(*) FROM fanout_configs WHERE type = 'bot'")
            row = await cursor.fetchone()
            assert row[0] == 0
        finally:
            await db.disconnect()


# ---------------------------------------------------------------------------
# Webhook module unit tests
# ---------------------------------------------------------------------------


class TestWebhookModule:
    @pytest.mark.asyncio
    async def test_status_disconnected_when_no_url(self):
        from app.fanout.webhook import WebhookModule

        mod = WebhookModule("test", {"url": ""})
        await mod.start()
        assert mod.status == "disconnected"
        await mod.stop()

    @pytest.mark.asyncio
    async def test_status_connected_with_url(self):
        from app.fanout.webhook import WebhookModule

        mod = WebhookModule("test", {"url": "http://localhost:9999/hook"})
        await mod.start()
        assert mod.status == "connected"
        await mod.stop()

    @pytest.mark.asyncio
    async def test_dispatch_with_matching_scope(self):
        """WebhookModule dispatches through FanoutManager scope matching."""
        manager = FanoutManager()
        mod = StubModule()
        scope = {"messages": {"channels": ["ch1"], "contacts": "none"}, "raw_packets": "none"}
        manager._modules["test-webhook"] = (mod, scope)

        await manager.broadcast_message({"type": "CHAN", "conversation_key": "ch1", "text": "yes"})
        await manager.broadcast_message({"type": "CHAN", "conversation_key": "ch2", "text": "no"})
        await manager.broadcast_message(
            {"type": "PRIV", "conversation_key": "pk1", "text": "dm no"}
        )

        assert len(mod.message_calls) == 1
        assert mod.message_calls[0]["text"] == "yes"


# ---------------------------------------------------------------------------
# Webhook router validation tests
# ---------------------------------------------------------------------------


class TestWebhookValidation:
    def test_validate_webhook_config_requires_url(self):
        from fastapi import HTTPException

        from app.routers.fanout import _validate_webhook_config

        with pytest.raises(HTTPException) as exc_info:
            _validate_webhook_config({"url": ""})
        assert exc_info.value.status_code == 400
        assert "url is required" in exc_info.value.detail

    def test_validate_webhook_config_requires_http_scheme(self):
        from fastapi import HTTPException

        from app.routers.fanout import _validate_webhook_config

        with pytest.raises(HTTPException) as exc_info:
            _validate_webhook_config({"url": "ftp://example.com"})
        assert exc_info.value.status_code == 400

    def test_validate_webhook_config_rejects_bad_method(self):
        from fastapi import HTTPException

        from app.routers.fanout import _validate_webhook_config

        with pytest.raises(HTTPException) as exc_info:
            _validate_webhook_config({"url": "https://example.com/hook", "method": "DELETE"})
        assert exc_info.value.status_code == 400
        assert "method" in exc_info.value.detail

    def test_validate_webhook_config_accepts_valid(self):
        from app.routers.fanout import _validate_webhook_config

        # Should not raise
        _validate_webhook_config(
            {"url": "https://example.com/hook", "method": "POST", "headers": {}}
        )

    def test_enforce_scope_webhook_strips_raw_packets(self):
        from app.routers.fanout import _enforce_scope

        scope = _enforce_scope("webhook", {"messages": "all", "raw_packets": "all"})
        assert scope["raw_packets"] == "none"
        assert scope["messages"] == "all"

    def test_enforce_scope_webhook_preserves_selective(self):
        from app.routers.fanout import _enforce_scope

        scope = _enforce_scope(
            "webhook",
            {"messages": {"channels": ["ch1"], "contacts": "none"}, "raw_packets": "all"},
        )
        assert scope["raw_packets"] == "none"
        assert scope["messages"] == {"channels": ["ch1"], "contacts": "none"}
