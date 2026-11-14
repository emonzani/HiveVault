<script lang="ts">
  import { ui } from "../lib/ui.svelte.ts";
  import { t } from "../lib/i18n.ts";
</script>

<div class="toasts" aria-live="polite" aria-relevant="additions">
  {#each ui.toasts as toast (toast.id)}
    <div class="toast {toast.tone}" role={toast.tone === "error" ? "alert" : "status"}>
      <span>{toast.text}</span>
      {#if toast.action}<button class="act" onclick={() => (toast.action!.run(), ui.dismiss(toast.id))}>{toast.action.label}</button>{/if}
      <button class="x" aria-label={t("Chiudi il messaggio")} onclick={() => ui.dismiss(toast.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    z-index: 100;
    left: 50%;
    bottom: 1.25rem;
    transform: translateX(-50%);
    display: grid;
    gap: 0.5rem;
    width: min(32rem, calc(100vw - 2rem));
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 0.65rem 0.65rem 0.95rem;
    border-radius: var(--r-control);
    background: var(--ink-2);
    border: 1px solid var(--line-strong);
    box-shadow: var(--shadow-subtle);
    font-size: var(--fs-sm);
    animation: up 0.16s ease-out;
  }
  .toast span {
    flex: 1;
  }
  .toast.ok {
    box-shadow: inset 3px 0 0 var(--busy), var(--shadow-subtle);
  }
  .toast.error {
    box-shadow: inset 3px 0 0 var(--alert), var(--shadow-subtle);
  }
  @keyframes up {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  .x,
  .act {
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--text-muted);
  }
  .act {
    color: var(--accent-blue);
    font-weight: 600;
  }
  .x {
    font-size: 1.1rem;
    padding: 0 0.3rem;
  }
</style>
