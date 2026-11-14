-- Memory model (plan §3): vaults, pages, links, sources, chunks partitioned by vault, RLS.
--
-- Classification: 0 pubblico, 1 interno, 2 riservato, 3 segreto.
-- Visibility:     0 privato,  1 team,    2 azienda.
--
-- Access paths:
--   * System jobs (ingestion, dream cycle) run as the owner role: no RLS.
--   * User and MCP queries run `set local role cb_reader` and set `cb.vaults` / `cb.clearance`
--     in the same transaction. Row Level Security is then the second defense behind the
--     application filter (AGENTS.md invariant 6).

-- ---------------------------------------------------------------------------
-- Vaults: cells (person, edge, team, project) and hive spaces
-- ---------------------------------------------------------------------------
create table vaults (
  id                      text primary key,
  kind                    text not null check (kind in ('cell', 'space')),
  owner                   text,                         -- "user:<id>", "edge:<id>", "team:<id>", "project:<id>"; null for spaces
  slug                    text not null unique,
  name                    text not null,
  schema_md               text not null default '',
  default_classification  smallint not null default 1 check (default_classification between 0 and 3),
  vector_index            text not null default 'binary' check (vector_index in ('binary', 'full', 'none')),
  chunks_partition        text not null unique,
  version                 bigint not null default 0,    -- +1 on every committed change: cache key
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Pages (compiled wiki, L2/L3). The Markdown body is the readable source of truth.
-- ---------------------------------------------------------------------------
create table pages (
  id              text primary key,
  vault_id        text not null references vaults(id) on delete cascade,
  path            text not null,                        -- "entities/acme-spa.md"
  title           text not null,
  type            text not null,                        -- "entity/company", "concept", "decision", "source", ...
  tldr            text not null default '',
  body            text not null,                        -- Markdown without frontmatter
  frontmatter     jsonb not null default '{}',
  tags            text[] not null default '{}',
  visibility      smallint not null default 2 check (visibility between 0 and 2),
  classification  smallint not null default 1 check (classification between 0 and 3),
  confidence      real,
  tokens          int not null,
  hash            text not null,
  version         int not null default 1,
  importance      real not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (vault_id, path)
);
create index pages_vault_type_idx on pages (vault_id, type, updated_at desc);
create index pages_title_trgm_idx on pages using gin (title gin_trgm_ops);

create table page_versions (
  page_id      text not null references pages(id) on delete cascade,
  version      int not null,
  title        text not null,
  body         text not null,
  frontmatter  jsonb not null,
  hash         text not null,
  author       text,
  created_at   timestamptz not null default now(),
  primary key (page_id, version)
);

-- Title and aliases, normalized: resolves [[links]] in O(1).
create table aliases (
  vault_id    text not null references vaults(id) on delete cascade,
  alias_norm  text not null,
  page_id     text not null references pages(id) on delete cascade,
  is_title    boolean not null default false,
  primary key (vault_id, alias_norm, page_id)
);
create index aliases_page_idx on aliases (page_id);
create index aliases_trgm_idx on aliases using gin (alias_norm gin_trgm_ops);

-- Addressable blocks (sections and ^block ids): read and cite parts of a page.
create table blocks (
  page_id       text not null references pages(id) on delete cascade,
  block_id      text not null,
  heading_path  text[] not null default '{}',
  start_offset  int not null,
  end_offset    int not null,
  tokens        int not null,
  primary key (page_id, block_id)
);

-- Links between pages. dst_page is null while the target does not exist yet.
create table links (
  src_page     text not null references pages(id) on delete cascade,
  vault_id     text not null references vaults(id) on delete cascade,
  ord          int not null,
  target_raw   text not null,
  target_norm  text not null,
  anchor       text,                                    -- heading or ^block
  kind         text not null default 'wikilink',        -- wikilink, mention, works_at, decided_by, ...
  dst_page     text references pages(id) on delete set null,
  primary key (src_page, ord)
);
create index links_dst_idx on links (dst_page) where dst_page is not null;
create index links_unresolved_idx on links (vault_id, target_norm) where dst_page is null;

-- ---------------------------------------------------------------------------
-- Sources (L0/L1): one row per document in a vault.
-- ---------------------------------------------------------------------------
create table sources (
  id              text primary key,
  vault_id        text not null references vaults(id) on delete cascade,
  sha256          text not null,
  name            text not null,
  mime            text not null,
  size            bigint not null,
  status          text not null default 'stored',      -- stored, parsed, indexed, embedded, compiled, failed
  level           smallint not null default 0 check (level between 0 and 3),  -- I1..I3 reached
  parser_version  text,
  classification  smallint not null default 1 check (classification between 0 and 3),
  priority        smallint not null default 1,
  meta            jsonb not null default '{}',
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (vault_id, sha256)
);
create index sources_status_idx on sources (status, priority, created_at);

-- ---------------------------------------------------------------------------
-- Chunks: the search unit. Partitioned by vault (one partition per vault, created by the
-- application together with its vector index, whose dimension comes from EMBED_DIMENSIONS).
-- ---------------------------------------------------------------------------
create table chunks (
  vault_id         text not null,
  id               text not null,
  page_id          text,
  source_id        text,
  block_id         text,
  heading          text not null default '',          -- heading path joined with " › "
  ord              int not null,
  text             text not null,
  tokens           int not null,
  lang             regconfig not null default 'italian',
  hash             text not null,                     -- sha256 of the text: embedding dedup
  classification   smallint not null default 1,
  tsv              tsvector generated always as (
                     setweight(to_tsvector(lang, heading), 'A') || setweight(to_tsvector(lang, text), 'B')
                   ) stored,
  embedding        halfvec,
  embedding_model  text,
  primary key (vault_id, id),
  check ((page_id is null) <> (source_id is null))
) partition by list (vault_id);

create table chunks_default partition of chunks default;

create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_page_idx on chunks (page_id) where page_id is not null;
create index chunks_source_idx on chunks (source_id) where source_id is not null;
create index chunks_hash_idx on chunks (hash, embedding_model);
create index chunks_pending_embedding_idx on chunks (vault_id) where embedding is null;

-- ---------------------------------------------------------------------------
-- Row Level Security for the query role
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cb_reader') then
    create role cb_reader nologin;
  end if;
end $$;
grant cb_reader to current_user;
grant usage on schema public to cb_reader;
grant select on vaults, pages, page_versions, aliases, blocks, links, sources, chunks to cb_reader;
-- No privileges on the chunk partitions: cb_reader reads chunks only through the parent,
-- where the policy applies.

create function cb_vaults() returns text[] language sql stable as $$
  select coalesce(nullif(current_setting('cb.vaults', true), '')::text[], '{}'::text[])
$$;
create function cb_clearance() returns smallint language sql stable as $$
  select coalesce(nullif(current_setting('cb.clearance', true), '')::smallint, -1::smallint)
$$;

alter table vaults enable row level security;
alter table pages enable row level security;
alter table page_versions enable row level security;
alter table aliases enable row level security;
alter table blocks enable row level security;
alter table links enable row level security;
alter table sources enable row level security;
alter table chunks enable row level security;

create policy reader_vaults on vaults for select to cb_reader using (id = any (cb_vaults()));
create policy reader_pages on pages for select to cb_reader
  using (vault_id = any (cb_vaults()) and classification <= cb_clearance());
create policy reader_versions on page_versions for select to cb_reader
  using (exists (select 1 from pages p where p.id = page_id));
create policy reader_aliases on aliases for select to cb_reader
  using (vault_id = any (cb_vaults()) and exists (select 1 from pages p where p.id = page_id));
create policy reader_blocks on blocks for select to cb_reader
  using (exists (select 1 from pages p where p.id = page_id));
create policy reader_links on links for select to cb_reader
  using (vault_id = any (cb_vaults()) and exists (select 1 from pages p where p.id = src_page));
create policy reader_sources on sources for select to cb_reader
  using (vault_id = any (cb_vaults()) and classification <= cb_clearance());
create policy reader_chunks on chunks for select to cb_reader
  using (vault_id = any (cb_vaults()) and classification <= cb_clearance());

-- Cache invalidation: every version change is announced.
create function vaults_notify_version() returns trigger language plpgsql as $$
begin
  if new.version <> old.version then
    perform pg_notify('cb_vault_version', new.id || ':' || new.version);
  end if;
  return new;
end $$;
create trigger vaults_version_trg after update of version on vaults
  for each row execute function vaults_notify_version();
