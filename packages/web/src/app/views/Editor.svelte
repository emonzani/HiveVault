<script lang="ts">
  // Markdown editor: CodeMirror 6 on the full file (frontmatter + body), live preview beside it,
  // [[ autocompletion from the titles and aliases of the vault, Ctrl+S to save. A save that
  // races with another one answers 409: the user chooses to reload or to overwrite.
  import { onDestroy, onMount } from "svelte";
  import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
  import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
  import { markdown } from "@codemirror/lang-markdown";
  import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
  import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
  import { EditorState } from "@codemirror/state";
  import { EditorView, keymap, placeholder } from "@codemirror/view";
  import { tags } from "@lezer/highlight";
  import Button from "../../components/Button.svelte";
  import Icon from "../../components/Icon.svelte";
  import { api, ApiError, qs } from "../../lib/api.ts";
  import { renderMarkdown, splitFrontmatter } from "../../lib/markdown.ts";
  import { pageCache, pageEvents } from "../../lib/pages.svelte.ts";
  import type { FullPage, Suggestion } from "../../lib/types.ts";
  import { ui } from "../../lib/ui.svelte.ts";
  import { ws } from "../../lib/workspace.svelte.ts";
  import { t } from "../../lib/i18n.ts";

  let { page, onclose }: { page: FullPage; onclose: () => void } = $props();

  let host: HTMLDivElement | undefined = $state();
  let view: EditorView | null = null;
  let text = $state("");
  let original = $state("");
  let loading = $state(true);
  let saving = $state(false);
  let preview = $state(true);
  let conflict = $state<string | null>(null);
  let baseVersion = $state(0);
  const dirty = $derived(!loading && text !== original);

  const env = $derived({
    titles: new Map(page.links.filter((l) => l.pageId).map((l) => [l.target, l])),
    citations: new Map(page.citations.map((c) => [c.ref, c])),
  });
  let html = $state("");
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const body = splitFrontmatter(text).body;
    const e = env;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => (html = renderMarkdown(body, { ...e, citeOrder: new Map(), headings: [] })), 120);
  });

  async function linkSource(ctx: CompletionContext): Promise<CompletionResult | null> {
    const m = ctx.matchBefore(/\[\[[^\]|#\n]*$/);
    if (!m) return null;
    const q = m.text.slice(2);
    let rows: Suggestion[] = [];
    try {
      rows = await api.get<Suggestion[]>(`/api/suggest${qs({ q, vault: page.vaultId, limit: 15 })}`);
    } catch {
      return null;
    }
    return {
      from: m.from + 2,
      options: rows.map((r) => ({
        label: r.title,
        detail: r.alias ? `alias: ${r.alias}` : r.type,
        apply: (v: EditorView, _c: unknown, from: number, to: number) => {
          const after = v.state.sliceDoc(to, to + 2);
          v.dispatch({ changes: { from, to: after === "]]" ? to + 2 : to, insert: `${r.title}]]` }, selection: { anchor: from + r.title.length + 2 } });
        },
      })),
      filter: false,
    };
  }

  // Tags of the vault, the most used first, in the "tags:" line of the frontmatter (or its "- "
  // items): one tag stays one tag instead of three spellings. One request per editor.
  let vaultTags: Promise<{ tag: string; pages: number }[]> | null = null;
  async function tagSource(ctx: CompletionContext): Promise<CompletionResult | null> {
    const before = ctx.state.sliceDoc(0, ctx.pos);
    if (!before.startsWith("---\n") || before.slice(4).includes("\n---")) return null;
    const lines = before.split("\n");
    const cur = lines.at(-1)!;
    const listItem = /^\s*-\s+[^,\]]*$/.test(cur) && [...lines.slice(0, -1)].reverse().find((l) => !/^\s*-\s/.test(l))?.trim() === "tags:";
    if (!/^tags:/.test(cur) && !listItem) return null;
    const word = ctx.matchBefore(/[\p{L}\p{N}_/-]*/u);
    if (!word || (word.from === word.to && !ctx.explicit && !/[[,:]\s*$|-\s+$/.test(cur))) return null;
    vaultTags ??= api.get<{ tag: string; pages: number }[]>(`/api/tags${qs({ vault: page.vaultId })}`).catch(() => []);
    const used = new Set(cur.replace(/^tags:/, "").split(/[[\],\s-]+/).filter(Boolean));
    const all = (await vaultTags).filter((t) => !used.has(t.tag) || t.tag === word.text);
    return {
      from: word.from,
      options: all.map((tag, i) => ({ label: tag.tag, detail: tag.pages === 1 ? t("{n} pagina", { n: tag.pages }) : t("{n} pagine", { n: tag.pages }), boost: Math.max(-99, 99 - i) })),
      validFor: /^[\p{L}\p{N}_/-]*$/u,
    };
  }

  const theme = EditorView.theme({
    "&": { height: "100%", backgroundColor: "transparent", color: "var(--text-main)", fontSize: "var(--fs-md)" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65", padding: "1.25rem 0" },
    ".cm-content": { caretColor: "var(--you)", maxWidth: "76ch", margin: "0 auto", padding: "0 1.5rem" },
    ".cm-cursor": { borderLeftColor: "var(--you)" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--you-mark) !important" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-gutters": { display: "none" },
    ".cm-tooltip": { border: "1px solid var(--line-strong)", backgroundColor: "var(--ink-1)", borderRadius: "8px", overflow: "hidden" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "0.25rem 0.6rem", fontFamily: "var(--font-sans)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--ink-3)", color: "var(--text-main)" },
    ".cm-completionDetail": { color: "var(--text-dim)", marginLeft: "0.6rem", fontStyle: "normal" },
    ".cm-panels": { backgroundColor: "var(--ink-1)", color: "var(--text-main)", borderColor: "var(--line)" },
    ".cm-searchMatch": { backgroundColor: "var(--you-soft)" },
  });
  const highlight = HighlightStyle.define([
    { tag: tags.heading, fontWeight: "650", color: "var(--text-main)" },
    { tag: tags.heading1, fontSize: "1.25em" },
    { tag: tags.heading2, fontSize: "1.12em" },
    { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "var(--text-dim)" },
    { tag: tags.link, color: "var(--link)" },
    { tag: tags.url, color: "var(--accent-blue)" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "700" },
    { tag: tags.monospace, color: "var(--busy-ink)" },
    { tag: tags.quote, color: "var(--text-muted)" },
    { tag: tags.list, color: "var(--you-ink)" },
  ]);

  async function save(overwrite = false) {
    if (saving || !view) return;
    saving = true;
    conflict = null;
    try {
      if (overwrite) baseVersion = (await pageCache.get(page.id, true)).version;
      const r = await api.put<{ version: number; changed: boolean; rectification?: { itemId: string; pages: unknown[]; sources: unknown[] } }>(`/api/pages/${encodeURIComponent(page.id)}`, { markdown: text, baseVersion });
      original = text;
      baseVersion = r.version;
      pageEvents.notify(page.id);
      if (r.rectification) {
        const n = r.rectification.pages.length + r.rectification.sources.length;
        ui.toast(t("Rettifica salvata. Correggi anche le {n} fonti elencate nella coda dei curatori.", { n }), "ok", { label: t("Apri la coda"), run: () => ws.open({ kind: "curator" }, "here") });
      } else ui.toast(r.changed ? t("Salvato (versione {version}).", { version: r.version }) : t("Nessuna modifica da salvare."), "ok");
      onclose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) conflict = e.message;
      else ui.toast((e as Error).message, "error");
    } finally {
      saving = false;
    }
  }

  async function reloadFromServer() {
    conflict = null;
    const md = await api.get<string>(`/api/pages/${encodeURIComponent(page.id)}/markdown`);
    const fresh = await pageCache.get(page.id, true);
    baseVersion = fresh.version;
    original = md;
    view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: md } });
  }

  function close() {
    if (dirty && !confirm(t("Ci sono modifiche non salvate. Chiudere l'editor senza salvarle?"))) return;
    onclose();
  }

  const beforeUnload = (e: BeforeUnloadEvent) => {
    if (dirty) e.preventDefault();
  };

  onMount(async () => {
    addEventListener("beforeunload", beforeUnload);
    baseVersion = page.version;
    try {
      original = await api.get<string>(`/api/pages/${encodeURIComponent(page.id)}/markdown`);
    } catch (e) {
      ui.toast((e as Error).message, "error");
      onclose();
      return;
    }
    text = original;
    loading = false;
    view = new EditorView({
      parent: host!,
      state: EditorState.create({
        doc: original,
        extensions: [
          history(),
          markdown(),
          syntaxHighlighting(highlight),
          closeBrackets(),
          autocompletion({ override: [linkSource, tagSource], activateOnTyping: true, icons: false }),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          placeholder(t("Scrivi in Markdown. [[ per collegare una pagina.")),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (void save(), true) },
            { key: "Escape", run: () => (close(), true) },
            indentWithTab,
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) text = u.state.doc.toString();
          }),
          EditorView.contentAttributes.of({ "aria-label": t("Testo della pagina {title}", { title: page.title }) }),
        ],
      }),
    });
    view.focus();
  });

  onDestroy(() => {
    removeEventListener("beforeunload", beforeUnload);
    clearTimeout(previewTimer);
    view?.destroy();
  });
</script>

<div class="editor">
  <header class="bar">
    <strong class="name">{page.title}</strong>
    <span class="state" aria-live="polite">{loading ? t("Caricamento…") : dirty ? t("Modifiche non salvate") : t("Nessuna modifica")}</span>
    <span class="grow"></span>
    <button class="icon-btn" aria-pressed={preview} title={t("Anteprima affiancata")} aria-label={t("Anteprima affiancata")} onclick={() => (preview = !preview)}><Icon name="eye" /></button>
    <Button variant="quiet" size="sm" onclick={close}>{t("Chiudi")} <kbd>Esc</kbd></Button>
    <Button variant="primary" size="sm" busy={saving} disabled={!dirty} onclick={() => save()}>{t("Salva")} <kbd>Ctrl S</kbd></Button>
  </header>
  {#if page.rectifiable}
    <p class="notice warn rectify">{t("Stai rettificando una pagina scritta dal ciclo notturno. La correzione vale subito; dopo il salvataggio la coda dei curatori elenca le pagine e i documenti da cui viene il dato, da correggere anche loro.")}</p>
  {/if}
  {#if conflict}
    <div class="notice warn conflict" role="alert">
      <span>{conflict}</span>
      <span class="grow"></span>
      <Button size="sm" onclick={reloadFromServer}>{t("Carica la versione nuova")}</Button>
      <Button size="sm" variant="danger" onclick={() => save(true)}>{t("Sovrascrivi con la mia")}</Button>
    </div>
  {/if}
  <div class="panes" class:preview>
    <div class="cm" bind:this={host}></div>
    {#if preview}
      <div class="pv" aria-label={t("Anteprima")}>
        <div class="md">{@html html}</div>
      </div>
    {/if}
  </div>
</div>

<style>
  .editor {
    min-height: 0;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--line);
    background: var(--ink-0);
  }
  .bar kbd {
    margin-left: 0.25rem;
  }
  .name {
    font-size: var(--fs-sm);
    max-width: 30ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .grow {
    flex: 1;
  }
  .conflict {
    margin: 0.6rem 1rem 0;
    align-items: center;
  }
  .rectify {
    margin: 0.6rem 1rem 0;
  }
  .panes {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  .panes.preview {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .cm {
    min-height: 0;
    overflow: hidden;
  }
  .cm :global(.cm-editor) {
    height: 100%;
  }
  .pv {
    min-height: 0;
    overflow-y: auto;
    padding: 1.25rem 1.75rem 4rem;
    border-left: 1px solid var(--line);
    background: var(--ink-1);
  }
  .pv .md {
    max-width: var(--measure);
    margin: 0 auto;
  }
  @media (max-width: 1000px) {
    .panes.preview {
      grid-template-columns: minmax(0, 1fr);
    }
    .pv {
      display: none;
    }
  }
</style>
