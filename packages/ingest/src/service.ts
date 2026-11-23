/**
 * Ingestion entry points: uploads, links, re-ingestion, compile now, compile on demand.
 */
import type { Readable } from "node:stream";
import { PageStore, PERSONAL, type Principal, type SearchHit } from "@cb/brain";
import type { Sql } from "@cb/db";
import type { EgressGuard } from "@cb/shared";
import { createLogger } from "@cb/shared";
import type { TaskEngine } from "@cb/tasks";
import { fetchLink } from "./links.ts";
import type { IngestTask } from "./pipeline.ts";
import type { Source, SourceStore } from "./sources.ts";

const log = createLogger("ingest.service");

export interface IngestServiceOptions {
  /** Uploads by people are compiled (I3) by default; imports only on demand. */
  compileUploads?: boolean;
  /** Search hits on a not yet compiled source before it is queued for compilation. */
  demandThreshold?: number;
}

export interface CompileQueue {
  waiting: number;
  backlog: number;
  secondsPerSource: number | null;
  /** Compiles the mean is taken from (at most 50). */
  measured: number;
  /** Minutes until the sources waiting now are compiled, one at a time; null without a measure. */
  waitMinutes: number | null;
  /** Hours of model time for the backlog. */
  backlogHours: number | null;
}

/**
 * A source that cannot be changed now: `busy` (a worker runs on it), `cited` (by other pages),
 * `duplicate` (the new content is a source the caller may not read).
 */
export class SourceError extends Error {
  constructor(
    readonly code: "busy" | "cited" | "not_link" | "duplicate",
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface AddOptions {
  classification?: number;
  compile?: boolean;
}

/** An upload or a link; `source: null`: the same content as a source the caller may not read. */
export type Added = { source: Source; created: boolean; taskId: string | null } | { source: null; created: false; taskId: null };

export class IngestService {
  private readonly o: Required<IngestServiceOptions>;
  /** The last queue estimate and when it was read: counting a large backlog takes a few hundred ms. */
  private queue: { at: number; value: Promise<CompileQueue> } | null = null;

  constructor(
    private readonly sql: Sql,
    readonly store: SourceStore,
    private readonly engine: TaskEngine,
    private readonly task: IngestTask,
    private readonly egress: EgressGuard | undefined,
    o: IngestServiceOptions = {},
  ) {
    this.o = { compileUploads: o.compileUploads ?? true, demandThreshold: o.demandThreshold ?? 3 };
  }

  private async start(src: Source, priority: number): Promise<string> {
    const { id } = await this.engine.submit(this.task, { sourceId: src.id }, { requestId: `ingest:${src.id}:${src.sha256}`, priority });
    await this.store.update(src.id, { task_id: id });
    return id;
  }

  /**
   * A file uploaded by a person: priority 1, compiled by default. `reader`: the uploader
   * (`SourceStore.create`); the same bytes as a source it may not read give `source: null`.
   */
  upload(vaultId: string, data: Readable | Buffer, name: string, by: string | null, reader: "system", o?: AddOptions): Promise<{ source: Source; created: boolean; taskId: string | null }>;
  upload(vaultId: string, data: Readable | Buffer, name: string, by: string | null, reader: Principal | "system", o?: AddOptions): Promise<Added>;
  async upload(vaultId: string, data: Readable | Buffer, name: string, by: string | null, reader: Principal | "system", o: AddOptions = {}): Promise<Added> {
    const compile = o.compile ?? this.o.compileUploads;
    const { source, created } = await this.store.create(data, { vaultId, name, origin: "upload", createdBy: by, compile, priority: 1, ...(o.classification !== undefined ? { classification: o.classification } : {}) }, reader);
    if (!source) return { source: null, created: false, taskId: null };
    const taskId = created || source.status === "failed" ? await this.start(source, 1) : source.taskId;
    return { source: (await this.store.get(source.id))!, created, taskId };
  }

  async link(vaultId: string, url: string, by: string | null, reader: Principal | "system", o: AddOptions = {}): Promise<Added> {
    const f = await fetchLink(url, this.egress);
    const compile = o.compile ?? this.o.compileUploads;
    const { source, created } = await this.store.create(
      f.data,
      {
        vaultId,
        name: f.name,
        origin: "link",
        path: f.url,
        createdBy: by,
        compile,
        priority: 1,
        meta: { url: f.url, contentType: f.contentType },
        ...(o.classification !== undefined ? { classification: o.classification } : {}),
      },
      reader,
    );
    if (!source) return { source: null, created: false, taskId: null };
    const taskId = created ? await this.start(source, 1) : source.taskId;
    return { source: (await this.store.get(source.id))!, created, taskId };
  }

  /** Runs the pipeline again (new parser version, failed source). */
  async reingest(sourceId: string): Promise<string> {
    const src = await this.store.get(sourceId);
    if (!src) throw new Error("source not found");
    const { id } = await this.engine.submit(this.task, { sourceId }, { requestId: `reingest:${sourceId}:${Date.now()}`, priority: src.priority });
    await this.store.update(sourceId, { task_id: id });
    // a new result is reviewed again
    await this.sql`update sources set meta = meta - 'reviewed' where id = ${sourceId}`;
    return id;
  }

  /** "Da rivedere": a person accepts the source as it is; it leaves the list until a reingest. */
  async markReviewed(sourceId: string, by: string): Promise<void> {
    await this.store.update(sourceId, {}, { reviewed: { by, at: new Date().toISOString() } });
  }

  /**
   * Replaces a link with another URL: the new link is fetched first (a failure leaves the old
   * source as it is), then the old source goes. The new source keeps classification and compile.
   */
  async relink(sourceId: string, url: string, by: string | null, reader: Principal | "system") {
    const old = await this.store.get(sourceId);
    if (!old) throw new Error("source not found");
    if (old.origin !== "link") throw new SourceError("not_link", "Solo i documenti aggiunti da un link hanno un indirizzo da cambiare.");
    await this.removable([old.id]);
    const r = await this.link(old.vaultId, url, by, reader, { classification: old.classification, compile: old.compile });
    // the new address gives the content of a source the caller may not read: the old link stays
    if (!r.source) throw new SourceError("duplicate", "Il contenuto di quel link è già nel vault. Il link resta com'era.");
    if (r.source.id !== old.id) await this.remove(old.id);
    return r;
  }

  /** The source with its attachments and archive members (ids). */
  private async tree(sourceId: string): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      with recursive t(id) as (select id from sources where id = ${sourceId} union all select s.id from sources s join t on s.parent_id = t.id)
      select id from t`;
    return rows.map((r) => r.id);
  }

  /** Refuses when a worker runs on one of the sources or another page cites them. */
  private async removable(ids: string[]): Promise<{ compiled: string[] }> {
    const running = await this.sql`select 1 from sources s join tasks t on t.id = s.task_id where s.id = any(${ids}) and t.status = 'running' limit 1`;
    if (running.length) throw new SourceError("busy", "Il documento è in elaborazione in questo momento. Riprova tra poco.");
    const compiled = (await this.sql<{ p: string }[]>`select compiled_page as p from sources where id = any(${ids}) and compiled_page is not null`).map((r) => r.p);
    const cites = await this.sql<{ title: string }[]>`
      select title from pages
      where id <> all(${compiled}) and body like any(${ids.map((id) => `%^[${id}%`)})
      order by title limit 4`;
    if (cites.length) {
      throw new SourceError("cited", `Il documento è citato da altre pagine (${cites.map((c) => `«${c.title}»`).join(", ")}). Togli prima le citazioni.`);
    }
    return { compiled };
  }

  /**
   * Deletes a source for good: its attachments and members, their chunks, the pages compiled
   * from them and the original files (L0) that no other source of the vault uses.
   */
  async remove(sourceId: string): Promise<{ sources: number; pages: number }> {
    const src = await this.store.get(sourceId);
    if (!src) throw new Error("source not found");
    const ids = await this.tree(sourceId);
    const { compiled } = await this.removable(ids);
    const blobs = await this.sql<{ sha: string }[]>`
      select sha256 as sha from sources where id = any(${ids}) union select extracted_sha from sources where id = any(${ids}) and extracted_sha is not null`;
    const tasks = await this.sql<{ id: string }[]>`select task_id as id from sources where id = any(${ids}) and task_id is not null`;
    for (const t of tasks) await this.engine.cancel(t.id);
    await this.sql.begin(async (tx) => {
      await tx`delete from chunks where vault_id = ${src.vaultId} and source_id = any(${ids})`;
      await tx`delete from sources where id = ${sourceId}`; // members follow (on delete cascade)
    });
    const pages = new PageStore(this.sql);
    for (const p of compiled) await pages.delete(p);
    for (const { sha } of blobs) {
      const used = await this.sql`select 1 from sources where vault_id = ${src.vaultId} and (sha256 = ${sha} or extracted_sha = ${sha}) limit 1`;
      if (!used.length) await this.store.blobs.delete(src.vaultId, sha);
    }
    await this.store.log(src.vaultId, "delete", `Eliminato: ${src.title ?? src.name}`, src.id, { sources: ids.length, pages: compiled.length }, src.classification);
    log.info("source removed", { source: src.id, sources: ids.length, pages: compiled.length });
    return { sources: ids.length, pages: compiled.length };
  }

  /**
   * Deletes every "personale" page and source of a vault, with their chunks, versions, claims,
   * timeline rows and original files (GDPR art. 17, account deletion). Nothing else is touched.
   */
  async purgePersonal(vaultId: string): Promise<{ pages: number; sources: number; blobs: number }> {
    const roots = await this.sql<{ id: string }[]>`select id from sources where vault_id = ${vaultId} and classification = ${PERSONAL}`;
    const ids = [...new Set((await Promise.all(roots.map((r) => this.tree(r.id)))).flat())];
    const shas = await this.sql<{ sha: string }[]>`
      select sha256 as sha from sources where id = any(${ids}) union select extracted_sha from sources where id = any(${ids}) and extracted_sha is not null`;
    const tasks = await this.sql<{ id: string }[]>`select task_id as id from sources where id = any(${ids}) and task_id is not null`;
    for (const t of tasks) await this.engine.cancel(t.id).catch(() => undefined);
    const pageIds = (await this.sql<{ id: string }[]>`select id from pages where vault_id = ${vaultId} and classification = ${PERSONAL}`).map((p) => p.id);
    const pages = new PageStore(this.sql);
    for (const id of pageIds) await pages.delete(id);
    await this.sql.begin(async (tx) => {
      await tx`delete from chunks where vault_id = ${vaultId} and source_id = any(${ids})`;
      await tx`delete from sources where id = any(${ids})`;
      await tx`delete from vault_log where vault_id = ${vaultId} and classification = ${PERSONAL}`;
      // findings of the nightly checks name pages by title: they come back for what is left
      await tx`delete from curator_items where space_id = ${vaultId} and kind in ('duplicate', 'lint')`;
      await tx`update vaults set version = version + 1 where id = ${vaultId}`;
    });
    let blobs = 0;
    for (const { sha } of shas) {
      const used = await this.sql`select 1 from sources where vault_id = ${vaultId} and (sha256 = ${sha} or extracted_sha = ${sha}) limit 1`;
      if (!used.length) {
        await this.store.blobs.delete(vaultId, sha);
        blobs++;
      }
    }
    log.info("personal content purged", { vault: vaultId, pages: pageIds.length, sources: ids.length, blobs });
    return { pages: pageIds.length, sources: ids.length, blobs };
  }

  /** Deletes the original files (L0) of every source of a vault: before the vault itself goes. */
  async deleteVaultFiles(vaultId: string): Promise<number> {
    const shas = await this.sql<{ sha: string }[]>`
      select sha256 as sha from sources where vault_id = ${vaultId} union select extracted_sha from sources where vault_id = ${vaultId} and extracted_sha is not null`;
    const tasks = await this.sql<{ id: string }[]>`
      select t.id from sources s join tasks t on t.id = s.task_id where s.vault_id = ${vaultId} and t.status not in ('done', 'failed', 'cancelled')`;
    for (const t of tasks) await this.engine.cancel(t.id).catch(() => undefined);
    for (const { sha } of shas) await this.store.blobs.delete(vaultId, sha);
    return shas.length;
  }

  /**
   * M14: the compilation queue of the installation (one chat model serves every vault), with
   * the estimated wait. `waiting`: sources asked to compile whose task runs or waits;
   * `backlog`: sources never asked to compile (imports), compiled when the model is free;
   * `secondsPerSource`: mean of the last 50 model compiles (`meta.compileMs`), null before the
   * first one. Counts only, never names: every user may read it.
   */
  compileQueue(): Promise<CompileQueue> {
    // an estimate: one count every 30 s is enough for every dialog and console page that asks
    if (this.queue && Date.now() - this.queue.at < 30_000) return this.queue.value;
    const value = this.readQueue();
    this.queue = { at: Date.now(), value };
    value.catch(() => (this.queue = null));
    return value;
  }

  private async readQueue(): Promise<CompileQueue> {
    const [r] = await this.sql<{ waiting: number; backlog: number; ms: number | null; n: number }[]>`
      select
        (select count(*)::int from sources s join tasks t on t.id = s.task_id
          where s.compile and s.level < 3 and s.status not in ('failed', 'unsupported') and t.status in ('queued', 'running', 'sleeping', 'waiting')) as waiting,
        (select count(*)::int from sources where not compile and level between 1 and 2 and status not in ('failed', 'unsupported')) as backlog,
        (select avg(ms)::float8 from (select (meta->>'compileMs')::float8 as ms from sources where meta ? 'compileMs' order by updated_at desc limit 50) x) as ms,
        (select count(*)::int from (select 1 from sources where meta ? 'compileMs' limit 50) y) as n`;
    const sec = r?.ms ? Math.round(r.ms / 100) / 10 : null;
    return {
      waiting: r?.waiting ?? 0,
      backlog: r?.backlog ?? 0,
      secondsPerSource: sec,
      measured: r?.n ?? 0,
      waitMinutes: sec === null ? null : Math.ceil(((r?.waiting ?? 0) * sec) / 60),
      backlogHours: sec === null ? null : Math.round(((r?.backlog ?? 0) * sec) / 360) / 10,
    };
  }

  /** "Compila adesso": marks the source and runs the pipeline (fast for the phases already done). */
  async compileNow(sourceId: string, priority = 1): Promise<string> {
    await this.store.update(sourceId, { compile: true });
    const src = (await this.store.get(sourceId))!;
    const { id } = await this.engine.submit(this.task, { sourceId }, { requestId: `compile:${sourceId}`, priority });
    await this.store.update(src.id, { task_id: id });
    return id;
  }

  /**
   * Compile on demand (plan §4.1): search hits on sources not yet compiled are counted; at the
   * threshold the source is queued for compilation at background priority.
   */
  async onSearchHits(hits: Pick<SearchHit, "kind" | "id" | "level">[]): Promise<void> {
    const ids = hits.filter((h) => h.kind === "source" && h.level !== "I3").map((h) => h.id);
    if (!ids.length) return;
    const due = await this.sql<{ id: string }[]>`
      update sources set demand = demand + 1
      where id = any(${ids}) and level < 3 and status in ('indexed', 'embedded')
      returning id, demand, compile`.then((rows) =>
      (rows as unknown as { id: string; demand: number; compile: boolean }[]).filter((r) => !r.compile && r.demand >= this.o.demandThreshold),
    );
    for (const r of due) {
      log.info("compile on demand", { source: r.id });
      await this.compileNow(r.id, 2);
    }
  }
}
