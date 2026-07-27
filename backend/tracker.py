import logging
from datetime import datetime, timezone

import httpx
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from .database import AsyncSessionLocal
from .models import GuildMember, RaidSnapshot, DetectedCompletion, PayoutEvent, PayoutItem, RewardDefinition, FetchLog

logger = logging.getLogger(__name__)

BASE_WYNN_URL = "https://api.wynncraft.com/v3/guild/uuid/"
GUILD_RANKS = ["owner", "chief", "strategist", "captain", "recruiter", "recruit"]

RAID_TYPES = ["notg", "nol", "tcc", "tna", "wtp"]


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


async def snapshot_guild(token: str, guild_uuid: str, fetch_log_id: int | None = None) -> dict:
    now = datetime.now(timezone.utc)
    data = await fetch_guild_data(token, guild_uuid)
    if data is None:
        await _update_fetch_log(fetch_log_id, "error", now, error_message="API returned no data")
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
                        snapshot = _create_snapshot(session, uuid, now, restricted=True)
                    else:
                        global_data = member_data.get("globalData", {})
                        guild_raids = global_data.get("currentGuildRaids", {})
                        snapshot = _create_snapshot(session, uuid, now, restricted=False, data=guild_raids)

                    await session.flush()

                    if not is_restricted:
                        await _detect_completions(session, uuid, snapshot.id, now)

                    snapshot_count += 1

            former_members = await _handle_departed_members(session, seen_uuids, now)
            snapshot_count += former_members

        await session.commit()

    await _update_fetch_log(fetch_log_id, "ok", now, snapshot_count, restricted_count)

    return {
        "status": "ok",
        "snapshot_count": snapshot_count,
        "restricted_count": restricted_count,
        "timestamp": now,
    }


async def _update_fetch_log(
    log_id: int | None,
    status: str,
    completed_at: datetime,
    snapshot_count: int | None = None,
    restricted_count: int | None = None,
    error_message: str | None = None,
):
    if log_id is None:
        return
    async with AsyncSessionLocal() as session:
        log = await session.get(FetchLog, log_id)
        if log:
            log.completed_at = completed_at
            log.status = status
            if snapshot_count is not None:
                log.snapshot_count = snapshot_count
            if restricted_count is not None:
                log.restricted_count = restricted_count
            if error_message:
                log.error_message = error_message
            await session.commit()


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
) -> RaidSnapshot:
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
    return snapshot


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


async def _detect_completions(session: AsyncSession, member_uuid: str, new_snapshot_id: int, detected_at: datetime):
    prev_result = await session.execute(
        select(RaidSnapshot)
        .where(
            RaidSnapshot.member_uuid == member_uuid,
            RaidSnapshot.id < new_snapshot_id,
            RaidSnapshot.access_restricted == False,  # noqa: E712
            RaidSnapshot.was_member == True,  # noqa: E712
        )
        .order_by(RaidSnapshot.timestamp.desc())
        .limit(1)
    )
    prev_snapshot = prev_result.scalar_one_or_none()
    if prev_snapshot is None:
        return

    new_snapshot_result = await session.execute(
        select(RaidSnapshot).where(RaidSnapshot.id == new_snapshot_id)
    )
    new_snapshot = new_snapshot_result.scalar_one()
    if new_snapshot.access_restricted:
        return

    for raid_type in RAID_TYPES:
        old_val = getattr(prev_snapshot, raid_type)
        new_val = getattr(new_snapshot, raid_type)

        if old_val is not None and new_val is not None and new_val > old_val:
            diff = new_val - old_val
            completion = DetectedCompletion(
                member_uuid=member_uuid,
                raid_type=raid_type,
                count=diff,
                detected_at=detected_at,
                start_snapshot_id=prev_snapshot.id,
                end_snapshot_id=new_snapshot_id,
            )
            session.add(completion)


async def _get_pending_completions(
    session: AsyncSession,
    starts_at: datetime,
    ends_at: datetime,
    member_uuid: str | None = None,
) -> list[dict]:
    total_paid_subq = (
        select(
            PayoutItem.detected_completion_id,
            func.coalesce(func.sum(PayoutItem.count_paid), 0).label("total_paid"),
        )
        .group_by(PayoutItem.detected_completion_id)
        .subquery()
    )

    stmt = (
        select(
            DetectedCompletion,
            func.coalesce(total_paid_subq.c.total_paid, 0).label("paid_sofar"),
        )
        .outerjoin(total_paid_subq, DetectedCompletion.id == total_paid_subq.c.detected_completion_id)
        .where(
            DetectedCompletion.detected_at >= starts_at,
            DetectedCompletion.detected_at <= ends_at,
        )
    )

    if member_uuid:
        stmt = stmt.where(DetectedCompletion.member_uuid == member_uuid)

    result = await session.execute(stmt)
    rows = result.all()

    pending: list[dict] = []
    for dc, paid_sofar in rows:
        remaining = dc.count - paid_sofar
        if remaining > 0:
            pending.append({
                "completion": dc,
                "remaining": remaining,
            })

    return pending


async def _aggregate_pending(
    session: AsyncSession,
    starts_at: datetime,
    ends_at: datetime,
    member_uuid: str | None = None,
) -> list[dict]:
    pending = await _get_pending_completions(session, starts_at, ends_at, member_uuid)

    member_cache: dict[str, str] = {}
    agg: dict[tuple[str, str], dict] = {}

    for entry in pending:
        dc = entry["completion"]
        key = (dc.member_uuid, dc.raid_type)

        if key not in agg:
            if dc.member_uuid not in member_cache:
                member = await session.get(GuildMember, dc.member_uuid)
                member_cache[dc.member_uuid] = member.username if member else "unknown"

            agg[key] = {
                "member_uuid": dc.member_uuid,
                "username": member_cache[dc.member_uuid],
                "raid_type": dc.raid_type,
                "count_pending": 0,
                "earliest_detected": dc.detected_at,
                "latest_detected": dc.detected_at,
            }

        agg[key]["count_pending"] += entry["remaining"]
        if dc.detected_at < agg[key]["earliest_detected"]:
            agg[key]["earliest_detected"] = dc.detected_at
        if dc.detected_at > agg[key]["latest_detected"]:
            agg[key]["latest_detected"] = dc.detected_at

    return sorted(agg.values(), key=lambda x: (x["username"], x["raid_type"]))


async def process_payout(
    starts_at: datetime,
    ends_at: datetime,
    items: list[dict],
    label: str | None = None,
) -> PayoutEvent:
    async with AsyncSessionLocal() as session:
        async with session.begin():
            payout_event = PayoutEvent(
                label=label,
                starts_at=starts_at,
                ends_at=ends_at,
            )
            session.add(payout_event)
            await session.flush()

            for item in items:
                member_uuid = item["member_uuid"]
                raid_type = item["raid_type"]
                count_to_pay = item["count"]

                if count_to_pay <= 0:
                    continue

                pending = await _get_pending_completions(
                    session, starts_at, ends_at, member_uuid=member_uuid
                )

                matching = [p for p in pending if p["completion"].raid_type == raid_type]
                matching.sort(key=lambda p: p["completion"].detected_at)

                still_needed = count_to_pay
                for entry in matching:
                    if still_needed <= 0:
                        break

                    dc = entry["completion"]
                    take = min(still_needed, entry["remaining"])

                    reward_def_result = await session.execute(
                        select(RewardDefinition).where(
                            RewardDefinition.raid_type == raid_type,
                            RewardDefinition.is_active == True,  # noqa: E712
                        )
                    )
                    reward_def = reward_def_result.scalar_one_or_none()
                    unit_amount = reward_def.reward_amount if reward_def else 0

                    payout_item = PayoutItem(
                        payout_event_id=payout_event.id,
                        detected_completion_id=dc.id,
                        member_uuid=member_uuid,
                        raid_type=raid_type,
                        count_paid=take,
                        reward_amount=take * unit_amount,
                    )
                    session.add(payout_item)
                    still_needed -= take

                if still_needed > 0:
                    logger.warning(
                        "Could only pay %d/%d of %s %s for %s",
                        count_to_pay - still_needed,
                        count_to_pay,
                        raid_type,
                        member_uuid,
                    )

        await session.commit()

        payout_with_items = await session.get(PayoutEvent, payout_event.id)
        return payout_with_items
