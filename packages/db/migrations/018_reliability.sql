-- Reliability of the pages: review dates and the curator item "review".
--
-- A page has a date after which a person should look at it again: `review_after` (a date) or
-- `review_every` (days) in its frontmatter, else the default of its vault for its kind of page
-- (`vaults.review_days`, e.g. {"entity": 180, "decision": 365}). The nightly lint opens a curator
-- item "review" for every page past that date; confirming the page (frontmatter `verified`)
-- starts the period again.

alter table vaults add column review_days jsonb not null default '{}'
  check (jsonb_typeof(review_days) = 'object');

alter table curator_items drop constraint curator_items_kind_check;
alter table curator_items add constraint curator_items_kind_check
  check (kind in ('conflict', 'duplicate', 'lint', 'low_confidence', 'proposal', 'mass_change', 'rectification', 'review'));

-- Link sources checked again by the nightly cycle (step "refresh"): the oldest check first.
create index sources_link_refresh_idx on sources (vault_id, ((meta->>'checkedAt')))
  where origin = 'link' and parent_id is null;
