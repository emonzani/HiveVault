-- Privacy (GDPR review, docs/sicurezza/privacy.md).
--
-- 1. Classification 4 "personale": content of one person. Only the owner of the personal vault
--    ("user:<id>") reads it. Administrators, grantees, teams and API accounts never do: it is
--    outside the clearance ladder (clearance stays 0–3), RLS lets it through only for the vaults
--    listed in `cb.personal`, which the application fills with the reader's own personal vaults.
-- 2. Teams: principals of kind 'team'. Users are members of any number of teams. A team gets
--    grants like a user; its members get them too, and write access to the vaults it owns
--    ("team:<id>"). A deleted user's vault goes to a team without its personal content.
-- 3. Personal vaults start "personale": what a person keeps in their own vault is theirs unless
--    they choose a lower level (privacy by default; never read by administrators or the cloud agent).
-- 4. Audit log: append-only (no UPDATE, no TRUNCATE, no DELETE of security events younger
--    than 6 months) and a hash chain over the security events, so a change is detectable
--    (Garante, provvedimento 27/11/2008 on system administrators). Read events (page.read,
--    search, ...) stay out of the chain: they have their own short retention (labour law).
-- 5. vault_log rows carry the classification of what they name: a reader only sees titles it
--    may see.
-- 6. Curator item 'rectification': an administrator corrected a generated page; its sources
--    must be corrected too, or the next night rebuilds the old text.

-- ---------------------------------------------------------------------------
-- 1. Classification 4 "personale"
-- ---------------------------------------------------------------------------
alter table pages drop constraint pages_classification_check;
alter table pages add constraint pages_classification_check check (classification between 0 and 4);
alter table sources drop constraint sources_classification_check;
alter table sources add constraint sources_classification_check check (classification between 0 and 4);
alter table vaults drop constraint vaults_default_classification_check;
alter table vaults add constraint vaults_default_classification_check check (default_classification between 0 and 4);
alter table import_jobs drop constraint import_jobs_classification_check;
alter table import_jobs add constraint import_jobs_classification_check check (classification between 0 and 4);

create function cb_personal() returns text[] language sql stable as $$
  select coalesce(nullif(current_setting('cb.personal', true), '')::text[], '{}'::text[])
$$;

drop policy reader_pages on pages;
drop policy reader_sources on sources;
drop policy reader_chunks on chunks;
create policy reader_pages on pages for select to cb_reader
  using (vault_id = any ((select cb_vaults())::text[])
         and (classification <= (select cb_clearance()) or (classification = 4 and vault_id = any ((select cb_personal())::text[]))));
create policy reader_sources on sources for select to cb_reader
  using (vault_id = any ((select cb_vaults())::text[])
         and (classification <= (select cb_clearance()) or (classification = 4 and vault_id = any ((select cb_personal())::text[]))));
create policy reader_chunks on chunks for select to cb_reader
  using (vault_id = any ((select cb_vaults())::text[])
         and (classification <= (select cb_clearance()) or (classification = 4 and vault_id = any ((select cb_personal())::text[]))));

-- ---------------------------------------------------------------------------
-- 2. Teams
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'principals'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '(kind|role)'
  loop
    execute format('alter table principals drop constraint %I', c.conname);
  end loop;
end $$;
alter table principals add constraint principals_kind_check check (kind in ('user', 'api', 'team'));
alter table principals add constraint principals_role_check check (
  (kind = 'user' and role in ('admin', 'curator', 'member')) or (kind = 'api' and role = 'api') or (kind = 'team' and role = 'team'));

create table team_members (
  team_id    text not null references principals(id) on delete cascade,
  member_id  text not null references principals(id) on delete cascade,
  added_by   text references principals(id) on delete set null,
  added_at   timestamptz not null default now(),
  primary key (team_id, member_id)
);
create index team_members_member_idx on team_members (member_id);

-- ---------------------------------------------------------------------------
-- 3. Personal vaults start "personale" (new content only: existing pages keep their level)
-- ---------------------------------------------------------------------------
update vaults set default_classification = 4 where owner like 'user:%';

-- ---------------------------------------------------------------------------
-- 4. Audit log: append-only, hash chain over security events
-- ---------------------------------------------------------------------------
-- Read events: frequent, about what people read; short retention, outside the chain.
create function cb_audit_is_read(action text) returns boolean language sql immutable as $$
  select action in ('page.read', 'source.read', 'source.download', 'search', 'project.doc.read',
                    'mcp.overview', 'mcp.neighbors', 'mcp.timeline', 'mcp.resource')
$$;

alter table audit_log add column seq bigint unique, add column prev_hash bytea, add column hash bytea;

create table audit_chain_head (
  one   boolean primary key default true check (one),
  seq   bigint not null,
  hash  bytea
);
insert into audit_chain_head (seq, hash) values (0, null);

-- The hash of a row: the previous hash and every field, in a text form that does not depend
-- on the session (time as microseconds since the epoch, jsonb in its canonical text).
create function cb_audit_row_hash(prev bytea, seq bigint, at timestamptz, principal_id text, action text, resource text,
                                  outcome text, ip inet, user_agent text, data jsonb) returns bytea
language sql immutable as $$
  select sha256(coalesce(prev, '\x'::bytea) || convert_to(concat_ws(chr(31),
    seq::text, (extract(epoch from at) * 1000000)::bigint::text, coalesce(principal_id, ''), action, coalesce(resource, ''),
    outcome, coalesce(host(ip), ''), coalesce(user_agent, ''), coalesce(data::text, '')), 'UTF8'))
$$;

-- the security events written before this migration start the chain, in id order
do $$
declare r record; prev bytea := null; h bytea; n bigint := 0;
begin
  for r in select * from audit_log where not cb_audit_is_read(action) order by id loop
    n := n + 1;
    h := cb_audit_row_hash(prev, n, r.at, r.principal_id, r.action, r.resource, r.outcome, r.ip, r.user_agent, r.data);
    update audit_log set seq = n, prev_hash = prev, hash = h where id = r.id;
    prev := h;
  end loop;
  update audit_chain_head set seq = n, hash = prev where one;
end $$;

create function audit_log_chain() returns trigger language plpgsql as $$
declare h audit_chain_head;
begin
  if cb_audit_is_read(new.action) then
    new.seq := null; new.prev_hash := null; new.hash := null;
    return new;
  end if;
  -- the row lock orders concurrent writers: the chain follows the commit order of the head
  select * into h from audit_chain_head where one for update;
  new.seq := h.seq + 1;
  new.prev_hash := h.hash;
  new.hash := cb_audit_row_hash(h.hash, new.seq, new.at, new.principal_id, new.action, new.resource, new.outcome, new.ip, new.user_agent, new.data);
  update audit_chain_head set seq = new.seq, hash = new.hash where one;
  return new;
end $$;
create trigger audit_log_chain_trg before insert on audit_log for each row execute function audit_log_chain();

create function audit_log_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'audit_log is append-only: rows cannot be changed' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'TRUNCATE' then
    raise exception 'audit_log is append-only: it cannot be truncated' using errcode = 'insufficient_privilege';
  end if;
  -- DELETE: read events at any time (their retention is short), security events after 6 months
  if old.seq is not null and old.at > now() - interval '183 days' then
    raise exception 'audit_log: security events are kept at least 6 months' using errcode = 'insufficient_privilege';
  end if;
  return old;
end $$;
create trigger audit_log_no_update before update on audit_log for each row execute function audit_log_guard();
create trigger audit_log_no_delete before delete on audit_log for each row execute function audit_log_guard();
create trigger audit_log_no_truncate before truncate on audit_log for each statement execute function audit_log_guard();

-- ---------------------------------------------------------------------------
-- 5. vault_log: classification of what a row names
-- ---------------------------------------------------------------------------
alter table vault_log add column classification smallint not null default 0;
drop policy reader_vault_log on vault_log;
create policy reader_vault_log on vault_log for select to cb_reader
  using (vault_id = any ((select cb_vaults())::text[])
         and (classification <= (select cb_clearance()) or (classification = 4 and vault_id = any ((select cb_personal())::text[]))));

-- ---------------------------------------------------------------------------
-- 6. Curator item: rectification of a generated page
-- ---------------------------------------------------------------------------
alter table curator_items drop constraint curator_items_kind_check;
alter table curator_items add constraint curator_items_kind_check
  check (kind in ('conflict', 'duplicate', 'lint', 'low_confidence', 'proposal', 'mass_change', 'rectification'));
