-- Run once in the Supabase SQL editor before the first engine run.
-- tracker_state holds what Apps Script kept in Script Properties and CacheService: the AeroDataBox usage
-- accounting (budget enforcement), short-lived caches, Telegram delivery tracking and the run lock.
-- Row-level security is on with NO policies: only the service-role key (the engine, server side) can read
-- or write it; the anon key used by the assistant and the preview cannot.

create table if not exists public.tracker_state (
  key        text primary key,
  value      text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.tracker_state enable row level security;
