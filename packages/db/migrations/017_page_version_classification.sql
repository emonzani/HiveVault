-- Page versions carry their own classification.
--
-- reader_versions let a reader see every earlier version of a page it could see now. When a
-- page was lowered (segreto -> interno, personale -> interno), its earlier text became readable
-- at the new level: by readers with a lower clearance, and by administrators for personale.
-- Now each version archived from here on keeps the classification the page had while that
-- version was current, and RLS checks it with the same rule as reader_pages.
--
-- Versions written before this migration have no recorded classification: they stay NULL and
-- follow their page as before (visible to every reader that sees the page now, also after the
-- page is lowered). Only versions archived from now on are filtered by their own level.

alter table page_versions add column classification smallint check (classification between 0 and 4);

-- New versions always have a classification. NOT VALID: the rows written before this migration
-- are not checked and stay NULL.
alter table page_versions add constraint page_versions_classification_set check (classification is not null) not valid;

-- A writer that does not set the classification (an older release after a rollback) gets the
-- classification of the page row. That release inserts the version before it updates the page,
-- so this is the level the page had while the version was current.
create function page_versions_classification() returns trigger language plpgsql as $$
begin
  if new.classification is null then
    select p.classification into new.classification from pages p where p.id = new.page_id;
  end if;
  return new;
end $$;
create trigger page_versions_classification_trg before insert on page_versions
  for each row execute function page_versions_classification();

drop policy reader_versions on page_versions;
create policy reader_versions on page_versions for select to cb_reader
  using (exists (select 1 from pages p
                 where p.id = page_id
                   and (page_versions.classification is null
                        or page_versions.classification <= (select cb_clearance())
                        or (page_versions.classification = 4 and p.vault_id = any ((select cb_personal())::text[])))));
