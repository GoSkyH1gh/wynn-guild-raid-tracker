import logging
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .database import AsyncSessionLocal
from .models import GuildMember, RaidSnapshot, DetectedCompletion, FetchLog, PayoutRecord, RewardDefinition

logger = logging.getLogger(__name__)

BASE_WYNN_URL = "https://api.wynncraft.com/v3/guild/uuid/"
GUILD_RANKS = ["owner", "chief", "strategist", "captain", "recruiter", "recruit"]

RAID_TYPES = ["notg", "nol", "tcc", "tna", "wtp"]

# Ranks that earn payouts. Everyone else is tracked but never paid.
REWARD_RANKS = {"recruit", "recruiter", "captain"}

CAP_DAY_OFFSET_MINUTES = int(os.getenv("CAP_DAY_OFFSET_MINUTES", "0"))


def day_bucket(ts: datetime) -> date:
    """Bucket a detection timestamp into a payout day, shifted by the configured offset."""
    return (ts + timedelta(minutes=CAP_DAY_OFFSET_MINUTES)).date()


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

    return {
        "status": "ok",
        "snapshot_count": snapshot_count,
        "restricted_count": restricted_count,
        "timestamp": now,
    }


async def _record_fetch_log(
    started_at: datetime,
    status: str,
    completed_at: datetime,
    snapshot_count: int | None = None,
    restricted_count: int | None = None,
    error_message: str | None = None,
):
    async with AsyncSessionLocal() as session:
        log = FetchLog(
            started_at=started_at,
            completed_at=completed_at,
            status=status,
            snapshot_count=snapshot_count,
            restricted_count=restricted_count,
            error_message=error_message,
        )
        session.add(log)
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
            or_(
                RaidSnapshot.total != 0,
                RaidSnapshot.notg != 0,
                RaidSnapshot.nol != 0,
                RaidSnapshot.tcc != 0,
                RaidSnapshot.tna != 0,
                RaidSnapshot.wtp != 0,
            ),
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


# ── Reward / payout logic ───────────────────────────────────────


async def get_reward_summary(
    session: AsyncSession,
    starts_at: datetime,
    ends_at: datetime,
    member_uuid: str | None = None,
) -> list[dict[str, Any]]:
    """Per (member, raid) payables/paid/pending in a range, after rank gate + daily cap."""
    rows = await _reward_rows(session, starts_at, ends_at, member_uuid)

    members = {
        m.uuid: m
        for m in await _load_members(session, {r["member_uuid"] for r in rows} | ({member_uuid} if member_uuid else set()))
    }
    defs = await _load_reward_defs(session)

    out: dict[tuple[str, str], dict] = {}
    for row in rows:
        member = members.get(row["member_uuid"])
        if member is None:
            continue
        cap = defs.get(row["raid_type"], {}).get("cap")
        key = (row["member_uuid"], row["raid_type"])
        entry = out.setdefault(
            key,
            {
                "member_uuid": row["member_uuid"],
                "username": member.username,
                "rank": member.rank,
                "is_eligible": member.rank in REWARD_RANKS,
                "raid_type": row["raid_type"],
                "days": 0,
                "detected": 0,
                "payable": 0,
                "paid": 0,
                "pending": 0,
                "daily_cap": cap,
            },
        )
        entry["days"] += 1
        entry["detected"] += row["detected"]
        entry["payable"] += row["payable"]
        entry["paid"] += row["paid"]
        entry["pending"] += row["pending"]

    result = list(out.values())
    result.sort(key=lambda x: (x["member_uuid"], x["raid_type"]))
    return result


async def get_reward_per_day(
    session: AsyncSession,
    starts_at: datetime,
    ends_at: datetime,
    member_uuid: str | None = None,
) -> list[dict[str, Any]]:
    """Per (member, raid, day) breakdown. Returns list of {day, entries: [...]}."""
    rows = await _reward_rows(session, starts_at, ends_at, member_uuid)

    seen = {r["member_uuid"] for r in rows}
    members = {m.uuid: m for m in await _load_members(session, seen | ({member_uuid} if member_uuid else set()))}
    defs = await _load_reward_defs(session)

    by_day: dict[date, list[dict]] = {}
    for row in rows:
        member = members.get(row["member_uuid"])
        cap = defs.get(row["raid_type"], {}).get("cap")
        day_entry = {
            "member_uuid": row["member_uuid"],
            "username": member.username if member else "unknown",
            "rank": member.rank if member else "",
            "is_eligible": (member.rank in REWARD_RANKS) if member else False,
            "raid_type": row["raid_type"],
            "daily_cap": cap,
            "detected": row["detected"],
            "payable": row["payable"],
            "paid": row["paid"],
            "pending": row["pending"],
            "over_cap": max(0, row["detected"] - row["payable"]),
        }
        by_day.setdefault(row["day"], []).append(day_entry)

    result = [
        {"day": day.isoformat(), "entries": sorted(by_day[day], key=lambda e: (e["username"], e["raid_type"]))}
        for day in sorted(by_day)
    ]
    return result


async def _reward_rows(
    session: AsyncSession,
    starts_at: datetime,
    ends_at: datetime,
    member_uuid: str | None = None,
) -> list[dict[str, Any]]:
    """Raw per (member, raid, day) rows with detected/payable/paid/pending after cap."""
    defs = await _load_reward_defs(session)

    # detected completions grouped by (member, raid, day)
    detected_completion_stmt = (
        select(
            DetectedCompletion.member_uuid,
            DetectedCompletion.raid_type,
            DetectedCompletion.detected_at,
            DetectedCompletion.count,
        )
        .where(
            DetectedCompletion.detected_at >= starts_at,
            DetectedCompletion.detected_at <= ends_at,
        )
    )
    if member_uuid:
        detected_completion_stmt = detected_completion_stmt.where(
            DetectedCompletion.member_uuid == member_uuid
        )
    completions = (await session.execute(detected_completion_stmt)).all()

    # already-paid chunks keyed by the day they apply to (the payout day bucket,
    # not paid_at — a payout recorded now can cover days inside the range)
    paid_stmt = (select(PayoutRecord)).where(
        PayoutRecord.day >= day_bucket(starts_at),
        PayoutRecord.day <= day_bucket(ends_at),
    )
    if member_uuid:
        paid_stmt = paid_stmt.where(PayoutRecord.member_uuid == member_uuid)
    paid_rows = (await session.execute(paid_stmt)).scalars().all()

    earnable: dict[tuple[str, str, date], int] = {}
    paid: dict[tuple[str, str, date], int] = {}

    for dc in completions:
        day = day_bucket(dc.detected_at)
        key = (dc.member_uuid, dc.raid_type, day)
        earnable[key] = earnable.get(key, 0) + dc.count

    for pr in paid_rows:
        key = (pr.member_uuid, pr.raid_type, pr.day)
        paid[key] = paid.get(key, 0) + pr.count_paid

    members = {m.uuid: m for m in await _load_members(session, {k[0] for k in earnable} | {k[0] for k in paid})}
    ranks = {uuid: members[uuid].rank for uuid in members}

    rows: list[dict[str, Any]] = []
    for (uuid, raid_type, day), detected in earnable.items():
        cap = defs.get(raid_type, {}).get("cap")
        is_eligible = ranks.get(uuid, "") in REWARD_RANKS

        earned_visible = detected if is_eligible else 0
        payable = min(earned_visible, cap) if cap is not None else earned_visible
        paid_count = paid.get((uuid, raid_type, day), 0)

        rows.append(
            {
                "member_uuid": uuid,
                "raid_type": raid_type,
                "day": day,
                "detected": detected,
                "payable": payable,
                "paid": paid_count,
                "pending": max(0, payable - paid_count),
            }
        )
    return rows


async def _load_members(session: AsyncSession, uuids: set[str]) -> list[GuildMember]:
    if not uuids:
        return []
    result = await session.execute(select(GuildMember).where(GuildMember.uuid.in_(uuids)))
    return result.scalars().all()


async def _load_reward_defs(session: AsyncSession) -> dict[str, dict]:
    result = await session.execute(select(RewardDefinition))
    defs = {}
    for d in result.scalars().all():
        defs[d.raid_type] = {
            "cap": d.daily_cap,
        }
    return defs


async def process_payout(
    session: AsyncSession,
    starts_at: datetime,
    ends_at: datetime,
    items: list[dict[str, Any]],
    paid_by_discord_id: str | None = None,
    paid_by_username: str | None = None,
) -> list[dict[str, Any]]:
    """Pay out capped amounts. Items: [{member_uuid, raid_type, count}].

    Created payout chunks: per (member, raid, day).
    """
    rows = await _reward_rows(session, starts_at, ends_at)
    defs = await _load_reward_defs(session)

    chunks: list[PayoutRecord] = []
    for item in items:
        member_uuid = item["member_uuid"]
        raid_type = item["raid_type"]
        count_to_pay = int(item["count"])
        if count_to_pay <= 0:
            continue

        member = await session.get(GuildMember, member_uuid)
        if member is None or member.rank not in REWARD_RANKS:
            raise ValueError(f"{member.username if member else member_uuid} is not payout-eligible")

        # available payout per (raid, day) within range
        available: dict[date, int] = {}
        for row in rows:
            if row["member_uuid"] == member_uuid and row["raid_type"] == raid_type:
                if row["pending"] > 0:
                    available[row["day"]] = row["pending"]

        # iterate days oldest first, pay as many as possible up to limit
        for day in sorted(available):
            if count_to_pay <= 0:
                break
            take = min(count_to_pay, available[day])
            # 1 rune per completion
            pr = PayoutRecord(
                member_uuid=member_uuid,
                raid_type=raid_type,
                day=day,
                count_paid=take,
                paid_by_discord_id=paid_by_discord_id,
                paid_by_username=paid_by_username,
            )
            session.add(pr)
            chunks.append(pr)
            count_to_pay -= take

        if count_to_pay > 0:
            logger.warning(
                "Could only pay part of %s %s for %s (unpaid %d)",
                raid_type,
                member_uuid,
                item["count"],
                count_to_pay,
            )

    await session.commit()
    return [{"day": c.day.isoformat(), "member_uuid": c.member_uuid, "raid_type": c.raid_type, "count_paid": c.count_paid} for c in chunks]


async def list_payouts(
    session: AsyncSession,
) -> list[dict[str, Any]]:
    result = await session.execute(
        select(PayoutRecord, GuildMember.username)
        .outerjoin(GuildMember, GuildMember.uuid == PayoutRecord.member_uuid)
        .order_by(PayoutRecord.paid_at.desc())
    )
    rows = result.all()
    return [
        {
            "id": p.id,
            "member_uuid": p.member_uuid,
            "member_username": username or p.member_uuid,
            "raid_type": p.raid_type,
            "day": p.day.isoformat(),
            "count_paid": p.count_paid,
            "paid_at": p.paid_at,
            "paid_by_discord_id": p.paid_by_discord_id,
            "paid_by_username": p.paid_by_username,
        }
        for p, username in rows
    ]
