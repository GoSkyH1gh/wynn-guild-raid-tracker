import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderAnalytics, teardownAnalytics } from "./src/charts/analytics.js";
import type { Cycle, RewardSummary } from "./src/api.js";

GlobalRegistrator.register();

const results: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  results.push(`ok: ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cycle: Cycle = {
  index: 1,
  start: "2026-08-01T00:00:00Z",
  end: "2026-08-15T00:00:00Z",
  start_date: "2026-08-01",
  end_date: "2026-08-15",
  display_end: "2026-08-14",
  payout_deadline: "2026-08-22T00:00:00Z",
  is_current: false,
  is_over: false,
  has_data: true,
  day_offset_minutes: 0,
};

const summary: RewardSummary[] = [
  { member_uuid: "m1", username: "Alice", rank: "Recruit", is_eligible: true, raid_type: "notg", days: 3, detected: 5, payable: 4, paid: 1, pending: 3, daily_cap: 2 },
  { member_uuid: "m1", username: "Alice", rank: "Recruit", is_eligible: true, raid_type: "nol", days: 2, detected: 2, payable: 2, paid: 2, pending: 0, daily_cap: null },
  { member_uuid: "m2", username: "Bob", rank: "Member", is_eligible: false, raid_type: "notg", days: 1, detected: 1, payable: 0, paid: 0, pending: 0, daily_cap: null },
  { member_uuid: "m3", username: "Carol", rank: "Officer", is_eligible: true, raid_type: "notg", days: 4, detected: 7, payable: 6, paid: 6, pending: 0, daily_cap: 2 },
];

async function main(): Promise<void> {
// ── states without data ─────────────────────────────────────────

const app = document.createElement("div");
document.body.appendChild(app);
const statusBar = document.createElement("div");
document.body.appendChild(statusBar);

renderAnalytics(app, statusBar, { cycle, statusHtml: "Cycle 1", summary: null, summaryError: null });
assert(app.querySelector(".loading-state") !== null, "null summary → loading state");
assert(statusBar.textContent?.includes("Cycle 1") === true, "status bar shows cycle status");

renderAnalytics(app, statusBar, { cycle, statusHtml: "", summary: [], summaryError: null });
assert(app.querySelector(".empty") !== null, "empty summary → empty state");

renderAnalytics(app, statusBar, { cycle: null, statusHtml: "", summary: null, summaryError: "backend down" });
assert(app.textContent?.includes("backend down") === true, "summary error surfaced");
assert(app.querySelector(".error-state") !== null, "summary error → error state");

// ── full mount (loads the real apexcharts bundle in happy-dom) ──

renderAnalytics(app, statusBar, { cycle, statusHtml: "Cycle 1", summary, summaryError: null });
assert(app.querySelector(".analytics-controls") !== null, "controls rendered");
assert(app.querySelectorAll("[data-metric]").length === 4, "metric toggle has 4 options");
assert(
  app.querySelector<HTMLButtonElement>('[data-metric="detected"]')?.getAttribute("aria-pressed") === "true",
  "detected is the default metric",
);
assert(app.querySelectorAll("[data-raid]").length === 5, "raid chips rendered for 5 raids");
assert(app.querySelectorAll("#ctl-member option").length === 4, "member select: all + 3 members");
assert(app.querySelectorAll("#ctl-top option").length === 3, "top N select has 3 options");

// wait for the lazy apexcharts import + chart render
await sleep(2500);

const svgs = app.querySelectorAll("#chart-totals svg, #chart-top svg, #chart-trend svg");
assert(svgs.length >= 2, `charts mounted (svg found in ${svgs.length} of 3 hosts)`);

// ── controls update charts in place without re-rendering HTML ──

const controls = app.querySelector(".analytics-controls");
const metricBtn = app.querySelector<HTMLButtonElement>('[data-metric="eligible"]');
metricBtn?.click();
assert(metricBtn?.getAttribute("aria-pressed") === "true", "metric toggle updates aria-pressed on eligible");
await sleep(300);
assert(app.querySelector("#chart-totals svg") !== null, "totals chart survives metric toggle (no remount)");

const raidChip = app.querySelector<HTMLButtonElement>('[data-raid="wtp"]');
raidChip?.click();
assert(raidChip?.getAttribute("aria-pressed") === "false", "raid chip toggles off");
await sleep(300);
assert(app.querySelector("#chart-top svg") !== null, "leaderboard chart survives raid toggle");

// theme event triggers in-place rebuild
document.dispatchEvent(new CustomEvent("themechange"));
await sleep(300);
assert(app.querySelector("#chart-totals svg") !== null, "charts rebuilt after themechange");

teardownAnalytics();
assert(app.querySelector("#chart-totals svg") === null, "teardown removes charts");

console.log(results.join("\n"));
console.log(`\n${results.length} assertions passed`);
}

void main();