// HiveVault command line: `npm run cb -- <command>`.
//
//   admin create <username> [--name "Nome Cognome"]   first administrator (only when there is none)
//   enroll <code>                                     TOTP setup in the terminal (QR code + recovery codes)
//   key gen [--type ed25519|p256] [--out <dir>]       key pair for the challenge login
//   login --user <username> --key <private.pem> [--url <server>]   challenge login, prints a session token
//   api create <name> --scopes <a,b> [--clearance 0-3] [--user <username>]   API account and its key (bound
//                                                     to a user with --user); stdout is the key alone,
//                                                     so it can go straight to a file (`> key`), never to a screen
//   dream <vault...> | --all [--full]                 starts the dream cycle now (vault id or slug); --full also looks at old pages
//   audit verify                                      checks the hash chain of the audit log; exit code 1 when it is broken
import "../../db/src/env.ts";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import QRCode from "qrcode";
import { SCOPES, signLogin, verifyAuditChain, type Scope } from "@cb/auth";
import { startDream } from "@cb/hive";
import { loadServerConfig } from "./config.ts";
import { createServices } from "./services.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = loadServerConfig();

function usage(): never {
  console.log(`Uso:
  npm run cb -- admin create <username> [--name "Nome Cognome"]
  npm run cb -- enroll <codice>
  npm run cb -- key gen [--type ed25519|p256] [--out <cartella>]
  npm run cb -- login --user <username> --key <chiave-privata.pem> [--url ${cfg.publicUrl}]
  npm run cb -- api create <nome> --scopes ${SCOPES.join(",")} [--clearance 0-3] [--user <utente>]   (stampa solo la chiave; --user lega la chiave ai permessi di un utente)
  npm run cb -- dream <id-o-slug-vault...> | --all [--full]   (--full: anche le pagine non modificate)
  npm run cb -- audit verify   (controlla la catena di hash del registro di audit)`);
  process.exit(2);
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

const [cmd, sub] = args;
try {
  if (cmd === "admin" && sub === "create") {
    const username = args[2];
    if (!username) usage();
    const s = await createServices(cfg, { models: false });
    try {
      const r = await s.auth.bootstrapAdmin(username, flag("name") ?? username);
      console.log(`\nAmministratore "${r.principal.name}" creato.`);
      console.log(`Codice di attivazione (valido fino a ${r.enrollment.expiresAt.toLocaleString("it-IT")}):\n\n    ${r.enrollment.code}\n`);
      console.log(`Completa l'attivazione con:  npm run cb -- enroll ${r.enrollment.code}`);
    } finally {
      await s.stop();
    }
  } else if (cmd === "api" && sub === "create") {
    process.env.LOG_STREAM = "stderr";
    const name = args[2];
    const scopes = (flag("scopes") ?? "").split(",").map((x) => x.trim()).filter(Boolean) as Scope[];
    if (!name || !scopes.length) usage();
    const s = await createServices(cfg, { models: false });
    try {
      const username = flag("user");
      const owner = username ? await s.auth.principals.getByName(username) : undefined;
      if (username && owner?.kind !== "user") throw new Error(`Utente "${username}" non trovato.`);
      const p = await s.auth.principals.createApiAccount({ name, scopes, clearance: Number(flag("clearance") ?? 1), userId: owner?.id ?? null });
      const { key } = await s.auth.apiKeys.issue(p.id, "Chiave della CLI");
      await s.auth.audit.writeNow({ principalId: null, action: "admin.api.create", resource: p.id, data: { name: p.name, scopes, userId: p.userId, via: "cli" } });
      // stdout: the key alone; what a person reads goes to stderr
      process.stdout.write(`${key}\n`);
      console.error(`Account API "${p.name}" creato (ambiti: ${scopes.join(", ")}${owner ? `; agisce per l'utente "${owner.name}"` : ""}). La chiave è stata scritta sull'uscita standard.`);
    } finally {
      await s.stop();
    }
  } else if (cmd === "enroll") {
    const code = sub;
    if (!code) usage();
    const s = await createServices(cfg, { models: false });
    try {
      const st = await s.auth.totp.startEnrollment(code);
      console.log(`\nAttivazione per "${st.username}". Inquadra il codice QR con l'app di autenticazione:\n`);
      console.log(await QRCode.toString(st.otpauthUri, { type: "terminal", small: true }));
      console.log(`Oppure inserisci a mano la chiave: ${st.secretBase32}\n`);
      const totpCode = await ask("Codice a 6 cifre mostrato dall'app: ");
      const r = await s.auth.enrollConfirm(code, totpCode, { userAgent: "cb-cli" });
      await s.auth.sessions.revokeToken(r.session.token); // the CLI does not keep the session
      console.log("\nAttivazione completata. Codici di recupero (usali se perdi il telefono; ognuno vale una volta):\n");
      for (const c of r.recoveryCodes) console.log(`    ${c}`);
      console.log("\nConservali in un posto sicuro: non verranno mostrati di nuovo.");
    } finally {
      await s.stop();
    }
  } else if (cmd === "key" && sub === "gen") {
    const type = flag("type") ?? "ed25519";
    const out = path.resolve(flag("out") ?? ".");
    mkdirSync(out, { recursive: true });
    const kp = type === "p256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
    const privFile = path.join(out, `cb-${type}.key.pem`);
    const pubFile = path.join(out, `cb-${type}.pub.pem`);
    writeFileSync(privFile, kp.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(pubFile, kp.publicKey.export({ type: "spki", format: "pem" }));
    console.log(`Chiave privata: ${privFile}  (non condividerla)\nChiave pubblica: ${pubFile}  (registrala nel tuo profilo o falla registrare all'amministratore)`);
  } else if (cmd === "login") {
    const user = flag("user");
    const keyFile = flag("key");
    if (!user || !keyFile) usage();
    const url = (flag("url") ?? cfg.publicUrl).replace(/\/+$/, "");
    const ch = (await (await fetch(`${url}/api/auth/challenge?username=${encodeURIComponent(user)}`)).json()) as { challengeId: string; nonce: string };
    const signed = signLogin(readFileSync(keyFile, "utf8"), user, ch.nonce);
    const res = await fetch(`${url}/api/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: user, challengeId: ch.challengeId, ...signed }),
    });
    const body = (await res.json()) as { token?: string; csrf?: string; expiresAt?: string; error?: { message: string } };
    if (!res.ok) {
      console.error(body.error?.message ?? `Accesso non riuscito (HTTP ${res.status}).`);
      process.exit(1);
    }
    console.log(`Accesso eseguito. Sessione valida fino a ${new Date(body.expiresAt!).toLocaleString("it-IT")}.`);
    console.log(`Cookie:     cb_session=${body.token}`);
    console.log(`CSRF:       ${body.csrf}   (header x-cb-csrf per le richieste che modificano dati)`);
  } else if (cmd === "dream") {
    const ids = args.slice(1).filter((x) => !x.startsWith("--"));
    const all = args.includes("--all");
    if (!ids.length && !all) usage();
    const full = args.includes("--full");
    const s = await createServices(cfg, { models: false });
    try {
      const vaults = all ? (await s.sql<{ id: string }[]>`select id from vaults order by id`).map((v) => v.id) : ids;
      let started = 0;
      for (const name of vaults) {
        try {
          const r = await startDream(s.sql, s.dream, { vaultId: name, window: cfg.dream.window, full });
          await s.auth.audit.writeNow({ principalId: null, action: "admin.vault.dream", resource: r.vaultId, data: { full, via: "cli" } });
          console.log(`${name}: ciclo avviato (attività ${r.taskId}, notte ${r.night}).`);
          started++;
        } catch (e) {
          console.error(`${name}: ${(e as Error).message}`);
          process.exitCode = 1;
        }
      }
      if (started) console.log("Il server esegue i cicli: segui lo stato nella pagina Ciclo notturno.");
    } finally {
      await s.stop();
    }
  } else if (cmd === "audit" && sub === "verify") {
    const s = await createServices(cfg, { models: false });
    try {
      const r = await verifyAuditChain(s.sql);
      await s.auth.audit.writeNow({ principalId: null, action: "admin.audit.verify", data: { rows: r.rows, broken: r.broken, via: "cli" } });
      if (r.broken) {
        console.error(`Catena di audit interrotta alla riga ${r.broken.seq} (${r.broken.reason}). Righe controllate: ${r.rows}.`);
        process.exitCode = 1;
      } else {
        console.log(`Catena di audit integra: ${r.rows} eventi di sicurezza (da ${r.first ?? "-"} a ${r.last ?? "-"}).`);
      }
    } finally {
      await s.stop();
    }
  } else {
    usage();
  }
} catch (e) {
  console.error(`Errore: ${(e as Error).message}`);
  process.exitCode = 1;
}
