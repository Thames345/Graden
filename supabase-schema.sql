-- ===================================================================
-- สวนอัจฉริยะ (Garden App) — Supabase schema
-- รันไฟล์นี้ครั้งเดียวใน Supabase → SQL Editor → New query → Run
--
-- หมายเหตุการออกแบบ:
--  * primary key เป็น text เพราะแอปสร้าง id เองตั้งแต่ตอนออฟไลน์
--    (แถวถูกสร้างบนมือถือก่อน แล้วค่อยซิงก์ขึ้นทีหลัง)
--  * ทุกตารางมี updated_at + deleted เพื่อให้ซิงก์แบบ last-write-wins
--    และลบข้ามเครื่องได้ (soft delete / tombstone)
--  * updated_at ตั้งค่าจากฝั่งแอป ไม่ใช้ trigger ทับ เพื่อให้ watermark
--    ของการซิงก์ตรงกับค่าที่ไคลเอนต์ส่งมา
-- ===================================================================

create extension if not exists pgcrypto;

-- ---------- ผู้ใช้ ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  name        text default '',
  role        text default '',
  updated_at  timestamptz not null default now()
);

-- ---------- สวน ----------
create table if not exists public.gardens (
  id              text primary key,
  owner_id        uuid not null references auth.users on delete cascade,
  name            text default '',
  lat             double precision,
  lng             double precision,
  area            text,
  area_unit       text,
  start_year      text,
  harvest_seasons jsonb default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  deleted         boolean not null default false
);
create index if not exists gardens_owner_idx on public.gardens(owner_id);

-- ---------- สมาชิกของสวน (แชร์สวนให้คนอื่นใช้ร่วมได้) ----------
create table if not exists public.garden_members (
  garden_id  text not null references public.gardens on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  role       text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (garden_id, user_id)
);
create index if not exists garden_members_user_idx on public.garden_members(user_id);

-- ---------- ตารางข้อมูลของสวน ----------
create table if not exists public.plots (
  id             text primary key,
  garden_id      text not null references public.gardens on delete cascade,
  name           text default '',
  fruit_type     text default '',
  variety        text default '',
  tree_count     integer default 0,
  planting_year  text default '',
  notes          text default '',
  updated_at     timestamptz not null default now(),
  deleted        boolean not null default false
);

create table if not exists public.products (
  id         text primary key,
  garden_id  text not null references public.gardens on delete cascade,
  name       text default '',
  type       text default '',
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);

create table if not exists public.buyers (
  id         text primary key,
  garden_id  text not null references public.gardens on delete cascade,
  name       text default '',
  phone      text default '',
  note       text default '',
  updated_at timestamptz not null default now(),
  deleted    boolean not null default false
);

-- items = [{name, qty, unitCost}, ...] เพราะหนึ่งรอบใช้ปุ๋ย/ยาหลายตัว
create table if not exists public.care_events (
  id           text primary key,
  garden_id    text not null references public.gardens on delete cascade,
  plot_id      text,
  date         date,
  type         text default 'spray',
  items        jsonb default '[]'::jsonb,
  other_cost   numeric default 0,
  total_cost   numeric default 0,
  product_name text default '',
  qty_bottles  numeric default 0,
  unit_cost    numeric default 0,
  note         text default '',
  updated_at   timestamptz not null default now(),
  deleted      boolean not null default false
);
create index if not exists care_events_garden_date_idx on public.care_events(garden_id, date);

create table if not exists public.health_issues (
  id                        text primary key,
  garden_id                 text not null references public.gardens on delete cascade,
  plot_id                   text,
  date                      date,
  issue_type                text default '',
  description               text default '',
  affected_tree_count_est   integer default 0,
  severity                  text default 'watch',
  status                    text default 'open',
  resolved_date             date,
  updated_at                timestamptz not null default now(),
  deleted                   boolean not null default false
);
create index if not exists health_issues_garden_idx on public.health_issues(garden_id, status);

create table if not exists public.harvests (
  id            text primary key,
  garden_id     text not null references public.gardens on delete cascade,
  plot_id       text,
  date          date,
  fruit_type    text default '',
  weight_kg     numeric default 0,
  count         integer default 0,
  price_per_kg  numeric default 0,
  buyer_id      text,
  labor_cost    numeric default 0,
  fuel_cost     numeric default 0,
  note          text default '',
  updated_at    timestamptz not null default now(),
  deleted       boolean not null default false
);
create index if not exists harvests_garden_date_idx on public.harvests(garden_id, date);

create table if not exists public.tasks (
  id               text primary key,
  garden_id        text not null references public.gardens on delete cascade,
  plot_id          text,
  title            text default '',
  type             text default 'other',
  due_date         date,
  recurrence_days  integer,
  done             boolean default false,
  done_date        date,
  updated_at       timestamptz not null default now(),
  deleted          boolean not null default false
);
create index if not exists tasks_garden_due_idx on public.tasks(garden_id, done, due_date);

-- ===================================================================
-- Row Level Security
-- ใช้ security definer function กันไม่ให้ policy เรียกวนกันเอง
-- ===================================================================

create or replace function public.is_garden_owner(g text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.gardens x
    where x.id = g and x.owner_id = auth.uid()
  );
$$;

create or replace function public.is_garden_member(g text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.garden_members m
    where m.garden_id = g and m.user_id = auth.uid()
  );
$$;

create or replace function public.can_access_garden(g text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select public.is_garden_owner(g) or public.is_garden_member(g);
$$;

-- เจ้าของสวนถูกเพิ่มเป็นสมาชิกอัตโนมัติตอนสร้างสวน
create or replace function public.add_owner_as_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.garden_members (garden_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists gardens_add_owner_member on public.gardens;
create trigger gardens_add_owner_member
  after insert on public.gardens
  for each row execute function public.add_owner_as_member();

alter table public.profiles       enable row level security;
alter table public.gardens        enable row level security;
alter table public.garden_members enable row level security;
alter table public.plots          enable row level security;
alter table public.products       enable row level security;
alter table public.buyers         enable row level security;
alter table public.care_events    enable row level security;
alter table public.health_issues  enable row level security;
alter table public.harvests       enable row level security;
alter table public.tasks          enable row level security;

-- profiles: แก้ไขได้เฉพาะของตัวเอง
drop policy if exists profiles_rw on public.profiles;
create policy profiles_rw on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- gardens
drop policy if exists gardens_select on public.gardens;
create policy gardens_select on public.gardens
  for select using (owner_id = auth.uid() or public.is_garden_member(id));

drop policy if exists gardens_insert on public.gardens;
create policy gardens_insert on public.gardens
  for insert with check (owner_id = auth.uid());

drop policy if exists gardens_update on public.gardens;
create policy gardens_update on public.gardens
  for update using (owner_id = auth.uid() or public.is_garden_member(id))
  with check (owner_id = auth.uid() or public.is_garden_member(id));

drop policy if exists gardens_delete on public.gardens;
create policy gardens_delete on public.gardens
  for delete using (owner_id = auth.uid());

-- garden_members: เห็นของตัวเอง / เจ้าของสวนจัดการได้
drop policy if exists members_select on public.garden_members;
create policy members_select on public.garden_members
  for select using (user_id = auth.uid() or public.is_garden_owner(garden_id));

drop policy if exists members_insert on public.garden_members;
create policy members_insert on public.garden_members
  for insert with check (public.is_garden_owner(garden_id));

drop policy if exists members_delete on public.garden_members;
create policy members_delete on public.garden_members
  for delete using (public.is_garden_owner(garden_id));

-- ตารางข้อมูล: เข้าถึงได้ถ้าเป็นเจ้าของหรือสมาชิกของสวนนั้น
do $$
declare t text;
begin
  foreach t in array array['plots','products','buyers','care_events','health_issues','harvests','tasks']
  loop
    execute format('drop policy if exists %I_all on public.%I', t, t);
    execute format(
      'create policy %I_all on public.%I for all
         using (public.can_access_garden(garden_id))
         with check (public.can_access_garden(garden_id))', t, t);
  end loop;
end $$;
