/**
 * Worker pool for parsing (plan §4.2 step 2). PDF and Office parsing are CPU-bound and
 * synchronous in places: in the main thread they would freeze the HTTP server. Each file is
 * parsed in a worker thread; the buffer is transferred, not copied.
 */
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Piscina } from "piscina";
import type { ParseResult } from "./types.ts";

export interface PoolOptions {
  threads?: number;
  /** Max time for one file (a broken PDF can loop): the worker is killed after it. */
  timeoutMs?: number;
  maxChars?: number;
}

export class ParserPool {
  private readonly pool: Piscina;
  private readonly timeoutMs: number;
  private readonly maxChars: number | undefined;

  constructor(o: PoolOptions = {}) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    this.pool = new Piscina({
      filename: path.join(here, "worker.ts"),
      // workers load TypeScript through tsx, like the main process
      execArgv: ["--import", "tsx"],
      minThreads: 1,
      maxThreads: o.threads ?? Math.max(2, Math.min(8, availableParallelism() - 2)),
      idleTimeout: 60_000,
    });
    this.timeoutMs = o.timeoutMs ?? 120_000;
    this.maxChars = o.maxChars;
  }

  async parse(data: Buffer, name: string): Promise<ParseResult> {
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      return await this.pool.run({ data: ab, name, maxChars: this.maxChars }, { transferList: [ab], signal });
    } catch (e) {
      if (signal.aborted) throw new Error(`Analisi interrotta: "${name}" ha superato ${Math.round(this.timeoutMs / 1000)} s.`);
      throw e;
    }
  }

  /** PNG images of PDF pages (1-based numbers), for the OCR phase of the pipeline. */
  async render(data: Buffer, pages: number[], scale?: number): Promise<Buffer[]> {
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const out: Uint8Array[] = await this.pool.run({ op: "render", data: ab, pages, scale }, { transferList: [ab], signal });
    return out.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  }

  get stats() {
    return { threads: this.pool.threads.length, queued: this.pool.queueSize, completed: this.pool.completed };
  }

  async close(): Promise<void> {
    await this.pool.destroy();
  }
}
