<script lang="ts">
  // Citation chip ^[src#chunk]: the number in the text, the source excerpt on hover/focus.
  let { n, source, excerpt, where }: { n: number; source: string; excerpt: string; where: string } = $props();
  let open = $state(false);
  const id = `cite-${Math.random().toString(36).slice(2, 8)}`;
</script>

<span class="cite">
  <button
    type="button"
    class="chip prov-machine"
    aria-describedby={open ? id : undefined}
    aria-expanded={open}
    onmouseenter={() => (open = true)}
    onmouseleave={() => (open = false)}
    onfocus={() => (open = true)}
    onblur={() => (open = false)}>{n}</button
  >
  {#if open}
    <span class="pop" role="tooltip" {id}>
      <span class="src">{source} <span class="where">{where}</span></span>
      <span class="ex">«{excerpt}»</span>
    </span>
  {/if}
</span>

<style>
  .cite {
    position: relative;
    display: inline-block;
  }
  .chip {
    vertical-align: 0.35em;
    margin-left: 0.1rem;
    min-width: 1.15rem;
    height: 1.05rem;
    padding: 0 0.25rem;
    border: 0;
    border-radius: 4px;
    background: var(--idle-soft);
    color: var(--idle-ink);
    font-size: 0.68rem;
    font-weight: 650;
    line-height: 1.05rem;
    cursor: help;
  }
  .chip:hover,
  .chip[aria-expanded="true"] {
    background: var(--idle);
    color: var(--ink-0);
  }
  .pop {
    position: absolute;
    z-index: 10;
    left: 50%;
    bottom: calc(100% + 0.4rem);
    transform: translateX(-50%);
    width: 22rem;
    max-width: 80vw;
    display: grid;
    gap: 0.35rem;
    padding: 0.65rem 0.75rem;
    border-radius: var(--r-control);
    background: var(--ink-1);
    border: 1px solid var(--line-strong);
    box-shadow: 0 10px 30px rgba(var(--lo), calc(0.25 * var(--lo-k) + 0.1));
    font-size: var(--fs-sm);
    line-height: 1.45;
    text-align: left;
  }
  .src {
    font-weight: 600;
  }
  .where {
    font-weight: 400;
    color: var(--text-dim);
  }
  .ex {
    color: var(--text-muted);
  }
</style>
