---
name: hivevault-project-docs
description: Keep the documentation of a software project in its HiveVault project vault - six sections (specifiche, analisi funzionale, analisi tecnica, analisi architetturale, indice del codice, documenti) read before work and rewritten from the code. Use when a coding agent works on a repository that has a project vault, the tools project_doc_read / project_doc_write are available (for example from the hivevault-progetti mod), or the user asks to update the project documentation.
---

# Project documentation in HiveVault

Every project that a coding agent follows has one vault in HiveVault (owner `project:<slug>`). The vault holds six fixed pages under `progetto/` and an inbox for notes. The slug is the name of the git remote `origin`, or else the folder name.

| Section | Content |
|---|---|
| `specifiche` | requirements, constraints, acceptance criteria |
| `analisi-funzionale` | actors, use cases, flows, business rules |
| `analisi-tecnica` | stack, modules, data, interfaces, technical choices and reasons |
| `analisi-architetturale` | components, boundaries, flows between services, deployment, invariants |
| `indice-codice` | map of folders and main files, entry points, where things are |
| `documenti` | project documents and where to find them, one line each |

## Access

- With the `hivevault-progetti` mod, the MCP server `docs` gives `project_doc_read`, `project_doc_write` and all `brain_*` tools of the server. The mod creates the vault, puts the summary of each section in the system prompt and says which sections are behind `HEAD`.
- Without the mod, use the REST API with an API key: `GET /api/projects/<slug>` (sections, summaries, versions, commits), `GET` and `PUT /api/projects/<slug>/docs/<section>`, `POST /api/projects` (`slug`, `name`) to create the vault.
- The API account needs the scope `projects` to write sections, and `read` to use MCP. A key bound to a person reads only what that person reads, never above `interno`, never the personal vaults.

## Read before you work

1. Read the summaries (system prompt or `GET /api/projects/<slug>`).
2. Read with `project_doc_read(section)` only the sections that matter for the task: `indice-codice` to find files, `analisi-architetturale` before a change across components, `specifiche` before a change of behavior.
3. A section marked behind `HEAD` can be wrong about the files of the newer commits. Trust the code over the section.

## Write a section

Write only when the user asks, or when the mod starts a documentation update after a commit.

1. `project_doc_read(section)` and keep its `version`. A missing section has no version.
2. Explore the code. Write the **full** section, not a diff: real names of files, types, functions, fields, commands and values, exact numbers, examples from the repository. Another developer must be able to work from the section without the code.
3. `project_doc_write(section, markdown, summary, baseVersion)`. `summary` is one sentence that the next session reads first. The section records the commit `HEAD`.
4. A conflict means that someone changed the section after your read. Read it again and write on top of the new version. Never overwrite the work of a person.

Rules:

- No credentials, keys, personal data, or content of `.env` files.
- Paths in backticks in `indice-codice` must exist: the mod checks them and names the missing ones.
- Markdown without frontmatter. Headings and tables are fine. Do not invent facts that the code does not show.

## Memory around the project

- `brain_search` and `brain_read` reach the project vault and the other project vaults that the person can read: use them to find an analysis or a decision of a similar project.
- `brain_capture(title, content, vault=<slug>)` writes a note into the inbox of the project vault. In project vaults the default is `compile: true`: HiveVault compiles the note into pages (concepts, decisions) with citations, and the dream cycle links them. Use it for a decision and its reason, or a finding that does not belong in the six sections. Do it only when the user asks or agrees.
- The cloud agent never edits other pages directly. To correct a compiled page use `brain_propose_edit` (scope `write`), which waits for a person.
