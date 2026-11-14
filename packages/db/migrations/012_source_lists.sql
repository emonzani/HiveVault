-- Phase 8 profiling: the Inbox and "Da rivedere" lists read the newest rows of `sources` over
-- all readable vaults. With many vaults (an administrator, an API account) Postgres scanned the
-- whole table in parallel (1.1M rows: 95 ms and 77 ms), and the time grew with the documents.
-- Partial indexes in the order of each list: the scan stops at the requested rows.
--
-- The migration runs in a transaction, so the indexes are built without CONCURRENTLY: on a table
-- of tens of millions of rows the build blocks writes to `sources` for its duration. On such an
-- installation, create the two indexes by hand with CONCURRENTLY first (same names), then migrate.

-- Inbox: uploaded documents (not the files inside an archive or a mail), newest first
create index if not exists sources_inbox_idx on sources (created_at desc) where parent_id is null;

-- "Da rivedere": documents that failed, are not supported, or have reading warnings
create index if not exists sources_review_idx on sources (updated_at desc)
  where status in ('failed', 'unsupported') or meta->'warnings' ?| array['needs_ocr', 'ocr_unavailable', 'little_text'];
