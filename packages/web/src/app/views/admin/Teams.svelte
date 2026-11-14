<script lang="ts">
  // Teams: groups of users. A grant to a team reaches its members; a vault owned by a team is
  // writable by them; a deleted user's non-personal content goes to one of their teams.
  import Explain from "../../../components/Explain.svelte";
  import Button from "../../../components/Button.svelte";
  import { api, qs } from "../../../lib/api.ts";
  import type { PrincipalView } from "../../../lib/admin.ts";
  import { EXPLAIN_ADMIN } from "../../../lib/explain.ts";
  import { when } from "../../../lib/format.ts";
  import { ui } from "../../../lib/ui.svelte.ts";
  import { ws } from "../../../lib/workspace.svelte.ts";
  import { t } from "../../../lib/i18n.ts";

  let { selected }: { selected?: string } = $props();

  interface Member {
    id: string;
    name: string;
    displayName: string;
    addedAt: string;
  }

  let teams = $state<PrincipalView[] | null>(null);
  let error = $state("");
  let creating = $state(false);
  let nt = $state({ name: "", displayName: "" });
  let members = $state<Member[] | null>(null);
  let who = $state("");
  let found = $state<PrincipalView[]>([]);
  let busy = $state("");

  async function load() {
    try {
      teams = (await api.get<{ items: PrincipalView[] }>(`/api/admin/principals${qs({ kind: "team", limit: 500 })}`)).items;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  async function loadMembers(id: string) {
    try {
      members = await api.get<Member[]>(`/api/admin/teams/${id}/members`);
    } catch (e) {
      ui.toast((e as Error).message, "error");
      members = null;
    }
  }
  $effect(() => void load());
  $effect(() => {
    if (selected) void loadMembers(selected);
    else members = null;
  });
  const select = (id: string | undefined) => ws.open({ kind: "admin", section: "team", ...(id ? { id } : {}) });
  const team = $derived(teams?.find((x) => x.id === selected) ?? null);

  let timer: ReturnType<typeof setTimeout>;
  $effect(() => {
    const q = who.trim();
    clearTimeout(timer);
    if (!q) {
      found = [];
      return;
    }
    timer = setTimeout(async () => {
      found = (await api.get<{ items: PrincipalView[] }>(`/api/admin/principals${qs({ kind: "user", q, limit: 8 })}`)).items.filter((u) => !members?.some((m) => m.id === u.id));
    }, 200);
  });

  async function run(key: string, fn: () => Promise<unknown>, ok: string): Promise<boolean> {
    busy = key;
    try {
      await fn();
      ui.toast(ok, "ok");
      return true;
    } catch (e) {
      ui.toast((e as Error).message, "error");
      return false;
    } finally {
      busy = "";
    }
  }

  async function create() {
    const name = nt.name.trim();
    if (await run("create", () => api.post("/api/admin/teams", { name, ...(nt.displayName.trim() ? { displayName: nt.displayName.trim() } : {}) }), t("Team creato."))) {
      nt = { name: "", displayName: "" };
      creating = false;
      await load();
    }
  }
  async function add(u: PrincipalView) {
    if (await run("add", () => api.put(`/api/admin/teams/${selected}/members/${u.id}`, {}), t("{x} aggiunto al team.", { x: u.displayName }))) {
      who = "";
      await loadMembers(selected!);
    }
  }
  async function removeMember(m: Member) {
    if (await run(`rm-${m.id}`, () => api.del(`/api/admin/teams/${selected}/members/${m.id}`), t("{x} tolto dal team.", { x: m.displayName }))) await loadMembers(selected!);
  }
  async function removeTeam() {
    if (!team || !confirm(t("Eliminare il team «{x}»? I suoi membri perdono i permessi dati al team.", { x: team.displayName }))) return;
    if (await run("del", () => api.del(`/api/admin/principals/${team.id}`), t("Team eliminato."))) {
      select(undefined);
      await load();
    }
  }
</script>

<div class="adm">
  <header class="adm-head">
    <div>
      <p class="eyebrow you">{t("Console")}</p>
      <h1>{t("Team")}</h1>
      <p>{t("Gruppi di utenti. I permessi dati a un team valgono per tutti i suoi membri; un utente può stare in più team. Quando un utente viene cancellato, i suoi contenuti non personali passano a un suo team.")}</p>
    </div>
    <div class="adm-bar">
      <Button variant="primary" onclick={() => (creating = !creating)}>{t("Nuovo team")}</Button>
    </div>
  </header>
  <Explain id="admin-team" text={EXPLAIN_ADMIN.team!} />

  {#if creating}
    <form class="adm-card" onsubmit={(e) => (e.preventDefault(), create())}>
      <h2>{t("Nuovo team")}</h2>
      <div class="adm-form">
        <label class="field"><span class="label">{t("Nome del team")}</span><input class="input" required pattern="[a-z0-9._\-]+" bind:value={nt.name} placeholder={t("vendite")} /></label>
        <label class="field"><span class="label">{t("Nome visibile")}</span><input class="input" bind:value={nt.displayName} placeholder={t("Vendite")} /></label>
      </div>
      <div class="adm-bar">
        <Button variant="primary" type="submit" busy={busy === "create"}>{t("Crea")}</Button>
        <Button variant="quiet" type="button" onclick={() => (creating = false)}>{t("Annulla")}</Button>
      </div>
    </form>
  {/if}

  {#if error}
    <p class="notice error">{error}</p>
  {:else if !teams}
    <span class="skeleton" style="height:8rem"></span>
  {:else}
    <div class="cols">
      <div class="adm-scroll">
        <table class="adm-table">
          <thead><tr><th>{t("Team")}</th><th>{t("Creato")}</th><th><span class="visually-hidden">{t("Azioni")}</span></th></tr></thead>
          <tbody>
            {#each teams as x (x.id)}
              <tr class:sel={x.id === selected}>
                <td><button class="link" onclick={() => select(x.id === selected ? undefined : x.id)}>{x.displayName}</button><div class="dim mono">{x.name}</div></td>
                <td class="dim">{when(x.createdAt)}</td>
                <td class="acts"><Button size="sm" variant={x.id === selected ? "secondary" : "quiet"} aria-expanded={x.id === selected} onclick={() => select(x.id === selected ? undefined : x.id)}>{x.id === selected ? t("Chiudi") : t("Membri")}</Button></td>
              </tr>
            {:else}
              <tr><td colspan="3" class="dim">{t("Nessun team.")}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>

      {#if team}
        <aside class="adm-card" aria-label={t("Membri del team")}>
          <h2>{team.displayName}</h2>
          <label class="field">
            <span class="label">{t("Aggiungi un utente")}</span>
            <input class="input" type="search" bind:value={who} placeholder={t("Cerca per nome")} />
          </label>
          {#if found.length}
            <ul class="found">
              {#each found as u (u.id)}<li><span>{u.displayName} <span class="dim mono">{u.name}</span></span><Button size="sm" busy={busy === "add"} onclick={() => add(u)}>{t("Aggiungi")}</Button></li>{/each}
            </ul>
          {/if}
          {#if !members}
            <span class="skeleton" style="height:4rem"></span>
          {:else}
            <ul class="members">
              {#each members as m (m.id)}
                <li><span>{m.displayName} <span class="dim mono">{m.name}</span></span><Button size="sm" variant="quiet" busy={busy === `rm-${m.id}`} onclick={() => removeMember(m)}>{t("Togli")}</Button></li>
              {:else}
                <li class="dim">{t("Nessun membro.")}</li>
              {/each}
            </ul>
          {/if}
          <div class="adm-bar">
            <Button size="sm" variant="quiet" onclick={() => ws.open({ kind: "admin", section: "permessi", id: team!.id })}>{t("Modifica i permessi")}</Button>
            <Button size="sm" variant="danger" busy={busy === "del"} onclick={removeTeam}>{t("Elimina il team")}</Button>
          </div>
        </aside>
      {/if}
    </div>
  {/if}
</div>

<style>
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
  }
  @media (min-width: 1000px) {
    .cols {
      grid-template-columns: minmax(0, 1fr) 24rem;
    }
  }
  .found,
  .members {
    list-style: none;
    margin: 0.5rem 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .found li,
  .members li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
</style>
