<script lang="ts">
  // Audit log with search (plan §8.3): account, action (a trailing * matches a prefix),
  // outcome and period. Older rows load on request (keyset on the id).
  import Explain from "../../../components/Explain.svelte";
  import { EXPLAIN_ADMIN } from "../../../lib/explain.ts";
  import { untrack } from "svelte";
  import Button from "../../../components/Button.svelte";
  import { api, qs } from "../../../lib/api.ts";
  import type { PrincipalView } from "../../../lib/admin.ts";
  import { when } from "../../../lib/format.ts";
  import { target } from "../../../lib/ui.svelte.ts";
  import { ws } from "../../../lib/workspace.svelte.ts";
  import { t } from "../../../lib/i18n.ts";

  let { principal }: { principal?: string } = $props();

  interface Row {
    id: number;
    at: string;
    principalId: string | null;
    action: string;
    resource: string | null;
    outcome: "ok" | "denied" | "error";
    ip: string | null;
    userAgent: string | null;
    data: Record<string, unknown> | null;
  }
  const PRESETS: [string, string][] = [
    ["", t("Tutte le azioni")],
    ["login*", t("Accessi")],
    ["admin.*", t("Modifiche degli amministratori")],
    ["page.*", t("Pagine")],
    ["source.*", t("Sorgenti")],
    ["mcp.*", t("Letture dell'agente cloud")],
    ["egress.blocked", t("Connessioni bloccate")],
    ["curator.*", t("Curatori")],
  ];
  const LIMIT = 200;

  let people = $state(new Map<string, PrincipalView>());
  // the filter starts from the account the console opened with; the user changes it here
  let who = $state(untrack(() => principal ?? ""));
  let action = $state("");
  let outcome = $state("");
  let since = $state("");
  let until = $state("");
  let rows = $state<Row[] | null>(null);
  let more = $state(false);
  let error = $state("");
  let open = $state<number | null>(null);

  $effect(() => {
    api.get<{ items: PrincipalView[] }>("/api/admin/principals?limit=500").then((r) => (people = new Map(r.items.map((p) => [p.id, p]))), () => {});
  });
  const query = (beforeId?: number) =>
    qs({
      principalId: who,
      action: action.trim(),
      outcome,
      since: since ? new Date(`${since}T00:00:00`).toISOString() : "",
      until: until ? new Date(`${until}T23:59:59`).toISOString() : "",
      limit: LIMIT,
      beforeId,
    });
  async function load(append = false) {
    try {
      const r = await api.get<Row[]>(`/api/admin/audit${query(append ? rows?.at(-1)?.id : undefined)}`);
      rows = append && rows ? [...rows, ...r] : r;
      more = r.length === LIMIT;
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
  }
  let timer: ReturnType<typeof setTimeout>;
  $effect(() => {
    void [who, action, outcome, since, until];
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 250);
  });
  const name = (id: string | null) => (id ? (people.get(id)?.displayName ?? id.slice(-8)) : "sistema");
  const summary = (d: Row["data"]) =>
    d
      ? Object.entries(d)
          .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
          .join(" · ")
          .slice(0, 160)
      : "";
</script>

<div class="adm">
  <header class="adm-head">
    <div>
      <p class="eyebrow you">{t("Console")}</p>
      <h1>{t("Audit")}</h1>
      <p>{t("Ogni accesso, modifica e lettura dell'agente cloud. Gli eventi di sicurezza sono scritti subito; le letture arrivano entro pochi secondi.")}</p>
    </div>
  </header>
  <Explain id="admin-audit" text={EXPLAIN_ADMIN["audit"]!} />
  <div class="adm-bar">
    <select class="input" aria-label={t("Account")} bind:value={who}>
      <option value="">{t("Tutti gli account")}</option>
      {#each [...people.values()] as p (p.id)}<option value={p.id}>{p.displayName}</option>{/each}
    </select>
    <select class="input" aria-label={t("Gruppo di azioni")} value={PRESETS.some(([v]) => v === action) ? action : "custom"} onchange={(e) => (action = (e.currentTarget as HTMLSelectElement).value === "custom" ? action : (e.currentTarget as HTMLSelectElement).value)}>
      {#each PRESETS as [v, l] (v)}<option value={v}>{l}</option>{/each}
      <option value="custom" disabled>{t("Personalizzata")}</option>
    </select>
    <input class="input mono" aria-label={t("Azione")} placeholder={t("azione, es. page.read")} bind:value={action} />
    <select class="input" aria-label={t("Esito")} bind:value={outcome}><option value="">{t("Ogni esito")}</option><option value="ok">{t("Riuscite")}</option><option value="denied">{t("Negate")}</option><option value="error">{t("Errori")}</option></select>
    <label class="dt">dal <input class="input" type="date" bind:value={since} /></label>
    <label class="dt">al <input class="input" type="date" bind:value={until} /></label>
  </div>

  {#if error}
    <p class="notice error">{error}</p>
  {:else if !rows}
    <span class="skeleton" style="height:14rem"></span>
  {:else}
    <div class="adm-scroll">
      <table class="adm-table">
        <thead><tr><th>{t("Quando")}</th><th>{t("Chi")}</th><th>{t("Azione")}</th><th>{t("Risorsa")}</th><th>{t("Esito")}</th><th>{t("Indirizzo")}</th></tr></thead>
        <tbody>
          {#each rows as r (r.id)}
            <tr class="row" onclick={() => (open = open === r.id ? null : r.id)}>
              <td class="dim nowrap">{when(r.at)}</td>
              <td>{name(r.principalId)}</td>
              <td class="mono">{r.action}</td>
              <td class="res mono">
                {#if r.resource && r.action.startsWith("page.")}
                  <a href="#/p/{r.resource}" onclick={(e) => (e.preventDefault(), e.stopPropagation(), ws.open({ kind: "page", id: r.resource! }, target(e)))}>{r.resource.slice(-10)}</a>
                {:else}{r.resource ?? ""}{/if}
                {#if r.data && open !== r.id}<span class="dim"> {summary(r.data)}</span>{/if}
              </td>
              <td><span class="badge {r.outcome === 'ok' ? 'idle' : 'alert'}">{r.outcome === "ok" ? t("ok") : r.outcome === "denied" ? t("negata") : t("errore")}</span></td>
              <td class="dim mono">{r.ip ?? ""}</td>
            </tr>
            {#if open === r.id}
              <tr class="more"><td colspan="6"><pre class="mono">{JSON.stringify({ ...r, data: r.data }, null, 2)}</pre></td></tr>
            {/if}
          {:else}
            <tr><td colspan="6" class="dim">{t("Nessun evento con questi filtri.")}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if more}<div><Button size="sm" onclick={() => load(true)}>{t("Eventi precedenti")}</Button></div>{/if}
  {/if}
</div>

<style>
  .dt {
    display: inline-flex;
    gap: 0.35rem;
    align-items: center;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .row {
    cursor: pointer;
  }
  .nowrap {
    white-space: nowrap;
  }
  .res {
    max-width: 28rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-xs);
  }
  .more pre {
    font-size: var(--fs-xs);
    background: var(--well);
    padding: 0.6rem;
    border-radius: var(--r-control);
    overflow: auto;
    max-height: 20rem;
  }
</style>
