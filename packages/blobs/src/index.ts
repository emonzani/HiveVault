/**
 * Raw store (L0): original documents, content-addressed and encrypted at rest.
 *
 * - Address: SHA-256 of the plaintext. The same file in the same vault is stored once.
 * - Encryption: AES-256-GCM, one key per vault derived with HKDF from the master key, so a
 *   leaked vault key does not open other vaults and a vault is erased by forgetting its key.
 * - File format: "CBB1" (4 bytes) | IV (12) | ciphertext | GCM tag (16).
 * - Streaming in both directions: files of any size never sit in memory.
 * - Atomic writes: temporary file + rename; a crash never leaves a half blob at its address.
 * - Tampering or corruption: reading fails with an authentication error (GCM tag).
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createLogger, strEnv } from "@cb/shared";

const MAGIC = Buffer.from("CBB1");
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + IV_LEN;
const log = createLogger("blobs");

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

  private file(vaultId: string, sha: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error(`invalid sha256: ${sha}`);
    if (!/^[\w-]+$/.test(vaultId)) throw new Error(`invalid vault id: ${vaultId}`);
    return path.join(this.root, vaultId, sha.slice(0, 2), sha.slice(2, 4), sha);
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
    const dest = this.file(vaultId, sha256);
    if (existsSync(dest)) {
      await rm(tmp, { force: true });
      return { sha256, size, created: false };
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(tmp, dest);
    return { sha256, size, created: true };
  }

  async get(vaultId: string, sha256: string): Promise<Readable> {
    const file = this.file(vaultId, sha256);
    const { size } = await stat(file);
    if (size < HEADER_LEN + TAG_LEN) throw new Error(`blob ${sha256} is truncated`);
    const fh = await open(file, "r");
    const head = Buffer.alloc(HEADER_LEN);
    const tag = Buffer.alloc(TAG_LEN);
    try {
      await fh.read(head, 0, HEADER_LEN, 0);
      await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
    } finally {
      await fh.close();
    }
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`blob ${sha256}: unknown format`);
    const decipher = createDecipheriv("aes-256-gcm", this.vaultKey(vaultId), head.subarray(MAGIC.length));
    decipher.setAuthTag(tag);
    const out = new PassThrough();
    const body = size - HEADER_LEN - TAG_LEN;
    const input = body > 0 ? createReadStream(file, { start: HEADER_LEN, end: HEADER_LEN + body - 1 }) : Readable.from([]);
    pipeline(input, decipher, out).catch((err) => out.destroy(err));
    return out;
  }

  async has(vaultId: string, sha256: string): Promise<boolean> {
    return existsSync(this.file(vaultId, sha256));
  }

  async delete(vaultId: string, sha256: string): Promise<boolean> {
    const f = this.file(vaultId, sha256);
    if (!existsSync(f)) return false;
    await rm(f);
    return true;
  }
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}
