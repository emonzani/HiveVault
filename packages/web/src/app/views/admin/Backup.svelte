<script lang="ts">
  // Backup and restore: sizes, the vault exports kept on the server, an export for every vault.
  // Restore of a vault is in "Vault e spazi"; the continuous database backup comes in phase 8.
  import Explain from "../../../components/Explain.svelte";
  import { EXPLAIN_ADMIN } from "../../../lib/explain.ts";
  import Button from "../../../components/Button.svelte";
  import { api } from "../../../lib/api.ts";
  import { downloadPost, type AdminVault } from "../../../lib/admin.ts";
  import { ago, bytes, nf, when } from "../../../lib/format.ts";
  import { ui } from "../../../lib/ui.svelte.ts";
  import { ws } from "../../../lib/workspace.svelte.ts";
  import { t, tHtml } from "../../../lib/i18n.ts";

  interface Status {
    databaseBytes: number;
    documentsBytes: number;
    exports: { file: string; bytes: number; at: string }[];
    pgbackrest: { configured: boolean; note: string };
    lastNightlyCheck: { at: string; data: Record<string, unknown> } | null;
  }
  let st = $state<Status | null>(null);
  let vaults = $state<AdminVault[]>([]);
  let error = $state("");
  let busy = $state("");

  async function load() {
    try {
      [st, vaults] = await Promise.all([api.get<Status>("/api/admin/backup"), api.get<AdminVault[]>("/api/admin/vaults")]);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => void load());

  async function exportVault(v: AdminVault) {
    busy = v.id;
    try {
      const name = await downloadPost(`/api/admin/vaults/${v.id}/export`, `${v.slug}.zip`);
      ui.toast(t("Esportazione pronta: {name}.", { name }), "ok");
      await load();
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
      <h1>{t("Backup e ripristino")}</h1>
      <p>{t("Le esportazioni contengono le pagine in Markdown, leggibili con Obsidian o qualsiasi editor. I documenti originali restano cifrati nella cartella dati del server: includila nel backup del disco.")}</p>
    </div>
  </header>
  <Explain id="admin-backup" text={EXPLAIN_ADMIN["backup"]!} />

  {#if error}
    <p class="notice error">{error}</p>
  {:else if !st}
    <span class="skeleton" style="height:12rem"></span>
  {:else}
    <div class="adm-grid">
      <section class="adm-card">
        <h2>{t("Spazio usato")}</h2>
        <dl class="kv">
          <dt>{t("Database")}</dt><dd>{bytes(st.databaseBytes)}</dd>
          <dt>{t("Documenti originali")}</dt><dd>{bytes(st.documentsBytes)}</dd>
          <dt>{t("Esportazioni salvate")}</dt><dd>{st.exports.length} · {bytes(st.exports.reduce((s, e) => s + e.bytes, 0))}</dd>
          {#if st.lastNightlyCheck}<dt>{t("Ultima verifica notturna")}</dt><dd>{when(st.lastNightlyCheck.at)}</dd>{/if}
        </dl>
      </section>
      <section class="adm-card">
        <h2>{t("Backup continuo del database")}</h2>
        <p class="dim">{st.pgbackrest.note}</p>
        <p class="notice warn">{@html tHtml("Fino ad allora, esegui ogni notte `pg_dump` del database e copia la cartella dati su un disco esterno.")}</p>
      </section>
    </div>

    <section class="adm-card">
      <h2>{t("Esporta un vault")}</h2>
      <div class="adm-scroll">
        <table class="adm-table">
          <thead><tr><th>{t("Vault")}</th><th class="num">{t("Pagine")}</th><th></th></tr></thead>
          <tbody>
            {#each vaults as v (v.id)}
              <tr>
                <td>{v.name} <span class="dim mono">{v.slug}</span></td>
                <td class="num">{nf.format(v.pages)}</td>
                <td class="acts">
                  <Button size="sm" variant="quiet" busy={busy === v.id} onclick={() => exportVault(v)}>{t("Esporta zip")}</Button>
                  <Button size="sm" variant="quiet" onclick={() => ws.open({ kind: "admin", section: "vault", id: v.id })}>{t("Ripristina…")}</Button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="adm-card">
      <h2>{t("Esportazioni sul server")}</h2>
      {#if !st.exports.length}
        <p class="dim">{t("Nessuna esportazione ancora.")}</p>
      {:else}
        <ul class="files">
          {#each st.exports as e (e.file)}
            <li><span class="mono">{e.file}</span><span class="dim">{bytes(e.bytes)} · {ago(e.at)}</span></li>
          {/each}
        </ul>
        <p class="dim small">{@html tHtml("Si trovano nella cartella `exports` della cartella dati.")}</p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .files {
    list-style: none;
    display: grid;
    gap: 0.25rem;
    font-size: var(--fs-sm);
  }
  .files li {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  .small {
    font-size: var(--fs-xs);
  }
</style>
