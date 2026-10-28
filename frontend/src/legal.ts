function currentTheme(): "light" | "dark" {
  const theme = document.documentElement.dataset.theme;
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function syncThemeControls() {
  const next = currentTheme() === "light" ? "dark" : "light";
  const label = next === "light" ? "Light" : "Dark";
  document.querySelectorAll<HTMLButtonElement>(".theme-toggle").forEach((btn) => {
    btn.textContent = label;
    btn.setAttribute("aria-label", `Switch to ${label.toLowerCase()} mode`);
  });

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = currentTheme() === "light" ? "#f2f6f2" : "#0e1518";
}

document.querySelectorAll<HTMLButtonElement>(".theme-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = currentTheme() === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // The theme still applies for this page when storage is unavailable.
    }
    syncThemeControls();
  });
});

syncThemeControls();
