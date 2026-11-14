-- Guards against mass changes and vault checkpoints.
--
-- 1. A change that would remove or rewrite much of a vault at once (the dream cycle removing
--    hive pages, an import over an existing vault) stops and waits for a person: curator item
--    kind 'mass_change'.
-- 2. A checkpoint is a copy of the pages of a vault at one moment. Restoring it brings every
--    page back to that copy (new pages go, removed pages come back) and first saves the current
--    state as another checkpoint, so a restore can be undone. Hive pages are rebuilt by the
--    dream cycle and are not part of a checkpoint.

alter table curator_items drop constraint curator_items_kind_check;
alter table curator_items add constraint curator_items_kind_check
  check (kind in ('conflict', 'duplicate', 'lint', 'low_confidence', 'proposal', 'mass_change'));

create table vault_checkpoints (
  id          text primary key,
  vault_id    text not null references vaults(id) on delete cascade,
  name        text not null,
  -- 'manual': made by a person; 'auto': before an import, a restore, a mass change
  kind        text not null default 'manual' check (kind in ('manual', 'auto')),
  pages       int not null default 0,
  created_by  text references principals(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index vault_checkpoints_vault_idx on vault_checkpoints (vault_id, created_at desc);

-- Full copies (TOAST compresses the text): page versions are deleted with their page, and a
-- checkpoint must bring back pages removed after it.
create table vault_checkpoint_pages (
  checkpoint_id  text not null references vault_checkpoints(id) on delete cascade,
  page_id        text not null,
  path           text not null,
  version        int not null,
  hash           text not null,
  frontmatter    jsonb not null,
  body           text not null,
  primary key (checkpoint_id, page_id)
);
