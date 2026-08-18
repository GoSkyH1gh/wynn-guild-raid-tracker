import type ApexCharts from "apexcharts/line";
import { fetchRewardPerDay } from "../api.js";
import type { Cycle, RewardDay, RewardSummary } from "../api.js";
import { loadApex } from "./loader.js";
import { chartColors, chartMode, type ChartColors, type ChartMode } from "./theme.js";
import {
  cycleTotals,
  memberLeaderboard,
  perDayTotals,
  raidersPerDay,
  rankTotals,
  METRIC_HINT,
  METRIC_LABEL,
  METRIC_ORDER,
  RUNE_META,
  RUNE_TYPES,
  type MemberBar,
  type Metric,
  type PerDaySeries,
  type RaidTotal,
  type RankTotals,
} from "./series.js";

type ApexCtor = typeof ApexCharts;

interface LiveChart {
  role: "totals" | "trend" | "top" | "raiders" | "rank" | "overcap";
  api: ApexCharts;
}

export interface AnalyticsProps {
  cycle: Cycle | null;
  statusHtml: string;
  /** Summary for the *selected* cycle; null while loading/stale. */
  summary: RewardSummary[] | null;
  summaryError: string | null;
}

// ── view state (module-level, mirrors main.ts style; survives re-renders) ──

let metric: Metric = "detected";

/** Members shown in the leaderboard (fixed, shown in the card title). */
const TOP_MEMBERS = 20;

let active = false;
let generation = 0; // bumped by teardown; aborts in-flight mounts
let charts: LiveChart[] = [];
let apexCtor: ApexCtor | null = null;
let lastSummary: RewardSummary[] | null = null;
let lastCycle: Cycle | null = null;

let trendData: RewardDay[] | null = null;
let trendCache = new Map<string, RewardDay[] | null>();
let trendFetchKey: string | null = null;

/**
 * Raid indices (RUNE_TYPES order) collapsed via the totals chart's legend.
 * ApexCharts disables native legend toggling for distributed bars, so this
 * view implements it by nulling the data point (mirroring native behavior).
 */
const collapsedTotalRaids = new Set<number>();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function trendKey(cycle: Cycle): string {
  return `${cycle.index}`;
}

function fmtDayShort(isoDay: string): string {
  return new Date(`${isoDay}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// ── render ──

export function renderAnalytics(
  $el: HTMLElement,
  $status: HTMLElement,
  props: AnalyticsProps,
): void {
  active = true;
  bindThemeListener();
  $status.innerHTML = `<span class="status-info">${props.statusHtml || "Charts"}</span>`;

  if (!props.cycle || props.summary === null) {
    $el.innerHTML = props.summaryError
      ? `<div class="error-state"><p>Failed to load rewards data</p><p class="error-detail">${escapeHtml(props.summaryError)}</p></div>`
      : `<div class="loading-state"><div class="spinner"></div><p>Loading charts…</p></div>`;
    return;
  }
  if (props.summary.length === 0) {
    $el.innerHTML = `<div class="empty"><p>No completions in this period.</p></div>`;
    return;
  }

  lastSummary = props.summary;
  lastCycle = props.cycle;

  $el.innerHTML = controlsHtml() + chartsHtml();
  bindControls();
  syncControlState();

  const gen = generation;
  void (async () => {
    let Apex: ApexCtor;
    try {
      Apex = await loadApex();
    } catch (err) {
      if (gen !== generation || !active) return;
      const msg = err instanceof Error ? err.message : String(err);
      $el.innerHTML = `<div class="error-state"><p>Failed to load charts library</p><p class="error-detail">${escapeHtml(msg)}</p><button class="btn-retry" id="charts-retry">Retry</button></div>`;
      document
        .getElementById("charts-retry")
        ?.addEventListener("click", () => renderAnalytics($el, $status, props), {
          once: true,
        });
      return;
    }
    if (gen !== generation || !active) return;
    mountAllCharts(Apex);
    void ensureTrendData(gen);
  })();
}

function controlsHtml(): string {
  const metricButtons = METRIC_ORDER.map(
    (m) =>
      `<button type="button" class="view-btn${metric === m ? " active" : ""}" data-metric="${m}" aria-pressed="${metric === m}" title="${escapeHtml(METRIC_HINT[m])}">${METRIC_LABEL[m]}</button>`,
  ).join("");

  return `
    <div class="analytics-controls">
      <div class="ctl-group">
        <span class="ctl-label" id="ctl-metric-label">Metric</span>
        <div class="ctl-segmented" role="group" aria-labelledby="ctl-metric-label">${metricButtons}</div>
      </div>
    </div>`;
}

function chartsHtml(): string {
  return `
    <div class="chart-grid">
      <section class="chart-card" aria-labelledby="totals-title">
        <h2 id="totals-title">Cycle totals by raid</h2>
        <div class="chart-host" id="chart-totals"><div class="chart-loading"><span class="spinner"></span><p>Loading…</p></div></div>
      </section>
      <section class="chart-card" aria-labelledby="trend-title">
        <h2 id="trend-title">Completions per day</h2>
        <div class="chart-host" id="chart-trend"><div class="chart-loading"><span class="spinner"></span><p>Loading…</p></div></div>
      </section>
      <section class="chart-card chart-card-wide" aria-labelledby="top-title">
        <h2 id="top-title">Top ${TOP_MEMBERS} members</h2>
        <div class="chart-host" id="chart-top"><div class="chart-loading"><span class="spinner"></span><p>Loading…</p></div></div>
      </section>
      <div class="chart-grid-three">
        <section class="chart-card" aria-labelledby="raiders-title">
          <h2 id="raiders-title">Active raiders per day</h2>
          <div class="chart-host" id="chart-raiders"><div class="chart-loading"><span class="spinner"></span><p>Loading…</p></div></div>
        </section>
        <section class="chart-card" aria-labelledby="rank-title">
          <h2 id="rank-title">Completions by rank</h2>
          <div class="chart-host" id="chart-rank"><div class="chart-loading"><span class="spinner"></span><p>Loading…</p></div></div>
        </section>
        <section class="chart-card" aria-labelledby="overcap-title">
          <h2 id="overcap-title">Over-cap completions</h2>
          <p class="chart-note">Detected completions above the daily cap, per raid.</p>
          <div class="chart-host" id="chart-overcap"><div class="chart-loading"><span class="spinner"></span><p>Loading…</p></div></div>
        </section>
      </div>
    </div>`;
}

// ── controls ──

function bindControls(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-metric]").forEach((btn) => {
    btn.addEventListener("click", () => {
      metric = btn.dataset.metric as Metric;
      syncControlState();
      refreshCharts();
    });
  });
}

function syncControlState(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-metric]").forEach((btn) => {
    const on = btn.dataset.metric === metric;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
}

// ── chart lifecycle ──

function mountAllCharts(Apex: ApexCtor): void {
  destroyCharts();
  apexCtor = Apex;
  if (!lastSummary) return;
  const colors = chartColors();
  const mode = chartMode();
  createChart(
    "chart-totals",
    "totals",
    Apex,
    totalsOptions(cycleTotals(lastSummary, metric), colors, mode),
  );
  createChart(
    "chart-top",
    "top",
    Apex,
    topOptions(memberLeaderboard(lastSummary, metric, TOP_MEMBERS), colors, mode),
  );
  createChart(
    "chart-rank",
    "rank",
    Apex,
    rankOptions(rankTotals(lastSummary, metric), colors, mode),
  );
  createChart(
    "chart-overcap",
    "overcap",
    Apex,
    overcapOptions(cycleTotals(lastSummary, "detected"), colors, mode),
  );
  if (trendData) {
    createChart(
      "chart-trend",
      "trend",
      Apex,
      trendOptions(perDayTotals(trendData, metric), colors, mode),
    );
    createChart(
      "chart-raiders",
      "raiders",
      Apex,
      raidersOptions(trendData, colors, mode),
    );
  }
}

function createChart(
  id: string,
  role: LiveChart["role"],
  Apex: ApexCtor,
  options: ApexCharts.ApexOptions,
): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.replaceChildren();
  const api = new Apex(el, options);
  charts.push({ role, api });
  void api.render();
}

function destroyCharts(): void {
  for (const lc of charts) {
    try {
      lc.api.destroy();
    } catch {
      // chart may already be torn down
    }
  }
  charts = [];
}

export function teardownAnalytics(): void {
  generation++;
  active = false;
  destroyCharts();
}

/** Rebuild options from current state and push them into the live charts. */
function refreshCharts(): void {
  if (!lastSummary || charts.length === 0) return;
  const colors = chartColors();
  const mode = chartMode();
  for (const lc of charts) {
    if (lc.role === "totals") {
      applyOptions(lc, totalsOptions(cycleTotals(lastSummary, metric), colors, mode));
    } else if (lc.role === "top") {
      applyOptions(
        lc,
        topOptions(memberLeaderboard(lastSummary, metric, TOP_MEMBERS), colors, mode),
      );
    } else if (lc.role === "rank") {
      applyOptions(lc, rankOptions(rankTotals(lastSummary, metric), colors, mode));
    } else if (lc.role === "trend" && trendData) {
      applyOptions(lc, trendOptions(perDayTotals(trendData, metric), colors, mode));
    }
  }
}

function applyOptions(lc: LiveChart, options: ApexCharts.ApexOptions): void {
  void lc.api.updateOptions(options, false, true);
}

// ── per-day trend data ──

async function ensureTrendData(gen: number): Promise<void> {
  const cycle = lastCycle;
  if (!cycle) return;
  const key = trendKey(cycle);
  if (trendCache.has(key)) {
    trendData = trendCache.get(key) ?? null;
    if (gen === generation && active) {
      updateTrendChart();
      updateRaidersChart();
    }
    return;
  }
  if (trendFetchKey === key) return; // already in flight
  trendFetchKey = key;
  let data: RewardDay[] | null;
  try {
    data = await fetchRewardPerDay(
      new Date(cycle.start).toISOString(),
      new Date(cycle.end).toISOString(),
    );
  } catch (err) {
    data = null;
    if (gen === generation && active) {
      const host = document.getElementById("chart-trend");
      if (host) {
        host.innerHTML = `<p class="error-detail">Failed to load per-day data: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>
          <button type="button" class="btn-retry" id="trend-retry">Retry</button>`;
        host.querySelector("#trend-retry")?.addEventListener(
          "click",
          () => {
            trendCache.delete(key);
            trendData = null;
            host.innerHTML = `<div class="chart-loading"><span class="spinner"></span><p>Loading…</p></div>`;
            void ensureTrendData(generation);
          },
          { once: true },
        );
      }
      const raidersHost = document.getElementById("chart-raiders");
      if (raidersHost) {
        raidersHost.innerHTML = `<p class="chart-note">Per-day data unavailable.</p>`;
      }
    }
  }
  trendCache.set(key, data);
  if (trendFetchKey === key) {
    trendData = data;
    trendFetchKey = null;
  }
  if (gen === generation && active) {
    updateTrendChart();
    updateRaidersChart();
  }
}

function updateTrendChart(): void {
  if (!active || !apexCtor || !trendData) return;
  const existing = charts.find((c) => c.role === "trend");
  const colors = chartColors();
  const mode = chartMode();
  const options = trendOptions(perDayTotals(trendData, metric), colors, mode);
  if (existing) applyOptions(existing, options);
  else createChart("chart-trend", "trend", apexCtor, options);
}

/** Raiders chart rides on the same per-day fetch as the trend chart. */
function updateRaidersChart(): void {
  if (!active || !apexCtor || !trendData) return;
  const existing = charts.find((c) => c.role === "raiders");
  const options = raidersOptions(trendData, chartColors(), chartMode());
  if (existing) applyOptions(existing, options);
  else createChart("chart-raiders", "raiders", apexCtor, options);
}

// ── theme changes: rebuild in place (no full re-render) ──

let themeBound = false;
function bindThemeListener(): void {
  if (themeBound) return;
  themeBound = true;
  document.addEventListener("themechange", () => {
    if (!active) return;
    const gen = generation;
    destroyCharts();
    void (async () => {
      try {
        const Apex = await loadApex(); // cached; instant
        if (gen === generation && active) mountAllCharts(Apex);
      } catch {
        // ignore; the next render retries
      }
    })();
  });
}

// ── options builders ──

/** Shared legend style: bottom position, circle markers, muted text. */
function bottomLegend(
  colors: ChartColors,
): NonNullable<ApexCharts.ApexOptions["legend"]> {
  return {
    position: "bottom",
    labels: { colors: colors.muted },
    markers: { shape: "circle" },
  };
}

function chartScaffold(
  mode: ChartMode,
  colors: ChartColors,
  type: "bar" | "area" | "donut",
  height: number,
  stacked: boolean,
): ApexCharts.ApexOptions {
  return {
    chart: {
      type,
      height,
      stacked,
      fontFamily: "inherit",
      background: "transparent",
      toolbar: {
        show: true,
        tools: { download: false }, // exports feature is not loaded, so hide the button
      },
    },
    theme: { mode },
    dataLabels: { enabled: false },
    grid: { borderColor: colors.grid },
    tooltip: { theme: mode },
  };
}

function toggleTotalRaid(index: number): void {
  const lc = charts.find((c) => c.role === "totals");
  if (!lc || !lastSummary) return;
  const collapsed = !collapsedTotalRaids.has(index);
  if (collapsed) collapsedTotalRaids.add(index);
  else collapsedTotalRaids.delete(index);
  const data = cycleTotals(lastSummary, metric).map((t, i) =>
    collapsedTotalRaids.has(i) ? null : t.value,
  );
  void lc.api
    .updateOptions({ series: [{ name: METRIC_LABEL[metric], data }] }, false, true)
    .then(() => {
      syncTotalsLegendItem(index, collapsed);
      // updateOptions' legend re-render can land after the promise, so re-sync.
      window.setTimeout(() => syncTotalsLegendItem(index, collapsed), 50);
    });
}

/** Keep the totals legend item's visual state in sync after a re-render. */
function syncTotalsLegendItem(index: number, collapsed: boolean): void {
  const item = document.querySelector(
    `#chart-totals .apexcharts-legend-series[rel="${index + 1}"]`,
  );
  if (!item) return;
  item.setAttribute("data:collapsed", String(collapsed));
  item.setAttribute("aria-pressed", String(collapsed));
  (item as HTMLElement).style.opacity = collapsed ? "0.45" : "1";
}

function totalsOptions(
  data: RaidTotal[],
  colors: ChartColors,
  mode: ChartMode,
): ApexCharts.ApexOptions {
  const label = METRIC_LABEL[metric];
  const scaffold = chartScaffold(mode, colors, "bar", 320, false);
  return {
    ...scaffold,
    chart: {
      ...scaffold.chart,
      events: {
        legendClick: (_chart: ApexCharts, seriesIndex?: number) => {
          toggleTotalRaid(seriesIndex ?? 0);
        },
      },
    },
    series: [
      {
        name: label,
        data: data.map((d, i) => (collapsedTotalRaids.has(i) ? null : d.value)),
      },
    ],
    colors: RUNE_TYPES.map((rt) => colors.runes[rt]),
    plotOptions: { bar: { distributed: true, borderRadius: 3, columnWidth: "55%" } },
    xaxis: {
      categories: data.map((d) => RUNE_META[d.raidType].short),
      labels: { style: { colors: colors.text } },
    },
    yaxis: {
      labels: { style: { colors: colors.text } },
      title: { text: label, style: { color: colors.muted } },
    },
    legend: bottomLegend(colors),
    tooltip: {
      theme: mode,
      y: {
        title: { formatter: () => "" },
        formatter: (val: number) => `${val} ${label.toLowerCase()}`,
      },
    },
  };
}

function trendOptions(
  result: PerDaySeries,
  colors: ChartColors,
  mode: ChartMode,
): ApexCharts.ApexOptions {
  const label = METRIC_LABEL[metric];
  return {
    ...chartScaffold(mode, colors, "area", 320, true),
    series: result.series,
    colors: result.series.map((s) => colors.runes[s.raidType]),
    stroke: { curve: "smooth", width: 2 },
    fill: { type: "solid", opacity: 0.8 },
    xaxis: {
      categories: result.categories.map(fmtDayShort),
      labels: { style: { colors: colors.text } },
    },
    yaxis: {
      labels: { style: { colors: colors.text } },
      title: { text: label, style: { color: colors.muted } },
    },
    legend: bottomLegend(colors),
    tooltip: {
      theme: mode,
      y: { formatter: (val: number) => `${val} ${label.toLowerCase()}` },
    },
  };
}

function topOptions(
  bars: MemberBar[],
  colors: ChartColors,
  mode: ChartMode,
): ApexCharts.ApexOptions {
  const label = METRIC_LABEL[metric];
  // 24px per bar, capped so the fixed Top 20 doesn't push the totals and
  // trend charts below the fold.
  const height = Math.min(520, Math.max(160, bars.length * 24 + 100));
  return {
    ...chartScaffold(mode, colors, "bar", height, true),
    series: RUNE_TYPES.map((rt) => ({
      name: RUNE_META[rt].short,
      data: bars.map((b) => b.segments.find((s) => s.raidType === rt)?.value ?? 0),
    })),
    colors: RUNE_TYPES.map((rt) => colors.runes[rt]),
    plotOptions: { bar: { horizontal: true, borderRadius: 2 } },
    xaxis: {
      categories: bars.map((b) => b.username),
      labels: { style: { colors: colors.text } },
    },
    yaxis: {
      labels: { style: { colors: colors.text } },
      title: { text: label, style: { color: colors.muted } },
    },
    legend: bottomLegend(colors),
    tooltip: {
      theme: mode,
      y: { formatter: (val: number) => `${val} ${label.toLowerCase()}` },
    },
  };
}

// ── additional charts ──

/** Donut slice colors for guild ranks (distinct from the rune palette). */
const RANK_PALETTE = ["#c9a86a", "#b05f6d", "#6d78a8", "#58a06e", "#a06e8f", "#8a94a0"];

/** Unique raiders per day — single line, shares the trend's per-day data. */
function raidersOptions(
  days: RewardDay[],
  colors: ChartColors,
  mode: ChartMode,
): ApexCharts.ApexOptions {
  const counts = raidersPerDay(days);
  return {
    ...chartScaffold(mode, colors, "area", 320, false),
    series: [{ name: "Active raiders", data: counts }],
    colors: [colors.text],
    stroke: { curve: "smooth", width: 2 },
    fill: { type: "solid", opacity: 0.3 },
    xaxis: {
      categories: days.map((d) => fmtDayShort(d.day)),
      labels: { style: { colors: colors.text } },
    },
    yaxis: {
      labels: { style: { colors: colors.text } },
      title: { text: "raiders", style: { color: colors.muted } },
    },
    legend: { show: false }, // single series
    tooltip: {
      theme: mode,
      y: { formatter: (val: number) => `${val} raiders` },
    },
  };
}

/** Donut of the selected metric broken down by guild rank. */
function rankOptions(
  data: RankTotals,
  colors: ChartColors,
  mode: ChartMode,
): ApexCharts.ApexOptions {
  const label = METRIC_LABEL[metric];
  return {
    ...chartScaffold(mode, colors, "donut", 320, false),
    series: data.values,
    labels: data.ranks,
    colors: RANK_PALETTE,
    legend: {
      position: "bottom",
      labels: { colors: colors.muted },
      markers: { shape: "circle" },
      formatter: (name: string, opts?: ApexCharts.ApexLegendFormatterOpts) =>
        `${name} · ${data.values[opts?.seriesIndex ?? 0] ?? 0}`,
    },
    tooltip: {
      theme: mode,
      y: { formatter: (val: number) => `${val} ${label.toLowerCase()}` },
    },
  };
}

/** Stacked "counted vs over-cap" bars — always detected-based (metric-independent). */
function overcapOptions(
  totals: RaidTotal[],
  colors: ChartColors,
  mode: ChartMode,
): ApexCharts.ApexOptions {
  return {
    ...chartScaffold(mode, colors, "bar", 320, true),
    series: [
      { name: "Counted", data: totals.map((t) => t.detected - t.overCap) },
      { name: "Over cap", data: totals.map((t) => t.overCap) },
    ],
    colors: [colors.text, colors.warn],
    plotOptions: { bar: { borderRadius: 2, columnWidth: "55%" } },
    xaxis: {
      categories: totals.map((t) => RUNE_META[t.raidType].short),
      labels: { style: { colors: colors.text } },
    },
    yaxis: {
      labels: { style: { colors: colors.text } },
      title: { text: "completions", style: { color: colors.muted } },
    },
    legend: bottomLegend(colors),
    tooltip: {
      theme: mode,
      y: { formatter: (val: number) => `${val} detected` },
    },
  };
}