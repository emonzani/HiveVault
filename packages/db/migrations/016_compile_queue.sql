-- The compilation queue (M3, M14) without a scan of every source. On 1.1 million sources the
-- queue estimate took 1.7 s and the backlog pick of the idle-compile task 1.2 s every minute.

-- backlog: sources never asked to compile, in the order the idle-compile task takes them
create index sources_backlog_idx on sources (demand desc, priority, created_at, id)
  where not compile and level between 1 and 2 and status not in ('failed', 'unsupported');

-- sources asked to compile and not compiled yet (their task says if they wait)
create index sources_to_compile_idx on sources (task_id)
  where compile and level < 3 and status not in ('failed', 'unsupported');

-- the last model compiles, for the mean time of a compile
create index sources_compile_ms_idx on sources (updated_at desc) where meta ? 'compileMs';
