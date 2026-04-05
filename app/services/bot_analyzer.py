"""Bot behaviour analyzer.

Runs as a periodic background task. For every sender key seen in the
messages table it fetches up to 300 recent messages, computes an
automation_score and impact_score, and persists the result to the
bot_detection_nodes table.

Scoring summary
---------------
automation_score (0–100)
  35 pts  timing regularity  – low coefficient of variation in inter-message gaps
  40 pts  template repetition – fraction of messages matching the dominant pattern
  25 pts  structured content  – regex-detected bot-reply signatures

impact_score (0–100)
  50 pts  message frequency   – messages per hour (last 24 h window)
  30 pts  total volume        – log-scaled absolute count
  20 pts  average length      – proxy for on-air time per transmission

classification
  'likely_human'            automation < 25
  'automated_utility'       automation >= 25, impact < 40
  'automated_high_impact'   automation >= 25, impact >= 40
  'insufficient_data'       fewer than MIN_MESSAGES messages seen
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import statistics

from app.repository.bot_detection import BotDetectionRepository

logger = logging.getLogger(__name__)

_ANALYZE_INTERVAL_SECONDS = 300  # re-score every 5 minutes
MIN_MESSAGES = 4  # minimum messages needed for meaningful scoring
_ANALYSIS_WINDOW_MESSAGES = 300  # max messages fetched per node

# Timing regularity: need at least this many intervals for a meaningful score.
# Short message series (e.g. 6 "Test" messages) cannot reliably signal automation.
_MIN_INTERVALS_FOR_TIMING = 9  # i.e. 10+ messages

# Pattern repetition: dominant template must be at least this many characters
# after normalisation. Single words like "test" or "hi" are common human radio
# check-ins and must not raise the automation score.
_MIN_TEMPLATE_LEN = 12

# Words / short phrases that humans send as routine radio check messages.
# Matching any of these as the sole dominant template cancels the pattern score.
_HUMAN_NOISE_WORDS: frozenset[str] = frozenset(
    {
        "test", "test2", "test3", "testing", "test 1", "test 2",
        "hello", "hi", "hoi", "hey", "hallo",
        "ok", "oke", "okay", "roger", "copy", "check", "received",
        "gm", "gn", "73", "cq", "tnx", "thx", "ack", "ping", "pong",
        "welterusten", "goedemorgen", "goedemiddag", "goedenavond",
    }
)

# Name-based keywords: a flat bonus added to the automation score when the
# node's display name contains any of these strings (case-insensitive).
# Applied even when message data is insufficient so obviously-named bots are
# always surfaced rather than hidden behind the data threshold.
_BOT_NAME_KEYWORDS: frozenset[str] = frozenset({"bot"})
_BOT_NAME_SCORE = 25.0

# Structured-content patterns: must appear in ≥30 % of messages before they
# contribute any score.  A single @[node] hop-count report from a human user
# must not tip the scale.
_MIN_STRUCTURED_RATIO = 0.30

# ── structured-content patterns ────────────────────────────────────────────────
_STRUCTURED_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"@\[", re.IGNORECASE),                        # @[node] addressing
    re.compile(r"\brssi\s*:\s*-?\d+", re.IGNORECASE),         # RSSI: -80
    re.compile(r"\bsnr\s*:\s*-?\d+", re.IGNORECASE),          # SNR: 5
    re.compile(r"\bp\(\d+\)", re.IGNORECASE),                  # P(3) path notation
    re.compile(r"^ack\s*@", re.IGNORECASE),                    # ack @ prefix
    re.compile(r"\|.*\|", re.IGNORECASE),                      # pipe-delimited fields
    re.compile(r"\b\w+\s*:\s*\S+(?:\s+\w+\s*:\s*\S+){2,}"),   # 3+ key:value pairs
]

# ── template normalisation (for pattern-repetition scoring) ───────────────────
_HEX_RE = re.compile(r"\b[0-9a-fA-F]{8,}\b")
# MeshCore path payloads joined by '>': e.g. "99>c2>f9>69>da>0f>03>4d>63"
_HEX_BYTE_PATH_RE = re.compile(r"(?:[0-9a-fA-F]{1,2}>)+[0-9a-fA-F]{1,2}", re.IGNORECASE)
# MeshCore ack hop paths joined by ',': e.g. "b8,59,dc,fc,63" or "752d,9879,1e0d,db25"
# Require ≥3 segments (two comma-terminated groups + final) to avoid matching
# ordinary comma-separated words or short values.
_HEX_COMMA_PATH_RE = re.compile(
    r"(?:[0-9a-fA-F]{2,4},){2,}[0-9a-fA-F]{2,4}", re.IGNORECASE
)
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
_NODE_REF_RE = re.compile(r"@\[[^\]]*\]")


def _normalise_template(text: str) -> str:
    """Strip variable parts to expose the structural template of a message."""
    t = _NODE_REF_RE.sub("@[X]", text)
    t = _HEX_RE.sub("<KEY>", t)
    t = _HEX_BYTE_PATH_RE.sub("<PATH>", t)    # strip NN>NN>NN>... payload sequences
    t = _HEX_COMMA_PATH_RE.sub("<PATH>", t)   # strip NN,NN,NN,... ack hop paths
    t = _NUM_RE.sub("<N>", t)
    return t.lower().strip()


def _is_noise_message(text: str) -> bool:
    """Return True if *text* is a routine human check-in that should be excluded
    from bot-scoring (pattern, timing, structured analysis).

    Noise messages are ones whose normalised template is either too short to
    carry structural information or appears in the known human-phrase blocklist.
    Filtering these out before scoring ensures that a node which exclusively
    sends "Test" messages is not falsely flagged as automated.
    """
    t = _normalise_template(text)
    return len(t) < _MIN_TEMPLATE_LEN or t in _HUMAN_NOISE_WORDS


# ── scoring helpers ────────────────────────────────────────────────────────────

def _timing_score(intervals: list[float]) -> tuple[float, float | None]:
    """Return (score 0-35, coefficient_of_variation or None).

    Requires at least _MIN_INTERVALS_FOR_TIMING data points so that sparse
    but coincidentally evenly-spaced human messages don't register as regular.
    A CV ≥ 0.20 yields zero points — true automation is far more regular than
    human behaviour (CV typically < 0.05).
    """
    if len(intervals) < _MIN_INTERVALS_FOR_TIMING:
        return 0.0, None
    mean = statistics.mean(intervals)
    if mean <= 0:
        return 0.0, None
    stdev = statistics.pstdev(intervals)
    cv = stdev / mean
    # Hard cutoff: irregular series (CV ≥ 0.20) score nothing
    if cv >= 0.20:
        return 0.0, round(cv, 4)
    # Linear scale from 0 pts at CV=0.20 to 35 pts at CV=0
    score = 35.0 * (0.20 - cv) / 0.20
    return round(score, 2), round(cv, 4)


def _pattern_score(messages: list[str]) -> tuple[float, float]:
    """Return (score 0-40, top_template_ratio).

    Short or common words are explicitly excluded so that a node that only
    ever sends "Test" or "Hello" is not flagged as automated.
    The dominant template must also cover ≥50 % of messages.
    """
    if not messages:
        return 0.0, 0.0
    templates: dict[str, int] = {}
    for msg in messages:
        t = _normalise_template(msg)
        templates[t] = templates.get(t, 0) + 1
    top_template, top_count = max(templates.items(), key=lambda x: x[1])
    ratio = top_count / len(messages)

    # Trivially short or known-human templates → no automation signal
    if len(top_template) < _MIN_TEMPLATE_LEN or top_template in _HUMAN_NOISE_WORDS:
        return 0.0, round(ratio, 4)

    # Need at least 50 % of messages to share the template
    if ratio < 0.50:
        return 0.0, round(ratio, 4)

    # Scale: 50 % → 0 pts, 100 % → 40 pts
    score = 40.0 * (ratio - 0.50) / 0.50
    return round(min(score, 40.0), 2), round(ratio, 4)


def _structured_score(messages: list[str]) -> tuple[float, float]:
    """Return (score 0-25, fraction of messages matching structured patterns).

    A single structured-looking message from a human (e.g. one hop-count
    report) must not raise the score; the pattern must be consistent across
    ≥30 % of messages.
    """
    if not messages:
        return 0.0, 0.0
    hits = sum(
        1
        for msg in messages
        if any(p.search(msg) for p in _STRUCTURED_PATTERNS)
    )
    ratio = hits / len(messages)
    if ratio < _MIN_STRUCTURED_RATIO:
        return 0.0, round(ratio, 4)
    # Scale from _MIN_STRUCTURED_RATIO → 0 pts, 1.0 → 25 pts
    score = 25.0 * (ratio - _MIN_STRUCTURED_RATIO) / (1.0 - _MIN_STRUCTURED_RATIO)
    return round(score, 2), round(ratio, 4)


def _frequency_score(messages_per_hour: float) -> float:
    """Return score 0-50 based on messages per hour."""
    return round(min(50.0, messages_per_hour * 5.0), 2)


def _volume_score(total: int) -> float:
    """Return score 0-30 log-scaled on total message count."""
    if total <= 0:
        return 0.0
    # 1 msg → 0, 10 → 10, 100 → 20, 1000+ → 30
    return round(min(30.0, math.log10(max(1, total)) / math.log10(1000) * 30.0), 2)


def _length_score(avg_length: float) -> float:
    """Return score 0-20 based on average message character length."""
    return round(min(20.0, avg_length / 10.0), 2)


def _classify(automation: float, impact: float) -> str:
    if automation < 25.0:
        return "likely_human"
    if impact < 40.0:
        return "automated_utility"
    return "automated_high_impact"


def _keyword_score(display_name: str) -> float:
    """Return a flat bonus when the node's display name contains a bot keyword.

    This applies even when message history is insufficient so nodes that
    self-identify as bots are not buried by the data threshold.
    """
    lower = display_name.lower()
    return _BOT_NAME_SCORE if any(kw in lower for kw in _BOT_NAME_KEYWORDS) else 0.0


# ── main analysis function ─────────────────────────────────────────────────────

async def analyze_node(public_key: str) -> None:
    """Fetch messages for a sender and compute / persist scores."""
    rows = await BotDetectionRepository.get_messages_for_analysis(
        public_key, limit=_ANALYSIS_WINDOW_MESSAGES
    )
    if not rows:
        return

    # ── name-based keyword score (applied regardless of message count) ─────────
    display_name = await BotDetectionRepository.get_contact_name(public_key) or ""
    k_score = _keyword_score(display_name)

    # ── display-level stats (all messages, including noise) ────────────────────
    message_count = len(rows)
    all_timestamps = sorted(r["received_at"] for r in rows)
    last_seen = all_timestamps[-1] if all_timestamps else None
    all_texts = [r["text"] or "" for r in rows]
    avg_length = sum(len(t) for t in all_texts) / len(all_texts) if all_texts else 0.0

    if len(all_timestamps) >= 2:
        window_hours = max((all_timestamps[-1] - all_timestamps[0]) / 3600.0, 1 / 60)
        msgs_per_hour = (len(all_timestamps) - 1) / window_hours
    else:
        msgs_per_hour = 0.0

    # ── scoring pool: strip noise messages (routine human check-ins) ───────────
    # Noise messages (e.g. "Test", "Hello", "OK") carry no structural signal and
    # would inflate pattern / timing scores for humans who routinely test their
    # radio link.  Only messages with meaningful content are used for scoring.
    scoring_rows = [r for r in rows if not _is_noise_message(r["text"] or "")]
    scoring_texts = [r["text"] or "" for r in scoring_rows]
    scoring_timestamps = sorted(r["received_at"] for r in scoring_rows)

    scoring_intervals = [
        float(scoring_timestamps[i + 1] - scoring_timestamps[i])
        for i in range(len(scoring_timestamps) - 1)
        if scoring_timestamps[i + 1] > scoring_timestamps[i]
    ]
    avg_interval = statistics.mean(scoring_intervals) if scoring_intervals else None

    # Insufficient data if even the meaningful messages are too few
    insufficient = len(scoring_texts) < MIN_MESSAGES

    if message_count < MIN_MESSAGES or insufficient:
        automation = round(min(100.0, k_score), 1)
        await BotDetectionRepository.upsert(
            public_key,
            automation_score=automation,
            impact_score=0.0,
            classification=_classify(automation, 0.0),
            message_count=message_count,
            last_seen=last_seen,
            timing_cv=None,
            pattern_ratio=None,
            structured_ratio=None,
            avg_interval_seconds=avg_interval,
            messages_per_hour=round(msgs_per_hour, 2),
            avg_message_length=avg_length,
            insufficient_data=True,
        )
        return

    t_score, cv = _timing_score(scoring_intervals)
    p_score, p_ratio = _pattern_score(scoring_texts)
    s_score, s_ratio = _structured_score(scoring_texts)

    automation = round(min(100.0, t_score + p_score + s_score + k_score), 1)

    f_score = _frequency_score(msgs_per_hour)
    v_score = _volume_score(message_count)
    l_score = _length_score(avg_length)

    impact = round(min(100.0, f_score + v_score + l_score), 1)

    classification = _classify(automation, impact)

    await BotDetectionRepository.upsert(
        public_key,
        automation_score=automation,
        impact_score=impact,
        classification=classification,
        message_count=message_count,
        last_seen=last_seen,
        timing_cv=cv,
        pattern_ratio=p_ratio,
        structured_ratio=s_ratio,
        avg_interval_seconds=avg_interval,
        messages_per_hour=msgs_per_hour,
        avg_message_length=avg_length,
        insufficient_data=False,
    )


async def analyze_all_nodes() -> int:
    """Analyze every known sender. Returns the number of nodes processed."""
    keys = await BotDetectionRepository.get_all_sender_keys()
    count = 0
    for key in keys:
        try:
            await analyze_node(key)
            count += 1
        except Exception:
            logger.exception("Error analyzing bot scores for %s", key)
    return count


# ── background loop ────────────────────────────────────────────────────────────

_bot_analyze_task: asyncio.Task | None = None


async def _bot_analyze_loop() -> None:
    """Periodic background loop: re-score all nodes every 5 minutes."""
    # Small initial delay so the DB is fully ready on startup
    await asyncio.sleep(30)
    while True:
        try:
            n = await analyze_all_nodes()
            if n:
                logger.debug("Bot analyzer: scored %d node(s)", n)
        except Exception:
            logger.exception("Bot analyzer loop error")
        await asyncio.sleep(_ANALYZE_INTERVAL_SECONDS)


def start_bot_analyzer() -> None:
    """Start the background bot-analysis task."""
    global _bot_analyze_task
    if _bot_analyze_task is None or _bot_analyze_task.done():
        _bot_analyze_task = asyncio.create_task(_bot_analyze_loop())


async def stop_bot_analyzer() -> None:
    """Cancel the background bot-analysis task."""
    global _bot_analyze_task
    if _bot_analyze_task and not _bot_analyze_task.done():
        _bot_analyze_task.cancel()
        try:
            await _bot_analyze_task
        except asyncio.CancelledError:
            pass
    _bot_analyze_task = None
