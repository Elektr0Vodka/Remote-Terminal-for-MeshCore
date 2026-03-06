"""FanoutManager: owns all active fanout modules and dispatches events."""

from __future__ import annotations

import logging
from typing import Any

from app.fanout.base import FanoutModule

logger = logging.getLogger(__name__)

# Type string -> module class mapping (extended in Phase 2/3)
_MODULE_TYPES: dict[str, type] = {}


def _register_module_types() -> None:
    """Lazily populate the type registry to avoid circular imports."""
    if _MODULE_TYPES:
        return
    from app.fanout.bot import BotModule
    from app.fanout.mqtt_community import MqttCommunityModule
    from app.fanout.mqtt_private import MqttPrivateModule
    from app.fanout.webhook import WebhookModule

    _MODULE_TYPES["mqtt_private"] = MqttPrivateModule
    _MODULE_TYPES["mqtt_community"] = MqttCommunityModule
    _MODULE_TYPES["bot"] = BotModule
    _MODULE_TYPES["webhook"] = WebhookModule


def _matches_filter(filter_value: Any, key: str) -> bool:
    """Check a single filter value (channels or contacts) against a key.

    Supported shapes:
      "all"                        -> True
      "none"                       -> False
      ["key1", "key2"]             -> key in list  (only listed)
      {"except": ["key1", "key2"]} -> key not in list  (all except listed)
    """
    if filter_value == "all":
        return True
    if filter_value == "none":
        return False
    if isinstance(filter_value, list):
        return key in filter_value
    if isinstance(filter_value, dict) and "except" in filter_value:
        return key not in filter_value["except"]
    return False


def _scope_matches_message(scope: dict, data: dict) -> bool:
    """Check whether a message event matches the given scope."""
    messages = scope.get("messages", "none")
    if messages == "all":
        return True
    if messages == "none":
        return False
    if isinstance(messages, dict):
        msg_type = data.get("type", "")
        conversation_key = data.get("conversation_key", "")
        if msg_type == "CHAN":
            return _matches_filter(messages.get("channels", "none"), conversation_key)
        elif msg_type == "PRIV":
            return _matches_filter(messages.get("contacts", "none"), conversation_key)
    return False


def _scope_matches_raw(scope: dict, _data: dict) -> bool:
    """Check whether a raw packet event matches the given scope."""
    return scope.get("raw_packets", "none") == "all"


class FanoutManager:
    """Owns all active fanout modules and dispatches events."""

    def __init__(self) -> None:
        self._modules: dict[str, tuple[FanoutModule, dict]] = {}  # id -> (module, scope)

    async def load_from_db(self) -> None:
        """Read enabled fanout_configs and instantiate modules."""
        _register_module_types()
        from app.repository.fanout import FanoutConfigRepository

        configs = await FanoutConfigRepository.get_enabled()
        for cfg in configs:
            await self._start_module(cfg)

    async def _start_module(self, cfg: dict[str, Any]) -> None:
        """Instantiate and start a single module from a config dict."""
        config_id = cfg["id"]
        config_type = cfg["type"]
        config_blob = cfg["config"]
        scope = cfg["scope"]

        # Skip bot modules when bots are disabled server-wide
        if config_type == "bot":
            from app.config import settings as server_settings

            if server_settings.disable_bots:
                logger.info("Skipping bot module %s (bots disabled by server config)", config_id)
                return

        cls = _MODULE_TYPES.get(config_type)
        if cls is None:
            logger.warning("Unknown fanout type %r for config %s, skipping", config_type, config_id)
            return

        try:
            if config_type == "bot":
                module = cls(config_id, config_blob, name=cfg.get("name", "Bot"))
            else:
                module = cls(config_id, config_blob)
            await module.start()
            self._modules[config_id] = (module, scope)
            logger.info(
                "Started fanout module %s (type=%s)", cfg.get("name", config_id), config_type
            )
        except Exception:
            logger.exception("Failed to start fanout module %s", config_id)

    async def reload_config(self, config_id: str) -> None:
        """Stop old module (if any) and start updated config."""
        await self.remove_config(config_id)

        from app.repository.fanout import FanoutConfigRepository

        cfg = await FanoutConfigRepository.get(config_id)
        if cfg is None or not cfg["enabled"]:
            return
        await self._start_module(cfg)

    async def remove_config(self, config_id: str) -> None:
        """Stop and remove a module."""
        entry = self._modules.pop(config_id, None)
        if entry is not None:
            module, _ = entry
            try:
                await module.stop()
            except Exception:
                logger.exception("Error stopping fanout module %s", config_id)

    async def broadcast_message(self, data: dict) -> None:
        """Dispatch a decoded message to modules whose scope matches."""
        for config_id, (module, scope) in list(self._modules.items()):
            if _scope_matches_message(scope, data):
                try:
                    await module.on_message(data)
                except Exception:
                    logger.exception("Fanout %s on_message error", config_id)

    async def broadcast_raw(self, data: dict) -> None:
        """Dispatch a raw packet to modules whose scope matches."""
        for config_id, (module, scope) in list(self._modules.items()):
            if _scope_matches_raw(scope, data):
                try:
                    await module.on_raw(data)
                except Exception:
                    logger.exception("Fanout %s on_raw error", config_id)

    async def stop_all(self) -> None:
        """Shutdown all modules."""
        for config_id, (module, _) in list(self._modules.items()):
            try:
                await module.stop()
            except Exception:
                logger.exception("Error stopping fanout module %s", config_id)
        self._modules.clear()

    def get_statuses(self) -> dict[str, dict[str, str]]:
        """Return status info for each active module."""
        from app.repository.fanout import _configs_cache

        result: dict[str, dict[str, str]] = {}
        for config_id, (module, _) in self._modules.items():
            info = _configs_cache.get(config_id, {})
            result[config_id] = {
                "name": info.get("name", config_id),
                "type": info.get("type", "unknown"),
                "status": module.status,
            }
        return result


# Module-level singleton
fanout_manager = FanoutManager()
