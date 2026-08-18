import type ApexCharts from "apexcharts/line";

let apexPromise: Promise<typeof ApexCharts> | null = null;

/**
 * Single-flight dynamic import of the tree-shaken ApexCharts core plus the
 * chart families and features this app uses. Nothing here runs (or is even
 * downloaded) until loadApex() is first called; Vite splits it into its own
 * chunk so it never blocks first paint.
 *
 * The `apexcharts/bar` and `apexcharts/features/*` imports are side-effect
 * imports: they register their chart types/features onto the same shared core
 * class that `apexcharts/line` exports as its default.
 */
export function loadApex(): Promise<typeof ApexCharts> {
  if (!apexPromise) {
    apexPromise = (async () => {
      const mod = await import("apexcharts/line"); // line/area/scatter/bubble/rangeArea
      await import("apexcharts/bar"); // bar/column/rangeBar
      await import("apexcharts/pie"); // pie/donut/polarArea/radialBar
      await import("apexcharts/features/legend");
      await import("apexcharts/features/toolbar"); // zoom/pan (download tool hidden; exports feature not loaded)
      return mod.default;
    })();
  }
  return apexPromise;
}

/**
 * Warm the chunk cache after first paint so opening the charts view is
 * instant. Failures are ignored; loadApex() retries on demand.
 */
export function preloadApex(): void {
  const run = () => {
    loadApex().catch(() => {
      // non-fatal; the charts view retries when it opens
    });
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 5000 });
  } else {
    setTimeout(run, 2500);
  }
}
