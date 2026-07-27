import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from .database import AsyncSessionLocal, engine, verify_database_connection
from .models import (
    Base,
    FetchLog,
    GuildMember,
    RaidSnapshot,
    RewardDefinition,
    DetectedCompletion,
    PayoutEvent,
    PayoutItem,
)
from .schemas import (
    FetchLogEntryOut,
    GuildMemberOut,
    MemberHistoryOut,
    RaidSnapshotOut,
    RewardDefinitionOut,
    RewardDefinitionUpdate,
    PendingRewardItem,
    PayoutEventOut,
    PayoutItemOut,
    PayoutCreate,
    PayoutResult,
    ServerStatus,
    TriggerResult,
    MemberPayoutSummary,
)
from .tracker import _aggregate_pending, process_payout, snapshot_guild

load_dotenv()

logger = logging.getLogger(__name__)

FETCH_INTERVAL_SECONDS = 60 * 30

_background_task: asyncio.Task | None = None

DEFAULT_RAID_TYPES = [
    {"name": "notg", "display": "Nest of the Grootslangs"},
    {"name": "nol", "display": "Orphion's Nexus of Light"},
    {"name": "tcc", "display": "The Canyon Colossus"},
    {"name": "tna", "display": "The Nameless Anomaly"},
    {"name": "wtp", "display": "The Wartorn Palace"},
]


async def _seed_reward_definitions():
    async with AsyncSessionLocal() as session:
        for i, rt in enumerate(DEFAULT_RAID_TYPES):
            existing = await session.execute(
                select(RewardDefinition).where(RewardDefinition.raid_type == rt["name"])
            )
            if existing.scalar_one_or_none() is None:
                session.add(
                    RewardDefinition(
                        raid_type=rt["name"],
                        display_name=rt["display"],
                        reward_amount=0,
                        reward_label="",
                        sort_order=i,
                        is_active=True,
                    )
                )
        await session.commit()


async def _create_fetch_log() -> int:
    async with AsyncSessionLocal() as session:
        log = FetchLog(started_at=datetime.now(timezone.utc), status="running")
        session.add(log)
        await session.commit()
        return log.id


async def _periodic_fetch():
    token = os.getenv("WYNN_TOKEN")
    guild_uuid = os.getenv("GUILD_UUID")
    if not token or not guild_uuid:
        logger.error("WYNN_TOKEN or GUILD_UUID not set — background fetch disabled")
        return

    while True:
        log_id = await _create_fetch_log()
        try:
            result = await snapshot_guild(token, guild_uuid, fetch_log_id=log_id)
            logger.info("Background fetch: %s", result)
        except Exception as e:
            logger.exception("Background fetch failed")
            async with AsyncSessionLocal() as session:
                log = await session.get(FetchLog, log_id)
                if log:
                    log.completed_at = datetime.now(timezone.utc)
                    log.status = "error"
                    log.error_message = str(e)[:512]
                    await session.commit()

        await asyncio.sleep(FETCH_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await verify_database_connection()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    await _seed_reward_definitions()

    global _background_task
    _background_task = asyncio.create_task(_periodic_fetch())

    yield

    if _background_task:
        _background_task.cancel()
        try:
            await _background_task
        except asyncio.CancelledError:
            pass

    await engine.dispose()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"message": "Wynn Guild Raids Tracker"}


@app.get("/health/database")
async def database_health():
    await verify_database_connection()
    return {"database": "connected"}


@app.post("/api/trigger-fetch", response_model=TriggerResult)
async def trigger_fetch():
    token = os.getenv("WYNN_TOKEN")
    guild_uuid = os.getenv("GUILD_UUID")
    if not token or not guild_uuid:
        raise HTTPException(status_code=500, detail="WYNN_TOKEN or GUILD_UUID not configured")

    log_id = await _create_fetch_log()
    result = await snapshot_guild(token, guild_uuid, fetch_log_id=log_id)
    if result["status"] == "error":
        raise HTTPException(status_code=502, detail="API fetch failed")

    return TriggerResult(
        status=result["status"],
        snapshot_count=result["snapshot_count"],
        restricted_count=result["restricted_count"],
        timestamp=result["timestamp"],
    )


@app.get("/api/members", response_model=list[GuildMemberOut])
async def list_members(current_only: bool = True):
    async with AsyncSessionLocal() as session:
        stmt = select(GuildMember).order_by(GuildMember.rank, GuildMember.username)
        if current_only:
            stmt = stmt.where(GuildMember.is_current_member == True)  # noqa: E712
        result = await session.execute(stmt)
        members = result.scalars().all()
        return [GuildMemberOut.model_validate(m) for m in members]


@app.get("/api/members/{uuid}", response_model=MemberHistoryOut)
async def get_member_history(uuid: str):
    async with AsyncSessionLocal() as session:
        member = await session.get(GuildMember, uuid)
        if member is None:
            raise HTTPException(status_code=404, detail="Member not found")

        snapshots = await session.execute(
            select(RaidSnapshot)
            .where(RaidSnapshot.member_uuid == uuid)
            .order_by(RaidSnapshot.timestamp.asc())
        )

        return MemberHistoryOut(
            member=GuildMemberOut.model_validate(member),
            snapshots=[RaidSnapshotOut.model_validate(s) for s in snapshots.scalars().all()],
        )


@app.get("/api/snapshots", response_model=list[RaidSnapshotOut])
async def list_snapshots(member_uuid: str | None = None, limit: int = 100, offset: int = 0):
    async with AsyncSessionLocal() as session:
        stmt = select(RaidSnapshot).order_by(RaidSnapshot.timestamp.desc())
        if member_uuid:
            stmt = stmt.where(RaidSnapshot.member_uuid == member_uuid)
        stmt = stmt.offset(offset).limit(limit)
        result = await session.execute(stmt)
        return [RaidSnapshotOut.model_validate(s) for s in result.scalars().all()]


@app.get("/api/reward-definitions", response_model=list[RewardDefinitionOut])
async def list_reward_definitions():
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(RewardDefinition).order_by(RewardDefinition.sort_order)
        )
        return [RewardDefinitionOut.model_validate(r) for r in result.scalars().all()]


@app.put("/api/reward-definitions/{definition_id}", response_model=RewardDefinitionOut)
async def update_reward_definition(definition_id: int, body: RewardDefinitionUpdate):
    async with AsyncSessionLocal() as session:
        async with session.begin():
            rd = await session.get(RewardDefinition, definition_id)
            if rd is None:
                raise HTTPException(status_code=404, detail="Reward definition not found")

            update_data = body.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                setattr(rd, field, value)

        await session.commit()
        return RewardDefinitionOut.model_validate(rd)


@app.get("/api/rewards/pending", response_model=list[PendingRewardItem])
async def get_pending_rewards(
    from_: datetime = Query(alias="from"),
    to: datetime = Query(alias="to"),
    member_uuid: str | None = None,
):
    async with AsyncSessionLocal() as session:
        return await _aggregate_pending(session, from_, to, member_uuid)


@app.post("/api/rewards/payout", response_model=PayoutResult)
async def create_payout(body: PayoutCreate):
    if not body.items:
        raise HTTPException(status_code=400, detail="Payout items list is empty")

    payout_event = await process_payout(
        starts_at=body.starts_at,
        ends_at=body.ends_at,
        items=[item.model_dump() for item in body.items],
        label=body.label,
    )

    return PayoutResult(
        payout_event_id=payout_event.id,
        label=payout_event.label,
        item_count=len(payout_event.items),
        created_at=payout_event.created_at,
    )


@app.get("/api/payouts", response_model=list[PayoutEventOut])
async def list_payouts():
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(PayoutEvent).order_by(PayoutEvent.created_at.desc())
        )
        events = result.scalars().all()

        output = []
        for event in events:
            items_result = await session.execute(
                select(PayoutItem).where(PayoutItem.payout_event_id == event.id)
            )
            event.items = items_result.scalars().all()
            output.append(PayoutEventOut.model_validate(event))

        return output


@app.get("/api/payouts/{payout_id}", response_model=PayoutEventOut)
async def get_payout(payout_id: int):
    async with AsyncSessionLocal() as session:
        event = await session.get(PayoutEvent, payout_id)
        if event is None:
            raise HTTPException(status_code=404, detail="Payout not found")

        items_result = await session.execute(
            select(PayoutItem).where(PayoutItem.payout_event_id == payout_id)
        )
        event.items = items_result.scalars().all()
        return PayoutEventOut.model_validate(event)


@app.get("/api/members/{uuid}/payouts", response_model=list[MemberPayoutSummary])
async def get_member_payouts(uuid: str):
    async with AsyncSessionLocal() as session:
        member = await session.get(GuildMember, uuid)
        if member is None:
            raise HTTPException(status_code=404, detail="Member not found")

        items_result = await session.execute(
            select(PayoutItem)
            .where(PayoutItem.member_uuid == uuid)
            .order_by(PayoutItem.rewarded_at.desc())
        )
        all_items = items_result.scalars().all()

        by_event: dict[int, dict] = {}
        for item in all_items:
            if item.payout_event_id not in by_event:
                event = await session.get(PayoutEvent, item.payout_event_id)
                by_event[item.payout_event_id] = {
                    "payout_event_id": item.payout_event_id,
                    "payout_label": event.label if event else None,
                    "rewarded_at": item.rewarded_at,
                    "items": [],
                }
            by_event[item.payout_event_id]["items"].append(PayoutItemOut.model_validate(item))

        return [MemberPayoutSummary(**v) for v in by_event.values()]


@app.get("/api/status", response_model=ServerStatus)
async def get_status():
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(FetchLog).order_by(FetchLog.started_at.desc())
        )
        logs = result.scalars().all()

        total = len(logs)
        total_ok = sum(1 for l in logs if l.status == "ok")
        total_errors = sum(1 for l in logs if l.status == "error")
        recent = logs[:30]

        latest = recent[0] if recent else None

        def log_to_out(log: FetchLog) -> FetchLogEntryOut:
            duration = None
            if log.started_at and log.completed_at:
                duration = (log.completed_at - log.started_at).total_seconds()
            return FetchLogEntryOut(
                id=log.id,
                started_at=log.started_at,
                completed_at=log.completed_at,
                status=log.status,
                snapshot_count=log.snapshot_count,
                restricted_count=log.restricted_count,
                error_message=log.error_message,
                duration_seconds=round(duration, 1) if duration else None,
            )

        return ServerStatus(
            latest_fetch=log_to_out(latest) if latest else None,
            total_fetches=total,
            total_ok=total_ok,
            total_errors=total_errors,
            recent_fetches=[log_to_out(l) for l in recent],
        )
