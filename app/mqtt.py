"""MQTT publisher for forwarding mesh network events to an MQTT broker."""

from __future__ import annotations

import asyncio
import logging
import ssl
from typing import Any

from app.models import AppSettings
from app.mqtt_base import BaseMqttPublisher

logger = logging.getLogger(__name__)


class MqttPublisher(BaseMqttPublisher):
    """Manages an MQTT connection and publishes mesh network events."""

    _backoff_max = 30
    _log_prefix = "MQTT"

    def _is_configured(self) -> bool:
        """Check if MQTT is configured and has something to publish."""
        return bool(
            self._settings
            and self._settings.mqtt_broker_host
            and (self._settings.mqtt_publish_messages or self._settings.mqtt_publish_raw_packets)
        )

    def _build_client_kwargs(self, settings: AppSettings) -> dict[str, Any]:
        return {
            "hostname": settings.mqtt_broker_host,
            "port": settings.mqtt_broker_port,
            "username": settings.mqtt_username or None,
            "password": settings.mqtt_password or None,
            "tls_context": self._build_tls_context(settings),
        }

    def _on_connected(self, settings: AppSettings) -> tuple[str, str]:
        return ("MQTT connected", f"{settings.mqtt_broker_host}:{settings.mqtt_broker_port}")

    def _on_error(self) -> tuple[str, str]:
        return ("MQTT connection failure", "Please correct the settings or disable.")

    @staticmethod
    def _build_tls_context(settings: AppSettings) -> ssl.SSLContext | None:
        """Build TLS context from settings, or None if TLS is disabled."""
        if not settings.mqtt_use_tls:
            return None
        ctx = ssl.create_default_context()
        if settings.mqtt_tls_insecure:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        return ctx


# Module-level singleton
mqtt_publisher = MqttPublisher()


def mqtt_broadcast(event_type: str, data: dict[str, Any]) -> None:
    """Fire-and-forget MQTT publish, matching broadcast_event's pattern."""
    if event_type not in ("message", "raw_packet"):
        return
    if not mqtt_publisher.connected or mqtt_publisher._settings is None:
        return
    asyncio.create_task(_mqtt_maybe_publish(event_type, data))


async def _mqtt_maybe_publish(event_type: str, data: dict[str, Any]) -> None:
    """Check settings and build topic, then publish."""
    settings = mqtt_publisher._settings
    if settings is None:
        return

    try:
        if event_type == "message" and settings.mqtt_publish_messages:
            topic = _build_message_topic(settings.mqtt_topic_prefix, data)
            await mqtt_publisher.publish(topic, data)

        elif event_type == "raw_packet" and settings.mqtt_publish_raw_packets:
            topic = _build_raw_packet_topic(settings.mqtt_topic_prefix, data)
            await mqtt_publisher.publish(topic, data)

    except Exception as e:
        logger.warning("MQTT broadcast error: %s", e)


def _build_message_topic(prefix: str, data: dict[str, Any]) -> str:
    """Build MQTT topic for a decrypted message."""
    msg_type = data.get("type", "")
    conversation_key = data.get("conversation_key", "unknown")

    if msg_type == "PRIV":
        return f"{prefix}/dm:{conversation_key}"
    elif msg_type == "CHAN":
        return f"{prefix}/gm:{conversation_key}"
    return f"{prefix}/message:{conversation_key}"


def _build_raw_packet_topic(prefix: str, data: dict[str, Any]) -> str:
    """Build MQTT topic for a raw packet."""
    info = data.get("decrypted_info")
    if info and isinstance(info, dict):
        contact_key = info.get("contact_key")
        channel_key = info.get("channel_key")
        if contact_key:
            return f"{prefix}/raw/dm:{contact_key}"
        if channel_key:
            return f"{prefix}/raw/gm:{channel_key}"
    return f"{prefix}/raw/unrouted"
