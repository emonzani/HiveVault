<script lang="ts">
  // Cells and hive spaces: creation, settings, the cells that feed a space, a dream cycle now,
  // export and restore (zip of Markdown pages), deletion with the slug as confirmation.
  import Explain from "../../../components/Explain.svelte";
  import { EXPLAIN_ADMIN } from "../../../lib/explain.ts";
  import Button from "../../../components/Button.svelte";
  import OwnerField from "./OwnerField.svelte";
  import { api, ApiError, request } from "../../../lib/api.ts";
  import { downloadPost, type AdminVault, type Checkpoint } from "../../../lib/admin.ts";
  import { ALL_CLASSIFICATIONS, classificationsFor, nf, valueLabel, when } from "../../../lib/format.ts";
  import { ui } from "../../../lib/ui.svelte.ts";
  import { ws } from "../../../lib/workspace.svelte.ts";
  import { t } from "../../../lib/i18n.ts";

  let { selected }: { selected?: string } = $props();

  const INDEX_LABEL = { binary: "binario + rerank (consigliato)", full: t("completo (più memoria)"), none: t("nessuno (solo testo)") } as const;
  const FEED_TYPES = ["entity", "concept", "decision", "process", "project", "meeting", "note"];

  let vaults = $state<AdminVault[] | null>(null);
  let error = $state("");
  let creating = $state(false);
  let busy = $state("");
  let nv = $state({ kind: "cell" as "cell" | "space", slug: "", name: "", owner: "", vectorIndex: "binary" as AdminVault["vectorIndex"], classification: "" });

  async function load() {
    try {
      vaults = await api.get<AdminVault[]>("/api/admin/vaults");
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => void load());

  const current = $derived(vaults?.find((v) => v.id === selected) ?? null);
  const cells = $derived(vaults?.filter((v) => v.kind === "cell") ?? []);
  const select = (id?: string) => ws.open({ kind: "admin", section: "vault", ...(id ? { id } : {}) });

  async function act<T>(label: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
    busy = label;
    try {
      const r = await fn();
      if (ok) ui.toast(ok, "ok");
      return r;
    } catch (e) {
      ui.toast((e as Error).message, "error");
      return undefined;
    } finally {
      busy = "";
    }
  }

  let newOwnerOk = $state(true);
  let editOwnerOk = $state(true);

  async function create() {
    if (!newOwnerOk) return ui.toast(t("Completa il proprietario o scegli «Nessuno»."), "error");
    const r = await act("create", () =>
      api.post<AdminVault>("/api/admin/vaults", {
        kind: nv.kind,
        slug: nv.slug.trim(),
        name: nv.name.trim(),
        vectorIndex: nv.vectorIndex,
        ...(nv.owner.trim() ? { owner: nv.owner.trim() } : {}),
        ...(nv.classification !== "" ? { defaultClassification: Number(nv.classification) } : {}),
      }),
      t("Vault creato."),
    );
    if (!r) return;
    creating = false;
    nv = { kind: "cell", slug: "", name: "", owner: "", vectorIndex: "binary", classification: "" };
    await load();
    select(r.id);
  }

  // --- edit -----------------------------------------------------------------------------
  let edit = $state<{ name: string; owner: string; schemaMd: string | null; defaultClassification: number; vectorIndex: AdminVault["vectorIndex"] } | null>(null);
  let schemaLoaded = "";
  // the edit card is below the table: it comes into view and takes the focus
  let editor = $state<HTMLElement>();
  let shownFor = "";
  $effect(() => {
    const id = current?.id;
    if (!editor || !id || shownFor === id) return;
    shownFor = id;
    editor.scrollIntoView({ block: "start", behavior: "smooth" });
    editor.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  });
  let feeds = $state<{ cellId: string; types: string[] }[]>([]);
  $effect(() => {
    const v = current;
    edit = v ? { name: v.name, owner: v.owner ?? "", schemaMd: null, defaultClassification: v.defaultClassification, vectorIndex: v.vectorIndex } : null;
    // SCHEMA.md is not in the list (up to 100 KB per vault): read it with the vault
    if (v) api.get<{ schemaMd: string }>(`/api/admin/vaults/${v.id}`).then((d) => { if (edit && current?.id === v.id) { edit.schemaMd = d.schemaMd; schemaLoaded = d.schemaMd; } }, () => {});
    feeds = [];
    if (v?.kind === "space") api.get<{ cellId: string; types: string[] }[]>(`/api/admin/vaults/${v.id}/feeds`).then((f) => (feeds = f), () => {});
  });

  async function save() {
    const v = current!;
    const body: Record<string, unknown> = {};
    if (edit!.name !== v.name) body.name = edit!.name;
    if (!editOwnerOk) return ui.toast(t("Completa il proprietario o scegli «Nessuno»."), "error");
    if (edit!.owner.trim() !== (v.owner ?? "")) {
      if (!confirm(t("Cambiare il proprietario cambia chi vede la cella come propria. Continuare?"))) return;
      body.owner = edit!.owner.trim() || null;
    }
    if (edit!.schemaMd !== null && edit!.schemaMd !== schemaLoaded) body.schemaMd = edit!.schemaMd;
    if (edit!.defaultClassification !== v.defaultClassification) body.defaultClassification = edit!.defaultClassification;
    if (edit!.vectorIndex !== v.vectorIndex) {
      if (!confirm(t("Cambiare l'indice vettoriale ricostruisce l'indice della partizione: può richiedere minuti su vault grandi. Continuare?"))) return;
      body.vectorIndex = edit!.vectorIndex;
    }
    if (!Object.keys(body).length) return ui.toast(t("Nessuna modifica."), "info");
    if (await act("save", () => request("PATCH", `/api/admin/vaults/${v.id}`, body), t("Vault aggiornato."))) {
      if (body.schemaMd !== undefined) schemaLoaded = body.schemaMd as string;
      await load();
    }
  }

  const feedOf = (id: string) => feeds.find((f) => f.cellId === id);
  function toggleFeed(id: string) {
    feeds = feedOf(id) ? feeds.filter((f) => f.cellId !== id) : [...feeds, { cellId: id, types: [] }];
  }
  function toggleType(id: string, t: string) {
    feeds = feeds.map((f) => (f.cellId !== id ? f : { ...f, types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t] }));
  }
  async function saveFeeds() {
    const r = await act("feeds", () => api.put<{ cellId: string; types: string[] }[]>(`/api/admin/vaults/${current!.id}/feeds`, { feeds: feeds.map((f) => ({ cellId: f.cellId, ...(f.types.length ? { types: f.types } : {}) })) }), t("Celle collegate. La promozione avviene nel prossimo ciclo notturno."));
    if (r) feeds = r;
  }

  async function dreamNow() {
    const r = await act("dream", () => api.post<{ taskId: string }>(`/api/admin/vaults/${current!.id}/dream`), t("Ciclo notturno avviato per questo vault."));
    if (r) ws.open({ kind: "admin", section: "task", id: r.taskId }, "tab");
  }

  async function exportZip() {
    const v = current!;
    const name = await act("export", () => downloadPost(`/api/admin/vaults/${v.id}/export`, `${v.slug}.zip`));
    if (name) ui.toast(t("Esportazione pronta: {name}. Una copia resta nella cartella dati del server.", { name }), "ok");
  }

  let fileInput = $state<HTMLInputElement>();
  async function importZip(file: File) {
    const v = current!;
    if (!confirm(t("Importare «{name}» in «{name2}»? Le pagine con lo stesso percorso vengono aggiornate con una nuova versione. Prima viene salvato un punto di ripristino.", { name: file.name, name2: v.name }))) return;
    const send = (confirmed: boolean) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.post<{ files: number; created?: number; updated?: number }>(`/api/admin/vaults/${v.id}/import${confirmed ? "?confirm=true" : ""}`, fd);
    };
    busy = "import";
    try {
      let r;
      try {
        r = await send(false);
      } catch (e) {
        // many pages rewritten at once: the server asks for a second confirmation
        if (!(e instanceof ApiError && e.status === 409) || !confirm(e.message)) throw e;
        r = await send(true);
      }
      ui.toast(t("Importati {files} file{x}.", { files: r.files, x: r.created !== undefined ? t(" · {created} nuove pagine · {x} aggiornate", { created: r.created, x: r.updated ?? 0 }) : "" }), "ok");
      await Promise.all([load(), loadCheckpoints(v.id)]);
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = "";
    }
  }

  // checkpoints: copies of the pages, restored in one step (hive pages excluded: rebuilt at night)
  let checkpoints = $state<Checkpoint[] | null>(null);
  let cpName = $state("");
  async function loadCheckpoints(id: string) {
    try {
      checkpoints = await api.get<Checkpoint[]>(`/api/admin/vaults/${id}/checkpoints`);
    } catch {
      checkpoints = [];
    }
  }
  $effect(() => {
    const id = current?.id;
    checkpoints = null;
    if (id) void loadCheckpoints(id);
  });
  async function createCheckpoint() {
    const v = current!;
    if (await act("cp", () => api.post(`/api/admin/vaults/${v.id}/checkpoints`, { name: cpName.trim() }), t("Punto di ripristino salvato."))) {
      cpName = "";
      await loadCheckpoints(v.id);
    }
  }
  async function restoreCheckpoint(c: Checkpoint) {
    const v = current!;
    if (!confirm(t("Riportare «{name}» com'era al punto «{name2}» ({createdAt})? Le pagine nuove vanno via, quelle cambiate tornano come allora. Lo stato attuale viene salvato prima, così puoi tornare indietro.", { name: v.name, name2: c.name, createdAt: when(c.createdAt) }))) return;
    const r = await act("cp-" + c.id, () => api.post<{ restored: number; removed: number; unchanged: number; skipped: string[] }>(`/api/admin/checkpoints/${c.id}/restore`));
    if (r) {
      ui.toast(t("Ripristino fatto: {restored} pagine riportate indietro, {removed} tolte, {unchanged} uguali{x}.", { restored: r.restored, removed: r.removed, unchanged: r.unchanged, x: r.skipped.length ? t(", {n} non riportate ({join})", { n: r.skipped.length, join: r.skipped.slice(0, 3).join(", ") }) : "" }), r.skipped.length ? "info" : "ok");
      await Promise.all([load(), loadCheckpoints(v.id)]);
    }
  }
  async function deleteCheckpoint(c: Checkpoint) {
    if (!confirm(t("Eliminare il punto di ripristino «{name}»?", { name: c.name }))) return;
    if (await act("cp-" + c.id, () => request("DELETE", `/api/admin/checkpoints/${c.id}`), t("Punto di ripristino eliminato."))) await loadCheckpoints(current!.id);
  }

  async function remove() {
    const v = current!;
    const confirmSlug = prompt(t("Eliminare «{name}» con tutte le sue {pages} pagine e {sources} sorgenti? L'operazione non si annulla. Scrivi l'identificativo ({slug}) per confermare.", { name: v.name, pages: nf.format(v.pages), sources: nf.format(v.sources), slug: v.slug }));
    if (confirmSlug === null) return;
    if (await act("remove", () => request("DELETE", `/api/admin/vaults/${v.id}`, { confirm: confirmSlug }), t("Vault eliminato."))) {
      select();
      await load();
    }
  }
</script>

<div class="adm">
  <header class="adm-head">
    <div>
      <p class="eyebrow you">{t("Console")}</p>
      <h1>{t("Vault e spazi")}</h1>
      <p>{t("Una cella per ogni persona, gruppo o progetto; gli spazi dell'alveare raccolgono le informazioni condivise delle celle collegate. Ogni vault ha una sua partizione di ricerca.")}</p>
    </div>
    <Button variant="primary" onclick={() => (creating = !creating)}>{t("Nuovo vault")}</Button>
  </header>
  <Explain id="admin-vault" text={EXPLAIN_ADMIN["vault"]!} />

  {#if creating}
    <form class="adm-card" onsubmit={(e) => (e.preventDefault(), create())}>
      <h2>{t("Nuovo vault")}</h2>
      <div class="adm-form">
        <label class="field"><span class="label">{t("Tipo")}</span><select class="input" bind:value={nv.kind}><option value="cell">{t("Cella")}</option><option value="space">{t("Spazio dell'alveare")}</option></select></label>
        <label class="field"><span class="label">{t("Identificativo")}</span><input class="input" required pattern="[a-z0-9][a-z0-9\-]*" maxlength="63" bind:value={nv.slug} placeholder={t("commerciale")} /></label>
        <label class="field"><span class="label">{t("Nome")}</span><input class="input" required bind:value={nv.name} placeholder={t("Ufficio commerciale")} /></label>
        {#if nv.kind === "cell"}
          <OwnerField bind:owner={nv.owner} bind:complete={newOwnerOk} optional />
        {/if}
        <label class="field"><span class="label">{t("Classificazione predefinita")}</span>
          <select class="input" bind:value={nv.classification}><option value="">{nv.owner.startsWith("user:") ? t("personale (vault personale)") : t("dalle impostazioni")}</option>{#each classificationsFor(nv.owner.startsWith("user:")) as c, i (c)}<option value={String(i)}>{valueLabel(c)}</option>{/each}</select>
        </label>
        <label class="field"><span class="label">{t("Indice vettoriale")}</span><select class="input" bind:value={nv.vectorIndex}>{#each Object.entries(INDEX_LABEL) as [k, l] (k)}<option value={k}>{l}</option>{/each}</select></label>
      </div>
      <div class="adm-bar">
        <Button variant="primary" type="submit" busy={busy === "create"}>{t("Crea")}</Button>
        <Button variant="quiet" type="button" onclick={() => (creating = false)}>{t("Annulla")}</Button>
      </div>
    </form>
  {/if}

  {#if error}
    <p class="notice error">{error}</p>
  {:else if !vaults}
    <span class="skeleton" style="height:12rem"></span>
  {:else}
    <div class="adm-scroll">
      <table class="adm-table">
        <thead><tr><th>{t("Nome")}</th><th>{t("Tipo")}</th><th class="num">{t("Pagine")}</th><th class="num">{t("Sorgenti")}</th><th class="num">{t("Permessi")}</th><th>{t("Predefinita")}</th><th>{t("Indice")}</th><th><span class="visually-hidden">{t("Azioni")}</span></th></tr></thead>
        <tbody>
          {#each vaults as v (v.id)}
            <tr class:sel={v.id === selected}>
              <td><button class="link" onclick={() => select(v.id === selected ? undefined : v.id)}>{v.name}</button> <span class="dim mono">{v.slug}</span></td>
              <td><span class="badge {v.kind === 'space' ? 'busy' : ''}">{v.kind === "space" ? t("alveare") : t("cella")}</span>{#if v.owner}<span class="dim"> {v.ownerLabel ? t("utente {ownerLabel}", { ownerLabel: v.ownerLabel }) : v.owner}</span>{/if}</td>
              <td class="num">{nf.format(v.pages)}</td>
              <td class="num">{nf.format(v.sources)}</td>
              <td class="num">{v.grants}</td>
              <td>{valueLabel(ALL_CLASSIFICATIONS[v.defaultClassification])}</td>
              <td class="dim">{v.vectorIndex}</td>
              <td class="acts"><Button size="sm" variant={v.id === selected ? "secondary" : "quiet"} aria-expanded={v.id === selected} onclick={() => select(v.id === selected ? undefined : v.id)}>{v.id === selected ? t("Chiudi") : t("Modifica")}</Button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if current && edit}
      <div class="adm-grid" bind:this={editor}>
        <section class="adm-card">
          <h2>{current.name}</h2>
          <div class="adm-form">
            <label class="field"><span class="label">{t("Nome")}</span><input class="input" bind:value={edit.name} /></label>
            <label class="field"><span class="label">{t("Classificazione predefinita")}</span><select class="input" bind:value={edit.defaultClassification}>{#each classificationsFor(edit.owner.startsWith("user:")) as c, i (c)}<option value={i}>{valueLabel(c)}</option>{/each}</select></label>
            <label class="field"><span class="label">{t("Indice vettoriale")}</span><select class="input" bind:value={edit.vectorIndex}>{#each Object.entries(INDEX_LABEL) as [k, l] (k)}<option value={k}>{l}</option>{/each}</select></label>
            {#key `${current.id}|${current.owner ?? ""}`}<OwnerField bind:owner={edit.owner} bind:complete={editOwnerOk} ownerLabel={current.ownerLabel} />{/key}
            <label class="field"><span class="label">{t("Identificativo")}</span><input class="input mono" value={current.slug} readonly title={t("L'identificativo è negli indirizzi brain:// e nei collegamenti: non si cambia")} /></label>
          </div>
          <label class="field schema"><span class="label">{t("SCHEMA.md (regole di compilazione del vault)")}</span>
            {#if edit.schemaMd === null}<span class="skeleton" style="height:6rem"></span>
            {:else}<textarea class="input mono" rows="8" maxlength="100000" bind:value={edit.schemaMd}></textarea>{/if}
          </label>
          <div class="adm-bar">
            <Button size="sm" variant="primary" busy={busy === "save"} onclick={save}>{t("Salva")}</Button>
            <Button size="sm" busy={busy === "dream"} onclick={dreamNow}>{t("Ciclo notturno ora")}</Button>
            <Button size="sm" variant="quiet" onclick={() => ws.open({ kind: "admin", section: "sorgenti", id: current!.slug })}>{t("Sorgenti")}</Button>
            <Button size="sm" variant="quiet" onclick={() => ws.open({ kind: "dashboard", id: "salute" })}>{t("Salute")}</Button>
          </div>
        </section>

        <section class="adm-card">
          <h2>{t("Copia e ripristino")}</h2>
          <p class="dim">{t("L'esportazione scarica le pagine in Markdown (formato Obsidian) in un file zip. L'importazione ripristina le pagine da un file esportato.")}</p>
          <div class="adm-bar">
            <Button size="sm" busy={busy === "export"} onclick={exportZip}>{t("Esporta zip")}</Button>
            <Button size="sm" busy={busy === "import"} onclick={() => fileInput?.click()}>{t("Importa zip…")}</Button>
            <input bind:this={fileInput} type="file" accept=".zip,application/zip" hidden onchange={(e) => {
              const f = (e.currentTarget as HTMLInputElement).files?.[0];
              (e.currentTarget as HTMLInputElement).value = "";
              if (f) void importZip(f);
            }} />
          </div>
          <h3>{t("Punti di ripristino")}</h3>
          <p class="dim">{t("Una copia delle pagine del vault in questo momento. Il ripristino riporta tutte le pagine a quella copia. Il server ne salva uno da solo prima di un import e prima di un ripristino.")}</p>
          <form class="adm-bar" onsubmit={(e) => (e.preventDefault(), void createCheckpoint())}>
            <input class="input" bind:value={cpName} maxlength="200" placeholder={t("Nome, es. prima della riorganizzazione")} aria-label={t("Nome del punto di ripristino")} required />
            <Button size="sm" type="submit" busy={busy === "cp"} disabled={!cpName.trim()}>{t("Salva un punto")}</Button>
          </form>
          {#if checkpoints === null}<span class="skeleton" style="height:2rem"></span>
          {:else if checkpoints.length}
            <ul class="checkpoints">
              {#each checkpoints as c (c.id)}
                <li>
                  <span><strong>{c.name}</strong> <span class="dim small">{t("{createdAt} · {pages} pagine{x}", { createdAt: when(c.createdAt), pages: nf.format(c.pages), x: c.kind === "auto" ? " · automatico" : "" })}</span></span>
                  <span class="adm-bar">
                    <Button size="sm" busy={busy === "cp-" + c.id} onclick={() => restoreCheckpoint(c)}>{t("Ripristina")}</Button>
                    <Button size="sm" variant="quiet" onclick={() => deleteCheckpoint(c)} aria-label={t("Elimina {name}", { name: c.name })}>{t("Elimina")}</Button>
                  </span>
                </li>
              {/each}
            </ul>
          {:else}<p class="dim small">{t("Nessun punto di ripristino.")}</p>{/if}
          <h2 class="danger">{t("Zona pericolosa")}</h2>
          <div><Button size="sm" variant="danger" busy={busy === "remove"} onclick={remove}>{t("Elimina il vault")}</Button></div>
        </section>

        {#if current.kind === "space"}
          <section class="adm-card feeds">
            <h2>{t("Celle che alimentano lo spazio")}</h2>
            <p class="dim">{t("Ogni notte le affermazioni delle celle scelte arrivano nello spazio. Senza tipi, la cella condivide tutte le pagine; con i tipi, solo quelle.")}</p>
            <ul>
              {#each cells as c (c.id)}
                {@const f = feedOf(c.id)}
                <li>
                  <label><input type="checkbox" checked={!!f} onchange={() => toggleFeed(c.id)} /> {c.name} <span class="dim mono">{c.slug}</span></label>
                  {#if f}
                    <span class="types">
                      {#each FEED_TYPES as t (t)}
                        <button type="button" class="chip" role="checkbox" aria-checked={f.types.includes(t)} onclick={() => toggleType(c.id, t)}>{t}</button>
                      {/each}
                    </span>
                  {/if}
                </li>
              {:else}
                <li class="dim">{t("Nessuna cella.")}</li>
              {/each}
            </ul>
            <div><Button size="sm" variant="primary" busy={busy === "feeds"} onclick={saveFeeds}>{t("Salva i collegamenti")}</Button></div>
          </section>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .checkpoints {
    list-style: none;
    margin: 0.5rem 0 1rem;
    padding: 0;
  }
  .checkpoints li {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--line);
  }
  .schema textarea {
    width: 100%;
    resize: vertical;
    font-size: var(--fs-xs);
    line-height: 1.5;
  }
  .danger {
    color: var(--alert-ink);
    font-size: var(--fs-sm) !important;
    margin-top: 0.5rem;
  }
  .feeds {
    grid-column: 1 / -1;
  }
  .feeds ul {
    list-style: none;
    display: grid;
    gap: 0.35rem;
    font-size: var(--fs-sm);
    max-height: 22rem;
    overflow-y: auto;
  }
  .feeds li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 1rem;
  }
  .types {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .types .chip {
    font-size: var(--fs-xs);
    padding: 0 0.45rem;
  }
</style>
