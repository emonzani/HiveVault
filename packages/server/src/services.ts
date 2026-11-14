import { readFileSync } from "node:fs";
import path from "node:path";
import { AuthService } from "@cb/auth";
import { FsBlobStore, loadMasterKey } from "@cb/blobs";
import { EmbeddingIndexer, PageStore, SearchEngine, VaultStore } from "@cb/brain";
import { createDb, migrate, type Sql } from "@cb/db";
import { Curator, defineDreamScheduler, defineDreamTask, defineLinkTask, type DreamTask } from "@cb/hive";
import { Compiler, defineIdleCompileTask, defineImportTask, defineIngestTask, ImportService, IngestService, SourceStore, type IngestTask } from "@cb/ingest";
import { MetricsService } from "@cb/metrics";
import { createModelsRuntime, EXTRACT_POOL, type ModelsRuntime } from "@cb/models";
import { PARSER_VERSIONS, ParserPool } from "@cb/parsers";
import { databaseUrl, EgressGuard, loadModelsConfig, metrics as registry } from "@cb/shared";
import { TaskEngine } from "@cb/tasks";
import type { ServerConfig } from "./config.ts";
import { registerCollectors } from "./ops/collectors.ts";
import { ModelsAdmin } from "./ops/models.ts";
import { Settings } from "./ops/settings.ts";

export interface Services {
  sql: Sql;
  auth: AuthService;
  vaults: VaultStore;
  search: SearchEngine;
  models: ModelsRuntime;
  ingest: IngestService;
  ingestTask: IngestTask;
  /** The compiler of the ingest pipeline (benchmarks call it directly). */
  compiler: Compiler;
  imports: ImportService;
  engine: TaskEngine;
  egress: EgressGuard;
  curator: Curator;
  pages: PageStore;
  dream: DreamTask;
  settings: Settings;
  metrics: MetricsService;
  modelsAdmin: ModelsAdmin;
  stop(): Promise<void>;
}

/**
 * Wires the long-lived services. The server runs the task workers (`workers: true`); the
 * CLI uses the same services without workers and without local model processes.
 */
export async function createServices(cfg: ServerConfig, o: { models?: boolean; workers?: boolean } = {}): Promise<Services> {
  const modelsCfg = loadModelsConfig();
  const sql = createDb({ max: 20, application: "cb-server" });
  // Ingestion and import workers: their task phases are idempotent, so their commits do not
  // wait for the WAL flush (3.7x faster ingestion in the phase 3 benchmark). Logins, sessions,
  // admin changes and audit stay on the synchronous pool.
  const workerSql = createDb({ max: 20, application: "cb-workers", synchronousCommit: false });

  // Outgoing connections: database, model servers and configured hosts only (invariant 1).
  let auth: AuthService | undefined;
  const egress = new EgressGuard({
    allow: cfg.egressAllow,
    onBlocked: (e) => {
      registry.inc("egress_blocked");
      auth?.audit.write({ action: "egress.blocked", resource: `${e.host}:${e.port}`, outcome: "denied" });
    },
  });
  egress.allowUrls([databaseUrl(), modelsCfg.chat.url, ...modelsCfg.chat.extractUrls, ...modelsCfg.embed.remoteUrls, ...modelsCfg.rerank.remoteUrls, ...modelsCfg.ocr.remoteUrls]);
  egress.install();

  await migrate(sql);
  const settings = new Settings(sql, {
    dream: { window: cfg.dream.window, minutes: cfg.dream.minutes, tokens: cfg.dream.tokens, compilePerNight: cfg.dream.compilePerNight, useModel: cfg.dream.useModel },
    notice: { text: "" },
    defaults: { classification: 1 },
    privacy: { readRetentionDays: cfg.privacy.readRetentionDays, emailIngest: cfg.privacy.emailIngest },
    "models.local": { threads: modelsCfg.local.threads, schedule: modelsCfg.local.schedule, offHours: modelsCfg.local.offHours },
    "models.remote": [],
    "models.overrides": {},
  });
  await settings.load();
  const models = createModelsRuntime(o.models === false ? { ...modelsCfg, local: { ...modelsCfg.local, enabled: false } } : modelsCfg);
  const masterKey = loadMasterKey(cfg.dataDir);
  auth = new AuthService(sql, {
    masterKey,
    webauthn: { rpId: cfg.rpId, rpName: "HiveVault", origins: [cfg.publicUrl, ...cfg.extraOrigins] },
    session: { idleMs: cfg.sessionIdleMs, maxMs: cfg.sessionMaxMs },
    clientCaPems: cfg.clientCaFile ? [readFileSync(cfg.clientCaFile, "utf8")] : [],
  });
  const dims = modelsCfg.embed.dimensions;
  const vaults = new VaultStore(sql, dims);
  const search = new SearchEngine(sql, models.dispatcher, { dims, embedModel: modelsCfg.embed.modelId });

  const store = new SourceStore(workerSql, new FsBlobStore(path.join(cfg.dataDir, "blobs"), masterKey));
  const pool = new ParserPool({ threads: cfg.parserThreads });
  const compiler = new Compiler(workerSql, store, new PageStore(workerSql), search, models.dispatcher, { mode: cfg.compileMode });
  const embedConfigured = modelsCfg.offlineMode === "mock" || modelsCfg.local.enabled || modelsCfg.embed.remoteUrls.length > 0;
  const ingestTask = defineIngestTask({
    store,
    parse: (data, name) => pool.parse(data, name),
    indexer: () => (embedConfigured ? new EmbeddingIndexer(workerSql, models.dispatcher, { model: modelsCfg.embed.modelId }) : null),
    compiler,
    email: () => settings.get("privacy").emailIngest,
    // extraction runs on the pool "extract" when one is up (M4); the agent always on the main model
    chatBusy: () => models.dispatcher.busy("chat", cfg.compileMode === "extract" ? EXTRACT_POOL : undefined),
    ocr: () => {
      const eps = models.dispatcher.snapshot().endpoints.filter((e) => e.kind === "ocr");
      if (!eps.length) return null;
      return {
        render: (data, pageNumbers) => pool.render(data, pageNumbers, modelsCfg.ocr.scale),
        read: (images, priority) => models.dispatcher.ocr({ images }, { priority: Math.min(2, priority) as 0 | 1 | 2 }),
        ready: () => models.dispatcher.snapshot().endpoints.some((e) => e.kind === "ocr" && e.status === "up"),
        pagesPerRequest: modelsCfg.ocr.pagesPerRequest,
        maxPages: modelsCfg.ocr.maxPages,
      };
    },
  });
  const importTask = defineImportTask({ sql: workerSql, store, ingestTask, roots: cfg.importRoots });
  const pages = new PageStore(workerSql);
  const dreamTask = defineDreamTask({
    sql: workerSql,
    pages,
    dispatcher: models.dispatcher,
    useModel: cfg.dream.useModel,
    indexer: () => (embedConfigured ? new EmbeddingIndexer(workerSql, models.dispatcher, { model: modelsCfg.embed.modelId }) : null),
    reingest: (id) => ingest.reingest(id),
    compileNow: (id, priority) => ingest.compileNow(id, priority),
    parserVersions: PARSER_VERSIONS,
    ocrAvailable: () => models.dispatcher.snapshot().endpoints.some((e) => e.kind === "ocr" && e.status === "up"),
    readBlob: (vaultId, sha) => store.readBlob(vaultId, sha),
    window: cfg.dream.window,
    budget: { minutes: cfg.dream.minutes, tokens: cfg.dream.tokens },
    compilePerNight: cfg.dream.compilePerNight,
    live: () => settings.get("dream"),
  });
  const dreamScheduler = defineDreamScheduler({ sql: workerSql, dream: dreamTask, window: cfg.dream.window, liveWindow: () => settings.get("dream").window, retention: () => ({ auditDays: cfg.dream.auditDays, taskDays: cfg.dream.taskDays, readDays: settings.get("privacy").readRetentionDays }) });
  const linkTask = defineLinkTask({ sql: workerSql, pages: new PageStore(workerSql), intervalMs: cfg.linkIntervalMinutes * 60_000 });
  // imports compiled while the chat model is free (M3): only a real model, never the extractive page alone
  const idleTask = defineIdleCompileTask({
    sql: workerSql,
    compileNow: (id, priority) => ingest.compileNow(id, priority),
    ready: () => compiler.modelAvailable() && !models.dispatcher.busy("chat", cfg.compileMode === "extract" ? EXTRACT_POOL : undefined),
    intervalMs: 60_000,
  });
  // with IDLE_COMPILE=false the task is not registered: a row left by an earlier run stays asleep
  const engine = new TaskEngine(workerSql, { concurrency: cfg.ingestWorkers }).register(ingestTask, importTask, dreamTask, dreamScheduler, linkTask, ...(cfg.idleCompile ? [idleTask] : []));
  const imports = new ImportService(workerSql, engine, importTask, cfg.importRoots);
  const ingest = new IngestService(workerSql, store, engine, ingestTask, egress, { compileUploads: cfg.compileUploads });
  const modelsAdmin = new ModelsAdmin(models, settings, egress, modelsCfg.apiKey || undefined, modelsCfg);
  const metricsService = new MetricsService(sql);
  registerCollectors(metricsService, { sql, models, dataDir: cfg.dataDir });
  if (o.workers) {
    await modelsAdmin.applyStored();
    // the server writes metrics; the leader among the processes also samples and rolls up
    metricsService.start();
    await engine.start();
    // one scheduler for the whole installation: it sleeps until every night window
    if (cfg.dream.enabled) await engine.submit(dreamScheduler, {}, { requestId: "dream-scheduler", priority: 5 });
    // links of the pages written during the day: minutes after a compilation, not the next night
    if (cfg.linkIntervalMinutes > 0) await engine.submit(linkTask, {}, { requestId: "links", priority: 4 });
    if (cfg.idleCompile) await engine.submit(idleTask, {}, { requestId: "idle-compile", priority: 4 });
  }

  return {
    sql,
    auth,
    models,
    vaults,
    search,
    ingest,
    ingestTask,
    compiler,
    imports,
    engine,
    egress,
    pages,
    dream: dreamTask,
    curator: new Curator(workerSql, pages),
    settings,
    metrics: metricsService,
    modelsAdmin,
    async stop() {
      await metricsService.stop();
      await engine.stop();
      await pool.close();
      await auth!.stop();
      await models.stop();
      await workerSql.end({ timeout: 5 });
      await sql.end({ timeout: 5 });
      egress.uninstall();
    },
  };
}
