-- Phase 5: hive memory and dream cycle (plan §3.2 and §5).

-- Claims: atomic statements extracted from the "Stato attuale" of the pages. Base for the
-- promotion to the hive (agreeing values are merged, different values open a conflict).
create table claims (
  id            text primary key,
  vault_id      text not null references vaults(id) on delete cascade,
  page_id       text not null references pages(id) on delete cascade,
  block_id      text,                                -- section of the page (provenance ^[page#block])
  subject       text not null,                       -- page title
  subject_norm  text not null,
  predicate     text not null,                       -- normalized label: "postazioni", "referente tecnico"
  value         text not null,
  value_norm    text not null,
  cites         text[] not null default '{}',        -- citations of the bullet (sources)
  observed_at   date,
  confidence    real,
  classification smallint not null default 1,
  visibility    smallint not null default 2,
  status        text not null default 'active' check (status in ('active', 'retracted')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (page_id, predicate, value_norm)
);
create index claims_subject_idx on claims (subject_norm, predicate) where status = 'active';
create index claims_vault_idx on claims (vault_id, updated_at desc);

-- Which cells feed which hive space, and for which page types.
create table hive_feeds (
  space_id   text not null references vaults(id) on delete cascade,
  cell_id    text not null references vaults(id) on delete cascade,
  types      text[] not null default '{entity}',
  created_at timestamptz not null default now(),
  primary key (space_id, cell_id)
);

-- Curator queue: conflicts, duplicate candidates, lint findings, low-confidence merges.
-- `fingerprint` keeps one item per finding across nights (idempotent dream steps).
create table curator_items (
  id           text primary key,
  space_id     text not null references vaults(id) on delete cascade,
  kind         text not null check (kind in ('conflict', 'duplicate', 'lint', 'low_confidence')),
  fingerprint  text not null,
  subject      text not null,
  predicate    text,
  page_id      text references pages(id) on delete set null,
  data         jsonb not null default '{}',
  status       text not null default 'open' check (status in ('open', 'resolved', 'dismissed', 'superseded')),
  resolution   jsonb,
  resolved_by  text references principals(id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (space_id, fingerprint)
);
create index curator_items_open_idx on curator_items (space_id, created_at desc) where status = 'open';

-- One row per vault and night: steps done, budget used, report (dashboard "Dream").
create table dream_runs (
  id          text primary key,
  vault_id    text not null references vaults(id) on delete cascade,
  night       date not null,
  task_id     text,
  status      text not null default 'running' check (status in ('running', 'paused', 'done', 'failed')),
  step        text,
  report      jsonb not null default '{}',
  tokens      int not null default 0,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  unique (vault_id, night)
);

grant select on claims, curator_items, dream_runs to cb_reader;
alter table claims enable row level security;
alter table curator_items enable row level security;
alter table dream_runs enable row level security;
create policy reader_claims on claims for select to cb_reader
  using (vault_id = any ((select cb_vaults())::text[]) and classification <= (select cb_clearance()));
create policy reader_curator on curator_items for select to cb_reader using (space_id = any ((select cb_vaults())::text[]));
create policy reader_dream on dream_runs for select to cb_reader using (vault_id = any ((select cb_vaults())::text[]));

-- Generated navigation of a vault (dream step 9): catalog by category and llms.txt for agents.
create table vault_indexes (
  vault_id    text not null references vaults(id) on delete cascade,
  name        text not null check (name in ('index', 'llms')),
  content     text not null,
  pages       int not null,
  updated_at  timestamptz not null default now(),
  primary key (vault_id, name)
);
grant select on vault_indexes to cb_reader;
alter table vault_indexes enable row level security;
create policy reader_vault_indexes on vault_indexes for select to cb_reader using (vault_id = any ((select cb_vaults())::text[]));

-- When the claims of a page were last taken from its text (dream step: only changed pages).
alter table pages add column claims_at timestamptz;
create index pages_claims_pending_idx on pages (vault_id) where claims_at is null;
