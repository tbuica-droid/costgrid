-- One row per signed-in person, holding the answers the old trial form used to
-- email. Run once in the Supabase SQL editor. The site reads and writes it with
-- the publishable key, so every access goes through the policies below: a
-- person can only see and change their own row.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  company text not null check (length(company) between 2 and 200),
  spend text not null check (
    spend in (
      'Under $1k / month',
      '$1k – $10k / month',
      '$10k – $50k / month',
      '$50k – $250k / month',
      'Over $250k / month'
    )
  ),
  notes text check (length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "read own profile" on public.profiles
  for select to authenticated using (auth.uid() = id);

create policy "create own profile" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

create policy "update own profile" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- New tables are not exposed automatically (project setting), so grant the
-- signed-in role exactly what the site needs and nothing else. Anonymous
-- visitors get nothing.
grant select, insert, update on public.profiles to authenticated;
