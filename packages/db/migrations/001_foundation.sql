-- Foundation: extensions and the durable task engine.

create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists pg_stat_statements;

-- ---------------------------------------------------------------------------
-- Tasks: a durable state machine. One row per task; the checkpoint is the state
-- saved at the end of every phase. A worker owns a task while its lease is valid.
-- ---------------------------------------------------------------------------
create table tasks (
  id            text primary key,
  name          text not null,                 -- task definition name, e.g. "ingest"
  version       int  not null default 1,       -- definition version that created the task
  request_id    text unique,                   -- idempotency key: same request -> same task
  parent_id     text references tasks(id) on delete cascade,
  status        text not null default 'queued'
                check (status in ('queued','running','sleeping','waiting','done','failed','cancelled')),
  phase         text not null,                 -- next phase to run
  input         jsonb not null default '{}',
  state         jsonb not null default '{}',   -- checkpoint, written atomically with the phase change
  result        jsonb,
  error         text,
  priority      int  not null default 1,       -- 0 = interactive, 1 = ingestion, 2 = background
  attempts      int  not null default 0,
  max_attempts  int  not null default 5,
  run_after     timestamptz not null default now(),
  lease_owner   text,
  lease_until   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  finished_at   timestamptz
);

-- Claim query: runnable tasks by priority then age. Partial index keeps it small at any table size.
create index tasks_runnable_idx on tasks (priority, run_after, id)
  where status in ('queued', 'sleeping');
create index tasks_lease_idx on tasks (lease_until) where status = 'running';
create index tasks_parent_idx on tasks (parent_id) where parent_id is not null;

-- ---------------------------------------------------------------------------
-- Effects journal: the intent of a side effect is stored before it runs, and its
-- result after. On resume, a finished effect returns its stored result; an effect
-- with intent and no result reruns only when it is replay-safe.
-- ---------------------------------------------------------------------------
create table task_effects (
  task_id      text not null references tasks(id) on delete cascade,
  key          text not null,                  -- stable key inside the task, e.g. "write:page:ent_x"
  replay_safe  boolean not null,
  status       text not null check (status in ('intent','done','failed')),
  result       jsonb,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  primary key (task_id, key)
);

-- Append-only event log for the trajectory view and the dashboards.
create table task_events (
  id         bigint generated always as identity primary key,
  task_id    text not null references tasks(id) on delete cascade,
  at         timestamptz not null default now(),
  kind       text not null,                    -- created, claimed, phase_done, sleep, retry, done, failed, ...
  phase      text,
  data       jsonb
);
create index task_events_task_idx on task_events (task_id, id);

-- Wake workers immediately when a task becomes runnable now.
create function tasks_notify() returns trigger language plpgsql as $$
begin
  if new.status = 'queued' and new.run_after <= now() then
    perform pg_notify('cb_tasks', new.priority::text);
  end if;
  return new;
end $$;

create trigger tasks_notify_trg after insert or update of status, run_after on tasks
  for each row execute function tasks_notify();
