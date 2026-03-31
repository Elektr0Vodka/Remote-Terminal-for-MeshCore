import time

from app.database import db


class NoiseFloorRepository:
    @staticmethod
    async def insert(timestamp: int, noise_floor_dbm: int) -> None:
        await db.conn.execute(
            "INSERT INTO noise_floor_samples (timestamp, noise_floor_dbm) VALUES (?, ?)",
            (timestamp, noise_floor_dbm),
        )
        await db.conn.commit()

    @staticmethod
    async def get_range(start_ts: int, end_ts: int) -> list[dict]:
        cursor = await db.conn.execute(
            "SELECT timestamp, noise_floor_dbm FROM noise_floor_samples "
            "WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC",
            (start_ts, end_ts),
        )
        rows = await cursor.fetchall()
        return [{"timestamp": r[0], "noise_floor_dbm": r[1]} for r in rows]

    @staticmethod
    async def get_last_n_hours(hours: int) -> list[dict]:
        cutoff = int(time.time()) - hours * 3600
        cursor = await db.conn.execute(
            "SELECT timestamp, noise_floor_dbm FROM noise_floor_samples "
            "WHERE timestamp >= ? ORDER BY timestamp ASC",
            (cutoff,),
        )
        rows = await cursor.fetchall()
        return [{"timestamp": r[0], "noise_floor_dbm": r[1]} for r in rows]
