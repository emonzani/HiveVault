# Agent skills and plugin for HiveVault

These skills teach a cloud agent (coding agent, desktop or web assistant with MCP support) to use a HiveVault server. They do not change the server.

| Skill | The agent can then |
|---|---|
| [`hivevault-query`](hivevault-query/SKILL.md) | Answer from the company memory with the MCP tools: search, read with a budget, links, timeline, citations; save notes and propose edits |
| [`hivevault-ingest`](hivevault-ingest/SKILL.md) | Load files and links into a vault and follow their processing (`scripts/brain.mjs`, Node.js 18+, no packages) |
| [`hivevault-project-docs`](hivevault-project-docs/SKILL.md) | Read and rewrite the six documentation sections of a project vault (`project_doc_read` / `project_doc_write`, or `/api/projects`), and save project notes |

## Coding agent mod `hivevault-progetti`

The mod gives a coding agent one project vault per repository. It creates the vault, puts the summary of each section in the system prompt, updates the sections in the background after each commit, and shows the state of the vault above the prompt. Its MCP server `docs` forwards the `brain_*` tools of the server and adds `project_doc_read` and `project_doc_write`. It needs an API account with the scopes `read` and `projects`, bound to the person:

```bash
npm run -s cb -- api create coding-agent-name.surname --scopes read,projects --user name.surname > key.txt
```

## Agent client with plugins (MCP server + skills)

The repository is a plugin marketplace for agent clients that support plugins. Set the server address and an API key, then install:

```bash
export HIVEVAULT_URL=https://brain.example.local
export HIVEVAULT_API_KEY=cb_...
```

```
/plugin marketplace add <git-url-or-local-path-of-this-repository>
/plugin install hivevault@hivevault
```

The plugin registers the MCP server `hivevault` (`$HIVEVAULT_URL/mcp`, header `Authorization: Bearer $HIVEVAULT_API_KEY`) and the three skills.

## Other clients

Any MCP client with streamable HTTP works: URL `https://<server>/mcp`, header `Authorization: Bearer <API key>`. The administrator creates the API account (scope `read`; `write` for notes and proposals; `ingest` for uploads; `projects` for the documentation of project vaults), grants it the vaults and gives it a key.

The cloud agent reads only pages classified `pubblico` or `interno`, whatever the clearance of the account. Every read is in the audit log; people see the reads of their own pages in "Cosa ha letto l'agente cloud".
