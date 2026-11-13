-- Smart Navigation — update 2: shared locations, contacts, devices, activity log, hours bypass.
-- Paste this whole file into Supabase → SQL Editor → Run (after schema.sql). Safe to run more than once.
-- Every signed-in coworker can read and edit locations (equal access). Routes stay private.

-- ---------- Locations ----------
create table if not exists public.locations (
  id                    text primary key default ('loc_' || replace(gen_random_uuid()::text, '-', '')),
  name                  text not null,
  street                text not null default '',
  city                  text not null default '',
  state                 text not null default '',
  zip                   text not null default '',
  phone                 text not null default '',
  account_manager       text not null default '',
  account_manager_phone text not null default '',
  hours                 jsonb not null default '{}'::jsonb,   -- {"sunday":"11:30 AM - 2:00 AM", ...}
  hours_comment         text not null default '',
  open_24_7             boolean not null default false,
  access_anytime        boolean not null default false,       -- key / door code / owner lets us in
  access_method         text not null default '' check (access_method in ('', 'key', 'code', 'call')),
  games_confirmed       integer check (games_confirmed between 0 and 200),  -- null = not confirmed
  ach                   boolean,                               -- null = unknown
  payout_tickets        boolean,                               -- null = unknown
  notes                 text not null default '' check (char_length(notes) <= 250),
  lat                   double precision,
  lng                   double precision,
  extra                 jsonb not null default '{}'::jsonb,   -- account #, license, territory, source rows…
  incomplete            boolean not null default false,
  version               integer not null default 1,
  updated_at            timestamptz not null default now(),
  updated_by            uuid default auth.uid() references auth.users(id) on delete set null,
  updated_by_email      text default (auth.jwt() ->> 'email')
);
create index if not exists locations_name_idx on public.locations (lower(name));

create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  location_id text not null references public.locations(id) on delete cascade,
  position    integer not null default 0,
  name        text not null default '',
  phone       text not null default '',
  email       text not null default '',
  role        text not null default '',
  extra       jsonb not null default '{}'::jsonb
);
create index if not exists contacts_loc_idx on public.contacts (location_id, position);

create table if not exists public.devices (
  id          uuid primary key default gen_random_uuid(),
  location_id text not null references public.locations(id) on delete cascade,
  position    integer not null default 0,
  category    text not null default 'Skill Game',
  type        text not null default '',
  extra       jsonb not null default '{}'::jsonb   -- asset #, serial, license, make, source row…
);
create index if not exists devices_loc_idx on public.devices (location_id, position);

create table if not exists public.activity (
  id          bigserial primary key,
  actor       uuid default auth.uid(),
  actor_email text default (auth.jwt() ->> 'email'),
  action      text not null,
  target      text not null default '',
  detail      text not null default '',
  at          timestamptz not null default now()
);
create index if not exists activity_at_idx on public.activity (at desc);

-- ---------- Stops can point at a saved location ----------
alter table public.stops add column if not exists location_id text references public.locations(id) on delete set null;
alter table public.stops add column if not exists rt_tasks jsonb not null default '[]'::jsonb;  -- ["Fill","None",...] per terminal
alter table public.stops add column if not exists ignore_hours boolean not null default false;  -- one-day hours bypass

-- ---------- Security: signed-in staff only ----------
alter table public.locations enable row level security;
alter table public.contacts  enable row level security;
alter table public.devices   enable row level security;
alter table public.activity  enable row level security;

drop policy if exists staff_locations on public.locations;
create policy staff_locations on public.locations for all to authenticated using (true) with check (true);
drop policy if exists staff_contacts on public.contacts;
create policy staff_contacts on public.contacts for all to authenticated using (true) with check (true);
drop policy if exists staff_devices on public.devices;
create policy staff_devices on public.devices for all to authenticated using (true) with check (true);

drop policy if exists read_activity on public.activity;
create policy read_activity on public.activity for select to authenticated using (true);
drop policy if exists write_activity on public.activity;
create policy write_activity on public.activity for insert to authenticated with check (actor = auth.uid());
-- (no update/delete policy: the log can't be edited from the app)

revoke all on public.locations, public.contacts, public.devices, public.activity from anon;

-- ---------- Save a location + its contacts + devices in one step ----------
-- Refuses if someone else saved it since you opened it (version check), so edits never overwrite each other.
create or replace function public.save_location(p_loc jsonb, p_contacts jsonb, p_devices jsonb, p_expected integer)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id      text := nullif(p_loc ->> 'id', '');
  v_version integer;
  v_has_rt  boolean;
  v_payout  boolean := (p_loc ->> 'payout_tickets')::boolean;
  v_action  text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if coalesce(trim(p_loc ->> 'name'), '') = '' then raise exception 'Location name is required'; end if;

  select exists (select 1 from jsonb_array_elements(coalesce(p_devices, '[]'::jsonb)) d
                 where lower(d ->> 'category') like '%redemption%') into v_has_rt;
  if v_has_rt then v_payout := false; end if;   -- payout tickets are not allowed with an RT

  if v_id is null then
    insert into locations (name, street, city, state, zip, phone, account_manager, account_manager_phone,
                           hours, hours_comment, open_24_7, access_anytime, access_method,
                           games_confirmed, ach, payout_tickets, notes, lat, lng, extra, incomplete)
    values (trim(p_loc ->> 'name'), coalesce(p_loc ->> 'street', ''), coalesce(p_loc ->> 'city', ''),
            coalesce(p_loc ->> 'state', ''), coalesce(p_loc ->> 'zip', ''), coalesce(p_loc ->> 'phone', ''),
            coalesce(p_loc ->> 'account_manager', ''), coalesce(p_loc ->> 'account_manager_phone', ''),
            coalesce(p_loc -> 'hours', '{}'::jsonb), coalesce(p_loc ->> 'hours_comment', ''),
            coalesce((p_loc ->> 'open_24_7')::boolean, false), coalesce((p_loc ->> 'access_anytime')::boolean, false),
            coalesce(p_loc ->> 'access_method', ''),
            (p_loc ->> 'games_confirmed')::integer, (p_loc ->> 'ach')::boolean, v_payout,
            left(coalesce(p_loc ->> 'notes', ''), 250),
            (p_loc ->> 'lat')::double precision, (p_loc ->> 'lng')::double precision,
            coalesce(p_loc -> 'extra', '{}'::jsonb), false)
    returning id, version into v_id, v_version;
    v_action := 'created location';
  else
    update locations set
      name = trim(p_loc ->> 'name'),
      street = coalesce(p_loc ->> 'street', ''), city = coalesce(p_loc ->> 'city', ''),
      state = coalesce(p_loc ->> 'state', ''), zip = coalesce(p_loc ->> 'zip', ''),
      phone = coalesce(p_loc ->> 'phone', ''),
      account_manager = coalesce(p_loc ->> 'account_manager', ''),
      account_manager_phone = coalesce(p_loc ->> 'account_manager_phone', ''),
      hours = coalesce(p_loc -> 'hours', '{}'::jsonb), hours_comment = coalesce(p_loc ->> 'hours_comment', ''),
      open_24_7 = coalesce((p_loc ->> 'open_24_7')::boolean, false),
      access_anytime = coalesce((p_loc ->> 'access_anytime')::boolean, false),
      access_method = coalesce(p_loc ->> 'access_method', ''),
      games_confirmed = (p_loc ->> 'games_confirmed')::integer,
      ach = (p_loc ->> 'ach')::boolean,
      payout_tickets = v_payout,
      notes = left(coalesce(p_loc ->> 'notes', ''), 250),
      lat = (p_loc ->> 'lat')::double precision, lng = (p_loc ->> 'lng')::double precision,
      extra = coalesce(p_loc -> 'extra', extra),
      version = version + 1, updated_at = now(),
      updated_by = auth.uid(), updated_by_email = auth.jwt() ->> 'email'
    where id = v_id and version = p_expected
    returning version into v_version;
    if v_version is null then
      raise exception 'CONFLICT: someone else changed this location. Reload it and make your change again.';
    end if;
    v_action := 'edited location';
  end if;

  delete from contacts where location_id = v_id;
  insert into contacts (location_id, position, name, phone, email, role, extra)
  select v_id, ord::integer, coalesce(c ->> 'name', ''), coalesce(c ->> 'phone', ''), coalesce(c ->> 'email', ''),
         coalesce(c ->> 'role', ''), coalesce(c -> 'extra', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_contacts, '[]'::jsonb)) with ordinality as t(c, ord)
  where coalesce(trim(c ->> 'name'), '') <> '' or coalesce(trim(c ->> 'phone'), '') <> '';

  delete from devices where location_id = v_id;
  insert into devices (location_id, position, category, type, extra)
  select v_id, ord::integer, coalesce(nullif(d ->> 'category', ''), 'Skill Game'), coalesce(d ->> 'type', ''),
         coalesce(d -> 'extra', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_devices, '[]'::jsonb)) with ordinality as t(d, ord);

  insert into activity (action, target, detail) values (v_action, v_id, trim(p_loc ->> 'name'));
  return jsonb_build_object('id', v_id, 'version', v_version);
end $$;

grant execute on function public.save_location(jsonb, jsonb, jsonb, integer) to authenticated;
revoke execute on function public.save_location(jsonb, jsonb, jsonb, integer) from anon;
