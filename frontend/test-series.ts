import {
  cycleTotals,
  memberLeaderboard,
  payoutBreakdown,
  perDayTotals,
  raidersPerDay,
  rankTotals,
} from "./src/charts/series.js";
import type { RewardSummary, RewardDay } from "./src/api.js";

const results: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  results.push(`ok: ${msg}`);
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── fixtures ─────────────────────────────────────────────────────

const summary: RewardSummary[] = [
  { member_uuid: "m1", username: "Alice", rank: "Recruit", is_eligible: true, raid_type: "notg", days: 3, detected: 5, payable: 4, paid: 1, pending: 3, daily_cap: 2 },
  { member_uuid: "m1", username: "Alice", rank: "Recruit", is_eligible: true, raid_type: "nol", days: 2, detected: 2, payable: 2, paid: 2, pending: 0, daily_cap: null },
  { member_uuid: "m2", username: "Bob", rank: "Member", is_eligible: false, raid_type: "notg", days: 1, detected: 1, payable: 0, paid: 0, pending: 0, daily_cap: null },
  { member_uuid: "m3", username: "Carol", rank: "Officer", is_eligible: true, raid_type: "notg", days: 4, detected: 7, payable: 6, paid: 6, pending: 0, daily_cap: 2 },
  { member_uuid: "m3", username: "Carol", rank: "Officer", is_eligible: true, raid_type: "bogus", days: 1, detected: 9, payable: 0, paid: 0, pending: 0, daily_cap: null },
];

const days: RewardDay[] = [
  {
    day: "2026-08-01",
    entries: [
      { member_uuid: "m1", username: "Alice", rank: "Recruit", is_eligible: true, raid_type: "notg", daily_cap: 2, detected: 2, payable: 2, paid: 0, pending: 2, over_cap: 0 },
      { member_uuid: "m2", username: "Bob", rank: "Member", is_eligible: false, raid_type: "notg", daily_cap: null, detected: 1, payable: 0, paid: 0, pending: 0, over_cap: 0 },
      { member_uuid: "m1", username: "Alice", rank: "Recruit", is_eligible: true, raid_type: "nol", daily_cap: null, detected: 1, payable: 1, paid: 1, pending: 0, over_cap: 0 },
    ],
  },
  {
    day: "2026-08-02",
    entries: [
      { member_uuid: "m1", username: "Alice", rank: "Recruit", is_eligible: true, raid_type: "notg", daily_cap: 2, detected: 1, payable: 1, paid: 0, pending: 1, over_cap: 0 },
    ],
  },
];

// ── cycleTotals ──────────────────────────────────────────────────

const totals = cycleTotals(summary, "pending");
const notg = totals.find((t) => t.raidType === "notg");
assert(eq(totals.length, 5), "cycleTotals: one entry per raid type");
assert(eq(notg?.detected, 13), "cycleTotals: detected sums all members (5+1+7)");
assert(eq(notg?.payable, 10), "cycleTotals: payable sums all members (4+0+6)");
assert(eq(notg?.paid, 7), "cycleTotals: paid sums all members (1+0+6)");
assert(eq(notg?.pending, 3), "cycleTotals: pending sums all members (3+0+0)");
assert(eq(notg?.overCap, 2), "cycleTotals: overCap = detected-payable per capped member (1+1)");
assert(eq(notg?.value, 3), "cycleTotals: value follows the selected metric (pending)");
const nol = totals.find((t) => t.raidType === "nol");
assert(eq(nol?.overCap, 0), "cycleTotals: uncapped raids always have overCap 0");
assert(eq(cycleTotals(summary, "detected")[0]?.value, 13), "cycleTotals: detected metric value");
assert(eq(cycleTotals(summary, "paid")[0]?.value, 7), "cycleTotals: paid metric value");
assert(eq(cycleTotals(summary, "eligible")[0]?.value, 10), "cycleTotals: eligible metric = paid + pending (7+3)");
assert(eq(cycleTotals([], "pending")[0]?.value, 0), "cycleTotals: empty summary → zeros");

// ── perDayTotals ─────────────────────────────────────────────────

const trend = perDayTotals(days, "detected");
assert(eq(trend.categories, ["2026-08-01", "2026-08-02"]), "perDayTotals: categories are ISO days in order");
assert(eq(trend.series.length, 5), "perDayTotals: one series per raid type");
assert(eq(trend.series[0]?.name, "NOTG"), "perDayTotals: series names use short codes");
const notgSeries = trend.series.find((s) => s.raidType === "notg");
assert(eq(notgSeries?.data, [3, 1]), "perDayTotals: aggregates entries per day per raid (2+1, 1)");
const nolSeries = trend.series.find((s) => s.raidType === "nol");
assert(eq(nolSeries?.data, [1, 0]), "perDayTotals: raid with no entry on a day → 0");
const pendingTrend = perDayTotals(days, "pending");
const notgPending = pendingTrend.series.find((s) => s.raidType === "notg");
assert(eq(notgPending?.data, [2, 1]), "perDayTotals: pending metric respects eligibility zeros");
const eligibleTrend = perDayTotals(days, "eligible");
const notgEligible = eligibleTrend.series.find((s) => s.raidType === "notg");
assert(eq(notgEligible?.data, [2, 1]), "perDayTotals: eligible metric = paid + pending per day");
const nolEligible = eligibleTrend.series.find((s) => s.raidType === "nol");
assert(eq(nolEligible?.data, [1, 0]), "perDayTotals: eligible includes paid for uncapped nol");
assert(eq(perDayTotals([], "detected").categories.length, 0), "perDayTotals: empty days");

// ── memberLeaderboard ────────────────────────────────────────────

const board = memberLeaderboard(summary, "pending", 10);
assert(eq(board.length, 3), "leaderboard: one bar per member with rows");
assert(eq(board[0]?.username, "Alice"), "leaderboard: sorted by total desc (Alice 3 pending)");
assert(eq(board[0]?.total, 3), "leaderboard: total sums the metric over all raids");
assert(eq(board[0]?.segments.map((s) => s.raidType), ["notg", "nol"]), "leaderboard: segments only for raids the member has entries for");
assert(eq(board[0]?.eligible, true), "leaderboard: eligibility flag");
assert(eq(board.find((b) => b.username === "Bob")?.eligible, false), "leaderboard: ineligible flag (Bob)");
const top2 = memberLeaderboard(summary, "pending", 2);
assert(eq(top2.length, 2), "leaderboard: topN slicing");
const detectedBoard = memberLeaderboard(summary, "detected", 10);
assert(eq(detectedBoard[0]?.username, "Alice") && eq(detectedBoard[0]?.total, 7), "leaderboard: detected metric ignores bogus raid");
const eligibleBoard = memberLeaderboard(summary, "eligible", 10);
assert(eq(eligibleBoard[0]?.username, "Alice") && eq(eligibleBoard[0]?.total, 6), "leaderboard: eligible metric = paid + pending (Alice 4+2)");
assert(eq(memberLeaderboard([], "pending", 5).length, 0), "leaderboard: empty summary");

// ── raidersPerDay ───────────────────────────────────────────────

assert(eq(raidersPerDay(days), [2, 1]), "raidersPerDay: distinct members per day (m1+m2, m1)");
assert(eq(raidersPerDay([]), []), "raidersPerDay: empty days → no points");

// ── rankTotals ──────────────────────────────────────────────────

const ranks = rankTotals(summary, "detected");
assert(eq(ranks.ranks, ["Recruit", "Member", "Officer"]), "rankTotals: known ranks first, unknown alphabetical");
assert(eq(ranks.values, [7, 1, 16]), "rankTotals: detected sums per rank (Alice 7, Bob 1, Carol 16)");
assert(eq(rankTotals(summary, "pending").values[2], 0), "rankTotals: selected metric applied (Carol pending 0)");
assert(eq(rankTotals(summary, "eligible").ranks[0], "Recruit"), "rankTotals: eligible = paid + pending (Alice first)");
assert(eq(rankTotals([], "detected").values.length, 0), "rankTotals: empty summary → no ranks");
assert(eq(rankTotals([{ ...summary[0]!, rank: "" }], "detected").values.length, 0), "rankTotals: empty rank rows skipped");

// ── payoutBreakdown ─────────────────────────────────────────────

const payout = payoutBreakdown(summary);
const payoutNotg = payout.find((t) => t.raidType === "notg");
assert(eq(payoutNotg?.eligible, 10), "payoutBreakdown: eligible = payable of paying ranks (Alice 4 + Carol 6)");
assert(eq(payoutNotg?.overCap, 2), "payoutBreakdown: overCap = excess of paying ranks (Alice 1 + Carol 1)");
assert(eq(payoutNotg?.ineligible, 1), "payoutBreakdown: ineligible = high-rank detected (Bob 1)");
assert(eq(payoutNotg?.eligible! + payoutNotg?.overCap! + payoutNotg?.ineligible!, 13), "payoutBreakdown: segments sum to detected");
const payoutNol = payout.find((t) => t.raidType === "nol");
assert(eq(payoutNol, { raidType: "nol", eligible: 2, overCap: 0, ineligible: 0 }), "payoutBreakdown: uncapped raid splits cleanly");
const payoutEmpty = payoutBreakdown([]);
assert(eq(payoutEmpty.every((t) => t.eligible === 0 && t.overCap === 0 && t.ineligible === 0), true), "payoutBreakdown: empty summary → zeros");

console.log(results.join("\n"));
console.log(`\n${results.length} assertions passed`);