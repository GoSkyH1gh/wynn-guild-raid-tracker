from datetime import date, datetime

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


class TriggerResult(BaseModel):
    status: str
    snapshot_count: int
    restricted_count: int
    timestamp: datetime


class RewardDefinitionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    raid_type: str
    display_name: str
    daily_cap: int | None
    sort_order: int


class RewardDefinitionUpdate(BaseModel):
    display_name: str | None = None
    daily_cap: int | None = None


class CycleOut(BaseModel):
    index: int
    start: datetime  # inclusive raw-UTC bound
    end: datetime    # exclusive raw-UTC bound
    start_date: date
    end_date: date   # exclusive
    display_end: date
    payout_deadline: datetime
    is_current: bool
    is_over: bool
    has_data: bool
    day_offset_minutes: int  # env-configured payout-day offset


class CycleConfigOut(BaseModel):
    anchor: date
    cycle_0_days: int
    schedule: list[int]
    payout_window_days: int
    day_offset_minutes: int  # read-only; set via CAP_DAY_OFFSET_MINUTES env


class CycleConfigUpdate(BaseModel):
    anchor: date
    cycle_0_days: int
    schedule: list[int]
    payout_window_days: int


class DetectedCompletionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    member_uuid: str
    raid_type: str
    count: int
    detected_at: datetime


class MemberHistoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    member: GuildMemberOut
    snapshots: list[RaidSnapshotOut]


class RewardSummaryOut(BaseModel):
    member_uuid: str
    username: str
    rank: str
    is_eligible: bool
    raid_type: str
    days: int
    detected: int
    payable: int
    paid: int
    pending: int
    daily_cap: int | None


class RewardDayEntryOut(BaseModel):
    member_uuid: str
    username: str
    rank: str
    is_eligible: bool
    raid_type: str
    daily_cap: int | None
    detected: int
    payable: int
    paid: int
    pending: int
    over_cap: int


class RewardDayOut(BaseModel):
    day: str
    entries: list[RewardDayEntryOut]


class PayoutCreateItem(BaseModel):
    member_uuid: str
    raid_type: str
    count: int


class PayoutCreate(BaseModel):
    starts_at: datetime
    ends_at: datetime
    items: list[PayoutCreateItem]


class PayoutChunkOut(BaseModel):
    day: str
    member_uuid: str
    raid_type: str
    count_paid: int


class PayoutRecordOut(BaseModel):
    id: int
    member_uuid: str
    member_username: str
    raid_type: str
    day: str
    count_paid: int
    paid_at: datetime
    paid_by_discord_id: str | None
    paid_by_username: str | None


class VoidPayoutResult(BaseModel):
    payout_id: int
    status: str


class DiscordUserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    discord_id: str
    username: str
    avatar_url: str | None
    is_admin: bool
    created_at: datetime
    last_login: datetime


class DiscordUserCreate(BaseModel):
    discord_id: str
    username: str
    is_admin: bool = False


class SetupRequest(BaseModel):
    secret: str
    discord_id: str
    username: str = ""


class CurrentUserOut(BaseModel):
    discord_id: str
    username: str
    avatar_url: str | None
    is_admin: bool


class FetchLogEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    started_at: datetime
    completed_at: datetime | None
    status: str
    snapshot_count: int | None
    restricted_count: int | None
    error_message: str | None
    duration_seconds: float | None = None


class ServerStatus(BaseModel):
    latest_fetch: FetchLogEntryOut | None
    total_fetches: int
    total_ok: int
    total_errors: int
    recent_fetches: list[FetchLogEntryOut]
