<script lang="ts">
  // Users or API accounts: list, creation, detail with credentials, sessions and grants.
  // A new secret (activation code, API key) is shown once, here, and never again.
  import Explain from "../../../components/Explain.svelte";
  import { EXPLAIN_ADMIN } from "../../../lib/explain.ts";
  import Button from "../../../components/Button.svelte";
  import Combobox, { type ComboOption } from "../../../components/Combobox.svelte";
  import { api, qs, request } from "../../../lib/api.ts";
  import { activationLink, clearanceLabel, copy, endOfDay, PERMISSION_LABEL, ROLE_LABEL, SCOPE_LABEL, USER_ROLE_LABEL, type PrincipalDetail, type PrincipalView } from "../../../lib/admin.ts";
  import { ago, CLASSIFICATIONS, valueLabel, when } from "../../../lib/format.ts";
  import { session } from "../../../lib/session.svelte.ts";
  import { ui } from "../../../lib/ui.svelte.ts";
  import { ws } from "../../../lib/workspace.svelte.ts";
  import { t } from "../../../lib/i18n.ts";

  let { kind, selected }: { kind: "user" | "api"; selected?: string } = $props();
  const section = $derived(kind === "user" ? "utenti" : "api");

  let q = $state("");
  let items = $state<PrincipalView[] | null>(null);
  let total = $state(0);
  let error = $state("");
  let creating = $state(false);
  let secret = $state<{ title: string; value: string; link?: string; note: string } | null>(null);
  let detail = $state<PrincipalDetail | null>(null);
  let busy = $state("");

  async function load() {
    try {
      const r = await api.get<{ items: PrincipalView[]; total: number }>(`/api/admin/principals${qs({ kind, q, limit: 300 })}`);
      items = r.items;
      total = r.total;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function loadDetail(id: string) {
    try {
      detail = await api.get<PrincipalDetail>(`/api/admin/principals/${id}`);
      form = { ...detail.principal, expires: detail.principal.expiresAt?.slice(0, 10) ?? "", ips: detail.principal.allowedIps?.join(", ") ?? "" };
    } catch (e) {
      ui.toast((e as Error).message, "error");
      detail = null;
    }
  }
  let timer: ReturnType<typeof setTimeout>;
  $effect(() => {
    void q;
    clearTimeout(timer);
    timer = setTimeout(load, 200);
  });
  $effect(() => {
    if (selected) void loadDetail(selected);
    else detail = null;
    deleting = false;
  });
  const select = (id: string | undefined) => ws.open({ kind: "admin", section, ...(id ? { id } : {}) });
  let searchEl = $state<HTMLInputElement>();
  /** Closes the account panel; the focus goes back to the account's row, or to the search box when the row is not listed. */
  function closeDetail(id: string) {
    select(undefined);
    (document.querySelector<HTMLElement>(`.adm-table button.link[data-id="${CSS.escape(id)}"]`) ?? searchEl)?.focus();
  }

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

  // --- creation -----------------------------------------------------------------------
  let nu = $state({ username: "", displayName: "", email: "", role: "member", clearance: 1 });
  let na = $state({ name: "", displayName: "", scopes: ["read"] as string[], clearance: 1, expires: "", ips: "", rate: "", userId: "", userText: "" });
  // the user an API key acts for: chosen among the suggestions only
  const searchUsers = async (s: string, signal: AbortSignal): Promise<ComboOption[]> =>
    (await api.get<{ items: PrincipalView[] }>(`/api/admin/principals${qs({ kind: "user", q: s, limit: 20 })}`, { signal })).items.map((u) => ({ value: u.id, label: u.displayName, hint: u.name }));
  async function create() {
    if (kind === "user") {
      const r = await act("create", () =>
        api.post<{ principal: PrincipalView; enrollment: { code: string; expiresAt: string } }>("/api/admin/users", {
          username: nu.username.trim(),
          displayName: nu.displayName.trim() || nu.username.trim(),
          ...(nu.email.trim() ? { email: nu.email.trim() } : {}),
          role: nu.role,
          clearance: nu.clearance,
        }),
      );
      if (!r) return;
      secret = { title: t("Attivazione di {displayName}", { displayName: r.principal.displayName }), value: r.enrollment.code, link: activationLink(r.enrollment.code), note: t("Valido fino a {expiresAt}. Invia il link all'utente: configura l'app di autenticazione e sceglie i codici di recupero.", { expiresAt: when(r.enrollment.expiresAt) }) };
      nu = { username: "", displayName: "", email: "", role: "member", clearance: 1 };
      creating = false;
      await load();
      select(r.principal.id);
    } else {
      const ips = na.ips.split(/[\s,]+/).filter(Boolean);
      const r = await act("create", () =>
        api.post<{ principal: PrincipalView; key: string; notice: string }>("/api/admin/api-accounts", {
          name: na.name.trim(),
          ...(na.displayName.trim() ? { displayName: na.displayName.trim() } : {}),
          scopes: na.scopes,
          clearance: na.clearance,
          expiresAt: endOfDay(na.expires),
          allowedIps: ips.length ? ips : null,
          ratePerMin: na.rate ? Number(na.rate) : null,
          userId: na.userId || null,
        }),
      );
      if (!r) return;
      secret = { title: t("Chiave di {name}", { name: r.principal.name }), value: r.key, note: r.notice };
      na = { name: "", displayName: "", scopes: ["read"], clearance: 1, expires: "", ips: "", rate: "", userId: "", userText: "" };
      creating = false;
      await load();
      select(r.principal.id);
    }
  }

  // --- detail -------------------------------------------------------------------------
  // the form comes into view and takes the focus (below the table on narrow windows)
  let panel = $state<HTMLElement>();
  let shownFor = "";
  $effect(() => {
    const id = detail?.principal.id;
    if (!panel || !id || shownFor === id) return;
    shownFor = id;
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    panel.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  });
  let form = $state<(PrincipalView & { expires: string; ips: string }) | null>(null);
  async function save() {
    if (!form || !detail) return;
    const p = detail.principal;
    const body: Record<string, unknown> = {};
    if (form.displayName !== p.displayName) body.displayName = form.displayName;
    if (form.clearance !== p.clearance) body.clearance = form.clearance;
    if (kind === "user") {
      if ((form.email ?? "") !== (p.email ?? "")) body.email = form.email || null;
      if (form.role !== p.role) body.role = form.role;
    } else {
      if (form.scopes.join() !== p.scopes.join()) body.scopes = form.scopes;
      const ips = form.ips.split(/[\s,]+/).filter(Boolean);
      if (ips.join() !== (p.allowedIps ?? []).join()) body.allowedIps = ips.length ? ips : null;
      if (form.expires !== (p.expiresAt?.slice(0, 10) ?? "")) body.expiresAt = endOfDay(form.expires);
      if ((form.ratePerMin ?? null) !== p.ratePerMin) body.ratePerMin = form.ratePerMin || null;
    }
    if (!Object.keys(body).length) return ui.toast(t("Nessuna modifica."), "info");
    if (await act("save", () => request("PATCH", `/api/admin/principals/${p.id}`, body), t("Modifiche salvate."))) {
      await Promise.all([loadDetail(p.id), load()]);
    }
  }
  async function setStatus(status: "active" | "suspended") {
    const p = detail!.principal;
    if (status === "suspended" && !confirm(t("Sospendere {displayName}? Le sessioni e le chiavi smettono di funzionare finché non lo riattivi.", { displayName: p.displayName }))) return;
    if (await act("status", () => request("PATCH", `/api/admin/principals/${p.id}`, { status }), status === "active" ? t("Account riattivato.") : t("Account sospeso."))) {
      await Promise.all([loadDetail(p.id), load()]);
    }
  }
  async function resetTotp() {
    const p = detail!.principal;
    if (!confirm(t("Azzerare l'autenticazione di {displayName}? Le sue sessioni vengono chiuse e riceve un nuovo codice di attivazione.", { displayName: p.displayName }))) return;
    const r = await act("totp", () => api.post<{ enrollment: { code: string; expiresAt: string } }>(`/api/admin/principals/${p.id}/reset-totp`));
    if (r) {
      secret = { title: t("Nuova attivazione di {displayName}", { displayName: p.displayName }), value: r.enrollment.code, link: activationLink(r.enrollment.code), note: t("Valido fino a {expiresAt}.", { expiresAt: when(r.enrollment.expiresAt) }) };
      await loadDetail(p.id);
    }
  }
  async function revokeSessions() {
    const p = detail!.principal;
    if (!confirm(t("Chiudere tutte le sessioni di {displayName}?", { displayName: p.displayName }))) return;
    const r = await act("sessions", () => api.post<{ revoked: number }>(`/api/admin/principals/${p.id}/revoke-sessions`));
    if (r) {
      ui.toast(t("{revoked} sessioni chiuse.", { revoked: r.revoked }), "ok");
      await loadDetail(p.id);
    }
  }
  async function issueKey() {
    const p = detail!.principal;
    const name = prompt(t("Nome della nuova chiave (per esempio: server di produzione)"), t("Chiave"));
    if (name === null) return;
    const r = await act("key", () => api.post<{ key: string; notice: string }>(`/api/admin/principals/${p.id}/api-keys`, { name: name.trim() || t("Chiave") }));
    if (r) {
      secret = { title: t("Nuova chiave di {name}", { name: p.name }), value: r.key, note: t("{notice} Revoca la chiave precedente quando il client usa quella nuova.", { notice: r.notice }) };
      await loadDetail(p.id);
    }
  }
  async function del(url: string, msg: string, ok: string) {
    if (!confirm(msg)) return;
    if (await act("del", () => api.del(url), ok)) await loadDetail(detail!.principal.id);
  }
  // Deleting a user: personal content goes, the rest of their vaults passes to a team
  let deleting = $state(false);
  let allTeams = $state<PrincipalView[]>([]);
  let heir = $state("");
  async function startDelete() {
    deleting = true;
    heir = detail?.teams.length === 1 ? detail.teams[0]!.id : "";
    if (kind === "user") allTeams = (await api.get<{ items: PrincipalView[] }>(`/api/admin/principals${qs({ kind: "team", limit: 500 })}`)).items;
  }
  async function remove() {
    const p = detail!.principal;
    if (prompt(t("Eliminare definitivamente {displayName}? Scrivi il nome account ({name}) per confermare.", { displayName: p.displayName, name: p.name })) !== p.name) return;
    if (await act("remove", () => api.del(`/api/admin/principals/${p.id}${heir ? qs({ team: heir }) : ""}`), t("Account eliminato."))) {
      deleting = false;
      select(undefined);
      await load();
    }
  }
  const toggleScope = (list: string[], s: string) => (list.includes(s) ? list.filter((x) => x !== s) : [...list, s]);
</script>

<div class="adm">
  <header class="adm-head">
    <div>
      <p class="eyebrow you">{t("Console")}</p>
      <h1>{kind === "user" ? t("Utenti") : t("Account API")}</h1>
      <p>
        {kind === "user"
          ? t("Le persone che usano la memoria. Ogni utente accede con l'app di autenticazione (TOTP), una passkey o una chiave di firma.")
          : t("Gli account delle applicazioni e dell'agente cloud. Ogni chiave si vede una sola volta; per ruotarla, creane una nuova e revoca la vecchia.")}
      </p>
    </div>
    <div class="adm-bar">
      <input class="input" type="search" placeholder={t("Cerca per nome")} aria-label={t("Cerca")} bind:value={q} bind:this={searchEl} />
      <Button variant="primary" onclick={() => (creating = !creating)}>{kind === "user" ? t("Nuovo utente") : t("Nuovo account API")}</Button>
    </div>
  </header>
  <Explain id={`admin-${section}`} text={EXPLAIN_ADMIN[section]!} />

  {#if secret}
    <div class="secret" role="status">
      <strong>{secret.title}</strong>
      <code>{secret.link ?? secret.value}</code>
      <span class="dim">{secret.note}</span>
      <div class="adm-bar">
        <Button size="sm" variant="primary" onclick={async () => ui.toast((await copy(secret!.link ?? secret!.value)) ? t("Copiato.") : t("Copia non riuscita: seleziona il testo."), "info")}>{t("Copia")}</Button>
        {#if secret.link}<Button size="sm" onclick={async () => ui.toast((await copy(secret!.value)) ? t("Codice copiato.") : t("Copia non riuscita."), "info")}>{t("Copia solo il codice")}</Button>{/if}
        <Button size="sm" variant="quiet" onclick={() => (secret = null)}>{t("Ho salvato, nascondi")}</Button>
      </div>
    </div>
  {/if}

  {#if creating}
    <form class="adm-card" onsubmit={(e) => (e.preventDefault(), create())}>
      <h2>{kind === "user" ? t("Nuovo utente") : t("Nuovo account API")}</h2>
      {#if kind === "user"}
        <div class="adm-form">
          <label class="field"><span class="label">{t("Nome account")}</span><input class="input" required pattern="[a-z0-9._\-]+" bind:value={nu.username} placeholder={t("nome.cognomeddd")} /></label>
          <label class="field"><span class="label">{t("Nome visibile")}</span><input class="input" bind:value={nu.displayName} placeholder={t("Nome CognomeDDD")} /></label>
          <label class="field"><span class="label">{t("Email (facoltativa)")}</span><input class="input" type="email" bind:value={nu.email} /></label>
          <label class="field"><span class="label">{t("Ruolo")}</span><select class="input" bind:value={nu.role}>{#each Object.entries(USER_ROLE_LABEL) as [v, l] (v)}<option value={v}>{l}</option>{/each}</select></label>
          <label class="field"><span class="label">{t("Può leggere")}</span><select class="input" bind:value={nu.clearance}>{#each CLASSIFICATIONS as c, i (c)}<option value={i}>{t("fino a {c}", { c })}</option>{/each}</select></label>
        </div>
      {:else}
        <div class="adm-form">
          <label class="field"><span class="label">{t("Nome account")}</span><input class="input" required pattern="[a-z0-9._\-]+" bind:value={na.name} placeholder={t("agente-commerciale")} /></label>
          <label class="field"><span class="label">{t("Descrizione")}</span><input class="input" bind:value={na.displayName} /></label>
          <div class="field">
            <label class="label" for="na-user">{t("Agisce per l'utente (facoltativo)")}</label>
            <Combobox id="na-user" bind:value={na.userId} bind:text={na.userText} search={searchUsers} placeholder={t("Nome, utente o email")} />
            {#if na.userText.trim() && !na.userId}<span class="msg error">{t("Scegli l'utente tra i suggerimenti.")}</span>{/if}
          </div>
          <label class="field"><span class="label">{t("Può leggere")}</span><select class="input" bind:value={na.clearance}>{#each CLASSIFICATIONS as c, i (c)}<option value={i}>{t("fino a {c}", { c })}</option>{/each}</select></label>
          <label class="field"><span class="label">{t("Scade il (facoltativo)")}</span><input class="input" type="date" bind:value={na.expires} /></label>
          <label class="field"><span class="label">{t("Indirizzi ammessi (facoltativo)")}</span><input class="input" bind:value={na.ips} placeholder="192.168.1.0/24, 10.0.0.5" /></label>
          <label class="field"><span class="label">{t("Richieste al minuto")}</span><input class="input" type="number" min="1" bind:value={na.rate} placeholder={t("predefinito")} /></label>
        </div>
        <fieldset class="scopes">
          <legend class="dim">{t("Permessi della chiave")}</legend>
          {#each Object.entries(SCOPE_LABEL) as [s, l] (s)}
            <button type="button" class="chip" role="checkbox" aria-checked={na.scopes.includes(s)} onclick={() => (na.scopes = toggleScope(na.scopes, s))}>{l}</button>
          {/each}
        </fieldset>
        <p class="notice agent">{t("Per l'agente cloud bastano lettura e un livello fino a «interno»: il server MCP non consegna mai pagine riservate o segrete.")}</p>
        <p class="notice agent">{t("Una chiave legata a un utente non supera mai i suoi permessi, e i suoi vault personali restano fuori. Per un agente di programmazione bastano lettura e documentazione dei progetti.")}</p>
      {/if}
      <div class="adm-bar">
        <Button variant="primary" type="submit" busy={busy === "create"}>{t("Crea")}</Button>
        <Button variant="quiet" type="button" onclick={() => (creating = false)}>{t("Annulla")}</Button>
      </div>
    </form>
  {/if}

  {#if error}
    <p class="notice error">{error}</p>
  {:else if !items}
    <span class="skeleton" style="height:12rem"></span>
  {:else}
    <div class="split" class:open={!!detail}>
      <div class="adm-scroll">
        <table class="adm-table">
          <thead>
            <tr>
              <th>{t("Nome")}</th>
              <th>{kind === "user" ? t("Ruolo") : t("Permessi")}</th>
              <th>{t("Livello")}</th>
              <th>{t("Stato")}</th>
              <th>{t("Ultimo accesso")}</th>
              <th><span class="visually-hidden">{t("Azioni")}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each items as p (p.id)}
              <tr class:sel={p.id === selected}>
                <td>
                  <button class="link" data-id={p.id} onclick={() => select(p.id === selected ? undefined : p.id)}>{p.displayName}</button>
                  <div class="dim mono">{p.name}</div>
                </td>
                <td>{kind === "user" ? ROLE_LABEL[p.role] : p.scopes.map((s) => SCOPE_LABEL[s]).join(", ")}</td>
                <td>{valueLabel(CLASSIFICATIONS[p.clearance])}</td>
                <td><span class="badge {p.status === 'active' ? 'idle' : 'alert'}">{p.status === "active" ? t("attivo") : t("sospeso")}</span></td>
                <td class="dim">{p.lastSeenAt ? ago(p.lastSeenAt) : t("mai")}</td>
                <td class="acts"><Button size="sm" variant={p.id === selected ? "secondary" : "quiet"} aria-expanded={p.id === selected} onclick={() => select(p.id === selected ? undefined : p.id)}>{p.id === selected ? t("Chiudi") : t("Modifica")}</Button></td>
              </tr>
            {:else}
              <tr><td colspan="6" class="dim">{t("Nessun account{x}.", { x: q ? t(" per «{q}»", { q }) : "" })}</td></tr>
            {/each}
          </tbody>
        </table>
        {#if total > items.length}<p class="dim more">{t("Mostrati {n} di {total}: affina la ricerca.", { n: items.length, total })}</p>{/if}
      </div>

      {#if detail && form}
        {@const p = detail.principal}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Esc inside the panel closes it) -->
        <aside class="adm-card detail" aria-label={t("Dettaglio account")} bind:this={panel} onkeydown={(e) => e.key === "Escape" && (e.stopPropagation(), closeDetail(p.id))}>
          <header class="dh">
            <div>
              <h2>{p.displayName}</h2>
              <span class="dim mono">{p.name}</span>
            </div>
            <button class="icon-btn" aria-label={t("Chiudi il dettaglio")} onclick={() => closeDetail(p.id)}>×</button>
          </header>
          <div class="adm-form">
            <label class="field"><span class="label">{t("Nome visibile")}</span><input class="input" bind:value={form.displayName} /></label>
            {#if kind === "user"}
              <label class="field"><span class="label">{t("Email")}</span><input class="input" type="email" bind:value={form.email} /></label>
              <label class="field"><span class="label">{t("Ruolo")}</span><select class="input" bind:value={form.role} disabled={p.id === session.me?.principal.id}>{#each Object.entries(USER_ROLE_LABEL) as [v, l] (v)}<option value={v}>{l}</option>{/each}</select></label>
            {:else}
              <label class="field"><span class="label">{t("Scade il")}</span><input class="input" type="date" bind:value={form.expires} /></label>
              <label class="field"><span class="label">{t("Indirizzi ammessi")}</span><input class="input" bind:value={form.ips} placeholder={t("tutti")} /></label>
              <label class="field"><span class="label">{t("Richieste al minuto")}</span><input class="input" type="number" min="1" bind:value={form.ratePerMin} placeholder={t("predefinito")} /></label>
            {/if}
            <label class="field"><span class="label">{t("Può leggere")}</span><select class="input" bind:value={form.clearance}>{#each CLASSIFICATIONS as c, i (c)}<option value={i}>{t("fino a {c}", { c })}</option>{/each}</select></label>
          </div>
          {#if kind === "api"}
            <p class="dim">{detail.actsFor ? t("Agisce per {name}", { name: `${detail.actsFor.displayName} (${detail.actsFor.name})` }) : t("Non è legata a un utente: valgono solo i suoi permessi.")}</p>
            <div class="scopes">
              {#each Object.entries(SCOPE_LABEL) as [s, l] (s)}
                <button type="button" class="chip" role="checkbox" aria-checked={form.scopes.includes(s as never)} onclick={() => (form!.scopes = toggleScope(form!.scopes, s) as never)}>{l}</button>
              {/each}
            </div>
          {/if}
          <div class="adm-bar">
            <Button variant="primary" size="sm" busy={busy === "save"} onclick={save}>{t("Salva")}</Button>
            {#if p.status === "active"}
              <Button size="sm" disabled={p.id === session.me?.principal.id} onclick={() => setStatus("suspended")}>{t("Sospendi")}</Button>
            {:else}
              <Button size="sm" onclick={() => setStatus("active")}>{t("Riattiva")}</Button>
            {/if}
            <Button size="sm" variant="quiet" onclick={() => ws.open({ kind: "admin", section: "audit", id: p.id })}>{t("Attività")}</Button>
            <Button size="sm" variant="danger" disabled={p.id === session.me?.principal.id} onclick={() => (kind === "user" ? startDelete() : remove())}>{t("Elimina")}</Button>
          </div>
          {#if deleting && kind === "user"}
            <section class="notice warn delete" aria-label={t("Eliminazione dell'account")}>
              <p>{t("Con l'account vengono cancellati i suoi contenuti «personale»: pagine, documenti e file originali. Nessuno li può leggere, nemmeno gli amministratori. Il resto dei suoi vault passa al team che scegli qui; un vault senza altro contenuto viene cancellato. I dati cancellati restano nelle copie di backup fino alla loro scadenza.")}</p>
              <label class="field">
                <span class="label">{t("Team che riceve i contenuti non personali")}</span>
                <select class="input" bind:value={heir}>
                  <option value="">{t("Il suo unico team")}</option>
                  {#each allTeams as x (x.id)}<option value={x.id}>{x.displayName}{detail.teams.some((m) => m.id === x.id) ? t(" (membro)") : ""}</option>{/each}
                </select>
              </label>
              <div class="adm-bar">
                <Button size="sm" variant="danger" busy={busy === "remove"} onclick={remove}>{t("Elimina definitivamente")}</Button>
                <Button size="sm" variant="quiet" onclick={() => (deleting = false)}>{t("Annulla")}</Button>
              </div>
            </section>
          {/if}

          <dl class="kv">
            <dt>{t("Creato")}</dt><dd>{when(p.createdAt)}</dd>
            <dt>{t("Livello")}</dt><dd>{clearanceLabel(p.clearance)}</dd>
            {#if kind === "user"}
              <dt>{t("Team")}</dt><dd>{detail.teams.length ? detail.teams.map((x) => x.displayName).join(", ") : t("nessuno")}</dd>
              <dt>{t("Autenticazione")}</dt>
              <dd>{detail.totp ? t("app attiva · {recoveryCodesLeft} codici di recupero", { recoveryCodesLeft: detail.recoveryCodesLeft }) : t("da attivare")}</dd>
            {/if}
          </dl>

          {#if kind === "user"}
            <section>
              <h3>{t("Accesso")}</h3>
              <div class="adm-bar">
                <Button size="sm" busy={busy === "totp"} onclick={resetTotp}>{t("Azzera l'autenticazione")}</Button>
                <Button size="sm" busy={busy === "sessions"} disabled={!detail.sessions.length} onclick={revokeSessions}>{t("Chiudi tutte le sessioni")}</Button>
              </div>
            </section>
            <section>
              <h3>{t("Passkey")}</h3>
              <ul class="creds">
                {#each detail.passkeys as k (k.id)}
                  <li><span>{k.name ?? t("Passkey")} <span class="dim">· {k.deviceType} · {k.lastUsedAt ? t("usata {lastUsedAt}", { lastUsedAt: ago(k.lastUsedAt) }) : t("mai usata")}</span></span>
                    <Button size="sm" variant="quiet" onclick={() => del(`/api/admin/principals/${p.id}/passkeys/${k.id}`, t("Rimuovere questa passkey?"), t("Passkey rimossa."))}>{t("Rimuovi")}</Button></li>
                {:else}<li class="dim">{t("Nessuna passkey.")}</li>{/each}
              </ul>
            </section>
            <section>
              <h3>{t("Chiavi di firma")}</h3>
              <ul class="creds">
                {#each detail.publicKeys.filter((k) => !k.revokedAt) as k (k.id)}
                  <li><span>{k.name ?? k.kind} <span class="dim mono">{k.fingerprint.slice(0, 23)}…</span></span>
                    <Button size="sm" variant="quiet" onclick={() => del(`/api/admin/principals/${p.id}/public-keys/${k.id}`, t("Revocare questa chiave?"), t("Chiave revocata."))}>{t("Revoca")}</Button></li>
                {:else}<li class="dim">{t("Nessuna chiave.")}</li>{/each}
              </ul>
            </section>
          {:else}
            <section>
              <h3>{t("Chiavi")}</h3>
              <ul class="creds">
                {#each detail.apiKeys as k (k.id)}
                  <li class:revoked={!!k.revokedAt}>
                    <span>{k.name} <span class="dim">{t("· creata {createdAt} · {x}{x2}", { createdAt: ago(k.createdAt), x: k.revokedAt ? "revocata" : k.lastUsedAt ? `usata ${ago(k.lastUsedAt)}` : t("mai usata"), x2: k.expiresAt ? ` · scade ${when(k.expiresAt)}` : "" })}</span></span>
                    {#if !k.revokedAt}<Button size="sm" variant="quiet" onclick={() => del(`/api/admin/principals/${p.id}/api-keys/${k.id}`, t("Revocare la chiave «{name}»? I client che la usano smettono di funzionare.", { name: k.name }), t("Chiave revocata."))}>{t("Revoca")}</Button>{/if}
                  </li>
                {:else}<li class="dim">{t("Nessuna chiave.")}</li>{/each}
              </ul>
              <Button size="sm" busy={busy === "key"} onclick={issueKey}>{t("Nuova chiave (rotazione)")}</Button>
            </section>
          {/if}

          {#if detail.sessions.length}
            <section>
              <h3>{t("Sessioni aperte")}</h3>
              <ul class="creds">
                {#each detail.sessions as s (s.id)}
                  <li><span>{s.method} <span class="dim">{t("· {x} · attiva {lastSeenAt}", { x: s.ip ?? "?", lastSeenAt: ago(s.lastSeenAt) })}</span></span>
                    <Button size="sm" variant="quiet" onclick={() => del(`/api/admin/sessions/${s.id}`, t("Chiudere questa sessione?"), t("Sessione chiusa."))}>{t("Chiudi")}</Button></li>
                {/each}
              </ul>
            </section>
          {/if}

          <section>
            <h3>{t("Permessi sui vault")}</h3>
            <ul class="creds">
              {#each detail.grants as g (g.vaultId)}
                <li><span>{g.name} <span class="dim mono">{g.slug}</span></span><span class="badge">{PERMISSION_LABEL[g.permission]}</span></li>
              {:else}<li class="dim">{t("Nessun permesso: vede solo i propri vault.")}</li>{/each}
            </ul>
            <Button size="sm" variant="quiet" onclick={() => ws.open({ kind: "admin", section: "permessi", id: detail!.principal.id })}>{t("Modifica i permessi")}</Button>
          </section>
        </aside>
      {/if}
    </div>
  {/if}
</div>

<style>
  .split {
    display: grid;
    gap: 1rem;
    align-items: start;
  }
  .split.open {
    grid-template-columns: minmax(0, 1fr) minmax(20rem, 27rem);
  }
  .more {
    padding: 0.5rem 0.7rem;
    font-size: var(--fs-xs);
  }
  .scopes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    border: 0;
    align-items: center;
  }
  .scopes legend {
    font-size: var(--fs-xs);
    margin-bottom: 0.3rem;
  }
  .detail {
    position: sticky;
    top: 0;
  }
  .delete {
    display: block;
    margin: 0.75rem 0;
  }
  .dh {
    display: flex;
    justify-content: space-between;
    align-items: start;
  }
  .detail h3 {
    font-size: var(--fs-sm);
    margin-bottom: 0.4rem;
  }
  .creds {
    list-style: none;
    display: grid;
    gap: 0.15rem;
    font-size: var(--fs-sm);
    margin-bottom: 0.4rem;
  }
  .creds li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0;
  }
  .creds li.revoked {
    opacity: 0.55;
  }
  @media (max-width: 1100px) {
    .split.open {
      grid-template-columns: 1fr;
    }
    .detail {
      position: static;
    }
  }
</style>
