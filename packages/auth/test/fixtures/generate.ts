// Vitest global setup: creates the TEST ONLY keys and certificates of the auth tests with OpenSSL
// (company CA, client certificate signed by it, self-signed "rogue" certificate with the same subject).
// The files are ignored by git and created again only when one is missing.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const FILES = ["ca.pem", "client.pem", "client-key.pem", "rogue.pem", "rogue-key.pem"];
const SUBJECT = "/CN=nome.cognomebbb";

export default function setup(): void {
  if (FILES.every((f) => existsSync(path.join(dir, f)))) return;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "hv-fixtures-"));
  const out = (f: string) => path.join(dir, f);
  const t = (f: string) => path.join(tmp, f);
  const ssl = (...args: string[]) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  const ecKey = (file: string) => {
    ssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", file);
  };
  try {
    // company CA (its key stays in the temporary folder)
    ecKey(t("ca-key.pem"));
    ssl("req", "-x509", "-new", "-key", t("ca-key.pem"), "-sha256", "-days", "3650", "-subj", "/CN=HiveVault TEST CA", "-out", out("ca.pem"));
    // client certificate signed by the CA
    ecKey(out("client-key.pem"));
    ssl("req", "-new", "-key", out("client-key.pem"), "-subj", SUBJECT, "-out", t("client.csr"));
    ssl("x509", "-req", "-in", t("client.csr"), "-CA", out("ca.pem"), "-CAkey", t("ca-key.pem"), "-CAcreateserial", "-CAserial", t("ca.srl"), "-sha256", "-days", "3650", "-out", out("client.pem"));
    // self-signed "rogue" certificate with the same subject
    ecKey(out("rogue-key.pem"));
    ssl("req", "-x509", "-new", "-key", out("rogue-key.pem"), "-sha256", "-days", "3650", "-subj", SUBJECT, "-out", out("rogue.pem"));
  } catch (e) {
    throw new Error(`The auth test certificates need OpenSSL on the PATH (openssl version). ${(e as Error).message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
