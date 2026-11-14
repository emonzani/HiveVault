-- Ingestion (plan §4): sources with origin and nesting, and bulk import jobs.

alter table sources
  add column origin         text not null default 'upload' check (origin in ('upload', 'import', 'link', 'attachment')),
  add column path           text,                          -- original path (import) or URL (link)
  add column parent_id      text references sources(id) on delete cascade,  -- attachments, archive members
  add column title          text,
  add column extracted_sha  text,                          -- L1 Markdown, stored encrypted in the blob store
  add column text_tokens    int,
  add column task_id        text,                          -- ingest task
  add column compiled_page  text references pages(id) on delete set null,
  add column demand         int not null default 0,        -- search hits while not compiled (compile on demand)
  add column created_by     text references principals(id) on delete set null;

create index sources_vault_idx on sources (vault_id, created_at desc);
create index sources_parent_idx on sources (parent_id) where parent_id is not null;
create index sources_level_idx on sources (vault_id, level);

-- Bulk import from a folder or a mounted share (plan §4.4).
create table import_jobs (
  id              text primary key,
  vault_id        text not null references vaults(id) on delete cascade,
  root            text not null,
  include         text[] not null default '{}',            -- glob patterns; empty = everything
  exclude         text[] not null default '{}',
  classification  smallint not null default 1 check (classification between 0 and 3),
  max_file_bytes  bigint not null default 524288000,       -- 500 MB
  files_per_sec   real,                                    -- null = no limit
  window_hours    text,                                    -- "19:00-07:00": runs only in this window
  compile         boolean not null default false,          -- also compile (I3) every file
  status          text not null default 'queued' check (status in ('queued', 'running', 'paused', 'done', 'failed', 'cancelled')),
  task_id         text,
  stats           jsonb not null default '{}',
  error           text,
  created_by      text references principals(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

-- One row per file seen by a job: the next scan reads only new or changed files.
create table import_files (
  job_id     text not null references import_jobs(id) on delete cascade,
  rel_path   text not null,
  size       bigint not null,
  mtime_ms   bigint not null,
  sha256     text,
  source_id  text references sources(id) on delete set null,
  status     text not null check (status in ('pending', 'stored', 'skipped', 'error')),
  reason     text,
  seen_at    timestamptz not null default now(),
  primary key (job_id, rel_path)
);
create index import_files_pending_idx on import_files (job_id) where status = 'pending';

-- Status changes of sources are announced (server-sent events to the browser).
create function sources_notify() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status or new.level is distinct from old.level then
    perform pg_notify('cb_source', json_build_object('id', new.id, 'vault', new.vault_id, 'status', new.status, 'level', new.level)::text);
  end if;
  return new;
end $$;
create trigger sources_notify_trg after insert or update of status, level on sources
  for each row execute function sources_notify();
