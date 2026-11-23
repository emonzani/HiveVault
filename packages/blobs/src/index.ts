/**
 * Raw store (L0): original documents, content-addressed and encrypted at rest.
 *
 * - Address: SHA-256 of the plaintext. The same file in the same vault is stored once.
 * - File name: `<vault>/k/<ab>/<cd>/<HMAC-SHA256(name key, sha256)>`, with a name key per vault
 *   derived with HKDF from the master key. The SHA-256 of the plaintext never appears on disk,
 *   so a copy of the store without the key does not show which known documents it holds.
 *   Older releases named the file `<vault>/<ab>/<cd>/<sha256>`: these names are still read, and
 *   `migrateNames` renames them (one way: older releases do not read keyed names).
 * - Encryption: AES-256-GCM, one key per vault derived with HKDF from the master key, so a
 *   leaked vault key does not open other vaults and a vault is erased by forgetting its key.
 * - File format: "CBB1" (4 bytes) | IV (12) | ciphertext | GCM tag (16).
 * - Streaming in both directions: files of any size never sit in memory.
 * - Atomic writes: temporary file + rename; a crash never leaves a half blob at its address.
 * - Tampering or corruption: reading fails with an authentication error (GCM tag).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createLogger, strEnv } from "@cb/shared";

const MAGIC = Buffer.from("CBB1");
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + IV_LEN;
const log = createLogger("blobs");
const SHA_RE = /^[a-f0-9]{64}$/;
const HEX2_RE = /^[a-f0-9]{2}$/;
const VAULT_RE = /^[\w-]+$/;
/** Older names of a vault are renamed only after the master key opens one of its first blobs. */
const KEY_PROOFS = 3;

const errCode = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? "unknown";

/** Removes a file; false when it does not exist. */
async function removeFile(file: string): Promise<boolean> {
  try {
    await rm(file);
    return true;
  } catch (e) {
    if (errCode(e) === "ENOENT") return false;
    throw e;
  }
}

/** Names of the subfolders of a folder (none when it does not exist). */
async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    if (errCode(e) === "ENOENT") return [];
    throw e;
  }
}

export interface PutResult {
  sha256: string;
  size: number;
  /** false when the same content was already stored in this vault (deduplicated). */
  created: boolean;
}

export interface BlobStore {
  put(vaultId: string, data: Readable | Buffer | string): Promise<PutResult>;
  get(vaultId: string, sha256: string): Promise<Readable>;
  has(vaultId: string, sha256: string): Promise<boolean>;
  delete(vaultId: string, sha256: string): Promise<boolean>;
}

/** Result of `FsBlobStore.migrateNames`. */
export interface NameMigration {
  /** Vaults whose older names were renamed. */
  vaults: number;
  renamed: number;
  /** Older copies removed because the keyed name already existed. */
  duplicates: number;
  /** Vaults left as they are: the master key does not open their blobs. */
  skipped: number;
  errors: number;
}

/**
 * Master key from BRAIN_MASTER_KEY (base64, 32 bytes). In development, when it is not set,
 * a key is generated once in `<dataDir>/.master-key`. Production must set the variable and
 * keep a copy outside the server: without it the raw store cannot be read.
 */
export function loadMasterKey(dataDir = "data"): Buffer {
  const fromEnv = strEnv("BRAIN_MASTER_KEY");
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "base64");
    if (key.length !== 32) throw new Error("BRAIN_MASTER_KEY must be 32 bytes in base64");
    return key;
  }
  const file = path.join(dataDir, ".master-key");
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  const key = randomBytes(32);
  writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  log.warn("BRAIN_MASTER_KEY is not set: generated a development key", { file });
  return key;
}

export class FsBlobStore implements BlobStore {
  private readonly keys = new Map<string, Buffer>();
  private readonly nameKeys = new Map<string, Buffer>();

  constructor(
    private readonly root: string,
    private readonly masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
  }

  private vaultKey(vaultId: string): Buffer {
    let k = this.keys.get(vaultId);
    if (!k) {
      k = Buffer.from(hkdfSync("sha256", this.masterKey, Buffer.from("cb-blob-v1"), Buffer.from(vaultId), 32));
      this.keys.set(vaultId, k);
    }
    return k;
  }

  /** Key of the file names of a vault: separate from the content key (another HKDF salt). */
  private nameKey(vaultId: string): Buffer {
    let k = this.nameKeys.get(vaultId);
    if (!k) {
      k = Buffer.from(hkdfSync("sha256", this.masterKey, Buffer.from("cb-blob-name-v1"), Buffer.from(vaultId), 32));
      this.nameKeys.set(vaultId, k);
    }
    return k;
  }

  private check(vaultId: string, sha: string): void {
    if (!SHA_RE.test(sha)) throw new Error(`invalid sha256: ${sha}`);
    if (!VAULT_RE.test(vaultId)) throw new Error(`invalid vault id: ${vaultId}`);
  }

  /** File name of a blob: HMAC of its sha256 with the name key of the vault. */
  private keyedFile(vaultId: string, sha: string): string {
    this.check(vaultId, sha);
    const name = createHmac("sha256", this.nameKey(vaultId)).update(Buffer.from(sha, "hex")).digest("hex");
    return path.join(this.root, vaultId, "k", name.slice(0, 2), name.slice(2, 4), name);
  }

  /** File name of a blob written by an older release. */
  private legacyFile(vaultId: string, sha: string): string {
    this.check(vaultId, sha);
    return path.join(this.root, vaultId, sha.slice(0, 2), sha.slice(2, 4), sha);
  }

  /**
   * The file of a blob: the keyed name, else the older name, else the keyed name again
   * (`migrateNames` renamed it between the two checks). null when the blob does not exist.
   */
  private find(vaultId: string, sha: string): string | null {
    const keyed = this.keyedFile(vaultId, sha);
    if (existsSync(keyed)) return keyed;
    const legacy = this.legacyFile(vaultId, sha);
    if (existsSync(legacy)) return legacy;
    return existsSync(keyed) ? keyed : null;
  }

  /** Opens a blob in the order of `find`. A missing blob fails with ENOENT. */
  private async open(vaultId: string, sha: string): Promise<FileHandle> {
    const keyed = this.keyedFile(vaultId, sha);
    for (const file of [keyed, this.legacyFile(vaultId, sha)]) {
      try {
        return await open(file, "r");
      } catch (e) {
        if (errCode(e) !== "ENOENT") throw e;
      }
    }
    return open(keyed, "r");
  }

  async put(vaultId: string, data: Readable | Buffer | string): Promise<PutResult> {
    const source = typeof data === "string" || Buffer.isBuffer(data) ? Readable.from([Buffer.from(data)]) : data;
    const tmpDir = path.join(this.root, vaultId, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${process.pid}-${randomBytes(8).toString("hex")}`);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.vaultKey(vaultId), iv);
    const hash = createHash("sha256");
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      // header | ciphertext | tag: the tag exists only after the cipher has flushed
      await pipeline(
        source,
        tap,
        cipher,
        async function* (encrypted: AsyncIterable<Buffer>) {
          yield Buffer.concat([MAGIC, iv]);
          for await (const c of encrypted) yield c;
          yield cipher.getAuthTag();
        },
        createWriteStream(tmp),
      );
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    const sha256 = hash.digest("hex");
    if (this.find(vaultId, sha256)) {
      await rm(tmp, { force: true });
      return { sha256, size, created: false };
    }
    const dest = this.keyedFile(vaultId, sha256);
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(tmp, dest);
    return { sha256, size, created: true };
  }

  async get(vaultId: string, sha256: string): Promise<Readable> {
    return this.decrypt(vaultId, sha256, await this.open(vaultId, sha256));
  }

  /**
   * Decrypts an open blob file and closes it at the end. Everything is read from the open
   * file, so a rename of the blob by `migrateNames` does not break a read in progress.
   */
  private async decrypt(vaultId: string, sha256: string, fh: FileHandle): Promise<Readable> {
    const head = Buffer.alloc(HEADER_LEN);
    const tag = Buffer.alloc(TAG_LEN);
    let size: number;
    try {
      ({ size } = await fh.stat());
      if (size < HEADER_LEN + TAG_LEN) throw new Error(`blob ${sha256} is truncated`);
      await fh.read(head, 0, HEADER_LEN, 0);
      await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
      if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`blob ${sha256}: unknown format`);
    } catch (err) {
      await fh.close();
      throw err;
    }
    const decipher = createDecipheriv("aes-256-gcm", this.vaultKey(vaultId), head.subarray(MAGIC.length));
    decipher.setAuthTag(tag);
    const out = new PassThrough();
    const body = size - HEADER_LEN - TAG_LEN;
    let input: Readable;
    if (body > 0) input = fh.createReadStream({ start: HEADER_LEN, end: HEADER_LEN + body - 1 });
    else {
      await fh.close();
      input = Readable.from([]);
    }
    pipeline(input, decipher, out).catch((err) => out.destroy(err));
    return out;
  }

  async has(vaultId: string, sha256: string): Promise<boolean> {
    return this.find(vaultId, sha256) !== null;
  }

  /**
   * Removes both names of a blob. After a miss of the older name it tries the keyed name
   * again: `migrateNames` can rename the blob between the first two attempts.
   */
  async delete(vaultId: string, sha256: string): Promise<boolean> {
    const keyed = this.keyedFile(vaultId, sha256);
    let removed = await removeFile(keyed);
    if (await removeFile(this.legacyFile(vaultId, sha256))) removed = true;
    else if (await removeFile(keyed)) removed = true;
    return removed;
  }

  /**
   * Renames the blobs written by older releases (`<vault>/<ab>/<cd>/<sha256>`) to their keyed
   * names. The server runs it in the background after it starts to listen. It is idempotent:
   * a run that stops continues at the next start. Before it renames the blobs of a vault, it
   * decrypts one of them with the current master key: with another key the vault stays as it
   * is (a name made with the wrong key cannot be found again). The log has counts, vault ids
   * and error codes only, never file names.
   */
  async migrateNames(): Promise<NameMigration> {
    const r: NameMigration = { vaults: 0, renamed: 0, duplicates: 0, skipped: 0, errors: 0 };
    const errorCodes: Record<string, number> = {};
    const failed = (e: unknown) => {
      r.errors++;
      errorCodes[errCode(e)] = (errorCodes[errCode(e)] ?? 0) + 1;
    };
    for (const vaultId of await subdirs(this.root)) {
      if (!VAULT_RE.test(vaultId)) continue;
      try {
        const proofs: string[] = [];
        for await (const sha of this.legacyBlobs(vaultId)) if (proofs.push(sha) >= KEY_PROOFS) break;
        if (!proofs.length) continue;
        if (!(await this.keyOpensOne(vaultId, proofs))) {
          r.skipped++;
          log.warn("blob names of a vault not migrated: the master key does not open its blobs", { vault: vaultId });
          continue;
        }
        r.vaults++;
        for await (const sha of this.legacyBlobs(vaultId)) {
          try {
            const outcome = await this.rename(vaultId, sha);
            if (outcome === "gone") continue;
            r[outcome]++;
            if ((r.renamed + r.duplicates) % 1000 === 0) log.info("blob name migration in progress", { renamed: r.renamed, duplicates: r.duplicates, errors: r.errors });
          } catch (e) {
            failed(e);
          }
        }
        await this.removeLegacyDirs(vaultId);
      } catch (e) {
        failed(e);
      }
    }
    if (r.vaults || r.skipped || r.errors) log.info("blob name migration done", { ...r, errorCodes });
    return r;
  }

  /** Blobs of a vault under their older name (the parent folders match the name). */
  private async *legacyBlobs(vaultId: string): AsyncGenerator<string> {
    const dir = path.join(this.root, vaultId);
    for (const ab of await subdirs(dir)) {
      if (!HEX2_RE.test(ab)) continue;
      for (const cd of await subdirs(path.join(dir, ab))) {
        if (!HEX2_RE.test(cd)) continue;
        let entries;
        try {
          entries = await readdir(path.join(dir, ab, cd), { withFileTypes: true });
        } catch (e) {
          if (errCode(e) === "ENOENT") continue;
          throw e;
        }
        for (const e of entries) if (e.isFile() && SHA_RE.test(e.name) && e.name.slice(0, 2) === ab && e.name.slice(2, 4) === cd) yield e.name;
      }
    }
  }

  /** true when the master key opens one of these blobs: GCM tag and sha256 of the plaintext. */
  private async keyOpensOne(vaultId: string, shas: string[]): Promise<boolean> {
    for (const sha of shas) {
      try {
        const hash = createHash("sha256");
        for await (const c of await this.decrypt(vaultId, sha, await open(this.legacyFile(vaultId, sha), "r"))) hash.update(c as Buffer);
        if (hash.digest("hex") === sha) return true;
      } catch {
        /* another key, a damaged blob or a blob deleted meanwhile: the next one decides */
      }
    }
    return false;
  }

  /** Moves one blob from its older name to its keyed name. */
  private async rename(vaultId: string, sha: string): Promise<"renamed" | "duplicates" | "gone"> {
    const legacy = this.legacyFile(vaultId, sha);
    const keyed = this.keyedFile(vaultId, sha);
    if (existsSync(keyed)) {
      await removeFile(legacy);
      return "duplicates";
    }
    await mkdir(path.dirname(keyed), { recursive: true });
    try {
      await rename(legacy, keyed);
    } catch (e) {
      if (errCode(e) === "ENOENT") return "gone"; // deleted meanwhile
      throw e;
    }
    return "renamed";
  }

  /** Removes the empty folders of the older names (a folder with files stays). */
  private async removeLegacyDirs(vaultId: string): Promise<void> {
    const dir = path.join(this.root, vaultId);
    for (const ab of await subdirs(dir)) {
      if (!HEX2_RE.test(ab)) continue;
      for (const cd of await subdirs(path.join(dir, ab))) if (HEX2_RE.test(cd)) await rmdir(path.join(dir, ab, cd)).catch(() => {});
      await rmdir(path.join(dir, ab)).catch(() => {});
    }
  }
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}
