<script lang="ts">
  import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
  import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
  import Button from "../components/Button.svelte";
  import ThemePicker from "../components/ThemePicker.svelte";
  import { api, ApiError } from "../lib/api.ts";
  import { session } from "../lib/session.svelte.ts";
  import { t } from "../lib/i18n.ts";

  type Mode = "totp" | "recovery" | "enroll";
  const fromUrl = new URLSearchParams(location.search).get("attiva") ?? (/^#\/attiva\/(.+)$/.exec(location.hash)?.[1] ?? "");

  let mode = $state<Mode>(fromUrl ? "enroll" : "totp");
  let username = $state("");
  let code = $state("");
  let error = $state("");
  let busy = $state(false);
  const passkeys = browserSupportsWebAuthn();

  // enrollment
  let activation = $state(decodeURIComponent(fromUrl));
  let enroll = $state<{ username: string; qrSvg: string; secret: string } | null>(null);
  let enrollTotp = $state("");
  let recoveryCodes = $state<string[] | null>(null);

  const fail = (e: unknown) => (error = e instanceof ApiError ? e.message : t("Accesso non riuscito. Riprova."));

  async function done() {
    history.replaceState(null, "", location.pathname + (location.hash.startsWith("#/attiva") ? "#/" : location.hash));
    await session.load();
  }

  async function loginCode(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    busy = true;
    try {
      const url = mode === "recovery" ? "/api/auth/login/recovery" : "/api/auth/login/totp";
      const r = await api.post<{ recoveryCodesLeft?: number }>(url, { username: username.trim(), code: code.replace(/\s+/g, "") }, { quiet401: true });
      if (mode === "recovery" && r.recoveryCodesLeft !== undefined && r.recoveryCodesLeft <= 3) {
        sessionStorage.setItem("cb-recovery-left", String(r.recoveryCodesLeft));
      }
      await done();
    } catch (err) {
      fail(err);
      code = "";
    } finally {
      busy = false;
    }
  }

  async function loginPasskey() {
    error = "";
    busy = true;
    try {
      const o = await api.post<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
        "/api/auth/passkey/options",
        username.trim() ? { username: username.trim() } : {},
        { quiet401: true },
      );
      const response = await startAuthentication({ optionsJSON: o.options });
      await api.post("/api/auth/passkey/login", { challengeId: o.challengeId, response }, { quiet401: true });
      await done();
    } catch (err) {
      if ((err as Error).name === "NotAllowedError") error = t("Accesso con passkey annullato o scaduto.");
      else fail(err);
    } finally {
      busy = false;
    }
  }

  async function startEnroll(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    busy = true;
    try {
      enroll = await api.post("/api/auth/enroll/start", { code: activation.trim() }, { quiet401: true });
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }

  async function confirmEnroll(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    busy = true;
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/api/auth/enroll/confirm", { code: activation.trim(), totp: enrollTotp.replace(/\s+/g, "") }, { quiet401: true });
      recoveryCodes = r.recoveryCodes;
    } catch (err) {
      fail(err);
      enrollTotp = "";
    } finally {
      busy = false;
    }
  }

  function copyCodes() {
    void navigator.clipboard?.writeText(recoveryCodes!.join("\n"));
  }
</script>

<div class="login">
  <div class="theme"><ThemePicker /></div>
  <main class="card" aria-labelledby="login-title">
    <div class="brand"><span class="mark" aria-hidden="true"></span>{t("HiveVault")}</div>

    {#if mode === "enroll"}
      {#if recoveryCodes}
        <h1 id="login-title">{t("Account attivo")}</h1>
        <p class="lead">{t("Conserva questi codici di recupero in un posto sicuro. Ognuno vale una volta, se perdi l'app di autenticazione.")}</p>
        <ol class="codes mono">
          {#each recoveryCodes as c (c)}<li>{c}</li>{/each}
        </ol>
        <div class="row">
          <Button onclick={copyCodes}>{t("Copia i codici")}</Button>
          <Button variant="primary" onclick={done}>{t("Ho salvato i codici, entra")}</Button>
        </div>
      {:else if enroll}
        <h1 id="login-title">{t("Collega l'app di autenticazione")}</h1>
        <p class="lead">{t("Inquadra il codice QR con l'app (per esempio Google Authenticator, Microsoft Authenticator o 1Password), poi scrivi il codice di 6 cifre.")}</p>
        <div class="qr" aria-label={t("Codice QR per l'app di autenticazione")}>{@html enroll.qrSvg}</div>
        <details class="secret">
          <summary>{t("Non puoi inquadrare il QR?")}</summary>
          <p>{t("Inserisci a mano questa chiave:")} <code class="mono">{enroll.secret}</code></p>
        </details>
        <form onsubmit={confirmEnroll} class="form">
          <label class="field">
            <span class="label">{t("Codice dell'app per {username}", { username: enroll.username })}</span>
            <input class="input code" bind:value={enrollTotp} inputmode="numeric" autocomplete="one-time-code" maxlength="8" required />
          </label>
          {#if error}<p class="notice error" role="alert">{error}</p>{/if}
          <Button variant="primary" type="submit" {busy}>{t("Conferma e attiva")}</Button>
        </form>
      {:else}
        <h1 id="login-title">{t("Attiva il tuo account")}</h1>
        <p class="lead">{t("Scrivi il codice di attivazione che ti ha dato l'amministratore. Vale 24 ore.")}</p>
        <form onsubmit={startEnroll} class="form">
          <label class="field">
            <span class="label">{t("Codice di attivazione")}</span>
            <input class="input mono" bind:value={activation} autocomplete="off" spellcheck="false" required />
          </label>
          {#if error}<p class="notice error" role="alert">{error}</p>{/if}
          <Button variant="primary" type="submit" {busy}>{t("Continua")}</Button>
        </form>
        <button class="link" type="button" onclick={() => ((mode = "totp"), (error = ""))}>{t("Ho già un account: accedi")}</button>
      {/if}
    {:else}
      <h1 id="login-title">{t("Accedi")}</h1>
      <p class="lead">{t("La memoria dell'azienda: le tue note, i documenti e le pagine compilate a cui hai accesso.")}</p>

      {#if passkeys}
        <Button variant="primary" onclick={loginPasskey} {busy}>{t("Accedi con una passkey")}</Button>
        <div class="or"><span>{t("oppure con il codice")}</span></div>
      {/if}

      <form onsubmit={loginCode} class="form">
        <label class="field">
          <span class="label">{t("Nome utente")}</span>
          <input class="input" bind:value={username} autocomplete="username webauthn" autocapitalize="none" spellcheck="false" required />
        </label>
        <label class="field">
          <span class="label">{mode === "recovery" ? t("Codice di recupero") : t("Codice dell'app di autenticazione")}</span>
          <input
            class="input {mode === 'totp' ? 'code' : 'mono'}"
            bind:value={code}
            inputmode={mode === "totp" ? "numeric" : "text"}
            autocomplete="one-time-code"
            maxlength={mode === "totp" ? 8 : 32}
            required
          />
        </label>
        {#if error}<p class="notice error" role="alert">{error}</p>{/if}
        <Button variant={passkeys ? "secondary" : "primary"} type="submit" {busy}>{t("Accedi")}</Button>
      </form>
      <div class="links">
        <button class="link" type="button" onclick={() => ((mode = mode === "recovery" ? "totp" : "recovery"), (error = ""), (code = ""))}>
          {mode === "recovery" ? t("Usa il codice dell'app") : t("Ho perso l'app: usa un codice di recupero")}
        </button>
        <button class="link" type="button" onclick={() => ((mode = "enroll"), (error = ""))}>{t("Ho un codice di attivazione")}</button>
      </div>
    {/if}
  </main>
  <p class="foot">{t("I documenti originali restano sul server dell'azienda.")}</p>
</div>

<style>
  .login {
    min-height: 100%;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 1.25rem;
    padding: 2rem 1rem;
    overflow-y: auto;
    height: 100%;
    background:
      radial-gradient(60rem 30rem at 15% -10%, color-mix(in srgb, var(--accent-purple) 10%, transparent), transparent),
      radial-gradient(50rem 30rem at 110% 110%, color-mix(in srgb, var(--busy) 8%, transparent), transparent),
      var(--ink-0);
  }
  .theme {
    position: fixed;
    top: 1rem;
    right: 1rem;
  }
  .card {
    width: min(26rem, 100%);
    display: grid;
    gap: 1rem;
    padding: 2rem;
    border-radius: var(--radius-lg);
    background: var(--ink-1);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-subtle);
  }
  .card > :global(.btn) {
    justify-content: center;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    font-weight: 680;
  }
  .mark {
    width: 1.2rem;
    height: 1.2rem;
    border-radius: 4px;
    background:
      radial-gradient(circle at 30% 30%, var(--you) 0 28%, transparent 30%),
      radial-gradient(circle at 70% 35%, var(--busy) 0 24%, transparent 26%),
      radial-gradient(circle at 45% 72%, var(--idle) 0 26%, transparent 28%),
      var(--ink-3);
  }
  h1 {
    font-size: var(--fs-2xl);
  }
  .lead {
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .form {
    display: grid;
    gap: 0.85rem;
  }
  .form :global(.btn) {
    justify-content: center;
  }
  .code {
    font-family: var(--font-mono);
    font-family: var(--font-mono);
    letter-spacing: 0.3em;
    font-size: var(--fs-lg);
  }
  .or {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--text-dim);
    font-size: var(--fs-xs);
  }
  .or::before,
  .or::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--line);
  }
  .links {
    display: grid;
    gap: 0.35rem;
    justify-items: start;
  }
  .link {
    border: 0;
    background: none;
    color: var(--accent-blue);
    font-size: var(--fs-sm);
    cursor: pointer;
    padding: 0;
    text-align: left;
  }
  .link:hover {
    text-decoration: underline;
  }
  .qr {
    justify-self: center;
    width: 12rem;
    padding: 0.6rem;
    border-radius: var(--r-control);
    background: #fff;
  }
  .qr :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }
  .secret {
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .secret code {
    overflow-wrap: anywhere;
    color: var(--text-main);
  }
  .codes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.35rem 1.5rem;
    padding: 0.85rem 1rem 0.85rem 2rem;
    border-radius: var(--r-control);
    background: var(--ink-2);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
  }
  .foot {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
</style>
