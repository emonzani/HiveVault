import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { BlobStore } from "@cb/blobs";
import { bumpVersion, chunkMarkdown, isPersonalOwner, PERSONAL, PersonalClassificationError, withReader, type ChunkOptions, type Principal } from "@cb/brain";
import type { Sql } from "@cb/db";
import { estimateTokens, newId } from "@cb/shared";

export type SourceOrigin = "upload" | "import" | "link" | "attachment";
export type SourceStatus = "stored" | "parsed" | "indexed" | "embedded" | "compiled" | "unsupported" | "failed";

export interface Source {
  id: string;
  vaultId: string;
  sha256: string;
  name: string;
  mime: string;
  size: number;
  status: SourceStatus;
  level: number;
  origin: SourceOrigin;
  path: string | null;
  parentId: string | null;
  title: string | null;
  parserVersion: string | null;
  classification: number;
  priority: number;
  compile: boolean;
  extractedSha: string | null;
  textTokens: number | null;
  taskId: string | null;
  compiledPage: string | null;
  demand: number;
  meta: Record<string, unknown>;
  error: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLS = `id, vault_id as "vaultId", sha256, name, mime, size, status, level, origin, path, parent_id as "parentId", title,
  parser_version as "parserVersion", classification, priority, compile, extracted_sha as "extractedSha", text_tokens as "textTokens",
  task_id as "taskId", compiled_page as "compiledPage", demand, meta, error, created_by as "createdBy", created_at as "createdAt",
  updated_at as "updatedAt"`;

export interface NewSource {
  vaultId: string;
  name: string;
  origin: SourceOrigin;
  path?: string | null;
  parentId?: string | null;
  classification?: number;
  priority?: number;
  compile?: boolean;
  createdBy?: string | null;
  meta?: Record<string, unknown>;
}

/** A new or known source; `source: null` is a known source the caller may not read. */
export type CreatedSource = { source: Source; created: boolean } | { source: null; created: false };

/** Max nesting of attachments (an email with a ZIP with an email with ...). */
export const MAX_DEPTH = 4;

export class SourceStore {
  constructor(
    private readonly sql: Sql,
    readonly blobs: BlobStore,
  ) {}

  /**
   * Stores the original file (L0, encrypted) and registers it. The same content in the same
   * vault is one source: `created: false` returns the existing one.
   *
   * `reader`: who asks. A person or an API account learns of an existing source only when it
   * may read it (RLS); otherwise the result is `{ source: null, created: false }` and the
   * existing source does not change. An attachment of the same parent is the parent's own
   * earlier insert (a parse that ran again). "system": jobs that see every source.
   */
  create(data: Readable | Buffer, s: NewSource, reader: "system"): Promise<{ source: Source; created: boolean }>;
  create(data: Readable | Buffer, s: NewSource, reader: Principal | "system"): Promise<CreatedSource>;
  async create(data: Readable | Buffer, s: NewSource, reader: Principal | "system"): Promise<CreatedSource> {
    const [vault] = await this.sql<{ dc: number; owner: string | null }[]>`select default_classification as dc, owner from vaults where id = ${s.vaultId}`;
    if (!vault) throw new Error(`vault ${s.vaultId} not found`);
    if ((s.classification ?? vault.dc) === PERSONAL && !isPersonalOwner(vault.owner)) throw new PersonalClassificationError();
    const put = await this.blobs.put(s.vaultId, data);
    const rows = await this.sql<Source[]>`
      insert into sources (id, vault_id, sha256, name, mime, size, origin, path, parent_id, classification, priority, compile, created_by, meta)
      values (${newId("src")}, ${s.vaultId}, ${put.sha256}, ${s.name.slice(0, 500)}, 'application/octet-stream', ${put.size}, ${s.origin},
              ${s.path ?? null}, ${s.parentId ?? null}, ${s.classification ?? vault.dc}, ${s.priority ?? 1}, ${s.compile ?? false},
              ${s.createdBy ?? null}, ${this.sql.json((s.meta ?? {}) as never)})
      on conflict (vault_id, sha256) do nothing
      returning ${this.sql.unsafe(COLS)}`;
    if (rows[0]) return { source: rows[0], created: true };
    const [existing] = await this.sql<Source[]>`select ${this.sql.unsafe(COLS)} from sources where vault_id = ${s.vaultId} and sha256 = ${put.sha256}`;
    if (reader !== "system" && !(s.parentId && existing!.parentId === s.parentId)) {
      const seen = await withReader(this.sql, reader, (tx) => tx`select 1 from sources where id = ${existing!.id}`);
      if (!seen.length) return { source: null, created: false };
    }
    // asking again to compile a known source is a request to compile it
    if (s.compile && !existing!.compile) await this.sql`update sources set compile = true where id = ${existing!.id}`;
    return { source: { ...existing!, compile: existing!.compile || !!s.compile }, created: false };
  }

  async get(id: string): Promise<Source | undefined> {
    const [r] = await this.sql<Source[]>`select ${this.sql.unsafe(COLS)} from sources where id = ${id}`;
    return r;
  }

  async list(vaultId: string, o: { status?: string; limit?: number; beforeCreated?: Date } = {}): Promise<Source[]> {
    return this.sql<Source[]>`
      select ${this.sql.unsafe(COLS)} from sources
      where vault_id = ${vaultId} and (${o.status ?? null}::text is null or status = ${o.status ?? null})
        and (${o.beforeCreated ?? null}::timestamptz is null or created_at < ${o.beforeCreated ?? null})
      order by created_at desc limit ${Math.min(o.limit ?? 100, 1000)}`;
  }

  async depth(id: string): Promise<number> {
    const [r] = await this.sql<{ d: number }[]>`
      with recursive up(id, parent_id, d) as (
        select id, parent_id, 0 from sources where id = ${id}
        union all select s.id, s.parent_id, up.d + 1 from sources s join up on s.id = up.parent_id where up.d < 20)
      select max(d)::int as d from up`;
    return r?.d ?? 0;
  }

  async update(id: string, patch: Partial<Record<"status" | "level" | "mime" | "parser_version" | "title" | "extracted_sha" | "text_tokens" | "task_id" | "compiled_page" | "error" | "compile", unknown>>, meta?: Record<string, unknown>): Promise<void> {
    const set: Record<string, unknown> = { ...patch, updated_at: new Date() };
    await this.sql`update sources set ${this.sql(set as never)} where id = ${id}`;
    if (meta) await this.sql`update sources set meta = meta || ${this.sql.json(meta as never)} where id = ${id}`;
  }

  /** Classification of a source and of its chunks (search and RLS read the chunks). */
  async setClassification(id: string, classification: number): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [s] = await tx<{ vaultId: string }[]>`update sources set classification = ${classification}, updated_at = now() where id = ${id} returning vault_id as "vaultId"`;
      if (s) await tx`update chunks set classification = ${classification} where vault_id = ${s.vaultId} and source_id = ${id}`;
    });
  }

  async readBlob(vaultId: string, sha: string): Promise<Buffer> {
    const s = await this.blobs.get(vaultId, sha);
    const parts: Buffer[] = [];
    for await (const c of s) parts.push(c as Buffer);
    return Buffer.concat(parts);
  }

  /**
   * Replaces the chunks of a source (I1). Embeddings of unchanged text are kept. One
   * transaction, then the vault version changes (search caches see the new text).
   *
   * The version is bumped after the commit, not inside the transaction: the vault row is a
   * hot row (every ingest task of the vault updates it); inside the transaction its lock
   * would serialize all concurrent ingestions of a vault for the whole chunk write.
   */
  async writeChunks(src: Source, markdown: string, lang: string, opts: ChunkOptions = {}): Promise<number> {
    const chunks = chunkMarkdown(markdown, opts);
    const n = await this.sql.begin(async (tx) => {
      const old = await tx<{ hash: string; embedding: string | null; embedding_model: string | null }[]>`
        delete from chunks where vault_id = ${src.vaultId} and source_id = ${src.id}
        returning hash, embedding::text as embedding, embedding_model`;
      const kept = new Map(old.filter((o) => o.embedding).map((o) => [o.hash, o]));
      const regconfig = lang === "english" ? "english" : lang === "simple" ? "simple" : "italian";
      const rows = chunks.map((c) => {
        const hash = createHash("sha256").update(c.text).digest("hex");
        const k = kept.get(hash);
        return {
          vault_id: src.vaultId,
          id: `${src.id}:${c.ord}`,
          source_id: src.id,
          block_id: c.blockId,
          heading: c.heading,
          ord: c.ord,
          text: c.text,
          tokens: c.tokens,
          lang: regconfig,
          hash,
          classification: src.classification,
          embedding: k?.embedding ?? null,
          embedding_model: k?.embedding_model ?? null,
        };
      });
      for (let i = 0; i < rows.length; i += 500) await tx`insert into chunks ${tx(rows.slice(i, i + 500) as never)}`;
      return rows.length;
    });
    await bumpVersion(this.sql, src.vaultId);
    return n as number;
  }

  async chunks(src: Source): Promise<{ id: string; ord: number; heading: string; text: string; tokens: number; hash: string }[]> {
    return this.sql`
      select id, ord, heading, text, tokens, hash from chunks where vault_id = ${src.vaultId} and source_id = ${src.id} order by ord`;
  }

  /** A row of the vault timeline; `classification`: of what the title names (readers see only what they may). */
  async log(vaultId: string, kind: string, title: string, ref: string | null, data?: Record<string, unknown>, classification = 0): Promise<void> {
    await this.sql`
      insert into vault_log (vault_id, kind, title, ref, data, classification)
      values (${vaultId}, ${kind}, ${title.slice(0, 300)}, ${ref}, ${data ? this.sql.json(data as never) : null}, ${classification})`;
  }
}

export const estimate = estimateTokens;
