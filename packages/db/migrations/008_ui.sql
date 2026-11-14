-- Phase 4: user interface.

-- Notice about the cloud agent (plan §3.6, D1): the user confirms it once; the audit log keeps the event.
alter table principals add column notice_ack_at timestamptz;

-- Folder listing of the sidebar: pages of one type folder in title order, keyset pagination.
-- The query must use the same expressions (folder = split_part(type, '/', 1), lower(title)).
create index pages_vault_folder_title_idx on pages (vault_id, (split_part(type, '/', 1)), lower(title), id);

-- Inbound degree for the global graph and the backlinks panel.
create index links_vault_dst_idx on links (vault_id, dst_page) where dst_page is not null;
