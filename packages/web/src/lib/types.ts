// Shapes of the server answers used by the web app.

export type Permission = "read" | "write" | "curate" | "admin";

export interface Vault {
  id: string;
  slug: string;
  name: string;
  kind: "cell" | "space";
  permission: Permission;
  /** "user:<id>", "edge:<id>", "team:<id>", "project:<id>"; null for hive spaces. */
  owner?: string | null;
  /** Pages the user can read. */
  pages?: number;
  /** The user's own personal vault: there it may classify content "personale". */
  personal?: boolean;
  /** Level of new content when the writer chooses none (0–4). */
  defaultClassification?: number;
}

export interface Principal {
  id: string;
  kind: "user" | "api";
  name: string;
  displayName: string;
  email: string | null;
  role: string;
  clearance: number;
}

export interface Me {
  principal: Principal;
  via: string;
  isAdmin: boolean;
  clearance: number;
  csrf: string | null;
  vaults: Vault[];
}

export interface PageListItem {
  id: string;
  title: string;
  type: string;
  path: string;
  tokens: number;
  classification: number;
  updatedAt: string;
  vaultId?: string;
}

export interface OutLink {
  raw: string;
  target: string;
  pageId: string | null;
  title: string | null;
  vaultId: string | null;
}

export interface CitationRef {
  ref: string;
  kind: "source" | "page" | "unknown";
  id: string;
  name: string | null;
  excerpt: string | null;
  chunkId: string | null;
}

export interface FullPage {
  id: string;
  vaultId: string;
  path: string;
  title: string;
  type: string;
  tldr: string;
  body: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  visibility: number;
  classification: number;
  confidence: number | null;
  tokens: number;
  version: number;
  updatedAt: string;
  aliases: string[];
  links: OutLink[];
  citations: CitationRef[];
  backlinks: number;
  permission: Permission | null;
  canWrite: boolean;
  /** Written by the dream cycle (hive page, maintenance page): read-only. */
  generated?: boolean;
  /** A generated page an administrator may correct now (rectification). */
  rectifiable?: boolean;
  /** The page is in the reader's own personal vault. */
  personalOwner?: boolean;
  agentReadable: boolean;
}

export interface Backlink {
  id: string;
  title: string;
  type: string;
  vaultId: string;
  context: string;
}

export interface SearchChunk {
  id: string;
  /** Passage with the matched terms between « and ». */
  snippet: string;
  heading?: string | null;
  blockId?: string | null;
  score?: number;
}

export interface SearchHit {
  kind: "page" | "source";
  id: string;
  vaultId: string;
  title: string;
  type: string;
  tldr: string;
  level: "I1" | "I2" | "I3";
  classification: number;
  tokens: number;
  score: number;
  cite: string;
  chunks: SearchChunk[];
  matchedTitle: boolean;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  totalTokens: number;
  degraded: string[];
  tookMs: number;
  cached: boolean;
}

export interface Suggestion {
  id: string;
  title: string;
  type: string;
  vaultId: string;
  alias: string | null;
}

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  vaultId: string;
  degree?: number;
  depth?: number;
}
export interface GraphEdge {
  from: string;
  to: string;
  /** wikilink, embed or a typed relation (missing in the local graph of a page). */
  kind?: string;
  /** The two pages are in different vaults. */
  cross?: boolean;
}

export interface SourceRow {
  id: string;
  vaultId: string;
  name: string;
  mime: string;
  size: number;
  status: string;
  level: number;
  origin: string;
  title: string | null;
  classification: number;
  compiledPage: string | null;
  textTokens: number | null;
  error: string | null;
  warnings: string[] | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceDetail extends SourceRow {
  path: string | null;
  parentId: string | null;
  parserVersion: string | null;
  meta: Record<string, unknown>;
  chunks: number;
  children: { id: string; name: string; status: string; level: number }[] | null;
  task: { status: string; phase: string; attempts: number; error: string | null } | null;
  /** Compiled into a page (I3) by the pipeline. */
  compile: boolean;
}

export interface SourceChunk {
  id: string;
  ord: number;
  heading: string | null;
  text: string;
  tokens: number;
}

export interface VersionItem {
  version: number;
  title: string;
  author: string | null;
  createdAt: string;
  current: boolean;
}

export interface ReadResult {
  id: string;
  title: string;
  type: string;
  tldr: string;
  classification: number;
  content: string;
  contentTokens: number;
  tokens: number;
  truncated: boolean;
}
