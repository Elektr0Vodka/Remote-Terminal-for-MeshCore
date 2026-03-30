import time

from app.database import db
from app.models import KmsKey, KmsKeyCreate, KmsKeyUpdate


class KmsRepository:
    @staticmethod
    def _row_to_key(row) -> KmsKey:
        cols = set(row.keys())
        return KmsKey(
            id=row["id"],
            public_key=row["public_key"],
            private_key=row["private_key"],
            device_name=row["device_name"] if "device_name" in cols else None,
            device_role=row["device_role"] if "device_role" in cols else None,
            model=row["model"] if "model" in cols else None,
            placement_date=row["placement_date"] if "placement_date" in cols else None,
            last_maintenance=row["last_maintenance"] if "last_maintenance" in cols else None,
            last_registered_failure=row["last_registered_failure"]
            if "last_registered_failure" in cols
            else None,
            assigned_to=row["assigned_to"] if "assigned_to" in cols else None,
            notes=row["notes"] if "notes" in cols else None,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    async def get_all() -> list[KmsKey]:
        cursor = await db.conn.execute("SELECT * FROM kms_keys ORDER BY created_at DESC")
        rows = await cursor.fetchall()
        return [KmsRepository._row_to_key(r) for r in rows]

    @staticmethod
    async def get_by_id(key_id: int) -> KmsKey | None:
        cursor = await db.conn.execute("SELECT * FROM kms_keys WHERE id = ?", (key_id,))
        row = await cursor.fetchone()
        return KmsRepository._row_to_key(row) if row else None

    @staticmethod
    async def create(data: KmsKeyCreate) -> KmsKey:
        now = int(time.time())
        cursor = await db.conn.execute(
            """
            INSERT INTO kms_keys (
                public_key, private_key, device_name, device_role, model,
                placement_date, last_maintenance, last_registered_failure,
                assigned_to, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.public_key.lower(),
                data.private_key.lower(),
                data.device_name,
                data.device_role,
                data.model,
                data.placement_date,
                data.last_maintenance,
                data.last_registered_failure,
                data.assigned_to,
                data.notes,
                now,
                now,
            ),
        )
        await db.conn.commit()
        row_id = cursor.lastrowid
        assert row_id is not None
        result = await KmsRepository.get_by_id(row_id)
        assert result is not None
        return result

    @staticmethod
    async def update(key_id: int, data: KmsKeyUpdate) -> KmsKey | None:
        now = int(time.time())
        fields = {
            "device_name": data.device_name,
            "device_role": data.device_role,
            "model": data.model,
            "placement_date": data.placement_date,
            "last_maintenance": data.last_maintenance,
            "last_registered_failure": data.last_registered_failure,
            "assigned_to": data.assigned_to,
            "notes": data.notes,
            "updated_at": now,
        }
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        await db.conn.execute(
            f"UPDATE kms_keys SET {set_clause} WHERE id = ?",
            (*fields.values(), key_id),
        )
        await db.conn.commit()
        return await KmsRepository.get_by_id(key_id)

    @staticmethod
    async def delete(key_id: int) -> bool:
        cursor = await db.conn.execute("DELETE FROM kms_keys WHERE id = ?", (key_id,))
        await db.conn.commit()
        return cursor.rowcount > 0
