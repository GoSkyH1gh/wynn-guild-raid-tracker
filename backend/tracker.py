import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .database import AsyncSessionLocal
from .models import GuildMember, RaidSnapshot, TrackingPeriod, RewardEligibility

logger = logging.getLogger(__name__)

BASE_WYNN_URL = "https://api.wynncraft.com/v3/guild/uuid/"
GUILD_RANKS = ["owner", "chief", "strategist", "captain", "recruiter", "recruit"]

async def fetch_guild_data(token: str, guild_uuid: str) -> dict | None:
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(f"{BASE_WYNN_URL}{guild_uuid}", headers=headers, timeout=30)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            logger.error("API returned %s: %s", e.response.status_code, e.response.text[:500])
            return None
        except httpx.RequestError as e:
            logger.error("Request failed: %s", e)
            return None


async def snapshot_guild(token: str, guild_uuid: str) -> dict:
    now = datetime.now(timezone.utc)
    data = await fetch_guild_data(token, guild_uuid)
    if data is None:
        return {"status": "error", "snapshot_count": 0, "restricted_count": 0, "timestamp": now}

    members_raw = data.get("members", {})
    seen_uuids: set[str] = set()

    restricted_count = 0
    snapshot_count = 0

    async with AsyncSessionLocal() as session:
        async with session.begin():
            for rank in GUILD_RANKS:
                rank_members = members_raw.get(rank, {})
                for username, member_data in rank_members.items():
                    uuid: str = member_data.get("uuid")
                    if not uuid:
                        continue
                    seen_uuids.add(uuid)

                    restrictions = member_data.get("restrictions", {})
                    is_restricted = restrictions.get("main_access", False)

                    await _upsert_member(session, uuid, username, rank, now)

                    if is_restricted:
                        restricted_count += 1
                        _create_snapshot(session, uuid, now, restricted=True)
                    else:
                        global_data = member_data.get("globalData", {})
                        guild_raids = global_data.get("currentGuildRaids", {})
                        _create_snapshot(session, uuid, now, restricted=False, data=guild_raids)

                    snapshot_count += 1

            former_members = await _handle_departed_members(session, seen_uuids, now)
            snapshot_count += former_members

        await session.commit()

    return {
        "status": "ok",
        "snapshot_count": snapshot_count,
        "restricted_count": restricted_count,
        "timestamp": now,
    }


async def _upsert_member(session: AsyncSession, uuid: str, username: str, rank: str, now: datetime):
    existing = await session.get(GuildMember, uuid)
    if existing is None:
        session.add(
            GuildMember(
                uuid=uuid,
                username=username,
                rank=rank,
                first_seen=now,
                last_seen=now,
                is_current_member=True,
            )
        )
    else:
        changed = False
        if existing.username != username:
            existing.username = username
            changed = True
        if existing.rank != rank:
            existing.rank = rank
            changed = True
        if not existing.is_current_member:
            existing.is_current_member = True
            changed = True
        if changed:
            existing.last_seen = now


def _create_snapshot(
    session: AsyncSession,
    member_uuid: str,
    timestamp: datetime,
    *,
    restricted: bool,
    data: dict | None = None,
    was_member: bool = True,
):
    if restricted or data is None:
        snapshot = RaidSnapshot(
            member_uuid=member_uuid,
            timestamp=timestamp,
            total=None,
            notg=None,
            nol=None,
            tcc=None,
            tna=None,
            wtp=None,
            access_restricted=True,
            was_member=was_member,
        )
    else:
        raid_list = data.get("list", {}) if isinstance(data, dict) else {}
        snapshot = RaidSnapshot(
            member_uuid=member_uuid,
            timestamp=timestamp,
            total=data.get("total"),
            notg=raid_list.get("Nest of the Grootslangs"),
            nol=raid_list.get("Orphion's Nexus of Light"),
            tcc=raid_list.get("The Canyon Colossus"),
            tna=raid_list.get("The Nameless Anomaly"),
            wtp=raid_list.get("The Wartorn Palace"),
            access_restricted=False,
            was_member=was_member,
        )
    session.add(snapshot)


async def _handle_departed_members(session: AsyncSession, current_uuids: set[str], now: datetime) -> int:
    result = await session.execute(
        select(GuildMember).where(GuildMember.is_current_member == True)  # noqa: E712
    )
    current_members = result.scalars().all()

    count = 0
    for member in current_members:
        if member.uuid not in current_uuids:
            member.is_current_member = False
            member.last_seen = now
            _create_snapshot(session, member.uuid, now, restricted=True, was_member=False)
            count += 1

    return count


async def calculate_period_rewards(period_id: int) -> list[RewardEligibility]:
    async with AsyncSessionLocal() as session:
        async with session.begin():
            period = await session.get(TrackingPeriod, period_id)
            if period is None:
                raise ValueError(f"TrackingPeriod {period_id} not found")

            start = period.starts_at
            end = period.ends_at

            members_in_period = await _find_members_in_period(session, start, end)

            existing = await session.execute(
                select(RewardEligibility).where(RewardEligibility.period_id == period_id)
            )
            for row in existing.scalars():
                await session.delete(row)

            eligibilities: list[RewardEligibility] = []
            for member_uuid in members_in_period:
                eligibility = await _calculate_member_eligibility(session, period_id, member_uuid, start, end)
                session.add(eligibility)
                eligibilities.append(eligibility)

        await session.commit()
        return eligibilities


async def _find_members_in_period(session: AsyncSession, start: datetime, end: datetime | None) -> set[str]:
    stmt = select(RaidSnapshot.member_uuid).where(
        RaidSnapshot.timestamp >= start,
    )
    if end:
        stmt = stmt.where(RaidSnapshot.timestamp <= end)

    result = await session.execute(stmt)
    return {row[0] for row in result.unique().all()}


async def _nearest_snapshot(
    session: AsyncSession, member_uuid: str, target_time: datetime, *, before: bool = True
) -> RaidSnapshot | None:
    if before:
        stmt = (
            select(RaidSnapshot)
            .where(
                RaidSnapshot.member_uuid == member_uuid,
                RaidSnapshot.timestamp <= target_time,
                RaidSnapshot.was_member == True,  # noqa: E712
            )
            .order_by(RaidSnapshot.timestamp.desc())
            .limit(1)
        )
    else:
        stmt = (
            select(RaidSnapshot)
            .where(
                RaidSnapshot.member_uuid == member_uuid,
                RaidSnapshot.timestamp >= target_time,
                RaidSnapshot.was_member == True,  # noqa: E712
            )
            .order_by(RaidSnapshot.timestamp.asc())
            .limit(1)
        )

    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def _calculate_member_eligibility(
    session: AsyncSession,
    period_id: int,
    member_uuid: str,
    start: datetime,
    end: datetime | None,
) -> RewardEligibility:
    start_snap = await _nearest_snapshot(session, member_uuid, start, before=True)
    end_snap = await _nearest_snapshot(session, member_uuid, end, before=False) if end else None

    start_id = start_snap.id if start_snap else None
    end_id = end_snap.id if end_snap else None

    if start_snap is None and end_snap is None:
        return RewardEligibility(
            period_id=period_id,
            member_uuid=member_uuid,
            eligibility_status="insufficient_data",
            notes="No snapshots found in or around this period.",
        )

    if start_snap is None:
        end_snap_latest = (
            await session.execute(
                select(RaidSnapshot)
                .where(
                    RaidSnapshot.member_uuid == member_uuid,
                    RaidSnapshot.was_member == True,  # noqa: E712
                )
                .order_by(RaidSnapshot.timestamp.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

        end_id = end_snap_latest.id if end_snap_latest else None
        return RewardEligibility(
            period_id=period_id,
            member_uuid=member_uuid,
            start_snapshot_id=start_id,
            end_snapshot_id=end_id,
            eligibility_status="not_yet_in_guild",
            notes="No snapshot exists before the period start. Member likely joined after period began.",
        )

    if end_snap is None:
        start_earliest = (
            await session.execute(
                select(RaidSnapshot)
                .where(
                    RaidSnapshot.member_uuid == member_uuid,
                    RaidSnapshot.was_member == True,  # noqa: E712
                )
                .order_by(RaidSnapshot.timestamp.asc())
                .limit(1)
            )
        ).scalar_one_or_none()

        start_id = start_earliest.id if start_earliest else start_id
        return RewardEligibility(
            period_id=period_id,
            member_uuid=member_uuid,
            start_snapshot_id=start_id,
            end_snapshot_id=end_id,
            eligibility_status="left_guild",
            notes="No snapshot exists at or after period end. Member likely left during the period.",
        )

    if start_snap.access_restricted and end_snap.access_restricted:
        return RewardEligibility(
            period_id=period_id,
            member_uuid=member_uuid,
            start_snapshot_id=start_id,
            end_snapshot_id=end_id,
            eligibility_status="restricted_both",
            notes="API data restricted at both start and end of period. Unable to calculate progress.",
        )

    if start_snap.access_restricted:
        return RewardEligibility(
            period_id=period_id,
            member_uuid=member_uuid,
            start_snapshot_id=start_id,
            end_snapshot_id=end_id,
            eligibility_status="restricted_start",
            notes="API data restricted at period start. Cannot determine baseline.",
        )

    if end_snap.access_restricted:
        return RewardEligibility(
            period_id=period_id,
            member_uuid=member_uuid,
            start_snapshot_id=start_id,
            end_snapshot_id=end_id,
            eligibility_status="restricted_end",
            notes="API data restricted at period end. Cannot determine final count.",
        )

    if start_snap.total is None or end_snap.total is None:
        return RewardEligibility(
            period_id=period_id,
            member_uuid=member_uuid,
            start_snapshot_id=start_id,
            end_snapshot_id=end_id,
            eligibility_status="insufficient_data",
            notes="Raid count data missing in one or both snapshots.",
        )

    total_progress = end_snap.total - start_snap.total
    notg_prog = _safe_sub(end_snap.notg, start_snap.notg)
    nol_prog = _safe_sub(end_snap.nol, start_snap.nol)
    tcc_prog = _safe_sub(end_snap.tcc, start_snap.tcc)
    tna_prog = _safe_sub(end_snap.tna, start_snap.tna)
    wtp_prog = _safe_sub(end_snap.wtp, start_snap.wtp)

    if total_progress < 0:
        total_progress = 0

    return RewardEligibility(
        period_id=period_id,
        member_uuid=member_uuid,
        start_snapshot_id=start_id,
        end_snapshot_id=end_id,
        total_progress=total_progress,
        notg_progress=notg_prog,
        nol_progress=nol_prog,
        tcc_progress=tcc_prog,
        tna_progress=tna_prog,
        wtp_progress=wtp_prog,
        eligibility_status="eligible",
        notes=None,
    )


def _safe_sub(a: int | None, b: int | None) -> int | None:
    if a is None or b is None:
        return None
    return max(0, a - b)
