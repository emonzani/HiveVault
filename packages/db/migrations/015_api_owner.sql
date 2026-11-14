-- API keys bound to a person: a coding agent (one install) acts for one user.
-- The key reads and writes only where its user may, capped by its own scopes and clearance;
-- deleting the user deletes the key. A key without user keeps its own grants alone.

alter table principals add column user_id text references principals(id) on delete cascade;
alter table principals add constraint principals_user_id_check check (user_id is null or kind = 'api');
create index principals_user_idx on principals (user_id) where user_id is not null;
