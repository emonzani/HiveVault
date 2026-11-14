<script lang="ts">
  // First-access notice about the cloud agent (plan §3.6, decision D1). It cannot be dismissed without
  // the confirmation, which the server records in the audit log.
  import Button from "../components/Button.svelte";
  import Icon from "../components/Icon.svelte";
  import { api } from "../lib/api.ts";
  import { session } from "../lib/session.svelte.ts";
  import { ui } from "../lib/ui.svelte.ts";
  import { t, tHtml } from "../lib/i18n.ts";

  let dialog: HTMLDialogElement | undefined = $state();
  let busy = $state(false);
  const need = $derived(session.me?.principal.kind === "user" && session.noticeAckAt === null);

  // text set by the administrators (console, Impostazioni); empty = the default below
  let custom = $state<string[] | null>(null);
  $effect(() => {
    if (!need) return;
    api.get<{ text: string }>("/api/notice-text").then(
      (r) => (custom = r.text.trim() ? r.text.trim().split(/\n\s*\n/) : []),
      () => (custom = []),
    );
  });

  $effect(() => {
    if (need && dialog && !dialog.open) dialog.showModal();
    else if (!need && dialog?.open) dialog.close();
  });

  async function ack() {
    busy = true;
    try {
      await session.acknowledgeNotice();
    } catch (e) {
      ui.toast((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }
</script>

<dialog class="modal" bind:this={dialog} oncancel={(e) => e.preventDefault()} aria-labelledby="notice-title" aria-describedby="notice-body">
  {#if need}
    <div class="modal-head"><h2 id="notice-title">{t("Prima di iniziare: l'agente cloud e i dati dell'azienda")}</h2></div>
    <div class="modal-body" id="notice-body">
      {#if custom?.length}
        {#each custom as para, i (i)}<p class="custom">{para}</p>{/each}
      {:else}
      <p>{t("HiveVault conserva i documenti sul server dell'azienda e li trasforma in pagine collegate con modelli che girano in locale.")}</p>
      <ul>
        <li><strong>{t("I documenti originali non escono mai dal server.")}</strong></li>
        <li>{@html tHtml("Il **testo compilato** delle pagine classificate **pubblico** o **interno** può essere letto dall'**agente cloud**, un servizio esterno, tramite gli account API autorizzati dall'amministratore.")}</li>
        <li>{@html tHtml("Le pagine **riservato** e **segreto** non sono mai consultabili dall'agente cloud.")}</li>
        <li>{t("Ogni pagina leggibile dall'agente cloud mostra il segno")} <span class="agent"><Icon name="agent" size={13} />{t("Consultabile dall'agente cloud")}</span>{t(". Nel pannello «Cosa ha letto l'agente cloud» vedi le letture delle pagine della tua cella.")}</li>
        <li>{t("Quando carichi un documento puoi alzare la classificazione prima della compilazione.")}</li>
      </ul>
      {/if}
    </div>
    <div class="modal-foot">
      <Button variant="primary" {busy} onclick={ack}>{t("Ho letto e ho capito")}</Button>
    </div>
  {/if}
</dialog>

<style>
  ul {
    display: grid;
    gap: 0.5rem;
    padding-left: 1.2rem;
    font-size: var(--fs-sm);
  }
  p {
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  p.custom {
    color: var(--text-main);
    white-space: pre-line;
  }
  .agent {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    vertical-align: bottom;
    color: var(--accent-blue);
    font-weight: 600;
    white-space: nowrap;
  }
</style>
