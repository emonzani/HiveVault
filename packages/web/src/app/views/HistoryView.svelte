<script lang="ts">
  // Page history: versions on the left, line diff between the chosen version and the one
  // before it (or the current text) on the right.
  import { diffLines, type Change } from "diff";
  import { untrack } from "svelte";
  import Button from "../../components/Button.svelte";
  import { api } from "../../lib/api.ts";
  import { when } from "../../lib/format.ts";
  import type { VersionItem } from "../../lib/types.ts";
  import { pageCache } from "../../lib/pages.svelte.ts";
  import { target, ui } from "../../lib/ui.svelte.ts";
  import { ws } from "../../lib/workspace.svelte.ts";
  import { t } from "../../lib/i18n.ts";

  let { tabId, id }: { tabId: string; id: string } = $props();

  let list = $state<VersionItem[] | null>(null);
  let selected = $state<number | null>(null);
  let diff = $state<Change[] | null>(null);
  let error = $state("");
  // page_versions keeps the body of each replaced version; its time is when it was replaced
  const cache = new Map<number, string>();

  async function body(v: number): Promise<string> {
    if (!cache.has(v)) {
      const r = await api.get<{ title: string; body: string }>(`/api/pages/${encodeURIComponent(id)}/versions/${v}`);
      cache.set(v, r.body);
    }
    return cache.get(v)!;
  }

  $effect(() => {
    const pid = id;
    untrack(async () => {
      try {
        list = await api.get<VersionItem[]>(`/api/pages/${encodeURIComponent(pid)}/versions`);
        ws.setTitle(tabId, t("Storico: {x}", { x: list[0]?.title ?? "" }));
        selected = list[0]?.version ?? null;
      } catch (e) {
        error = (e as Error).message;
      }
    });
  });

  $effect(() => {
    const v = selected;
    if (v === null || !list) return;
    const prev = untrack(() => list!.find((x) => x.version < v)?.version);
    diff = null;
    void (async () => {
      const [a, b] = await Promise.all([prev !== undefined ? body(prev) : Promise.resolve(""), body(v)]);
      if (selected === v) diff = diffLines(a, b);
    })().catch((e: Error) => (error = e.message));
  });

  let restoring = $state(false);
  async function restore(v: number) {
    if (!confirm(t("Ripristinare la versione {v}? Diventa una nuova versione: lo storico resta intatto.", { v }))) return;
    restoring = true;
    try {
      const r = await api.post<{ version: number }>(`/api/pages/${encodeURIComponent(id)}/restore`, { version: v });
      pageCache.drop(id);
      ui.toast(t("Versione {v} ripristinata come v{version}.", { v, version: r.version }), "ok");
      ws.open({ kind: "page", id });
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      restoring = false;
    }
  }

  const stats = $derived(diff ? { add: diff.filter((c) => c.added).reduce((s, c) => s + (c.count ?? 0), 0), del: diff.filter((c) => c.removed).reduce((s, c) => s + (c.count ?? 0), 0) } : null);
</script>

<div class="hv">
  {#if error}
    <div class="empty"><p>{error}</p></div>
  {:else if !list}
    <div class="pad"><span class="skeleton" style="height:10rem"></span></div>
  {:else}
    <nav class="versions" aria-label={t("Versioni")}>
      <a class="back" href="#/p/{id}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "page", id }, target(e)))}>{t("← Torna alla pagina")}</a>
      <ol>
        {#each list as v (v.version)}
          <li>
            <button class:sel={v.version === selected} onclick={() => (selected = v.version)}>
              <span class="vn">v{v.version}{v.current ? t(" · attuale") : ""}</span>
              <span class="dim">{v.current ? t("dal {createdAt}", { createdAt: when(v.createdAt) }) : t("sostituita {createdAt}", { createdAt: when(v.createdAt) })}</span>
              {#if v.title !== list[0]?.title}<span class="dim t">«{v.title}»</span>{/if}
            </button>
          </li>
        {/each}
      </ol>
    </nav>
    <section class="diff" aria-label={t("Differenze")}>
      {#if stats}
        <p class="sum">
          <span><span class="add">+{stats.add}</span> <span class="del">−{stats.del}</span> {t("righe rispetto alla versione precedente")}</span>
          {#if selected !== null && !list.find((x) => x.version === selected)?.current}
            <Button size="sm" busy={restoring} onclick={() => restore(selected!)}>{t("Ripristina questa versione")}</Button>
          {/if}
        </p>
      {/if}
      {#if !diff}
        <span class="skeleton" style="height:12rem"></span>
      {:else}
        <pre class="mono">{#each diff as c, i (i)}<span class:add={c.added} class:del={c.removed} class:same={!c.added && !c.removed}>{c.value}</span>{/each}</pre>
      {/if}
    </section>
  {/if}
</div>

<style>
  .hv {
    min-height: 0;
    display: grid;
    grid-template-columns: 16rem minmax(0, 1fr);
  }
  .pad {
    padding: 1.25rem;
  }
  .versions {
    min-height: 0;
    overflow-y: auto;
    border-right: 1px solid var(--line);
    padding: 0.75rem;
    display: grid;
    align-content: start;
    gap: 0.5rem;
  }
  .back {
    font-size: var(--fs-sm);
    color: var(--accent-blue);
    text-decoration: none;
    padding: 0.25rem 0.4rem;
  }
  ol {
    list-style: none;
    display: grid;
    gap: 0.15rem;
  }
  ol button {
    width: 100%;
    display: grid;
    gap: 0.1rem;
    padding: 0.45rem 0.6rem;
    border: 0;
    border-radius: 6px;
    background: none;
    text-align: left;
    cursor: pointer;
    font-size: var(--fs-sm);
  }
  ol button:hover {
    background: var(--ink-2);
  }
  ol button.sel {
    background: var(--ink-3);
  }
  .vn {
    font-weight: 600;
  }
  .t {
    font-size: var(--fs-xs);
  }
  .dim {
    font-size: var(--fs-xs);
  }
  .diff {
    min-height: 0;
    overflow: auto;
    padding: 1rem 1.25rem 4rem;
    display: grid;
    align-content: start;
    gap: 0.6rem;
  }
  .sum {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  pre {
    white-space: pre-wrap;
    font-size: var(--fs-sm);
    line-height: 1.6;
  }
  .add {
    color: var(--busy-ink);
  }
  pre .add {
    display: block;
    background: var(--busy-soft);
    color: var(--text-main);
    box-shadow: inset 3px 0 0 var(--busy);
    padding-left: 0.5rem;
  }
  .del {
    color: var(--alert-ink);
  }
  pre .del {
    display: block;
    background: var(--alert-soft);
    color: var(--text-muted);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--alert) 50%, transparent);
    box-shadow: inset 3px 0 0 var(--alert);
    padding-left: 0.5rem;
  }
  pre .same {
    display: block;
    color: var(--text-dim);
    padding-left: 0.5rem;
  }
</style>
