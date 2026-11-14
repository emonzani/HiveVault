<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  type Variant = "primary" | "secondary" | "quiet" | "danger";
  let {
    variant = "secondary",
    size = "md",
    busy = false,
    children,
    ...rest
  }: HTMLButtonAttributes & { variant?: Variant; size?: "sm" | "md"; busy?: boolean; children: Snippet } = $props();
</script>

<button class="btn {variant} {size}" aria-busy={busy} disabled={busy || rest.disabled} {...rest}>
  {#if busy}<span class="spin" aria-hidden="true"></span>{/if}
  {@render children()}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    border: 1px solid transparent;
    border-radius: var(--r-control);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background-color var(--transition-fast),
      border-color var(--transition-fast),
      transform var(--transition-fast);
  }
  .btn:active:not(:disabled) {
    transform: translateY(1px);
  }
  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .md {
    font-size: var(--fs-sm);
    padding: 0.45rem 0.85rem;
  }
  .sm {
    font-size: var(--fs-xs);
    padding: 0.25rem 0.6rem;
  }
  .primary {
    background: var(--you);
    color: var(--on-you);
  }
  .primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--you) 88%, var(--text-main));
  }
  .secondary {
    background: var(--ink-2);
    border-color: var(--line);
    color: var(--text-main);
  }
  .secondary:hover:not(:disabled) {
    background: var(--ink-3);
  }
  .quiet {
    background: transparent;
    color: var(--text-muted);
  }
  .quiet:hover:not(:disabled) {
    background: var(--ink-2);
    color: var(--text-main);
  }
  .danger {
    background: var(--alert-soft);
    border-color: color-mix(in srgb, var(--alert-ink) 30%, transparent);
    color: var(--alert-ink);
  }
  .danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--alert) 30%, transparent);
  }
  .spin {
    width: 0.8em;
    height: 0.8em;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-right-color: transparent;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
