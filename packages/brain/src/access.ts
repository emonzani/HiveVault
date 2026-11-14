import type { Sql, TransactionSql } from "@cb/db";

/**
 * Classification levels (plan §3.6). "personale" (4) is outside the clearance ladder: it is the
 * content of one person, read only by the owner of the personal vault ("user:<id>"), never by
 * administrators, grantees, teams or API accounts (`Principal.personal`, RLS `cb_personal()`).
 */
export const CLASSIFICATIONS = ["pubblico", "interno", "riservato", "segreto", "personale"] as const;
/** Level of "personale". */
export const PERSONAL = 4;
export type ClassificationName = (typeof CLASSIFICATIONS)[number];
export const VISIBILITIES = ["privato", "team", "azienda"] as const;
export type VisibilityName = (typeof VISIBILITIES)[number];

/** "personale" outside a personal vault: there is no person who owns it. HTTP 400. */
export class PersonalClassificationError extends Error {
  readonly statusCode = 400;
  constructor() {
    super("La classificazione «personale» vale solo nei vault personali.");
  }
}

/** A personal vault belongs to one person: owner "user:<id>". */
export const isPersonalOwner = (owner: string | null | undefined): boolean => !!owner?.startsWith("user:");

export function classificationLevel(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= PERSONAL) return v;
  const i = CLASSIFICATIONS.indexOf(String(v ?? "").toLowerCase() as ClassificationName);
  return i >= 0 ? i : fallback;
}
export function visibilityLevel(v: unknown, fallback: number): number {
  if (typeof v === "number" && v >= 0 && v <= 2) return v;
  const i = VISIBILITIES.indexOf(String(v ?? "").toLowerCase() as VisibilityName);
  return i >= 0 ? i : fallback;
}

/**
 * Who is reading: the vaults the principal may read (already resolved from the ACL) and the
 * highest classification it may see. MCP accounts get clearance ≤ 1 (interno) unless an
 * admin decides otherwise.
 */
export interface Principal {
  id: string;
  vaults: string[];
  clearance: number;
  /** The reader's own personal vaults: there it also reads "personale" content. */
  personal?: string[];
}

/**
 * Runs `fn` in a transaction as the restricted role `cb_reader`, with the principal's vaults
 * and clearance set for Row Level Security. Every read for a user or an API account goes
 * through here: even a query that forgets its vault filter cannot see other vaults.
 */
export async function withReader<T>(sql: Sql, p: Principal, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const personal = (p.personal ?? []).filter((v) => p.vaults.includes(v));
  for (const v of [...p.vaults, ...personal]) if (!/^[\w-]+$/.test(v)) throw new Error(`invalid vault id: ${v}`);
  return sql.begin(async (tx) => {
    await tx`set local role cb_reader`;
    await tx`select set_config('cb.vaults', ${`{${p.vaults.join(",")}}`}, true), set_config('cb.clearance', ${String(p.clearance)}, true),
                     set_config('cb.personal', ${`{${personal.join(",")}}`}, true)`;
    return fn(tx);
  }) as Promise<T>;
}
