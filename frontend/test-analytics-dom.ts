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
assert(app.querySelector("#ctl-member") === null, "player filter removed");
assert(app.querySelector("#ctl-top") === null, "top-N selector removed");
assert(app.querySelector("#top-title")?.textContent === "Top 20 members", "leaderboard title shows Top 20");

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

// all legends share the same circle marker style (trend chart isn't mounted
// in this test because its per-day fetch has no backend → 2 charts × 5 raids)
const circleMarkers = app.querySelectorAll(".apexcharts-legend-marker.apexcharts-marker-circle");
const squareMarkers = app.querySelectorAll(".apexcharts-legend-marker.apexcharts-marker-square");
assert(circleMarkers.length === 10, "mounted legends use circle markers (10 total)");
assert(squareMarkers.length === 0, "no square legend markers remain");

// each chart's legend toggles raids (the totals legend is the new one)
const totalsHost = app.querySelector("#chart-totals")!;
const totalsLegend = totalsHost.querySelectorAll(".apexcharts-legend-series");
assert(totalsLegend.length === 5, "totals legend lists all 5 raids");
// collapsed bars stay in the DOM with fill="none", so count visible ones
const visibleBars = () =>
  [...totalsHost.querySelectorAll(".apexcharts-bar-area")].filter(
    (el) => el.getAttribute("fill") !== "none",
  ).length;
const barsBefore = visibleBars();
const clickFirstLegend = () => {
  totalsHost
    .querySelector<HTMLElement>(".apexcharts-legend-series")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};
clickFirstLegend();
await sleep(300);
assert(visibleBars() === barsBefore - 1, "legend click hides one raid on the totals chart");
assert(totalsHost.querySelector("svg") !== null, "totals chart survives legend toggle");
clickFirstLegend();
await sleep(300);
assert(visibleBars() === barsBefore, "second legend click restores the raid");

// theme event triggers in-place rebuild
document.dispatchEvent(new CustomEvent("themechange"));
await sleep(300);
assert(app.querySelector("#chart-totals svg") !== null, "charts rebuilt after themechange");

// trend chart fetch fails in this test (no backend) → error + retry flow
const trendHost = app.querySelector("#chart-trend")!;
const trendErrorShown = () => trendHost.querySelector(".error-detail") !== null;
assert(trendErrorShown(), "trend fetch failure surfaces inline error");
const trendRetry = trendHost.querySelector<HTMLButtonElement>("#trend-retry");
assert(trendRetry !== null, "trend error state offers a retry button");
trendRetry!.click();
assert(trendHost.querySelector(".chart-loading") !== null, "retry puts the trend host back to loading");
await sleep(1200);
assert(trendErrorShown(), "failed retry surfaces the error again");

teardownAnalytics();
assert(app.querySelector("#chart-totals svg") === null, "teardown removes charts");

console.log(results.join("\n"));
console.log(`\n${results.length} assertions passed`);
}

void main();