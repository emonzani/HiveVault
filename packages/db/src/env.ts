// Loads .env from the repository root when present (Node >= 22: process.loadEnvFile).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const file = path.join(root, ".env");
if (existsSync(file)) process.loadEnvFile(file);
