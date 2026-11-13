-- Smart Navigation — one-time data fix: account managers
-- Paste into Supabase → SQL Editor → Run.
--
-- 1) Locations with NO account manager and NO customer service rep
--      → account manager = Anthony Bukoskie, (531) 210-7409
-- 2) Locations whose account manager is Leo Akselrud or Rob Dolrenry
--      → account manager = that location's customer service rep (phone left blank — not on file),
--        or Anthony Bukoskie, (531) 210-7409 if the location has no customer service rep
--
-- Every change is recorded in the app's "Recent location changes" log.
-- Running it a second time changes nothing (those locations no longer match).

begin;

create temporary table am_fix on commit drop as
select
  id,
  name,
  account_manager as old_manager,
  case
    when lower(trim(account_manager)) in ('leo akselrud', 'leo askelrud', 'rob dolrenry')
         and coalesce(trim(extra ->> 'customerServiceRep'), '') <> ''
      then trim(extra ->> 'customerServiceRep')
    else 'Anthony Bukoskie'
  end as new_manager,
  case
    when lower(trim(account_manager)) in ('leo akselrud', 'leo askelrud', 'rob dolrenry')
         and coalesce(trim(extra ->> 'customerServiceRep'), '') <> ''
      then ''
    else '(531) 210-7409'
  end as new_phone
from public.locations
where (coalesce(trim(account_manager), '') = '' and coalesce(trim(extra ->> 'customerServiceRep'), '') = '')
   or lower(trim(account_manager)) in ('leo akselrud', 'leo askelrud', 'rob dolrenry');

update public.locations l
set account_manager       = f.new_manager,
    account_manager_phone = f.new_phone,
    version               = l.version + 1,
    updated_at            = now(),
    updated_by_email      = 'account manager update (SQL)'
from am_fix f
where l.id = f.id;

insert into public.activity (actor_email, action, target, detail)
select 'account manager update (SQL)',
       'changed account manager at',
       id,
       name || ' — ' || coalesce(nullif(trim(old_manager), ''), '(none)') || ' → ' || new_manager
from am_fix;

-- Show what changed
select name as location,
       coalesce(nullif(trim(old_manager), ''), '(none)') as old_account_manager,
       new_manager as new_account_manager,
       new_phone   as new_phone
from am_fix
order by new_manager, name;

commit;
