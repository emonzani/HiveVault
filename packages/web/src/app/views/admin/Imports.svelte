<script lang="ts">
  // Bulk imports from server folders (plan §6): new job, progress, pause, resume, cancel, a
  // new scan that reads only new or changed files. The list refreshes while a job runs.
  import Explain from "../../../components/Explain.svelte";
  import { EXPLAIN_ADMIN } from "../../../lib/explain.ts";
  import Button from "../../../components/Button.svelte";
  import { api, request } from "../../../lib/api.ts";
  import { HHMM_RANGE, type AdminVault } from "../../../lib/admin.ts";
  import { ago, bytes, CLASSIFICATIONS, dec1, nf, valueLabel } from "../../../lib/format.ts";
  import { ui } from "../../../lib/ui.svelte.ts";
  import { t } from "../../../lib/i18n.ts";

  interface Job {
    id: string;
    vaultId: string;
    root: string;
    include: string[];
    exclude: string[];
    status: "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
    stats: { scanned?: number; pending?: number; stored?: number; duplicates?: number; skipped?: number; errors?: number; bytes?: number; filesPerSec?: number; etaSeconds?: number | null };
    error: string | null;
    filesPerSec: number | null;
    windowHours: string | null;
    compile: boolean;
    classification: number;
    maxFileBytes: number;
    createdAt: string;
    finishedAt: string | null;
  }
  const STATUS: Record<Job["status"], { label: string; tone: string }> = {
    queued: { label: t("In coda"), tone: "" },
    running: { label: t("In corso"), tone: "busy" },
    paused: { label: t("In pausa"), tone: "you" },
    done: { label: t("Completato"), tone: "idle" },
    failed: { label: t("Errore"), tone: "alert" },
    cancelled: { label: t("Annullato"), tone: "" },
  };

  let jobs = $state<Job[] | null>(null);
  let vaults = $state<AdminVault[]>([]);
  let error = $state("");
  let creating = $state(false);
  let busy = $state("");
  let nj = $state({ vaultId: "", root: "", include: "", exclude: "", classification: "", maxFileMb: 200, filesPerSec: "", windowHours: "", compile: false });

  async function load() {
    try {
      jobs = await api.get<Job[]>("/api/admin/imports");
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    void load();
    api.get<AdminVault[]>("/api/admin/vaults").then((v) => (vaults = v), () => {});
  });
  // poll while something runs (the event stream carries sources, not import jobs)
  $effect(() => {
    if (!jobs?.some((j) => j.status === "running" || j.status === "queued")) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  });

  const list = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  async function create() {
    busy = "create";
    try {
      await api.post("/api/admin/imports", {
        vaultId: nj.vaultId,
        root: nj.root.trim(),
        ...(list(nj.include).length ? { include: list(nj.include) } : {}),
        ...(list(nj.exclude).length ? { exclude: list(nj.exclude) } : {}),
        ...(nj.classification !== "" ? { classification: Number(nj.classification) } : {}),
        maxFileMb: nj.maxFileMb,
        filesPerSec: nj.filesPerSec ? Number(nj.filesPerSec) : null,
        windowHours: nj.windowHours.trim() || null,
        compile: nj.compile,
      });
      ui.toast(t("Import avviato."), "ok");
      creating = false;
      await load();
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = "";
    }
  }
  async function act(j: Job, action: "pause" | "resume" | "cancel" | "rescan") {
    if (action === "cancel" && !confirm(t("Annullare l'import? I file già letti restano nel vault."))) return;
    busy = j.id + action;
    try {
      await api.post(`/api/admin/imports/${j.id}/${action}`);
      await load();
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = "";
    }
  }
  // --- edit of a job: everything except the folder and the vault ----------------------------
  let ej = $state<{ id: string; include: string; exclude: string; classification: number; maxFileMb: number; filesPerSec: string; windowHours: string; compile: boolean } | null>(null);
  const startEdit = (j: Job) =>
    (ej = ej?.id === j.id ? null : {
      id: j.id,
      include: j.include.join(", "),
      exclude: j.exclude.join(", "),
      classification: j.classification,
      maxFileMb: Math.round(j.maxFileBytes / 1024 ** 2),
      filesPerSec: j.filesPerSec === null ? "" : String(j.filesPerSec),
      windowHours: j.windowHours ?? "",
      compile: j.compile,
    });
  async function saveEdit() {
    const e = ej!;
    busy = e.id + "save";
    try {
      await request("PATCH", `/api/admin/imports/${e.id}`, {
        include: list(e.include),
        exclude: list(e.exclude),
        classification: e.classification,
        maxFileMb: e.maxFileMb,
        filesPerSec: e.filesPerSec === "" ? null : Number(e.filesPerSec),
        windowHours: e.windowHours.trim() || null,
        compile: e.compile,
      });
      ui.toast(t("Import aggiornato. Velocità, fascia e classificazione valgono subito; i filtri dalla prossima scansione."), "ok");
      ej = null;
      await load();
    } catch (err) {
      ui.toast((err as Error).message, "error");
    } finally {
      busy = "";
    }
  }
  const vaultName = (id: string) => vaults.find((v) => v.id === id)?.name ?? id;
  const eta = (s: number | null | undefined) => (!s ? "" : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${dec1(s / 3600)} h`);
</script>

<div class="adm">
  <header class="adm-head">
    <div>
      <p class="eyebrow you">{t("Console")}</p>
      <h1>{t("Import massivi")}</h1>
      <p>{t("Legge una cartella del server (per esempio un archivio di rete montato) e carica i documenti in un vault. I duplicati non si caricano due volte; una nuova scansione legge solo i file nuovi o cambiati.")}</p>
    </div>
    <Button variant="primary" onclick={() => (creating = !creating)}>{t("Nuovo import")}</Button>
  </header>
  <Explain id="admin-import" text={EXPLAIN_ADMIN["import"]!} />

  {#if creating}
    <form class="adm-card" onsubmit={(e) => (e.preventDefault(), create())}>
      <h2>{t("Nuovo import")}</h2>
      <div class="adm-form">
        <label class="field"><span class="label">{t("Vault")}</span>
          <select class="input" required bind:value={nj.vaultId}><option value="" disabled>{t("Scegli…")}</option>{#each vaults as v (v.id)}<option value={v.id}>{v.name}</option>{/each}</select>
        </label>
        <label class="field wide"><span class="label">{t("Cartella sul server")}</span><input class="input mono" required bind:value={nj.root} placeholder="/mnt/archivio/commerciale" /></label>
        <label class="field"><span class="label">{t("Includi (glob)")}</span><input class="input mono" bind:value={nj.include} placeholder="**/*.pdf, **/*.docx" /></label>
        <label class="field"><span class="label">{t("Escludi (glob)")}</span><input class="input mono" bind:value={nj.exclude} placeholder="**/old/**" /></label>
        <label class="field"><span class="label">{t("Classificazione")}</span>
          <select class="input" bind:value={nj.classification}><option value="">{t("del vault")}</option>{#each CLASSIFICATIONS as c, i (c)}<option value={String(i)}>{valueLabel(c)}</option>{/each}</select>
        </label>
        <label class="field"><span class="label">{t("File massimo (MB)")}</span><input class="input" type="number" min="1" max="10000" bind:value={nj.maxFileMb} /></label>
        <label class="field"><span class="label">{t("File al secondo")}</span><input class="input" type="number" min="0.1" step="0.1" bind:value={nj.filesPerSec} placeholder={t("senza limite")} /></label>
        <label class="field"><span class="label">{t("Solo nella fascia")}</span><input class="input" bind:value={nj.windowHours} placeholder="20:00-07:00" pattern={HHMM_RANGE} /></label>
      </div>
      <label class="check"><input type="checkbox" bind:checked={nj.compile} /> {t("Compila subito una pagina per ogni documento (altrimenti lo fa il ciclo notturno)")}</label>
      <div class="adm-bar">
        <Button variant="primary" type="submit" busy={busy === "create"}>{t("Avvia")}</Button>
        <Button variant="quiet" type="button" onclick={() => (creating = false)}>{t("Annulla")}</Button>
      </div>
    </form>
  {/if}

  {#if error}
    <p class="notice error">{error}</p>
  {:else if !jobs}
    <span class="skeleton" style="height:10rem"></span>
  {:else if !jobs.length}
    <div class="empty"><h2>{t("Nessun import")}</h2><p>{t("Le cartelle ammesse sono quelle della variabile IMPORT_ROOTS del server.")}</p></div>
  {:else}
    <ul class="jobs">
      {#each jobs as j (j.id)}
        {@const st = STATUS[j.status]}
        {@const s = j.stats}
        {@const done = (s.stored ?? 0) + (s.duplicates ?? 0) + (s.skipped ?? 0) + (s.errors ?? 0)}
        {@const pct = s.scanned ? Math.min(100, (done / s.scanned) * 100) : 0}
        <li class="adm-card">
          <div class="top">
            <div>
              <strong class="mono">{j.root}</strong>
              <div class="dim">{t("→ {vaultId} · creato {createdAt}{x}{x2}", { vaultId: vaultName(j.vaultId), createdAt: ago(j.createdAt), x: j.windowHours ? ` · solo ${j.windowHours}` : "", x2: j.filesPerSec ? ` · max ${j.filesPerSec} file/s` : "" })}</div>
            </div>
            <span class="badge {st.tone}">{st.label}</span>
          </div>
          <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(pct)} aria-label={t("Avanzamento")}><span style="width:{pct}%"></span></div>
          <p class="nums">
            {t("{format} trovati · {format2} caricati · {format3} duplicati · {format4} saltati", { format: nf.format(s.scanned ?? 0), format2: nf.format(s.stored ?? 0), format3: nf.format(s.duplicates ?? 0), format4: nf.format(s.skipped ?? 0) })}
            {#if s.errors}· <span class="err">{t("{errors} errori", { errors: nf.format(s.errors) })}</span>{/if}
            {#if s.bytes}· {bytes(s.bytes)}{/if}
            {#if j.status === "running" && s.filesPerSec}{t("· {rate} file/s", { rate: dec1(s.filesPerSec) })}{#if s.etaSeconds} {t("· ancora {etaSeconds}", { etaSeconds: eta(s.etaSeconds) })}{/if}{/if}
          </p>
          {#if j.error}<p class="err">{j.error}</p>{/if}
          <div class="adm-bar">
            {#if j.status === "running" || j.status === "queued"}
              <Button size="sm" busy={busy === j.id + "pause"} onclick={() => act(j, "pause")}>{t("Pausa")}</Button>
            {/if}
            {#if j.status === "paused"}
              <Button size="sm" variant="primary" busy={busy === j.id + "resume"} onclick={() => act(j, "resume")}>{t("Riprendi")}</Button>
            {/if}
            {#if ["running", "queued", "paused"].includes(j.status)}
              <Button size="sm" variant="quiet" busy={busy === j.id + "cancel"} onclick={() => act(j, "cancel")}>{t("Annulla")}</Button>
            {:else}
              <Button size="sm" busy={busy === j.id + "rescan"} onclick={() => act(j, "rescan")}>{t("Nuova scansione")}</Button>
            {/if}
            <Button size="sm" variant="quiet" aria-expanded={ej?.id === j.id} onclick={() => startEdit(j)}>{t("Modifica")}</Button>
          </div>
          {#if ej?.id === j.id}
            <form class="edit" onsubmit={(e) => (e.preventDefault(), saveEdit())}>
              <div class="adm-form">
                <label class="field"><span class="label">{t("Includi (glob)")}</span><input class="input mono" bind:value={ej.include} placeholder={t("tutti i file")} /></label>
                <label class="field"><span class="label">{t("Escludi (glob)")}</span><input class="input mono" bind:value={ej.exclude} placeholder={t("nessuno")} /></label>
                <label class="field"><span class="label">{t("Classificazione")}</span>
                  <select class="input" bind:value={ej.classification}>{#each CLASSIFICATIONS as c, i (c)}<option value={i}>{valueLabel(c)}</option>{/each}</select>
                </label>
                <label class="field"><span class="label">{t("File massimo (MB)")}</span><input class="input" type="number" min="1" max="10000" required bind:value={ej.maxFileMb} /></label>
                <label class="field"><span class="label">{t("File al secondo")}</span><input class="input" type="number" min="0.1" step="0.1" bind:value={ej.filesPerSec} placeholder={t("senza limite")} /></label>
                <label class="field"><span class="label">{t("Solo nella fascia")}</span><input class="input" bind:value={ej.windowHours} placeholder={t("sempre")} pattern={HHMM_RANGE} /></label>
              </div>
              <label class="check"><input type="checkbox" bind:checked={ej.compile} /> {t("Compila subito una pagina per ogni documento")}</label>
              <p class="dim small">{t("La classificazione vale per i file caricati da ora in poi. Per i documenti già caricati, cambiala nella sezione Sorgenti.")}</p>
              <div class="adm-bar">
                <Button size="sm" variant="primary" type="submit" busy={busy === j.id + "save"}>{t("Salva")}</Button>
                <Button size="sm" variant="quiet" type="button" onclick={() => (ej = null)}>{t("Annulla")}</Button>
              </div>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .wide {
    grid-column: span 2;
  }
  .check {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: var(--fs-sm);
  }
  .jobs {
    list-style: none;
    display: grid;
    gap: 0.75rem;
  }
  .top {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: start;
  }
  .top .dim {
    font-size: var(--fs-xs);
    margin-top: 0.15rem;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--ink-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--idle);
    transition: width 0.4s ease;
  }
  .nums {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .err {
    color: var(--alert-ink);
    font-size: var(--fs-sm);
  }
  .edit {
    display: grid;
    gap: 0.6rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--line);
  }
  .small {
    font-size: var(--fs-xs);
  }
  @media (max-width: 700px) {
    .wide {
      grid-column: auto;
    }
  }
</style>
