import {
  fetchRewardSummary,
  fetchRewardPerDay,
  fetchPayoutRecords,
  fetchServerStatus,
  fetchRewardDefinitions,
  updateRewardDefinition,
  createPayout,
  voidPayoutRecord,
  fetchDiscordLoginUrl,
  fetchCurrentUser,
  triggerFetch,
  setToken,
  clearToken,
  getToken,
  isAuthenticated,
  type RewardSummary,
  type RewardDay,
  type RewardDayEntry,
  type PayoutRecord,
  type ServerStatus,
  type CurrentUser,
  type RewardDefinition,
  RAID_RUNES,
} from "./api.js";

type View = "rewards" | "payouts" | "status" | "settings";
type Range = "7d" | "14d" | "30d" | "all" | "custom";

const RAID_TYPES = ["notg", "nol", "tcc", "tna", "wtp"];
const VIEW_LABELS: Record<View, string> = {
  rewards: "Rewards",
  payouts: "Payouts",
  status: "Status",
  settings: "Settings",
};

const hashParams = new URLSearchParams(location.hash.slice(1));
const tokenParam = hashParams.get("token");
const params = new URLSearchParams(location.search);
const errorParam = params.get("error");
if (tokenParam) {
  setToken(tokenParam);
  const url = new URL(location.href);
  url.hash = "";
  history.replaceState(null, "", url.href);
}
if (errorParam === "unauthorized") {
  const url = new URL(location.href);
  url.searchParams.delete("error");
  history.replaceState(null, "", url.href);
}

let currentView: View = (params.get("view") as View) ?? "rewards";
let currentRange: Range = (params.get("range") as Range) ?? "7d";

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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

const _now = new Date();
const _defaultFrom = new Date(_now);
_defaultFrom.setDate(_defaultFrom.getDate() - 7);
let customFrom = params.get("from") ?? params.get("custom-from") ?? isoDate(_defaultFrom);
let customTo = params.get("to") ?? params.get("custom-to") ?? isoDate(_now);
let summaryData: RewardSummary[] | null = null;
let perDayData: RewardDay[] | null = null;
let payoutsData: PayoutRecord[] | null = null;
let statusData: ServerStatus | null = null;
let rewardDefs: RewardDefinition[] | null = null;
let isFetching = false;
let fetchError: string | null = null;
let expandedMember: string | null = null;
let perDayCache = new Map<string, RewardDay[] | null>();
let perDayLoading = new Set<string>();
let voidingPayoutId: number | null = null;
let payingMember: string | null = null;
let confirmingVoidId: number | null = null;
let savingDefId: number | null = null;
let currentUser: CurrentUser | null = null;

function now(): Date {
  return new Date();
}

function rangeFrom(r: Range): { from: Date; to: Date } {
  const to = now();
  if (r === "custom" && customFrom && customTo) {
    const from = new Date(`${customFrom}T00:00:00`);
    const toEnd = new Date(`${customTo}T23:59:59.999`);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(toEnd.getTime()) && from <= toEnd) {
      return { from, to: toEnd };
    }
  }
  const from = new Date(to);
  if (r === "7d") from.setDate(from.getDate() - 7);
  else if (r === "14d") from.setDate(from.getDate() - 14);
  else if (r === "30d") from.setDate(from.getDate() - 30);
  else from.setFullYear(from.getFullYear() - 10);
  return { from, to };
}

function fmtISO(d: Date): string {
  return d.toISOString();
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s.toFixed(0)}s` : `${m}m`;
}

function fmtAgo(iso: string): string {
  const diff = now().getTime() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
}

function capFor(raidType: string): number | null {
  return rewardDefs?.find((d) => d.raid_type === raidType)?.daily_cap ?? null;
}

const $app = document.getElementById("app")!;

function viewBtnHtml(view: View) {
  return `<button class="view-btn${currentView === view ? " active" : ""}" data-view="${escapeHtml(view)}">${VIEW_LABELS[view]}</button>`;
}

function rangeBtnHtml(r: Range, label: string) {
  return `<button class="range-btn${currentRange === r ? " active" : ""}" data-range="${escapeHtml(r)}">${label}</button>`;
}

function runeTag(rune: string, color: string) {
  return `<span class="rune-tag" style="--rune-color: ${color}">${rune}</span>`;
}

function render() {
  if (!isAuthenticated() && !currentUser) {
    renderLogin();
    return;
  }

  const { from, to } = rangeFrom(currentRange);
  const showRange = currentView !== "status";

  const userHtml = currentUser
    ? `<div class="user-info">
        ${currentUser.avatar_url
          ? `<img class="user-avatar" src="${escapeHtml(currentUser.avatar_url)}" alt="" width="24" height="24">`
          : `<span class="user-avatar-fallback">${escapeHtml(currentUser.username[0]?.toUpperCase() ?? "?")}</span>`}
        <span class="user-name">${escapeHtml(currentUser.username)}</span>
        <button class="btn-logout" id="logout-btn">Log out</button>
      </div>`
    : "";

  $app.innerHTML = `
    <header class="header">
      <div class="header-row">
        <h1 class="title">Guild Raid&nbsp;Tracker</h1>
        ${userHtml}
      </div>
      <p class="subtitle">Per-day completions · capped rune payouts</p>
    </header>

    <main class="main">
      <div class="controls">
        <div class="view-toggle">${viewBtnHtml("rewards")}${viewBtnHtml("payouts")}${viewBtnHtml("status")}${currentUser?.is_admin ? viewBtnHtml("settings") : ""}</div>
        ${showRange
          ? `<div class="range-group">${rangeBtnHtml("7d", "7 days")}${rangeBtnHtml("14d", "14 days")}${rangeBtnHtml("30d", "30 days")}${rangeBtnHtml("all", "All time")}${rangeBtnHtml("custom", "Custom")}</div>
             ${currentRange === "custom"
                ? `<div class="custom-range">
                     <label class="date-field">
                       <span>From</span>
                       <input type="date" id="range-from" value="${escapeHtml(customFrom)}" max="${escapeHtml(customTo)}">
                     </label>
                     <label class="date-field">
                       <span>To</span>
                       <input type="date" id="range-to" value="${escapeHtml(customTo)}" min="${escapeHtml(customFrom)}">
                     </label>
                   </div>`
               : ""}`
          : ""}
      </div>

      <div id="content" class="content-area"></div>
    </main>

    <div id="status-bar" class="status-bar"></div>
  `;

  document.getElementById("logout-btn")?.addEventListener("click", async () => {
    const token = getToken();
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
    } catch {
      // proceed with logout regardless
    }
    clearToken();
    currentUser = null;
    window.location.reload();
  });

  document.querySelectorAll(".view-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      currentView = (btn as HTMLElement).dataset.view as View;
      expandedMember = null;
      confirmingVoidId = null;
      const url = new URL(location.href);
      url.searchParams.set("view", currentView);
      history.replaceState(null, "", url.href);
      render();
      fetchData();
    })
  );

  document.querySelectorAll(".range-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      currentRange = (btn as HTMLElement).dataset.range as Range;
      expandedMember = null;
      const url = new URL(location.href);
      url.searchParams.set("range", currentRange);
      if (currentRange !== "custom") {
        url.searchParams.delete("custom-from");
        url.searchParams.delete("custom-to");
        url.searchParams.delete("from");
        url.searchParams.delete("to");
      }
      history.replaceState(null, "", url.href);
      render();
      fetchData();
    })
  );

  const applyCustomRange = () => {
    const $from = document.getElementById("range-from") as HTMLInputElement | null;
    const $to = document.getElementById("range-to") as HTMLInputElement | null;
    if (!$from || !$to) return;
    if (!$from.value && !$to.value) return;
    if (!$from.value) $from.value = customFrom;
    if (!$to.value) $to.value = customTo;
    if ($from.value > $to.value) $to.value = $from.value;
    customFrom = $from.value;
    customTo = $to.value;
    currentRange = "custom";
    expandedMember = null;
    const url = new URL(location.href);
    url.searchParams.set("range", "custom");
    url.searchParams.set("custom-from", customFrom);
    url.searchParams.set("custom-to", customTo);
    history.replaceState(null, "", url.href);
    render();
    fetchData();
  };

  document.getElementById("range-from")?.addEventListener("change", applyCustomRange);
  document.getElementById("range-to")?.addEventListener("change", applyCustomRange);

  const $contentEl = document.getElementById("content")!;
  const $statusBarEl = document.getElementById("status-bar")!;

  if (currentView === "rewards") {
    renderRewards($contentEl, $statusBarEl);
  } else if (currentView === "payouts") {
    renderPayouts($contentEl, $statusBarEl);
  } else if (currentView === "settings") {
    renderSettings($contentEl, $statusBarEl);
  } else {
    renderStatus($contentEl, $statusBarEl);
  }
}

function renderLogin() {
  const wasDenied = errorParam === "unauthorized";

  $app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <h1 class="login-title">Guild Raid&nbsp;Tracker</h1>
        <p class="login-desc">Sign in with Discord to continue</p>
        ${wasDenied ? `<p class="login-error">Your Discord account is not authorized. Ask an admin to add them.</p>` : ""}
        <button class="btn-discord" id="login-btn">Login with Discord</button>
      </div>
    </div>
  `;

  document.getElementById("login-btn")?.addEventListener("click", async () => {
    const $btn = document.getElementById("login-btn") as HTMLButtonElement | null;
    if ($btn) {
      $btn.disabled = true;
      $btn.textContent = "Connecting…";
    }
    try {
      const url = await fetchDiscordLoginUrl();
      window.location.href = url;
    } catch (err) {
      showToast(`Login failed: ${err instanceof Error ? err.message : "error"}`);
      if ($btn) {
        $btn.disabled = false;
        $btn.textContent = "Login with Discord";
      }
    }
  });
}

// ── Rewards view ───────────────────────────────────────────────

function renderRewards($el: HTMLElement, $status: HTMLElement) {
  const { from, to } = rangeFrom(currentRange);

  if (isFetching) {
    $status.innerHTML = `<span class="status-info">${fmtDate(fmtISO(from))} — ${fmtDate(fmtISO(to))}</span>`;
    $el.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading rewards…</p></div>`;
    return;
  }

  if (summaryData === null) {
    if (fetchError) {
      $status.innerHTML = `<span class="status-info">${fmtDate(fmtISO(from))} — ${fmtDate(fmtISO(to))}</span>`;
      $el.innerHTML = `<div class="error-state"><p>Failed to load rewards</p><p class="error-detail">${escapeHtml(fetchError)}</p><button class="btn-retry">Retry</button></div>`;
      document.querySelector(".btn-retry")?.addEventListener("click", () => fetchData(), { once: true });
      return;
    }
    $el.innerHTML = `<div class="empty"><p>No data in this period.</p></div>`;
    return;
  }

  const byMember = new Map<string, RewardSummary[]>();
  for (const item of summaryData) {
    const list = byMember.get(item.member_uuid);
    if (list) list.push(item);
    else byMember.set(item.member_uuid, [item]);
  }
  const eligibleMembers: Array<[string, RewardSummary[]]> = [];
  const ineligibleMembers: Array<[string, RewardSummary[]]> = [];
  for (const entry of byMember.entries()) {
    if (entry[1][0]!.is_eligible) eligibleMembers.push(entry);
    else ineligibleMembers.push(entry);
  }
  const totalOf = (rows: RewardSummary[]) => rows.reduce((s, r) => s + r.pending, 0);
  eligibleMembers.sort((a, b) => totalOf(b[1]) - totalOf(a[1]));
  ineligibleMembers.sort((a, b) => totalOf(b[1]) - totalOf(a[1]));
  const members = eligibleMembers.concat(ineligibleMembers);
  const totalPending = eligibleMembers.reduce((s, entry) => s + totalOf(entry[1]), 0);

  $status.innerHTML = `
    <span class="status-info">${fmtDate(fmtISO(from))} — ${fmtDate(fmtISO(to))}</span>
    <span class="status-summary">${members.length} players · ${totalPending} runs pending</span>
  `;

  if (members.length === 0) {
    $el.innerHTML = `<div class="empty"><p>No completions in this period.</p></div>`;
    return;
  }

  let html = `<div class="table-wrap"><table class="raid-table rewards-table">
    <colgroup>
      <col class="col-name">
      <col class="col-rank">
      ${RAID_TYPES.map(() => `<col class="col-raid">`).join("")}
      <col class="col-pending">
      <col class="col-action">
    </colgroup>
    <thead>
      <tr>
        <th class="col-member">Player</th>
        <th>Rank</th>
        ${RAID_TYPES.map((rt) => {
          const info = RAID_RUNES[rt]!;
          const cap = capFor(rt);
          return `<th>${info.rune}<span class="rune-label">${rt}${cap !== null ? ` · cap ${cap}` : ""}</span></th>`;
        }).join("")}
        <th>Pending</th>
        <th class="col-action"></th>
      </tr>
    </thead>
    <tbody>
  `;

  for (const [uuid, rows] of eligibleMembers) {
    html += memberRowHtml(uuid, rows);
  }

  if (ineligibleMembers.length > 0) {
    html += `<tr class="section-row"><td colspan="${RAID_TYPES.length + 4}">
        <span class="section-label">No payouts (view-only)</span>
      </td></tr>`;
    for (const [uuid, rows] of ineligibleMembers) {
      html += memberRowHtml(uuid, rows);
    }
  }

  const raidPending = RAID_TYPES.map((rt) =>
    eligibleMembers.reduce(
      (s, [, rows]) => s + (rows.find((r) => r.raid_type === rt)?.pending ?? 0),
      0,
    ),
  );

  html += `</tbody>
    <tfoot>
      <tr class="summary-row">
        <td class="col-member summary-label">Totals</td>
        <td></td>
        ${raidPending.map((n) => `<td class="overview-cell summary-cell">${n}</td>`).join("")}
        <td class="summary-total">${totalPending}</td>
        <td class="col-action"></td>
      </tr>
    </tfoot>
  </table></div>`;
  $el.innerHTML = html;

  document.querySelectorAll(".member-row").forEach((row) => {
    const toggle = () => {
      const uuid = (row as HTMLElement).dataset.member!;
      if (expandedMember === uuid) {
        expandedMember = null;
        renderRewards($el, $status);
      } else {
        expandedMember = uuid;
        renderRewards($el, $status);
        void loadPerDay(uuid);
      }
    };
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-pay]")) return;
      toggle();
    });
    row.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" || ke.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  });

  document.querySelectorAll(".btn-pay").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const uuid = (e.currentTarget as HTMLElement).dataset.pay!;
      void payMember(uuid);
    })
  );
}

function capCellHtml(p: { detected: number; payable: number; cap: number | null; pending?: number }): string {
  const over = p.cap !== null && p.detected > p.payable;
  const overCount = p.detected - p.payable;
  const pending = p.pending;
  return `<td class="overview-cell${over ? " over-limit-cell" : ""}">
    <span class="cell-payable">${p.payable}</span>
    ${over ? `<span class="over-limit-badge">${overCount} over</span>` : ""}
    ${pending ? `<span class="cell-pending"> · ${pending} pending</span>` : ""}
  </td>`;
}

function memberRowHtml(uuid: string, rows: RewardSummary[]): string {
  const first = rows[0]!;
  const eligible = first.is_eligible;
  const byRaid = new Map<string, RewardSummary>(rows.map((r) => [r.raid_type, r]));
  const pending = rows.reduce((s, r) => s + r.pending, 0);
  const expanded = expandedMember === uuid;
  const paying = payingMember === uuid;

  let html = `<tr class="member-row ${expanded ? "selected" : ""}${eligible ? "" : " ineligible"}" data-member="${escapeHtml(uuid)}" tabindex="0">
    <td class="col-member"><span class="member-name">${escapeHtml(first.username)}</span></td>
    <td><span class="rank-tag${eligible ? "" : " no-payout"}">${escapeHtml(first.rank)}</span></td>
    ${RAID_TYPES.map((rt) => {
      const row = byRaid.get(rt);
      if (!row) return `<td class="overview-cell">—</td>`;
      if (!eligible) {
        return `<td class="overview-cell"><span class="cell-payable">${row.detected}</span></td>`;
      }
      return capCellHtml({ detected: row.detected, payable: row.payable, cap: row.daily_cap });
    }).join("")}
    <td><span class="total-runes">${pending}</span></td>
    <td class="col-action">
      ${eligible && pending > 0
        ? `<button class="btn-pay" data-pay="${escapeHtml(uuid)}" ${paying ? "disabled" : ""}>${paying ? "Paying…" : `Pay ${pending}`}</button>`
        : `<span class="text-muted-cell">${eligible ? "—" : "no payout"}</span>`}
    </td>
  </tr>`;

  if (expanded) {
    html += `<tr class="payout-detail"><td colspan="${RAID_TYPES.length + 4}">
      <div class="day-table-wrap">${renderDayBreakdown(uuid)}</div>
    </td></tr>`;
  }
  return html;
}

function renderDayBreakdown(uuid: string): string {
  if (perDayLoading.has(uuid)) {
    return `<div class="loading-state"><div class="spinner"></div><p>Loading per-day details…</p></div>`;
  }
  const cached = perDayCache.get(uuid);
  if (cached === undefined) {
    return `<div class="loading-state"><div class="spinner"></div><p>Loading per-day…</p></div>`;
  }
  if (cached === null) {
    return `<div class="empty"><p>No per-day data.</p></div>`;
  }

  const byDay = new Map<string, Map<string, RewardDayEntry>>();
  const days: string[] = [];
  for (const day of cached) {
    days.push(day.day);
    const perRaid = new Map<string, RewardDayEntry>();
    for (const e of day.entries) {
      if (e.member_uuid === uuid) perRaid.set(e.raid_type, e);
    }
    byDay.set(day.day, perRaid);
  }
  const visibleDays = constrainRangeDays(days);

  let html = `<div class="legend">
    <span class="legend-item"><span class="legend-swatch" style="background: color-mix(in srgb, var(--rune-tcc) 22%, transparent)"></span> over daily cap</span>
  </div>
  <div class="table-wrap"><table class="raid-table day-table">
    <colgroup>
      <col class="col-day">
      ${RAID_TYPES.map(() => `<col class="col-raid">`).join("")}
    </colgroup>
    <thead>
      <tr>
        <th class="col-member">Day</th>
        ${RAID_TYPES.map((rt) => {
          const info = RAID_RUNES[rt]!;
          return `<th>${info.rune}<span class="rune-label">${rt}</span></th>`;
        }).join("")}
      </tr>
    </thead>
    <tbody>
  `;

  for (const day of visibleDays) {
    const perRaid = byDay.get(day);
    html += `<tr><td class="col-member"><span class="member-name">${fmtDay(day)}</span></td>`;
    for (const rt of RAID_TYPES) {
      const e = perRaid?.get(rt);
      if (!e) {
        html += `<td>—</td>`;
        continue;
      }
      if (!e.is_eligible) {
        html += `<td class="overview-cell"><span class="cell-payable">${e.detected}</span></td>`;
        continue;
      }
      html += capCellHtml({ detected: e.detected, payable: e.payable, cap: e.daily_cap, pending: e.pending });
    }
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

function constrainRangeDays(days: string[]): string[] {
  const sorted = [...days].sort();
  const max = 14;
  if (sorted.length <= max) return sorted;
  return sorted.slice(-max);
}

async function loadPerDay(uuid: string) {
  if (perDayCache.has(uuid)) {
    render();
    return;
  }
  perDayLoading.add(uuid);
  perDayCache.set(uuid, []);
  render();

  const { from, to } = rangeFrom(currentRange);
  try {
    const data = await fetchRewardPerDay(fmtISO(from), fmtISO(to), uuid);
    perDayCache.set(uuid, data);
  } catch (err) {
    perDayCache.set(uuid, null);
    const msg = err instanceof Error ? err.message : "error";
    showToast(`Failed to load per-day details: ${msg}`);
  }
  perDayLoading.delete(uuid);
  render();
}

async function payMember(uuid: string) {
  const rows = (summaryData ?? []).filter((r) => r.member_uuid === uuid);
  const items = rows
    .filter((r) => r.pending > 0 && r.is_eligible)
    .map((r) => ({ member_uuid: uuid, raid_type: r.raid_type, count: r.pending }));

  if (items.length === 0) {
    showToast("Nothing pending for this player");
    return;
  }

  payingMember = uuid;
  render();

  const { from, to } = rangeFrom(currentRange);
  try {
    const result = await createPayout({ starts_at: fmtISO(from), ends_at: fmtISO(to), items });
    const total = result.reduce((s, c) => s + c.count_paid, 0);
    payingMember = null;
    await fetchData();
    showToast(`Paid out ${total} rune(s) across ${result.length} day chunk(s)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    payingMember = null;
    render();
    showToast(`Payout failed: ${msg}`);
  }
}

async function loadSummary() {
  const { from, to } = rangeFrom(currentRange);
  summaryData = await fetchRewardSummary(fmtISO(from), fmtISO(to));
}

// ── Payouts view ───────────────────────────────────────────────

function voidActionHtml(p: PayoutRecord): string {
  if (!currentUser?.is_admin) return `<span class="text-muted-cell">—</span>`;
  if (voidingPayoutId === p.id) {
    return `<button class="btn-pay btn-pay-busy" disabled><span class="btn-spinner"></span>Voiding…</button>`;
  }
  if (confirmingVoidId === p.id) {
    return `<button class="btn-pay btn-pay-confirm" data-void="${p.id}">Confirm void?</button>`;
  }
  return `<button class="btn-pay" data-void="${p.id}">Void</button>`;
}

function renderPayouts($el: HTMLElement, $status: HTMLElement) {
  $status.innerHTML = `<span class="status-info">Payout history</span>`;

  if (isFetching) {
    $el.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading payouts…</p></div>`;
    return;
  }

  if (payoutsData === null) {
    if (fetchError) {
      $el.innerHTML = `<div class="error-state"><p>Failed to load payouts</p><p class="error-detail">${escapeHtml(fetchError)}</p><button class="btn-retry">Retry</button></div>`;
      document.querySelector(".btn-retry")?.addEventListener("click", () => fetchData(), { once: true });
      return;
    }
    $el.innerHTML = `<div class="empty"><p>No payouts recorded yet.</p></div>`;
    return;
  }

  if (payoutsData.length === 0) {
    $el.innerHTML = `<div class="empty"><p>No payouts recorded yet.</p></div>`;
    return;
  }

  let html = `<div class="table-wrap"><table class="raid-table">
    <thead>
      <tr>
        <th>Paid at</th>
        <th class="col-member">Player</th>
        <th>Raid</th>
        <th>Day</th>
        <th>Runes</th>
        <th class="col-member">Paid by</th>
        <th class="col-action"></th>
      </tr>
    </thead>
    <tbody>
  `;

  for (const p of payoutsData) {
    const info = RAID_RUNES[p.raid_type] ?? { rune: p.raid_type, color: "var(--text-muted)" };
    html += `<tr class="${voidingPayoutId === p.id ? "voiding" : ""}">
      <td>${fmtDate(p.paid_at)}</td>
      <td class="col-member"><span class="member-name">${escapeHtml(p.member_username)}</span></td>
      <td class="overview-cell">${runeTag(info.rune, info.color)}</td>
      <td>${fmtDay(p.day)}</td>
      <td>${p.count_paid}</td>
      <td class="col-member">${p.paid_by_username ? escapeHtml(p.paid_by_username) : "—"}</td>
      <td class="col-action">${voidActionHtml(p)}</td>
    </tr>`;
  }

  html += `</tbody></table></div>`;
  $el.innerHTML = html;

  document.querySelectorAll("[data-void]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = Number((e.currentTarget as HTMLElement).dataset.void);
      if (confirmingVoidId === id) {
        confirmingVoidId = null;
        void handleVoid(id);
      } else {
        confirmingVoidId = id;
        renderPayouts($el, $status);
      }
    });
  });
}

async function handleVoid(payoutId: number) {
  voidingPayoutId = payoutId;
  confirmingVoidId = null;
  render();
  try {
    await voidPayoutRecord(payoutId);
    const { from, to } = rangeFrom(currentRange);
    payoutsData = await fetchPayoutRecords();
    if (currentView === "payouts") {
      render();
    } else {
      summaryData = await fetchRewardSummary(fmtISO(from), fmtISO(to));
      render();
    }
    showToast("Payout voided");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    showToast(`Failed to void payout: ${msg}`);
  }
  voidingPayoutId = null;
  render();
}

// ── Status view ────────────────────────────────────────────────

function renderStatus($el: HTMLElement, $status: HTMLElement) {
  $status.innerHTML = `<span class="status-info">Server status</span>`;

  if (isFetching) {
    $el.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading status…</p></div>`;
    return;
  }

  if (!statusData) {
    if (fetchError) {
      $el.innerHTML = `<div class="error-state"><p>Failed to load status</p><p class="error-detail">${escapeHtml(fetchError)}</p><button class="btn-retry">Retry</button></div>`;
      document.querySelector(".btn-retry")?.addEventListener("click", () => fetchData(), { once: true });
      return;
    }
    $el.innerHTML = `<div class="empty"><p>No status data available.</p></div>`;
    return;
  }

  const latest = statusData.latest_fetch;
  const uptimePct = statusData.total_fetches > 0
    ? Math.round((statusData.total_ok / statusData.total_fetches) * 100)
    : 100;

  let html = `
    <div class="table-wrap" style="margin-bottom: 1.5rem">
      <div class="status-grid">
        <div class="stat-card">
          <span class="stat-value">${statusData.total_fetches}</span>
          <span class="stat-label">Total Fetches</span>
        </div>
        <div class="stat-card">
          <span class="stat-value" style="color: var(--rune-wtp)">${uptimePct}%</span>
          <span class="stat-label">Success Rate</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${statusData.total_errors}</span>
          <span class="stat-label">Errors</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${latest ? fmtAgo(latest.started_at) : "—"}</span>
          <span class="stat-label">Last Fetch</span>
        </div>
      </div>
    </div>
    <div class="fetch-bar">
      <button id="fetch-now-btn" class="btn-fetch">Fetch Now</button>
    </div>
  `;

  if (latest) {
    const duration = latest.duration_seconds ? fmtDuration(latest.duration_seconds) : "—";
    const members = latest.snapshot_count ?? "—";
    html += `<div class="status-detail">
      <p><strong>Latest fetch</strong> — ${fmtDate(latest.started_at)} (${fmtAgo(latest.started_at)})</p>
      <p>Took ${duration} · ${members} members (${latest.restricted_count ?? 0} restricted) · status: ${escapeHtml(latest.status)}
    </p></div>`;
  }

  html += `<div class="table-wrap"><table class="raid-table fetch-table">
    <thead>
      <tr>
        <th>Time</th>
        <th>Duration</th>
        <th>Members</th>
        <th>Restricted</th>
        <th>Status</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>
  `;

  for (const log of statusData.recent_fetches) {
    const dur = log.duration_seconds ? fmtDuration(log.duration_seconds) : "—";
    const members = log.snapshot_count ?? "—";
    const restricted = log.restricted_count ?? "—";
    const statusClass = log.status === "ok" ? "tag-ok" : log.status === "error" ? "tag-err" : "tag-run";
    const statusLabel = escapeHtml(log.status === "running" ? "running…" : log.status);
    html += `<tr>
      <td>${fmtDate(log.started_at)}</td>
      <td>${dur}</td>
      <td>${members}</td>
      <td>${restricted}</td>
      <td><span class="status-tag ${statusClass}">${statusLabel}</span></td>
      <td class="err-cell">${log.error_message ? escapeHtml(log.error_message.slice(0, 60)) : "—"}</td>
    </tr>`;
  }

  html += `</tbody></table></div>`;
  $el.innerHTML = html;

  document.getElementById("fetch-now-btn")?.addEventListener("click", handleFetchNow);
}

// ── Settings view ──────────────────────────────────────────────

function renderSettings($el: HTMLElement, $status: HTMLElement) {
  $status.innerHTML = `<span class="status-info">Reward settings</span>`;

  if (!currentUser?.is_admin) {
    $el.innerHTML = `<div class="error-state"><p>Admin access required.</p></div>`;
    return;
  }

  if (rewardDefs === null) {
    $el.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading settings…</p></div>`;
    return;
  }

  let html = `
    <div class="settings-intro"><p>Daily caps per raid. Caps limit how many completions count toward a payout per member per day. Leave empty for unlimited.</p></div>
    <div class="table-wrap"><table class="raid-table settings-table">
      <thead>
        <tr>
          <th>Raid</th>
          <th>Name</th>
          <th>Daily cap</th>
          <th class="col-action"></th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const def of rewardDefs) {
    const info = RAID_RUNES[def.raid_type];
    const saving = savingDefId === def.id;
    html += `<tr>
      <td class="overview-cell">${info ? runeTag(info.rune, info.color) : escapeHtml(def.raid_type)}</td>
      <td>${escapeHtml(def.display_name)}</td>
      <td><input class="settings-input settings-cap" type="number" min="0" data-def="${def.id}" value="${def.daily_cap ?? ""}" placeholder="unlimited"></td>
      <td class="col-action">
        <button class="btn-pay settings-save" data-def="${def.id}" ${saving ? "disabled" : ""}>${saving ? "Saving…" : "Save"}</button>
      </td>
    </tr>`;
  }

  html += `</tbody></table></div>`;
  $el.innerHTML = html;

  document.querySelectorAll(".settings-save").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number((btn as HTMLElement).dataset.def);
      const $cap = document.querySelector(`.settings-cap[data-def="${id}"]`) as HTMLInputElement | null;
      if (!$cap) return;

      const capRaw = $cap.value.trim();
      const daily_cap = capRaw === "" ? null : Math.max(0, Math.floor(Number(capRaw) || 0));

      savingDefId = id;
      renderSettings($el, $status);
      try {
        await updateRewardDefinition(id, { daily_cap });
        rewardDefs = await fetchRewardDefinitions();
        showToast("Settings saved");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "error";
        showToast(`Failed to save: ${msg}`);
      }
      savingDefId = null;
      renderSettings($el, $status);
    });
  });
}

// ── Fetch now action ───────────────────────────────────────────

async function handleFetchNow() {
  const $btn = document.getElementById("fetch-now-btn") as HTMLButtonElement | null;

  if ($btn) {
    $btn.disabled = true;
    $btn.textContent = "Fetching…";
  }

  try {
    const result = await triggerFetch();
    statusData = await fetchServerStatus();
    showToast(
      result.status === "ok"
        ? `Fetch complete: ${result.snapshot_count} members, ${result.restricted_count} restricted`
        : `Fetch returned: ${result.status}`,
    );
    render();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    showToast(`Fetch failed: ${msg}`);
    if ($btn) {
      $btn.disabled = false;
      $btn.textContent = "Fetch Now";
    }
  }
}

// ── Toast ──────────────────────────────────────────────────────

function showToast(msg: string) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.remove("visible");
  requestAnimationFrame(() => {
    toast!.classList.add("visible");
  });
  setTimeout(() => toast!.classList.remove("visible"), 3500);
}

// ── Data fetching ──────────────────────────────────────────────

async function fetchData() {
  if (!isAuthenticated() && !currentUser) {
    render();
    return;
  }

  isFetching = true;
  fetchError = null;
  render();

  try {
    if (rewardDefs === null) {
      rewardDefs = await fetchRewardDefinitions();
    }
    if (currentView === "rewards") {
      await loadSummary();
    }
    payoutsData = await fetchPayoutRecords();
    statusData = await fetchServerStatus();
    fetchError = null;
  } catch (err) {
    if (!isAuthenticated()) {
      currentUser = null;
    }
    const msg = err instanceof Error ? err.message : "An error occurred";
    fetchError = msg;
    showToast(`Failed to load data: ${msg}`);
  }

  isFetching = false;
  render();
}

// ── Init ───────────────────────────────────────────────────────

async function init() {
  try {
    currentUser = await fetchCurrentUser();
  } catch {
    if (!isAuthenticated()) {
      currentUser = null;
    }
  }

  document.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Escape" && confirmingVoidId !== null) {
      confirmingVoidId = null;
      render();
    }
  });

  if (currentUser || isAuthenticated()) {
    render();
    fetchData();
    setInterval(fetchData, 60000);
  } else {
    render();
  }
}

init();