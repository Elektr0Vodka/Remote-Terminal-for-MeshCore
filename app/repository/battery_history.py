import time

from app.database import db


class BatteryHistoryRepository:
    @staticmethod
    async def insert(timestamp: int, battery_mv: int) -> None:
        await db.conn.execute(
            "INSERT INTO battery_history (timestamp, battery_mv) VALUES (?, ?)",
            (timestamp, battery_mv),
        )
        await db.conn.commit()

    @staticmethod
    async def get_range(start_ts: int, end_ts: int) -> list[dict]:
        cursor = await db.conn.execute(
            "SELECT timestamp, battery_mv FROM battery_history "
            "WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC",
            (start_ts, end_ts),
        )
        rows = await cursor.fetchall()
        return [{"timestamp": r[0], "battery_mv": r[1]} for r in rows]

    @staticmethod
    async def get_last_n_hours(hours: int) -> list[dict]:
        cutoff = int(time.time()) - hours * 3600
        cursor = await db.conn.execute(
            "SELECT timestamp, battery_mv FROM battery_history "
            "WHERE timestamp >= ? ORDER BY timestamp ASC",
            (cutoff,),
        )
        rows = await cursor.fetchall()
        return [{"timestamp": r[0], "battery_mv": r[1]} for r in rows]
