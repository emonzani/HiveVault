/**
 * Export and import of a vault as an Obsidian folder (plan §3.3).
 *
 *   SCHEMA.md            rules of the vault
 *   index.md             catalog by category: "- [[Title]] — tldr" (LLM-Wiki index)
 *   llms.txt             map for agents (llms.txt format)
 *   entities/…, concepts/…, decisions/…, sources/…, syntheses/…, notes/…
 *
 * Obsidian resolves [[Title]] by file name, so a page is written as "<folder>/<Title>.md"
 * (characters not allowed in file names are replaced; the real title stays in the
 * frontmatter). The frontmatter keeps the page id: importing the export again updates the
 * same pages instead of creating copies.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "@cb/db";
import { CLASSIFICATIONS, classificationLevel, PERSONAL, VISIBILITIES } from "./access.ts";
import { parseDocument, serializeDocument } from "./markdown.ts";
import { pageCols, pageFolder, PageStore, type Page } from "./pages.ts";

const RESERVED = new Set(["schema.md", "index.md", "llms.txt", "log.md"]);
const FOLDER_TITLES: Record<string, string> = {
  entities: "Entità",
  concepts: "Concetti",
  decisions: "Decisioni",
  sources: "Sorgenti",
  syntheses: "Sintesi",
  notes: "Note",
};

/** File name for a title: Obsidian-safe and unique in its folder. */
export function obsidianFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 120) || "Pagina";
}

export interface ExportResult {
  dir: string;
  pages: number;
  files: number;
}

export async function exportVault(sql: Sql, vaultId: string, dir: string): Promise<ExportResult> {
  const [vault] = await sql<{ name: string; slug: string; schemaMd: string }[]>`
    select name, slug, schema_md as "schemaMd" from vaults where id = ${vaultId}`;
  if (!vault) throw new Error(`vault ${vaultId} not found`);
  // "personale" pages stay out: an export is made by an administrator
  const pages = await sql<Page[]>`select ${sql.unsafe(pageCols())} from pages where vault_id = ${vaultId} and classification <> ${PERSONAL} order by type, title`;
  await mkdir(dir, { recursive: true });

  const used = new Set<string>();
  const files = new Map<string, string>(); // page id -> relative file
  for (const p of pages) {
    const folder = pageFolder(p.type);
    let name = obsidianFileName(p.title);
    for (let n = 2; used.has(`${folder}/${name}`.toLowerCase()); n++) name = `${obsidianFileName(p.title)} (${n})`;
    used.add(`${folder}/${name}`.toLowerCase());
    files.set(p.id, `${folder}/${name}.md`);
  }

  for (const p of pages) {
    const fm: Record<string, unknown> = { ...(p.frontmatter as Record<string, unknown>) };
    fm.id = p.id;
    fm.title = p.title;
    fm.type = p.type;
    fm.tldr = p.tldr || undefined;
    fm.classification = CLASSIFICATIONS[p.classification];
    fm.visibility = VISIBILITIES[p.visibility];
    fm.updated = p.updatedAt.toISOString().slice(0, 10);
    fm.tokens = p.tokens;
    const file = path.join(dir, files.get(p.id)!);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, serializeDocument(fm, p.body.endsWith("\n") ? p.body : p.body + "\n"), "utf8");
  }

  await writeFile(path.join(dir, "SCHEMA.md"), vault.schemaMd || `# Schema del vault ${vault.name}\n\nNessuna regola definita.\n`, "utf8");

  // index.md: content-oriented catalog (LLM-Wiki), one line per page
  const byFolder = new Map<string, Page[]>();
  for (const p of pages) {
    const f = pageFolder(p.type);
    byFolder.set(f, [...(byFolder.get(f) ?? []), p]);
  }
  const index = [`# Indice — ${vault.name}`, "", `${pages.length} pagine.`, ""];
  const llms = [`# ${vault.name}`, "", `> Vault "${vault.slug}" di HiveVault: ${pages.length} pagine. Leggi SCHEMA.md per le convenzioni.`, ""];
  for (const [folder, ps] of [...byFolder.entries()].sort()) {
    index.push(`## ${FOLDER_TITLES[folder] ?? folder}`, "");
    llms.push(`## ${FOLDER_TITLES[folder] ?? folder}`, "");
    for (const p of ps) {
      const file = files.get(p.id)!;
      const link = path.basename(file, ".md");
      index.push(`- [[${link}${link !== p.title ? `|${p.title}` : ""}]] — ${p.tldr || "(senza sintesi)"}`);
      llms.push(`- [${p.title}](${encodeURI(file)}): ${p.tldr || p.type} (${p.tokens} token)`);
    }
    index.push("");
    llms.push("");
  }
  await writeFile(path.join(dir, "index.md"), index.join("\n"), "utf8");
  await writeFile(path.join(dir, "llms.txt"), llms.join("\n"), "utf8");
  return { dir, pages: pages.length, files: pages.length + 3 };
}

export interface ImportResult {
  pages: number;
  created: number;
  updated: number;
  unchanged: number;
  unresolvedLinks: number;
  /** Files left out: "personale" pages, or files that would overwrite one. */
  skipped: number;
}

/** Imports every Markdown file of a folder (an Obsidian vault or an export) into a vault. */
export async function importVault(sql: Sql, store: PageStore, vaultId: string, dir: string, author = "import"): Promise<ImportResult> {
  async function walk(d: string): Promise<string[]> {
    const es = await readdir(d, { withFileTypes: true });
    const nested = await Promise.all(
      es.filter((e) => !e.name.startsWith(".")).map((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])),
    );
    return nested.flat();
  }
  const files = (await walk(dir)).filter((f) => f.toLowerCase().endsWith(".md")).sort();
  const res: ImportResult = { pages: 0, created: 0, updated: 0, unchanged: 0, unresolvedLinks: 0, skipped: 0 };
  // an import never creates, overwrites or reads "personale" pages: it is an administrator's tool
  const personal = await sql<{ id: string; path: string }[]>`select id, path from pages where vault_id = ${vaultId} and classification = ${PERSONAL}`;
  const personalIds = new Set(personal.map((p) => p.id));
  const personalPaths = new Set(personal.map((p) => p.path));
  for (const f of files) {
    const rel = path.relative(dir, f).replaceAll("\\", "/");
    if (RESERVED.has(rel.toLowerCase())) {
      if (rel.toLowerCase() === "schema.md") {
        await sql`update vaults set schema_md = ${await readFile(f, "utf8")}, updated_at = now() where id = ${vaultId}`;
      }
      continue;
    }
    const markdown = await readFile(f, "utf8");
    const titleFromFile = path.basename(rel, ".md");
    // Obsidian notes often have no frontmatter title: the file name is the title.
    const withTitle = /^---[\s\S]*?\ntitle:/m.test(markdown.split(/\n---\n/)[0] ?? "") ? markdown : injectTitle(markdown, titleFromFile);
    const fm = parseDocument(withTitle).frontmatter;
    if (classificationLevel(fm.classification, -1) === PERSONAL || personalPaths.has(rel) || (typeof fm.id === "string" && personalIds.has(fm.id))) {
      res.skipped++;
      continue;
    }
    const r = await store.upsert({ vaultId, markdown: withTitle, path: rel, author });
    res.pages++;
    if (r.created) res.created++;
    else if (r.changed) res.updated++;
    else res.unchanged++;
  }
  const [{ n }] = (await sql`
    select count(*)::int as n from links where vault_id = ${vaultId} and dst_page is null and kind = 'wikilink'`) as unknown as [{ n: number }];
  res.unresolvedLinks = n;
  return res;
}

function injectTitle(markdown: string, title: string): string {
  if (markdown.startsWith("---\n")) return markdown.replace(/^---\n/, `---\ntitle: ${JSON.stringify(title)}\n`);
  return `---\ntitle: ${JSON.stringify(title)}\n---\n${markdown}`;
}

export { PageStore };
