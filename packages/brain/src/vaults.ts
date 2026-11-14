import type { Sql, TransactionSql } from "@cb/db";
import { newId } from "@cb/shared";

export type VaultKind = "cell" | "space";
export type VectorIndexKind = "binary" | "full" | "none";

export interface Vault {
  id: string;
  kind: VaultKind;
  owner: string | null;
  slug: string;
  name: string;
  schemaMd: string;
  defaultClassification: number;
  vectorIndex: VectorIndexKind;
  chunksPartition: string;
  version: number;
}

export interface CreateVault {
  kind: VaultKind;
  slug: string;
  name: string;
  owner?: string;
  schemaMd?: string;
  defaultClassification?: number;
  /** binary: HNSW on binary_quantize + rescoring (default, large spaces); full: HNSW on halfvec. */
  vectorIndex?: VectorIndexKind;
}

const COLS = `id, kind, owner, slug, name, schema_md as "schemaMd", default_classification as "defaultClassification",
  vector_index as "vectorIndex", chunks_partition as "chunksPartition", version`;

/**
 * Vector index expressions. Queries must use exactly the same expressions, or Postgres does
 * not use the index (see search.ts).
 */
export const vecExpr = (dims: number) => `(embedding::halfvec(${dims}))`;
export const binExpr = (dims: number) => `(binary_quantize(embedding::halfvec(${dims}))::bit(${dims}))`;

export class VaultStore {
  constructor(
    private readonly sql: Sql,
    private readonly dims: number,
  ) {}

  /** Creates the vault, its chunk partition and its indexes, in one transaction. */
  async create(v: CreateVault): Promise<Vault> {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(v.slug)) throw new Error(`invalid vault slug: ${v.slug}`);
    const id = newId("vlt");
    const partition = `chunks_${id.slice(4).toLowerCase()}`;
    const vectorIndex = v.vectorIndex ?? "binary";
    return this.sql.begin(async (tx) => {
      const [row] = await tx<Vault[]>`
        insert into vaults (id, kind, owner, slug, name, schema_md, default_classification, vector_index, chunks_partition)
        values (${id}, ${v.kind}, ${v.owner ?? null}, ${v.slug}, ${v.name}, ${v.schemaMd ?? ""}, ${v.defaultClassification ?? 1},
                ${vectorIndex}, ${partition})
        returning ${tx.unsafe(COLS)}`;
      await tx.unsafe(`create table ${partition} partition of chunks for values in ('${id}')`);
      await this.createVectorIndex(tx, partition, vectorIndex);
      return row!;
    }) as Promise<Vault>;
  }

  private async createVectorIndex(tx: TransactionSql | Sql, partition: string, kind: VectorIndexKind): Promise<void> {
    if (kind === "none") return;
    const expr = kind === "binary" ? `${binExpr(this.dims)} bit_hamming_ops` : `${vecExpr(this.dims)} halfvec_cosine_ops`;
    await tx.unsafe(`create index ${partition}_vec_idx on ${partition} using hnsw (${expr}) with (m = 16, ef_construction = 64)`);
  }

  /** Switches the vector index of a vault (e.g. a space became large). Rebuilds the index. */
  async setVectorIndex(id: string, kind: VectorIndexKind): Promise<void> {
    const v = await this.get(id);
    if (!v) throw new Error(`vault ${id} not found`);
    await this.sql.begin(async (tx) => {
      await tx.unsafe(`drop index if exists ${v.chunksPartition}_vec_idx`);
      await this.createVectorIndex(tx, v.chunksPartition, kind);
      await tx`update vaults set vector_index = ${kind}, updated_at = now() where id = ${id}`;
    });
  }

  async get(idOrSlug: string): Promise<Vault | undefined> {
    const [v] = await this.sql<Vault[]>`select ${this.sql.unsafe(COLS)} from vaults where id = ${idOrSlug} or slug = ${idOrSlug}`;
    return v;
  }

  async list(): Promise<Vault[]> {
    return this.sql<Vault[]>`select ${this.sql.unsafe(COLS)} from vaults order by kind, slug`;
  }

  async versions(ids: string[]): Promise<Map<string, number>> {
    const rows = await this.sql<{ id: string; version: number }[]>`select id, version from vaults where id = any(${ids})`;
    return new Map(rows.map((r) => [r.id, Number(r.version)]));
  }

  /** Deletes the vault with all its pages, sources and chunks (the partition is dropped). */
  async delete(id: string): Promise<boolean> {
    const v = await this.get(id);
    if (!v) return false;
    await this.sql.begin(async (tx) => {
      await tx.unsafe(`drop table if exists ${v.chunksPartition}`);
      await tx`delete from vaults where id = ${v.id}`;
    });
    return true;
  }
}

export async function bumpVersion(tx: TransactionSql | Sql, vaultId: string): Promise<number> {
  const [r] = await tx<{ version: number }[]>`
    update vaults set version = version + 1, updated_at = now() where id = ${vaultId} returning version`;
  return Number(r!.version);
}
