-- Smart Navigation — update 3: ▶ Start route and ✔ Complete route.
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once (run it again if you ran an earlier copy).
alter table public.routes add column if not exists started_at timestamptz;    -- when the route was actually started
alter table public.routes add column if not exists completed_at timestamptz;  -- set when completed and saved
