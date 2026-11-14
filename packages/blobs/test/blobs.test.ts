import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { FsBlobStore, readAll } from "../src/index.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "cb-blobs-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const store = new FsBlobStore(root, randomBytes(32));

async function blobFile(vault: string, sha: string) {
  return path.join(root, vault, sha.slice(0, 2), sha.slice(2, 4), sha);
}

describe("FsBlobStore", () => {
  it("round-trips content and addresses it by the sha256 of the plaintext", async () => {
    const data = Buffer.from("Contratto Company example 2 — 250 postazioni");
    const r = await store.put("vlt_a", data);
    expect(r).toMatchObject({ size: data.length, created: true });
    expect(await readAll(await store.get("vlt_a", r.sha256))).toEqual(data);
  });

  it("stores ciphertext on disk, not the plaintext", async () => {
    const r = await store.put("vlt_a", "testo riservato molto riconoscibile");
    const raw = await readFile(await blobFile("vlt_a", r.sha256));
    expect(raw.includes(Buffer.from("riconoscibile"))).toBe(false);
    expect(raw.subarray(0, 4).toString()).toBe("CBB1");
  });

  it("deduplicates the same content in the same vault", async () => {
    const a = await store.put("vlt_a", "stesso file");
    const b = await store.put("vlt_a", "stesso file");
    expect(b).toEqual({ ...a, created: false });
    expect((await readdir(path.join(root, "vlt_a", ".tmp"))).length).toBe(0); // no temporary file left
  });

  it("uses a different key for every vault", async () => {
    const a = await store.put("vlt_a", "condiviso");
    const b = await store.put("vlt_b", "condiviso");
    expect(a.sha256).toBe(b.sha256);
    const fa = await readFile(await blobFile("vlt_a", a.sha256));
    const fb = await readFile(await blobFile("vlt_b", b.sha256));
    expect(fa.equals(fb)).toBe(false);
  });

  it("streams large content (8 MB) both ways", async () => {
    const big = randomBytes(8 * 1024 * 1024);
    const chunks = Array.from({ length: 128 }, (_, i) => big.subarray(i * 65536, (i + 1) * 65536));
    const r = await store.put("vlt_big", Readable.from(chunks));
    expect(r.size).toBe(big.length);
    expect((await readAll(await store.get("vlt_big", r.sha256))).equals(big)).toBe(true);
  });

  it("detects tampering", async () => {
    const r = await store.put("vlt_a", "importo: 23.250,00 EUR");
    const f = await blobFile("vlt_a", r.sha256);
    const raw = await readFile(f);
    raw[20] = raw[20]! ^ 0xff;
    await writeFile(f, raw);
    await expect(readAll(await store.get("vlt_a", r.sha256))).rejects.toThrow();
  });

  it("rejects path traversal in vault ids and hashes", async () => {
    await expect(store.get("../etc", "a".repeat(64))).rejects.toThrow(/invalid vault id/);
    await expect(store.get("vlt_a", "../../x")).rejects.toThrow(/invalid sha256/);
  });

  it("handles empty content", async () => {
    const r = await store.put("vlt_a", "");
    expect((await readAll(await store.get("vlt_a", r.sha256))).length).toBe(0);
  });
});
