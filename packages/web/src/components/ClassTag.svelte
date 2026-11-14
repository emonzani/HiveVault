<script lang="ts" module>
  import { t } from "../lib/i18n.ts";
  import { valueLabel } from "../lib/format.ts";
  export type Classification = "pubblico" | "interno" | "riservato" | "segreto" | "personale";
  const HINT: Record<Classification, string> = {
    pubblico: t("Visibile a tutti; l'agente cloud può leggerla"),
    interno: t("Visibile in azienda; l'agente cloud può leggerla con un account autorizzato"),
    riservato: t("Solo chi ha accesso allo spazio; l'agente cloud non la legge"),
    segreto: t("Accesso nominativo; non esce mai dal server"),
    personale: t("Solo il proprietario la legge, nemmeno gli amministratori; non esce mai dal server"),
  };
</script>

<script lang="ts">
  let { level }: { level: Classification } = $props();
</script>

<span class="tag {level}" title={HINT[level]}>
  <svg viewBox="0 0 10 10" aria-hidden="true">
    {#if level === "pubblico"}
      <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.4" />
    {:else if level === "interno"}
      <path d="M5 1.5 A3.5 3.5 0 0 1 5 8.5 Z" fill="currentColor" /><circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.4" />
    {:else if level === "riservato"}
      <path d="M5 1.5 A3.5 3.5 0 1 1 1.5 5 L5 5 Z" fill="currentColor" /><circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.4" />
    {:else if level === "personale"}
      <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.4" /><circle cx="5" cy="5" r="1.6" fill="currentColor" />
    {:else}
      <circle cx="5" cy="5" r="4" fill="currentColor" />
    {/if}
  </svg>
  {valueLabel(level)}
</span>

<style>
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.1rem 0.55rem 0.12rem 0.45rem;
    border-radius: var(--r-pill);
    font-size: var(--fs-xs);
    font-weight: 560;
    line-height: 1.5;
  }
  svg {
    width: 0.7rem;
    height: 0.7rem;
  }
  .pubblico {
    background: var(--cls-pubblico-bg);
    color: var(--cls-pubblico-fg);
  }
  .interno {
    background: var(--cls-interno-bg);
    color: var(--cls-interno-fg);
  }
  .riservato {
    background: var(--cls-riservato-bg);
    color: var(--cls-riservato-fg);
  }
  /* personale: the colors of segreto (checked at 4.5:1), its own icon */
  .segreto,
  .personale {
    background: var(--cls-segreto-bg);
    color: var(--cls-segreto-fg);
  }
</style>
