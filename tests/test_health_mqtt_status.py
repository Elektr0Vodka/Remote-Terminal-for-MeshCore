"""Tests for health endpoint MQTT status field.

Verifies that build_health_data correctly reports MQTT status as
'connected', 'disconnected', or 'disabled' based on publisher state.
"""

from unittest.mock import patch

import pytest

from app.routers.health import build_health_data


class TestHealthMqttStatus:
    """Test MQTT status in build_health_data."""

    @pytest.mark.asyncio
    async def test_mqtt_disabled_when_not_configured(self, test_db):
        """MQTT status is 'disabled' when broker host is empty."""
        from app.mqtt import mqtt_publisher

        original_settings = mqtt_publisher._settings
        original_connected = mqtt_publisher.connected
        try:
            from app.models import AppSettings

            mqtt_publisher._settings = AppSettings(mqtt_broker_host="")
            mqtt_publisher.connected = False

            data = await build_health_data(True, "TCP: 1.2.3.4:4000")

            assert data["mqtt_status"] == "disabled"
        finally:
            mqtt_publisher._settings = original_settings
            mqtt_publisher.connected = original_connected

    @pytest.mark.asyncio
    async def test_mqtt_disabled_when_nothing_to_publish(self, test_db):
        """MQTT status is 'disabled' when broker host is set but no publish options enabled."""
        from app.mqtt import mqtt_publisher

        original_settings = mqtt_publisher._settings
        original_connected = mqtt_publisher.connected
        try:
            from app.models import AppSettings

            mqtt_publisher._settings = AppSettings(
                mqtt_broker_host="broker.local",
                mqtt_publish_messages=False,
                mqtt_publish_raw_packets=False,
            )
            mqtt_publisher.connected = False

            data = await build_health_data(True, "TCP: 1.2.3.4:4000")

            assert data["mqtt_status"] == "disabled"
        finally:
            mqtt_publisher._settings = original_settings
            mqtt_publisher.connected = original_connected

    @pytest.mark.asyncio
    async def test_mqtt_connected_when_publisher_connected(self, test_db):
        """MQTT status is 'connected' when publisher is connected."""
        from app.mqtt import mqtt_publisher

        original_settings = mqtt_publisher._settings
        original_connected = mqtt_publisher.connected
        try:
            from app.models import AppSettings

            mqtt_publisher._settings = AppSettings(
                mqtt_broker_host="broker.local", mqtt_publish_messages=True
            )
            mqtt_publisher.connected = True

            data = await build_health_data(True, "TCP: 1.2.3.4:4000")

            assert data["mqtt_status"] == "connected"
        finally:
            mqtt_publisher._settings = original_settings
            mqtt_publisher.connected = original_connected

    @pytest.mark.asyncio
    async def test_mqtt_disconnected_when_configured_but_not_connected(self, test_db):
        """MQTT status is 'disconnected' when configured but not connected."""
        from app.mqtt import mqtt_publisher

        original_settings = mqtt_publisher._settings
        original_connected = mqtt_publisher.connected
        try:
            from app.models import AppSettings

            mqtt_publisher._settings = AppSettings(
                mqtt_broker_host="broker.local", mqtt_publish_raw_packets=True
            )
            mqtt_publisher.connected = False

            data = await build_health_data(False, None)

            assert data["mqtt_status"] == "disconnected"
        finally:
            mqtt_publisher._settings = original_settings
            mqtt_publisher.connected = original_connected

    @pytest.mark.asyncio
    async def test_health_status_ok_when_connected(self, test_db):
        """Health status is 'ok' when radio is connected."""
        with patch(
            "app.routers.health.RawPacketRepository.get_oldest_undecrypted", return_value=None
        ):
            data = await build_health_data(True, "Serial: /dev/ttyUSB0")

        assert data["status"] == "ok"
        assert data["radio_connected"] is True
        assert data["connection_info"] == "Serial: /dev/ttyUSB0"

    @pytest.mark.asyncio
    async def test_health_status_degraded_when_disconnected(self, test_db):
        """Health status is 'degraded' when radio is disconnected."""
        with patch(
            "app.routers.health.RawPacketRepository.get_oldest_undecrypted", return_value=None
        ):
            data = await build_health_data(False, None)

        assert data["status"] == "degraded"
        assert data["radio_connected"] is False
        assert data["connection_info"] is None
