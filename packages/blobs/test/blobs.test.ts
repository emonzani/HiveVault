import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { FsBlobStore, readAll } from "../src/index.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "cb-blobs-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const master = randomBytes(32);
const store = new FsBlobStore(root, master);

/** On-disk name: HMAC-SHA256 of the sha256 with the name key of the vault. */
function keyedName(key: Buffer, vault: string, sha: string): string {
  const nameKey = Buffer.from(hkdfSync("sha256", key, Buffer.from("cb-blob-name-v1"), Buffer.from(vault), 32));
  return createHmac("sha256", nameKey).update(Buffer.from(sha, "hex")).digest("hex");
}

async function blobFile(vault: string, sha: string, dir = root, key = master) {
  const n = keyedName(key, vault, sha);
  return path.join(dir, vault, "k", n.slice(0, 2), n.slice(2, 4), n);
}

function legacyFile(dir: string, vault: string, sha: string) {
  return path.join(dir, vault, sha.slice(0, 2), sha.slice(2, 4), sha);
}

/** A blob as older releases wrote it: same format, file named by the sha256 of the plaintext. */
async function writeLegacy(dir: string, key: Buffer, vault: string, data: string): Promise<string> {
  const plain = Buffer.from(data);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", key, Buffer.from("cb-blob-v1"), Buffer.from(vault), 32)), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  const sha = createHash("sha256").update(plain).digest("hex");
  const f = legacyFile(dir, vault, sha);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, Buffer.concat([Buffer.from("CBB1"), iv, body, c.getAuthTag()]));
  return sha;
}

/** Every file below a folder, as paths relative to it with "/". */
async function files(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => rel(dir, path.join(e.parentPath, e.name)));
}

const rel = (dir: string, file: string) => path.relative(dir, file).split(path.sep).join("/");

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

  it("names files by a keyed digest: the sha256 of the plaintext is not on disk", async () => {
    const a = await store.put("vlt_names", "modulo ferie noto");
    const b = await store.put("vlt_names2", "modulo ferie noto");
    expect(a.sha256).toBe(b.sha256);
    for (const vault of ["vlt_names", "vlt_names2"]) {
      const list = await files(path.join(root, vault));
      expect(list).toHaveLength(1);
      expect(list[0]).not.toContain(a.sha256);
      expect(list[0]!.startsWith(`k/${a.sha256.slice(0, 2)}/${a.sha256.slice(2, 4)}/`)).toBe(false);
      expect(path.join(root, vault, list[0]!)).toBe(await blobFile(vault, a.sha256));
    }
    // the same content has another name in another vault, and with another master key
    expect(keyedName(master, "vlt_names", a.sha256)).not.toBe(keyedName(master, "vlt_names2", a.sha256));
    expect(keyedName(randomBytes(32), "vlt_names", a.sha256)).not.toBe(keyedName(master, "vlt_names", a.sha256));
  });

  it("deletes a blob and reports a missing one", async () => {
    const r = await store.put("vlt_del", "da cancellare");
    expect(await store.delete("vlt_del", r.sha256)).toBe(true);
    expect(await store.has("vlt_del", r.sha256)).toBe(false);
    expect(await store.delete("vlt_del", r.sha256)).toBe(false);
    await expect(store.get("vlt_del", r.sha256)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("FsBlobStore: names of older releases", () => {
  it("reads older names before and after the migration; the migration is idempotent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cb-blobs-mig-"));
    try {
      const s = new FsBlobStore(dir, master);
      const shas = [await writeLegacy(dir, master, "vlt_old", "contratto 1"), await writeLegacy(dir, master, "vlt_old", "contratto 2")];
      const kept = await s.put("vlt_new", "già con nome nuovo");
      // before: read, found, deduplicated without a second copy
      expect((await readAll(await s.get("vlt_old", shas[0]!))).toString()).toBe("contratto 1");
      expect(await s.has("vlt_old", shas[1]!)).toBe(true);
      expect(await s.put("vlt_old", "contratto 2")).toMatchObject({ sha256: shas[1], created: false });
      expect(await files(path.join(dir, "vlt_old", "k"))).toEqual([]);

      expect(await s.migrateNames()).toEqual({ vaults: 1, renamed: 2, duplicates: 0, skipped: 0, errors: 0 });
      // after: keyed names only, the empty folders of the older names are gone
      const list = await files(path.join(dir, "vlt_old"));
      expect(list.sort()).toEqual((await Promise.all(shas.map((h) => blobFile("vlt_old", h, dir)))).map((f) => rel(path.join(dir, "vlt_old"), f)).sort());
      for (const h of shas) expect(list.some((f) => f.includes(h))).toBe(false);
      expect((await readdir(path.join(dir, "vlt_old"))).filter((n) => n !== ".tmp")).toEqual(["k"]);
      expect((await readAll(await s.get("vlt_old", shas[0]!))).toString()).toBe("contratto 1");
      expect((await readAll(await s.get("vlt_old", shas[1]!))).toString()).toBe("contratto 2");
      expect((await readAll(await s.get("vlt_new", kept.sha256))).toString()).toBe("già con nome nuovo");

      // a second run changes nothing
      expect(await s.migrateNames()).toEqual({ vaults: 0, renamed: 0, duplicates: 0, skipped: 0, errors: 0 });
      // an older copy back from a backup, next to the keyed name: the older copy goes
      const keyed = await blobFile("vlt_old", shas[0]!, dir);
      await mkdir(path.dirname(legacyFile(dir, "vlt_old", shas[0]!)), { recursive: true });
      await copyFile(keyed, legacyFile(dir, "vlt_old", shas[0]!));
      expect(await s.migrateNames()).toEqual({ vaults: 1, renamed: 0, duplicates: 1, skipped: 0, errors: 0 });
      expect(existsSync(legacyFile(dir, "vlt_old", shas[0]!))).toBe(false);
      expect((await readAll(await s.get("vlt_old", shas[0]!))).toString()).toBe("contratto 1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a vault as it is when the master key does not open its blobs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cb-blobs-key-"));
    try {
      const sha = await writeLegacy(dir, master, "vlt_k", "busta paga");
      const wrong = new FsBlobStore(dir, randomBytes(32));
      expect(await wrong.migrateNames()).toEqual({ vaults: 0, renamed: 0, duplicates: 0, skipped: 1, errors: 0 });
      expect(existsSync(legacyFile(dir, "vlt_k", sha))).toBe(true);
      expect(await files(path.join(dir, "vlt_k", "k"))).toEqual([]);
      // the right key still reads it, and renames it at its next start
      const right = new FsBlobStore(dir, master);
      expect((await readAll(await right.get("vlt_k", sha))).toString()).toBe("busta paga");
      expect(await right.migrateNames()).toMatchObject({ vaults: 1, renamed: 1, skipped: 0 });
      expect(existsSync(await blobFile("vlt_k", sha, dir))).toBe(true);
      expect((await readAll(await right.get("vlt_k", sha))).toString()).toBe("busta paga");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads and deletes blobs while the migration runs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cb-blobs-race-"));
    try {
      const s = new FsBlobStore(dir, master);
      const shas: string[] = [];
      for (let i = 0; i < 200; i++) shas.push(await writeLegacy(dir, master, "vlt_r", `documento ${i}`));
      const doomed = shas.filter((_, i) => i % 2 === 0);
      const kept = shas.filter((_, i) => i % 2 === 1);
      const [migration, deleted, read] = await Promise.all([
        s.migrateNames(),
        Promise.all([...doomed].reverse().map((h) => s.delete("vlt_r", h))),
        Promise.all(kept.map(async (h) => (await readAll(await s.get("vlt_r", h))).toString())),
      ]);
      expect(migration.errors).toBe(0);
      expect(deleted.every(Boolean)).toBe(true);
      expect(read).toEqual(kept.map((h) => `documento ${shas.indexOf(h)}`));
      for (const h of doomed) expect(await s.has("vlt_r", h)).toBe(false);
      // nothing of the deleted blobs is left under any name; the others have their keyed name
      expect((await files(path.join(dir, "vlt_r"))).sort()).toEqual(
        (await Promise.all(kept.map((h) => blobFile("vlt_r", h, dir)))).map((f) => rel(path.join(dir, "vlt_r"), f)).sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finds and deletes a blob renamed between the check of its two names", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cb-blobs-gap-"));
    try {
      const s = new FsBlobStore(dir, master);
      const shas = [await writeLegacy(dir, master, "vlt_g", "primo"), await writeLegacy(dir, master, "vlt_g", "secondo")];
      // the migration renames the blob right after the miss of the keyed name
      const self = s as unknown as { legacyFile(v: string, h: string): string };
      const legacyOf = self.legacyFile.bind(s);
      self.legacyFile = (v, h) => {
        const f = legacyOf(v, h);
        if (existsSync(f)) {
          const n = keyedName(master, v, h);
          mkdirSync(path.join(dir, v, "k", n.slice(0, 2), n.slice(2, 4)), { recursive: true });
          renameSync(f, path.join(dir, v, "k", n.slice(0, 2), n.slice(2, 4), n));
        }
        return f;
      };
      expect(await s.has("vlt_g", shas[0]!)).toBe(true);
      expect(await s.delete("vlt_g", shas[1]!)).toBe(true);
      expect(await s.has("vlt_g", shas[1]!)).toBe(false);
      expect(await files(path.join(dir, "vlt_g"))).toEqual([rel(path.join(dir, "vlt_g"), await blobFile("vlt_g", shas[0]!, dir))]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes both names of a blob", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cb-blobs-both-"));
    try {
      const s = new FsBlobStore(dir, master);
      const sha = await writeLegacy(dir, master, "vlt_b", "copia doppia");
      await s.migrateNames();
      await mkdir(path.dirname(legacyFile(dir, "vlt_b", sha)), { recursive: true });
      await copyFile(await blobFile("vlt_b", sha, dir), legacyFile(dir, "vlt_b", sha));
      expect(await s.delete("vlt_b", sha)).toBe(true);
      expect(await files(path.join(dir, "vlt_b"))).toEqual([]);
      expect(await s.has("vlt_b", sha)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
