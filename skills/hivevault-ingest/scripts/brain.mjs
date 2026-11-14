#!/usr/bin/env node
// HiveVault command-line client for loading documents (Node.js 18+, no packages).
// Environment: HIVEVAULT_URL, HIVEVAULT_API_KEY.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const URL_ = (process.env.HIVEVAULT_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.HIVEVAULT_API_KEY ?? "";
const [cmd, ...args] = process.argv.slice(2);

function usage(code = 0) {
  console.log(`Uso:
  brain.mjs vaults
  brain.mjs upload <vault> <file...> [--compile] [--classification pubblico|interno|riservato|segreto]
  brain.mjs link <vault> <url> [--compile]
  brain.mjs status <source-id>
  brain.mjs wait <source-id> [level]
  brain.mjs review`);
  process.exit(code);
}
if (!cmd || cmd === "help") usage();
if (!URL_ || !KEY) {
  console.error("Imposta HIVEVAULT_URL e HIVEVAULT_API_KEY.");
  process.exit(2);
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${URL_}${path}`, { method, headers: { authorization: `Bearer ${KEY}`, accept: "application/json", ...headers }, body });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === "object" ? (data.error?.message ?? data.message ?? text) : text;
    console.error(`Errore ${res.status}: ${msg}`);
    process.exit(1);
  }
  return data;
}

const LEVELS = ["", "I1", "I2", "I3"];
const CLASS = { pubblico: 0, interno: 1, riservato: 2, segreto: 3 };
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--classification"));

async function vaultId(ref) {
  const vaults = await call("GET", "/api/vaults");
  const v = vaults.find((x) => x.id === ref || x.slug === ref);
  if (!v) {
    console.error(`Vault «${ref}» non accessibile. Disponibili: ${vaults.map((x) => x.slug).join(", ")}`);
    process.exit(1);
  }
  return v.id;
}

function show(s) {
  const warn = (s.meta?.warnings ?? s.warnings ?? []).join(", ");
  console.log(`${s.id}  ${s.status}  ${LEVELS[s.level] || "-"}  ${s.title ?? s.name}${warn ? `  [${warn}]` : ""}${s.error ? `  errore: ${s.error}` : ""}`);
}

switch (cmd) {
  case "vaults": {
    for (const v of await call("GET", "/api/vaults")) console.log(`${v.slug.padEnd(28)} ${v.permission.padEnd(8)} ${v.kind.padEnd(6)} ${v.name}`);
    break;
  }
  case "upload": {
    const [vault, ...files] = positional;
    if (!vault || !files.length) usage(2);
    const id = await vaultId(vault);
    const form = new FormData();
    form.append("compile", String(flag("compile")));
    const cls = opt("classification");
    if (cls) form.append("classification", String(CLASS[cls] ?? cls));
    for (const f of files) form.append("file", new Blob([await readFile(f)]), basename(f));
    const r = await call("POST", `/api/vaults/${id}/sources`, form);
    for (const s of r.sources) console.log(`${s.id}  ${s.created ? "nuovo" : "già presente"}  ${s.name}`);
    break;
  }
  case "link": {
    const [vault, url] = positional;
    if (!vault || !url) usage(2);
    const r = await call("POST", `/api/vaults/${await vaultId(vault)}/links`, JSON.stringify({ url, compile: flag("compile") }), { "content-type": "application/json" });
    console.log(`${r.id}  ${r.created ? "nuovo" : "già presente"}  ${r.url}`);
    break;
  }
  case "status": {
    if (!positional[0]) usage(2);
    show(await call("GET", `/api/sources/${positional[0]}`));
    break;
  }
  case "wait": {
    const [id, level = "1"] = positional;
    if (!id) usage(2);
    for (let i = 0; i < 600; i++) {
      const s = await call("GET", `/api/sources/${id}`);
      if (s.level >= Number(level) || ["failed", "unsupported"].includes(s.status)) {
        show(s);
        process.exit(s.status === "failed" ? 1 : 0);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.error("Tempo scaduto: il documento è ancora in elaborazione.");
    process.exit(1);
  }
  case "review": {
    const rows = await call("GET", "/api/review?limit=100");
    if (!rows.length) console.log("Nessun documento da rivedere.");
    rows.forEach(show);
    break;
  }
  default:
    usage(2);
}
