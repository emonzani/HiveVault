<script lang="ts">
  import Citation from "./Citation.svelte";
  import ClassTag from "./ClassTag.svelte";
</script>

<!-- A compiled entity page as the vault shows it: compiled truth first, then the evidence. -->
<article class="page">
  <header class="meta">
    <div class="crumbs"><span>Alveare</span><span aria-hidden="true">/</span><span>Clienti</span></div>
    <h1>Alpi Sanità S.p.A.</h1>
    <div class="facts">
      <ClassTag level="interno" />
      <span class="agent" title="Un account MCP con clearance interno può leggere questa pagina">Consultabile dall'agente cloud</span>
      <span class="dim tabular">aggiornata il 26/10/2026</span>
      <span class="dim prov-machine">ent_01JB8K3QW7</span>
    </div>
  </header>

  <p class="tldr prov-compiled">
    Cliente del settore sanitario dal 2025, con 250 postazioni di <a class="wl" href="#atlas">Company example 2</a>. Il contratto si rinnova
    l'8 aprile 2026; il referente tecnico è <a class="wl" href="#marino">Nome CognomeCCC</a>.
  </p>

  <section>
    <h2>Stato attuale</h2>
    <ul class="prov-compiled">
      <li>
        Abbonamento a <a class="wl" href="#atlas">Company example 2</a> per 250 postazioni, 31 € al mese ciascuna<Citation
          n={1}
          source="Offerta 412/2025.txt"
          where="punti 2–3"
          excerpt="Numero di postazioni: 250. Canone per postazione: 31,00 EUR al mese, IVA esclusa."
        />
      </li>
      <li>
        Scadenza del contratto: 8 aprile 2026, rinnovo tacito<Citation
          n={2}
          source="Firma contratto Company example 2.eml"
          where="31/05/2025"
          excerpt="Il contratto scade il 08/04/2026 e si rinnova in automatico."
        />
      </li>
      <li>
        Referente tecnico: <a class="wl" href="#marino">Nome CognomeCCC</a>, responsabile IT; acquisti:
        <a class="wl" href="#persona-hhh">Nome CognomeHHH</a><Citation
          n={2}
          source="Firma contratto Company example 2.eml"
          where="31/05/2025"
          excerpt="Per gli aspetti tecnici il vostro riferimento sarà Nome CognomeCCC, nostro responsabile IT."
        />
      </li>
    </ul>
  </section>

  <aside class="callout conflict" aria-label="Contraddizione da verificare">
    <h3>Due fonti non concordano sulla consegna del <a class="wl" href="#cometa">Progetto Cometa</a></h3>
    <p class="prov-compiled">
      Il verbale di kickoff indica il 14 novembre 2025<Citation n={3} source="Verbale kickoff Cometa.md" where="Pianificazione" excerpt="Consegna prevista: 14/11/2025" />,
      un'email successiva il 31 ottobre<Citation n={4} source="Re: stato avanzamento Progetto Cometa.eml" where="12/10/2025" excerpt="Confermiamo la consegna per il 31/10/2025." />.
    </p>
    <div class="actions">
      <button type="button" class="link">Apri il confronto</button>
      <button type="button" class="link">Segna come risolta</button>
    </div>
  </aside>

  <section>
    <h2>Timeline</h2>
    <ol class="timeline prov-compiled">
      <li><time datetime="2025-12-04">04/12/2025</time><span>Ampliamento a 250 postazioni dopo l'apertura della sede di Verona</span></li>
      <li><time datetime="2025-05-31">31/05/2025</time><span>Firma del contratto per <a class="wl" href="#atlas">Company example 2</a></span></li>
      <li><time datetime="2025-04-22">22/04/2025</time><span>Offerta commerciale per 175 postazioni</span></li>
    </ol>
  </section>

  <section class="note">
    <h2>Nota di <span class="who">Nome CognomeBBB</span></h2>
    <p class="prov-human">Nome CognomeHHH preferisce le call il martedì mattina. Prima del rinnovo chiedere il budget per il modulo HR.</p>
  </section>
</article>

<style>
  .page {
    max-width: var(--measure);
    display: grid;
    gap: 1.6rem;
    font-size: var(--fs-lg);
    line-height: 1.6;
  }
  .meta {
    display: grid;
    gap: 0.45rem;
  }
  .crumbs {
    display: flex;
    gap: 0.4rem;
    font-size: var(--fs-sm);
    color: var(--text-dim);
  }
  h1 {
    font-size: var(--fs-2xl);
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.8rem;
    font-size: var(--fs-xs);
  }
  .agent {
    color: var(--accent-blue);
    font-weight: 560;
  }
  .dim {
    color: var(--text-dim);
  }
  .tldr {
    font-size: var(--fs-xl);
    line-height: 1.45;
    color: var(--text-main);
    padding-left: 1rem;
    border-left: 3px solid var(--busy);
  }
  h2 {
    font-size: var(--fs-md);
    font-weight: 650;
    margin-bottom: 0.5rem;
  }
  ul {
    display: grid;
    gap: 0.45rem;
    padding-left: 1.1rem;
  }
  .wl {
    color: var(--link);
    text-decoration: none;
    background: linear-gradient(currentColor, currentColor) 0 100% / 100% 1px no-repeat;
    background-image: linear-gradient(color-mix(in srgb, currentColor 35%, transparent), color-mix(in srgb, currentColor 35%, transparent));
  }
  .wl:hover {
    background-image: linear-gradient(currentColor, currentColor);
  }
  .callout {
    border-radius: var(--r-panel);
    padding: 0.9rem 1rem;
    display: grid;
    gap: 0.5rem;
    font-size: var(--fs-md);
  }
  .conflict {
    background: var(--you-soft);
    border: 1px solid var(--you-line);
  }
  .conflict h3 {
    font-size: var(--fs-md);
    color: var(--you-ink);
  }
  .actions {
    display: flex;
    gap: 1rem;
  }
  .link {
    border: 0;
    background: none;
    color: var(--you-ink);
    font-weight: 600;
    font-size: var(--fs-sm);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
  .timeline {
    list-style: none;
    display: grid;
    gap: 0;
    font-size: var(--fs-md);
  }
  .timeline li {
    display: grid;
    grid-template-columns: 6.5rem 1fr;
    gap: 1rem;
    padding: 0.45rem 0;
    border-top: 1px solid var(--line);
  }
  .timeline time {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .note {
    padding: 0.9rem 1rem;
    border-radius: var(--r-panel);
    background: var(--ink-2);
  }
  .note h2 {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    font-weight: 560;
  }
  .who {
    color: var(--text-main);
  }
  .note p {
    font-size: var(--fs-lg);
  }
</style>
