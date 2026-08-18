# Plan: ApexCharts visualisations for the guild raid tracker

**Status:** draft · **Target:** `apexcharts@^6.10.0` · **Date:** 2026-08-18

Everything below is grounded in the current ApexCharts docs (v6) and the existing
codebase (`frontend/src/main.ts`, `frontend/src/api.ts`,
`frontend/src/cycle-picker.ts`, `frontend/vite.config.ts`).

---

## 1. Research summary (what the docs say)

ApexCharts v6 is **tree-shakeable** — the docs and README document three import strategies:

| Strategy | Import | Cost |
|---|---|---|
| Full bundle | `import ApexCharts from "apexcharts"` | everything, ~30–60% bigger than needed |
| Per-type entry | `import ApexCharts from "apexcharts/line"` (+ side-effect `import "apexcharts/bar"`) | core + only those chart families |
| Bare core | `import ApexCharts from "apexcharts/core"` | manual registration, rarely needed |

Plus optional feature modules: `apexcharts/features/legend`, `toolbar`, `exports`,
`annotations`, `keyboard`. The docs' tree-shaking guide flags a **known Vite pitfall**:
without `optimizeDeps.include`, Vite can bundle ApexCharts twice (per-type entries plus
a duplicate full bundle) — so the plan includes that config.

Other relevant facts:

- `chart.render()` is awaitable in v6; `chart.destroy()` is required when removing a
  chart (ResizeObserver leaks otherwise).
- Premium (watermarked) features — unit/waffle, crossfilter, ink, measure, etc. — are
  all opt-in; plain line/bar/area charts are free with no license.

## 2. Loading strategy (recommended)

**Lazy dynamic import, triggered on first visit to the Analytics view, with an
optional idle-time preload.** ApexCharts is never part of the initial bundle.

1. **No static import anywhere.** `main.ts` stays ApexCharts-free; the initial JS
   bundle is untouched.
2. **New module `frontend/src/charts/loader.ts`** with a single-flight loader:

   ```ts
   // loader.ts
   let apexPromise: Promise<ApexChartsConstructor> | null = null;
   export function loadApex() {
     apexPromise ??= (async () => {
       const { default: ApexCharts } = await import("apexcharts/line"); // line, area, scatter…
       await import("apexcharts/bar");                                  // bar/column family
       await import("apexcharts/features/legend");
       await import("apexcharts/features/toolbar"); // zoom/pan for the trend chart
       return ApexCharts;
     })();
     return apexPromise;
   }
   export function preloadApex() { /* called from idle; ignores errors */ loadApex().catch(() => {}); }
   ```

   Vite turns that `import()` into its own chunk automatically → **zero blocking cost
   on first load**; the module is cached in memory + browser cache after first use.
3. **Idle preload (nice-to-have, cheap):** in `init()` after the first `fetchData()`
   completes, call `preloadApex()` inside `requestIdleCallback` (fallback:
   `setTimeout` 2–3 s). The tree-shaken chunk (~150–250 KB raw, far less gzipped)
   downloads in the background while the user reads the rewards table, so clicking
   Analytics is instant.
4. **Vite config** (`frontend/vite.config.ts`):

   ```ts
   optimizeDeps: {
     include: [
       "apexcharts/line",
       "apexcharts/bar",
       "apexcharts/features/legend",
       "apexcharts/features/toolbar",
     ],
   },
   ```

   per the official guide, to prevent duplicate bundles in dev.
5. **Verify after install:** check `node_modules/apexcharts/package.json` `exports`
   map — v5 and v6 use different subpath layouts (`apexcharts/dist/...` vs
   `apexcharts/line`). Confirm the entry points above exist before writing code.
6. **Acceptance check:** `npm run build` → confirm `dist/assets` contains one
   `apexcharts-*.js` chunk that is **not** referenced from `index-*.js`/`index.html`,
   and eyeball its size.

*Rejected alternatives:* static import (blocks first load with ~200 KB+), CDN
`<script>` (no tree-shaking, no version pinning, breaks offline dev), manual
`manualChunks` splitting (dynamic import already achieves this more cleanly).

## 3. Which data to visualise

New **"Analytics" view** (4th tab), all driven by data already in `api.ts`:

| # | Chart | Data source | Shape |
|---|---|---|---|
| A | **Cycle totals per raid type** | `summaryData` (already fetched via `loadSummary()`) | Stacked column: per raid type, bars split into *paid / pending / over-cap* segments, coloured with the existing `RAID_RUNES`/`--rune-*` palette. The "Totals" row of the rewards table becomes this chart. |
| B | **Per-day trend across the cycle** | `fetchRewardPerDay(from, to)` **without** `member_uuid` (endpoint already supports it — verify on backend, then cache under a new key like `${cycleIndex}:__all__` in `perDayCache`) | Stacked area/column, X = days of the cycle, one series per raid type; aggregated over members (or a single member when filtered). |
| C | **Top members leaderboard** | `summaryData` | Horizontal stacked bars, top N (5/10/20) by selected metric, each member's bar stacked by raid type in rune colours — shows *who owes what* at a glance. |
| D *(phase 2, optional)* | **Fetch history** on the Status view | `statusData.recent_fetches` | Line/area of `snapshot_count` + duration over time, error points in red. |

Per-member sparklines in the expanded day-breakdown are a possible later phase, not v1.

## 4. Controls to surface

**Global (reuse existing infra):** the cycle picker (`cycle-picker.ts`, `?cycle=N` in
URL) currently only shows on the rewards view (`showCyclePicker` check in `render()`).
Extend that condition to the Analytics view → cycle selection for charts for free,
synced with the rest of the app, and the existing polling already handles data refresh.

**In-view controls** (simple buttons/dropdowns in the Analytics header, plain state
vars like the rest of the app):

1. **Metric toggle** — segmented control: *Pending* (default) / *Paid* / *Detected*;
   drives which value every chart displays (`pending` / `paid` / `detected` on
   `RewardSummary`/`RewardDayEntry`).
2. **Member filter** — dropdown: *All members* (default) + each player from
   `summaryData`; when set, chart B (and optionally A/C) re-fetch with `member_uuid`
   via the existing per-day cache pattern.
3. **Raid type chips** — toggle each of the 5 raids on/off (all on by default);
   charts recompute from already-loaded data (no refetch).
4. **Top N** — small select (5/10/20) for chart C.

No chart-type switcher — each widget keeps a fixed type to avoid option bloat.

## 5. Integration with the existing architecture

The app re-renders **everything** via `innerHTML` on a 60 s poll,
`visibilitychange`, and every cycle/control change — so charts cannot live inside the
HTML-string cycle:

- **New module `frontend/src/charts/`** with:
  - `loader.ts` — dynamic import, single-flight, idle preload (section 2);
  - `theme.ts` — reads `--rune-*`, `--text`, `--bg` via `getComputedStyle`, resolves
    hex at mount;
  - **pure series-builder functions** — `cycleTotalsSeries(summaryData, metric)`,
    `perDayTrendSeries(days, metric, raids)`, `topMembersSeries(...)` — exported pure
    so they're unit-testable with the existing happy-dom setup;
  - `analytics.ts` — renders the view + mounts charts imperatively.
- **Mount key guard:** `analytics.ts` keeps
  `mountKey = `${cycle}:${metric}:${member}:${raids}:${dataRef}``; on re-render, if
  the container exists and the key is unchanged, do nothing (survives the 60 s polls
  without destroying/recreating charts); if changed, `destroy()` existing charts,
  re-render HTML, re-mount.
- **Teardown:** `render()` calls `analytics.teardown()` when leaving the Analytics
  view → `chart.destroy()` on each instance (prevents ResizeObserver/DOM leaks,
  which matter because `$app.innerHTML` wipes the containers).
- **Theme sync:** `mountThemeToggle()` (in `main.ts`) additionally dispatches a small
  `CustomEvent("themechange")`; `analytics.ts` listens and rebuilds charts so they
  follow the existing light/dark toggle. (ApexCharts can't read CSS vars live in all
  versions, so resolve-to-hex + rebuild is the robust approach.)
- **View wiring:** add `"analytics"` to the `View` type, `VIEW_LABELS`, `viewBtnHtml`,
  the render switch, and the `showCyclePicker` condition. `renderAnalytics` follows
  the same loading/error/empty-state pattern as `renderRewards`, reusing
  `fetchData`/`loadSummary` for data.

## 6. Implementation checklist

1. `npm install apexcharts` (v6.10.0); verify subpath exports in `node_modules`.
2. Update `vite.config.ts` (`optimizeDeps.include`).
3. `charts/loader.ts` (dynamic import, single-flight, idle preload) + `charts/theme.ts`.
4. Series-builder pure functions + happy-dom tests for them (aggregation, metric
   mapping, top-N).
5. `charts/analytics.ts` view: HTML shells, controls, mount-key guard, teardown.
6. Wire view tab + cycle picker in `main.ts`; theme-change event.
7. `npm run build` → verify the apexcharts chunk is separate, not in the initial
   payload; measure sizes.
8. Manual pass: switch cycles, filter member/raids, toggle theme, let a 60 s poll hit
   while charts are open.

## 7. Open questions / risks

- **Backend check:** confirm `/api/rewards/per-day` without `member_uuid` returns all
  members (the param is optional in the frontend type, but the endpoint has never been
  called unfiltered — payload size/behaviour needs a quick verify). Guild-scale data
  (~60 members × 10–14 days × 5 raids ≈ 4k rows) is fine if it does.
- **v6 entry points:** exact subpath names to confirm at install time (`apexcharts/line`,
  `apexcharts/bar`, `apexcharts/features/*` — these changed between v5/v6).
- **Watermark:** none of the planned chart types/features are premium, so no license
  needed.
- **Scope:** chart D (status fetch history) and per-member sparklines are explicitly
  deferred; v1 = charts A–C on the Analytics view.

---

## Addendum: framework vs. the DIY SPA (2026-08-18)

Discussion context: should this plan be implemented inside the current vanilla TS
`innerHTML` SPA, or is that architecture the real problem?

**Assessment.** At ~1,550 lines the app is small enough that vanilla works, but the
re-render strategy has known costs: full `innerHTML` re-renders wipe DOM state
(scroll, focus, expanded rows are manually re-tracked), events are re-bound after
every render, a modal focus trap is hand-rolled, and state lives in module-level
mutable variables. Charts add a third lifecycle concern (mount/update/destroy) that a
framework would handle declaratively. The mount-key guard in section 5 is a
workaround for this, not a feature.

**Options considered:**

| Path | When it wins |
|---|---|
| Stay vanilla (extract views into modules, keep mount-key guard) | The tracker is feature-complete after charts; a rewrite would be churn with no user-visible payoff |
| lit-html (~5 KB, declarative templates, targeted DOM patching) | Re-render churn is the only pain and a cheap structural fix is wanted |
| React (user's known framework; reconciliation, component state) | More interactive views/features are expected; migration is cheapest while the app is small |
| Svelte (compiled, tiny runtime, closest to vanilla, reactive lifecycle) | Same as React, if the maintainer is open to a new framework |

**Decision (2026-08-18): stay vanilla.** The user is comfortable with React only,
and judged the rewrite not worth it for a tool this size. As a mitigation, the
background-poll churn was fixed at the source: `fetchData()` now computes a
signature of everything that affects the rendered UI (`dataSignature()` in
`main.ts`) and skips `render()` entirely when a poll found no changes. Quiet polls
are now no-ops (no focus/scroll/input loss); full re-renders only happen when data
actually changed or a fetch failed. Bonus: `usersData` was missing from the
`renderSettings` null-guard — fixed (pre-existing `tsc` errors are now gone).
Consequences for this plan:

- The mount-key guard in section 5 is still needed (data *can* change), but its
  mount-key should be an **update-key**: on data-only changes, prefer
  `chart.updateSeries()`/`updateOptions()` over destroy+remount to avoid a flash.
- React remains the fallback if the app grows; the port would keep `api.ts` and
  `charts/loader.ts`/`theme.ts`/series builders as-is.
