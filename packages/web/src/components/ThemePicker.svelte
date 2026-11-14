<script lang="ts">
  import { onMount } from "svelte";
  import { THEMES, THEME_LABELS, applyTheme, currentTheme, type Theme } from "../lib/theme.ts";
  import { t } from "../lib/i18n.ts";

  let theme = $state<Theme>("scuro");
  onMount(() => (theme = currentTheme()));

  function choose(t: Theme) {
    theme = t;
    applyTheme(t);
  }

  // Radio-group keyboard pattern: arrows move between swatches
  function onKey(e: KeyboardEvent) {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = THEMES[(THEMES.indexOf(theme) + step + THEMES.length) % THEMES.length]!;
    choose(next);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-theme-value="${next}"]`)?.focus();
  }
</script>

<div class="theme-picker" role="radiogroup" aria-label={t("Tema dei colori")} tabindex="-1" onkeydown={onKey}>
  <span class="theme-picker-label">{t("Tema")}</span>
  {#each THEMES as t (t)}
    <button
      type="button"
      class="theme-swatch"
      role="radio"
      data-theme-value={t}
      aria-checked={theme === t}
      tabindex={theme === t ? 0 : -1}
      title={THEME_LABELS[t]}
      aria-label={THEME_LABELS[t]}
      onclick={() => choose(t)}
    ></button>
  {/each}
</div>

<style>
  .theme-picker {
    padding: 0;
  }
</style>
