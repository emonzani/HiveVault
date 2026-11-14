<script lang="ts">
  import { tick } from "svelte";
  import Button from "../components/Button.svelte";
  import { api, ApiError } from "../lib/api.ts";
  import { classificationsFor, PERSONAL, valueLabel } from "../lib/format.ts";
  import { pageEvents } from "../lib/pages.svelte.ts";
  import { session } from "../lib/session.svelte.ts";
  import { ui } from "../lib/ui.svelte.ts";
  import { ws } from "../lib/workspace.svelte.ts";
  import { t } from "../lib/i18n.ts";

  const TYPES = [
    { id: "note", label: t("Nota") },
    { id: "entity", label: t("Entità (persona, cliente, prodotto…)") },
    { id: "concept", label: t("Concetto") },
    { id: "decision", label: t("Decisione") },
    { id: "synthesis", label: t("Sintesi") },
  ];

  let dialog: HTMLDialogElement | undefined = $state();
  let titleEl: HTMLInputElement | undefined = $state();
  let title = $state("");
  let vaultId = $state("");
  let type = $state("note");
  let classification = $state("default");
  let busy = $state(false);
  let error = $state("");
  const vault = $derived(session.writable.find((v) => v.id === vaultId));
  const personal = $derived(vault?.personal ?? false);
  /** The level the page gets: the chosen one, or the default of the vault. */
  const level = $derived(classification === "default" ? (vault?.defaultClassification ?? 1) : Number(classification));
  $effect(() => {
    if (!personal && classification === String(PERSONAL)) classification = "default";
  });

  $effect(() => {
    const n = ui.newPage;
    if (n && dialog && !dialog.open) {
      title = n.title ?? "";
      const w = session.writable;
      const want = n.vaultId ?? session.vault?.id;
      vaultId = w.some((v) => v.id === want) ? want! : (w[0]?.id ?? "");
      type = "note";
      classification = "default";
      error = "";
      dialog.showModal();
      void tick().then(() => titleEl?.select());
    } else if (!n && dialog?.open) dialog.close();
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      const t = title.trim();
      const r = await api.post<{ id: string }>(`/api/vaults/${encodeURIComponent(vaultId)}/pages`, {
        title: t,
        type,
        body: `# ${t}\n\n`,
        ...(classification !== "default" ? { classification: Number(classification) } : {}),
      });
      pageEvents.notify(r.id);
      ui.newPage = null;
      ws.open({ kind: "page", id: r.id, edit: true }, "here");
    } catch (err) {
      error = err instanceof ApiError ? err.message : t("Creazione non riuscita.");
    } finally {
      busy = false;
    }
  }
</script>

<dialog class="modal" bind:this={dialog} onclose={() => (ui.newPage = null)} aria-labelledby="np-title">
  {#if ui.newPage}
    <form onsubmit={create}>
      <div class="modal-head"><h2 id="np-title">{t("Nuova pagina")}</h2></div>
      <div class="modal-body">
        <label class="field">
          <span class="label">{t("Titolo")}</span>
          <input class="input" bind:this={titleEl} bind:value={title} required maxlength="300" />
          <span class="msg">{t("Gli altri possono collegarla scrivendo [[{x}]].", { x: title.trim() || t("Titolo") })}</span>
        </label>
        <div class="grid2">
          <label class="field">
            <span class="label">{t("Vault")}</span>
            <select class="input" bind:value={vaultId}>{#each session.writable as v (v.id)}<option value={v.id}>{v.name}</option>{/each}</select>
          </label>
          <label class="field">
            <span class="label">{t("Tipo")}</span>
            <select class="input" bind:value={type}>{#each TYPES as t (t.id)}<option value={t.id}>{t.label}</option>{/each}</select>
          </label>
        </div>
        <label class="field">
          <span class="label">{t("Classificazione")}</span>
          <select class="input" bind:value={classification}>
            <option value="default">{t("Predefinita del vault")}</option>
            {#each classificationsFor(personal) as c, i (c)}<option value={String(i)}>{valueLabel(c)}</option>{/each}
          </select>
          <span class="msg"
            >{level === PERSONAL
              ? personal
                ? t("Solo tu potrai leggere questa pagina: nemmeno gli amministratori. Se il tuo account viene cancellato, la pagina viene cancellata.")
                : t("Solo il proprietario di questo vault personale potrà leggere la pagina: né tu né gli amministratori.")
              : level <= 1
                ? t("L'agente cloud potrà leggere il testo della pagina tramite gli account API autorizzati.")
                : t("L'agente cloud non leggerà questa pagina.")}</span
          >
        </label>
        {#if error}<p class="notice error" role="alert">{error}</p>{/if}
      </div>
      <div class="modal-foot">
        <Button variant="quiet" type="button" onclick={() => (ui.newPage = null)}>{t("Annulla")}</Button>
        <Button variant="primary" type="submit" {busy} disabled={!title.trim() || !vaultId}>{t("Crea e scrivi")}</Button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
</style>
