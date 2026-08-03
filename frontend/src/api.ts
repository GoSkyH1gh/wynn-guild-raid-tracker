export interface GuildMember {
  uuid: string;
  username: string;
  rank: string;
  first_seen: string;
  last_seen: string;
  is_current_member: boolean;
}

export interface RewardDefinition {
  id: number;
  raid_type: string;
  display_name: string;
  daily_cap: number | null;
  sort_order: number;
}

export interface RewardSummary {
  member_uuid: string;
  username: string;
  rank: string;
  is_eligible: boolean;
  raid_type: string;
  days: number;
  detected: number;
  payable: number;
  paid: number;
  pending: number;
  daily_cap: number | null;
}

export interface RewardDayEntry {
  member_uuid: string;
  username: string;
  rank: string;
  is_eligible: boolean;
  raid_type: string;
  daily_cap: number | null;
  detected: number;
  payable: number;
  paid: number;
  pending: number;
  over_cap: number;
}

export interface RewardDay {
  day: string;
  entries: RewardDayEntry[];
}

export interface PayoutChunk {
  day: string;
  member_uuid: string;
  raid_type: string;
  count_paid: number;
}

export interface PayoutRecord {
  id: number;
  member_uuid: string;
  member_username: string;
  raid_type: string;
  day: string;
  count_paid: number;
  paid_at: string;
  paid_by_discord_id: string | null;
  paid_by_username: string | null;
}

export const RAID_RUNES: Record<string, { rune: string; color: string }> = {
  notg: { rune: "Az", color: "#00d4ff" },
  nol: { rune: "Uth", color: "#b44dff" },
  tcc: { rune: "Tol", color: "#ff4444" },
  tna: { rune: "Tol", color: "#ff8844" },
  wtp: { rune: "Ek", color: "#44ff88" },
};

export const RAID_LABELS: Record<string, string> = {
  notg: "Nest of the Grootslangs",
  nol: "Orphion's Nexus of Light",
  tcc: "The Canyon Colossus",
  tna: "The Nameless Anomaly",
  wtp: "The Wartorn Palace",
};

const BASE = import.meta.env.VITE_API_BASE ?? "";

let _token: string | null = null;

export function getToken(): string | null {
  return _token;
}

export function setToken(token: string) {
  _token = token;
}

export function clearToken() {
  _token = null;
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${url}`, {
    headers,
    credentials: "include",
    ...init,
  });

  if (res.status === 401) {
    clearToken();
    throw new Error("Not authenticated");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchDiscordLoginUrl(): Promise<string> {
  const data = await fetchJson<{ url: string }>("/api/auth/discord/login");
  return data.url;
}

export interface CurrentUser {
  discord_id: string;
  username: string;
  avatar_url: string | null;
  is_admin: boolean;
}

export async function fetchCurrentUser(): Promise<CurrentUser> {
  return fetchJson<CurrentUser>("/api/auth/me");
}

export async function fetchMembers(): Promise<GuildMember[]> {
  return fetchJson<GuildMember[]>("/api/members?current_only=true");
}

export async function fetchRewardDefinitions(): Promise<RewardDefinition[]> {
  return fetchJson<RewardDefinition[]>("/api/reward-definitions");
}

export async function updateRewardDefinition(
  id: number,
  patch: Partial<
    Pick<RewardDefinition, "daily_cap" | "display_name">
  >,
): Promise<RewardDefinition> {
  return fetchJson<RewardDefinition>(`/api/reward-definitions/${id}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function fetchRewardSummary(
  from: string,
  to: string,
  member_uuid?: string,
): Promise<RewardSummary[]> {
  let url = `/api/rewards/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  if (member_uuid) url += `&member_uuid=${member_uuid}`;
  return fetchJson<RewardSummary[]>(url);
}

export async function fetchRewardPerDay(
  from: string,
  to: string,
  member_uuid?: string,
): Promise<RewardDay[]> {
  let url = `/api/rewards/per-day?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  if (member_uuid) url += `&member_uuid=${member_uuid}`;
  return fetchJson<RewardDay[]>(url);
}

export async function createPayout(body: {
  starts_at: string;
  ends_at: string;
  items: { member_uuid: string; raid_type: string; count: number }[];
}): Promise<PayoutChunk[]> {
  return fetchJson<PayoutChunk[]>("/api/rewards/payout", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function fetchPayoutRecords(): Promise<PayoutRecord[]> {
  return fetchJson<PayoutRecord[]>("/api/payouts");
}

export async function voidPayoutRecord(payoutId: number): Promise<{ payout_id: number; status: string }> {
  return fetchJson(`/api/payouts/${payoutId}/void`, { method: "POST" });
}

export interface FetchLogEntry {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: string;
  snapshot_count: number | null;
  restricted_count: number | null;
  error_message: string | null;
  duration_seconds: number | null;
}

export interface ServerStatus {
  latest_fetch: FetchLogEntry | null;
  total_fetches: number;
  total_ok: number;
  total_errors: number;
  recent_fetches: FetchLogEntry[];
}

export async function fetchServerStatus(): Promise<ServerStatus> {
  return fetchJson<ServerStatus>("/api/status");
}

export interface TriggerResult {
  status: string;
  snapshot_count: number;
  restricted_count: number;
  timestamp: string;
}

export async function triggerFetch(): Promise<TriggerResult> {
  return fetchJson<TriggerResult>("/api/trigger-fetch", { method: "POST" });
}
