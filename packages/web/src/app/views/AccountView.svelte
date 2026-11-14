<script lang="ts">
  // The user's own account: profile, passkeys, recovery codes, active sessions, cloud agent notice.
  import { startRegistration, browserSupportsWebAuthn, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
  import { untrack } from "svelte";
  import Button from "../../components/Button.svelte";
  import ThemePicker from "../../components/ThemePicker.svelte";
  import { api } from "../../lib/api.ts";
  import { classificationName, valueLabel, when } from "../../lib/format.ts";
  import { session } from "../../lib/session.svelte.ts";
  import { ui } from "../../lib/ui.svelte.ts";
  import { t, tHtml } from "../../lib/i18n.ts";
  import { ROLE_LABEL } from "../../lib/admin.ts";

  interface Security {
    totp: boolean;
    recoveryCodesLeft: number;
    passkeys: { id: string; name: string | null; deviceType: string; backedUp: boolean; createdAt: string; lastUsedAt: string | null }[];
    publicKeys: { id: string; name: string | null; kind: string; fingerprint: string; createdAt: string }[];
    sessions: { id: string; method: string; ip: string | null; userAgent: string | null; lastSeenAt: string; current: boolean }[];
  }
  let sec = $state<Security | null>(null);
  let adding = $state(false);
  let pkName = $state("");

  async function load() {
    try {
      sec = await api.get<Security>("/api/me/security");
    } catch (e) {
      ui.toast((e as Error).message, "error");
    }
  }
  $effect(() => untrack(() => void load()));

  async function addPasskey() {
    adding = true;
    try {
      const o = await api.post<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>("/api/me/passkeys/options");
      const response = await startRegistration({ optionsJSON: o.options });
      await api.post("/api/me/passkeys", { challengeId: o.challengeId, response, ...(pkName.trim() ? { name: pkName.trim() } : {}) });
      pkName = "";
      ui.toast(t("Passkey aggiunta."), "ok");
      await load();
    } catch (e) {
      ui.toast((e as Error).name === "NotAllowedError" ? t("Registrazione della passkey annullata.") : (e as Error).message, "error");
    } finally {
      adding = false;
    }
  }

  async function del(url: string, msg: string) {
    if (!confirm(msg)) return;
    try {
      await api.del(url);
      await load();
    } catch (e) {
      ui.toast((e as Error).message, "error");
    }
  }

  const me = $derived(session.me!.principal);
  const browser = (ua: string | null) => (!ua ? t("Sconosciuto") : /Edg\//.test(ua) ? t("Edge") : /Chrome\//.test(ua) ? t("Chrome") : /Firefox\//.test(ua) ? t("Firefox") : /Safari\//.test(ua) ? t("Safari") : /node|undici|curl/i.test(ua) ? t("Riga di comando") : t("Browser"));
  const METHOD: Record<string, string> = { totp: t("Codice TOTP"), passkey: t("Passkey"), signature: t("Firma"), recovery: t("Codice di recupero"), enroll: t("Attivazione") };
</script>

<div class="av">
  <div class="col">
    <header class="me">
      <div class="avatar" aria-hidden="true">{me.displayName.slice(0, 1).toUpperCase()}</div>
      <div>
        <h1>{me.displayName}</h1>
        <p class="dim">{t("{name}{x} · ruolo {role} · vede fino a «{clearance}»", { name: me.name, x: me.email ? ` · ${me.email}` : "", role: ROLE_LABEL[me.role] ?? me.role, clearance: valueLabel(classificationName(session.me!.clearance)) })}</p>
      </div>
      <span class="grow"></span>
      <Button onclick={() => session.logout()}>{t("Esci")}</Button>
    </header>

    <section>
      <h2>{t("Aspetto")}</h2>
      <ThemePicker />
    </section>

    <section>
      <h2>{t("Passkey")}</h2>
      <p class="dim small">{t("Accesso senza codice con l'impronta, il volto o il PIN del dispositivo.")}</p>
      {#if sec}
        <ul class="list">
          {#each sec.passkeys as p (p.id)}
            <li>
              <span><strong>{p.name ?? t("Passkey")}</strong> <span class="dim">{t("{x} · aggiunta {createdAt}{x2}", { x: p.deviceType === "multiDevice" ? "sincronizzata" : t("su questo dispositivo"), createdAt: when(p.createdAt), x2: p.lastUsedAt ? ` · usata ${when(p.lastUsedAt)}` : "" })}</span></span>
              <Button size="sm" variant="quiet" onclick={() => del(`/api/me/passkeys/${p.id}`, t("Rimuovere questa passkey?"))}>{t("Rimuovi")}</Button>
            </li>
          {:else}
            <li class="dim">{t("Nessuna passkey.")}</li>
          {/each}
        </ul>
        {#if browserSupportsWebAuthn()}
          <div class="row">
            <input class="input" style="max-width:16rem" placeholder={t("Nome (es. Portatile)")} bind:value={pkName} maxlength="80" aria-label={t("Nome della passkey")} />
            <Button variant="primary" busy={adding} onclick={addPasskey}>{t("Aggiungi una passkey")}</Button>
          </div>
        {:else}
          <p class="notice small">{t("Questo browser non supporta le passkey.")}</p>
        {/if}
      {/if}
    </section>

    {#if sec}
      <section>
        <h2>{t("App di autenticazione")}</h2>
        <p class="small">{t("{x} Codici di recupero rimasti:", { x: sec.totp ? t("Collegata.") : t("Non collegata.") })} <strong class:warn={sec.recoveryCodesLeft <= 3}>{sec.recoveryCodesLeft}</strong>.</p>
        {#if sec.recoveryCodesLeft <= 3}<p class="notice warn small">{t("Restano pochi codici di recupero: chiedi all'amministratore di ricollegare l'app per averne di nuovi.")}</p>{/if}
      </section>

      <section>
        <h2>{t("Sessioni attive")}</h2>
        <ul class="list">
          {#each sec.sessions as s (s.id)}
            <li>
              <span><strong>{browser(s.userAgent)}</strong>{#if s.current} <span class="cur">{t("questa sessione")}</span>{/if} <span class="dim">{t("{x} · {x2} · attiva {lastSeenAt}", { x: METHOD[s.method] ?? s.method, x2: s.ip ?? "—", lastSeenAt: when(s.lastSeenAt) })}</span></span>
              {#if !s.current}<Button size="sm" variant="quiet" onclick={() => del(`/api/me/sessions/${s.id}`, t("Chiudere questa sessione?"))}>{t("Chiudi")}</Button>{/if}
            </li>
          {/each}
        </ul>
      </section>

      {#if sec.publicKeys.length}
        <section>
          <h2>{t("Chiavi per l'accesso con firma")}</h2>
          <ul class="list">
            {#each sec.publicKeys as k (k.id)}
              <li><span><strong>{k.name ?? k.kind}</strong> <span class="dim mono">{k.fingerprint.slice(0, 23)}…</span></span><Button size="sm" variant="quiet" onclick={() => del(`/api/me/public-keys/${k.id}`, t("Revocare questa chiave?"))}>{t("Revoca")}</Button></li>
            {/each}
          </ul>
        </section>
      {/if}
    {/if}

    <section>
      <h2>{t("L'agente cloud e i tuoi dati")}</h2>
      <p class="small">{@html tHtml("Il testo compilato delle pagine **pubblico** e **interno** può essere letto dall'agente cloud (un servizio esterno) tramite gli account API autorizzati dall'amministratore. I documenti originali non escono mai dal server.")}</p>
      {#if session.noticeAckAt}<p class="dim small">{t("Presa visione confermata {noticeAckAt}.", { noticeAckAt: when(session.noticeAckAt) })}</p>{/if}
    </section>
  </div>
</div>

<style>
  .av {
    overflow-y: auto;
    min-height: 0;
    padding: 2rem 2rem 5rem;
  }
  .col {
    max-width: 46rem;
    margin: 0 auto;
    display: grid;
    gap: 1.5rem;
  }
  .me {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .avatar {
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent-purple-glow);
    color: var(--accent-purple);
    font-weight: 700;
    font-size: var(--fs-xl);
  }
  h1 {
    font-size: var(--fs-xl);
  }
  h2 {
    font-size: var(--fs-md);
  }
  section {
    display: grid;
    gap: 0.6rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--line);
  }
  .grow {
    flex: 1;
  }
  .list {
    list-style: none;
    display: grid;
  }
  .list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--line);
    font-size: var(--fs-sm);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
  }
  .small {
    font-size: var(--fs-sm);
  }
  .cur {
    font-size: var(--fs-xs);
    color: var(--busy-ink);
  }
  .warn {
    color: var(--you-ink);
  }
</style>
