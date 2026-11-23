<script lang="ts">
  // Right panel for a document selected in the inbox: visibility to the cloud agent, the facts of the document, the pipeline steps with the
  // live phase, warnings and actions. Read again when the level of the document changes.
  import { untrack } from "svelte";
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import { api, ApiError } from "../lib/api.ts";
  import { sourceEvents } from "../lib/events.svelte.ts";
  import { ALL_CLASSIFICATIONS, bytes, nf, valueLabel, WARNING_LABEL } from "../lib/format.ts";
  import { session } from "../lib/session.svelte.ts";
  import type { SourceDetail } from "../lib/types.ts";
  import { target, ui } from "../lib/ui.svelte.ts";
  import { phaseLabel, working } from "../lib/working.svelte.ts";
  import { ws } from "../lib/workspace.svelte.ts";
  import { inspect } from "../lib/inspect.svelte.ts";
  import { t } from "../lib/i18n.ts";

  let { id }: { id: string } = $props();
  let detail = $state<SourceDetail | null>(null);

  $effect(() => {
    const sid = id;
    void sourceEvents.status[sid]?.level;
    void working.has(sid);
    untrack(() => {
      api.get<SourceDetail>(`/api/sources/${encodeURIComponent(sid)}`).then(
        (d) => id === sid && (detail = d),
        () => id === sid && (detail = null),
      );
    });
  });

  const steps = $derived.by(() => {
    if (!detail) return [];
    const w = working.get(detail.id);
    const list = [
      { label: t("Conservato e cifrato"), note: bytes(detail.size), done: true },
      { label: t("Testo cercabile (I1)"), note: detail.chunks ? `${nf.format(detail.chunks)} chunk` : "", done: detail.level >= 1 },
      { label: t("Vettori del significato (I2)"), note: "", done: detail.level >= 2 },
    ];
    if (detail.compile || detail.level >= 3) list.push({ label: t("Pagina compilata per l'agente cloud (I3)"), note: detail.compiledPage ? t("pagina pronta") : "", done: detail.level >= 3 });
    const current = w ? list.findIndex((s) => !s.done) : -1;
    return list.map((s, i) => ({ ...s, current: i === current, note: i === current && w ? phaseLabel(w) : s.note }));
  });
  const permission = $derived(detail ? session.vaults.find((v) => v.id === detail!.vaultId)?.permission : undefined);
  const writable = $derived(!!permission && permission !== "read");
  // deleting or replacing: the uploader with write permission, otherwise a curator
  const owner = $derived(writable && (permission === "curate" || permission === "admin" || detail?.createdBy === session.me?.principal.id));
  const REVIEW_WARNINGS = new Set(["needs_ocr", "ocr_unavailable", "ocr_failed", "little_text"]);
  const toReview = $derived(
    !!detail && !detail.meta?.reviewed && (detail.status === "failed" || detail.status === "unsupported" || (detail.warnings ?? []).some((w) => REVIEW_WARNINGS.has(w))),
  );

  let busy = $state(false);
  let relinking = $state(false);
  let url = $state("");
  // a new document closes the link form
  $effect(() => {
    void id;
    relinking = false;
  });

  async function act(fn: () => Promise<void>) {
    busy = true;
    try {
      await fn();
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }
  const sid = () => encodeURIComponent(detail!.id);
  const reingest = () =>
    act(async () => {
      await api.post(`/api/sources/${sid()}/reingest`);
      ui.toast(t("\"{name}\" rimesso in coda.", { name: detail!.name }), "ok");
      inspect.touch();
    });
  const reviewed = () =>
    act(async () => {
      await api.post(`/api/sources/${sid()}/reviewed`);
      ui.toast(t("\"{x}\" segnato come rivisto.", { x: detail!.title ?? detail!.name }), "ok");
      inspect.touch(null);
    });
  function startRelink() {
    url = detail!.path ?? "";
    relinking = true;
  }
  const relink = (e: SubmitEvent) => {
    e.preventDefault();
    return act(async () => {
      const r = await api.post<{ id: string }>(`/api/sources/${sid()}/relink`, { url: url.trim() });
      ui.toast(t("Link sostituito: il nuovo documento è in elaborazione."), "ok");
      relinking = false;
      inspect.touch(r.id);
    });
  };
  const remove = () => {
    const name = detail!.title ?? detail!.name;
    const extra = [detail!.children?.length ? `i ${detail!.children.length} allegati` : "", detail!.compiledPage ? t("la pagina compilata") : ""].filter(Boolean).join(" e ");
    if (!confirm(t("Eliminare «{name}»{x}? Il file originale viene cancellato dal server. L'operazione non si può annullare.", { name, x: extra ? t(" con {extra}", { extra }) : "" }))) return;
    return act(async () => {
      try {
        await api.del(`/api/sources/${sid()}`);
      } catch (e) {
        // other pages cite the document: offer to retract it from them
        if (!(e instanceof ApiError) || e.code !== "cited") throw e;
        if (!confirm(t("{message}\n\nRitirare il documento? Le frasi che cita solo lui vengono tolte dalle pagine, le altre perdono la sua citazione. L'operazione non si può annullare.", { message: e.message }))) return;
        await retract(name, false);
        return;
      }
      ui.toast(t("\"{name}\" eliminato.", { name }), "ok");
      inspect.touch(null);
    });
  };
  async function retract(name: string, confirmed: boolean): Promise<void> {
    let r: { rewritten: number; deleted: number };
    try {
      r = await api.post<{ rewritten: number; deleted: number }>(`/api/sources/${sid()}/retract`, { confirm: confirmed });
    } catch (e) {
      // a mass change asks once more
      if (confirmed || !(e instanceof ApiError) || e.code !== "mass_change") throw e;
      if (confirm(e.message)) await retract(name, true);
      return;
    }
    ui.toast(t("\"{name}\" ritirato: {n} pagine riscritte, {d} eliminate.", { name, n: r.rewritten, d: r.deleted }), "ok");
    inspect.touch(null);
  }
</script>

<div class="si">
  {#if !detail}
    <span class="skeleton" style="height:8rem"></span>
  {:else}
    <p class="eyebrow you">{t("Documento selezionato")}</p>
    <h2>{detail.title ?? detail.name}</h2>
    <p class="file mono">{detail.name}</p>
    <div class="tags">
      {#if detail.classification <= 1}<span class="badge busy">{t("Consultabile dall'agente cloud")}</span>{:else}<span class="badge">{t("Non leggibile dall'agente cloud")}</span>{/if}
      <span class="badge">{valueLabel(ALL_CLASSIFICATIONS[detail.classification])}</span>
    </div>
    <dl class="facts">
      <div><dt>{t("Token")}</dt><dd class="mono">{detail.textTokens ? nf.format(detail.textTokens) : "–"}</dd></div>
      <div><dt>{t("Chunk")}</dt><dd class="mono">{nf.format(detail.chunks)}</dd></div>
      <div><dt>{t("Vault")}</dt><dd>{session.vaultName(detail.vaultId)}</dd></div>
      <div><dt>{t("Dimensione")}</dt><dd class="mono">{bytes(detail.size)}</dd></div>
    </dl>

    <p class="eyebrow">{t("Fasi della pipeline")}</p>
    <ol class="steps">
      {#each steps as s, i (s.label)}
        <li class:done={s.done} class:current={s.current}>
          <span class="mark" aria-hidden="true">{#if s.done}<Icon name="check" size={12} />{:else}{i + 1}{/if}</span>
          <span class="sl">{s.label}{#if s.note}<span class="sn mono">{s.note}</span>{/if}</span>
          <span class="visually-hidden">{s.done ? t("fatto") : s.current ? t("in corso") : t("da fare")}</span>
        </li>
      {/each}
    </ol>

    {#if (detail.warnings ?? []).length || detail.error}
      <p class="notice warn">{detail.error ?? (detail.warnings ?? []).map((w) => WARNING_LABEL[w] ?? w).join(" · ")}</p>
    {/if}

    {#if detail.origin === "link" && detail.path}
      <p class="file mono link">{t("Link: {path}", { path: detail.path })}</p>
    {/if}

    <div class="acts">
      <Button size="sm" onclick={(e: MouseEvent) => ws.open({ kind: "source", id: detail!.id }, target(e))}>{t("Apri il documento")}</Button>
      {#if detail.compiledPage}<Button size="sm" onclick={(e: MouseEvent) => ws.open({ kind: "page", id: detail!.compiledPage! }, target(e))}>{t("Apri la pagina compilata")}</Button>{/if}
    </div>

    {#if writable}
      <p class="eyebrow">{toReview ? t("Revisione") : t("Azioni")}</p>
      {#if toReview}<p class="hint">{t("Se il documento va bene così, segnalo come rivisto. Altrimenti rielaboralo{x} o eliminalo.", { x: detail.origin === "link" ? t(", cambia il link") : "" })}</p>{/if}
      <div class="acts">
        {#if toReview}<Button size="sm" variant="primary" {busy} onclick={reviewed}><Icon name="check" size={14} />{t("Segna come rivisto")}</Button>{/if}
        <Button size="sm" variant="quiet" disabled={busy} onclick={reingest}>{t("Rielabora")}</Button>
        {#if owner && detail.origin === "link" && !relinking}<Button size="sm" variant="quiet" disabled={busy} onclick={startRelink}>{t("Cambia link")}</Button>{/if}
        {#if owner}<Button size="sm" variant="danger" disabled={busy} onclick={remove}>{t("Elimina")}</Button>{/if}
      </div>
      {#if relinking}
        <form class="relink" onsubmit={relink}>
          <label class="field">
            <span class="label">{t("Nuovo indirizzo")}</span>
            <input class="input" type="url" required maxlength="2000" bind:value={url} placeholder={t("https://…")} />
          </label>
          <p class="hint">{t("Il nuovo link viene scaricato e sostituisce questo documento. Se il download non riesce, il documento resta com'è.")}</p>
          <div class="acts">
            <Button size="sm" variant="primary" type="submit" {busy}>{t("Scarica e sostituisci")}</Button>
            <Button size="sm" variant="quiet" type="button" disabled={busy} onclick={() => (relinking = false)}>{t("Annulla")}</Button>
          </div>
        </form>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .si {
    display: grid;
    align-content: start;
    gap: 0.7rem;
    padding: 0.5rem 0.1rem 1rem;
  }
  h2 {
    font-size: var(--fs-lg);
    font-weight: 700;
    letter-spacing: -0.015em;
    overflow-wrap: anywhere;
  }
  .file {
    margin-top: -0.4rem;
    font-size: 0.6875rem;
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem 0.9rem;
    padding: 0.75rem 0.85rem;
    border: 1px solid var(--line);
    border-radius: var(--r-panel);
    background: var(--ink-1);
  }
  .facts dt {
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .facts dd {
    font-size: var(--fs-sm);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .steps {
    list-style: none;
    display: grid;
    gap: 0.35rem;
  }
  .steps li {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    background: var(--ink-1);
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .steps .mark {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 1.2rem;
    height: 1.2rem;
    border-radius: 50%;
    border: 1px solid var(--line-strong);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
  }
  .steps li.done {
    color: var(--text-main);
  }
  .steps li.done .mark {
    border-color: var(--busy-ink);
    color: var(--busy-ink);
  }
  .steps li.current {
    border-color: var(--you-line);
    color: var(--text-main);
  }
  .steps li.current .mark {
    border-color: var(--you);
    color: var(--you-ink);
  }
  .sl {
    display: grid;
    gap: 0.1rem;
  }
  .sn {
    font-size: 0.6875rem;
    color: var(--text-dim);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .link {
    margin-top: 0;
  }
  .hint {
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .relink {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem 0.85rem;
    border: 1px solid var(--line);
    border-radius: var(--r-panel);
    background: var(--ink-1);
  }
</style>
