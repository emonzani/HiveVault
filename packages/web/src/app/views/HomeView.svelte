<script lang="ts">
  // Empty tab: recent pages, favorites, quick actions and the keyboard shortcuts.
  import Icon from "../../components/Icon.svelte";
  import { api } from "../../lib/api.ts";
  import { typeLabel, when } from "../../lib/format.ts";
  import { prefetch } from "../../lib/pages.svelte.ts";
  import { session } from "../../lib/session.svelte.ts";
  import type { PageListItem } from "../../lib/types.ts";
  import { target, ui } from "../../lib/ui.svelte.ts";
  import { ws } from "../../lib/workspace.svelte.ts";
  import { t } from "../../lib/i18n.ts";

  let recent = $state<PageListItem[] | null>(null);
  $effect(() => {
    api.get<PageListItem[]>("/api/recent?limit=12").then(
      (r) => (recent = r),
      () => (recent = []),
    );
  });

  const hour = new Date().getHours();
  const hello = hour < 13 ? t("Buongiorno") : hour < 18 ? t("Buon pomeriggio") : t("Buonasera");
  const keys = [
    [t("Ctrl K"), t("Comandi")],
    [t("Ctrl O"), t("Apri una pagina")],
    [t("Ctrl Maiusc F"), t("Cerca")],
    [t("Ctrl \\"), t("Dividi il pannello")],
    [t("Alt ← / →"), t("Indietro / avanti")],
    [t("Ctrl E"), t("Modifica la pagina")],
    [t("Alt N"), t("Nuova pagina")],
    [t("Alt T / Alt W"), t("Nuova scheda / chiudi")],
  ];
</script>

<div class="hv">
  <div class="col">
    <h1>{hello}, {session.me?.principal.displayName.split(" ")[0]}</h1>
    <div class="actions">
      <button class="act" onclick={(e) => ws.open({ kind: "search", q: "" }, target(e))}><Icon name="search" /><span>{t("Cerca nella memoria")}</span><kbd>Ctrl Maiusc F</kbd></button>
      <button class="act" onclick={() => (ui.palette = "switcher")}><Icon name="switch" /><span>{t("Apri una pagina")}</span><kbd>Ctrl O</kbd></button>
      {#if session.writable.length}
        <button class="act" onclick={() => (ui.newPage = {})}><Icon name="plus" /><span>{t("Nuova nota")}</span><kbd>Alt N</kbd></button>
        <button class="act" onclick={() => (ui.upload = {})}><Icon name="upload" /><span>{t("Carica documenti")}</span></button>
      {/if}
      <button class="act" onclick={(e) => ws.open({ kind: "graph" }, target(e))}><Icon name="graph" /><span>{t("Grafo")}</span></button>
    </div>

    <section>
      <h2>{t("Modificate di recente")}</h2>
      {#if !recent}
        <span class="skeleton" style="height:6rem"></span>
      {:else if !recent.length}
        <p class="dim">{t("Ancora nessuna pagina nei tuoi vault.")}</p>
      {:else}
        <ul class="recent">
          {#each recent as p (p.id)}
            <li>
              <a href="#/p/{p.id}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "page", id: p.id }, target(e)))} onmouseenter={() => prefetch(p.id)}>{p.title}</a>
              <span class="dim">{typeLabel(p.type)} · {session.vaultName(p.vaultId ?? "")} · {when(p.updatedAt)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>{t("Scorciatoie")}</h2>
      <dl class="keys">
        {#each keys as [k, v] (k)}<dt><kbd>{k}</kbd></dt><dd>{v}</dd>{/each}
      </dl>
    </section>
  </div>
</div>

<style>
  .hv {
    overflow-y: auto;
    min-height: 0;
    padding: 3rem 2rem 5rem;
  }
  .col {
    max-width: 48rem;
    margin: 0 auto;
    display: grid;
    gap: 2rem;
  }
  h1 {
    font-size: var(--fs-2xl);
  }
  h2 {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    margin-bottom: 0.6rem;
    font-weight: 600;
  }
  .actions {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: 0.6rem;
  }
  .act {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.75rem 0.9rem;
    border-radius: var(--r-panel);
    border: 1px solid var(--line);
    background: var(--ink-1);
    cursor: pointer;
    text-align: left;
    color: var(--text-muted);
  }
  .act span {
    flex: 1;
    color: var(--text-main);
    font-weight: 560;
  }
  .act:hover {
    border-color: var(--line-strong);
    background: var(--ink-2);
  }
  .recent {
    list-style: none;
    display: grid;
  }
  .recent li {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--line);
    font-size: var(--fs-sm);
  }
  .recent a {
    color: var(--link);
    font-weight: 560;
    text-decoration: none;
  }
  .recent a:hover {
    text-decoration: underline;
  }
  .keys {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.45rem 1rem;
    font-size: var(--fs-sm);
  }
  .keys dd {
    color: var(--text-muted);
  }
</style>
