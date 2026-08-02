import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from dotenv import load_dotenv, find_dotenv
from fastapi import FastAPI, HTTPException, Depends, Query, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from .auth import (
    AUTHORIZED_DISCORD_IDS,
    SETUP_SECRET,
    create_jwt,
    discord_login_url,
    exchange_code,
    get_discord_user,
    get_current_user,
    get_admin_user,
    create_oauth_state,
    consume_oauth_state,
    set_jwt_cookie,
    delete_jwt_cookie,
    revoke_user_token,
)
from .database import AsyncSessionLocal, engine, verify_database_connection
from .models import Base, DiscordUser, FetchLog, GuildMember, RaidSnapshot, RewardDefinition, PayoutRecord
from .schemas import (
CurrentUserOut,
    DiscordUserOut,
    DiscordUserCreate,
    SetupRequest,
    FetchLogEntryOut,
    GuildMemberOut,
    MemberHistoryOut,
    RaidSnapshotOut,
    RewardDefinitionOut,
    RewardDefinitionUpdate,
    RewardSummaryOut,
    RewardDayOut,
    PayoutCreate,
    PayoutChunkOut,
    PayoutRecordOut,
    VoidPayoutResult,
    ServerStatus,
    TriggerResult,
)
from .tracker import (
    get_reward_summary,
    get_reward_per_day,
    process_payout,
    list_payouts,
    _record_fetch_log,
    snapshot_guild,
)

load_dotenv(find_dotenv())

logger = logging.getLogger(__name__)

FETCH_INTERVAL_SECONDS = 60 * 30

_background_task: asyncio.Task | None = None

DEFAULT_RAID_TYPES = [
    {"name": "notg", "display": "Nest of the Grootslangs", "cap": 2},
    {"name": "nol", "display": "Orphion's Nexus of Light", "cap": 6},
    {"name": "tcc", "display": "The Canyon Colossus", "cap": 6},
    {"name": "tna", "display": "The Nameless Anomaly", "cap": 6},
    {"name": "wtp", "display": "The Wartorn Palace", "cap": 0},
]


async def _seed_reward_definitions():
    async with AsyncSessionLocal() as session:
        for i, rt in enumerate(DEFAULT_RAID_TYPES):
            existing = await session.execute(
                select(RewardDefinition).where(RewardDefinition.raid_type == rt["name"])
            )
            definition = existing.scalar_one_or_none()
            if definition is None:
                session.add(
                    RewardDefinition(
                        raid_type=rt["name"],
                        display_name=rt["display"],
                        reward_amount=1,
                        reward_label="",
                        sort_order=i,
                        is_active=True,
                        daily_cap=rt["cap"],
                    )
                )
            elif definition.daily_cap is None:
                definition.daily_cap = rt["cap"]
        await session.commit()


async def _periodic_fetch():
    token = os.getenv("WYNN_TOKEN")
    guild_uuid = os.getenv("GUILD_UUID")
    if not token or not guild_uuid:
        logger.error("WYNN_TOKEN or GUILD_UUID not set — background fetch disabled")
        return

    while True:
        started_at = datetime.now(timezone.utc)
        try:
            result = await snapshot_guild(token, guild_uuid)
            error_message = None if result["status"] == "ok" else "API returned no data"
            await _record_fetch_log(
                started_at,
                result["status"],
                result["timestamp"],
                snapshot_count=result["snapshot_count"],
                restricted_count=result["restricted_count"],
                error_message=error_message,
            )
            logger.info("Background fetch: %s", result)
        except Exception as e:
            logger.exception("Background fetch failed")
            await _record_fetch_log(
                started_at,
                "error",
                datetime.now(timezone.utc),
                error_message=str(e)[:512],
            )

        await asyncio.sleep(FETCH_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await verify_database_connection()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    await _seed_reward_definitions()

    async with AsyncSessionLocal() as session:
        result = await session.execute(select(FetchLog).where(FetchLog.status == "running"))
        for log in result.scalars().all():
            log.status = "error"
            log.completed_at = datetime.now(timezone.utc)
            log.error_message = "Server restarted before fetch completed"
        await session.commit()

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
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        os.environ.get("FRONTEND_URL", ""),
        "https://guild-raid-tracker.netlify.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"message": "Wynn Guild Raids Tracker"}


@app.get("/health/server")
async def get_health():
    return {"status": "ok"}


@app.get("/health/database")
async def database_health():
    await verify_database_connection()
    return {"database": "connected"}


# ── Auth routes ────────────────────────────────────────────────


@app.post("/api/auth/setup", response_model=DiscordUserOut)
async def auth_setup(body: SetupRequest):
    if not SETUP_SECRET:
        raise HTTPException(
            status_code=500, detail="SETUP_SECRET not configured on server"
        )
    if body.secret != SETUP_SECRET:
        raise HTTPException(status_code=403, detail="Invalid setup secret")

    async with AsyncSessionLocal() as session:
        existing = await session.execute(
            select(DiscordUser).where(DiscordUser.discord_id == body.discord_id)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="User already authorized")

        user = DiscordUser(
            discord_id=body.discord_id,
            username=body.username or body.discord_id,
            is_admin=True,
        )
        session.add(user)
        await session.commit()
        return DiscordUserOut.model_validate(user)


@app.get("/api/auth/discord/login")
async def auth_discord_login():
    state = create_oauth_state()
    return {"url": discord_login_url(state=state)}


@app.get("/api/auth/discord/callback")
async def auth_discord_callback(code: str, state: str | None = None):
    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    if state is None or not consume_oauth_state(state):
        raise HTTPException(
            status_code=403, detail="Invalid OAuth state — possible CSRF"
        )

    token_data = await exchange_code(code)
    if token_data is None or "access_token" not in token_data:
        raise HTTPException(
            status_code=502, detail="Failed to exchange code with Discord"
        )

    discord_user = await get_discord_user(token_data["access_token"])
    if discord_user is None:
        raise HTTPException(status_code=502, detail="Failed to fetch Discord user")

    discord_id = discord_user["id"]
    username = discord_user.get("global_name") or discord_user.get(
        "username", "unknown"
    )
    avatar_hash = discord_user.get("avatar")
    avatar_url = (
        f"https://cdn.discordapp.com/avatars/{discord_id}/{avatar_hash}.png"
        if avatar_hash
        else None
    )

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(DiscordUser).where(DiscordUser.discord_id == discord_id)
        )
        user = result.scalar_one_or_none()

        if user is None:
            if discord_id in AUTHORIZED_DISCORD_IDS:
                user = DiscordUser(
                    discord_id=discord_id,
                    username=username,
                    avatar_url=avatar_url,
                    is_admin=True,
                )
                session.add(user)
            else:
                frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
                return RedirectResponse(
                    url=f"{frontend_url}?error=unauthorized",
                    status_code=303,
                )
        else:
            user.username = username
            user.avatar_url = avatar_url
            user.last_login = datetime.now(timezone.utc)

        await session.commit()

    jwt_token = create_jwt(discord_id, user.token_version)
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173")
    redirect_url = f"{frontend_url.rstrip('/')}/#token={jwt_token}"
    response = RedirectResponse(url=redirect_url, status_code=303)
    set_jwt_cookie(response, jwt_token)
    return response


@app.get("/api/auth/me", response_model=CurrentUserOut)
async def auth_me(current_user: dict = Depends(get_current_user)):
    return CurrentUserOut(**current_user)


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    await revoke_user_token(request)
    delete_jwt_cookie(response)
    return {"message": "Logged out"}


@app.get("/api/auth/users", response_model=list[DiscordUserOut])
async def auth_list_users(admin_user: dict = Depends(get_admin_user)):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(DiscordUser).order_by(DiscordUser.created_at.desc())
        )
        return [DiscordUserOut.model_validate(u) for u in result.scalars().all()]


@app.post("/api/auth/users", response_model=DiscordUserOut)
async def auth_add_user(
    body: DiscordUserCreate, admin_user: dict = Depends(get_admin_user)
):
    async with AsyncSessionLocal() as session:
        existing = await session.execute(
            select(DiscordUser).where(DiscordUser.discord_id == body.discord_id)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="User already exists")

        user = DiscordUser(
            discord_id=body.discord_id,
            username=body.username,
            is_admin=body.is_admin,
        )
        session.add(user)
        await session.commit()
        return DiscordUserOut.model_validate(user)


@app.delete("/api/auth/users/{discord_id}", status_code=204)
async def auth_remove_user(discord_id: str, admin_user: dict = Depends(get_admin_user)):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(DiscordUser).where(DiscordUser.discord_id == discord_id)
        )
        user = result.scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=404, detail="User not found")
        await session.delete(user)
        await session.commit()


# ── Protected API routes ────────────────────────────────────────


@app.post("/api/trigger-fetch", response_model=TriggerResult)
async def trigger_fetch(current_user: dict = Depends(get_current_user)):
    token = os.getenv("WYNN_TOKEN")
    guild_uuid = os.getenv("GUILD_UUID")
    if not token or not guild_uuid:
        raise HTTPException(
            status_code=500, detail="WYNN_TOKEN or GUILD_UUID not configured"
        )

    started_at = datetime.now(timezone.utc)
    try:
        result = await snapshot_guild(token, guild_uuid)
        if result["status"] == "error":
            await _record_fetch_log(
                started_at,
                "error",
                result["timestamp"],
                error_message="API returned no data",
            )
            raise HTTPException(status_code=502, detail="API fetch failed")

        await _record_fetch_log(
            started_at,
            "ok",
            result["timestamp"],
            snapshot_count=result["snapshot_count"],
            restricted_count=result["restricted_count"],
        )

        return TriggerResult(
            status=result["status"],
            snapshot_count=result["snapshot_count"],
            restricted_count=result["restricted_count"],
            timestamp=result["timestamp"],
        )
    except HTTPException:
        raise
    except Exception as e:
        await _record_fetch_log(
            started_at,
            "error",
            datetime.now(timezone.utc),
            error_message=str(e)[:512],
        )
        raise HTTPException(status_code=500, detail=str(e)[:256])


@app.get("/api/members", response_model=list[GuildMemberOut])
async def list_members(
    current_only: bool = True, current_user: dict = Depends(get_current_user)
):
    async with AsyncSessionLocal() as session:
        stmt = select(GuildMember).order_by(GuildMember.rank, GuildMember.username)
        if current_only:
            stmt = stmt.where(GuildMember.is_current_member == True)  # noqa: E712
        result = await session.execute(stmt)
        members = result.scalars().all()
        return [GuildMemberOut.model_validate(m) for m in members]


@app.get("/api/members/{uuid}", response_model=MemberHistoryOut)
async def get_member_history(uuid: str, current_user: dict = Depends(get_current_user)):
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
            snapshots=[
                RaidSnapshotOut.model_validate(s) for s in snapshots.scalars().all()
            ],
        )


@app.get("/api/snapshots", response_model=list[RaidSnapshotOut])
async def list_snapshots(
    member_uuid: str | None = None,
    limit: int = 100,
    offset: int = 0,
    current_user: dict = Depends(get_current_user),
):
    async with AsyncSessionLocal() as session:
        stmt = select(RaidSnapshot).order_by(RaidSnapshot.timestamp.desc())
        if member_uuid:
            stmt = stmt.where(RaidSnapshot.member_uuid == member_uuid)
        stmt = stmt.offset(offset).limit(limit)
        result = await session.execute(stmt)
        return [RaidSnapshotOut.model_validate(s) for s in result.scalars().all()]


@app.get("/api/reward-definitions", response_model=list[RewardDefinitionOut])
async def list_reward_definitions(current_user: dict = Depends(get_current_user)):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(RewardDefinition).order_by(RewardDefinition.sort_order)
        )
        return [RewardDefinitionOut.model_validate(r) for r in result.scalars().all()]


@app.put("/api/reward-definitions/{definition_id}", response_model=RewardDefinitionOut)
async def update_reward_definition(
    definition_id: int,
    body: RewardDefinitionUpdate,
    admin_user: dict = Depends(get_admin_user),
):
    async with AsyncSessionLocal() as session:
        async with session.begin():
            rd = await session.get(RewardDefinition, definition_id)
            if rd is None:
                raise HTTPException(
                    status_code=404, detail="Reward definition not found"
                )

            update_data = body.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                setattr(rd, field, value)

        await session.commit()
        return RewardDefinitionOut.model_validate(rd)


@app.get("/api/rewards/summary", response_model=list[RewardSummaryOut])
async def get_rewards_summary(
    from_: datetime = Query(alias="from"),
    to: datetime = Query(alias="to"),
    member_uuid: str | None = None,
    current_user: dict = Depends(get_current_user),
):
    async with AsyncSessionLocal() as session:
        return await get_reward_summary(session, from_, to, member_uuid)


@app.get("/api/rewards/per-day", response_model=list[RewardDayOut])
async def get_rewards_per_day(
    from_: datetime = Query(alias="from"),
    to: datetime = Query(alias="to"),
    member_uuid: str | None = None,
    current_user: dict = Depends(get_current_user),
):
    async with AsyncSessionLocal() as session:
        return await get_reward_per_day(session, from_, to, member_uuid)


@app.post("/api/rewards/payout", response_model=list[PayoutChunkOut])
async def create_reward_payout(body: PayoutCreate, admin_user: dict = Depends(get_admin_user)):
    async with AsyncSessionLocal() as session:
        try:
            return await process_payout(
                session,
                body.starts_at,
                body.ends_at,
                [item.model_dump() for item in body.items],
                paid_by_discord_id=admin_user["discord_id"],
                paid_by_username=admin_user["username"],
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/payouts", response_model=list[PayoutRecordOut])
async def get_payouts(current_user: dict = Depends(get_current_user)):
    async with AsyncSessionLocal() as session:
        return await list_payouts(session)


@app.post("/api/payouts/{payout_id}/void", response_model=VoidPayoutResult)
async def void_payout(payout_id: int, admin_user: dict = Depends(get_admin_user)):
    async with AsyncSessionLocal() as session:
        record = await session.get(PayoutRecord, payout_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Payout record not found")
        await session.delete(record)
        await session.commit()
        return VoidPayoutResult(payout_id=payout_id, status="voided")


@app.get("/api/status", response_model=ServerStatus)
async def get_status(current_user: dict = Depends(get_current_user)):
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
