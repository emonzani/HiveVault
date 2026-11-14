<script lang="ts">
  // Owner of a cell vault in two fields: the kind, then the name with suggestions. The value
  // stays one string "kind:ref"; a user or a team is stored by id, the other kinds by their free name.
  import { untrack } from "svelte";
  import Combobox, { type ComboOption } from "../../../components/Combobox.svelte";
  import { api, qs } from "../../../lib/api.ts";
  import { t } from "../../../lib/i18n.ts";

  const KINDS = { user: t("Utente"), project: t("Progetto"), team: t("Team"), edge: t("Edge") } as const;
  type Kind = keyof typeof KINDS;
  const NAME = /^[A-Za-z0-9_-]+$/;

  let {
    owner = $bindable(""),
    /** Display name of a user owner (the value holds its id). */
    ownerLabel = null,
    /** False while the kind is chosen but the name is missing or not picked. */
    complete = $bindable(true),
    optional = false,
  }: { owner?: string; ownerLabel?: string | null; complete?: boolean; optional?: boolean } = $props();

  const uid = $props.id();
  // the first value only: the caller re-creates the field (with {#key}) for another vault
  const [start, startLabel] = untrack(() => [/^(user|project|team|edge):(.+)$/.exec(owner), ownerLabel] as const);
  let kind = $state<Kind | "">((start?.[1] as Kind) ?? "");
  let value = $state(start?.[2] ?? "");
  let text = $state(start ? (start[1] === "user" ? (startLabel ?? start[2]!) : start[2]!) : "");

  $effect(() => {
    owner = kind && value ? `${kind}:${value}` : "";
    complete = !kind || !!value;
  });

  function changeKind() {
    value = "";
    text = "";
  }

  const search = (q: string, signal: AbortSignal) => api.get<ComboOption[]>(`/api/admin/owners${qs({ kind, q })}`, { signal });
</script>

<div class="field">
  <label class="label" for="ok-{uid}">{t("Tipo di proprietario{x}", { x: optional ? " (facoltativo)" : "" })}</label>
  <select id="ok-{uid}" class="input" bind:value={kind} onchange={changeKind}>
    <option value="">{t("Nessuno")}</option>
    {#each Object.entries(KINDS) as [k, l] (k)}<option value={k}>{l}</option>{/each}
  </select>
</div>
{#if kind}
  <div class="field">
    <label class="label" for="ov-{uid}">{KINDS[kind]}</label>
    <Combobox
      id="ov-{uid}"
      bind:value
      bind:text
      {search}
      free={kind === "user" || kind === "team" ? undefined : NAME}
      placeholder={kind === "user" ? t("Nome, utente o email") : t("Nome {x}", { x: kind === "team" ? t("del team") : kind === "project" ? t("del progetto") : t("dell'edge") })}
    />
    {#if text.trim() && !value}<span class="msg error">{kind === "user" ? t("Scegli l'utente tra i suggerimenti.") : kind === "team" ? t("Scegli il team tra i suggerimenti.") : t("Lettere, cifre, trattini e trattini bassi.")}</span>{/if}
  </div>
{/if}
