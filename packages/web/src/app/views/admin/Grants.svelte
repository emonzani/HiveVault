<script lang="ts">
  // Permissions (plan §8.3), one account or one vault at a time: a searchable list on the left,
  // the grants of the chosen one on the right. Only the grants that exist are loaded, so the
  // page stays the same with 10 or 10 000 accounts and vaults. Every change is audited.
  import { untrack } from "svelte";
  import Button from "../../../components/Button.svelte";
  import Combobox, { type ComboOption } from "../../../components/Combobox.svelte";
  import Explain from "../../../components/Explain.svelte";
  import VirtualList from "../../../components/VirtualList.svelte";
  import { EXPLAIN_ADMIN } from "../../../lib/explain.ts";
  import { api, qs, request } from "../../../lib/api.ts";
  import { PERMISSION_LABEL, ROLE_LABEL, type AdminVault, type Permission, type PrincipalView } from "../../../lib/admin.ts";
  import { ui } from "../../../lib/ui.svelte.ts";
  import { ws } from "../../../lib/workspace.svelte.ts";
  import { t } from "../../../lib/i18n.ts";
  import { tablist } from "../../../lib/tablist.ts";

  interface Grant {
    principalId: string;
    vaultId: string;
    permission: Permission;
    principalName: string;
    principalKind: "user" | "api" | "team";
    principalRole: string;
    vaultName: string;
    vaultSlug: string;
    vaultKind: "cell" | "space";
  }

  let { selected }: { selected?: string } = $props();

  const PAGE = 100;
  const KIND_LABEL = { cell: t("cella"), space: t("alveare") };
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // the vault list is one request (names and counts only); accounts are searched on the server
  let vaults = $state<AdminVault[] | null>(null);
  let error = $state("");
  $effect(() => {
    api.get<AdminVault[]>("/api/admin/vaults").then((v) => (vaults = v), (e: Error) => (error = e.message));
  });

  let mode = $state<"account" | "vault">(untrack(() => selected)?.startsWith("vlt_") ? "vault" : "account");
  let q = $state("");
  let pkind = $state<"user" | "team" | "api" | "">("");
  let vkind = $state<"cell" | "space" | "">("");

  // --- accounts, paged ----------------------------------------------------------------------
  let accounts = $state<PrincipalView[]>([]);
  let total = $state(0);
  let loadingMore = false;
  let gen = 0;
  async function loadAccounts(reset: boolean) {
    if (!reset && (loadingMore || accounts.length >= total)) return;
    const my = reset ? ++gen : gen;
    loadingMore = true;
    try {
      const r = await api.get<{ items: PrincipalView[]; total: number }>(
        `/api/admin/principals${qs({ q: q.trim() || undefined, kind: pkind || undefined, limit: PAGE, offset: reset ? 0 : accounts.length })}`,
      );
      if (my !== gen) return;
      accounts = reset ? r.items : [...accounts, ...r.items];
      total = r.total;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loadingMore = false;
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (mode !== "account") return;
    void q;
    void pkind;
    clearTimeout(timer);
    timer = setTimeout(() => void loadAccounts(true), q ? 150 : 0);
    return () => clearTimeout(timer);
  });

  const vaultRows = $derived((vaults ?? []).filter((v) => (!vkind || v.kind === vkind) && (!q.trim() || fold(`${v.name} ${v.slug}`).includes(fold(q.trim())))));

  const pick = (id: string) => ws.open({ kind: "admin", section: "permessi", id });
  function switchMode(m: "account" | "vault") {
    if (m === mode) return;
    mode = m;
    q = "";
  }

  // --- the chosen account or vault --------------------------------------------------------------
  // the detail follows the selection, not the list on the left
  const side = $derived<"account" | "vault">(selected?.startsWith("vlt_") ? "vault" : "account");
  let account = $state<PrincipalView | null>(null);
  const vault = $derived(selected?.startsWith("vlt_") ? (vaults?.find((v) => v.id === selected) ?? null) : null);
  let grants = $state<Grant[] | null>(null);

  async function loadGrants() {
    const id = selected;
    if (!id) return void (grants = null);
    const r = await api.get<Grant[]>(`/api/admin/grants${qs(id.startsWith("vlt_") ? { vaultId: id } : { principalId: id })}`);
    if (id === selected) grants = r;
  }
  $effect(() => {
    const id = selected;
    grants = null;
    account = null;
    if (!id) return;
    if (!id.startsWith("vlt_")) api.get<{ principal: PrincipalView }>(`/api/admin/principals/${id}`).then((d) => id === selected && (account = d.principal), (e: Error) => (error = e.message));
    loadGrants().catch((e: Error) => (error = e.message));
  });

  const ownedCells = $derived(account ? (vaults ?? []).filter((v) => v.owner === `user:${account!.id}`) : []);
  const isAdmin = $derived(account?.kind === "user" && account.role === "admin");

  let busy = $state("");
  async function setGrant(principalId: string, vaultId: string, permission: Permission | "") {
    busy = `${principalId}|${vaultId}`;
    try {
      if (permission) await api.put("/api/admin/grants", { principalId, vaultId, permission });
      else await request("DELETE", `/api/admin/grants/${principalId}/${vaultId}`);
      await loadGrants();
      vaults = vaults && (await api.get<AdminVault[]>("/api/admin/vaults"));
      return true;
    } catch (e) {
      ui.toast((e as Error).message, "error");
      return false;
    } finally {
      busy = "";
    }
  }

  // --- adding a grant: the other side is picked with a search ------------------------------------
  let addId = $state("");
  let addText = $state("");
  let addPerm = $state<Permission>("read");
  const granted = $derived(new Set((grants ?? []).map((g) => (side === "account" ? g.vaultId : g.principalId))));
  const searchVaults = async (s: string): Promise<ComboOption[]> =>
    (vaults ?? [])
      .filter((v) => !granted.has(v.id) && v.owner !== `user:${selected}` && v.owner !== `team:${selected}` && fold(`${v.name} ${v.slug}`).includes(fold(s)))
      .slice(0, 20)
      .map((v) => ({ value: v.id, label: v.name, hint: `${KIND_LABEL[v.kind]} · ${v.slug}` }));
  const searchAccounts = async (s: string, signal: AbortSignal): Promise<ComboOption[]> => {
    const r = await api.get<{ items: PrincipalView[] }>(`/api/admin/principals${qs({ q: s, limit: 20 })}`, { signal });
    return r.items
      .filter((p) => !granted.has(p.id) && !(p.kind === "user" && p.role === "admin") && vault?.owner !== `user:${p.id}` && vault?.owner !== `team:${p.id}`)
      .map((p) => ({ value: p.id, label: p.displayName, hint: p.kind === "api" ? t("account API") : p.kind === "team" ? t("team") : p.name }));
  };
  async function add() {
    if (!addId || !selected) return ui.toast(side === "account" ? t("Scegli un vault tra i suggerimenti.") : t("Scegli un account tra i suggerimenti."), "error");
    const ok = side === "account" ? await setGrant(selected, addId, addPerm) : await setGrant(addId, selected, addPerm);
    if (ok) {
      ui.toast(t("Permesso aggiunto."), "ok");
      addId = "";
      addText = "";
    }
  }
</script>

<div class="adm">
  <header class="adm-head">
    <div>
      <p class="eyebrow you">{t("Console")}</p>
      <h1>{t("Permessi")}</h1>
      <p>{t("Chi può leggere, scrivere o curare ogni vault. Gli amministratori vedono tutto; ogni persona vede sempre la propria cella. Il livello dell'account limita comunque le pagine riservate e segrete.")}</p>
    </div>
  </header>
  <Explain id="admin-permessi" text={EXPLAIN_ADMIN["permessi"]!} />

  {#if error}<p class="notice error">{error}</p>{/if}

  <div class="split">
    <section class="pick adm-card" aria-label={mode === "account" ? t("Account") : t("Vault")}>
      <div class="seg" role="tablist" use:tablist aria-label={t("Parti da")}>
        <button role="tab" aria-selected={mode === "account"} onclick={() => switchMode("account")}>{t("Per account")}</button>
        <button role="tab" aria-selected={mode === "vault"} onclick={() => switchMode("vault")}>{t("Per vault")}</button>
      </div>
      <div class="filters">
        <input class="input" type="search" placeholder={mode === "account" ? t("Nome, utente o email") : t("Nome o identificativo")} aria-label={mode === "account" ? t("Cerca un account") : t("Cerca un vault")} bind:value={q} />
        {#if mode === "account"}
          <select class="input" aria-label={t("Tipo di account")} bind:value={pkind}><option value="">{t("Tutti")}</option><option value="user">{t("Utenti")}</option><option value="team">{t("Team")}</option><option value="api">{t("Account API")}</option></select>
        {:else}
          <select class="input" aria-label={t("Tipo di vault")} bind:value={vkind}><option value="">{t("Tutti")}</option><option value="cell">{t("Celle")}</option><option value="space">{t("Alveare")}</option></select>
        {/if}
      </div>

      {#if mode === "account"}
        <p class="count dim">{t("{total} account{x}", { total, x: q ? " trovati" : "" })}</p>
        {#if accounts.length}
          <VirtualList items={accounts} rowHeight={46} maxHeight={520} label={t("Account")} onend={() => void loadAccounts(false)}>
            {#snippet row(p: PrincipalView)}
              <button class="item" class:on={p.id === selected} aria-current={p.id === selected ? "true" : undefined} onclick={() => pick(p.id)}>
                <span class="nm">{p.displayName}</span>
                <span class="dim sub">{p.kind === "api" ? t("account API") : `${p.name} · ${ROLE_LABEL[p.role]}`}</span>
              </button>
            {/snippet}
          </VirtualList>
        {:else}
          <p class="dim none">{t("Nessun account.")}</p>
        {/if}
      {:else if !vaults}
        <span class="skeleton" style="height:12rem"></span>
      {:else}
        <p class="count dim">{t("{n} vault", { n: vaultRows.length })}</p>
        {#if vaultRows.length}
          <VirtualList items={vaultRows} rowHeight={46} maxHeight={520} label={t("Vault")}>
            {#snippet row(v: AdminVault)}
              <button class="item" class:on={v.id === selected} aria-current={v.id === selected ? "true" : undefined} onclick={() => pick(v.id)}>
                <span class="nm">{v.name}</span>
                <span class="dim sub">{v.grants === 1 ? t("{x} · {grants} permesso", { x: KIND_LABEL[v.kind], grants: v.grants }) : t("{x} · {grants} permessi", { x: KIND_LABEL[v.kind], grants: v.grants })}</span>
              </button>
            {/snippet}
          </VirtualList>
        {:else}
          <p class="dim none">{t("Nessun vault.")}</p>
        {/if}
      {/if}
    </section>

    <section class="adm-card detail" aria-live="polite">
      {#if !selected}
        <div class="empty"><p>{t("Scegli {x} a sinistra per vedere e cambiare i suoi permessi.", { x: mode === "account" ? t("un account") : t("un vault") })}</p></div>
      {:else if side === "account" && (!account || !grants)}
        <span class="skeleton" style="height:10rem"></span>
      {:else if side === "vault" && (!vault || !grants)}
        {#if vaults && !vault}<p class="dim">{t("Vault non trovato.")}</p>{:else}<span class="skeleton" style="height:10rem"></span>{/if}
      {:else}
        <header class="dh">
          {#if side === "account" && account}
            <h2>{account.displayName}</h2>
            <p class="dim">{account.kind === "api" ? t("Account API") : `${account.name} · ${ROLE_LABEL[account.role]}`}
              · <button class="link" onclick={() => ws.open({ kind: "admin", section: account!.kind === "user" ? "utenti" : account!.kind === "team" ? "team" : "api", id: account!.id })}>{t("scheda dell'account")}</button></p>
          {:else if vault}
            <h2>{vault.name}</h2>
            <p class="dim">{KIND_LABEL[vault.kind]} · <span class="mono">{vault.slug}</span>
              · <button class="link" onclick={() => ws.open({ kind: "admin", section: "vault", id: vault.id })}>{t("scheda del vault")}</button></p>
          {/if}
        </header>

        {#if isAdmin}
          <p class="notice">{t("Amministratore: vede e amministra tutti i vault. I permessi sotto non cambiano niente finché resta amministratore.")}</p>
        {/if}

        <table class="adm-table">
          <thead><tr><th>{side === "account" ? t("Vault") : t("Account")}</th><th>{t("Permesso")}</th><th><span class="visually-hidden">{t("Azioni")}</span></th></tr></thead>
          <tbody>
            {#if side === "account"}
              {#each ownedCells as v (v.id)}
                <tr><td>{v.name} <span class="dim">{t("cella propria")}</span></td><td><span class="badge">{t("Proprietario")}</span></td><td></td></tr>
              {/each}
            {:else if vault?.owner}
              <tr><td>{vault.ownerLabel ?? vault.owner}</td><td><span class="badge">{t("Proprietario")}</span></td><td></td></tr>
            {/if}
            {#each grants as g (`${g.principalId}|${g.vaultId}`)}
              {@const k = `${g.principalId}|${g.vaultId}`}
              {@const name = side === "account" ? g.vaultName : g.principalName}
              <tr>
                <td>{name} <span class="dim">{side === "account" ? KIND_LABEL[g.vaultKind] : g.principalKind === "api" ? t("account API") : ROLE_LABEL[g.principalRole]}</span></td>
                <td>
                  <select class="input perm" aria-label={t("Permesso su {name}", { name })} value={g.permission} disabled={busy === k}
                    onchange={async (e) => { const el = e.currentTarget; if (!(await setGrant(g.principalId, g.vaultId, el.value as Permission))) el.value = g.permission; }}>
                    {#each Object.entries(PERMISSION_LABEL) as [p, l] (p)}<option value={p}>{l}</option>{/each}
                  </select>
                </td>
                <td class="acts"><Button size="sm" variant="quiet" busy={busy === k} aria-label={t("Togli il permesso su {name}", { name })} onclick={() => setGrant(g.principalId, g.vaultId, "")}>{t("Togli")}</Button></td>
              </tr>
            {:else}
              {#if !(side === "account" ? ownedCells.length : vault?.owner)}
                <tr><td colspan="3" class="dim">{t("Nessun permesso.{x}", { x: side === "vault" ? t(" Lo vedono solo gli amministratori.") : "" })}</td></tr>
              {/if}
            {/each}
          </tbody>
        </table>

        <form class="add" onsubmit={(e) => (e.preventDefault(), add())}>
          <h3>{t("Aggiungi un permesso")}</h3>
          <div class="adm-form">
            <div class="field">
              <label class="label" for="grant-add">{side === "account" ? t("Vault") : t("Account")}</label>
              {#key `${side}|${selected}`}
                <Combobox id="grant-add" bind:value={addId} bind:text={addText} search={side === "account" ? searchVaults : searchAccounts} minChars={side === "account" ? 0 : 2} placeholder={side === "account" ? t("Nome del vault") : t("Nome, utente o email")} />
              {/key}
            </div>
            <label class="field"><span class="label">{t("Permesso")}</span>
              <select class="input" bind:value={addPerm}>{#each Object.entries(PERMISSION_LABEL) as [p, l] (p)}<option value={p}>{l}</option>{/each}</select>
            </label>
            <div><Button variant="primary" type="submit" busy={busy !== ""}>{t("Aggiungi")}</Button></div>
          </div>
        </form>
      {/if}
    </section>
  </div>
</div>

<style>
  .split {
    display: grid;
    grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr);
    gap: 0.9rem;
    align-items: start;
  }
  @media (max-width: 760px) {
    .split {
      grid-template-columns: 1fr;
    }
  }
  .pick {
    gap: 0.6rem;
  }
  .seg {
    display: flex;
    gap: 0.25rem;
    padding: 0.2rem;
    border-radius: var(--r-control);
    background: var(--ink-2);
  }
  .seg button {
    flex: 1;
    padding: 0.3rem 0.8rem;
    border: 0;
    border-radius: 6px;
    background: none;
    cursor: pointer;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .seg button[aria-selected="true"] {
    background: var(--ink-1);
    color: var(--text-main);
  }
  .filters {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.4rem;
  }
  .count {
    font-size: var(--fs-xs);
  }
  .none {
    font-size: var(--fs-sm);
  }
  .item {
    display: grid;
    width: 100%;
    height: 100%;
    padding: 0.3rem 0.55rem;
    border: 0;
    border-radius: 6px;
    background: none;
    text-align: left;
    cursor: pointer;
    align-content: center;
  }
  .item:hover {
    background: var(--ink-2);
  }
  .item.on {
    background: var(--you-soft);
    color: var(--you-ink);
  }
  .nm,
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: var(--fs-xs);
  }
  .item.on .sub {
    color: inherit;
  }
  .detail {
    min-height: 12rem;
  }
  .dh h2 {
    font-size: var(--fs-lg);
  }
  .dh .link {
    border: 0;
    background: none;
    padding: 0;
    font: inherit;
    color: var(--you-ink);
    text-decoration: underline;
    cursor: pointer;
  }
  .perm {
    width: auto;
    padding: 0.25rem 0.5rem;
  }
  .acts {
    text-align: right;
  }
  .add {
    display: grid;
    gap: 0.5rem;
    border-top: 1px solid var(--line);
    padding-top: 0.75rem;
  }
  .add h3 {
    font-size: var(--fs-md);
  }
</style>
