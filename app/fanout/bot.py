"""Fanout module wrapping bot execution logic."""

from __future__ import annotations

import asyncio
import logging

from app.fanout.base import FanoutModule

logger = logging.getLogger(__name__)


class BotModule(FanoutModule):
    """Wraps a single bot's code execution and response routing.

    Each BotModule represents one bot configuration. It receives decoded
    messages via ``on_message``, executes the bot's Python code in a
    background task (after a 2-second settle delay), and sends any response
    back through the radio.
    """

    def __init__(self, config_id: str, config: dict, *, name: str = "Bot") -> None:
        super().__init__(config_id, config)
        self._name = name

    async def on_message(self, data: dict) -> None:
        """Kick off bot execution in a background task so we don't block dispatch."""
        asyncio.create_task(self._run_for_message(data))

    async def _run_for_message(self, data: dict) -> None:
        from app.fanout.bot_exec import (
            BOT_EXECUTION_TIMEOUT,
            execute_bot_code,
            process_bot_response,
        )

        code = self.config.get("code", "")
        if not code or not code.strip():
            return

        msg_type = data.get("type", "")
        is_dm = msg_type == "PRIV"

        # Extract bot parameters from broadcast data
        if is_dm:
            conversation_key = data.get("conversation_key", "")
            sender_key = conversation_key
            is_outgoing = data.get("outgoing", False)
            message_text = data.get("text", "")
            channel_key = None
            channel_name = None

            # Look up sender name from contacts
            from app.repository import ContactRepository

            contact = await ContactRepository.get_by_key(conversation_key)
            sender_name = contact.name if contact else None
        else:
            conversation_key = data.get("conversation_key", "")
            sender_key = None
            is_outgoing = bool(data.get("outgoing", False))
            sender_name = data.get("sender_name")
            channel_key = conversation_key

            # Look up channel name
            from app.repository import ChannelRepository

            channel = await ChannelRepository.get_by_key(conversation_key)
            channel_name = channel.name if channel else None

            # Strip "sender: " prefix from channel message text
            text = data.get("text", "")
            if sender_name and text.startswith(f"{sender_name}: "):
                message_text = text[len(f"{sender_name}: ") :]
            else:
                message_text = text

        sender_timestamp = data.get("sender_timestamp")
        path_value = data.get("path")
        # Message model serializes paths as list of dicts; extract first path string
        if path_value is None:
            paths = data.get("paths")
            if paths and isinstance(paths, list) and len(paths) > 0:
                path_value = paths[0].get("path") if isinstance(paths[0], dict) else None

        # Wait for message to settle (allows retransmissions to be deduped)
        await asyncio.sleep(2)

        # Execute bot code in thread pool with timeout
        from app.fanout.bot_exec import _bot_executor, _bot_semaphore

        async with _bot_semaphore:
            loop = asyncio.get_event_loop()
            try:
                response = await asyncio.wait_for(
                    loop.run_in_executor(
                        _bot_executor,
                        execute_bot_code,
                        code,
                        sender_name,
                        sender_key,
                        message_text,
                        is_dm,
                        channel_key,
                        channel_name,
                        sender_timestamp,
                        path_value,
                        is_outgoing,
                    ),
                    timeout=BOT_EXECUTION_TIMEOUT,
                )
            except asyncio.TimeoutError:
                logger.warning("Bot '%s' execution timed out", self._name)
                return
            except Exception as e:
                logger.warning("Bot '%s' execution error: %s", self._name, e)
                return

        if response:
            await process_bot_response(response, is_dm, sender_key or "", channel_key)

    @property
    def status(self) -> str:
        return "connected"
