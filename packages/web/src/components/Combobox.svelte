<script lang="ts" module>
  import { t } from "../lib/i18n.ts";
  export interface ComboOption {
    value: string;
    label: string;
    hint?: string;
  }
</script>

<script lang="ts">
  // Text field with suggestions from the server (ARIA 1.2 combobox, list autocomplete).
  // The search starts at `minChars`; ↑/↓ move, Enter picks, Esc closes. Without `free`, only a
  // picked suggestion gives a value; with `free`, typed text that matches the pattern is the value.
  let {
    value = $bindable(""),
    text = $bindable(""),
    search,
    free,
    minChars = 2,
    id,
    placeholder,
    label,
    onpick,
  }: {
    value?: string;
    /** Shown text; for a value set from outside, the caller sets its label here. */
    text?: string;
    search: (q: string, signal: AbortSignal) => Promise<ComboOption[]>;
    free?: RegExp;
    minChars?: number;
    id?: string;
    placeholder?: string;
    /** Accessible name when no <label for> points to the field. */
    label?: string;
    onpick?: (o: ComboOption) => void;
  } = $props();

  const uid = $props.id();
  const inputId = $derived(id ?? `cb-${uid}`);
  const listId = `cb-list-${uid}`;
  let options = $state<ComboOption[]>([]);
  let open = $state(false);
  let sel = $state(-1);
  let loading = $state(false);
  let focused = $state(false);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let ctl: AbortController | null = null;
  function query(q: string) {
    clearTimeout(timer);
    ctl?.abort();
    if (q.trim().length < minChars) {
      options = [];
      loading = false;
      return;
    }
    loading = true;
    timer = setTimeout(async () => {
      ctl = new AbortController();
      try {
        options = await search(q.trim(), ctl.signal);
        sel = options.length ? 0 : -1;
        loading = false;
      } catch {
        /* aborted by a newer query, or failed: keep the list */
      }
    }, 150);
  }

  function oninput() {
    value = free?.test(text.trim()) ? text.trim() : "";
    open = true;
    query(text);
  }

  function pick(o: ComboOption) {
    value = o.value;
    text = o.label;
    open = false;
    onpick?.(o);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      open = true;
      if (!options.length) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      document.getElementById(`${listId}-${sel}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && open && options[sel]) {
      e.preventDefault();
      pick(options[sel]!);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      open = false;
    }
  }

  const short = $derived(text.trim().length < minChars);
  const shown = $derived(open && focused);
</script>

<div class="cb">
  <input
    id={inputId}
    class="input"
    type="text"
    role="combobox"
    aria-label={label}
    aria-autocomplete="list"
    aria-expanded={shown}
    aria-controls={listId}
    aria-activedescendant={shown && sel >= 0 ? `${listId}-${sel}` : undefined}
    aria-invalid={!focused && !free && text.trim() !== "" && !value ? true : undefined}
    autocomplete="off"
    spellcheck="false"
    {placeholder}
    bind:value={text}
    {oninput}
    {onkeydown}
    onfocus={() => {
      focused = true;
      // minChars 0: the suggestions show as soon as the field gets the focus, searched again
      // each time so a value used since the last search does not come back
      if (minChars === 0) {
        open = true;
        query(text);
      } else open = options.length > 0;
    }}
    onblur={() => ((focused = false), (open = false))}
  />
  <div class="list" hidden={!shown}>
  <ul id={listId} role="listbox" aria-label={label ?? t("Suggerimenti")}>
    {#each options as o, i (o.value)}
      <!-- mousedown keeps the focus in the field; the keyboard path is on the input -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li id="{listId}-{i}" role="option" aria-selected={i === sel} class:sel={i === sel} onmousedown={(e) => (e.preventDefault(), pick(o))} onmouseenter={() => (sel = i)}>
        <span class="l">{o.label}</span>
        {#if o.hint && o.hint !== o.label}<span class="h">{o.hint}</span>{/if}
      </li>
    {/each}
  </ul>
  {#if !options.length}
    <p class="none" role="status">{short ? t("Scrivi almeno {minChars} caratteri.", { minChars }) : loading ? t("Cerco…") : free ? t("Nessun suggerimento: puoi usare il testo scritto.") : t("Nessun risultato.")}</p>
  {/if}
  </div>
</div>

<style>
  .cb {
    position: relative;
  }
  .input[aria-invalid="true"] {
    border-color: var(--alert-ink);
  }
  .list {
    position: absolute;
    z-index: 20;
    top: calc(100% + 0.25rem);
    left: 0;
    right: 0;
    max-height: 16rem;
    overflow-y: auto;
    padding: 0.3rem;
    background: var(--ink-1);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-control);
    box-shadow: var(--shadow-modal);
  }
  .list[hidden] {
    display: none;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.4rem 0.55rem;
    border-radius: 6px;
    cursor: pointer;
  }
  li.sel {
    background: var(--ink-3);
  }
  /* the name wins the space; the hint shrinks first */
  .l {
    flex: 0 1 auto;
    min-width: min(100%, 8rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .h {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    font-size: var(--fs-xs);
    color: var(--text-dim);
    font-family: var(--font-mono);
  }
  .none {
    margin: 0;
    padding: 0.4rem 0.55rem;
    color: var(--text-dim);
    font-size: var(--fs-sm);
  }
</style>
