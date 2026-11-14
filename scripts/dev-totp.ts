// Prints the current TOTP code of the demo user (development only; see scripts/seed-demo.ts).
import { readFileSync } from "node:fs";
import path from "node:path";
import { base32Decode, totp } from "@cb/auth";

const file = path.join(process.env.DATA_DIR ?? "data", "dev-demo.json");
const { username, secret } = JSON.parse(readFileSync(file, "utf8")) as { username: string; secret: string };
const left = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`${username}: ${totp(base32Decode(secret))} (valido ancora ${left} s)`);
