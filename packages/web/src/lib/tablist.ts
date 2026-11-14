// Keyboard model of the ARIA tabs pattern for a role="tablist" element: only the selected tab is
// in the Tab order (roving tabindex); Left/Right arrows, Home and End move to another tab and
// select it (automatic activation, like a click). The workspace tabs have their own handler.

function tabsOf(node: HTMLElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>('[role="tab"]')].filter((t) => !t.hasAttribute("disabled"));
}

function sync(node: HTMLElement) {
  const tabs = tabsOf(node);
  const sel = tabs.find((t) => t.getAttribute("aria-selected") === "true") ?? tabs[0];
  for (const t of tabs) t.tabIndex = t === sel ? 0 : -1;
}

export function tablist(node: HTMLElement) {
  sync(node);
  // the selection changes from outside (a click, the URL): keep the Tab stop on the selected tab
  const obs = new MutationObserver(() => sync(node));
  obs.observe(node, { subtree: true, attributes: true, attributeFilter: ["aria-selected", "disabled"], childList: true });

  function onKey(e: KeyboardEvent) {
    const tabs = tabsOf(node);
    const i = tabs.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const next =
      e.key === "ArrowRight" ? (i + 1) % tabs.length
      : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    tabs[next]!.focus();
    tabs[next]!.click();
  }
  node.addEventListener("keydown", onKey);
  return {
    destroy() {
      obs.disconnect();
      node.removeEventListener("keydown", onKey);
    },
  };
}
