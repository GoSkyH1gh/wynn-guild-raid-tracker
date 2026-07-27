from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String, Text
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
    reward_eligibilities: Mapped[list["RewardEligibility"]] = relationship(back_populates="member", cascade="all, delete-orphan")


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


class TrackingPeriod(Base):
    __tablename__ = "tracking_periods"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    reward_eligibilities: Mapped[list["RewardEligibility"]] = relationship(back_populates="period", cascade="all, delete-orphan")


class RewardEligibility(Base):
    __tablename__ = "reward_eligibility"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    period_id: Mapped[int] = mapped_column(ForeignKey("tracking_periods.id"), nullable=False)
    member_uuid: Mapped[str] = mapped_column(ForeignKey("guild_members.uuid"), nullable=False)

    start_snapshot_id: Mapped[int | None] = mapped_column(ForeignKey("raid_snapshots.id"), nullable=True)
    end_snapshot_id: Mapped[int | None] = mapped_column(ForeignKey("raid_snapshots.id"), nullable=True)

    total_progress: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notg_progress: Mapped[int | None] = mapped_column(Integer, nullable=True)
    nol_progress: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tcc_progress: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tna_progress: Mapped[int | None] = mapped_column(Integer, nullable=True)
    wtp_progress: Mapped[int | None] = mapped_column(Integer, nullable=True)

    eligibility_status: Mapped[str] = mapped_column(
        Enum(
            "eligible",
            "partially_restricted",
            "restricted_start",
            "restricted_end",
            "restricted_both",
            "insufficient_data",
            "not_yet_in_guild",
            "left_guild",
            name="eligibility_status",
        ),
        nullable=False,
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    rewarded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    period: Mapped["TrackingPeriod"] = relationship(back_populates="reward_eligibilities")
    member: Mapped["GuildMember"] = relationship(back_populates="reward_eligibilities")
