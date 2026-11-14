-- Phase 7: metrics for the dashboards (plan §8.4) and settings changed from the console.

-- One row per metric name and label set.
create table metric_series (
  id      bigint generated always as identity primary key,
  name    text not null,
  labels  jsonb not null default '{}',
  kind    text not null check (kind in ('counter', 'gauge', 'histogram')),
  key     text not null unique                       -- name{label=value,...}, labels sorted
);
create index metric_series_name_idx on metric_series (name);

-- Samples per minute: sum, count, min, max and last value; histograms keep their buckets.
-- Partitioned by day (created ahead and dropped beyond the retention by the collector).
create table metrics_1m (
  bucket     timestamptz not null,
  series_id  bigint not null,
  sum        double precision not null,
  count      bigint not null,
  min        double precision not null,
  max        double precision not null,
  last       double precision not null,
  buckets    jsonb,
  primary key (series_id, bucket)
) partition by range (bucket);

-- Rollups: same columns, one row per hour and per day.
create table metrics_1h (like metrics_1m including defaults, primary key (series_id, bucket));
create table metrics_1d (like metrics_1m including defaults, primary key (series_id, bucket));
create index metrics_1h_bucket_brin on metrics_1h using brin (bucket);
create index metrics_1d_bucket_brin on metrics_1d using brin (bucket);

-- Settings changed from the console (they override the environment): dream window and
-- budget, cloud agent notice text, default classification, model endpoints and processes.
create table settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text references principals(id) on delete set null
);
