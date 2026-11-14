// Types and small helpers of the administration console.
import { classificationName, valueLabel } from "./format.ts";

import { t } from "./i18n.ts";
export interface PrincipalView {
  id: string;
  kind: "user" | "api" | "team";
  name: string;
  displayName: string;
  email: string | null;
  role: "admin" | "curator" | "member" | "team";
  scopes: ("read" | "write" | "ingest" | "admin" | "projects")[];
  clearance: number;
  status: "active" | "suspended";
  expiresAt: string | null;
  allowedIps: string[] | null;
  ratePerMin: number | null;
  createdAt: string;
  lastSeenAt: string | null;
  /** API accounts: the user the key acts for. */
  userId: string | null;
}

export interface PrincipalDetail {
  principal: PrincipalView;
  /** Teams of a user. */
  teams: { id: string; name: string; displayName: string }[];
  /** API accounts bound to a user: that user. */
  actsFor?: { id: string; name: string; displayName: string } | null;
  totp: boolean;
  recoveryCodesLeft: number;
  passkeys: { id: string; name: string | null; deviceType: string; createdAt: string; lastUsedAt: string | null }[];
  publicKeys: { id: string; kind: string; fingerprint: string; name: string | null; notAfter: string | null; revokedAt: string | null; lastUsedAt: string | null }[];
  apiKeys: { id: string; name: string; expiresAt: string | null; revokedAt: string | null; createdAt: string; lastUsedAt: string | null }[];
  sessions: { id: string; method: string; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string; expiresAt: string }[];
  grants: { vaultId: string; permission: Permission; slug: string; name: string }[];
}

export interface Checkpoint {
  id: string;
  vaultId: string;
  name: string;
  kind: "manual" | "auto";
  pages: number;
  createdBy: string | null;
  createdAt: string;
}

export interface AdminVault {
  id: string;
  kind: "cell" | "space";
  owner: string | null;
  /** Display name when the owner is a user. */
  ownerLabel: string | null;
  slug: string;
  name: string;
  defaultClassification: number;
  vectorIndex: "binary" | "full" | "none";
  version: number;
  pages: number;
  sources: number;
  grants: number;
}

export type Permission = "read" | "write" | "curate" | "admin";
export const PERMISSION_LABEL: Record<Permission, string> = { read: t("Lettura"), write: t("Scrittura"), curate: t("Curatore"), admin: t("Amministra") };
/** Roles a user can have (the role selects of the console). */
export const USER_ROLE_LABEL: Record<string, string> = { admin: t("Amministratore"), curator: t("Curatore"), member: t("Membro") };
/** Every role, for display: a team principal has the role "team". */
export const ROLE_LABEL: Record<string, string> = { ...USER_ROLE_LABEL, team: t("Team") };
export const SCOPE_LABEL: Record<string, string> = { read: t("lettura"), write: t("scrittura"), ingest: t("caricamento"), admin: t("amministrazione"), projects: t("documentazione dei progetti") };

/** Activation link for a new user or after a TOTP reset: the login screen reads it. */
export const activationLink = (code: string) => `${location.origin}/#/attiva/${encodeURIComponent(code)}`;

export const clearanceLabel = (n: number) => t("fino a {level}", { level: valueLabel(classificationName(n)) });

/** Copies text; the clipboard API needs a secure context (localhost or HTTPS). */
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** ISO date-time from an <input type="date"> value (end of that day), or null. */
export const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59`).toISOString() : null);

const csrfCookie = () => /(?:^|;\s*)cb_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? "";

/** POSTs and saves the answer as a file (vault export). Returns the file name. */
export async function downloadPost(url: string, fallbackName: string): Promise<string> {
  const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "x-cb-csrf": csrfCookie() } });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? t("Richiesta non riuscita ({status}).", { status: res.status }));
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return name;
}

/**
 * `pattern` of a time window input (HH:MM-HH:MM); in a Svelte attribute the braces would be
 * expressions. String.raw keeps the backslashes: "\d" in a plain string is just "d".
 */
export const HHMM_RANGE = String.raw`\d{1,2}:\d{2}-\d{1,2}:\d{2}`;
