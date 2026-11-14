<script lang="ts">
  // Server settings changed from the console: night window and budget, default
  // classification of new vaults, text of the cloud agent notice. They apply without a restart.
  import Explain from "../../../components/Explain.svelte";
  import { EXPLAIN_ADMIN } from "../../../lib/explain.ts";
  import Button from "../../../components/Button.svelte";
  import { api } from "../../../lib/api.ts";
  import { HHMM_RANGE } from "../../../lib/admin.ts";
  import { CLASSIFICATIONS, nf, valueLabel } from "../../../lib/format.ts";
  import { ui } from "../../../lib/ui.svelte.ts";
  import { t } from "../../../lib/i18n.ts";

  interface All {
    dream: { window: string; minutes: number; tokens: number; compilePerNight: number; useModel: boolean };
    notice: { text: string };
    defaults: { classification: number };
    privacy: { readRetentionDays: number; emailIngest: boolean };
  }
  let s = $state<All | null>(null);
  let error = $state("");
  let busy = $state("");

  $effect(() => {
    api.get<All>("/api/admin/settings").then((r) => (s = r), (e: Error) => (error = e.message));
  });

  async function save<K extends keyof All>(key: K) {
    busy = key;
    try {
      s![key] = await api.put<All[K]>(`/api/admin/settings/${key}`, $state.snapshot(s![key]));
      ui.toast(t("Impostazioni salvate."), "ok");
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
      <h1>{t("Impostazioni")}</h1>
      <p>{t("Valgono subito, senza riavviare il server, e prevalgono sui valori del file .env.")}</p>
    </div>
  </header>
  <Explain id="admin-impostazioni" text={EXPLAIN_ADMIN["impostazioni"]!} />

  {#if error}
    <p class="notice error">{error}</p>
  {:else if !s}
    <span class="skeleton" style="height:14rem"></span>
  {:else}
    <form class="adm-card" onsubmit={(e) => (e.preventDefault(), save("dream"))}>
      <h2>{t("Ciclo notturno")}</h2>
      <p class="dim">{t("Il server riordina la memoria nella finestra notturna, vault dopo vault, entro un budget di tempo e di token per vault e per notte. Se il budget finisce, riprende la notte dopo.")}</p>
      <div class="adm-form">
        <label class="field"><span class="label">{t("Finestra (HH:MM-HH:MM)")}</span><input class="input" required pattern={HHMM_RANGE} bind:value={s.dream.window} /></label>
        <label class="field"><span class="label">{t("Minuti per vault")}</span><input class="input" type="number" min="1" max="1440" bind:value={s.dream.minutes} /></label>
        <label class="field"><span class="label">{t("Token del modello per vault")}</span><input class="input" type="number" min="0" step="1000" bind:value={s.dream.tokens} /></label>
        <label class="field"><span class="label">{t("Compilazioni per notte")}</span><input class="input" type="number" min="0" bind:value={s.dream.compilePerNight} /></label>
      </div>
      <label class="check"><input type="checkbox" bind:checked={s.dream.useModel} /> {t("Usa il modello di chat (sintesi, compilazione, deduplica). Senza modello restano i passi deterministici.")}</label>
      <p class="dim small">{t("Budget totale per notte: circa {tokens} token per ogni vault con modifiche.", { tokens: nf.format(s.dream.tokens) })}</p>
      <div><Button variant="primary" size="sm" type="submit" busy={busy === "dream"}>{t("Salva")}</Button></div>
    </form>

    <form class="adm-card" onsubmit={(e) => (e.preventDefault(), save("defaults"))}>
      <h2>{t("Classificazione predefinita")}</h2>
      <p class="dim">{t("Il livello dei nuovi vault quando chi li crea non ne sceglie uno. Ogni documento e pagina può avere un livello più alto.")}</p>
      <div class="adm-form">
        <label class="field"><span class="label">{t("Nuovi vault")}</span>
          <select class="input" bind:value={s.defaults.classification}>{#each CLASSIFICATIONS as c, i (c)}<option value={i}>{valueLabel(c)}</option>{/each}</select>
        </label>
      </div>
      <div><Button variant="primary" size="sm" type="submit" busy={busy === "defaults"}>{t("Salva")}</Button></div>
    </form>

    <form class="adm-card" onsubmit={(e) => (e.preventDefault(), save("privacy"))}>
      <h2>{t("Privacy")}</h2>
      <p class="dim">{t("Le letture delle pagine (chi ha letto cosa) servono alla sicurezza e all'importanza delle pagine, ma mostrano anche il lavoro di ogni persona. Tienile il tempo minimo concordato con i lavoratori. Gli eventi di sicurezza (accessi, modifiche degli amministratori) restano almeno 6 mesi e non si possono modificare.")}</p>
      <div class="adm-form">
        <label class="field"><span class="label">{t("Giorni di conservazione delle letture")}</span><input class="input" type="number" min="1" max="400" required bind:value={s.privacy.readRetentionDays} /></label>
      </div>
      <label class="check"><input type="checkbox" bind:checked={s.privacy.emailIngest} /> {t("Accetta i file di posta (EML, MSG, MBOX). Le email diventano almeno «riservato»: l'agente cloud non le legge.")}</label>
      <div><Button variant="primary" size="sm" type="submit" busy={busy === "privacy"}>{t("Salva")}</Button></div>
    </form>

    <form class="adm-card" onsubmit={(e) => (e.preventDefault(), save("notice"))}>
      <h2>{t("Avviso sull'agente cloud")}</h2>
      <p class="dim">{t("Ogni utente lo legge e lo conferma al primo accesso. Vuoto = testo predefinito. Separa i paragrafi con una riga vuota.")}</p>
      <textarea class="input notice-text" rows="8" maxlength="5000" bind:value={s.notice.text} placeholder={t("Testo predefinito: le pagine pubbliche e interne possono essere lette dall'agente cloud, un servizio esterno…")}></textarea>
      <div class="adm-bar">
        <Button variant="primary" size="sm" type="submit" busy={busy === "notice"}>{t("Salva")}</Button>
        <span class="dim small">{s.notice.text.length}/5000</span>
      </div>
    </form>
  {/if}
</div>

<style>
  .check {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: var(--fs-sm);
  }
  .small {
    font-size: var(--fs-xs);
  }
  .notice-text {
    width: 100%;
    font: inherit;
    resize: vertical;
    line-height: 1.5;
  }
</style>
