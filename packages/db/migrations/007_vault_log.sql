-- Vault log (LLM-Wiki "log.md"): an append-only timeline of what happened in a vault —
-- ingested sources, compiled pages, lint passes. Exported as log.md; read by the compiler
-- to know what was done recently.
create table vault_log (
  id        bigint generated always as identity primary key,
  vault_id  text not null references vaults(id) on delete cascade,
  at        timestamptz not null default now(),
  kind      text not null,             -- ingest, compile, lint, import, ...
  title     text not null,
  ref       text,                      -- source or page id
  data      jsonb
);
create index vault_log_vault_idx on vault_log (vault_id, id desc);

alter table vault_log enable row level security;
grant select on vault_log to cb_reader;
create policy reader_vault_log on vault_log for select to cb_reader using (vault_id = any ((select cb_vaults())::text[]));

-- A source marked for compilation (I3): user uploads by default, imports on demand.
alter table sources add column compile boolean not null default false;
