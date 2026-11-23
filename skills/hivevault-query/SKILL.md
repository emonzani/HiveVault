---
name: hivevault-query
description: Answer questions from the company memory (HiveVault) through its MCP tools - clients, people, projects, decisions, contracts, what changed and when. Use when the user asks what the company knows about someone or something, the current state of a client or project, who decided what, or wants a meeting brief, and the hivevault MCP server is connected.
---

# Query HiveVault

HiveVault is the self-hosted memory of the company. Documents (PDF, email, Office, web pages) stay on the company server; local models compile them into linked Markdown pages. Every statement of a compiled page cites its source. You reach the memory through the MCP server `hivevault`.

## What you can see

- Only pages classified **pubblico** or **interno**, in the vaults granted to the API account. Pages **riservato** and **segreto** never reach you, and original files never leave the server.
- A missing answer can mean "not in the memory" or "not visible to this account". Say "la memoria non lo contiene (o non è visibile a questo account)"; never guess.

## Workflow

1. **Orientation (once per conversation).** `brain_overview` lists the vaults (cells of people, hive spaces of the company), page counts and coverage. Skip it when you already know where to look.
2. **Find.** `brain_search` with the question or with names. Each result has an id, a type, a level (I1 keywords, I2 meaning, I3 compiled page), a summary, snippets with citations and its cost in tokens. Prefer I3 pages: they hold the current state.
   - A result marked **"non ancora compilato"** (or **"documento recente, non ancora compilato"**) is a document that no page includes yet. Read it with `brain_read("src_…", query=…)` before you say that the memory does not contain something, and before you give the current state of its subject: it can be newer than the pages.
3. **Read with a budget.** `brain_read(id, max_tokens=1500)`. A page comes in this order: summary, "Stato attuale" (the current truth), sections that match `query`, the newest part of "Timeline". The answer lists the sections left out with their cost: ask for them with `sections` only if needed.
4. **Check freshness.** When `brain_read` starts with **"Attenzione: … documenti più recenti della pagina"**, documents newer than the page name its subject and the page does not cite them. Read them (`brain_read("src_…", query=<the subject>)`) before you give the current state as certain. When they change a value, give the newer value with its source and say that the page is older.
5. **Relations and history.** `brain_neighbors` for who works with whom, projects of a client, pages that cite a page. `brain_timeline(entity)` for dated events, newest first.
6. **Verify.** `brain_source("src_…#c3")` returns the extracted text of a cited passage. Use it before you state a number, a date or a commitment that matters.
7. **Short factual questions.** `brain_ask` lets the local model answer from the best pages, with citations. Check important points with step 6.
8. **Check a statement.** `brain_verify(claim)` gives a verdict (supportata, in parte, contraddetta, non verificabile) with the citations for and against. It also searches the subject without the values of the statement, to find sources that say something else. Check the citations with step 6 before you rely on the verdict.

`brain_read` and `brain_search` give the **reliability** of a page: "alta", "media" or "bassa", with the cited sources, open conflicts, the confirmation by a person and the review date. For a page with "bassa" or "da ricontrollare", verify the points you use with step 6 and say that the page may be old.

Budget rule of thumb: one search (≤ 2000 tokens), then two or three reads at 1000–1500 tokens. Do not read whole pages "just in case".

## How to answer

- Cite every fact with the id returned by the tools, in the same form: `^[ent_01…#stato-attuale]` or `^[src_01…#c3]`.
- Current state comes from "Stato attuale"; the "Timeline" is history. When they disagree, the current state wins, and you can mention the change with its date.
- A `> [!conflict]` block or a hive page with "fonti discordanti" means the sources disagree: give both values with their sources, do not pick one silently.
- Pages marked "Alveare" merge what several people wrote; their citations point to pages in the cells of those people.
- Write in the user's language. Keep names, amounts and dates exactly as in the sources.

## Give back to the memory

- `brain_capture(title, content)` saves a useful synthesis (for example a meeting brief you prepared) in the inbox of the account's writable vault, with its citations. Do it only when the user asks or agrees. With `compile: true` the note goes to ingestion and becomes compiled pages; this is the default in project vaults. With `compile: false` it stays a note in the inbox.
- `brain_journal(action)` is the work journal. At the start of a session, `leggi` tells where the work stopped and what is open. At the end, when the user agrees, `sessione` writes Fatto, Deciso, Aperto with `links` to the real pages touched (find them with `brain_search`; never invent one). The prompts `buongiorno`, `chiudi-sessione` and `fine-giornata` run these steps.
- `brain_propose_edit(page, section, text, rationale)` proposes a correction. A person approves it in the curator queue; until then the page does not change. Never claim that a page was changed by a proposal.
- These tools need the `write` scope; a read-only account gets an error: tell the user. A key with `read` and `projects` can use `brain_capture` only in project vaults. For the six documentation sections of a project vault, use the skill `hivevault-project-docs`.

## Prompts

The server offers ready prompts: `cosa-sappiamo-di` (argomento), `stato-cliente` (cliente), `prepara-riunione` (con, argomento), and for the work journal `buongiorno`, `chiudi-sessione`, `fine-giornata`.

## Resources

`brain://<vault>/llms.txt` and `brain://<vault>/index` are compact maps of a vault (titles, ids, summaries, cost), most important pages first. Read one when the user asks for an overview of a whole area.

`brain://<vault>/changes?since=<ISO date or time>` lists the pages written and the documents added since that time (default: the last 24 hours), newest first. It ends with the address of the next read (`since=` the time of this read). In a recurring session (a daily brief, a follow-up of a project), read it first and keep the address it gives for the next session, then read only the pages that changed.
