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
    reward_amount: int
    reward_label: str
    daily_cap: int | None
    is_active: bool
    sort_order: int


class RewardDefinitionUpdate(BaseModel):
    reward_amount: int | None = None
    reward_label: str | None = None
    display_name: str | None = None
    daily_cap: int | None = None
    is_active: bool | None = None


class DetectedCompletionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    member_uuid: str
    raid_type: str
    count: int
    detected_at: datetime


class PendingRewardItem(BaseModel):
    member_uuid: str
    username: str
    raid_type: str
    count_pending: int
    earliest_detected: datetime
    latest_detected: datetime


class PayoutItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    payout_event_id: int
    detected_completion_id: int
    member_uuid: str
    raid_type: str
    count_paid: int
    reward_amount: int
    rewarded_at: datetime


class PayoutEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    label: str | None
    starts_at: datetime
    ends_at: datetime
    created_at: datetime
    items: list[PayoutItemOut] = []


class PayoutCreateItem(BaseModel):
    member_uuid: str
    raid_type: str
    count: int


class PayoutCreate(BaseModel):
    label: str | None = None
    starts_at: datetime
    ends_at: datetime
    items: list[PayoutCreateItem]


class PayoutResult(BaseModel):
    payout_event_id: int
    label: str | None
    item_count: int
    created_at: datetime


class MemberHistoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    member: GuildMemberOut
    snapshots: list[RaidSnapshotOut]


class MemberPayoutSummary(BaseModel):
    payout_event_id: int
    payout_label: str | None
    rewarded_at: datetime
    items: list[PayoutItemOut]


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
