<script lang="ts">
  // "Spiegato in parole semplici": a short explanation for anyone. It opens by itself the first
  // time a viewer meets it; afterwards it starts closed (one click opens it), unless the viewer
  // opened it on purpose. Per-viewer conveniences in localStorage.
  import Icon from "./Icon.svelte";
  import { t } from "../lib/i18n.ts";

  let { id, text }: { id: string; text: string } = $props();

  const CLOSED = "cb-explain-closed";
  const SEEN = "cb-explain-seen";
  const PINNED = "cb-explain-pinned";
  const read = (key: string): Set<string> => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  };
  const write = (key: string, set: Set<string>) => {
    try {
      localStorage.setItem(key, JSON.stringify([...set]));
    } catch {
      /* storage unavailable: the state lasts for this page */
    }
  };

  let open = $state(true);
  $effect(() => {
    const seen = read(SEEN);
    open = read(PINNED).has(id) || (!seen.has(id) && !read(CLOSED).has(id));
    if (!seen.has(id)) write(SEEN, seen.add(id));
  });
  function toggle(e: Event) {
    // the browser also fires "toggle" when the element is mounted open: only a change is a choice
    const now = (e.currentTarget as HTMLDetailsElement).open;
    if (now === open) return;
    open = now;
    const closed = read(CLOSED);
    const pinned = read(PINNED);
    if (open) (closed.delete(id), pinned.add(id));
    else (closed.add(id), pinned.delete(id));
    write(CLOSED, closed);
    write(PINNED, pinned);
  }
</script>

<details class="explain" {open} ontoggle={toggle}>
  <summary><span class="ic" aria-hidden="true"><Icon name="star" size={13} /></span>{t("Spiegato in parole semplici")}<span class="chev" aria-hidden="true"><Icon name="chevron" size={13} /></span></summary>
  <p>{text}</p>
</details>

<style>
  /* a quiet aside: neutral surface, the colour only in the icon */
  .explain {
    border: 1px solid var(--line);
    background: var(--ink-2);
    border-radius: var(--r-control);
    padding: 0.45rem 0.75rem;
    max-width: 72ch;
    font-size: var(--fs-sm);
  }
  .explain:not([open]) {
    width: fit-content;
    background: transparent;
  }
  summary {
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-weight: 600;
    color: var(--text-muted);
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:hover {
    color: var(--text-main);
  }
  .ic {
    display: inline-flex;
    color: var(--link);
  }
  .chev {
    display: inline-flex;
    transition: transform var(--transition-fast);
  }
  .explain[open] .chev {
    transform: rotate(90deg);
  }
  p {
    margin-top: 0.35rem;
    color: var(--text-main);
    line-height: 1.55;
  }
</style>
