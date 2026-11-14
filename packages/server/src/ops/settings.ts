/**
 * Settings changed from the console (plan §8.3). They live in the `settings` table and
 * override the environment; every change is audited by the route that makes it.
 */
import type { Sql } from "@cb/db";

export interface DreamSettings {
  window: string;
  minutes: number;
  tokens: number;
  compilePerNight: number;
  useModel: boolean;
}
export interface NoticeSettings {
  /** Custom text of the cloud agent notice (plain text, paragraphs separated by a blank line); empty = default. */
  text: string;
}
export interface DefaultsSettings {
  /** Default classification of new vaults: 0 pubblico … 3 segreto. */
  classification: number;
}
export interface PrivacySettings {
  /** Days read events (page.read, search, ...) stay in the audit log: they show what each person reads. */
  readRetentionDays: number;
  /** Email files (EML, MSG, MBOX) are ingested; off: they stop as "unsupported". */
  emailIngest: boolean;
}
export interface LocalModelSettings {
  threads: number;
  schedule: "always" | "off-hours" | "on-demand";
  offHours: string;
}
export interface RemoteEndpointSetting {
  id: string;
  kind: "embed" | "rerank" | "chat" | "ocr";
  url: string;
}

export interface SettingsShape {
  dream: DreamSettings;
  notice: NoticeSettings;
  defaults: DefaultsSettings;
  privacy: PrivacySettings;
  "models.local": LocalModelSettings;
  "models.remote": RemoteEndpointSetting[];
  /** New addresses of the remote endpoints of .env (chat, remote-embed-N, remote-rerank-N), by id. */
  "models.overrides": Record<string, string>;
}

export class Settings {
  private cache = new Map<string, unknown>();
  private loaded = false;

  constructor(
    private readonly sql: Sql,
    private readonly defaults: SettingsShape,
  ) {}

  async load(): Promise<void> {
    const rows = await this.sql<{ key: string; value: unknown }[]>`select key, value from settings`;
    this.cache = new Map(rows.map((r) => [r.key, r.value]));
    this.loaded = true;
  }

  /** The value (stored or default). Synchronous after `load`: the dream cycle reads it at every step. */
  get<K extends keyof SettingsShape>(key: K): SettingsShape[K] {
    if (!this.loaded) return this.defaults[key];
    const v = this.cache.get(key);
    if (v === undefined) return this.defaults[key];
    const d = this.defaults[key];
    return (Array.isArray(d) ? v : { ...(d as object), ...(v as object) }) as SettingsShape[K];
  }

  all(): SettingsShape {
    return Object.fromEntries((Object.keys(this.defaults) as (keyof SettingsShape)[]).map((k) => [k, this.get(k)])) as unknown as SettingsShape;
  }

  async set<K extends keyof SettingsShape>(key: K, value: SettingsShape[K], by: string | null): Promise<SettingsShape[K]> {
    await this.sql`
      insert into settings (key, value, updated_by) values (${key}, ${this.sql.json(value as never)}, ${by})
      on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
    this.cache.set(key, value);
    return this.get(key);
  }
}
