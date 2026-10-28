-- =====================================================================
--  INVESTPRO (DEMO / SIMULATION) - SUPABASE SETUP
--  Run this whole file once in:  Supabase > SQL Editor > New query > Run
--  All money in this system is VIRTUAL. No real payments are handled.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) TABLES
-- ---------------------------------------------------------------------

create table if not exists public.profiles (
    id            uuid primary key references auth.users(id) on delete cascade,
    email         text not null,
    first_name    text,
    last_name     text,
    phone         text,
    referral_code text not null unique,
    referred_by   uuid references public.profiles(id),
    role          text not null default 'user' check (role in ('user', 'admin')),
    created_at    timestamptz not null default now()
);

create table if not exists public.plans (
    id            text primary key,
    name          text not null,
    min_amount    numeric(14,2) not null check (min_amount > 0),
    max_amount    numeric(14,2) not null,
    duration_days int not null check (duration_days > 0),
    daily_rate    numeric(6,3) not null check (daily_rate >= 0),     -- % per day
    referral_rate numeric(6,3) not null default 0 check (referral_rate >= 0),  -- % commission
    featured      boolean not null default false,
    active        boolean not null default true,
    sort_order    int not null default 0,
    check (max_amount >= min_amount)
);

create table if not exists public.settings (
    id               int primary key default 1 check (id = 1),
    min_withdraw     numeric(14,2) not null default 5,
    return_principal boolean not null default true
);

create table if not exists public.deposits (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references public.profiles(id) on delete cascade,
    plan_id     text not null references public.plans(id),
    amount      numeric(14,2) not null check (amount > 0),
    note        text,
    status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    created_at  timestamptz not null default now(),
    reviewed_at timestamptz,
    reviewed_by uuid references public.profiles(id)
);

create table if not exists public.investments (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references public.profiles(id) on delete cascade,
    deposit_id    uuid not null unique references public.deposits(id) on delete cascade,
    plan_id       text not null references public.plans(id),
    amount        numeric(14,2) not null,
    daily_rate    numeric(6,3) not null,      -- copied from the plan when approved
    duration_days int not null,
    start_date    date not null default current_date,
    status        text not null default 'running' check (status in ('running', 'completed')),
    created_at    timestamptz not null default now()
);

create table if not exists public.profit_logs (
    id            bigint generated always as identity primary key,
    investment_id uuid not null references public.investments(id) on delete cascade,
    user_id       uuid not null references public.profiles(id) on delete cascade,
    day_number    int not null,
    profit_date   date not null,
    amount        numeric(14,2) not null,
    unique (investment_id, day_number)
);

create table if not exists public.referral_earnings (
    id          uuid primary key default gen_random_uuid(),
    referrer_id uuid not null references public.profiles(id) on delete cascade,
    referred_id uuid not null references public.profiles(id) on delete cascade,
    deposit_id  uuid not null unique references public.deposits(id) on delete cascade,
    rate        numeric(6,3) not null,
    amount      numeric(14,2) not null,
    created_at  timestamptz not null default now()
);

create table if not exists public.withdrawals (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references public.profiles(id) on delete cascade,
    amount      numeric(14,2) not null check (amount > 0),
    note        text,
    status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    created_at  timestamptz not null default now(),
    reviewed_at timestamptz,
    reviewed_by uuid references public.profiles(id)
);

create index if not exists idx_deposits_user     on public.deposits(user_id);
create index if not exists idx_investments_user  on public.investments(user_id);
create index if not exists idx_profit_user       on public.profit_logs(user_id);
create index if not exists idx_referral_referrer on public.referral_earnings(referrer_id);
create index if not exists idx_withdrawals_user  on public.withdrawals(user_id);
create index if not exists idx_profiles_referred on public.profiles(referred_by);


-- ---------------------------------------------------------------------
-- 2) DEFAULT DATA  (change the numbers later from the Admin panel)
-- ---------------------------------------------------------------------

insert into public.settings (id, min_withdraw, return_principal)
values (1, 5, true)
on conflict (id) do nothing;

insert into public.plans (id, name, min_amount, max_amount, duration_days, daily_rate, referral_rate, featured, sort_order)
values
    ('starter', 'Starter',   10,    50,  50, 1.0,  5, false, 1),
    ('silver',  'Silver',    50,   100,  90, 1.2,  6, false, 2),
    ('gold',    'Gold',     100,   500, 120, 1.5,  8, true,  3),
    ('diamond', 'Diamond',  500,  1000, 180, 2.0, 10, false, 4)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 3) HELPER FUNCTIONS
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.gen_referral_code()
returns text
language plpgsql
set search_path = public
as $$
declare
    c text;
begin
    loop
        c := 'IP' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
        exit when not exists (select 1 from public.profiles where referral_code = c);
    end loop;
    return c;
end;
$$;

-- Creates a profile (with its own referral code) for every new account
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    used_code text;
    ref_id    uuid;
begin
    used_code := upper(trim(coalesce(new.raw_user_meta_data ->> 'referral_code', '')));

    if used_code <> '' then
        select id into ref_id from public.profiles where referral_code = used_code;
    end if;

    insert into public.profiles (id, email, first_name, last_name, phone, referral_code, referred_by)
    values (
        new.id,
        new.email,
        left(new.raw_user_meta_data ->> 'first_name', 60),
        left(new.raw_user_meta_data ->> 'last_name', 60),
        left(new.raw_user_meta_data ->> 'phone', 30),
        public.gen_referral_code(),
        ref_id
    );

    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- Available balance = profit + referral bonus (+ principal of finished plans) - withdrawals
create or replace function public.balance_of(p_user uuid)
returns numeric
language sql
security definer
stable
set search_path = public
as $$
    select
        coalesce((select sum(amount) from public.profit_logs where user_id = p_user), 0)
      + coalesce((select sum(amount) from public.referral_earnings where referrer_id = p_user), 0)
      + case
            when (select return_principal from public.settings where id = 1)
            then coalesce((select sum(amount) from public.investments where user_id = p_user and status = 'completed'), 0)
            else 0
        end
      - coalesce((select sum(amount) from public.withdrawals where user_id = p_user and status in ('pending', 'approved')), 0);
$$;

-- Adds the daily profit that is due (safe to run many times)
create or replace function public.accrue_profits(p_user uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    r       record;
    added   int := 0;
    n       int;
    maxday  int;
begin
    for r in
        select * from public.investments
        where status = 'running' and (p_user is null or user_id = p_user)
    loop
        maxday := least(r.duration_days, current_date - r.start_date);

        if maxday >= 1 then
            insert into public.profit_logs (investment_id, user_id, day_number, profit_date, amount)
            select r.id, r.user_id, g, r.start_date + g, round(r.amount * r.daily_rate / 100, 2)
            from generate_series(1, maxday) as g
            on conflict (investment_id, day_number) do nothing;

            get diagnostics n = row_count;
            added := added + n;
        end if;

        if (current_date - r.start_date) >= r.duration_days then
            update public.investments set status = 'completed' where id = r.id;
        end if;
    end loop;

    return added;
end;
$$;


-- ---------------------------------------------------------------------
-- 4) FUNCTIONS THE WEBSITE CALLS (the only way to change data)
-- ---------------------------------------------------------------------

-- Used on the register page to check a referral code
create or replace function public.referral_code_exists(p_code text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select exists (select 1 from public.profiles where referral_code = upper(trim(p_code)));
$$;

create or replace function public.accrue_my_profits()
returns int
language sql
security definer
set search_path = public
as $$
    select public.accrue_profits(auth.uid());
$$;

create or replace function public.my_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    uid uuid := auth.uid();
    s   public.settings;
begin
    if uid is null then
        raise exception 'Please login first';
    end if;

    select * into s from public.settings where id = 1;

    return jsonb_build_object(
        'available',    public.balance_of(uid),
        'profit',       coalesce((select sum(amount) from public.profit_logs where user_id = uid), 0),
        'referral',     coalesce((select sum(amount) from public.referral_earnings where referrer_id = uid), 0),
        'active',       coalesce((select sum(amount) from public.investments where user_id = uid and status = 'running'), 0),
        'used',         coalesce((select sum(amount) from public.withdrawals where user_id = uid and status in ('pending', 'approved')), 0),
        'min_withdraw', s.min_withdraw
    );
end;
$$;

-- People who joined with my code, and what plans they bought
create or replace function public.my_referrals()
returns table (
    r_name       text,
    r_email      text,
    r_joined     timestamptz,
    r_plan       text,
    r_amount     numeric,
    r_commission numeric,
    r_status     text
)
language sql
security definer
stable
set search_path = public
as $$
    select
        trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')),
        left(split_part(p.email, '@', 1), 2) || '***@' || split_part(p.email, '@', 2),
        p.created_at,
        pl.name,
        d.amount,
        case when d.id is null then null else round(d.amount * pl.referral_rate / 100, 2) end,
        d.status
    from public.profiles p
    left join public.deposits d on d.user_id = p.id
    left join public.plans pl   on pl.id = d.plan_id
    where p.referred_by = auth.uid()
    order by p.created_at desc, d.created_at desc;
$$;

create or replace function public.request_deposit(p_plan text, p_amount numeric, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    uid    uuid := auth.uid();
    pl     public.plans;
    new_id uuid;
begin
    if uid is null then
        raise exception 'Please login first';
    end if;

    if p_amount is null then
        raise exception 'Please enter an amount';
    end if;

    select * into pl from public.plans where id = p_plan and active;

    if not found then
        raise exception 'Plan not found';
    end if;

    if p_amount < pl.min_amount or p_amount > pl.max_amount then
        raise exception 'For the % plan, the amount must be between % and %', pl.name, pl.min_amount, pl.max_amount;
    end if;

    if (select count(*) from public.deposits where user_id = uid and status = 'pending') >= 5 then
        raise exception 'You already have 5 pending deposits. Please wait for approval.';
    end if;

    insert into public.deposits (user_id, plan_id, amount, note)
    values (uid, pl.id, round(p_amount, 2), left(p_note, 200))
    returning id into new_id;

    return new_id;
end;
$$;

create or replace function public.request_withdrawal(p_amount numeric, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    uid    uuid := auth.uid();
    minw   numeric;
    bal    numeric;
    new_id uuid;
begin
    if uid is null then
        raise exception 'Please login first';
    end if;

    if p_amount is null then
        raise exception 'Please enter an amount';
    end if;

    -- lock this user's row so two requests cannot spend the same balance
    perform 1 from public.profiles where id = uid for update;

    select min_withdraw into minw from public.settings where id = 1;

    if p_amount < minw then
        raise exception 'Minimum withdrawal is %', minw;
    end if;

    perform public.accrue_profits(uid);
    bal := public.balance_of(uid);

    if p_amount > bal then
        raise exception 'You can withdraw up to %', bal;
    end if;

    insert into public.withdrawals (user_id, amount, note)
    values (uid, round(p_amount, 2), left(p_note, 200))
    returning id into new_id;

    return new_id;
end;
$$;


-- ---------------------------------------------------------------------
-- 5) ADMIN FUNCTIONS (checked on the server, users cannot call them)
-- ---------------------------------------------------------------------

create or replace function public.admin_review_deposit(p_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    d   public.deposits;
    pl  public.plans;
    ref uuid;
begin
    if not public.is_admin() then
        raise exception 'Admins only';
    end if;

    select * into d from public.deposits where id = p_id for update;

    if not found then
        raise exception 'Deposit not found';
    end if;

    if d.status <> 'pending' then
        raise exception 'This deposit was already reviewed';
    end if;

    if not p_approve then
        update public.deposits
        set status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid()
        where id = p_id;
        return;
    end if;

    select * into pl from public.plans where id = d.plan_id;

    update public.deposits
    set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid()
    where id = p_id;

    insert into public.investments (user_id, deposit_id, plan_id, amount, daily_rate, duration_days)
    values (d.user_id, d.id, d.plan_id, d.amount, pl.daily_rate, pl.duration_days);

    -- referral commission for whoever referred this user
    select referred_by into ref from public.profiles where id = d.user_id;

    if ref is not null and pl.referral_rate > 0 then
        insert into public.referral_earnings (referrer_id, referred_id, deposit_id, rate, amount)
        values (ref, d.user_id, d.id, pl.referral_rate, round(d.amount * pl.referral_rate / 100, 2));
    end if;
end;
$$;

create or replace function public.admin_review_withdrawal(p_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'Admins only';
    end if;

    update public.withdrawals
    set status = case when p_approve then 'approved' else 'rejected' end,
        reviewed_at = now(),
        reviewed_by = auth.uid()
    where id = p_id and status = 'pending';

    if not found then
        raise exception 'Withdrawal not found or already reviewed';
    end if;
end;
$$;

create or replace function public.admin_update_plan(
    p_id text, p_min numeric, p_max numeric, p_days int,
    p_rate numeric, p_ref numeric, p_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'Admins only';
    end if;

    update public.plans
    set min_amount = p_min, max_amount = p_max, duration_days = p_days,
        daily_rate = p_rate, referral_rate = p_ref, active = p_active
    where id = p_id;

    if not found then
        raise exception 'Plan not found';
    end if;
end;
$$;

create or replace function public.admin_update_settings(p_min_withdraw numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'Admins only';
    end if;

    update public.settings set min_withdraw = p_min_withdraw where id = 1;
end;
$$;

create or replace function public.admin_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'Admins only';
    end if;

    return jsonb_build_object(
        'users',               (select count(*) from public.profiles where role = 'user'),
        'pending_deposits',    (select count(*) from public.deposits where status = 'pending'),
        'pending_withdrawals', (select count(*) from public.withdrawals where status = 'pending'),
        'approved_deposits',   coalesce((select sum(amount) from public.deposits where status = 'approved'), 0),
        'profit_credited',     coalesce((select sum(amount) from public.profit_logs), 0),
        'referral_credited',   coalesce((select sum(amount) from public.referral_earnings), 0)
    );
end;
$$;


-- ---------------------------------------------------------------------
-- 6) SECURITY: Row Level Security (users only see their own rows)
-- ---------------------------------------------------------------------

alter table public.profiles          enable row level security;
alter table public.plans             enable row level security;
alter table public.settings          enable row level security;
alter table public.deposits          enable row level security;
alter table public.investments       enable row level security;
alter table public.profit_logs       enable row level security;
alter table public.referral_earnings enable row level security;
alter table public.withdrawals       enable row level security;

drop policy if exists "read own profile"     on public.profiles;
drop policy if exists "read plans"           on public.plans;
drop policy if exists "read settings"        on public.settings;
drop policy if exists "read own deposits"    on public.deposits;
drop policy if exists "read own investments" on public.investments;
drop policy if exists "read own profit"      on public.profit_logs;
drop policy if exists "read own referrals"   on public.referral_earnings;
drop policy if exists "read own withdrawals" on public.withdrawals;

create policy "read own profile"     on public.profiles          for select using (id = auth.uid() or public.is_admin());
create policy "read plans"           on public.plans             for select using (true);
create policy "read settings"        on public.settings          for select using (true);
create policy "read own deposits"    on public.deposits          for select using (user_id = auth.uid() or public.is_admin());
create policy "read own investments" on public.investments       for select using (user_id = auth.uid() or public.is_admin());
create policy "read own profit"      on public.profit_logs       for select using (user_id = auth.uid() or public.is_admin());
create policy "read own referrals"   on public.referral_earnings for select using (referrer_id = auth.uid() or public.is_admin());
create policy "read own withdrawals" on public.withdrawals       for select using (user_id = auth.uid() or public.is_admin());

-- The website can NOT write to tables directly. Only the functions above can.
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
grant  select on all tables in schema public to authenticated;
grant  select on public.plans, public.settings to anon;


-- ---------------------------------------------------------------------
-- 7) WHO CAN CALL WHICH FUNCTION
-- ---------------------------------------------------------------------

-- internal only (never callable from the website)
revoke all on function public.balance_of(uuid)       from public, anon, authenticated;
revoke all on function public.accrue_profits(uuid)   from public, anon, authenticated;
revoke all on function public.gen_referral_code()    from public, anon, authenticated;
revoke all on function public.is_admin()             from public, anon;

-- visitors (not logged in)
revoke all on function public.referral_code_exists(text) from public;
grant execute on function public.referral_code_exists(text) to anon, authenticated;

-- logged-in users
revoke all on function public.accrue_my_profits()                    from public, anon;
revoke all on function public.my_summary()                           from public, anon;
revoke all on function public.my_referrals()                         from public, anon;
revoke all on function public.request_deposit(text, numeric, text)   from public, anon;
revoke all on function public.request_withdrawal(numeric, text)      from public, anon;
grant execute on function public.is_admin()                          to authenticated;
grant execute on function public.accrue_my_profits()                 to authenticated;
grant execute on function public.my_summary()                        to authenticated;
grant execute on function public.my_referrals()                      to authenticated;
grant execute on function public.request_deposit(text, numeric, text) to authenticated;
grant execute on function public.request_withdrawal(numeric, text)   to authenticated;

-- admin functions (the function itself also checks is_admin())
revoke all on function public.admin_review_deposit(uuid, boolean)    from public, anon;
revoke all on function public.admin_review_withdrawal(uuid, boolean) from public, anon;
revoke all on function public.admin_update_plan(text, numeric, numeric, int, numeric, numeric, boolean) from public, anon;
revoke all on function public.admin_update_settings(numeric)         from public, anon;
revoke all on function public.admin_stats()                          from public, anon;
grant execute on function public.admin_review_deposit(uuid, boolean)    to authenticated;
grant execute on function public.admin_review_withdrawal(uuid, boolean) to authenticated;
grant execute on function public.admin_update_plan(text, numeric, numeric, int, numeric, numeric, boolean) to authenticated;
grant execute on function public.admin_update_settings(numeric)         to authenticated;
grant execute on function public.admin_stats()                          to authenticated;


-- ---------------------------------------------------------------------
-- 8) AFTER YOU REGISTER ON THE WEBSITE: make yourself the admin
--    (replace the email, then run just this one line)
-- ---------------------------------------------------------------------
-- update public.profiles set role = 'admin' where email = 'your-email@gmail.com';


-- ---------------------------------------------------------------------
-- 9) OPTIONAL: automatic daily profit even when nobody opens the site
--    First enable it: Database > Extensions > pg_cron > Enable. Then run:
-- ---------------------------------------------------------------------
-- select cron.schedule('accrue-profits-daily', '10 0 * * *', $$select public.accrue_profits()$$);
