<script lang="ts">
  import { onMount } from "svelte";
  import { sourceEvents } from "../lib/events.svelte.ts";
  import { working } from "../lib/working.svelte.ts";
  import { pageCache, previewCache } from "../lib/pages.svelte.ts";
  import { session } from "../lib/session.svelte.ts";
  import { ui } from "../lib/ui.svelte.ts";
  import { ws } from "../lib/workspace.svelte.ts";
  import Login from "./Login.svelte";
  import Shell from "./Shell.svelte";
  import { t } from "../lib/i18n.ts";

  onMount(() => void session.load());

  // The event stream and the caches belong to one logged-in user
  $effect(() => {
    if (session.me) {
      ui.loadFavorites(session.me.principal.id);
      // M14: a document uploaded from this tab reached I3
      sourceEvents.onCompiled = (id, name) => ui.toast(t("«{name}» è compilato nel wiki.", { name }), "ok", { label: t("Apri il documento"), run: () => ws.open({ kind: "source", id }) });
      sourceEvents.start();
      working.start();
    } else {
      sourceEvents.stop();
      working.stop();
      pageCache.clear();
      previewCache.clear();
    }
  });
</script>

{#if !session.ready}
  <div class="splash" aria-busy="true" aria-label={t("Caricamento")}><span class="mark"></span></div>
{:else if !session.me}
  <Login />
{:else}
  <Shell />
{/if}

<style>
  .splash {
    height: 100%;
    display: grid;
    place-items: center;
  }
  .mark {
    width: 2rem;
    height: 2rem;
    border-radius: 7px;
    background:
      radial-gradient(circle at 30% 30%, var(--you) 0 28%, transparent 30%),
      radial-gradient(circle at 70% 35%, var(--busy) 0 24%, transparent 26%),
      radial-gradient(circle at 45% 72%, var(--idle) 0 26%, transparent 28%),
      var(--ink-3);
    animation: pulse 1.4s ease-in-out infinite;
  }
</style>
