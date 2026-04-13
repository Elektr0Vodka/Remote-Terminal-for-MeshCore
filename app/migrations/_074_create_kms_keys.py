import logging

import aiosqlite

logger = logging.getLogger(__name__)


async def migrate(conn: aiosqlite.Connection) -> None:
    """Create the kms_keys table for MeshCore Key Management System.

    Stores generated Ed25519 keypairs alongside device-lifecycle metadata
    (device name, role, model, placement date, maintenance dates, etc.).
    """
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS kms_keys (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            public_key              TEXT NOT NULL UNIQUE,
            private_key             TEXT NOT NULL,
            device_name             TEXT,
            device_role             TEXT,
            model                   TEXT,
            placement_date          TEXT,
            last_maintenance        TEXT,
            last_registered_failure TEXT,
            assigned_to             TEXT,
            notes                   TEXT,
            created_at              INTEGER NOT NULL,
            updated_at              INTEGER NOT NULL
        )
        """
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_kms_keys_created ON kms_keys(created_at DESC)"
    )
    await conn.commit()
    logger.debug("Created kms_keys table")
