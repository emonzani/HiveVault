-- Let the reader role use the full-text and trigram indexes under Row Level Security.
--
-- With RLS, Postgres uses a condition as an index condition only when its operator is
-- LEAKPROOF; otherwise it evaluates the condition row by row after the security filter.
-- `tsv @@ query` (ts_match_vq) and `text % text` (similarity_op) are not marked leakproof in
-- core / pg_trgm, so every search scanned all chunk partitions sequentially (phase 1
-- benchmark, 1M chunks, 20 vaults: 0.9 s instead of milliseconds).
--
-- Why this is acceptable here:
--   * Both functions compare their arguments and return a boolean; they raise no error that
--     depends on row content (input parsing happens on the query side, before any row).
--   * The reader role never runs SQL written by a user: it runs the queries of the engine.
--     RLS is the second defense against bugs of that code (AGENTS.md invariant 6), not a
--     barrier against an attacker with SQL access.
--
-- Requires a superuser (the Docker image user is one). In a managed database, run this file
-- with the administrator account.

alter function pg_catalog.ts_match_vq(tsvector, tsquery) leakproof;
alter function similarity_op(text, text) leakproof;
