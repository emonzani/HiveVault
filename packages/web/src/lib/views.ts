// The views a tab can show and the sections of the console. Plain data, no runes and no
// browser APIs: the dashboard definitions and the phase 7 benchmark import it from Node too.
import { t } from "./i18n.ts";

export type View =
  | { kind: "home" }
  | { kind: "page"; id: string; anchor?: string; edit?: boolean }
  | { kind: "search"; q: string }
  | { kind: "graph" }
  | { kind: "source"; id: string; chunk?: string }
  | { kind: "inbox"; tab?: "inbox" | "review" }
  | { kind: "agent" }
  | { kind: "history"; id: string }
  | { kind: "account" }
  | { kind: "curator" }
  | { kind: "dream" }
  | { kind: "admin"; section: AdminSection; id?: string }
  | { kind: "dashboard"; id: string };

/** Sections of the administration console (#/admin/<section>). */
export type AdminSection = "utenti" | "team" | "api" | "vault" | "permessi" | "sorgenti" | "import" | "task" | "modelli" | "audit" | "impostazioni" | "backup";
export const ADMIN_SECTIONS: { id: AdminSection; label: string; icon: string }[] = [
  { id: "utenti", label: t("Utenti"), icon: "user" },
  { id: "team", label: t("Team"), icon: "user" },
  { id: "api", label: t("Account API"), icon: "key" },
  { id: "vault", label: t("Vault e spazi"), icon: "hive" },
  { id: "permessi", label: t("Permessi"), icon: "shield" },
  { id: "sorgenti", label: t("Sorgenti"), icon: "file" },
  { id: "import", label: t("Import massivi"), icon: "upload" },
  { id: "task", label: t("Task"), icon: "task" },
  { id: "modelli", label: t("Modelli"), icon: "cpu" },
  { id: "audit", label: t("Audit"), icon: "history" },
  { id: "impostazioni", label: t("Impostazioni"), icon: "settings" },
  { id: "backup", label: t("Backup"), icon: "database" },
];
