import {
  fetchPendingRewards,
  fetchPayouts,
  fetchServerStatus,
  createPayout,
  voidPayout,
  fetchDiscordLoginUrl,
  fetchCurrentUser,
  triggerFetch,
  setToken,
  clearToken,
  isAuthenticated,
  type PendingRewardItem,
  type PayoutEvent,
  type ServerStatus,
  type CurrentUser,
  RAID_RUNES,
} from "./api.js";

type View = "pending" | "history" | "status";
type Range = "7d" | "14d" | "30d" | "all" | "custom";

const RAID_TYPES = ["notg", "nol", "tcc", "tna", "wtp"];
const VIEW_LABELS: Record<View, string> = {
  pending: "Pending Rewards",
  history: "Payout History",
  status: "Status",
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

let currentView: View = (params.get("view") as View) ?? "pending";
let currentRange: Range = (params.get("range") as Range) ?? "7d";

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const _now = new Date();
const _defaultFrom = new Date(_now);
_defaultFrom.setDate(_defaultFrom.getDate() - 7);
let customFrom = params.get("from") ?? isoDate(_defaultFrom);
let customTo = params.get("to") ?? isoDate(_now);
let pendingData: PendingRewardItem[] | null = null;
let payoutsData: PayoutEvent[] | null = null;
let statusData: ServerStatus | null = null;
let isFetching = false;
let fetchError: string | null = null;
let selected: Set<string> = new Set();
let animateRows = true;
let confirmingPayoutId: number | null = null;
let expandedPayoutId: number | null = null;
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

function groupByMember(items: PendingRewardItem[] | null): Map<string, { username: string; raids: Record<string, number> }> {
  const map = new Map<string, { username: string; raids: Record<string, number> }>();
  if (!items) return map;
  for (const item of items) {
    const key = item.member_uuid;
    if (!map.has(key)) {
      map.set(key, { username: item.username, raids: {} });
    }
    const entry = map.get(key)!;
    entry.raids[item.raid_type] = (entry.raids[item.raid_type] ?? 0) + item.count_pending;
  }
  return map;
}

function totalRunes(raids: Record<string, number>): number {
  return Object.values(raids).reduce((a, b) => a + b, 0);
}

function selectionKey(uuid: string): string {
  return uuid;
}

function isSelected(uuid: string): boolean {
  return selected.has(selectionKey(uuid));
}

function toggleSelect(uuid: string) {
  const k = selectionKey(uuid);
  if (selected.has(k)) selected.delete(k);
  else selected.add(k);
}

const $app = document.getElementById("app")!;

function viewBtnHtml(view: View) {
  return `<button class="view-btn${currentView === view ? " active" : ""}" data-view="${view}">${VIEW_LABELS[view]}</button>`;
}

function rangeBtnHtml(r: Range, label: string) {
  return `<button class="range-btn${currentRange === r ? " active" : ""}" data-range="${r}">${label}</button>`;
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
          ? `<img class="user-avatar" src="${currentUser.avatar_url}" alt="" width="24" height="24">`
          : `<span class="user-avatar-fallback">${currentUser.username[0]?.toUpperCase() ?? "?"}</span>`}
        <span class="user-name">${currentUser.username}</span>
        <button class="btn-logout" id="logout-btn">Log out</button>
      </div>`
    : "";

  $app.innerHTML = `
    <header class="header">
      <div class="header-row">
        <h1 class="title">Guild Raid&nbsp;Tracker</h1>
        ${userHtml}
      </div>
      <p class="subtitle">Track completions &amp; payout runes</p>
    </header>

    <main class="main">
      <div class="controls">
        <div class="view-toggle">${viewBtnHtml("pending")}${viewBtnHtml("history")}${viewBtnHtml("status")}</div>
        ${showRange
          ? `<div class="range-group">${rangeBtnHtml("7d", "7 days")}${rangeBtnHtml("14d", "14 days")}${rangeBtnHtml("30d", "30 days")}${rangeBtnHtml("all", "All time")}${rangeBtnHtml("custom", "Custom")}</div>
             ${currentRange === "custom"
               ? `<div class="custom-range">
                    <label class="date-field">
                      <span>From</span>
                      <input type="date" id="range-from" value="${customFrom}" max="${customTo}">
                    </label>
                    <label class="date-field">
                      <span>To</span>
                      <input type="date" id="range-to" value="${customTo}" min="${customFrom}">
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
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // proceed with logout regardless
    }
    clearToken();
    window.location.reload();
  });

  document.querySelectorAll(".view-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      currentView = (btn as HTMLElement).dataset.view as View;
      selected.clear();
      confirmingPayoutId = null;
      animateRows = true;
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
      selected.clear();
      animateRows = true;
      const url = new URL(location.href);
      url.searchParams.set("range", currentRange);
      if (currentRange !== "custom") {
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
    selected.clear();
    animateRows = true;
    const url = new URL(location.href);
    url.searchParams.set("range", "custom");
    url.searchParams.set("from", customFrom);
    url.searchParams.set("to", customTo);
    history.replaceState(null, "", url.href);
    render();
    fetchData();
  };

  document.getElementById("range-from")?.addEventListener("change", applyCustomRange);
  document.getElementById("range-to")?.addEventListener("change", applyCustomRange);

  const $contentEl = document.getElementById("content")!;
  const $statusBarEl = document.getElementById("status-bar")!;

  if (currentView === "pending") {
    renderPending($contentEl, $statusBarEl, from, to);
  } else if (currentView === "history") {
    renderHistory($contentEl, $statusBarEl);
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
        ${wasDenied ? `<p class="login-error">Your Discord account is not authorized. Ask an admin to add you.</p>` : ""}
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

// ── Pending view ───────────────────────────────────────────────

function renderPending($el: HTMLElement, $status: HTMLElement, from: Date, to: Date) {
  if (isFetching) {
    $status.innerHTML = `<span class="status-info">${fmtDate(fmtISO(from))} — ${fmtDate(fmtISO(to))}</span>`;
    $el.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading pending rewards…</p></div>`;
    return;
  }

  if (pendingData === null) {
    if (fetchError) {
      $status.innerHTML = `<span class="status-info">${fmtDate(fmtISO(from))} — ${fmtDate(fmtISO(to))}</span>`;
      $el.innerHTML = `<div class="error-state"><p>Failed to load pending rewards</p><p class="error-detail">${fetchError}</p><button class="btn-retry">Retry</button></div>`;
      document.querySelector(".btn-retry")?.addEventListener("click", () => fetchData(), { once: true });
      return;
    }
  }

  const byMember = groupByMember(pendingData);
  const members = Array.from(byMember.entries());
  const totalSelected = Array.from(selected).length;
  const totalPending = pendingData ? pendingData.reduce((s, i) => s + i.count_pending, 0) : 0;

  $status.innerHTML = `
    <span class="status-info">${fmtDate(fmtISO(from))} — ${fmtDate(fmtISO(to))}</span>
    <span class="status-summary">${members.length} members · ${totalPending} pending runs</span>
  `;

  if (members.length === 0) {
    $el.innerHTML = `<div class="empty"><p>No pending rewards in this period.</p></div>`;
    return;
  }

  const allSelected = members.every(([uuid]) => isSelected(uuid));

  let html = `
    <div class="payout-bar">
      <label class="select-all-label">
        <input type="checkbox" id="select-all" ${allSelected ? "checked" : ""}>
        Select all
      </label>
      <button id="payout-btn" class="btn-payout" ${totalSelected === 0 ? "disabled" : ""}>
        Pay out selected (${totalSelected})
      </button>
    </div>
    <div class="table-wrap">
    <table class="raid-table">
      <thead>
        <tr>
          <th class="col-check"></th>
          <th class="col-member">Member</th>
          ${RAID_TYPES.map((rt) => {
            const info = RAID_RUNES[rt]!;
            return `<th>${info.rune}<span class="rune-label">${rt}</span></th>`;
          }).join("")}
          <th>Total Runes</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const [i, [uuid, entry]] of members.entries()) {
    const sel = isSelected(uuid);
    const anim = animateRows
      ? `style="animation: row-in 0.25s ease both; animation-delay: ${i * 0.03}s"`
      : "";
    html += `
      <tr class="member-row${sel ? " selected" : ""}" data-uuid="${uuid}" tabindex="0" ${anim}>
        <td class="col-check"><input type="checkbox" class="row-check" ${sel ? "checked" : ""} data-uuid="${uuid}" aria-label="Select ${entry.username}"></td>
        <td class="col-member"><span class="member-name">${entry.username}</span></td>
        ${RAID_TYPES.map((rt) => {
          const count = entry.raids[rt] ?? 0;
          const info = RAID_RUNES[rt]!;
          return count > 0
            ? `<td><span class="raid-count">${count}</span> ${runeTag(info.rune, info.color)}</td>`
            : `<td><span class="raid-count">—</span></td>`;
        }).join("")}
        <td><span class="total-runes">${totalRunes(entry.raids)}</span></td>
      </tr>
    `;
  }

  html += `</tbody></table></div>`;
  $el.innerHTML = html;
  animateRows = false;

  document.querySelectorAll(".row-check").forEach((cb) =>
    cb.addEventListener("change", (e) => {
      const uuid = (e.currentTarget as HTMLElement).dataset.uuid!;
      toggleSelect(uuid);
      renderPending($el, $status, from, to);
    })
  );

  const $payoutBtn = document.getElementById("payout-btn") as HTMLButtonElement | null;
  if ($payoutBtn) {
    $payoutBtn.addEventListener("click", handlePayout);
  }

  const $selectAllCb = document.getElementById("select-all") as HTMLInputElement | null;
  if ($selectAllCb) {
    $selectAllCb.addEventListener("change", (e) => {
      const checked = (e.currentTarget as HTMLInputElement).checked;
      if (checked) {
        for (const [uuid] of members) selected.add(selectionKey(uuid));
      } else {
        selected.clear();
      }
      renderPending($el, $status, from, to);
    });
  }

  document.querySelectorAll(".member-row").forEach((row) => {
    const toggleRow = () => {
      const uuid = (row as HTMLElement).dataset.uuid!;
      toggleSelect(uuid);
      renderPending($el, $status, from, to);
    };

    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("input[type=checkbox]")) return;
      toggleRow();
    });

    row.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" || ke.key === " ") {
        e.preventDefault();
        toggleRow();
      }
    });
  });
}

// ── History view ───────────────────────────────────────────────

function renderHistory($el: HTMLElement, $status: HTMLElement) {
  if (isFetching) {
    $status.innerHTML = `<span class="status-info">Payout history</span>`;
    $el.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading payout history…</p></div>`;
    return;
  }

  if (payoutsData === null) {
    if (fetchError) {
      $status.innerHTML = `<span class="status-info">Payout history</span>`;
      $el.innerHTML = `<div class="error-state"><p>Failed to load payout history</p><p class="error-detail">${fetchError}</p><button class="btn-retry">Retry</button></div>`;
      document.querySelector(".btn-retry")?.addEventListener("click", () => fetchData(), { once: true });
      return;
    }
  }

  $status.innerHTML = `<span class="status-info">Payout history</span>`;

  if (!payoutsData || payoutsData.length === 0) {
    $el.innerHTML = `<div class="empty"><p>No payouts recorded yet.</p></div>`;
    return;
  }

  let html = `<div class="table-wrap"><table class="raid-table history-table">
    <thead>
      <tr>
        <th>Date</th>
        ${RAID_TYPES.map((rt) => {
          const info = RAID_RUNES[rt]!;
          return `<th>${info.rune}<span class="rune-label">${rt}</span></th>`;
        }).join("")}
        <th>Total</th>
        <th>Members</th>
        <th>Paid by</th>
        <th class="col-status">Status</th>
      </tr>
    </thead>
    <tbody>
  `;

  for (const payout of payoutsData) {
    const isVoided = payout.status === "voided";
    const isExpanded = expandedPayoutId === payout.id;

    const byMember = new Map<string, { username: string; raids: Record<string, number> }>();
    for (const item of payout.items) {
      if (!byMember.has(item.member_uuid)) {
        byMember.set(item.member_uuid, { username: item.member_username ?? item.member_uuid, raids: {} });
      }
      const entry = byMember.get(item.member_uuid)!;
      entry.raids[item.raid_type] = (entry.raids[item.raid_type] ?? 0) + item.count_paid;
    }

    const runeTotals: Record<string, number> = {};
    for (const rt of RAID_TYPES) {
      runeTotals[rt] = Array.from(byMember.values()).reduce((s, e) => s + (e.raids[rt] ?? 0), 0);
    }

    const isConfirming = confirmingPayoutId === payout.id;
    const statusHtml = isVoided
      ? `<span class="tag-voided">Voided</span>`
      : currentUser?.is_admin
        ? isConfirming
          ? `<button class="btn-void btn-void-confirm" data-payout-id="${payout.id}">Confirm void?</button>`
          : `<button class="btn-void" data-payout-id="${payout.id}">Void</button>`
        : `<span class="text-completed">Completed</span>`;

    html += `<tr class="payout-summary${isVoided ? " row-voided" : ""}${isExpanded ? " expanded" : ""}" data-payout-id="${payout.id}" tabindex="0" aria-expanded="${isExpanded}">
      <td><span class="chevron" aria-hidden="true">${isExpanded ? "▾" : "▸"}</span>${fmtDate(payout.created_at)}${payout.label ? `<span class="payout-label">${payout.label}</span>` : ""}</td>
      ${RAID_TYPES.map((rt) => `<td class="rune-cell">${runeTotals[rt] > 0 ? runeTotals[rt] : "—"}</td>`).join("")}
      <td><span class="total-runes">${totalRunes(runeTotals)}</span></td>
      <td>${byMember.size}</td>
      <td>${payout.paid_by_username ?? "—"}</td>
      <td class="col-status">${statusHtml}</td>
    </tr>`;

    if (isExpanded) {
      html += `<tr class="payout-detail${isVoided ? " row-voided" : ""}"><td colspan="10">
        <table class="raid-table detail-table">
          <thead>
            <tr>
              <th class="col-member">Member</th>
              ${RAID_TYPES.map((rt) => {
                const info = RAID_RUNES[rt]!;
                return `<th>${info.rune}<span class="rune-label">${rt}</span></th>`;
              }).join("")}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
          ${Array.from(byMember.entries())
            .map(([uuid, entry]) => {
              const memberName = entry.username.length > 24 ? `${entry.username.slice(0, 24)}…` : entry.username;
              return `<tr>
                <td class="col-member"><span class="member-name" title="${entry.username}">${memberName}</span></td>
                ${RAID_TYPES.map((rt) => `<td>${entry.raids[rt] > 0 ? entry.raids[rt] : "—"}</td>`).join("")}
                <td><span class="total-runes">${totalRunes(entry.raids)}</span></td>
              </tr>`;
            })
            .join("")}
          </tbody>
        </table>
      </td></tr>`;
    }
  }

  html += `</tbody></table></div>`;
  $el.innerHTML = html;

  document.querySelectorAll(".payout-summary").forEach((row) => {
    const toggle = (e?: Event) => {
      if (e && (e.target as HTMLElement).closest(".btn-void")) return;
      const payoutId = Number((row as HTMLElement).dataset.payoutId);
      expandedPayoutId = expandedPayoutId === payoutId ? null : payoutId;
      renderHistory($el, $status);
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key !== "Enter" && ke.key !== " ") return;
      ke.preventDefault();
      toggle(e);
    });
  });

  document.querySelectorAll(".btn-void").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const payoutId = Number((e.currentTarget as HTMLElement).dataset.payoutId);
      e.stopPropagation();
      if (confirmingPayoutId === payoutId) {
        confirmingPayoutId = null;
        const $confirmBtn = e.currentTarget as HTMLButtonElement;
        $confirmBtn.disabled = true;
        $confirmBtn.textContent = "Voiding…";
        handleVoid(payoutId);
      } else {
        confirmingPayoutId = payoutId;
        renderHistory($el, $status);
      }
    })
  );
  document.querySelectorAll(".btn-void-confirm").forEach((btn) =>
    btn.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Escape") {
        confirmingPayoutId = null;
        renderHistory($el, $status);
      }
    })
  );
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
      $el.innerHTML = `<div class="error-state"><p>Failed to load status</p><p class="error-detail">${fetchError}</p><button class="btn-retry">Retry</button></div>`;
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
      <p>Took ${duration} · ${members} members (${latest.restricted_count ?? 0} restricted) · status: ${latest.status}
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
    const statusLabel = log.status === "running" ? "running…" : log.status;
    html += `<tr>
      <td>${fmtDate(log.started_at)}</td>
      <td>${dur}</td>
      <td>${members}</td>
      <td>${restricted}</td>
      <td><span class="status-tag ${statusClass}">${statusLabel}</span></td>
      <td class="err-cell">${log.error_message ? log.error_message.slice(0, 60) : "—"}</td>
    </tr>`;
  }

  html += `</tbody></table></div>`;
  $el.innerHTML = html;

  document.getElementById("fetch-now-btn")?.addEventListener("click", handleFetchNow);
}

// ── Payout action ──────────────────────────────────────────────

async function handlePayout() {
  const byMember = groupByMember(pendingData);
  const items: { member_uuid: string; raid_type: string; count: number }[] = [];
  let totalCount = 0;

  for (const [uuid, entry] of byMember) {
    if (!isSelected(uuid)) continue;
    for (const rt of RAID_TYPES) {
      const count = entry.raids[rt] ?? 0;
      if (count > 0) {
        items.push({ member_uuid: uuid, raid_type: rt, count });
        totalCount += count;
      }
    }
  }

  if (items.length === 0) return;

  const { from, to } = rangeFrom(currentRange);
  const label = `Payout ${fmtDate(fmtISO(from))} — ${fmtDate(fmtISO(to))}`;

  const $payoutBtn = document.getElementById("payout-btn") as HTMLButtonElement | null;
  if ($payoutBtn) {
    $payoutBtn.disabled = true;
    $payoutBtn.textContent = "Paying out…";
  }

  try {
    await createPayout({ label, starts_at: fmtISO(from), ends_at: fmtISO(to), items });
    selected.clear();
    await fetchData();
    showToast(`Paid out ${totalCount} runes across ${items.length} line items`);
  } catch (err) {
    showToast(`Payout failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    if ($payoutBtn) {
      $payoutBtn.disabled = false;
      $payoutBtn.textContent = "Pay out selected";
    }
  }
}

// ── Void action ────────────────────────────────────────────────

async function handleVoid(payoutId: number) {
  try {
    await voidPayout(payoutId);
    await fetchData();
    showToast("Payout voided");
  } catch (err) {
    showToast(`Failed to void payout: ${err instanceof Error ? err.message : "Unknown error"}`);
  }
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
    showToast(`Fetch failed: ${err instanceof Error ? err.message : "Unknown error"}`);
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

  const { from, to } = rangeFrom(currentRange);

  try {
    if (currentView === "pending") {
      pendingData = await fetchPendingRewards(fmtISO(from), fmtISO(to));
    }
    payoutsData = await fetchPayouts();
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
  if (isAuthenticated()) {
    try {
      currentUser = await fetchCurrentUser();
    } catch {
      clearToken();
    }
  }

  if (!currentUser && !isAuthenticated()) {
    try {
      currentUser = await fetchCurrentUser();
    } catch {
      currentUser = null;
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && confirmingPayoutId !== null) {
      confirmingPayoutId = null;
      if (currentView === "history") {
        const $el = document.getElementById("content")!;
        const $statusBarEl = document.getElementById("status-bar")!;
        renderHistory($el, $statusBarEl);
      }
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
