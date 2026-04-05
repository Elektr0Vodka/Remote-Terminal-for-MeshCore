"""Repository for bot detection node scores and manual tags."""

import logging
import time
from typing import Any

from app.database import db

logger = logging.getLogger(__name__)


class BotDetectionRepository:
    @staticmethod
    async def upsert(
        public_key: str,
        *,
        automation_score: float,
        impact_score: float,
        classification: str,
        message_count: int,
        last_seen: int | None,
        timing_cv: float | None,
        pattern_ratio: float | None,
        structured_ratio: float | None,
        avg_interval_seconds: float | None,
        messages_per_hour: float,
        avg_message_length: float,
        insufficient_data: bool,
    ) -> None:
        """Insert or replace computed scores for a node. Preserves manual_tag."""
        now = int(time.time())
        await db.conn.execute(
            """
            INSERT INTO bot_detection_nodes (
                public_key,
                automation_score, impact_score, classification,
                message_count, last_seen,
                timing_cv, pattern_ratio, structured_ratio,
                avg_interval_seconds, messages_per_hour, avg_message_length,
                insufficient_data, last_analyzed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(public_key) DO UPDATE SET
                automation_score       = excluded.automation_score,
                impact_score           = excluded.impact_score,
                classification         = excluded.classification,
                message_count          = excluded.message_count,
                last_seen              = excluded.last_seen,
                timing_cv              = excluded.timing_cv,
                pattern_ratio          = excluded.pattern_ratio,
                structured_ratio       = excluded.structured_ratio,
                avg_interval_seconds   = excluded.avg_interval_seconds,
                messages_per_hour      = excluded.messages_per_hour,
                avg_message_length     = excluded.avg_message_length,
                insufficient_data      = excluded.insufficient_data,
                last_analyzed_at       = excluded.last_analyzed_at
            """,
            (
                public_key.lower(),
                round(automation_score, 1),
                round(impact_score, 1),
                classification,
                message_count,
                last_seen,
                timing_cv,
                pattern_ratio,
                structured_ratio,
                avg_interval_seconds,
                round(messages_per_hour, 2),
                round(avg_message_length, 1),
                1 if insufficient_data else 0,
                now,
            ),
        )
        await db.conn.commit()

    @staticmethod
    async def set_manual_tag(public_key: str, tag: str | None) -> None:
        """Set or clear the manual tag for a node.

        Creates a stub row if the node is not yet scored, so the tag is preserved.
        """
        now = int(time.time())
        await db.conn.execute(
            """
            INSERT INTO bot_detection_nodes (public_key, manual_tag, last_analyzed_at)
            VALUES (?, ?, ?)
            ON CONFLICT(public_key) DO UPDATE SET
                manual_tag = excluded.manual_tag
            """,
            (public_key.lower(), tag, now),
        )
        await db.conn.commit()

    @staticmethod
    async def get_all() -> list[dict[str, Any]]:
        """Return all scored nodes, joined with the latest contact name."""
        cursor = await db.conn.execute(
            """
            SELECT
                b.public_key,
                COALESCE(c.name, b.public_key) AS display_name,
                b.automation_score,
                b.impact_score,
                b.classification,
                b.manual_tag,
                b.message_count,
                b.last_seen,
                b.timing_cv,
                b.pattern_ratio,
                b.structured_ratio,
                b.avg_interval_seconds,
                b.messages_per_hour,
                b.avg_message_length,
                b.insufficient_data,
                b.last_analyzed_at
            FROM bot_detection_nodes b
            LEFT JOIN contacts c ON LOWER(c.public_key) = b.public_key
            ORDER BY b.automation_score DESC, b.impact_score DESC
            """,
        )
        rows = await cursor.fetchall()
        cols = [d[0] for d in cursor.description]
        return [dict(zip(cols, row, strict=True)) for row in rows]

    @staticmethod
    async def get_by_key(public_key: str) -> dict[str, Any] | None:
        """Return a single node record."""
        cursor = await db.conn.execute(
            """
            SELECT
                b.public_key,
                COALESCE(c.name, b.public_key) AS display_name,
                b.automation_score,
                b.impact_score,
                b.classification,
                b.manual_tag,
                b.message_count,
                b.last_seen,
                b.timing_cv,
                b.pattern_ratio,
                b.structured_ratio,
                b.avg_interval_seconds,
                b.messages_per_hour,
                b.avg_message_length,
                b.insufficient_data,
                b.last_analyzed_at
            FROM bot_detection_nodes b
            LEFT JOIN contacts c ON LOWER(c.public_key) = b.public_key
            WHERE b.public_key = ?
            """,
            (public_key.lower(),),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        cols = [d[0] for d in cursor.description]
        return dict(zip(cols, row, strict=True))

    @staticmethod
    async def get_contact_name(public_key: str) -> str | None:
        """Return the display name from the contacts table, or None if unknown."""
        cursor = await db.conn.execute(
            "SELECT name FROM contacts WHERE LOWER(public_key) = ?",
            (public_key.lower(),),
        )
        row = await cursor.fetchone()
        return str(row[0]) if row and row[0] else None

    @staticmethod
    async def get_all_sender_keys() -> list[str]:
        """Return all distinct sender_keys from incoming messages."""
        cursor = await db.conn.execute(
            """
            SELECT DISTINCT LOWER(sender_key)
            FROM messages
            WHERE sender_key IS NOT NULL AND sender_key != '' AND outgoing = 0
            """
        )
        rows = await cursor.fetchall()
        return [row[0] for row in rows]

    @staticmethod
    async def get_messages_for_analysis(
        public_key: str, limit: int = 300
    ) -> list[dict[str, Any]]:
        """Return recent incoming messages for a sender key, for scoring."""
        cursor = await db.conn.execute(
            """
            SELECT text, received_at, sender_timestamp
            FROM messages
            WHERE LOWER(sender_key) = ? AND outgoing = 0
            ORDER BY received_at DESC
            LIMIT ?
            """,
            (public_key.lower(), limit),
        )
        rows = await cursor.fetchall()
        cols = [d[0] for d in cursor.description]
        return [dict(zip(cols, row, strict=True)) for row in rows]

    @staticmethod
    async def get_recent_messages_for_display(
        public_key: str, limit: int = 20
    ) -> list[dict[str, Any]]:
        """Return recent messages for display in the bot detail panel."""
        cursor = await db.conn.execute(
            """
            SELECT text, received_at, type, conversation_key
            FROM messages
            WHERE LOWER(sender_key) = ? AND outgoing = 0
            ORDER BY received_at DESC
            LIMIT ?
            """,
            (public_key.lower(), limit),
        )
        rows = await cursor.fetchall()
        cols = [d[0] for d in cursor.description]
        return [dict(zip(cols, row, strict=True)) for row in rows]
