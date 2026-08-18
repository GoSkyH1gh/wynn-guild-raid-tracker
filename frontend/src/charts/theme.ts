import type { Rune } from "./series.js";

export interface ChartColors {
  text: string;
  muted: string;
  grid: string;
  /** Warning accent for over-cap segments; theme-independent (no CSS var). */
  warn: string;
  runes: Record<Rune, string>;
}

export type ChartMode = "dark" | "light";

/**
 * Resolve the app's CSS custom properties to concrete hex colors at chart
 * mount time. ApexCharts cannot read CSS variables live, so charts are
 * rebuilt (or re-themed) when the theme changes.
 */
export function chartColors(): ChartColors {
  const s = getComputedStyle(document.documentElement);
  const css = (name: string, fallback: string): string => {
    const v = s.getPropertyValue(name).trim();
    return v !== "" ? v : fallback;
  };
  return {
    text: css("--text", "#d4ddd0"),
    muted: css("--text-muted", "#93aa9b"),
    grid: css("--text-dim", "#9cb1a4"),
    warn: "#e07b5b",
    runes: {
      notg: css("--rune-notg", "#7bc3d6"),
      nol: css("--rune-nol", "#b298d6"),
      tcc: css("--rune-tcc", "#d49176"),
      tna: css("--rune-tna", "#d5b25a"),
      wtp: css("--rune-wtp", "#74bd85"),
    },
  };
}

/** Mirror of main.ts's currentTheme(): chart tooltips follow the app theme. */
export function chartMode(): ChartMode {
  const t = document.documentElement.dataset.theme;
  if (t === "light") return "light";
  if (t === "dark") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}
