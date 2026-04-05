"""Bot detection API router."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.repository.bot_detection import BotDetectionRepository
from app.services.bot_analyzer import analyze_all_nodes

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bot-detection", tags=["bot-detection"])

_VALID_TAGS = {"likely_bot", "utility_bot", "test", "not_a_bot"}


class TagRequest(BaseModel):
    tag: str | None = None  # None = clear tag


def _row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    """Normalise a DB row for API responses."""
    return {
        "public_key": row["public_key"],
        "display_name": row.get("display_name") or row["public_key"],
        "automation_score": row.get("automation_score") or 0.0,
        "impact_score": row.get("impact_score") or 0.0,
        "classification": row.get("classification") or "unknown",
        "manual_tag": row.get("manual_tag"),
        "message_count": row.get("message_count") or 0,
        "last_seen": row.get("last_seen"),
        "timing_cv": row.get("timing_cv"),
        "pattern_ratio": row.get("pattern_ratio"),
        "structured_ratio": row.get("structured_ratio"),
        "avg_interval_seconds": row.get("avg_interval_seconds"),
        "messages_per_hour": row.get("messages_per_hour") or 0.0,
        "avg_message_length": row.get("avg_message_length") or 0.0,
        "insufficient_data": bool(row.get("insufficient_data", 1)),
        "last_analyzed_at": row.get("last_analyzed_at"),
    }


@router.get("/nodes")
async def list_nodes() -> list[dict[str, Any]]:
    """Return all scored nodes sorted by automation score descending."""
    rows = await BotDetectionRepository.get_all()
    return [_row_to_dict(r) for r in rows]


@router.get("/nodes/{public_key}")
async def get_node(public_key: str) -> dict[str, Any]:
    """Return a single node with score details and recent messages."""
    row = await BotDetectionRepository.get_by_key(public_key)
    if row is None:
        raise HTTPException(status_code=404, detail="Node not found in bot detection index")
    result = _row_to_dict(row)
    messages = await BotDetectionRepository.get_recent_messages_for_display(public_key)
    result["recent_messages"] = [
        {
            "text": m.get("text"),
            "received_at": m.get("received_at"),
            "type": m.get("type"),
        }
        for m in messages
    ]
    return result


@router.post("/nodes/{public_key}/tag")
async def set_tag(public_key: str, body: TagRequest) -> dict[str, str | None]:
    """Set or clear the manual tag for a node."""
    tag = body.tag
    if tag is not None and tag not in _VALID_TAGS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid tag. Must be one of: {', '.join(sorted(_VALID_TAGS))} or null",
        )
    await BotDetectionRepository.set_manual_tag(public_key, tag)
    return {"public_key": public_key.lower(), "manual_tag": tag}


@router.post("/analyze")
async def trigger_analysis() -> dict[str, int]:
    """Trigger an immediate full re-analysis of all nodes."""
    count = await analyze_all_nodes()
    return {"nodes_analyzed": count}


