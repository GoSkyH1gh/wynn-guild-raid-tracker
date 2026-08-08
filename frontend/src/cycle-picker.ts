export type CyclePickerStatus = "current" | "open" | "closed";

export interface CyclePickerOption {
  index: number;
  title: string;
  dates: string;
  status: CyclePickerStatus;
  hasData: boolean;
  isSelected: boolean;
}

let pickerCounter = 0;

const STATUS_LABEL: Record<CyclePickerStatus, string> = {
  current: "ongoing",
  open: "open",
  closed: "closed",
};

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

interface Section {
  kind: CyclePickerStatus;
  label: string;
  options: CyclePickerOption[];
}

function badge(content: string, cls: string): string {
  return `<span class="${cls}" aria-hidden="true">${content}</span>`;
}

/**
 * A dependency-free, accessible menu button (WAI-ARIA APG "Menu Button"
 * pattern, active-descendant variant): focus stays on the trigger, arrow keys
 * move a highlight that is exposed via `aria-activedescendant`, Enter/Space
 * selects, Escape closes, Home/End jump, and single-key typeahead works on
 * cycle numbers or titles. Empty cycles are hidden unless selected.
 */
export function mountCyclePicker(
  root: HTMLElement,
  options: CyclePickerOption[],
  onSelect: (index: number) => void,
): () => void {
  const uid = `cycle-picker-${++pickerCounter}`;
  const menuId = `${uid}-menu`;
  const triggerId = `${uid}-trigger`;

  const visible = options.filter(
    (o) => o.hasData || o.isSelected || o.status !== "closed" || o.index === 0,
  );
  const sections: Section[] = [];
  const pushSection = (kind: CyclePickerStatus, label: string, list: CyclePickerOption[]) => {
    if (list.length > 0) sections.push({ kind, label, options: list });
  };
  pushSection("current", "Current", visible.filter((o) => o.status === "current"));
  pushSection("open", "Previous", visible.filter((o) => o.status === "open"));
  pushSection("closed", "History", visible.filter((o) => o.status === "closed"));

  const items: CyclePickerOption[] = sections.flatMap((s) => s.options);
  const selected = visible.find((o) => o.isSelected) ?? visible[0] ?? null;

  root.innerHTML = `
    <div class="cycle-picker" id="${uid}">
      <button type="button" class="cp-trigger" id="${triggerId}"
              aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}">
        ${badge(selected ? String(selected.index) : "—", "cp-badge")}
        <span class="cp-text">
          <span class="cp-title">${escapeHtml(selected?.title ?? "No cycles")}</span>
          <span class="cp-dates">${escapeHtml(selected?.dates ?? "")}</span>
        </span>
        <span class="cp-dot" data-status="${selected?.status ?? "closed"}" aria-hidden="true"></span>
        <span class="cp-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="cp-menu" id="${menuId}" role="menu" aria-labelledby="${triggerId}" hidden>
        ${sections
          .map(
            (s) => `
          <div class="cp-section" data-kind="${s.kind}">
            <span class="cp-section-label">${escapeHtml(s.label)}</span>
            ${s.options
              .map(
                (o) => `
            <div class="cp-item${o.isSelected ? " selected" : ""}" role="menuitem" tabindex="-1"
                 id="${uid}-item-${o.index}" data-index="${o.index}" data-status="${o.status}">
              ${badge(String(o.index), "cp-item-badge")}
              <span class="cp-item-text">
                <span class="cp-item-title">${escapeHtml(o.title)}</span>
                <span class="cp-item-dates">${escapeHtml(o.dates)}${o.status !== "closed" ? `<span class="cp-item-status" data-status="${o.status}"> · ${STATUS_LABEL[o.status]}</span>` : ""}</span>
              </span>
              <span class="cp-check" aria-hidden="true">✓</span>
            </div>`,
              )
              .join("")}
          </div>`,
          )
          .join("")}
      </div>
    </div>
  `;

  const trigger = root.querySelector<HTMLButtonElement>(".cp-trigger")!;
  const menu = root.querySelector<HTMLElement>(".cp-menu")!;
  const itemEls = [...menu.querySelectorAll<HTMLElement>(".cp-item")];
  const indexToEl = new Map(itemEls.map((el) => [Number(el.dataset.index), el]));
  let highlightedIndex: number | null = selected?.index ?? items[0]?.index ?? null;

  function setHighlight(index: number | null) {
    highlightedIndex = index;
    for (const el of itemEls) {
      if (index !== null && Number(el.dataset.index) === index) {
        el.setAttribute("data-highlighted", "true");
      } else {
        el.removeAttribute("data-highlighted");
      }
    }
    if (index !== null) {
      menu.setAttribute("aria-activedescendant", `${uid}-item-${index}`);
    } else {
      menu.removeAttribute("aria-activedescendant");
    }
  }

  function move(dir: 1 | -1) {
    const pos = items.findIndex((o) => o.index === highlightedIndex);
    const next = pos === -1 ? 0 : (pos + dir + items.length) % items.length;
    const index = items[next]!.index;
    setHighlight(index);
    indexToEl.get(index)?.scrollIntoView({ block: "nearest" });
  }

  let typeaheadBuf = "";
  let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;
  function typeahead(key: string) {
    if (!/^[a-z0-9]$/i.test(key)) return;
    typeaheadBuf += key.toLowerCase();
    clearTimeout(typeaheadTimer);
    typeaheadTimer = setTimeout(() => {
      typeaheadBuf = "";
    }, 600);
    const start = items.findIndex((o) => o.index === highlightedIndex) + 1;
    for (let i = 0; i < items.length; i++) {
      const o = items[(start + i) % items.length]!;
      if (
        String(o.index).startsWith(typeaheadBuf) ||
        o.title.toLowerCase().startsWith(typeaheadBuf)
      ) {
        setHighlight(o.index);
        indexToEl.get(o.index)?.scrollIntoView({ block: "nearest" });
        return;
      }
    }
  }

  let open = false;

  function openMenu() {
    if (open) return;
    open = true;
    trigger.setAttribute("aria-expanded", "true");
    menu.hidden = false;
    setHighlight(selected?.index ?? items[0]?.index ?? null);
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeydown, true);
    window.addEventListener("blur", onWindowBlur);
  }

  function close(restoreFocus: boolean) {
    if (!open) return;
    open = false;
    trigger.setAttribute("aria-expanded", "false");
    menu.hidden = true;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeydown, true);
    window.removeEventListener("blur", onWindowBlur);
    if (restoreFocus) trigger.focus();
  }

  function select(index: number | null) {
    close(false);
    if (index !== null) onSelect(index);
  }

  function onDocPointerDown(e: PointerEvent) {
    if (!root.contains(e.target as Node)) close(true);
  }

  function onDocKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close(true);
  }

  function onWindowBlur() {
    close(false);
  }

  trigger.addEventListener("click", () => {
    if (open) close(true);
    else openMenu();
  });

  trigger.addEventListener("keydown", (e) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setHighlight(items[0]!.index);
        break;
      case "End":
        e.preventDefault();
        setHighlight(items[items.length - 1]!.index);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        select(highlightedIndex);
        break;
      case "Escape":
        e.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
      default:
        typeahead(e.key);
    }
  });

  for (const el of itemEls) {
    const index = Number(el.dataset.index);
    el.addEventListener("pointermove", () => {
      if (open) setHighlight(index);
    });
    el.addEventListener("click", () => select(index));
  }

  return () => {
    close(false);
    root.innerHTML = "";
  };
}
