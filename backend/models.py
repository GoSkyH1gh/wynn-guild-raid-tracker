from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
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
    payout_items: Mapped[list["PayoutItem"]] = relationship(back_populates="member", cascade="all, delete-orphan")


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
    reward_amount: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reward_label: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    daily_cap: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


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
    payout_items: Mapped[list["PayoutItem"]] = relationship(back_populates="completion", cascade="all, delete-orphan")


class PayoutEvent(Base):
    __tablename__ = "payout_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    label: Mapped[str | None] = mapped_column(String(256), nullable=True)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    status: Mapped[str] = mapped_column(String(16), default="completed")
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    paid_by_discord_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    paid_by_username: Mapped[str | None] = mapped_column(String(64), nullable=True)

    items: Mapped[list["PayoutItem"]] = relationship(back_populates="event", cascade="all, delete-orphan")


class DiscordUser(Base):
    __tablename__ = "discord_users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    discord_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(String(256), nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
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


class PayoutItem(Base):
    __tablename__ = "payout_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    payout_event_id: Mapped[int] = mapped_column(ForeignKey("payout_events.id"), nullable=False, index=True)
    detected_completion_id: Mapped[int] = mapped_column(ForeignKey("detected_completions.id"), nullable=False, index=True)
    member_uuid: Mapped[str] = mapped_column(ForeignKey("guild_members.uuid"), nullable=False, index=True)
    raid_type: Mapped[str] = mapped_column(String(10), nullable=False)
    count_paid: Mapped[int] = mapped_column(Integer, nullable=False)
    reward_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    rewarded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    event: Mapped["PayoutEvent"] = relationship(back_populates="items")
    completion: Mapped["DetectedCompletion"] = relationship(back_populates="payout_items")
    member: Mapped["GuildMember"] = relationship(back_populates="payout_items")

    @property
    def member_username(self) -> str | None:
        return self.member.username if self.member else None
