-- RLS policies: evaluate cb_vaults() / cb_clearance() once per query, not once per row.
--
-- A STABLE function in a policy is called for every candidate row. With a full-text match
-- of hundreds of thousands of chunks, parsing the setting into an array for each row made
-- the search over 20 vaults take 2.6 s (phase 1 benchmark, 1M chunks). Wrapped in a scalar
-- subquery the value becomes an InitPlan: computed once, then compared like a constant.

drop policy reader_vaults on vaults;
drop policy reader_pages on pages;
drop policy reader_aliases on aliases;
drop policy reader_links on links;
drop policy reader_sources on sources;
drop policy reader_chunks on chunks;

create policy reader_vaults on vaults for select to cb_reader using (id = any ((select cb_vaults())::text[]));
create policy reader_pages on pages for select to cb_reader
  using (vault_id = any ((select cb_vaults())::text[]) and classification <= (select cb_clearance()));
create policy reader_aliases on aliases for select to cb_reader
  using (vault_id = any ((select cb_vaults())::text[]) and exists (select 1 from pages p where p.id = page_id));
create policy reader_links on links for select to cb_reader
  using (vault_id = any ((select cb_vaults())::text[]) and exists (select 1 from pages p where p.id = src_page));
create policy reader_sources on sources for select to cb_reader
  using (vault_id = any ((select cb_vaults())::text[]) and classification <= (select cb_clearance()));
create policy reader_chunks on chunks for select to cb_reader
  using (vault_id = any ((select cb_vaults())::text[]) and classification <= (select cb_clearance()));
