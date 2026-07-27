import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from .database import AsyncSessionLocal, engine, verify_database_connection
from .models import Base, GuildMember, RaidSnapshot, TrackingPeriod, RewardEligibility
from .schemas import (
    GuildMemberOut,
    MemberHistoryOut,
    RaidSnapshotOut,
    RewardEligibilityOut,
    TrackingPeriodCreate,
    TrackingPeriodOut,
    TriggerResult,
)
from .tracker import calculate_period_rewards, snapshot_guild

load_dotenv()

logger = logging.getLogger(__name__)

FETCH_INTERVAL_SECONDS = 60 * 30

_background_task: asyncio.Task | None = None


async def _periodic_fetch():
    token = os.getenv("WYNN_TOKEN")
    guild_uuid = os.getenv("GUILD_UUID")
    if not token or not guild_uuid:
        logger.error("WYNN_TOKEN or GUILD_UUID not set — background fetch disabled")
        return

    while True:
        try:
            result = await snapshot_guild(token, guild_uuid)
            logger.info("Background fetch: %s", result)
        except Exception:
            logger.exception("Background fetch failed")

        await asyncio.sleep(FETCH_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await verify_database_connection()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

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

    result = await snapshot_guild(token, guild_uuid)
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


@app.get("/api/periods", response_model=list[TrackingPeriodOut])
async def list_periods():
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(TrackingPeriod).order_by(TrackingPeriod.starts_at.desc())
        )
        return [TrackingPeriodOut.model_validate(p) for p in result.scalars().all()]


@app.post("/api/periods", response_model=TrackingPeriodOut, status_code=201)
async def create_period(body: TrackingPeriodCreate):
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as session:
        async with session.begin():
            if body.starts_at is None:
                starts_at = now
            else:
                starts_at = body.starts_at

            period = TrackingPeriod(
                name=body.name,
                starts_at=starts_at,
                ends_at=body.ends_at,
                is_active=True,
            )
            session.add(period)

        await session.commit()
        return TrackingPeriodOut.model_validate(period)


@app.post("/api/periods/{period_id}/close")
async def close_period(period_id: int):
    async with AsyncSessionLocal() as session:
        async with session.begin():
            period = await session.get(TrackingPeriod, period_id)
            if period is None:
                raise HTTPException(status_code=404, detail="Period not found")
            period.ends_at = datetime.now(timezone.utc)
            period.is_active = False
        await session.commit()
        return TrackingPeriodOut.model_validate(period)


@app.post("/api/periods/{period_id}/calculate", response_model=list[RewardEligibilityOut])
async def calculate_rewards(period_id: int):
    async with AsyncSessionLocal() as session:
        period = await session.get(TrackingPeriod, period_id)
        if period is None:
            raise HTTPException(status_code=404, detail="Period not found")
        if period.ends_at is None:
            raise HTTPException(
                status_code=400,
                detail="Period must be closed (have an end date) before calculating rewards. "
                "POST /api/periods/{id}/close first.",
            )

    eligibilities = await calculate_period_rewards(period_id)

    async with AsyncSessionLocal() as session:
        member_cache: dict[str, str] = {}
        results = []
        for el in eligibilities:
            if el.member_uuid not in member_cache:
                member = await session.get(GuildMember, el.member_uuid)
                member_cache[el.member_uuid] = member.username if member else "unknown"
            results.append(
                RewardEligibilityOut(
                    id=el.id,
                    period_id=el.period_id,
                    member_uuid=el.member_uuid,
                    member_username=member_cache[el.member_uuid],
                    start_snapshot_id=el.start_snapshot_id,
                    end_snapshot_id=el.end_snapshot_id,
                    total_progress=el.total_progress,
                    notg_progress=el.notg_progress,
                    nol_progress=el.nol_progress,
                    tcc_progress=el.tcc_progress,
                    tna_progress=el.tna_progress,
                    wtp_progress=el.wtp_progress,
                    eligibility_status=el.eligibility_status,
                    notes=el.notes,
                    rewarded_at=el.rewarded_at,
                )
            )
        return results


@app.get("/api/periods/{period_id}/rewards", response_model=list[RewardEligibilityOut])
async def get_period_rewards(period_id: int):
    async with AsyncSessionLocal() as session:
        period = await session.get(TrackingPeriod, period_id)
        if period is None:
            raise HTTPException(status_code=404, detail="Period not found")

        result = await session.execute(
            select(RewardEligibility).where(RewardEligibility.period_id == period_id)
        )
        eligibilities = result.scalars().all()

        member_cache: dict[str, str] = {}
        results = []
        for el in eligibilities:
            if el.member_uuid not in member_cache:
                member = await session.get(GuildMember, el.member_uuid)
                member_cache[el.member_uuid] = member.username if member else "unknown"
            results.append(
                RewardEligibilityOut(
                    id=el.id,
                    period_id=el.period_id,
                    member_uuid=el.member_uuid,
                    member_username=member_cache[el.member_uuid],
                    start_snapshot_id=el.start_snapshot_id,
                    end_snapshot_id=el.end_snapshot_id,
                    total_progress=el.total_progress,
                    notg_progress=el.notg_progress,
                    nol_progress=el.nol_progress,
                    tcc_progress=el.tcc_progress,
                    tna_progress=el.tna_progress,
                    wtp_progress=el.wtp_progress,
                    eligibility_status=el.eligibility_status,
                    notes=el.notes,
                    rewarded_at=el.rewarded_at,
                )
            )
        return results


@app.post("/api/eligibility/{eligibility_id}/mark-rewarded")
async def mark_rewarded(eligibility_id: int):
    async with AsyncSessionLocal() as session:
        async with session.begin():
            el = await session.get(RewardEligibility, eligibility_id)
            if el is None:
                raise HTTPException(status_code=404, detail="Reward eligibility not found")
            el.rewarded_at = datetime.now(timezone.utc)
        await session.commit()
        return {"status": "ok", "eligibility_id": eligibility_id, "rewarded_at": el.rewarded_at}
