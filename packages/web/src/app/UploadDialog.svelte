<script lang="ts">
  // Upload (plan §3.6 and §9.2): files or a link, the classification shown with the cloud agent
  // notice before anything is stored, progress of the transfer, then the live status of each
  // document from the server-sent events.
  import { tick } from "svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import { api, upload } from "../lib/api.ts";
  import { sourceEvents } from "../lib/events.svelte.ts";
  import { waitLabel, type CompileQueue } from "../lib/working.svelte.ts";
  import { ALL_CLASSIFICATIONS, bytes, classificationsFor, PERSONAL, SOURCE_STATUS, valueLabel } from "../lib/format.ts";
  import { session } from "../lib/session.svelte.ts";
  import { ui } from "../lib/ui.svelte.ts";
  import { ws } from "../lib/workspace.svelte.ts";
  import { t, tHtml } from "../lib/i18n.ts";
  import { tablist } from "../lib/tablist.ts";

  interface Sent {
    id: string;
    name: string;
    size: number;
    created: boolean;
    status: string;
  }

  let dialog: HTMLDialogElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let files = $state<File[]>([]);
  let vaultId = $state("");
  let classification = $state<string>("default");
  let compile = $state(true);
  let url = $state("");
  let mode = $state<"files" | "link">("files");
  let progress = $state<{ loaded: number; total: number } | null>(null);
  let sent = $state<Sent[] | null>(null);
  let error = $state("");
  let abort: (() => void) | null = null;
  /** The estimated wait of the compilation, after an upload with compile (M14). */
  let wait = $state("");

  $effect(() => {
    const u = ui.upload;
    if (u && dialog && !dialog.open) {
      files = u.files ?? [];
      const writable = session.writable;
      vaultId = writable.some((v) => v.id === session.vault?.id) ? session.vault!.id : (writable[0]?.id ?? "");
      classification = "default";
      compile = true;
      url = "";
      mode = "files";
      progress = null;
      sent = null;
      error = "";
      wait = "";
      dialog.showModal();
      if (!files.length) void tick().then(() => fileInput?.focus());
    } else if (!u && dialog?.open) dialog.close();
  });

  const vault = $derived(session.writable.find((v) => v.id === vaultId));
  const personal = $derived(vault?.personal ?? false);
  /** The level the documents get: the chosen one, or the default of the vault. */
  const level = $derived(classification === "default" ? (vault?.defaultClassification ?? 1) : Number(classification));
  const agentMay = $derived(level <= 1);
  $effect(() => {
    if (!personal && classification === String(PERSONAL)) classification = "default";
  });
  const total = $derived(files.reduce((s, f) => s + f.size, 0));
  const busy = $derived(!!progress && !sent);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const known = new Set(files.map((f) => `${f.name}:${f.size}`));
    files = [...files, ...[...list].filter((f) => !known.has(`${f.name}:${f.size}`))];
  }

  /** Watches the new documents (a message at I3) and reads the estimated wait. */
  async function afterSend(list: Sent[]) {
    if (!compile) return;
    const fresh = list.filter((s) => s.created);
    for (const s of fresh) sourceEvents.watch(s.id, s.name);
    if (!fresh.length) return;
    try {
      wait = waitLabel(await api.get<CompileQueue>("/api/sources/queue"));
    } catch {
      wait = "";
    }
  }

  async function send() {
    error = "";
    if (!vaultId) return;
    if (mode === "link") {
      try {
        progress = { loaded: 0, total: 0 };
        const r = await api.post<{ id: string; created: boolean; status: string; url: string }>(`/api/vaults/${encodeURIComponent(vaultId)}/links`, {
          url: url.trim(),
          compile,
          ...(classification !== "default" ? { classification: Number(classification) } : {}),
        });
        sent = [{ id: r.id, name: r.url, size: 0, created: r.created, status: r.status }];
        void afterSend(sent);
      } catch (e) {
        error = (e as Error).message;
        progress = null;
      }
      return;
    }
    const form = new FormData();
    // fields first: the server reads them before the files of the same request
    form.append("compile", String(compile));
    if (classification !== "default") form.append("classification", classification);
    for (const f of files) form.append("file", f, f.name);
    progress = { loaded: 0, total };
    const u = upload<{ sources: Sent[] }>(`/api/vaults/${encodeURIComponent(vaultId)}/sources`, form, (loaded, t) => (progress = { loaded, total: t || total }));
    abort = u.abort;
    try {
      sent = (await u.promise).sources;
      void afterSend(sent);
    } catch (e) {
      error = (e as Error).message;
      progress = null;
    } finally {
      abort = null;
    }
  }

  function close() {
    if (busy && abort && !confirm(t("Il caricamento è in corso. Annullarlo?"))) return;
    abort?.();
    ui.upload = null;
  }

  const statusOf = (s: Sent) => sourceEvents.status[s.id]?.status ?? s.status;
</script>

<dialog class="modal" bind:this={dialog} onclose={() => (ui.upload = null)} oncancel={(e) => (e.preventDefault(), close())} aria-labelledby="up-title">
  {#if ui.upload}
    <div class="modal-head">
      <h2 id="up-title">{t("Carica nella memoria")}</h2>
      <button class="icon-btn" aria-label={t("Chiudi")} onclick={close}>×</button>
    </div>
    <div class="modal-body">
      {#if sent}
        <ul class="sent">
          {#each sent as s (s.id)}
            {@const st = SOURCE_STATUS[statusOf(s)] ?? { label: statusOf(s), tone: "dim" }}
            <li>
              <span class="dot {['stored', 'parsed'].includes(statusOf(s)) ? 'busy' : st.tone}"></span>
              <span class="n">{s.name}</span>
              <span class="dim">{s.created ? st.label : t("Già presente: non duplicato")}</span>
            </li>
          {/each}
        </ul>
        {#if wait}<p class="small" role="status">{wait}</p>{/if}
        <p class="dim small">{t("L'elaborazione continua sul server anche se chiudi questa finestra. Lo stato è nell'inbox.")}</p>
      {:else}
        <div class="seg" role="tablist" use:tablist aria-label={t("Cosa caricare")}>
          <button role="tab" aria-selected={mode === "files"} onclick={() => (mode = "files")}>{t("File")}</button>
          <button role="tab" aria-selected={mode === "link"} onclick={() => (mode = "link")}>{t("Link a una pagina web")}</button>
        </div>

        {#if mode === "files"}
          <button class="dropzone" onclick={() => fileInput?.click()} ondragover={(e) => e.preventDefault()} ondrop={(e) => (e.preventDefault(), e.stopPropagation(), addFiles(e.dataTransfer?.files ?? null))}>
            <strong>{t("Scegli i file o trascinali qui")}</strong>
            <span>{t("PDF, Word, Excel, PowerPoint, email (EML, MSG, MBOX), CSV, HTML, ZIP, testo, codice, immagini")}</span>
          </button>
          <input bind:this={fileInput} type="file" multiple hidden onchange={(e) => addFiles((e.currentTarget as HTMLInputElement).files)} />
          {#if files.length}
            <ul class="files">
              {#each files as f, i (f.name + f.size)}
                <li><span class="n">{f.name}</span><span class="dim tabular">{bytes(f.size)}</span><button class="icon-btn" aria-label={t("Togli {name}", { name: f.name })} onclick={() => (files = files.filter((_, j) => j !== i))}>×</button></li>
              {/each}
            </ul>
            <p class="dim small">{t("{n} file · {total}", { n: files.length, total: bytes(total) })}</p>
          {/if}
        {:else}
          <label class="field">
            <span class="label">{t("Indirizzo della pagina")}</span>
            <input class="input" type="url" bind:value={url} placeholder={t("https://…")} />
            <span class="msg">{t("Il server scarica la pagina una volta. Gli indirizzi della rete interna non sono consentiti.")}</span>
          </label>
        {/if}

        <div class="grid2">
          <label class="field">
            <span class="label">{t("Vault")}</span>
            <select class="input" bind:value={vaultId}>
              {#each session.writable as v (v.id)}<option value={v.id}>{v.name}</option>{/each}
            </select>
          </label>
          <label class="field">
            <span class="label">{t("Classificazione")}</span>
            <select class="input" bind:value={classification}>
              <option value="default">{t("Predefinita del vault")}</option>
              {#each classificationsFor(personal) as c, i (c)}<option value={String(i)}>{valueLabel(c)}</option>{/each}
            </select>
          </label>
        </div>

        {#if agentMay}
          <p class="notice agent">
            <span class="notice-icon" aria-hidden="true"><Icon name="agent" size={16} /></span>
            <span>{@html tHtml("Con la classificazione **{level}**, il **testo compilato** di questi documenti può essere letto dall'agente cloud (un servizio esterno) tramite gli account API autorizzati. I file originali restano sul server. Scegli **riservato** o **segreto** per escluderli.", { level: valueLabel(ALL_CLASSIFICATIONS[level]) })}</span>
          </p>
        {:else if level === PERSONAL}
          <p class="notice"><span aria-hidden="true">🔒</span><span>{personal ? t("Solo tu potrai leggere questi documenti: nemmeno gli amministratori. Se il tuo account viene cancellato, i documenti vengono cancellati.") : t("Solo il proprietario di questo vault personale potrà leggere i documenti: né tu né gli amministratori.")}</span></p>
        {:else}
          <p class="notice"><span aria-hidden="true">🔒</span><span>{t("L'agente cloud non leggerà questi documenti: restano solo in azienda.")}</span></p>
        {/if}

        <label class="check"><input type="checkbox" bind:checked={compile} /> {t("Compila subito nel wiki con il modello locale (altrimenti: solo ricerca, compilazione quando serve)")}</label>

        {#if progress && !sent}
          <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0} aria-label={t("Caricamento")}>
            <span style:width="{progress.total ? (progress.loaded / progress.total) * 100 : 30}%"></span>
          </div>
        {/if}
        {#if error}<p class="notice error" role="alert">{error}</p>{/if}
      {/if}
    </div>
    <div class="modal-foot">
      {#if sent}
        <Button onclick={() => ((ui.upload = null), ws.open({ kind: "inbox", tab: "inbox" }))}>{t("Apri l'inbox")}</Button>
        <Button variant="primary" onclick={() => (ui.upload = null)}>{t("Fatto")}</Button>
      {:else}
        <Button variant="quiet" onclick={close}>{t("Annulla")}</Button>
        <Button variant="primary" {busy} disabled={!vaultId || (mode === "files" ? !files.length : !/^https?:\/\/./i.test(url.trim()))} onclick={send}>
          {mode === "files" ? t("Carica {n} file", { n: files.length || "" }) : t("Scarica e indicizza")}
        </Button>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  .seg {
    display: flex;
    gap: 0.25rem;
    padding: 0.2rem;
    border-radius: var(--r-control);
    background: var(--ink-0);
    width: fit-content;
  }
  .seg button {
    padding: 0.3rem 0.75rem;
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
  .dropzone {
    display: grid;
    gap: 0.3rem;
    padding: 1.25rem;
    border: 2px dashed var(--line-strong);
    border-radius: var(--r-panel);
    background: var(--ink-0);
    cursor: pointer;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--fs-xs);
  }
  .dropzone strong {
    font-size: var(--fs-md);
    color: var(--text-main);
  }
  .dropzone:hover {
    border-color: var(--you-line);
  }
  .files,
  .sent {
    list-style: none;
    display: grid;
    max-height: 12rem;
    overflow-y: auto;
  }
  .files li,
  .sent li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--line);
    font-size: var(--fs-sm);
  }
  .n {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  .check {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .check input {
    margin-top: 0.25rem;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--ink-3);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--busy);
    transition: width 0.2s;
  }
  .small {
    font-size: var(--fs-xs);
  }
</style>
