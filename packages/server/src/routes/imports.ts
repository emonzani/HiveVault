/** Bulk imports (admin): create, list, progress, pause, resume, cancel, rescan. */
import type { FastifyInstance } from "fastify";
import { AuthError, type AuthService } from "@cb/auth";
import { ImportError, type ImportService } from "@cb/ingest";
import { meta, requireAction } from "../http.ts";

const str = (max = 200) => ({ type: "string", minLength: 1, maxLength: max }) as const;

export function importRoutes(app: FastifyInstance, auth: AuthService, imports: ImportService): void {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ImportError) throw new AuthError("invalid_request", e.message);
      throw e;
    }
  };

  app.post<{ Body: { vaultId: string; root: string; include?: string[]; exclude?: string[]; classification?: number; maxFileMb?: number; filesPerSec?: number | null; windowHours?: string | null; compile?: boolean } }>(
    "/api/admin/imports",
    {
      schema: {
        body: {
          type: "object",
          required: ["vaultId", "root"],
          properties: {
            vaultId: str(64),
            root: str(1000),
            include: { type: "array", maxItems: 50, items: str(200) },
            exclude: { type: "array", maxItems: 50, items: str(200) },
            classification: { type: "integer", minimum: 0, maximum: 3 },
            maxFileMb: { type: "integer", minimum: 1, maximum: 10_000 },
            filesPerSec: { anyOf: [{ type: "number", minimum: 0.1, maximum: 10_000 }, { type: "null" }] },
            windowHours: { anyOf: [str(11), { type: "null" }] },
            compile: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const a = requireAction(req, "admin.vaults");
      const { maxFileMb, ...rest } = req.body;
      const job = await wrap(() => imports.create({ ...rest, ...(maxFileMb ? { maxFileBytes: maxFileMb * 1024 ** 2 } : {}), createdBy: a.principal.id }));
      await auth.audit.writeNow({ principalId: a.principal.id, action: "admin.import.create", resource: job.id, ...meta(req), data: { vault: job.vaultId, root: job.root } });
      return reply.status(201).send(job);
    },
  );

  app.get<{ Querystring: { vaultId?: string } }>("/api/admin/imports", async (req) => {
    requireAction(req, "admin.vaults");
    return imports.list(req.query.vaultId);
  });

  app.patch<{ Params: { id: string }; Body: { include?: string[]; exclude?: string[]; classification?: number; maxFileMb?: number; filesPerSec?: number | null; windowHours?: string | null; compile?: boolean } }>(
    "/api/admin/imports/:id",
    {
      schema: {
        body: {
          type: "object",
          minProperties: 1,
          properties: {
            include: { type: "array", maxItems: 50, items: str(200) },
            exclude: { type: "array", maxItems: 50, items: str(200) },
            classification: { type: "integer", minimum: 0, maximum: 3 },
            maxFileMb: { type: "integer", minimum: 1, maximum: 10_000 },
            filesPerSec: { anyOf: [{ type: "number", minimum: 0.1, maximum: 10_000 }, { type: "null" }] },
            windowHours: { anyOf: [str(11), { type: "null" }] },
            compile: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const a = requireAction(req, "admin.vaults");
      const { maxFileMb, ...rest } = req.body;
      const job = await wrap(() => imports.update(req.params.id, { ...rest, ...(maxFileMb ? { maxFileBytes: maxFileMb * 1024 ** 2 } : {}) }));
      await auth.audit.writeNow({ principalId: a.principal.id, action: "admin.import.update", resource: job.id, ...meta(req), data: { changes: req.body } });
      return job;
    },
  );

  app.get<{ Params: { id: string } }>("/api/admin/imports/:id", async (req) => {
    requireAction(req, "admin.vaults");
    const j = await imports.get(req.params.id);
    if (!j) throw new AuthError("not_found", "Import non trovato.");
    return j;
  });

  for (const [action, status] of [["pause", "paused"], ["resume", "running"], ["cancel", "cancelled"]] as const) {
    app.post<{ Params: { id: string } }>(`/api/admin/imports/:id/${action}`, async (req) => {
      const a = requireAction(req, "admin.vaults");
      await wrap(() => imports.setStatus(req.params.id, status));
      await auth.audit.writeNow({ principalId: a.principal.id, action: `admin.import.${action}`, resource: req.params.id, ...meta(req) });
      return { ok: true };
    });
  }

  app.post<{ Params: { id: string } }>("/api/admin/imports/:id/rescan", async (req) => {
    const a = requireAction(req, "admin.vaults");
    const taskId = await wrap(() => imports.rescan(req.params.id));
    await auth.audit.writeNow({ principalId: a.principal.id, action: "admin.import.rescan", resource: req.params.id, ...meta(req) });
    return { taskId };
  });
}
