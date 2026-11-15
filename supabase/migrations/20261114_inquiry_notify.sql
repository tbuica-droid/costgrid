-- Quote requests and questions saved on the website are emailed to
-- support@costgrid.org by the notify-inquiry function. It records when it last
-- sent one for a row in notified_at, so a person saving twice in a row, or a
-- script calling the function in a loop, sends one email, not hundreds.
-- Run once in the Supabase SQL editor, after 20260924_profiles.sql.

alter table public.profiles add column notified_at timestamptz;

-- Signed-in people keep writing their own answers, but not notified_at: only
-- the function, which uses the service role, may set it. Column grants do
-- that; the row policies from the first migration still decide which row.
revoke insert, update on public.profiles from authenticated;
grant insert (id, email, company, spend, notes, updated_at) on public.profiles to authenticated;
grant update (id, email, company, spend, notes, updated_at) on public.profiles to authenticated;

-- Claims the right to send one email for a row, in one statement, so two
-- calls at the same moment cannot both send. It returns the row when an email
-- is due (first save, or answers changed and the last email is 10 minutes
-- old) and nothing otherwise. previous_notified_at lets the function tell a
-- first inquiry from an update, and put the old value back if sending fails.
create function public.claim_inquiry_notification(uid uuid)
returns table (
  company text,
  spend text,
  notes text,
  created_at timestamptz,
  previous_notified_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  with before as (
    select p.id, p.notified_at from public.profiles p where p.id = uid for update
  )
  update public.profiles p
     set notified_at = now()
    from before b
   where p.id = b.id
     and (b.notified_at is null
          or (p.updated_at > b.notified_at and b.notified_at < now() - interval '10 minutes'))
  returning p.company, p.spend, p.notes, p.created_at, b.notified_at;
$$;

revoke execute on function public.claim_inquiry_notification(uuid) from public, anon, authenticated;
grant execute on function public.claim_inquiry_notification(uuid) to service_role;
