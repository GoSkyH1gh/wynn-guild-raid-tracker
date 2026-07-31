export interface GuildMember {
  uuid: string;
  username: string;
  rank: string;
  first_seen: string;
  last_seen: string;
  is_current_member: boolean;
}

export interface PendingRewardItem {
  member_uuid: string;
  username: string;
  raid_type: string;
  count_pending: number;
  earliest_detected: string;
  latest_detected: string;
}

export interface PayoutItem {
  id: number;
  payout_event_id: number;
  detected_completion_id: number;
  member_uuid: string;
  member_username: string | null;
  raid_type: string;
  count_paid: number;
  reward_amount: number;
  rewarded_at: string;
}

export interface PayoutEvent {
  id: number;
  label: string | null;
  starts_at: string;
  ends_at: string;
  created_at: string;
  status: string;
  voided_at: string | null;
  paid_by_discord_id: string | null;
  paid_by_username: string | null;
  items: PayoutItem[];
}

export interface RewardDefinition {
  id: number;
  raid_type: string;
  display_name: string;
  reward_amount: number;
  reward_label: string;
  daily_cap: number | null;
  is_active: boolean;
  sort_order: number;
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

export async function fetchPendingRewards(
  from: string,
  to: string,
  member_uuid?: string,
): Promise<PendingRewardItem[]> {
  let url = `/api/rewards/pending?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  if (member_uuid) url += `&member_uuid=${member_uuid}`;
  return fetchJson<PendingRewardItem[]>(url);
}

export async function fetchPayouts(): Promise<PayoutEvent[]> {
  return fetchJson<PayoutEvent[]>("/api/payouts");
}

export async function createPayout(body: {
  label?: string | null;
  starts_at: string;
  ends_at: string;
  items: { member_uuid: string; raid_type: string; count: number }[];
}): Promise<{ payout_event_id: number }> {
  return fetchJson("/api/rewards/payout", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function voidPayout(payoutId: number): Promise<{ payout_event_id: number; status: string; voided_at: string }> {
  return fetchJson(`/api/payouts/${payoutId}/void`, {
    method: "POST",
  });
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
