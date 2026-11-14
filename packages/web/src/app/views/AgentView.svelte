<script lang="ts">
  // "Cosa ha letto l'agente cloud" (plan §3.6): reads by API accounts of pages in the user's own cell,
  // from the audit log.
  import ClassTag from "../../components/ClassTag.svelte";
  import { api } from "../../lib/api.ts";
  import { classificationName, nf, when } from "../../lib/format.ts";
  import { target } from "../../lib/ui.svelte.ts";
  import { ws } from "../../lib/workspace.svelte.ts";
  import { t, tHtml } from "../../lib/i18n.ts";

  interface Read {
    at: string;
    pageId: string;
    title: string;
    account: string;
    accountName: string;
    tokens: number | null;
    classification: number | null;
  }
  let days = $state(30);
  let data = $state<{ vaults: string[]; reads: Read[] } | null>(null);
  let error = $state("");

  $effect(() => {
    const d = days;
    data = null;
    api.get<{ vaults: string[]; reads: Read[] }>(`/api/me/agent-reads?days=${d}`).then(
      (r) => (data = r),
      (e: Error) => (error = e.message),
    );
  });

  const byPage = $derived.by(() => {
    const m = new Map<string, { title: string; n: number; tokens: number; last: string }>();
    for (const r of data?.reads ?? []) {
      const e = m.get(r.pageId) ?? { title: r.title, n: 0, tokens: 0, last: r.at };
      e.n++;
      e.tokens += r.tokens ?? 0;
      m.set(r.pageId, e);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  });
</script>

<div class="cv">
  <div class="col">
    <header>
      <h1>{t("Cosa ha letto l'agente cloud")}</h1>
      <p class="lead">{@html tHtml("Le letture delle pagine della tua cella da parte degli account API (l'agente cloud e altri client autorizzati). L'agente cloud riceve solo il testo compilato delle pagine **pubblico** e **interno**; i documenti originali non escono mai dal server.")}</p>
      <div class="range" role="radiogroup" aria-label={t("Periodo")}>
        {#each [7, 30, 90] as d (d)}
          <button class="chip" role="radio" aria-checked={days === d} onclick={() => (days = d)}>{t("Ultimi {d} giorni", { d })}</button>
        {/each}
      </div>
    </header>

    {#if error}
      <p class="notice error">{error}</p>
    {:else if !data}
      <span class="skeleton" style="height:8rem"></span>
    {:else if !data.vaults.length}
      <div class="empty"><h2>{t("Non hai una cella personale")}</h2><p>{t("Questo pannello mostra le letture delle pagine della tua cella.")}</p></div>
    {:else if !data.reads.length}
      <div class="empty"><h2>{t("Nessuna lettura")}</h2><p>{t("Nessun account API ha letto le tue pagine in questo periodo.")}</p></div>
    {:else}
      <section class="summary">
        <div class="stat"><span class="v tabular">{nf.format(data.reads.length)}</span><span class="k">{t("letture")}</span></div>
        <div class="stat"><span class="v tabular">{nf.format(new Set(data.reads.map((r) => r.pageId)).size)}</span><span class="k">{t("pagine diverse")}</span></div>
        <div class="stat"><span class="v tabular">{nf.format(data.reads.reduce((s, r) => s + (r.tokens ?? 0), 0))}</span><span class="k">{t("token letti")}</span></div>
        <div class="stat"><span class="v tabular">{new Set(data.reads.map((r) => r.account)).size}</span><span class="k">{t("account")}</span></div>
      </section>
      <section>
        <h2>{t("Le pagine più lette")}</h2>
        <ol class="top">
          {#each byPage as [id, p] (id)}
            <li><a href="#/p/{id}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "page", id }, target(e)))}>{p.title}</a><span class="dim tabular">{t("{n} letture · {tokens} token", { n: p.n, tokens: nf.format(p.tokens) })}</span></li>
          {/each}
        </ol>
      </section>
      <section>
        <h2>{t("Tutte le letture")}</h2>
        <table>
          <thead><tr><th>{t("Quando")}</th><th>{t("Pagina")}</th><th>{t("Account")}</th><th>{t("Classificazione")}</th><th class="r">{t("Token")}</th></tr></thead>
          <tbody>
            {#each data.reads as r, i (i)}
              <tr>
                <td class="dim">{when(r.at)}</td>
                <td><a href="#/p/{r.pageId}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "page", id: r.pageId }, target(e)))}>{r.title}</a></td>
                <td>{r.accountName}</td>
                <td>{#if r.classification !== null}<ClassTag level={classificationName(r.classification)} />{/if}</td>
                <td class="r tabular">{r.tokens !== null ? nf.format(r.tokens) : "—"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}
  </div>
</div>

<style>
  .cv {
    overflow-y: auto;
    min-height: 0;
    padding: 2rem 2rem 5rem;
  }
  .col {
    max-width: 58rem;
    margin: 0 auto;
    display: grid;
    gap: 1.75rem;
  }
  header {
    display: grid;
    gap: 0.6rem;
  }
  h1 {
    font-size: var(--fs-2xl);
  }
  h2 {
    font-size: var(--fs-md);
    margin-bottom: 0.6rem;
  }
  .lead {
    color: var(--text-muted);
    max-width: 68ch;
  }
  .range {
    display: flex;
    gap: 0.35rem;
  }
  .summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 0.75rem;
  }
  .stat {
    display: grid;
    padding: 0.9rem 1rem;
    border-radius: var(--r-panel);
    background: var(--ink-1);
    border: 1px solid var(--line);
  }
  .stat .v {
    font-size: var(--fs-2xl);
    font-weight: 650;
  }
  .stat .k {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .top {
    display: grid;
    gap: 0.35rem;
    padding-left: 1.2rem;
  }
  .top li {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    font-size: var(--fs-sm);
  }
  a {
    color: var(--link);
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-sm);
  }
  th {
    text-align: left;
    font-size: var(--fs-xs);
    color: var(--text-dim);
    font-weight: 600;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid var(--line);
  }
  td {
    padding: 0.45rem 0.5rem;
    border-bottom: 1px solid var(--line);
  }
  .r {
    text-align: right;
  }
</style>
