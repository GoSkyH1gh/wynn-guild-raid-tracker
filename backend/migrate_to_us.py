"""One-time migration: EU DB (DATABASE_URL) -> US DB (US_DATABASE_URL).

Copies the raw tables only, in FK-safe order, preserving primary keys so
referential links between snapshots/completions survive. reward_definitions rows
are copied with the columns the new schema expects (dead columns are dropped).

payout_records is intentionally NOT migrated: the US instance starts with a
clean payout slate for the new cap-aware system.

Idempotent: refuses to run if the US DB already has rows in any target table.
"""

import asyncio
import os

from dotenv import find_dotenv, load_dotenv
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

load_dotenv(find_dotenv())

from database import _async_database_url  # noqa: E402
from models import Base  # noqa: E402

# (table, columns to copy) in foreign-key-safe insertion order
TABLES = [
    ("discord_users", ["id", "discord_id", "username", "avatar_url", "is_admin", "token_version", "created_at", "last_login"]),
    ("guild_members", ["uuid", "username", "rank", "first_seen", "last_seen", "is_current_member"]),
    ("raid_snapshots", ["id", "member_uuid", "timestamp", "total", "notg", "nol", "tcc", "tna", "wtp", "access_restricted", "was_member"]),
    ("detected_completions", ["id", "member_uuid", "raid_type", "count", "detected_at", "start_snapshot_id", "end_snapshot_id"]),
    ("fetch_logs", ["id", "started_at", "completed_at", "status", "snapshot_count", "restricted_count", "error_message"]),
    # reward_definitions in the US schema has no reward_amount/reward_label/is_active
    ("reward_definitions", ["id", "raid_type", "display_name", "daily_cap", "sort_order"]),
]

SERIAL_TABLES = ["discord_users", "raid_snapshots", "detected_completions", "fetch_logs", "reward_definitions"]

COPY_BATCH_SIZE = 1000


async def check_empty(mig_engine) -> None:
    async with mig_engine.connect() as conn:
        for table, _ in TABLES:
            cnt = (await conn.execute(text(f"SELECT COUNT(*) FROM {table}"))).scalar_one()
            if cnt:
                raise SystemExit(f"US DB table {table} already has {cnt} rows; aborting (target must be empty).")


async def create_schema(mig_engine) -> None:
    async with mig_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def copy_table(src_engine, mig_engine, table: str, columns: list[str]) -> int:
    cols = ", ".join(columns)
    placeholders = ", ".join(f":c{i}" for i in range(len(columns)))
    insert_stmt = text(f"INSERT INTO {table} ({cols}) VALUES ({placeholders})")

    async with src_engine.connect() as src:
        result = await src.execute(text(f"SELECT {cols} FROM {table}"))
        total = 0
        while True:
            batch = result.fetchmany(COPY_BATCH_SIZE)
            if not batch:
                break
            params = [
                {f"c{i}": r._mapping[col] for i, col in enumerate(columns)}
                for r in batch
            ]
            async with mig_engine.begin() as mig:
                await mig.execute(insert_stmt, params)
            total += len(batch)
    return total


async def set_sequences(mig_engine) -> None:
    async with mig_engine.begin() as conn:
        for table in SERIAL_TABLES:
            await conn.execute(
                text(
                    "SELECT setval(pg_get_serial_sequence(:tbl, 'id'), "
                    "COALESCE((SELECT MAX(id) FROM " + table + "), 1))"
                ),
                {"tbl": table},
            )
            print(f"sequence reset for {table}")


async def main() -> None:
    src_url = os.getenv("DATABASE_URL")
    mig_url = os.getenv("US_DATABASE_URL")
    if not src_url:
        raise SystemExit("DATABASE_URL not set (source = EU DB)")
    if not mig_url:
        raise SystemExit("US_DATABASE_URL not set (target = US DB)")

    src_engine = create_async_engine(_async_database_url(src_url), pool_pre_ping=True)
    mig_engine = create_async_engine(_async_database_url(mig_url), pool_pre_ping=True)

    try:
        await create_schema(mig_engine)
        print("schema created on target")
        await check_empty(mig_engine)
        for table, columns in TABLES:
            n = await copy_table(src_engine, mig_engine, table, columns)
            print(f"copied {table}: {n} rows")
        await set_sequences(mig_engine)
        print("migration complete")
    finally:
        await src_engine.dispose()
        await mig_engine.dispose()


asyncio.run(main())