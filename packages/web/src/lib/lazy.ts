// Heavy views load on first use, so the first paint downloads only the reading UI: the editor
// (CodeMirror) and the graph (d3-force). `preload` fetches them when the browser is idle.
export const loadEditor = () => import("../app/views/Editor.svelte");
export const loadGraph = () => import("../components/GraphCanvas.svelte");
// Administrators only: the console and the dashboards stay out of the main bundle.
export const loadAdmin = () => import("../app/views/admin/AdminView.svelte");
export const loadDashboard = () => import("../app/views/DashboardView.svelte");

export function preload(withEditor: boolean): void {
  const run = () => {
    void loadGraph();
    if (withEditor) void loadEditor();
  };
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 2000);
}
