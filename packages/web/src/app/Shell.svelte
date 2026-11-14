<script lang="ts">
  import { onMount } from "svelte";
  import { current } from "../lib/current.svelte.ts";
  import { preload } from "../lib/lazy.ts";
  import { session } from "../lib/session.svelte.ts";
  import { ui } from "../lib/ui.svelte.ts";
  import { ws } from "../lib/workspace.svelte.ts";
  import HoverLayer from "./HoverLayer.svelte";
  import Inspector from "./Inspector.svelte";
  import NewPageDialog from "./NewPageDialog.svelte";
  import NoticeDialog from "./NoticeDialog.svelte";
  import Palette from "./Palette.svelte";
  import PaneView from "./PaneView.svelte";
  import Ribbon from "./Ribbon.svelte";
  import Sidebar from "./Sidebar.svelte";
  import Toasts from "./Toasts.svelte";
  import UploadDialog from "./UploadDialog.svelte";
  import { t } from "../lib/i18n.ts";

  let dragging = $state(0);
  // the console and the dashboards use the whole width: the inspector belongs to pages
  const wide = $derived(ws.panes.length === 1 && (ws.tab.view.kind === "admin" || ws.tab.view.kind === "dashboard"));
  // the details panel shows a page or an inbox document: other views (search, graph, queues)
  // have nothing for it, so it closes and gives the width to the view
  const DETAIL_VIEWS = new Set(["page", "history", "source", "inbox"]);
  const hasDetail = $derived(DETAIL_VIEWS.has(ws.tab.view.kind) || !!current.byTab[ws.tab.id]?.page);
  const right = $derived(ui.rightOpen && !wide && hasDetail && !ui.narrow);

  // on a phone the focus goes into the drawer when it opens
  $effect(() => {
    if (ui.narrow && ui.leftOpen) requestAnimationFrame(() => document.querySelector<HTMLElement>(".sidebar button, .sidebar a")?.focus());
  });

  // on a phone the drawer closes when a view opens
  $effect(() => {
    void ws.tab.view;
    if (ui.narrow) ui.leftOpen = false;
  });
  const canUpload = $derived(session.writable.length > 0);

  onMount(() => {
    preload(canUpload);
    ws.fromHash();
    const onHash = () => ws.fromHash();
    addEventListener("hashchange", onHash);
    const left = sessionStorage.getItem("cb-recovery-left");
    if (left) {
      sessionStorage.removeItem("cb-recovery-left");
      ui.toast(t("Ti restano {left} codici di recupero: collega di nuovo l'app di autenticazione dal tuo account.", { left }), "error");
    }
    return () => removeEventListener("hashchange", onHash);
  });

  /** "Skip to content": the focus goes to the title of the active view (past ribbon, sidebar, tabs and any section menu). */
  function skipToContent() {
    const body = document.querySelector<HTMLElement>(".pane.focused .body") ?? document.querySelector<HTMLElement>(".pane .body");
    const target = body?.querySelector<HTMLElement>("h1") ?? body;
    if (!target) return;
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus();
  }

  /** Global shortcuts (plan §9.1). Shortcuts the browser reserves (Ctrl+T, Ctrl+W, Ctrl+N) are left alone. */
  function onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === "Escape" && ui.narrow && ui.leftOpen && !document.querySelector("dialog[open]")) {
      ui.leftOpen = false;
      document.querySelector<HTMLElement>(".ribbon .toggle")?.focus();
    } else if (mod && !e.shiftKey && k === "k") {
      e.preventDefault();
      ui.palette = ui.palette === "commands" ? null : "commands";
    } else if (mod && !e.shiftKey && k === "o") {
      e.preventDefault();
      ui.palette = ui.palette === "switcher" ? null : "switcher";
    } else if (mod && e.shiftKey && k === "f") {
      e.preventDefault();
      ws.open({ kind: "search", q: ws.tab.view.kind === "search" ? ws.tab.view.q : "" }, ws.tab.view.kind === "search" ? "here" : "tab");
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-search-input]")?.focus());
    } else if (mod && (e.key === "\\" || e.code === "Backslash")) {
      e.preventDefault();
      ws.toggleSplit();
    } else if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      ws.back();
    } else if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      ws.forward();
    } else if (mod && !e.shiftKey && k === "b") {
      e.preventDefault();
      ui.leftOpen = !ui.leftOpen;
    } else if (mod && e.shiftKey && k === "b") {
      e.preventDefault();
      ui.rightOpen = !ui.rightOpen;
    } else if (e.altKey && !mod && k === "n") {
      e.preventDefault();
      ui.newPage = {};
    } else if (e.altKey && !mod && k === "t") {
      e.preventDefault();
      ws.newTab();
    } else if (e.altKey && !mod && k === "w") {
      e.preventDefault();
      ws.close(ws.focused, ws.pane.active);
    } else if (e.ctrlKey && e.key === "PageDown") {
      e.preventDefault();
      ws.cycleTab(1);
    } else if (e.ctrlKey && e.key === "PageUp") {
      e.preventDefault();
      ws.cycleTab(-1);
    }
  }

  // Drag & drop of files anywhere on the window opens the upload dialog
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
  function onDragEnter(e: DragEvent) {
    if (!hasFiles(e) || !canUpload) return;
    e.preventDefault();
    dragging++;
  }
  function onDragLeave(e: DragEvent) {
    if (!hasFiles(e) || !canUpload) return;
    dragging = Math.max(0, dragging - 1);
  }
  function onDragOver(e: DragEvent) {
    if (hasFiles(e) && canUpload) e.preventDefault();
  }
  function onDrop(e: DragEvent) {
    if (!hasFiles(e) || !canUpload) return;
    e.preventDefault();
    dragging = 0;
    if (ui.upload) return; // the dialog's own drop zone takes the files
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) ui.upload = { files };
  }
</script>

<svelte:window onkeydown={onKey} ondragenter={onDragEnter} ondragleave={onDragLeave} ondragover={onDragOver} ondrop={onDrop} />

<button class="skip" onclick={skipToContent}>{t("Salta al contenuto")}</button>
<div class="shell" class:left={ui.leftOpen} class:right>
  <Ribbon />
  {#if ui.leftOpen}<Sidebar />{/if}
  {#if ui.leftOpen && ui.narrow}<button class="drawer-scrim" aria-label={t("Chiudi")} onclick={() => (ui.leftOpen = false)}></button>{/if}
  <main class="panes" class:split={ws.panes.length === 2} inert={ui.narrow && ui.leftOpen}>
    {#each ws.panes as pane, i (i)}
      <PaneView {pane} index={i} />
    {/each}
  </main>
  {#if right}<Inspector />{/if}
</div>

{#if dragging > 0}
  <div class="drop" aria-hidden="true">
    <div class="drop-card">
      <strong>{t("Rilascia per caricare")}</strong>
      <span>{t("I file restano sul server: vengono letti e indicizzati qui.")}</span>
    </div>
  </div>
{/if}

<HoverLayer />
<Palette />
<UploadDialog />
<NewPageDialog />
<NoticeDialog />
<Toasts />

<style>
  .shell {
    height: 100%;
    display: grid;
    grid-template-columns: 3rem minmax(0, 1fr);
    background: var(--ink-0);
  }
  .shell.left {
    grid-template-columns: 3rem var(--rail-w) minmax(0, 1fr);
  }
  .shell.right {
    grid-template-columns: 3rem minmax(0, 1fr) var(--inspector-w);
  }
  .shell.left.right {
    grid-template-columns: 3rem var(--rail-w) minmax(0, 1fr) var(--inspector-w);
  }
  .panes {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  .panes.split {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .panes.split > :global(:first-child) {
    border-right: 1px solid var(--line);
  }
  .drop {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
    background: var(--scrim);
    pointer-events: none;
  }
  .drop-card {
    display: grid;
    gap: 0.4rem;
    text-align: center;
    padding: 2rem 2.5rem;
    border: 2px dashed var(--you);
    border-radius: var(--radius-lg);
    background: var(--ink-1);
    color: var(--text-muted);
  }
  .drop-card strong {
    font-size: var(--fs-xl);
    color: var(--text-main);
  }
  .drawer-scrim {
    display: none;
  }
  /* first Tab stop of the app: hidden until it has the focus */
  .skip {
    position: fixed;
    z-index: 100;
    top: 0.5rem;
    left: 0.5rem;
    padding: 0.5rem 0.9rem;
    border: 0;
    border-radius: var(--r-control);
    background: var(--you);
    color: var(--on-you);
    font-weight: 650;
    cursor: pointer;
    transform: translateY(-200%);
  }
  .skip:focus-visible {
    transform: none;
  }
  /* Phones: one column for the view; the sidebar slides over it as a drawer */
  @media (max-width: 760px) {
    .shell.left,
    .shell.left.right {
      grid-template-columns: 3rem minmax(0, 1fr);
    }
    .shell.left > :global(.sidebar) {
      position: fixed;
      z-index: 60;
      top: 0;
      bottom: 0;
      left: 3rem;
      width: min(var(--rail-w), calc(100vw - 4rem));
      box-shadow: var(--shadow-modal);
      animation: drawer-in 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .drawer-scrim {
      display: block;
      position: fixed;
      z-index: 59;
      inset: 0 0 0 3rem;
      border: 0;
      background: var(--scrim);
      cursor: pointer;
    }
  }
  @keyframes drawer-in {
    from {
      transform: translateX(-12px);
      opacity: 0;
    }
  }
  @media (max-width: 1100px) {
    .shell.left.right {
      grid-template-columns: 3rem var(--rail-w) minmax(0, 1fr);
    }
    .shell.left.right > :global(.inspector) {
      display: none;
    }
  }
</style>
