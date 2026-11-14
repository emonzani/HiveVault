<script lang="ts">
  // Durable tasks (@cb/tasks): counts by status, list with filters, detail with the event
  // journal; a failed or cancelled task can start again, a live one can be cancelled.
  import Explain from "../../../components/Explain.svelte";
  import { EXPLAIN_ADMIN } from "../../../lib/explain.ts";
  import Button from "../../../components/Button.svelte";
  import Icon from "../../../components/Icon.svelte";
  import { api, qs, request } from "../../../lib/api.ts";
  import { ago, when } from "../../../lib/format.ts";
  import { ui } from "../../../lib/ui.svelte.ts";
  import { ws } from "../../../lib/workspace.svelte.ts";
  import { intlLocale, t } from "../../../lib/i18n.ts";

  let { selected }: { selected?: string } = $props();

  interface Task {
    id: string;
    name: string;
    status: string;
    phase: string;
    attempts: number;
    maxAttempts: number;
    priority: number;
    error: string | null;
    requestId: string | null;
    runAfter: string;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
    worker: string | null;
  }
  interface Detail {
    task: Task & { input: unknown; state: unknown; result: unknown };
    events: { at: string; kind: string; phase: string | null; data: unknown }[];
  }
  const STATUS: Record<string, { label: string; tone: string }> = {
    queued: { label: t("In coda"), tone: "" },
    running: { label: t("In corso"), tone: "idle" },
    sleeping: { label: t("In attesa"), tone: "warn" },
    waiting: { label: t("Aspetta altri task"), tone: "" },
    done: { label: t("Completato"), tone: "busy" },
    failed: { label: t("Fallito"), tone: "alert" },
    cancelled: { label: t("Annullato"), tone: "" },
  };
  const NAME: Record<string, string> = { ingest: t("Lettura documento"), import: t("Import massivo"), dream: t("Ciclo notturno"), "dream-scheduler": t("Pianificatore notturno") };

  let status = $state("");
  let name = $state("");
  let q = $state("");
  let data = $state<{ items: Task[]; counts: Record<string, number>; names: string[] } | null>(null);
  let detail = $state<Detail | null>(null);
  let error = $state("");
  let busy = $state("");

  async function load() {
    try {
      data = await api.get(`/api/admin/tasks${qs({ status, name, q: q.trim(), limit: 200 })}`);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  let timer: ReturnType<typeof setTimeout>;
  $effect(() => {
    void [status, name, q];
    clearTimeout(timer);
    timer = setTimeout(load, 200);
  });
  $effect(() => {
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  });
  $effect(() => {
    if (!selected) return void (detail = null);
    api.get<Detail>(`/api/admin/tasks/${selected}`).then((d) => (detail = d), (e: Error) => ui.toast(e.message, "error"));
  });
  const select = (id?: string) => ws.open({ kind: "admin", section: "task", ...(id ? { id } : {}) });

  async function act(id: string, action: "retry" | "cancel") {
    if (action === "cancel" && !confirm(t("Annullare il task? Gli effetti già registrati restano."))) return;
    busy = id + action;
    try {
      await api.post(`/api/admin/tasks/${id}/${action}`);
      ui.toast(action === "retry" ? t("Task di nuovo in coda.") : t("Task annullato."), "ok");
      await load();
      if (selected === id) detail = await api.get<Detail>(`/api/admin/tasks/${id}`);
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = "";
    }
  }
  /** Priority (0 first) and "run now" of a task that waits; the engine reads them at once. */
  async function patch(id: string, body: { priority?: number; runNow?: true }, ok: string) {
    busy = id + "patch";
    try {
      await request("PATCH", `/api/admin/tasks/${id}`, body);
      ui.toast(ok, "ok");
      await load();
      if (selected === id) detail = await api.get<Detail>(`/api/admin/tasks/${id}`);
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = "";
    }
  }
  const waiting = (s: string) => ["queued", "sleeping", "waiting"].includes(s);
  const live = (s: string) => ["queued", "running", "sleeping", "waiting"].includes(s);
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  const n = (k: string) => data?.counts[k] ?? 0;
</script>

<div class="adm">
  <header class="adm-head">
    <div>
      <p class="eyebrow you">{t("Motore dei task")}</p>
      <h1>{t("Task")}</h1>
      <p>{t("Il lavoro lungo del server: letture dei documenti, import, ciclo notturno. Ogni task salva lo stato a ogni fase e riprende dopo un riavvio.")}</p>
    </div>
  </header>
  <Explain id="admin-task" text={EXPLAIN_ADMIN["task"]!} />

  {#if data}
    <div class="kpis" role="group" aria-label={t("Riepilogo dei task")}>
      <button class="kpi idle" aria-pressed={status === "running"} onclick={() => (status = status === "running" ? "" : "running")}>
        <span class="eyebrow">{t("Attivi")}</span>
        <span class="kpi-icon" aria-hidden="true"><Icon name="play" size={16} /></span>
        <span class="kpi-value">{n("running")}<span class="kpi-note">{t("in corso")}</span></span>
      </button>
      <button class="kpi" aria-pressed={status === "queued"} onclick={() => (status = status === "queued" ? "" : "queued")}>
        <span class="eyebrow">{t("In attesa")}</span>
        <span class="kpi-icon" aria-hidden="true"><Icon name="history" size={16} /></span>
        <span class="kpi-value">{n("queued") + n("sleeping") + n("waiting")}<span class="kpi-note">{t("{n} aspettano un modello", { n: n("sleeping") })}</span></span>
      </button>
      <button class="kpi busy" aria-pressed={status === "done"} onclick={() => (status = status === "done" ? "" : "done")}>
        <span class="eyebrow">{t("Completati")}</span>
        <span class="kpi-icon" aria-hidden="true"><Icon name="check" size={16} /></span>
        <span class="kpi-value">{n("done")}<span class="kpi-note">{t("conservati")}</span></span>
      </button>
      <button class="kpi {n('failed') ? 'alert' : ''}" aria-pressed={status === "failed"} onclick={() => (status = status === "failed" ? "" : "failed")}>
        <span class="eyebrow">{t("Falliti")}</span>
        <span class="kpi-icon" aria-hidden="true"><Icon name="alert" size={16} /></span>
        <span class="kpi-value">{n("failed")}<span class="kpi-note">{n("failed") ? t("da controllare") : t("nessun errore")}</span></span>
      </button>
    </div>
    <div class="adm-bar" role="group" aria-label={t("Filtra per stato")}>
      <button class="chip" aria-pressed={status === ""} onclick={() => (status = "")}>{t("Tutti")}</button>
      {#each Object.entries(STATUS) as [k, s] (k)}
        <button class="chip" aria-pressed={status === k} onclick={() => (status = status === k ? "" : k)}>{s.label} <span class="n">{data.counts[k] ?? 0}</span></button>
      {/each}
    </div>
  {/if}
  <div class="adm-bar">
    <select class="input" aria-label={t("Tipo di task")} bind:value={name}>
      <option value="">{t("Tutti i tipi")}</option>
      {#each data?.names ?? [] as n (n)}<option value={n}>{NAME[n] ?? n}</option>{/each}
    </select>
    <input class="input" type="search" placeholder={t("Id, chiave o errore")} aria-label={t("Cerca")} bind:value={q} />
  </div>

  {#if error}
    <p class="notice error">{error}</p>
  {:else if !data}
    <span class="skeleton" style="height:14rem"></span>
  {:else}
    <div class="split" class:open={!!detail}>
      <div class="adm-scroll">
        <table class="adm-table">
          <thead><tr><th>{t("Task")}</th><th>{t("Stato")}</th><th>{t("Fase")}</th><th class="num">{t("Tentativi")}</th><th>{t("Aggiornato")}</th><th></th></tr></thead>
          <tbody>
            {#each data.items as task (task.id)}
              {@const st = STATUS[task.status] ?? { label: task.status, tone: "" }}
              <tr class:sel={task.id === selected}>
                <td>
                  <button class="link" onclick={() => select(task.id === selected ? undefined : task.id)}>{NAME[task.name] ?? task.name}</button>
                  <div class="dim mono id">{task.requestId ?? task.id}</div>
                  {#if task.error}<div class="err">{task.error.slice(0, 160)}</div>{/if}
                </td>
                <td><span class="badge {st.tone}">{st.label}</span></td>
                <td class="mono dim">{task.phase}</td>
                <td class="num">{task.attempts}/{task.maxAttempts}</td>
                <td class="dim">{ago(task.updatedAt)}</td>
                <td class="acts">
                  {#if task.status === "failed" || task.status === "cancelled"}
                    <Button size="sm" variant="quiet" busy={busy === task.id + "retry"} onclick={() => act(task.id, "retry")}>{t("Riprova")}</Button>
                  {:else if live(task.status)}
                    <Button size="sm" variant="quiet" busy={busy === task.id + "cancel"} onclick={() => act(task.id, "cancel")}>{t("Annulla")}</Button>
                  {/if}
                </td>
              </tr>
            {:else}
              <tr><td colspan="6" class="dim">{t("Nessun task.")}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if detail}
        {@const task = detail.task}
        <aside class="adm-card detail" aria-label={t("Dettaglio del task")}>
          <header class="dh">
            <h2>{NAME[task.name] ?? task.name}</h2>
            <button class="icon-btn" aria-label={t("Chiudi il dettaglio")} onclick={() => select()}>×</button>
          </header>
          <dl class="kv">
            <dt>Id</dt><dd class="mono">{task.id}</dd>
            <dt>{t("Stato")}</dt><dd>{t("{x} · fase {phase}", { x: STATUS[task.status]?.label ?? task.status, phase: task.phase })}</dd>
            <dt>{t("Creato")}</dt><dd>{when(task.createdAt)}</dd>
            {#if task.finishedAt}<dt>{t("Concluso")}</dt><dd>{when(task.finishedAt)}</dd>{/if}
            {#if waiting(task.status)}<dt>{t("Previsto")}</dt><dd>{when(task.runAfter)}</dd>{/if}
          </dl>
          {#if waiting(task.status)}
            <div class="adm-bar">
              <label class="pri">{t("Priorità")}
                <select class="input" value={task.priority} disabled={busy === task.id + "patch"} onchange={(e) => patch(task.id, { priority: Number((e.currentTarget as HTMLSelectElement).value) }, t("Priorità aggiornata."))}>
                  {#each Array.from({ length: 10 }, (_, i) => i) as p (p)}<option value={p}>{p}{p === 0 ? t(" (prima)") : p === 9 ? t(" (ultima)") : ""}</option>{/each}
                </select>
              </label>
              {#if new Date(task.runAfter).getTime() > Date.now()}
                <Button size="sm" busy={busy === task.id + "patch"} onclick={() => patch(task.id, { runNow: true }, t("Il task parte appena c'è un worker libero."))}>{t("Esegui ora")}</Button>
              {/if}
            </div>
          {/if}
          {#if task.error}<p class="notice error">{task.error}</p>{/if}
          <details><summary>{t("Ingresso")}</summary><pre class="mono">{json(task.input)}</pre></details>
          <details><summary>{t("Stato salvato")}</summary><pre class="mono">{json(task.state)}</pre></details>
          {#if task.result}<details open><summary>{t("Risultato")}</summary><pre class="mono">{json(task.result)}</pre></details>{/if}
          <h3>{t("Giornale")}</h3>
          <ol class="events">
            {#each detail.events as e, i (i)}
              <li><span class="dim">{new Date(e.at).toLocaleTimeString(intlLocale)}</span> <strong>{e.kind}</strong>{#if e.phase} <span class="mono">{e.phase}</span>{/if}{#if e.data}<span class="dim"> {JSON.stringify(e.data).slice(0, 140)}</span>{/if}</li>
            {:else}<li class="dim">{t("Nessun evento.")}</li>{/each}
          </ol>
        </aside>
      {/if}
    </div>
  {/if}
</div>

<style>
  .split {
    display: grid;
    gap: 1rem;
    align-items: start;
  }
  .split.open {
    grid-template-columns: minmax(0, 1fr) minmax(20rem, 30rem);
  }
  .id {
    font-size: var(--fs-xs);
    max-width: 22rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err {
    font-size: var(--fs-xs);
    color: var(--alert-ink);
  }
  .detail {
    position: sticky;
    top: 0;
    max-height: calc(100vh - 8rem);
    overflow-y: auto;
  }
  .dh {
    display: flex;
    justify-content: space-between;
  }
  h3 {
    font-size: var(--fs-sm);
  }
  details summary {
    cursor: pointer;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  pre {
    font-size: var(--fs-xs);
    background: var(--well);
    padding: 0.6rem;
    border-radius: var(--r-control);
    overflow: auto;
    max-height: 16rem;
  }
  .pri {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .pri .input {
    width: auto;
  }
  .events {
    list-style: none;
    display: grid;
    gap: 0.2rem;
    font-size: var(--fs-xs);
  }
  @media (max-width: 1100px) {
    .split.open {
      grid-template-columns: 1fr;
    }
    .detail {
      position: static;
      max-height: none;
    }
  }
</style>
