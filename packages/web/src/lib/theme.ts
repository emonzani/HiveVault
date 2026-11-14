// Theme state (key "cb-theme"). "scuro" is the base theme (no data-theme attribute); without a
// saved choice, theme-boot.js follows the theme of the operating system.
import { t } from "./i18n.ts";
export const THEMES = ["chiaro", "scuro"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_LABELS: Record<Theme, string> = {
  chiaro: t("Chiaro"),
  scuro: t("Scuro"),
};
const KEY = "cb-theme";

export function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "chiaro" ? "chiaro" : "scuro";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  // Many elements use "transition: all": without this pause the switch would fade in waves
  root.classList.add("theme-switching");
  if (theme === "scuro") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  void root.offsetHeight;
  requestAnimationFrame(() => root.classList.remove("theme-switching"));
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable: the theme lasts for this page only */
  }
}
