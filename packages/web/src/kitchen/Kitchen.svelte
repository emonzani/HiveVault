<script lang="ts">
  import Button from "../components/Button.svelte";
  import ClassTag from "../components/ClassTag.svelte";
  import CoverageBar from "../components/CoverageBar.svelte";
  import PageSpecimen from "../components/PageSpecimen.svelte";
  import StatPanel from "../components/StatPanel.svelte";
  import ThemePicker from "../components/ThemePicker.svelte";

  const sections = [
    { id: "pagina", label: "Pagina compilata" },
    { id: "ricerca", label: "Risultati di ricerca" },
    { id: "controlli", label: "Controlli e moduli" },
    { id: "stati", label: "Stati e classificazioni" },
    { id: "dashboard", label: "Pannelli dashboard" },
    { id: "tabella", label: "Tabelle" },
    { id: "tipografia", label: "Tipografia" },
    { id: "palette", label: "Colori del tema" },
  ];

  const results = [
    {
      title: "Alpi Sanità S.p.A.",
      kind: "Entità · cliente",
      level: "I3",
      tokens: 742,
      snippet: "Abbonamento a Company example 2 per <mark>250 postazioni</mark>, 31 € al mese ciascuna. Scadenza del contratto: 8 aprile 2026.",
    },
    {
      title: "Re: ampliamento postazioni Company example 2",
      kind: "Email · 04/12/2025",
      level: "I2",
      tokens: 188,
      snippet: "…portiamo le <mark>postazioni</mark> di Company example 2 da 175 a <mark>250</mark>, con decorrenza dal mese prossimo.",
    },
    {
      title: "ordini-2026-Q1.csv",
      kind: "Foglio · 214 righe",
      level: "I1",
      tokens: 3410,
      snippet: "2026-02-11; Alpi Sanità S.p.A.; Company example 2; <mark>250</mark>; 23.250,00",
    },
  ];

  const users = [
    { name: "Nome CognomeBBB", email: "nome.cognomebbb@company-example-1.example", role: "Curatrice", access: "TOTP · passkey", last: "oggi, 09:12", state: "attivo" },
    { name: "Nome CognomeGGG", email: "nome.cognomeggg@company-example-1.example", role: "Membro", access: "passkey", last: "ieri, 18:40", state: "attivo" },
    { name: "agente-cloud-vendite", email: "account API · clearance interno", role: "API", access: "chiave · scade 31/03/2027", last: "oggi, 10:03", state: "attivo" },
    { name: "Nome CognomeFFF", email: "nome.cognomefff@company-example-1.example", role: "Membro", access: "TOTP", last: "12/09/2026", state: "sospeso" },
  ];

  const tokens = ["--ink-0", "--ink-1", "--ink-2", "--ink-3", "--you", "--busy", "--idle", "--alert", "--accent-purple", "--accent-blue", "--series-1", "--series-2"];
  const wave = (n: number, base: number, amp: number, seed: number) =>
    Array.from({ length: n }, (_, i) => Math.max(0, base + amp * Math.sin(i / 3 + seed) + amp * 0.4 * Math.sin(i * 1.7 + seed * 2)));

  let query = $state("postazioni Alpi Sanità");
  let email = $state("nome.cognomebbb@");
  const emailError = $derived(email.length > 0 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? "Scrivi un indirizzo completo, per esempio nome@azienda.it" : "");
  let saving = $state(false);
  let rerank = $state(true);
</script>

<div class="shell">
  <header class="top">
    <a class="brand" href="#pagina"><span class="mark" aria-hidden="true"></span>HiveVault</a>
    <label class="search">
      <span class="visually-hidden">Cerca nella memoria</span>
      <input type="search" bind:value={query} placeholder="Cerca in tutte le memorie a cui hai accesso" />
      <kbd>Ctrl K</kbd>
    </label>
    <ThemePicker />
  </header>

  <nav class="rail" aria-label="Sezioni del kitchen sink">
    <p class="rail-title">Kitchen sink</p>
    <ul>
      {#each sections as s (s.id)}
        <li><a href="#{s.id}">{s.label}</a></li>
      {/each}
    </ul>
    <p class="rail-foot">Fase 0 · design system.</p>
  </nav>

  <main>
    <section id="pagina" class="block">
      <PageSpecimen />
    </section>

    <section id="ricerca" class="block">
      <h2 class="block-title">Risultati di ricerca</h2>
      <p class="lead">Ogni risultato dice quanto è elaborato il documento e quanti token costa leggerlo.</p>
      <ol class="results">
        {#each results as r (r.title)}
          <li>
            <div class="r-head">
              <a href="#pagina" class="r-title">{r.title}</a>
              <span class="lvl {r.level}" title={r.level === "I3" ? "Compilato nel wiki" : r.level === "I2" ? "Cercabile per significato" : "Cercabile per parole chiave"}>{r.level}</span>
            </div>
            <p class="r-snippet">{@html r.snippet}</p>
            <p class="r-meta"><span>{r.kind}</span><span class="tabular">{r.tokens.toLocaleString("it-IT")} token</span></p>
          </li>
        {/each}
      </ol>
    </section>

    <section id="controlli" class="block">
      <h2 class="block-title">Controlli e moduli</h2>
      <div class="row">
        <Button variant="primary">Carica documenti</Button>
        <Button>Esporta il vault</Button>
        <Button variant="quiet">Annulla</Button>
        <Button variant="danger">Revoca la chiave</Button>
        <Button variant="primary" busy={saving} onclick={() => ((saving = true), setTimeout(() => (saving = false), 1500))}>
          {saving ? "Salvataggio" : "Salva le modifiche"}
        </Button>
        <Button size="sm">Piccolo</Button>
      </div>
      <form class="form" onsubmit={(e) => e.preventDefault()}>
        <label class="field">
          <span class="label">Email di accesso</span>
          <input type="email" bind:value={email} aria-invalid={emailError ? "true" : undefined} aria-describedby="email-msg" />
          <span id="email-msg" class="msg" class:error={!!emailError}>{emailError || "Ricevi il QR code TOTP a questo indirizzo"}</span>
        </label>
        <label class="field">
          <span class="label">Classificazione predefinita</span>
          <select>
            <option>interno</option>
            <option>pubblico</option>
            <option>riservato</option>
            <option>segreto</option>
          </select>
          <span class="msg">Vale per i documenti nuovi di questo spazio</span>
        </label>
        <label class="toggle">
          <input type="checkbox" role="switch" bind:checked={rerank} />
          <span class="track" aria-hidden="true"><span class="thumb"></span></span>
          <span>Riordina i risultati con il reranker {rerank ? "(attivo)" : "(spento)"}</span>
        </label>
      </form>
    </section>

    <section id="stati" class="block">
      <h2 class="block-title">Stati e classificazioni</h2>
      <div class="row">
        <ClassTag level="pubblico" />
        <ClassTag level="interno" />
        <ClassTag level="riservato" />
        <ClassTag level="segreto" />
      </div>
      <ul class="states">
        <li><span class="dot you"></span>Serve la tua attenzione: conflitti, revisioni, approvazioni</li>
        <li><span class="dot busy"></span>In elaborazione: parsing, embedding, compilazione</li>
        <li><span class="dot idle"></span>Disponibile, nessuna azione richiesta</li>
        <li><span class="dot alert"></span>Errore: un parser ha fallito o un endpoint non risponde</li>
      </ul>
    </section>

    <section id="dashboard" class="block">
      <h2 class="block-title">Pannelli dashboard</h2>
      <div class="panels">
        <StatPanel title="Latenza ricerca p95" value="184" unit="ms" series={wave(36, 150, 30, 1)} threshold={200} note="Ultime 24 ore · soglia 200 ms" />
        <StatPanel title="Coda di compilazione" value="12.480" unit="documenti" series={wave(36, 9000, 2500, 2).map((v, i) => v + i * 120)} status="warn" threshold={10000} note="Cresce da 6 ore: la GPU serve le query interattive" />
        <StatPanel title="Embedding al secondo" value="1.920" unit="token/s" series={wave(36, 1800, 300, 3)} note="Locale 640 · remoti 1.280" />
      </div>
      <div class="coverage">
        <CoverageBar name="Clienti" total={48210} i3={9120} i2={30450} i1={8640} />
        <CoverageBar name="Progetti" total={12740} i3={6800} i2={5100} i1={840} />
        <CoverageBar name="Archivio email 2019–2024" total={1268400} i3={4100} i2={212000} i1={1052300} />
      </div>
    </section>

    <section id="tabella" class="block">
      <h2 class="block-title">Tabelle</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">Account</th><th scope="col">Ruolo</th><th scope="col">Accesso</th><th scope="col">Ultimo accesso</th><th scope="col">Stato</th></tr>
          </thead>
          <tbody>
            {#each users as u (u.name)}
              <tr>
                <td><span class="u-name">{u.name}</span><span class="u-sub">{u.email}</span></td>
                <td>{u.role}</td>
                <td>{u.access}</td>
                <td class="tabular">{u.last}</td>
                <td><span class="st {u.state}">{u.state}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section id="tipografia" class="block">
      <h2 class="block-title">Tipografia</h2>
      <p class="lead">Due caratteri: Plus Jakarta Sans per l'interfaccia e il testo, JetBrains Mono per quello che genera il sistema (id, citazioni, token).</p>
      <dl class="prov">
        <div><dt>Compilato dal brain</dt><dd class="prov-compiled">Il contratto si rinnova l'8 aprile 2026 per 250 postazioni.</dd></div>
        <div><dt>Scritto da una persona</dt><dd class="prov-human">Nome CognomeHHH preferisce le call il martedì mattina.</dd></div>
        <div><dt>Generato dal sistema</dt><dd class="prov-machine">src_7f3a91bc#c12 · ent_01JB8K3QW7</dd></div>
      </dl>
      <div class="scale">
        <p style:font-size="var(--fs-2xl)">28 — Titolo di pagina</p>
        <p style:font-size="var(--fs-xl)">21 — TL;DR della pagina</p>
        <p style:font-size="var(--fs-lg)">17 — Colonna di lettura</p>
        <p style:font-size="var(--fs-md)">15 — Interfaccia</p>
        <p style:font-size="var(--fs-xs)">13 — Metadati e legende</p>
      </div>
    </section>

    <section id="palette" class="block">
      <h2 class="block-title">Colori del tema</h2>
      <ul class="swatches">
        {#each tokens as t (t)}
          <li><span class="sw" style:background="var({t})"></span><code class="prov-machine">{t}</code></li>
        {/each}
      </ul>
    </section>
  </main>

  <aside class="inspector" aria-label="Proprietà della pagina">
    <section>
      <h2>Proprietà</h2>
      <dl class="props">
        <dt>Tipo</dt><dd>Entità · azienda</dd>
        <dt>Visibilità</dt><dd>Azienda</dd>
        <dt>Fonti</dt><dd class="tabular">7 documenti</dd>
        <dt>Affidabilità</dt><dd class="tabular">0,86</dd>
        <dt>Lunghezza</dt><dd class="tabular">742 token</dd>
      </dl>
    </section>
    <section>
      <h2>Backlink <span class="count">5</span></h2>
      <ul class="links">
        <li><a href="#pagina">Progetto Cometa</a></li>
        <li><a href="#pagina">Nome CognomeCCC</a></li>
        <li><a href="#pagina">Company example 2</a></li>
        <li><a href="#pagina">Rinnovi 2026</a></li>
        <li><a href="#pagina">Nome CognomeHHH</a></li>
      </ul>
    </section>
    <section>
      <h2>Copertura dello spazio</h2>
      <CoverageBar name="Clienti" total={48210} i3={9120} i2={30450} i1={8640} />
    </section>
  </aside>
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns: var(--rail-w) minmax(0, 1fr) var(--inspector-w);
    grid-template-rows: auto 1fr;
    grid-template-areas: "top top top" "rail main inspector";
    min-height: 100vh;
  }
  .top {
    grid-area: top;
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 1.25rem;
    padding: 0.6rem 1.25rem;
    background: var(--topbar-bg);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--line);
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    font-weight: 680;
    color: var(--text-main);
    text-decoration: none;
    width: calc(var(--rail-w) - 1.25rem);
  }
  .mark {
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 4px;
    background:
      radial-gradient(circle at 30% 30%, var(--you) 0 28%, transparent 30%),
      radial-gradient(circle at 70% 35%, var(--busy) 0 24%, transparent 26%),
      radial-gradient(circle at 45% 72%, var(--idle) 0 26%, transparent 28%),
      var(--ink-3);
  }
  .search {
    flex: 1;
    max-width: 42rem;
    position: relative;
  }
  .search input {
    width: 100%;
    padding: 0.5rem 4.5rem 0.5rem 0.85rem;
    border-radius: var(--r-control);
    border: 1px solid var(--line);
    background: var(--ink-1);
  }
  kbd {
    position: absolute;
    right: 0.6rem;
    top: 50%;
    transform: translateY(-50%);
    font: inherit;
    font-size: var(--fs-xs);
    color: var(--text-dim);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 0 0.35rem;
  }
  .top :global(.theme-picker) {
    margin-left: auto;
  }

  .rail {
    grid-area: rail;
    position: sticky;
    top: 3.4rem;
    align-self: start;
    height: calc(100vh - 3.4rem);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1.25rem 0.75rem;
    background: var(--sidebar-bg);
    border-right: 1px solid var(--line);
  }
  .rail-title {
    padding: 0 0.6rem;
    font-size: var(--fs-sm);
    font-weight: 650;
  }
  .rail ul {
    list-style: none;
    display: grid;
    gap: 1px;
  }
  .rail a {
    display: block;
    padding: 0.35rem 0.6rem;
    border-radius: 6px;
    color: var(--text-muted);
    text-decoration: none;
    font-size: var(--fs-sm);
  }
  .rail a:hover {
    background: color-mix(in srgb, var(--ink-1) 70%, transparent);
    color: var(--text-main);
  }
  .rail-foot {
    margin-top: auto;
    padding: 0 0.6rem;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  main {
    grid-area: main;
    padding: 2.5rem clamp(1.25rem, 4vw, 3.5rem) 6rem;
    display: grid;
    gap: 3.5rem;
    align-content: start;
  }
  .block {
    display: grid;
    gap: 1rem;
    scroll-margin-top: 4.5rem;
  }
  .block + .block {
    padding-top: 2.5rem;
    border-top: 1px solid var(--line);
  }
  .block-title {
    font-size: var(--fs-xl);
  }
  .lead {
    color: var(--text-muted);
    max-width: var(--measure);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: center;
  }

  .results {
    list-style: none;
    max-width: var(--measure);
    display: grid;
  }
  .results li {
    padding: 0.85rem 0;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 0.25rem;
  }
  .r-head {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }
  .r-title {
    font-weight: 620;
    color: var(--text-main);
    text-decoration: none;
  }
  .r-title:hover {
    text-decoration: underline;
  }
  .r-snippet {
    color: var(--text-muted);
  }
  .r-snippet :global(mark) {
    background: var(--you-mark);
    color: inherit;
    border-radius: 2px;
    padding: 0 0.1em;
  }
  .r-meta {
    display: flex;
    gap: 1rem;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .lvl {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0 0.35rem;
    border-radius: 4px;
    font-family: var(--font-mono);
  }
  .lvl.I3 {
    background: var(--busy-ink);
    color: var(--ink-1);
  }
  .lvl.I2 {
    background: var(--busy-soft);
    color: var(--busy-ink);
  }
  .lvl.I1 {
    background: var(--idle-soft);
    color: var(--idle-ink);
  }

  .form {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: 1rem 1.5rem;
    max-width: 52rem;
  }
  .field {
    display: grid;
    gap: 0.3rem;
  }
  .label {
    font-size: var(--fs-sm);
    font-weight: 560;
  }
  .field input,
  .field select {
    padding: 0.5rem 0.7rem;
    border-radius: var(--r-control);
    border: 1px solid var(--line-strong);
    background: var(--ink-1);
  }
  .field input[aria-invalid="true"] {
    border-color: var(--alert-ink);
  }
  .msg {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .msg.error {
    color: var(--alert-ink);
  }
  .toggle {
    grid-column: 1 / -1;
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
    cursor: pointer;
    font-size: var(--fs-sm);
  }
  .toggle input {
    position: absolute;
    opacity: 0;
  }
  .track {
    width: 2.1rem;
    height: 1.2rem;
    border-radius: var(--r-pill);
    background: var(--ink-3);
    position: relative;
    transition: background-color var(--transition-fast);
  }
  .thumb {
    position: absolute;
    top: 0.15rem;
    left: 0.15rem;
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 50%;
    background: var(--text-main);
    transition: transform var(--transition-fast);
  }
  .toggle input:checked + .track {
    background: var(--busy-ink);
  }
  .toggle input:checked + .track .thumb {
    transform: translateX(0.9rem);
    background: var(--ink-1);
  }
  .toggle input:focus-visible + .track {
    outline: 2px solid var(--you);
    outline-offset: 2px;
  }

  .states {
    list-style: none;
    display: grid;
    gap: 0.4rem;
    font-size: var(--fs-sm);
  }
  .dot {
    display: inline-block;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    margin-right: 0.55rem;
  }
  .dot.you {
    background: var(--you);
  }
  .dot.busy {
    background: var(--busy);
  }
  .dot.idle {
    background: var(--idle);
  }
  .dot.alert {
    background: var(--alert);
  }

  .panels {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.75rem;
  }
  .coverage {
    display: grid;
    gap: 1.1rem;
    max-width: 40rem;
    margin-top: 0.5rem;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: var(--r-panel);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-sm);
  }
  th {
    text-align: left;
    font-weight: 560;
    color: var(--text-muted);
    background: var(--ink-1);
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--line);
  }
  td {
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  tbody tr:last-child td {
    border-bottom: 0;
  }
  tbody tr:hover {
    background: color-mix(in srgb, var(--ink-2) 55%, transparent);
  }
  .u-name {
    display: block;
    font-weight: 560;
  }
  .u-sub {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }
  .st {
    font-size: var(--fs-xs);
    padding: 0.05rem 0.5rem;
    border-radius: var(--r-pill);
  }
  .st.attivo {
    background: var(--busy-soft);
    color: var(--busy-ink);
  }
  .st.sospeso {
    background: var(--ink-3);
    color: var(--text-muted);
  }

  .prov {
    display: grid;
    gap: 0.8rem;
    max-width: var(--measure);
  }
  .prov div {
    display: grid;
    grid-template-columns: 12rem 1fr;
    gap: 1rem;
    align-items: baseline;
  }
  .prov dt {
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .prov dd {
    font-size: var(--fs-xl);
  }
  .scale {
    display: grid;
    gap: 0.3rem;
    padding-top: 0.5rem;
  }

  .swatches {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
    gap: 0.6rem;
  }
  .swatches li {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-size: var(--fs-xs);
  }
  .sw {
    width: 2rem;
    height: 2rem;
    border-radius: 6px;
    box-shadow: inset 0 0 0 1px var(--line-strong);
  }

  .inspector {
    grid-area: inspector;
    position: sticky;
    top: 3.4rem;
    align-self: start;
    height: calc(100vh - 3.4rem);
    overflow-y: auto;
    padding: 2.5rem 1.25rem;
    border-left: 1px solid var(--line);
    display: grid;
    gap: 2rem;
    align-content: start;
  }
  .inspector h2 {
    font-size: var(--fs-sm);
    font-weight: 650;
    margin-bottom: 0.6rem;
  }
  .count {
    color: var(--text-dim);
    font-weight: 500;
    margin-left: 0.25rem;
  }
  .props {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.35rem 1rem;
    font-size: var(--fs-sm);
  }
  .props dt {
    color: var(--text-dim);
  }
  .links {
    list-style: none;
    display: grid;
    gap: 0.3rem;
    font-size: var(--fs-sm);
  }
  .links a {
    color: var(--accent-purple);
    text-decoration: none;
  }
  .links a:hover {
    text-decoration: underline;
  }

  @media (max-width: 1180px) {
    .shell {
      grid-template-columns: var(--rail-w) minmax(0, 1fr);
      grid-template-areas: "top top" "rail main";
    }
    .inspector {
      display: none;
    }
  }
  @media (max-width: 760px) {
    .shell {
      grid-template-columns: 1fr;
      grid-template-areas: "top" "main";
    }
    .rail {
      display: none;
    }
    .brand {
      width: auto;
    }
    .top {
      flex-wrap: wrap;
    }
    .search {
      order: 3;
      flex-basis: 100%;
    }
    .prov div {
      grid-template-columns: 1fr;
      gap: 0.2rem;
    }
  }
</style>
