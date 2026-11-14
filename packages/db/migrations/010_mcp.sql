-- Phase 6: edits proposed by the cloud agent (brain_propose_edit) wait in the curator queue until a
-- person approves them.
alter table curator_items drop constraint curator_items_kind_check;
alter table curator_items add constraint curator_items_kind_check
  check (kind in ('conflict', 'duplicate', 'lint', 'low_confidence', 'proposal'));
