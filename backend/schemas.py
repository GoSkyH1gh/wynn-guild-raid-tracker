from datetime import datetime

from pydantic import BaseModel, ConfigDict


class GuildMemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    uuid: str
    username: str
    rank: str
    first_seen: datetime
    last_seen: datetime
    is_current_member: bool


class RaidSnapshotOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    member_uuid: str
    timestamp: datetime
    total: int | None
    notg: int | None
    nol: int | None
    tcc: int | None
    tna: int | None
    wtp: int | None
    access_restricted: bool
    was_member: bool


class TrackingPeriodOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    starts_at: datetime
    ends_at: datetime | None
    is_active: bool


class TrackingPeriodCreate(BaseModel):
    name: str
    starts_at: datetime | None = None
    ends_at: datetime | None = None


class RewardEligibilityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    period_id: int
    member_uuid: str
    member_username: str | None = None
    start_snapshot_id: int | None
    end_snapshot_id: int | None
    total_progress: int | None
    notg_progress: int | None
    nol_progress: int | None
    tcc_progress: int | None
    tna_progress: int | None
    wtp_progress: int | None
    eligibility_status: str
    notes: str | None
    rewarded_at: datetime | None


class MemberHistoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    member: GuildMemberOut
    snapshots: list[RaidSnapshotOut]


class TriggerResult(BaseModel):
    status: str
    snapshot_count: int
    restricted_count: int
    timestamp: datetime
