import type ApexCharts from "apexcharts/line";
import { fetchRewardPerDay } from "../api.js";
import type { Cycle, RewardDay, RewardSummary } from "../api.js";
import { loadApex } from "./loader.js";
import { chartColors, chartMode, type ChartColors, type ChartMode } from "./theme.js";
import {
  cycleTotals,
  memberLeaderboard,
  perDayTotals,
  METRIC_LABEL,
  RUNE_META,
  RUNE_TYPES,
  type MemberBar,
  type Metric,
  type PerDaySeries,
  type RaidTotal,
  type Rune,
} from "./series.js";

type ApexCtor = typeof ApexCharts;

interface LiveChart {
  role: "totals" | "trend" | "top";
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

let metric: Metric = "pending";
let memberUuid: string | null = null; // null = all members
let enabledRaids: Set<Rune> = new Set(RUNE_TYPES);
let topN = 10;

let active = false;
let generation = 0; // bumped by teardown; aborts in-flight mounts
let charts: LiveChart[] = [];
let apexCtor: ApexCtor | null = null;
let lastSummary: RewardSummary[] | null = null;
let lastCycle: Cycle | null = null;

let trendData: RewardDay[] | null = null;
let trendCache = new Map<string, RewardDay[] | null>();
let trendFetchKey: string | null = null;

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

function activeRaids(): Rune[] {
  return RUNE_TYPES.filter((rt) => enabledRaids.has(rt));
}

function trendKey(cycle: Cycle): string {
  return `${cycle.index}:${memberUuid ?? "*"}`;
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

  $el.innerHTML = controlsHtml(props.summary) + chartsHtml();
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

function controlsHtml(summary: RewardSummary[]): string {
  const memberNames = new Map<string, string>();
  for (const r of summary) {
    if (!memberNames.has(r.member_uuid)) memberNames.set(r.member_uuid, r.username);
  }
  const memberOptions = [...memberNames.entries()]
    .sort((a, b) => a[1]!.localeCompare(b[1]!))
    .map(
      ([uuid, name]) =>
        `<option value="${escapeHtml(uuid)}"${uuid === memberUuid ? " selected" : ""}>${escapeHtml(name)}</option>`,
    )
    .join("");

  const metricButtons = (["pending", "paid", "detected"] as Metric[])
    .map(
      (m) =>
        `<button type="button" class="view-btn${metric === m ? " active" : ""}" data-metric="${m}" aria-pressed="${metric === m}">${METRIC_LABEL[m]}</button>`,
    )
    .join("");

  const raidChips = RUNE_TYPES.map((rt) => {
    const on = enabledRaids.has(rt);
    return `<button type="button" class="chip-btn${on ? " on" : ""}" data-raid="${rt}" aria-pressed="${on}" title="${escapeHtml(RUNE_META[rt].name)}"><span class="chip-dot" style="background: var(--rune-${rt})"></span>${RUNE_META[rt].glyph}</button>`;
  }).join("");

  const topOptions = [5, 10, 20]
    .map((n) => `<option value="${n}"${topN === n ? " selected" : ""}>${n}</option>`)
    .join("");

  return `
    <div class="analytics-controls">
      <div class="ctl-group">
        <span class="ctl-label" id="ctl-metric-label">Metric</span>
        <div class="ctl-segmented" role="group" aria-labelledby="ctl-metric-label">${metricButtons}</div>
      </div>
      <div class="ctl-group">
        <label class="ctl-label" for="ctl-member">Player</label>
        <select id="ctl-member" class="settings-input" aria-label="Filter charts by player">
          <option value="">All members</option>
          ${memberOptions}
        </select>
      </div>
      <div class="ctl-group">
        <span class="ctl-label" id="ctl-raids-label">Raids</span>
        <div class="ctl-chips" role="group" aria-labelledby="ctl-raids-label">${raidChips}</div>
      </div>
      <div class="ctl-group">
        <label class="ctl-label" for="ctl-top">Top</label>
        <select id="ctl-top" class="settings-input" aria-label="Number of members shown in the leaderboard">
          ${topOptions}
        </select>
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
        <h2 id="top-title">Top members</h2>
        <div class="chart-host" id="chart-top"><div class="chart-loading"><span class="spinner"></span><p>Loading…</p></div></div>
      </section>
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
  document.querySelectorAll<HTMLButtonElement>("[data-raid]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const rt = btn.dataset.raid as Rune;
      if (enabledRaids.has(rt)) enabledRaids.delete(rt);
      else enabledRaids.add(rt);
      syncControlState();
      refreshCharts();
    });
  });
  document.getElementById("ctl-member")?.addEventListener("change", (e) => {
    const value = (e.target as HTMLSelectElement).value || null;
    void changeMember(value);
  });
  document.getElementById("ctl-top")?.addEventListener("change", (e) => {
    topN = Number((e.target as HTMLSelectElement).value) || 10;
    refreshCharts();
  });
}

function syncControlState(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-metric]").forEach((btn) => {
    const on = btn.dataset.metric === metric;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-raid]").forEach((btn) => {
    const rt = btn.dataset.raid as Rune;
    const on = enabledRaids.has(rt);
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
  });
}

async function changeMember(uuid: string | null): Promise<void> {
  memberUuid = uuid;
  trendData = null;
  const existing = charts.find((c) => c.role === "trend");
  if (existing) {
    try {
      existing.api.destroy();
    } catch {
      // ignore
    }
    charts = charts.filter((c) => c !== existing);
  }
  const host = document.getElementById("chart-trend");
  if (host) {
    host.innerHTML = `<div class="chart-loading"><span class="spinner"></span><p>Loading…</p></div>`;
  }
  refreshCharts(); // totals + leaderboard are summary-based; update immediately
  await ensureTrendData(generation);
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
    topOptions(memberLeaderboard(lastSummary, metric, topN, activeRaids()), colors, mode),
  );
  if (trendData) {
    createChart(
      "chart-trend",
      "trend",
      Apex,
      trendOptions(perDayTotals(trendData, metric, activeRaids()), colors, mode),
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
        topOptions(memberLeaderboard(lastSummary, metric, topN, activeRaids()), colors, mode),
      );
    } else if (lc.role === "trend" && trendData) {
      applyOptions(lc, trendOptions(perDayTotals(trendData, metric, activeRaids()), colors, mode));
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
    if (gen === generation && active) updateTrendChart();
    return;
  }
  if (trendFetchKey === key) return; // already in flight
  trendFetchKey = key;
  let data: RewardDay[] | null;
  try {
    data = await fetchRewardPerDay(
      new Date(cycle.start).toISOString(),
      new Date(cycle.end).toISOString(),
      memberUuid ?? undefined,
    );
  } catch (err) {
    data = null;
    if (gen === generation && active) {
      const host = document.getElementById("chart-trend");
      if (host) {
        host.innerHTML = `<p class="error-detail">Failed to load per-day data: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
      }
    }
  }
  trendCache.set(key, data);
  if (trendFetchKey === key) {
    trendData = data;
    trendFetchKey = null;
  }
  if (gen === generation && active) updateTrendChart();
}

function updateTrendChart(): void {
  if (!active || !apexCtor || !trendData) return;
  const existing = charts.find((c) => c.role === "trend");
  const colors = chartColors();
  const mode = chartMode();
  const options = trendOptions(perDayTotals(trendData, metric, activeRaids()), colors, mode);
  if (existing) applyOptions(existing, options);
  else createChart("chart-trend", "trend", apexCtor, options);
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

function chartScaffold(
  mode: ChartMode,
  colors: ChartColors,
  type: "bar" | "area",
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

function totalsOptions(
  data: RaidTotal[],
  colors: ChartColors,
  mode: ChartMode,
): ApexCharts.ApexOptions {
  const label = METRIC_LABEL[metric];
  return {
    ...chartScaffold(mode, colors, "bar", 320, false),
    series: [{ name: label, data: data.map((d) => d.value) }],
    colors: RUNE_TYPES.map((rt) => colors.runes[rt]),
    plotOptions: { bar: { distributed: true, borderRadius: 3, columnWidth: "55%" } },
    xaxis: {
      categories: data.map((d) => `${RUNE_META[d.raidType].glyph} · ${d.raidType}`),
      labels: { style: { colors: colors.text } },
    },
    yaxis: {
      labels: { style: { colors: colors.text } },
      title: { text: label, style: { color: colors.muted } },
    },
    legend: { show: false },
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
    legend: { position: "bottom", labels: { colors: colors.muted } },
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
  const raids = activeRaids();
  return {
    ...chartScaffold(mode, colors, "bar", Math.max(160, bars.length * 34 + 100), true),
    series: raids.map((rt) => ({
      name: RUNE_META[rt].name,
      data: bars.map((b) => b.segments.find((s) => s.raidType === rt)?.value ?? 0),
    })),
    colors: raids.map((rt) => colors.runes[rt]),
    plotOptions: { bar: { horizontal: true, borderRadius: 2 } },
    xaxis: {
      categories: bars.map((b) => b.username),
      labels: { style: { colors: colors.text } },
    },
    yaxis: {
      labels: { style: { colors: colors.text } },
      title: { text: label, style: { color: colors.muted } },
    },
    legend: { position: "bottom", labels: { colors: colors.muted } },
    tooltip: {
      theme: mode,
      y: { formatter: (val: number) => `${val} ${label.toLowerCase()}` },
    },
  };
}