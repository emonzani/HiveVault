<script lang="ts">
  // Sources of every vault: status and level, retry (new reading), forced compilation,
  // deletion with the child sources (zip, mail attachments) and the encrypted originals.
  import Explain from "../../../components/Explain.svelte";
  import { EXPLAIN_ADMIN } from "../../../lib/explain.ts";
  import { untrack } from "svelte";
  import Button from "../../../components/Button.svelte";
  import { api, qs, request } from "../../../lib/api.ts";
  import { phaseLabel, queueLabel, working, type CompileQueue } from "../../../lib/working.svelte.ts";
  import type { AdminVault } from "../../../lib/admin.ts";
  import { ago, bytes, CLASSIFICATIONS, SOURCE_STATUS, valueLabel } from "../../../lib/format.ts";
  import { target, ui } from "../../../lib/ui.svelte.ts";
  import { ws } from "../../../lib/workspace.svelte.ts";
  import { inSentence, t } from "../../../lib/i18n.ts";

  let { vault: initialVault }: { vault?: string } = $props();

  interface Row {
    id: string;
    vault: string;
    name: string;
    title: string | null;
    mime: string;
    size: number;
    status: string;
    level: number;
    origin: string | null;
    classification: number;
    error: string | null;
    parentId: string | null;
    compiledPage: string | null;
    createdAt: string;
    children: number;
  }
  const PAGE = 100;

  let vaults = $state<AdminVault[]>([]);
  let vault = $state(untrack(() => initialVault ?? ""));
  let status = $state("");
  let q = $state("");
  let rows = $state<Row[] | null>(null);
  let offset = $state(0);
  let more = $state(false);
  let error = $state("");
  let busy = $state("");

  $effect(() => {
    api.get<AdminVault[]>("/api/admin/vaults").then((v) => (vaults = v), () => {});
  });
  // M14: the compilation queue and its estimated wait, read again with the list
  let queue = $state<CompileQueue | null>(null);
  const loadQueue = () => api.get<CompileQueue>("/api/sources/queue").then((x) => (queue = x), () => {});
  $effect(() => void loadQueue());

  async function load(append = false) {
    try {
      const r = await api.get<Row[]>(`/api/admin/sources${qs({ vault, status, q: q.trim(), limit: PAGE, offset: append ? offset : 0 })}`);
      rows = append && rows ? [...rows, ...r] : r;
      if (!append) void loadQueue();
      offset = (append ? offset : 0) + r.length;
      more = r.length === PAGE;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  let timer: ReturnType<typeof setTimeout>;
  $effect(() => {
    void [vault, status, q];
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 200);
  });

  async function run(r: Row, what: "reingest" | "compile") {
    busy = r.id + what;
    try {
      await api.post(`/api/sources/${r.id}/${what}`);
      ui.toast(what === "reingest" ? t("«{name}» torna in coda per una nuova lettura.", { name: r.name }) : t("Compilazione di «{name}» in coda.", { name: r.name }), "ok");
      await load();
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = "";
    }
  }
  // --- edit: title and classification ---------------------------------------------------
  let edit = $state<{ id: string; title: string; classification: number } | null>(null);
  const startEdit = (r: Row) => (edit = edit?.id === r.id ? null : { id: r.id, title: r.title ?? "", classification: r.classification });
  async function saveEdit(r: Row) {
    const e = edit!;
    const body: Record<string, unknown> = {};
    if (e.title.trim() !== (r.title ?? "")) body.title = e.title.trim() || null;
    if (e.classification !== r.classification) {
      if (e.classification < r.classification) {
        const who = e.classification <= 1 ? t(" Con «pubblico» o «interno» anche l'agente cloud potrà leggerne il testo.") : "";
        const files = r.children ? ` e i suoi ${r.children} file contenuti` : "";
        if (!confirm(t("Abbassare «{x}»{files} da «{x2}» a «{x3}»? Più persone potranno trovarlo nella ricerca.{who} Le pagine già compilate non cambiano.", { x: r.title ?? r.name, files, x2: CLASSIFICATIONS[r.classification], x3: CLASSIFICATIONS[e.classification], who }))) return;
      }
      body.classification = e.classification;
    }
    if (!Object.keys(body).length) return void (edit = null);
    busy = r.id + "save";
    try {
      const x = await request<{ classification?: { sources: number }; pagesRaised?: string[] }>("PATCH", `/api/admin/sources/${r.id}`, body);
      const parts = [t("Sorgente aggiornata")];
      if (x.classification && x.classification.sources > 1) parts.push(`classificazione applicata a ${x.classification.sources} file`);
      if (x.pagesRaised?.length) parts.push(t("{n} pagine compilate alzate allo stesso livello", { n: x.pagesRaised.length }));
      ui.toast(parts.join(" · ") + ".", "ok");
      edit = null;
      await load();
    } catch (err) {
      ui.toast((err as Error).message, "error");
    } finally {
      busy = "";
    }
  }

  async function remove(r: Row) {
    const extra = r.children ? ` e i suoi ${r.children} file contenuti` : "";
    if (!confirm(t("Eliminare «{name}»{extra}? Il file originale cifrato viene cancellato; le pagine compilate restano, con citazioni non più verificabili.", { name: r.name, extra }))) return;
    busy = r.id + "del";
    try {
      const x = await api.del<{ deleted: number; blobs: number }>(`/api/admin/sources/${r.id}`);
      ui.toast(t("{deleted} sorgenti eliminate, {blobs} file cancellati dal disco.", { deleted: x.deleted, blobs: x.blobs }), "ok");
      rows = rows?.filter((y) => y.id !== r.id) ?? null;
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = "";
    }
  }
</script>

<div class="adm">
  <header class="adm-head">
    <div>
      <p class="eyebrow you">{t("Console")}</p>
      <h1>{t("Sorgenti")}</h1>
      <p>{t("I documenti caricati in tutti i vault. I livelli: I0 conservato, I1 testo cercabile, I2 vettori, I3 pagina compilata.")}</p>
    </div>
    <div class="adm-bar">
      <select class="input" aria-label={t("Vault")} bind:value={vault}>
        <option value="">{t("Tutti i vault")}</option>
        {#each vaults as v (v.id)}<option value={v.slug}>{v.name}</option>{/each}
      </select>
      <select class="input" aria-label={t("Stato")} bind:value={status}>
        <option value="">{t("Tutti gli stati")}</option>
        {#each Object.entries(SOURCE_STATUS) as [k, s] (k)}<option value={k}>{s.label}</option>{/each}
      </select>
      <input class="input" type="search" placeholder={t("Nome o id")} aria-label={t("Cerca")} bind:value={q} />
    </div>
  </header>
  <Explain id="admin-sorgenti" text={EXPLAIN_ADMIN["sorgenti"]!} />
  {#if queue}<p class="dim small queue" role="status">{queueLabel(queue)}</p>{/if}

  {#if error}
    <p class="notice error">{error}</p>
  {:else if !rows}
    <span class="skeleton" style="height:14rem"></span>
  {:else}
    <div class="adm-scroll">
      <table class="adm-table">
        <thead><tr><th>{t("Documento")}</th><th>{t("Vault")}</th><th>{t("Stato")}</th><th>{t("Livello")}</th><th class="num">{t("Dimensione")}</th><th>{t("Caricato")}</th><th></th></tr></thead>
        <tbody>
          {#each rows as r (r.id)}
            {@const st = SOURCE_STATUS[r.status] ?? { label: r.status, tone: "dim" }}
            {@const w = working.get(r.id)}
            <tr class:sel={edit?.id === r.id}>
              <td class="doc">
                <a href="#/sorgente/{r.id}" onclick={(e) => (e.preventDefault(), ws.open({ kind: "source", id: r.id }, target(e)))}>{r.title ?? r.name}</a>
                <div class="dim">{r.mime}{r.children ? t(" · {children} file contenuti", { children: r.children }) : ""}{r.parentId ? t(" · contenuto in un altro file") : ""} · {valueLabel(CLASSIFICATIONS[r.classification])}</div>
                {#if r.error}<div class="err">{r.error}</div>{/if}
              </td>
              <td class="mono dim">{r.vault}</td>
              <td><span class="badge {st.tone}">{st.label}</span>{#if w}<div class="wip" title={phaseLabel(w)}>{t("in lavorazione: {toLowerCase}", { toLowerCase: inSentence(phaseLabel(w)) })}</div>{/if}</td>
              <td><span class="lvl I{r.level}">I{r.level}</span></td>
              <td class="num">{bytes(r.size)}</td>
              <td class="dim">{ago(r.createdAt)}</td>
              <td class="acts">
                <Button size="sm" variant="quiet" busy={busy === r.id + "reingest"} title={t("Leggi di nuovo il documento")} onclick={() => run(r, "reingest")}>{t("Riprova")}</Button>
                {#if r.level < 3 && r.status !== "unsupported"}
                  <Button size="sm" variant="quiet" busy={busy === r.id + "compile"} title={t("Compila subito una pagina")} onclick={() => run(r, "compile")}>{t("Compila")}</Button>
                {/if}
                <Button size="sm" variant="quiet" aria-expanded={edit?.id === r.id} onclick={() => startEdit(r)}>{t("Modifica")}</Button>
                <Button size="sm" variant="quiet" busy={busy === r.id + "del"} onclick={() => remove(r)}>{t("Elimina")}</Button>
              </td>
            </tr>
            {#if edit?.id === r.id}
              <tr class="editor">
                <td colspan="7">
                  <form class="adm-form" onsubmit={(e) => (e.preventDefault(), saveEdit(r))}>
                    <label class="field"><span class="label">{t("Titolo")}</span><input class="input" maxlength="300" placeholder={r.name} bind:value={edit.title} /></label>
                    <label class="field"><span class="label">{t("Classificazione")}</span>
                      <select class="input" bind:value={edit.classification}>{#each CLASSIFICATIONS as c, i (c)}<option value={i}>{valueLabel(c)}</option>{/each}</select>
                    </label>
                    <div class="adm-bar">
                      <Button size="sm" variant="primary" type="submit" busy={busy === r.id + "save"}>{t("Salva")}</Button>
                      <Button size="sm" variant="quiet" type="button" onclick={() => (edit = null)}>{t("Annulla")}</Button>
                    </div>
                  </form>
                  <p class="dim hint">{t("La classificazione vale anche per i file contenuti{x}. Se la alzi, la pagina compilata sale allo stesso livello; se la abbassi, la pagina resta com'è.", { x: r.children ? ` (${r.children})` : "" })}</p>
                </td>
              </tr>
            {/if}
          {:else}
            <tr><td colspan="7" class="dim">{t("Nessuna sorgente.")}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if more}<div><Button size="sm" onclick={() => load(true)}>{t("Mostra altre")}</Button></div>{/if}
  {/if}
</div>

<style>
  .doc {
    max-width: 30rem;
  }
  .doc a {
    font-weight: 600;
    color: var(--text-main);
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  .doc a:hover {
    text-decoration: underline;
  }
  .doc .dim {
    font-size: var(--fs-xs);
  }
  .err {
    font-size: var(--fs-xs);
    color: var(--alert-ink);
  }
  .wip {
    font-size: var(--fs-xs);
    color: var(--busy-ink);
    margin-top: 0.2rem;
    max-width: 14rem;
  }
  .editor td {
    background: var(--ink-1);
  }
  .hint {
    font-size: var(--fs-xs);
    margin-top: 0.4rem;
  }
</style>
