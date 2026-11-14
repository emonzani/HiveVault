<script lang="ts">
  // Models page (plan §10): every endpoint of the dispatcher with its state, latency and
  // throughput; the local processes (start, stop, threads, schedule, log); the remote
  // endpoints added from here. The page refreshes every 5 seconds.
  import Explain from "../../../components/Explain.svelte";
  import { EXPLAIN_ADMIN } from "../../../lib/explain.ts";
  import Button from "../../../components/Button.svelte";
  import { api, request } from "../../../lib/api.ts";
  import { HHMM_RANGE } from "../../../lib/admin.ts";
  import { ago, dec1, nf } from "../../../lib/format.ts";
  import { ui } from "../../../lib/ui.svelte.ts";
  import { ws } from "../../../lib/workspace.svelte.ts";
  import { t } from "../../../lib/i18n.ts";

  interface Endpoint {
    id: string;
    kind: "chat" | "embed" | "rerank" | "ocr";
    origin: "local" | "remote";
    url: string;
    status: "unknown" | "up" | "down" | "mismatch";
    reason?: string;
    slots: number;
    inflight: number;
    requests: number;
    errors: number;
    items: number;
    latencyMs: number | null;
    itemsPerSec: number | null;
  }
  interface Local {
    name: string;
    kind: "embed" | "rerank";
    status: "stopped" | "starting" | "running" | "unhealthy" | "backoff" | "disabled";
    pid?: number;
    restarts: number;
    lastError?: string;
    startedAt?: string;
    logTail: string[];
    threads: number;
    schedule: string;
    model: string;
    port: number;
  }
  interface Snapshot {
    endpoints: Endpoint[];
    queues: Record<string, Record<string, number>>;
    local: Local[];
    localSettings: { threads: number; schedule: "always" | "off-hours" | "on-demand"; offHours: string };
    remote: { id: string; kind: string; url: string }[];
    /** New addresses of .env endpoints, set from the console. */
    overrides: Record<string, string>;
  }
  const KIND = { chat: t("Chat"), embed: t("Embedding"), rerank: t("Rerank"), ocr: "OCR (immagini)" } as const;
  const EP_STATUS = { up: { l: t("Attivo"), t: "idle" }, down: { l: t("Non raggiungibile"), t: "alert" }, mismatch: { l: t("Modello diverso"), t: "alert" }, unknown: { l: t("Verifica…"), t: "" } } as const;
  const PROC = { running: { l: t("In esecuzione"), t: "idle" }, starting: { l: t("Avvio…"), t: "busy" }, unhealthy: { l: t("Non risponde"), t: "alert" }, backoff: { l: t("Riavvio a breve"), t: "you" }, stopped: { l: t("Fermo"), t: "" }, disabled: { l: t("Fuori fascia"), t: "" } } as const;
  const SCHEDULE = { always: t("Sempre attivi"), "off-hours": t("Solo nella fascia indicata"), "on-demand": t("Solo quando servono") } as const;

  let snap = $state<Snapshot | null>(null);
  let error = $state("");
  let busy = $state("");
  let tests = $state<Record<string, { ok: boolean; ms?: number; model?: string; error?: string }>>({});
  let local = $state<Snapshot["localSettings"] | null>(null);
  let logOpen = $state<string | null>(null);
  let nr = $state({ kind: "embed", url: "" });
  let editUrl = $state<{ id: string; url: string } | null>(null);

  async function load() {
    try {
      snap = await api.get<Snapshot>("/api/admin/models");
      local ??= { ...snap.localSettings };
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  });

  async function run<T>(label: string, fn: () => Promise<T>, ok?: string) {
    busy = label;
    try {
      const r = await fn();
      if (ok) ui.toast(ok, "ok");
      await load();
      return r;
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = "";
    }
  }
  async function test(id: string) {
    busy = `test-${id}`;
    try {
      tests = { ...tests, [id]: await api.post(`/api/admin/models/${encodeURIComponent(id)}/test`) };
    } catch (e) {
      tests = { ...tests, [id]: { ok: false, error: (e as Error).message } };
    } finally {
      busy = "";
    }
  }
  const remoteIds = $derived(new Set(snap?.remote.map((r) => r.id) ?? []));
</script>

<div class="adm">
  <header class="adm-head">
    <div>
      <p class="eyebrow you">{t("Console")}</p>
      <h1>{t("Modelli")}</h1>
      <p>{t("Tutte le chiamate ai modelli passano dal dispatcher: le richieste interattive hanno la precedenza su caricamenti e ciclo notturno. I modelli girano solo su questo server o sugli host della rete aziendale: nessun documento esce.")}</p>
    </div>
    <Button variant="quiet" onclick={() => ws.open({ kind: "dashboard", id: "modelli" })}>{t("Dashboard dei modelli")}</Button>
  </header>
  <Explain id="admin-modelli" text={EXPLAIN_ADMIN["modelli"]!} />

  {#if error}
    <p class="notice error">{error}</p>
  {:else if !snap || !local}
    <span class="skeleton" style="height:14rem"></span>
  {:else}
    <section class="adm-card">
      <h2>{t("Endpoint")}</h2>
      <div class="adm-scroll">
        <table class="adm-table">
          <thead><tr><th>{t("Endpoint")}</th><th>{t("Tipo")}</th><th>{t("Stato")}</th><th class="num">{t("In corso")}</th><th class="num">{t("Latenza")}</th><th class="num">{t("Elementi/s")}</th><th class="num">{t("Richieste")}</th><th class="num">{t("Errori")}</th><th></th></tr></thead>
          <tbody>
            {#each snap.endpoints as e (e.id)}
              {@const st = EP_STATUS[e.status]}
              {@const probe = tests[e.id]}
              <tr>
                <td>
                  <strong class="mono">{e.id}</strong> <span class="badge">{e.origin === "local" ? t("locale") : t("remoto")}</span>
                  <div class="dim mono url">{e.url}{#if snap.overrides?.[e.id]} <span class="badge you">{t("indirizzo cambiato dalla console")}</span>{/if}</div>
                  {#if probe}<div class={probe.ok ? "ok" : "err"}>{probe.ok ? t("Test riuscito in {format} ms{x}", { format: nf.format(probe.ms ?? 0), x: probe.model ? ` · ${probe.model}` : "" }) : t("Test non riuscito: {error}", { error: probe.error })}</div>{/if}
                </td>
                <td>{KIND[e.kind]}</td>
                <td><span class="badge {st.t}" title={e.reason ?? ""}>{st.l}</span></td>
                <td class="num">{e.inflight}/{e.slots}</td>
                <td class="num">{e.latencyMs === null ? "—" : t("{format} ms", { format: nf.format(Math.round(e.latencyMs)) })}</td>
                <td class="num">{e.itemsPerSec === null ? "—" : dec1(e.itemsPerSec)}</td>
                <td class="num">{nf.format(e.requests)}</td>
                <td class="num">{nf.format(e.errors)}</td>
                <td class="acts">
                  <Button size="sm" variant="quiet" busy={busy === `test-${e.id}`} onclick={() => test(e.id)}>{t("Prova")}</Button>
                  {#if e.origin === "remote"}
                    <Button size="sm" variant="quiet" aria-expanded={editUrl?.id === e.id} onclick={() => (editUrl = editUrl?.id === e.id ? null : { id: e.id, url: e.url })}>{t("Modifica")}</Button>
                  {/if}
                  {#if remoteIds.has(e.id)}
                    <Button size="sm" variant="quiet" onclick={() => confirm(t("Rimuovere {id}?", { id: e.id })) && run("rm", () => api.del(`/api/admin/models/remote/${encodeURIComponent(e.id)}`), t("Endpoint rimosso."))}>{t("Rimuovi")}</Button>
                  {/if}
                </td>
              </tr>
              {#if editUrl?.id === e.id}
                <tr class="edit-row">
                  <td colspan="9">
                    <form class="adm-bar" onsubmit={(ev) => (ev.preventDefault(), run("url", () => request("PATCH", `/api/admin/models/remote/${encodeURIComponent(e.id)}`, { url: editUrl!.url.trim() }), t("Indirizzo aggiornato: il dispatcher controlla di nuovo il modello.")).then((r) => r !== undefined && (editUrl = null)))}>
                      <label class="field grow"><span class="label">{t("Indirizzo di {id}", { id: e.id })}</span><input class="input mono" type="url" required bind:value={editUrl.url} /></label>
                      <Button size="sm" variant="primary" type="submit" busy={busy === "url"}>{t("Salva")}</Button>
                      <Button size="sm" variant="quiet" type="button" onclick={() => (editUrl = null)}>{t("Annulla")}</Button>
                    </form>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
      <p class="queues">
        {t("Code in attesa:")}
        {#each Object.entries(snap.queues) as [k, q] (k)}
          <span><strong>{KIND[k as keyof typeof KIND] ?? k}</strong> {t("{x} interattive · {x2} caricamenti · {x3} notturne", { x: q["0"] ?? 0, x2: q["1"] ?? 0, x3: q["2"] ?? 0 })}</span>
        {/each}
      </p>
    </section>

    <div class="adm-grid">
      <section class="adm-card">
        <h2>{t("Processi locali")}</h2>
        {#if !snap.local.length}
          <p class="dim">{t("Nessun processo locale: imposta LOCAL_MODELS_ENABLED=true e i file dei modelli nella cartella LOCAL_MODELS_DIR.")}</p>
        {/if}
        {#each snap.local as p (p.name)}
          {@const st = PROC[p.status]}
          <div class="proc">
            <div class="ph">
              <div>
                <strong>{KIND[p.kind]}</strong> <span class="badge {st.t}">{st.l}</span>
                <div class="dim mono">{t("{model} · porta {port} · {threads} thread{x}{x2}{x3}", { model: p.model, port: p.port, threads: p.threads, x: p.pid ? ` · pid ${p.pid}` : "", x2: p.startedAt ? ` · avviato ${ago(p.startedAt)}` : "", x3: p.restarts ? ` · ${p.restarts} riavvii` : "" })}</div>
                {#if p.lastError}<div class="err">{p.lastError}</div>{/if}
              </div>
              <div class="adm-bar">
                {#if p.status === "stopped" || p.status === "disabled"}
                  <Button size="sm" busy={busy === `${p.kind}-start`} onclick={() => run(`${p.kind}-start`, () => api.post(`/api/admin/models/local/${p.kind}/start`))}>{t("Avvia")}</Button>
                {:else}
                  <Button size="sm" busy={busy === `${p.kind}-restart`} onclick={() => run(`${p.kind}-restart`, () => api.post(`/api/admin/models/local/${p.kind}/restart`))}>{t("Riavvia")}</Button>
                  <Button size="sm" variant="quiet" busy={busy === `${p.kind}-stop`} onclick={() => run(`${p.kind}-stop`, () => api.post(`/api/admin/models/local/${p.kind}/stop`))}>{t("Ferma")}</Button>
                {/if}
                <Button size="sm" variant="quiet" aria-expanded={logOpen === p.name} onclick={() => (logOpen = logOpen === p.name ? null : p.name)}>{t("Log")}</Button>
              </div>
            </div>
            {#if logOpen === p.name}<pre class="log mono">{p.logTail.join("\n") || t("Nessuna riga.")}</pre>{/if}
          </div>
        {/each}
        <form class="adm-form" onsubmit={(e) => (e.preventDefault(), run("local", () => api.put("/api/admin/models/local", local), t("Impostazioni applicate: i processi ripartono.")))}>
          <label class="field"><span class="label">{t("Thread per processo")}</span><input class="input" type="number" min="1" max="256" bind:value={local.threads} /></label>
          <label class="field"><span class="label">{t("Quando")}</span><select class="input" bind:value={local.schedule}>{#each Object.entries(SCHEDULE) as [k, l] (k)}<option value={k}>{l}</option>{/each}</select></label>
          <label class="field"><span class="label">{t("Fascia (HH:MM-HH:MM)")}</span><input class="input" bind:value={local.offHours} pattern={HHMM_RANGE} disabled={local.schedule !== "off-hours"} /></label>
          <div><Button size="sm" variant="primary" type="submit" busy={busy === "local"}>{t("Applica")}</Button></div>
        </form>
      </section>

      <section class="adm-card">
        <h2>{t("Aggiungi un endpoint remoto")}</h2>
        <p class="dim">{t("Un server llama.cpp o compatibile OpenAI nella rete aziendale. Per embedding e rerank deve usare lo stesso modello dei vettori già salvati: il dispatcher lo verifica e altrimenti non lo usa. Per l'OCR serve un modello che legge le immagini (llama-server con --mmproj, oppure Unlimited-OCR).")}</p>
        <form class="adm-form" onsubmit={(e) => (e.preventDefault(), run("add", () => api.post("/api/admin/models/remote", { kind: nr.kind, url: nr.url.trim() }), t("Endpoint aggiunto.")).then((r) => r && (nr.url = "")))}>
          <label class="field"><span class="label">{t("Tipo")}</span><select class="input" bind:value={nr.kind}>{#each Object.entries(KIND) as [k, l] (k)}<option value={k}>{l}</option>{/each}</select></label>
          <label class="field"><span class="label">{t("Indirizzo")}</span><input class="input mono" required type="url" bind:value={nr.url} placeholder={t("http://192.168.1.20:8080")} /></label>
          <div><Button size="sm" variant="primary" type="submit" busy={busy === "add"}>{t("Aggiungi")}</Button></div>
        </form>
        <p class="dim small">{t("Anche gli endpoint del file .env si modificano qui: il nuovo indirizzo resta dopo un riavvio. Per tornare a quello del .env, scrivilo di nuovo.")}</p>
      </section>
    </div>
  {/if}
</div>

<style>
  .url {
    font-size: var(--fs-xs);
  }
  .ok {
    font-size: var(--fs-xs);
    color: var(--idle-ink);
  }
  .err {
    font-size: var(--fs-xs);
    color: var(--alert-ink);
  }
  .queues {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 1.2rem;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .proc {
    display: grid;
    gap: 0.5rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--line);
  }
  .ph {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .ph .dim {
    font-size: var(--fs-xs);
    margin-top: 0.2rem;
  }
  .log {
    font-size: var(--fs-xs);
    background: var(--well);
    padding: 0.6rem;
    border-radius: var(--r-control);
    max-height: 18rem;
    overflow: auto;
    white-space: pre-wrap;
  }
  .small {
    font-size: var(--fs-xs);
  }
  .edit-row td {
    background: var(--ink-1);
  }
  .edit-row .adm-bar {
    align-items: end;
  }
  .grow {
    flex: 1;
    min-width: 16rem;
  }
</style>
