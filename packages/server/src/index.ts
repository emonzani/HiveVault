// HiveVault server entry point: `npm start`.
import "../../db/src/env.ts";
import { mkdirSync } from "node:fs";
import { createLogger } from "@cb/shared";
import { buildApp } from "./app.ts";
import { loadServerConfig } from "./config.ts";
import { createServices } from "./services.ts";

const log = createLogger("server");
const cfg = loadServerConfig();
mkdirSync(cfg.dataDir, { recursive: true });
const services = await createServices(cfg, { workers: true });
const app = await buildApp({
  ...services,
  secureCookies: !!cfg.tls || cfg.publicUrl.startsWith("https://"),
  rateLimitPerMin: cfg.rateLimitPerMin,
  loginRateLimitPerMin: cfg.loginRateLimitPerMin,
  trustProxy: cfg.trustProxy,
  https: cfg.tls,
  uploadMaxBytes: cfg.uploadMaxBytes,
  imports: services.imports,
  webDir: cfg.webDir || null,
  mcp: { pages: services.pages, dispatcher: services.models.dispatcher },
  hive: { curator: services.curator, pages: services.pages, engine: services.engine, dream: services.dream, dreamWindow: cfg.dream.window },
  ops: {
    metrics: services.metrics,
    engine: services.engine,
    pages: services.pages,
    models: services.modelsAdmin,
    settings: services.settings,
    dataDir: cfg.dataDir,
    blobs: services.blobs,
    metricsToken: cfg.metricsToken,
  },
});

await app.listen({ host: cfg.host, port: cfg.port });
log.info("listening", { url: `${cfg.tls ? "https" : "http"}://${cfg.host}:${cfg.port}`, publicUrl: cfg.publicUrl, rpId: cfg.rpId });
if ((await services.auth.principals.countAdmins()) === 0) {
  log.warn("no administrator yet: run `npm run cb -- admin create <username>`");
}
// blob names of older releases become keyed names (one way). In the background after the
// server listens: the health check of a deploy does not wait for a large store.
services.blobs.migrateNames().catch((e: NodeJS.ErrnoException) => log.error("blob name migration stopped", { errorCode: e?.code ?? "unknown" }));

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal: sig });
    await app.close();
    await services.stop();
    process.exit(0);
  });
}
