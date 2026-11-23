<script lang="ts">
  // Curator queue (plan §3.2): conflicts between cells, duplicate candidates, values to check.
  // A decision updates the hive page at once.
  import { diffLines } from "diff";
  import { untrack } from "svelte";
  import Button from "../../components/Button.svelte";
  import { api, qs } from "../../lib/api.ts";
  import { curatorCount } from "../../lib/curator.svelte.ts";
  import { when } from "../../lib/format.ts";
  import { pageEvents, prefetch } from "../../lib/pages.svelte.ts";
  import { target, ui } from "../../lib/ui.svelte.ts";
  import { ws } from "../../lib/workspace.svelte.ts";
  import { t } from "../../lib/i18n.ts";
  import { tablist } from "../../lib/tablist.ts";

  interface Ref {
    pageId: string;
    blockId: string | null;
    vaultName?: string;
    observedAt?: string | null;
  }
  interface Value {
    value: string;
    valueNorm: string;
    refs: Ref[];
  }
  interface Item {
    id: string;
    spaceId: string;
    vaultName: string;
    kind: "conflict" | "duplicate" | "lint" | "low_confidence" | "proposal" | "mass_change" | "rectification" | "review";
    subject: string;
    predicate: string | null;
    pageId: string | null;
    data: { title?: string; values?: Value[]; body?: string; before?: string; rationale?: string; by?: string; section?: string | null; a?: { id: string; title: string; tldr?: string }; b?: { id: string; title: string; tldr?: string }; similarity?: number; value?: string; confidence?: number; origin?: string; subjects?: string[]; total?: number; pages?: { id: string; title: string; vaultName: string }[]; sources?: { id: string; name: string; vaultName: string }[]; reviewAfter?: string };
    status: string;
    resolution: Record<string, unknown> | null;
    resolvedAt: string | null;
    createdAt: string;
  }

  let status = $state<"open" | "resolved">("open");
  let kind = $state("");
  let items = $state<Item[] | null>(null);
  let error = $state("");
  let busy = $state("");
  let custom = $state<Record<string, string>>({});

  async function load() {
    try {
      items = await api.get<Item[]>(`/api/curator${qs({ status, kind })}`);
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void status;
    void kind;
    items = null;
    untrack(() => void load());
  });

  async function act(it: Item, path: string, body: unknown, done: string) {
    busy = it.id;
    try {
      await api.post(`/api/curator/${it.id}/${path}`, body);
      if (it.pageId) pageEvents.notify(it.pageId);
      ui.toast(done, "ok");
      items = (items ?? []).filter((x) => x.id !== it.id);
      curatorCount.refresh();
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = "";
    }
  }

  /** Changed lines in full, unchanged runs longer than 4 lines folded to "…". */
  function proposalDiff(before: string, after: string): { kind: "add" | "del" | "same"; text: string }[] {
    return diffLines(before, after).map((c) => ({
      kind: c.added ? "add" : c.removed ? "del" : "same",
      text: !c.added && !c.removed && c.value.split(NL).length > 5 ? `…${NL}` : c.value,
    }));
  }
  const NL = String.fromCharCode(10);
  const KINDS: [string, string][] = [["", t("Tutte")], ["conflict", t("Conflitti")], ["proposal", t("Proposte dell'agente cloud")], ["duplicate", t("Duplicati")], ["low_confidence", t("Da verificare")], ["mass_change", t("Modifiche di massa")], ["rectification", t("Rettifiche")], ["review", t("Da ricontrollare")]];
  const KIND: Record<string, string> = { proposal: t("Proposta di modifica"), conflict: t("Conflitto"), duplicate: t("Possibile duplicato"), low_confidence: t("Da verificare"), lint: t("Controllo"), mass_change: t("Modifica di massa"), rectification: t("Rettifica"), review: t("Da ricontrollare") };
  const title = (it: Item) => it.data.title ?? it.subject;
  const open = (e: MouseEvent, id: string) => (e.preventDefault(), ws.open({ kind: "page", id }, target(e)));
  const decision = (it: Item) => {
    const r = it.resolution ?? {};
    if ("choice" in r) return `scelto «${(it.data.values ?? []).find((v) => v.valueNorm === r.choice)?.value ?? r.choice}»`;
    if ("custom" in r) return t("valore scritto: «{value}»", { value: String(r.custom) });
    if ("keepAll" in r) return t("tutti i valori sono validi");
    if ("verified" in r) return t("pagina confermata");
    if ("note" in r && r.note) return String(r.note);
    return "chiusa";
  };
</script>

<div class="cv">
  <div class="col">
    <header>
      <h1>{t("Coda dei curatori")}</h1>
      <p class="lead">{t("Il ciclo notturno unisce nell'alveare le informazioni concordi delle celle. Qui arrivano i casi da decidere: valori diversi per la stessa informazione, pagine che sembrano duplicate, valori con poca fiducia.")}</p>
      <div class="filters">
        <div class="seg" role="tablist" use:tablist aria-label={t("Stato")}>
          <button role="tab" aria-selected={status === "open"} onclick={() => (status = "open")}>{t("Aperte")}</button>
          <button role="tab" aria-selected={status === "resolved"} onclick={() => (status = "resolved")}>{t("Decise")}</button>
        </div>
        <div class="grp" role="group" aria-label={t("Tipo")}>
          {#each KINDS as [k, l] (k)}
            <button class="chip" aria-pressed={kind === k} onclick={() => (kind = k)}>{l}</button>
          {/each}
        </div>
      </div>
    </header>

    {#if error}
      <p class="notice error">{error}</p>
    {:else if !items}
      {#each [1, 2] as i (i)}<span class="skeleton" style="height:8rem"></span>{/each}
    {:else if !items.length}
      <div class="empty">
        <h2>{status === "open" ? t("Niente da decidere") : t("Nessuna decisione")}</h2>
        <p>{status === "open" ? t("Le celle sono d'accordo su tutto quello che è nell'alveare.") : t("Le decisioni prese appaiono qui.")}</p>
      </div>
    {:else}
      <ul class="items">
        {#each items as it (it.id)}
          <li class="card {it.kind}">
            <div class="ch">
              <span class="kind">{KIND[it.kind]}</span>
              <span class="dim">{it.vaultName} · {when(it.createdAt)}</span>
            </div>
            <h2>
              {#if it.pageId}<a href="#/p/{it.pageId}" onclick={(e) => open(e, it.pageId!)} onmouseenter={() => prefetch(it.pageId!)}>{title(it)}</a>{:else}{title(it)}{/if}
              {#if it.predicate}<span class="pred">· {it.predicate}</span>{/if}
            </h2>

            {#if it.kind === "conflict" && it.data.values}
              <ul class="values">
                {#each it.data.values as v (v.valueNorm)}
                  <li>
                    <span class="v">{v.value.replace(/\[\[([^\]|]*)(\|([^\]]*))?\]\]/g, (_m, t, _x, d) => d ?? t)}</span>
                    <span class="dim small">
                      {#each v.refs as r, i (r.pageId + i)}{#if i},{/if} <a href="#/p/{r.pageId}" onclick={(e) => open(e, r.pageId)}>{r.vaultName ?? t("cella")}</a>{#if r.observedAt} ({r.observedAt}){/if}{/each}
                    </span>
                    {#if status === "open"}<Button size="sm" busy={busy === it.id} onclick={() => act(it, "resolve", { choice: v.valueNorm }, t("Valore scelto: la pagina dell'alveare è aggiornata."))}>{t("Scegli")}</Button>{/if}
                  </li>
                {/each}
              </ul>
              {#if status === "open"}
                <div class="row">
                  <input class="input" placeholder={t("Oppure scrivi il valore corretto")} bind:value={custom[it.id]} aria-label={t("Valore corretto")} />
                  <Button size="sm" disabled={!custom[it.id]?.trim()} busy={busy === it.id} onclick={() => act(it, "resolve", { custom: custom[it.id] }, t("Valore salvato."))}>{t("Usa questo valore")}</Button>
                  <Button size="sm" variant="quiet" busy={busy === it.id} onclick={() => act(it, "resolve", { keepAll: true }, t("Tutti i valori restano nella pagina."))}>{t("Sono tutti validi")}</Button>
                </div>
              {/if}
            {:else if it.kind === "proposal" && it.data.body !== undefined}
              <p class="small">{t("Proposta da")} <strong>{it.data.by}</strong>{it.data.section ? t(" per la sezione «{section}»", { section: it.data.section }) : ""}: {it.data.rationale}</p>
              <pre class="diff mono">{#each proposalDiff(it.data.before ?? "", it.data.body) as c, i (i)}<span class={c.kind}>{c.text}</span>{/each}</pre>
              {#if status === "open"}
                <div class="row">
                  <Button size="sm" variant="primary" busy={busy === it.id} onclick={() => act(it, "apply", {}, t("Modifica applicata alla pagina."))}>{t("Approva e applica")}</Button>
                  <Button size="sm" variant="quiet" busy={busy === it.id} onclick={() => act(it, "dismiss", {}, t("Proposta rifiutata."))}>{t("Rifiuta")}</Button>
                </div>
              {/if}
            {:else if it.kind === "mass_change" && it.data.subjects}
              <p class="small">
                {t("Il ciclo notturno vuole togliere {n} pagine su {total}: le celle collegate non ne parlano più. Sono tante tutte insieme, quindi aspetta la tua conferma. Succede se una cella è stata scollegata o svuotata per errore.", { n: it.data.subjects.length, total: it.data.total })}
              </p>
              <details><summary class="small">{t("Pagine coinvolte")}</summary><p class="dim small">{it.data.subjects.join(" · ")}</p></details>
              {#if status === "open"}
                <div class="row">
                  <Button size="sm" variant="danger" busy={busy === it.id} onclick={() => act(it, "resolve", {}, t("Pagine rimosse dall'alveare."))}>{t("Conferma la rimozione")}</Button>
                  <Button size="sm" variant="quiet" busy={busy === it.id} onclick={() => act(it, "dismiss", {}, t("Le pagine restano."))}>{t("Tieni le pagine")}</Button>
                </div>
              {/if}
            {:else if it.kind === "rectification"}
              <p class="small">{t("Un amministratore ha corretto questa pagina. Il ciclo notturno la lascia com'è finché la voce resta aperta. Correggi anche le pagine e i documenti da cui viene il dato, poi chiudi la voce: dalla notte dopo la pagina si ricostruisce dalle fonti corrette.")}</p>
              {#if it.data.pages?.length}
                <h3 class="small">{t("Pagine da correggere")}</h3>
                <ul class="refs small">{#each it.data.pages as p (p.id)}<li><a href="#/p/{p.id}" onclick={(e) => open(e, p.id)}>{p.title}</a> <span class="dim">· {p.vaultName}</span></li>{/each}</ul>
              {/if}
              {#if it.data.sources?.length}
                <h3 class="small">{t("Documenti da correggere")}</h3>
                <ul class="refs small">{#each it.data.sources as s (s.id)}<li><a href="#/sorgente/{s.id}">{s.name}</a> <span class="dim">· {s.vaultName}</span></li>{/each}</ul>
              {/if}
              {#if !it.data.pages?.length && !it.data.sources?.length}<p class="dim small">{t("La pagina non cita fonti che puoi leggere.")}</p>{/if}
              {#if status === "open"}
                <div class="row"><Button size="sm" busy={busy === it.id} onclick={() => act(it, "resolve", {}, t("Voce chiusa: dalla prossima notte la pagina si ricostruisce dalle fonti."))}>{t("Fonti corrette")}</Button></div>
              {/if}
            {:else if it.kind === "review"}
              <p class="small">{t("La pagina ha superato la data di ricontrollo ({at}): i fatti potrebbero essere cambiati. Leggila, correggila se serve, poi confermala: conta come controllata da oggi.", { at: it.data.reviewAfter ?? "" })}</p>
              {#if status === "open"}
                <div class="row">
                  <Button size="sm" busy={busy === it.id} onclick={() => act(it, "resolve", {}, t("Pagina confermata: conta come controllata da oggi."))}>{t("È corretta")}</Button>
                  <Button size="sm" variant="quiet" busy={busy === it.id} onclick={() => act(it, "dismiss", {}, t("Voce ignorata."))}>{t("Ignora")}</Button>
                </div>
              {/if}
            {:else if it.kind === "duplicate" && it.data.a && it.data.b}
              <div class="pair">
                {#each [it.data.a, it.data.b] as p (p.id)}
                  <div class="side">
                    <a href="#/p/{p.id}" onclick={(e) => open(e, p.id)} onmouseenter={() => prefetch(p.id)}>{p.title}</a>
                    {#if p.tldr}<p class="dim small">{p.tldr}</p>{/if}
                    {#if status === "open"}<Button size="sm" busy={busy === it.id} onclick={() => act(it, "merge", { keep: p.id }, t("Pagine unite in «{title}». I link sono stati aggiornati.", { title: p.title }))}>{t("Tieni questa e unisci")}</Button>{/if}
                  </div>
                {/each}
              </div>
              {#if it.data.similarity}<p class="dim small">{t("Somiglianza dei titoli: {round}%", { round: Math.round(it.data.similarity * 100) })}</p>{/if}
              {#if status === "open"}<div class="row"><Button size="sm" variant="quiet" busy={busy === it.id} onclick={() => act(it, "dismiss", {}, t("Segnato come non duplicato."))}>{t("Non sono la stessa cosa")}</Button></div>{/if}
            {:else}
              {#if it.data.value}<p>{t("Valore:")} <strong>{it.data.value}</strong>{#if it.data.confidence !== undefined} {t("· fiducia della compilazione {round}%", { round: Math.round((it.data.confidence ?? 0) * 100) })}{/if}</p>{/if}
              {#if status === "open"}
                <div class="row">
                  <Button size="sm" busy={busy === it.id} onclick={() => act(it, "resolve", {}, t("Segnato come verificato."))}>{t("Verificato")}</Button>
                  <Button size="sm" variant="quiet" busy={busy === it.id} onclick={() => act(it, "dismiss", {}, t("Voce ignorata."))}>{t("Ignora")}</Button>
                </div>
              {/if}
            {/if}
            {#if status !== "open"}<p class="dim small">{t("Decisione: {it}{x}", { it: decision(it), x: it.resolvedAt ? ` · ${when(it.resolvedAt)}` : "" })}</p>{/if}
          </li>
        {/each}
      </ul>
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
    max-width: 52rem;
    margin: 0 auto;
    display: grid;
    gap: 1.25rem;
  }
  header {
    display: grid;
    gap: 0.6rem;
  }
  h1 {
    font-size: var(--fs-2xl);
  }
  .lead {
    color: var(--text-muted);
    max-width: 68ch;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem 1.25rem;
    align-items: center;
  }
  .seg {
    display: flex;
    gap: 0.25rem;
    padding: 0.2rem;
    border-radius: var(--r-control);
    background: var(--ink-1);
  }
  .seg button {
    padding: 0.3rem 0.8rem;
    border: 0;
    border-radius: 6px;
    background: none;
    cursor: pointer;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .seg button[aria-selected="true"] {
    background: var(--ink-3);
    color: var(--text-main);
  }
  .grp {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .items {
    list-style: none;
    display: grid;
    gap: 0.9rem;
  }
  .card {
    display: grid;
    gap: 0.6rem;
    padding: 1rem 1.1rem;
    border-radius: var(--r-panel);
    background: var(--ink-1);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-card);
  }
  .card.conflict {
    box-shadow:
      inset 3px 0 0 var(--you),
      var(--shadow-card);
  }
  .ch {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    font-size: var(--fs-xs);
  }
  .kind {
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  .conflict .kind {
    color: var(--you-ink);
  }
  h2 {
    font-size: var(--fs-lg);
  }
  h2 a,
  .side a,
  .values a {
    color: var(--link);
    text-decoration: none;
  }
  h2 a:hover,
  .side a:hover,
  .values a:hover {
    text-decoration: underline;
  }
  .pred {
    color: var(--text-muted);
    font-weight: 500;
  }
  .values {
    list-style: none;
    display: grid;
    gap: 0.4rem;
  }
  .values li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.9rem;
    padding: 0.45rem 0.6rem;
    border-radius: var(--r-control);
    background: var(--ink-0);
  }
  .v {
    font-weight: 620;
    min-width: 8rem;
  }
  .values .dim {
    flex: 1;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .row .input {
    max-width: 20rem;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  .side {
    display: grid;
    gap: 0.4rem;
    align-content: start;
    padding: 0.6rem 0.75rem;
    border-radius: var(--r-control);
    background: var(--ink-0);
  }
  .small {
    font-size: var(--fs-xs);
  }
  .diff {
    max-height: 18rem;
    overflow: auto;
    white-space: pre-wrap;
    font-size: var(--fs-xs);
    line-height: 1.5;
    padding: 0.6rem;
    border-radius: var(--r-control);
    background: var(--ink-0);
  }
  .diff .add {
    display: block;
    background: var(--busy-soft);
    box-shadow: inset 3px 0 0 var(--busy);
    padding-left: 0.4rem;
  }
  .diff .del {
    display: block;
    background: var(--alert-soft);
    color: var(--text-muted);
    text-decoration: line-through;
    box-shadow: inset 3px 0 0 var(--alert);
    padding-left: 0.4rem;
  }
  .diff .same {
    display: block;
    color: var(--text-dim);
    padding-left: 0.4rem;
  }
  .card.proposal {
    box-shadow:
      inset 3px 0 0 var(--accent-blue),
      var(--shadow-card);
  }
</style>
