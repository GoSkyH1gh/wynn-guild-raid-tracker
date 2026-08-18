import type { RewardSummary, RewardDay } from "../api.js";

// ── Raid types / labels (keep short codes + names in sync with api.ts) ──

export type Rune = "notg" | "nol" | "tcc" | "tna" | "wtp";
export const RUNE_TYPES: Rune[] = ["notg", "nol", "tcc", "tna", "wtp"];

export const RUNE_META: Record<Rune, { short: string; name: string }> = {
  notg: { short: "NOTG", name: "Nest of the Grootslangs" },
  nol: { short: "NOL", name: "Orphion's Nexus of Light" },
  tcc: { short: "TCC", name: "The Canyon Colossus" },
  tna: { short: "TNA", name: "The Nameless Anomaly" },
  wtp: { short: "WTP", name: "The Wartorn Palace" },
};

// ── Metric ──

export type Metric = "pending" | "paid" | "detected";

export const METRIC_LABEL: Record<Metric, string> = {
  pending: "Pending",
  paid: "Paid",
  detected: "Detected",
};

function isRune(rt: string): rt is Rune {
  return (RUNE_TYPES as string[]).includes(rt);
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

// ── Chart A: cycle totals per raid type ──

export interface RaidTotal {
  raidType: Rune;
  detected: number;
  payable: number;
  paid: number;
  pending: number;
  /** detected − payable for capped raids (0 when uncapped or not over). */
  overCap: number;
  /** The currently selected metric. */
  value: number;
}

export function cycleTotals(summary: RewardSummary[], metric: Metric): RaidTotal[] {
  const totals = new Map<Rune, RaidTotal>(
    RUNE_TYPES.map((rt) => [
      rt,
      { raidType: rt, detected: 0, payable: 0, paid: 0, pending: 0, overCap: 0, value: 0 },
    ]),
  );
  for (const r of summary) {
    if (!isRune(r.raid_type)) continue;
    const t = totals.get(r.raid_type)!;
    t.detected += r.detected;
    t.payable += r.payable;
    t.paid += r.paid;
    t.pending += r.pending;
    if (r.daily_cap !== null) {
      t.overCap += Math.max(0, r.detected - r.payable);
    }
  }
  for (const t of totals.values()) {
    t.value = t[metric];
  }
  return RUNE_TYPES.map((rt) => totals.get(rt)!);
}

// ── Chart B: per-day totals (aggregated over the filtered members) ──

export interface PerDaySeries {
  /** ISO day strings ("YYYY-MM-DD"), one per RewardDay. */
  categories: string[];
  /** One series per enabled raid type, in RUNE_TYPES order. */
  series: { name: string; raidType: Rune; data: number[] }[];
}

export function perDayTotals(
  days: RewardDay[],
  metric: Metric,
  enabled: Rune[],
): PerDaySeries {
  const enabledSet = new Set<Rune>(enabled);
  const series = RUNE_TYPES.filter((rt) => enabledSet.has(rt)).map((rt) => ({
    name: RUNE_META[rt].name,
    raidType: rt,
    data: days.map(() => 0),
  }));
  const idxByRaid = new Map(series.map((s, i) => [s.raidType, i]));
  days.forEach((day, di) => {
    for (const e of day.entries) {
      const i = idxByRaid.get(e.raid_type as Rune);
      if (i === undefined) continue; // unknown raid types are ignored
      series[i]!.data[di]! += e[metric];
    }
  });
  return { categories: days.map((d) => d.day), series };
}

// ── Chart C: top-members leaderboard ──

export interface MemberBar {
  uuid: string;
  username: string;
  rank: string;
  eligible: boolean;
  /** Sum of the selected metric over the enabled raids. */
  total: number;
  /** One segment per enabled raid type, in RUNE_TYPES order. */
  segments: { raidType: Rune; value: number }[];
}

export function memberLeaderboard(
  summary: RewardSummary[],
  metric: Metric,
  topN: number,
  enabled: Rune[],
): MemberBar[] {
  const enabledSet = new Set<Rune>(enabled);
  const byMember = new Map<string, MemberBar>();
  for (const r of summary) {
    if (!isRune(r.raid_type) || !enabledSet.has(r.raid_type)) continue;
    let m = byMember.get(r.member_uuid);
    if (!m) {
      m = {
        uuid: r.member_uuid,
        username: r.username,
        rank: r.rank,
        eligible: r.is_eligible,
        total: 0,
        segments: [],
      };
      byMember.set(r.member_uuid, m);
    }
    m.segments.push({ raidType: r.raid_type, value: r[metric] });
  }
  for (const m of byMember.values()) {
    m.segments.sort(
      (a, b) => RUNE_TYPES.indexOf(a.raidType) - RUNE_TYPES.indexOf(b.raidType),
    );
    m.total = sum(m.segments.map((s) => s.value));
  }
  return [...byMember.values()]
    .sort((a, b) => b.total - a.total || a.username.localeCompare(b.username))
    .slice(0, Math.max(0, topN));
}
