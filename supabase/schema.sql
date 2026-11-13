-- Smart Navigation database. Paste this whole file into Supabase → SQL Editor → Run.
-- Safe to run more than once.
-- Every route and stop belongs to one person; nobody (not even the owner) can read another person's routes from the app.

create extension if not exists pgcrypto;

create table if not exists public.routes (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name            text not null default 'New route',
  route_date      date not null default current_date,
  collectors      integer not null default 1 check (collectors between 1 and 3),
  start_mode      text not null default 'gps' check (start_mode in ('gps','address')),
  start_label     text,
  start_lat       double precision,
  start_lng       double precision,
  end_mode        text not null default 'none' check (end_mode in ('none','start','address')),
  end_label       text,
  end_lat         double precision,
  end_lng         double precision,
  start_time      time,                 -- planned departure (blank = now)
  geometry        jsonb,                -- route line [[lat,lng],...]
  legs            jsonb,                -- drive seconds/meters per leg
  total_distance  double precision,     -- meters
  total_drive     double precision,     -- seconds
  optimized_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.stops (
  id                 uuid primary key default gen_random_uuid(),
  route_id           uuid not null references public.routes(id) on delete cascade,
  owner_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  position           integer not null default 0,
  name               text not null default '',
  address            text not null,
  lat                double precision,
  lng                double precision,
  phone              text not null default '',
  notes              text not null default '',
  status             text not null default 'pending' check (status in ('pending','done','failed','skipped')),
  status_note        text not null default '',
  completed_at       timestamptz,
  -- Collector / service-time details
  games              integer not null default 0 check (games between 0 and 200),
  has_rt             boolean not null default false,
  rt_task            text not null default 'No Fill' check (rt_task in ('No Fill','Fill','Swap')),
  ach                boolean,
  payout_tickets     boolean,
  service_override   integer check (service_override between 0 and 1440),
  created_at         timestamptz not null default now(),
  constraint no_payout_with_rt check (not (has_rt and coalesce(payout_tickets,false)))
);

create index if not exists routes_owner_idx on public.routes(owner_id, route_date desc);
create index if not exists stops_route_idx  on public.stops(route_id, position);

-- keep updated_at fresh
create or replace function public.touch_route() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists routes_touch on public.routes;
create trigger routes_touch before update on public.routes for each row execute function public.touch_route();

-- Row Level Security: each person only ever sees their own routes and stops.
alter table public.routes enable row level security;
alter table public.stops  enable row level security;

drop policy if exists own_routes on public.routes;
create policy own_routes on public.routes for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists own_stops on public.stops;
create policy own_stops on public.stops for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid()
              and exists (select 1 from public.routes r where r.id = route_id and r.owner_id = auth.uid()));

-- No access at all for signed-out visitors.
revoke all on public.routes, public.stops from anon;
