<script lang="ts">
  // Reports of the dream cycle (plan §5 step 12): one row per vault and night, the details of
  // every step on request.
  import { api } from "../../lib/api.ts";
  import { nf, when } from "../../lib/format.ts";
  import { intlLocale, t } from "../../lib/i18n.ts";

  interface Run {
    vaultId: string;
    vaultName: string;
    kind: string;
    night: string;
    status: "running" | "paused" | "done" | "failed";
    step: string | null;
    report: Record<string, Record<string, number | string>>;
    tokens: number;
    startedAt: string;
    finishedAt: string | null;
  }

  const STEP_TITLE: Record<string, string> = {
    reparse: t("1 · Nuova lettura con parser aggiornati"),
    backlog: "2 · Backlog I2/I3",
    dedup: "3 · Deduplica",
    crosslink: t("4 · Collegamento delle menzioni"),
    lint: "5 · Controlli",
    tldr: "6 · Sintesi",
    promote: "7 · Promozione all'alveare",
    importance: "8 · Importanza",
    indexes: "9 · Indici e llms.txt",
    database: "10 · Database",
    backup: "11 · Verifiche",
    report: "12 · Rapporto",
  };
  const STATUS: Record<string, { label: string; tone: string }> = {
    running: { label: t("In corso"), tone: "busy" },
    paused: { label: t("In pausa fino alla prossima notte"), tone: "you" },
    done: { label: t("Completato"), tone: "idle" },
    failed: { label: t("Errore"), tone: "alert" },
  };

  let runs = $state<Run[] | null>(null);
  let error = $state("");
  let open = $state<string | null>(null);

  $effect(() => {
    api.get<Run[]>("/api/dream?limit=100").then(
      (r) => (runs = r),
      (e: Error) => (error = e.message),
    );
  });

  const nights = $derived([...new Set((runs ?? []).map((r) => r.night))]);
  const fmt = (v: number | string) => (typeof v === "number" ? nf.format(v) : v);
  const highlights = (r: Run) => {
    const out: string[] = [];
    const g = (s: string, k: string) => r.report[s]?.[k];
    if (g("promote", "scritte")) out.push(t("{g} pagine d'alveare aggiornate", { g: g("promote", "scritte") }));
    if (g("promote", "conflitti")) out.push(`${g("promote", "conflitti")} conflitti aperti`);
    if (g("dedup", "unite")) out.push(`${g("dedup", "unite")} duplicati uniti`);
    if (g("crosslink", "link aggiunti")) out.push(`${g("crosslink", "link aggiunti")} link aggiunti`);
    if (g("backlog", "vettori")) out.push(`${fmt(g("backlog", "vettori")!)} vettori`);
    if (g("tldr", "sintesi")) out.push(`${g("tldr", "sintesi")} sintesi`);
    if (g("lint", "link rotti")) out.push(`${g("lint", "link rotti")} link rotti`);
    return out.join(" · ") || t("nessun cambiamento");
  };
</script>

<div class="dv">
  <div class="col">
    <header>
      <h1>{t("Ciclo notturno")}</h1>
      <p class="lead">{t("Ogni notte il server riordina la memoria: legge di nuovo i documenti con parser aggiornati, calcola i vettori mancanti, unisce i duplicati, collega le menzioni, controlla link e contraddizioni, aggiorna le sintesi e porta nell'alveare le informazioni delle celle. Se il tempo della notte non basta, riprende la notte dopo dal punto in cui si è fermato.")}</p>
    </header>
    {#if error}
      <p class="notice error">{error}</p>
    {:else if !runs}
      <span class="skeleton" style="height:10rem"></span>
    {:else if !runs.length}
      <div class="empty"><h2>{t("Nessun ciclo ancora")}</h2><p>{t("Il primo ciclo parte all'inizio della finestra notturna.")}</p></div>
    {:else}
      {#each nights as n (n)}
        <section>
          <h2>{t("Notte del {toLocaleDateString}", { toLocaleDateString: new Date(`${n}T12:00:00`).toLocaleDateString(intlLocale, { weekday: "long", day: "numeric", month: "long" }) })}</h2>
          <ul class="runs">
            {#each runs.filter((r) => r.night === n) as r (r.vaultId + r.night)}
              {@const st = STATUS[r.status] ?? { label: r.status, tone: "dim" }}
              {@const key = r.vaultId + r.night}
              <li>
                <button class="row" aria-expanded={open === key} onclick={() => (open = open === key ? null : key)}>
                  <span class="dot {st.tone}"></span>
                  <span class="name">{r.vaultName} <span class="dim">· {r.kind === "space" ? t("alveare") : t("cella")}</span></span>
                  <span class="hl">{r.status === "done" ? highlights(r) : `${st.label}${r.step ? ` · passo ${STEP_TITLE[r.step] ?? r.step}` : ""}`}</span>
                  <span class="dim when">{when(r.finishedAt ?? r.startedAt)}</span>
                </button>
                {#if open === key}
                  <dl class="steps">
                    {#each Object.keys(STEP_TITLE).filter((s) => r.report[s]) as s (s)}
                      <dt>{STEP_TITLE[s]}</dt>
                      <dd>
                        {Object.entries(r.report[s]!)
                          .filter(([k]) => k !== "ms")
                          .map(([k, v]) => `${k}: ${fmt(v)}`)
                          .join(" · ") || t("fatto")}
                        <span class="dim"> · {fmt(Number(r.report[s]!.ms ?? 0))} ms</span>
                      </dd>
                    {/each}
                    {#if r.report._cycle}<dt>{t("Sessioni")}</dt><dd>{Object.entries(r.report._cycle).map(([k, v]) => `${k}: ${v}`).join(" · ")}</dd>{/if}
                    {#if r.tokens}<dt>{t("Token del modello")}</dt><dd>{nf.format(r.tokens)}</dd>{/if}
                  </dl>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </div>
</div>

<style>
  .dv {
    overflow-y: auto;
    min-height: 0;
    padding: 2rem 2rem 5rem;
  }
  .col {
    max-width: 58rem;
    margin: 0 auto;
    display: grid;
    gap: 1.5rem;
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
    margin-bottom: 0.5rem;
  }
  .lead {
    color: var(--text-muted);
    max-width: 72ch;
  }
  .runs {
    list-style: none;
    display: grid;
    border-top: 1px solid var(--line);
  }
  .runs li {
    border-bottom: 1px solid var(--line);
  }
  .row {
    width: 100%;
    display: grid;
    grid-template-columns: auto minmax(10rem, 14rem) 1fr auto;
    gap: 0.75rem;
    align-items: center;
    padding: 0.6rem 0.4rem;
    border: 0;
    background: none;
    cursor: pointer;
    text-align: left;
    font-size: var(--fs-sm);
  }
  .row:hover {
    background: var(--ink-1);
  }
  .name {
    font-weight: 600;
  }
  .hl {
    color: var(--text-muted);
  }
  .when {
    font-size: var(--fs-xs);
  }
  .steps {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.3rem 1rem;
    padding: 0.5rem 0.75rem 0.9rem 2rem;
    font-size: var(--fs-xs);
  }
  .steps dt {
    color: var(--text-muted);
  }
  @media (max-width: 800px) {
    .row {
      grid-template-columns: auto 1fr;
    }
    .hl,
    .when {
      grid-column: 2;
    }
  }
</style>
