/**
 * Project documentation written by coding agents (through the
 * "hivevault-progetti" mod): one cell vault per software project, owner "project:<slug>",
 * with six fixed sections kept up to date by the agent that works on the code.
 *
 * Only API accounts with the scope "projects" (and administrators) use these routes. The
 * scope gives write permission on the vaults granted to the account, and nothing else: the
 * MCP server, search and the editor need the scope "read". Writes go only to the six pages
 * under `progetto/` of a project vault (invariant 16 still holds for MCP); a page a person
 * changed after the agent read it is refused (409) until the agent reads it again.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Access, AuthError, type AuthService } from "@cb/auth";
import { extractCitations, PageStore, withReader, type VaultStore } from "@cb/brain";
import type { Sql } from "@cb/db";
import { SourceError, type IngestService } from "@cb/ingest";
import { meta, requireAuth } from "../http.ts";

/** The sections of a project vault: path under progetto/, title and what goes in it. */
export const PROJECT_SECTIONS = {
  specifiche: { title: "Specifiche", about: "requisiti, vincoli, criteri di accettazione" },
  "analisi-funzionale": { title: "Analisi funzionale", about: "attori, casi d'uso, flussi, regole di business" },
  "analisi-tecnica": { title: "Analisi tecnica", about: "stack, moduli, dati, interfacce, scelte tecniche e motivi" },
  "analisi-architetturale": { title: "Analisi architetturale", about: "componenti, confini, flussi tra servizi, deployment, invarianti" },
  "indice-codice": { title: "Indice del codice", about: "mappa di cartelle e file principali, punti di ingresso, dove sta cosa" },
  documenti: { title: "Documenti", about: "documenti del progetto e dove trovarli, con una riga su ciascuno" },
} as const;
export type ProjectSection = keyof typeof PROJECT_SECTIONS;
const SECTIONS = Object.keys(PROJECT_SECTIONS) as ProjectSection[];
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const pathOf = (s: ProjectSection) => `progetto/${s}.md`;
/** A repository file: a relative path, no "..", no drive, no backslash. */
const FILE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\:\0]{1,500}$/;
/** The largest repository file the mod sends (it reads at most 4 MiB). */
const FILE_MAX_BYTES = 4 * 1024 ** 2;

export function projectRoutes(app: FastifyInstance, sql: Sql, auth: AuthService, vaults: VaultStore, ingest?: IngestService): void {
  const pages = new PageStore(sql);

  /** API accounts need the scope "projects"; people need to be administrators. */
  function agent(req: FastifyRequest) {
    const a = requireAuth(req);
    if (a.principal.kind === "api" ? !a.principal.scopes.includes("projects") : !a.ctx.isAdmin) {
      throw new AuthError("forbidden", "Serve un account API con l'ambito «projects».");
    }
    return a;
  }

  /** The project vault and the caller's permission on it, or 404. */
  async function project(req: FastifyRequest, slug: string, need: "read" | "write") {
    const a = agent(req);
    const [v] = await sql<{ id: string; slug: string; name: string; owner: string | null }[]>`
      select id, slug, name, owner from vaults where slug = ${slug} and kind = 'cell'`;
    if (!v || !v.owner?.startsWith("project:")) throw new AuthError("not_found", "Progetto non trovato.");
    Access.require(a.ctx, need === "read" ? "vault.read" : "vault.write", v.id);
    return { a, v };
  }

  async function sectionPages(a: ReturnType<typeof agent>, vaultId: string) {
    return withReader(sql, Access.toReader(a.ctx, [vaultId]), (tx) => tx<{ path: string; title: string; tldr: string; version: number; tokens: number; updatedAt: Date; commit: string | null }[]>`
      select path, title, tldr, version, tokens, updated_at as "updatedAt", frontmatter->>'commit' as commit from pages where vault_id = ${vaultId} and path like 'progetto/%'`);
  }

  /** The vault and its six sections (missing ones say so): what a session reads first. */
  app.get<{ Params: { slug: string } }>("/api/projects/:slug", async (req) => {
    const { a, v } = await project(req, req.params.slug, "read");
    const byPath = new Map((await sectionPages(a, v.id)).map((p) => [p.path, p]));
    return {
      vault: { id: v.id, slug: v.slug, name: v.name },
      sections: SECTIONS.map((s) => {
        const p = byPath.get(pathOf(s));
        return { section: s, title: PROJECT_SECTIONS[s].title, about: PROJECT_SECTIONS[s].about, ...(p ? { tldr: p.tldr, version: p.version, tokens: p.tokens, updatedAt: p.updatedAt, ...(p.commit ? { commit: p.commit } : {}) } : { missing: true }) };
      }),
    };
  });

  /**
   * Creates the vault of a project (a cell owned by "project:<slug>") and grants the caller
   * write permission. Calling it again for an existing project the caller can write is a no-op.
   */
  app.post<{ Body: { slug: string; name: string } }>(
    "/api/projects",
    {
      schema: {
        body: {
          type: "object",
          required: ["slug", "name"],
          properties: { slug: { type: "string", pattern: SLUG.source }, name: { type: "string", minLength: 1, maxLength: 120 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const a = agent(req);
      const [found] = await sql<{ id: string; owner: string | null }[]>`select id, owner from vaults where slug = ${req.body.slug}`;
      if (found) {
        if (!found.owner?.startsWith("project:") || a.ctx.vaults.get(found.id) === undefined || a.ctx.vaults.get(found.id) === "read") {
          throw new AuthError("conflict", `Esiste già un vault «${req.body.slug}» che questo account non può scrivere.`);
        }
        return reply.status(200).send({ id: found.id, slug: req.body.slug, created: false });
      }
      const v = await vaults.create({ kind: "cell", slug: req.body.slug, name: req.body.name.trim(), owner: `project:${req.body.slug}` });
      if (a.principal.kind === "api") {
        await auth.access.grant(a.principal.id, v.id, "write", a.principal.id);
        // the person the key acts for sees and writes the project too (web interface, other keys)
        if (a.principal.userId) await auth.access.grant(a.principal.userId, v.id, "write", a.principal.id);
      }
      await auth.audit.writeNow({ principalId: a.principal.id, action: "project.create", resource: v.id, ...meta(req), data: { slug: v.slug, name: v.name } });
      return reply.status(201).send({ id: v.id, slug: v.slug, created: true });
    },
  );

  /**
   * The state of a project vault for the agent's panel: pages, documents in each ingestion
   * state, the work still queued, the last night cycle. Counts only: no titles, no text.
   */
  app.get<{ Params: { slug: string } }>("/api/projects/:slug/status", async (req) => {
    const { a, v } = await project(req, req.params.slug, "read");
    const reader = Access.toReader(a.ctx, [v.id]);
    const [pg] = await withReader(sql, reader, (tx) => tx<{ pages: number; inbox: number; sections: number; tokens: number; updatedAt: Date | null }[]>`
      select count(*)::int as pages, count(*) filter (where path like 'inbox/%')::int as inbox,
             count(*) filter (where path like 'progetto/%')::int as sections, coalesce(sum(tokens), 0)::int as tokens, max(updated_at) as "updatedAt"
      from pages where vault_id = ${v.id}`);
    const sources = await sql<{ status: string; n: number }[]>`
      select status, count(*)::int as n from sources where vault_id = ${v.id} and classification <> 4 and parent_id is null group by status`;
    const [work] = await sql<{ queued: number; running: number; failed: number }[]>`
      select count(*) filter (where t.status in ('queued', 'sleeping', 'waiting'))::int as queued,
             count(*) filter (where t.status = 'running')::int as running,
             count(*) filter (where t.status = 'failed' and t.updated_at > now() - interval '7 days')::int as failed
      from sources s join tasks t on t.id = s.task_id where s.vault_id = ${v.id} and s.classification <> 4`;
    const [dream] = await sql<{ night: string; status: string; step: string | null; startedAt: Date; finishedAt: Date | null; tokens: number }[]>`
      select night::text, status, step, started_at as "startedAt", finished_at as "finishedAt", tokens
      from dream_runs where vault_id = ${v.id} order by night desc limit 1`;
    const [today] = await sql<{ added: number }[]>`
      select count(*)::int as added from sources where vault_id = ${v.id} and classification <> 4 and created_at > now() - interval '24 hours'`;
    return {
      vault: { id: v.id, slug: v.slug, name: v.name },
      pages: pg ?? { pages: 0, inbox: 0, sections: 0, tokens: 0, updatedAt: null },
      sources: Object.fromEntries(sources.map((s) => [s.status, s.n])),
      sourcesLast24h: today?.added ?? 0,
      work: work ?? { queued: 0, running: 0, failed: 0 },
      dream: dream ?? null,
    };
  });

  app.get<{ Params: { slug: string; section: string } }>("/api/projects/:slug/docs/:section", async (req) => {
    const section = sectionOf(req.params.section);
    const { a, v } = await project(req, req.params.slug, "read");
    const [p] = await withReader(sql, Access.toReader(a.ctx, [v.id]), (tx) => tx<{ id: string; body: string; version: number; updatedAt: Date; commit: string | null }[]>`
      select id, body, version, updated_at as "updatedAt", frontmatter->>'commit' as commit from pages where vault_id = ${v.id} and path = ${pathOf(section)}`);
    if (!p) throw new AuthError("not_found", `La sezione «${PROJECT_SECTIONS[section].title}» non è ancora scritta.`);
    auth.audit.write({ principalId: a.principal.id, action: "project.doc.read", resource: p.id, ...meta(req), data: { section } });
    return { section, id: p.id, markdown: p.body, version: p.version, updatedAt: p.updatedAt, ...(p.commit ? { commit: p.commit } : {}) };
  });

  /**
   * Writes one section. `baseVersion`: the version the agent read; absent for a section that
   * does not exist yet. A page changed since (by a person) answers 409. `commit`: the git commit
   * the text describes, so the next session can tell how far the code has moved since.
   */
  app.put<{ Params: { slug: string; section: string }; Body: { markdown: string; summary: string; baseVersion?: number; commit?: string } }>(
    "/api/projects/:slug/docs/:section",
    {
      schema: {
        body: {
          type: "object",
          required: ["markdown", "summary"],
          properties: {
            markdown: { type: "string", minLength: 1, maxLength: 400_000 },
            summary: { type: "string", minLength: 1, maxLength: 400 },
            baseVersion: { type: "integer", minimum: 1 },
            commit: { type: "string", pattern: "^[0-9a-f]{7,40}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const section = sectionOf(req.params.section);
      const { a, v } = await project(req, req.params.slug, "write");
      const [cur] = await sql<{ id: string; version: number }[]>`select id, version from pages where vault_id = ${v.id} and path = ${pathOf(section)}`;
      if (cur && req.body.baseVersion !== cur.version) {
        throw new AuthError("conflict", `La sezione è alla versione ${cur.version}${req.body.baseVersion ? `, non alla ${req.body.baseVersion}` : ""}: leggila di nuovo e scrivi sopra quella.`);
      }
      // the frontmatter is the server's: the agent writes the body
      const body = req.body.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      const r = await pages.upsert({
        vaultId: v.id,
        path: pathOf(section),
        ...(cur ? { id: cur.id } : {}),
        frontmatter: {
          title: `${PROJECT_SECTIONS[section].title} · ${v.name}`,
          type: "synthesis/progetto",
          tldr: req.body.summary.replace(/\s+/g, " ").trim(),
          tags: ["progetto", section],
          project_section: section,
          written_by: a.principal.name,
          ...(req.body.commit ? { commit: req.body.commit } : {}),
        },
        body: `${body}\n`,
        author: a.principal.id,
      });
      await auth.audit.writeNow({ principalId: a.principal.id, action: "project.doc.write", resource: r.page.id, ...meta(req), data: { vault: v.id, section, version: r.page.version, tokens: r.page.tokens } });
      // what the text links or cites and the vault does not have: the agent can fix it now
      const brokenLinks = (await sql<{ t: string }[]>`select distinct target_raw as t from links where src_page = ${r.page.id} and dst_page is null order by 1 limit 50`).map((x) => x.t);
      const cited = [...new Set(extractCitations(body).map((c) => c.source))].slice(0, 200);
      const known = cited.length
        ? new Set((await sql<{ id: string }[]>`select id from sources where vault_id = ${v.id} and id = any(${cited}) union select id from pages where vault_id = ${v.id} and id = any(${cited})`).map((x) => x.id))
        : new Set<string>();
      const unknownCitations = cited.filter((c) => !known.has(c));
      return { section, id: r.page.id, version: r.page.version, changed: r.changed, ...(brokenLinks.length ? { brokenLinks } : {}), ...(unknownCitations.length ? { unknownCitations } : {}) };
    },
  );

  // -------------------------------------------------------------------------
  // Repository files (vault-docs.conf of the mod): one source of the vault per file path,
  // `meta.projectFile` = the path. A new version replaces the old source; a file the
  // repository no longer lists is deleted. Ingestion compiles them like uploads.
  // -------------------------------------------------------------------------

  /** The sources of the vault that stand for repository files, by path. */
  async function fileSources(vaultId: string) {
    return sql<{ id: string; path: string; status: string; commit: string | null }[]>`
      select id, meta->>'projectFile' as path, status, meta->>'commit' as commit from sources
      where vault_id = ${vaultId} and parent_id is null and meta ? 'projectFile' and classification <> 4
      order by meta->>'projectFile', created_at`;
  }

  /** Deletes the sources of a path except `keep`; what could not go (busy, cited) is returned. */
  async function dropFile(vaultId: string, path: string, keep?: string): Promise<{ removed: number; kept: string[] }> {
    const stale = (await fileSources(vaultId)).filter((s) => s.path === path && s.id !== keep);
    let removed = 0;
    const kept: string[] = [];
    for (const s of stale) {
      try {
        await ingest!.remove(s.id);
        removed++;
      } catch (e) {
        if (!(e instanceof SourceError)) throw e;
        kept.push(e.message);
      }
    }
    return { removed, kept };
  }

  function needIngest(): IngestService {
    if (!ingest) throw new AuthError("conflict", "L'ingestion non è attiva su questo server.");
    return ingest;
  }

  app.get<{ Params: { slug: string } }>("/api/projects/:slug/files", async (req) => {
    const { v } = await project(req, req.params.slug, "read");
    return { files: (await fileSources(v.id)).map((s) => ({ path: s.path, sourceId: s.id, status: s.status, ...(s.commit ? { commit: s.commit } : {}) })) };
  });

  /**
   * Writes one repository file (`content` in base64). The same bytes as the current source of
   * the path change nothing; new bytes become a new source and the old one is deleted.
   */
  app.put<{ Params: { slug: string }; Body: { path: string; content: string; commit?: string } }>(
    "/api/projects/:slug/files",
    {
      bodyLimit: Math.ceil(FILE_MAX_BYTES * 1.4) + 4096,
      schema: {
        body: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", pattern: FILE_PATH.source },
            content: { type: "string", maxLength: Math.ceil((FILE_MAX_BYTES * 4) / 3) + 4 },
            commit: { type: "string", pattern: "^[0-9a-f]{7,40}$" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const svc = needIngest();
      const { a, v } = await project(req, req.params.slug, "write");
      const data = Buffer.from(req.body.content, "base64");
      if (!data.length) throw new AuthError("invalid_request", "Il file è vuoto.");
      const name = req.body.path.split("/").pop()!;
      const r = await svc.upload(v.id, data, name, a.principal.id, Access.toReader(a.ctx, [v.id]), { compile: true });
      // the same bytes as a source the caller may not read: nothing about it, nothing written
      if (!r.source) return { path: req.body.path, removed: 0, duplicate: true };
      const owner = r.source.meta?.projectFile;
      // the same bytes as another file of the vault (or a person's upload): that source stays its own
      const mine = r.created || owner === req.body.path;
      if (r.created) {
        await sql`update sources set path = ${req.body.path}, meta = meta || ${sql.json({ projectFile: req.body.path, ...(req.body.commit ? { commit: req.body.commit } : {}) })} where id = ${r.source.id}`;
      } else if (mine && req.body.commit) {
        // unchanged at a later commit: the next comparison starts from there
        await sql`update sources set meta = meta || ${sql.json({ commit: req.body.commit })} where id = ${r.source.id}`;
      }
      const dropped = await dropFile(v.id, req.body.path, mine ? r.source.id : undefined);
      if (r.created || dropped.removed) {
        await auth.audit.writeNow({ principalId: a.principal.id, action: "project.file.write", resource: r.source.id, ...meta(req), data: { vault: v.id, path: req.body.path, created: r.created, removed: dropped.removed } });
      }
      return { path: req.body.path, sourceId: r.source.id, created: r.created, removed: dropped.removed, ...(mine ? {} : { duplicateOf: r.source.name }), ...(dropped.kept.length ? { kept: dropped.kept } : {}) };
    },
  );

  /** Deletes the sources of a repository file the mod no longer lists. */
  app.delete<{ Params: { slug: string }; Querystring: { path: string } }>(
    "/api/projects/:slug/files",
    { schema: { querystring: { type: "object", required: ["path"], properties: { path: { type: "string", pattern: FILE_PATH.source } } } } },
    async (req) => {
      needIngest();
      const { a, v } = await project(req, req.params.slug, "write");
      const dropped = await dropFile(v.id, req.query.path);
      if (dropped.removed) {
        await auth.audit.writeNow({ principalId: a.principal.id, action: "project.file.delete", resource: v.id, ...meta(req), data: { path: req.query.path, removed: dropped.removed } });
      }
      return { path: req.query.path, removed: dropped.removed, ...(dropped.kept.length ? { kept: dropped.kept } : {}) };
    },
  );
}

function sectionOf(s: string): ProjectSection {
  if (!(s in PROJECT_SECTIONS)) throw new AuthError("not_found", `Sezione sconosciuta. Sezioni: ${SECTIONS.join(", ")}.`);
  return s as ProjectSection;
}
