-- Smart Navigation — update 4: remember the answer to "This location isn't open yet — can you get in early?"
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.
alter table public.stops add column if not exists hours_answer text not null default ''
  check (hours_answer in ('', 'early', 'wait'));   -- '' = not answered, early = we can get in, wait = wait until it opens
