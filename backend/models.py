from datetime import date, datetime, timezone

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, String, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class GuildMember(Base):
    __tablename__ = "guild_members"

    uuid: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    rank: Mapped[str] = mapped_column(String(32), nullable=False)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)
    is_current_member: Mapped[bool] = mapped_column(Boolean, default=True)

    snapshots: Mapped[list["RaidSnapshot"]] = relationship(back_populates="member", cascade="all, delete-orphan")
    completions: Mapped[list["DetectedCompletion"]] = relationship(back_populates="member", cascade="all, delete-orphan")


class RaidSnapshot(Base):
    __tablename__ = "raid_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    member_uuid: Mapped[str] = mapped_column(ForeignKey("guild_members.uuid"), nullable=False, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, index=True)

    total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notg: Mapped[int | None] = mapped_column(Integer, nullable=True)
    nol: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tcc: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tna: Mapped[int | None] = mapped_column(Integer, nullable=True)
    wtp: Mapped[int | None] = mapped_column(Integer, nullable=True)

    access_restricted: Mapped[bool] = mapped_column(Boolean, default=False)
    was_member: Mapped[bool] = mapped_column(Boolean, default=True)

    member: Mapped["GuildMember"] = relationship(back_populates="snapshots")


class RewardDefinition(Base):
    __tablename__ = "reward_definitions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    raid_type: Mapped[str] = mapped_column(String(10), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(64), nullable=False)
    daily_cap: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class CycleConfig(Base):
    """Single-row table holding the cycle schedule the app derives cycles from."""

    __tablename__ = "cycle_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    anchor: Mapped[date] = mapped_column(Date, nullable=False)
    cycle_0_days: Mapped[int] = mapped_column(Integer, nullable=False)
    schedule: Mapped[list[int]] = mapped_column(JSON, nullable=False)
    payout_window_days: Mapped[int] = mapped_column(Integer, nullable=False)


class DetectedCompletion(Base):
    __tablename__ = "detected_completions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    member_uuid: Mapped[str] = mapped_column(ForeignKey("guild_members.uuid"), nullable=False, index=True)
    raid_type: Mapped[str] = mapped_column(String(10), nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False)
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, index=True)
    start_snapshot_id: Mapped[int | None] = mapped_column(ForeignKey("raid_snapshots.id"), nullable=True)
    end_snapshot_id: Mapped[int | None] = mapped_column(ForeignKey("raid_snapshots.id"), nullable=True)

    member: Mapped["GuildMember"] = relationship(back_populates="completions")


class DiscordUser(Base):
    __tablename__ = "discord_users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    discord_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(String(256), nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    token_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_login: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, onupdate=_utcnow)


class FetchLog(Base):
    __tablename__ = "fetch_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    snapshot_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    restricted_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(512), nullable=True)


class PayoutRecord(Base):
    __tablename__ = "payout_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    member_uuid: Mapped[str] = mapped_column(ForeignKey("guild_members.uuid"), nullable=False, index=True)
    raid_type: Mapped[str] = mapped_column(String(10), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    count_paid: Mapped[int] = mapped_column(Integer, nullable=False)
    paid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    paid_by_discord_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    paid_by_username: Mapped[str | None] = mapped_column(String(64), nullable=True)
