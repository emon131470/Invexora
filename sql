-- =====================================================================
--  INVEXORA - UPDATE 2  (run ONCE in Supabase > SQL Editor, after the first setup file)
--  Adds: payment method columns, user suspend, admin activity log,
--        return-principal switch, support chat.
--  Safe to run again (it will not delete your data).
-- =====================================================================

-- 1) NEW COLUMNS
alter table public.profiles    add column if not exists suspended    boolean not null default false;
alter table public.profiles    add column if not exists suspended_at timestamptz;
alter table public.deposits    add column if not exists payment_method text;
alter table public.withdrawals add column if not exists payment_method text;

-- fill the method for old rows that stored it inside the note like "[Bank Transfer] ..."
update public.deposits    set payment_method = substring(note from '^\[([^\]]+)\]') where payment_method is null and note ~ '^\[[^\]]+\]';
update public.withdrawals set payment_method = substring(note from '^\[([^\]]+)\]') where payment_method is null and note ~ '^\[[^\]]+\]';

-- 2) NEW TABLES
create table if not exists public.audit_log (
    id           bigint generated always as identity primary key,
    admin_id     uuid references public.profiles(id) on delete set null,
    action       text not null,
    target_table text,
    target_id    text,
    details      jsonb,
    created_at   timestamptz not null default now()
);

create table if not exists public.support_messages (
    id            bigint generated always as identity primary key,
    user_id       uuid not null references public.profiles(id) on delete cascade,
    sender        text not null check (sender in ('user', 'admin')),
    body          text not null check (char_length(body) between 1 and 1000),
    read_by_admin boolean not null default false,
    read_by_user  boolean not null default false,
    created_at    timestamptz not null default now()
);

create index if not exists idx_support_user  on public.support_messages(user_id, created_at);
create index if not exists idx_audit_created on public.audit_log(created_at desc);

-- 3) SECURITY FOR THE NEW TABLES (read-only from the website, writes only through functions)
alter table public.audit_log        enable row level security;
alter table public.support_messages enable row level security;

drop policy if exists "admin reads audit"      on public.audit_log;
drop policy if exists "read own support"       on public.support_messages;
create policy "admin reads audit" on public.audit_log        for select using (public.is_admin());
create policy "read own support"  on public.support_messages for select using (user_id = auth.uid() or public.is_admin());

revoke all on public.audit_log, public.support_messages from anon, authenticated;
grant  select on public.audit_log, public.support_messages to authenticated;

-- 4) HELPER FUNCTIONS (internal)
create or replace function public.audit(p_action text, p_table text, p_id text, p_details jsonb default null)
returns void
language sql
security definer
set search_path = public
as $$
    insert into public.audit_log (admin_id, action, target_table, target_id, details)
    values (auth.uid(), p_action, p_table, p_id, p_details);
$$;

create or replace function public.is_suspended(p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select coalesce((select suspended from public.profiles where id = p_user), false);
$$;

revoke all on function public.audit(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.is_suspended(uuid)             from public, anon, authenticated;

-- 5) DEPOSIT / WITHDRAWAL NOW SAVE THE PAYMENT METHOD (and block suspended users)
drop function if exists public.request_deposit(text, numeric, text);
drop function if exists public.request_withdrawal(numeric, text);

create or replace function public.request_deposit(p_plan text, p_amount numeric, p_note text default null, p_method text default null)
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

    if public.is_suspended(uid) then
        raise exception 'Your account is suspended. Please contact support.';
    end if;

    if p_amount is null then
        raise exception 'Please enter an amount';
    end if;

    if p_method is null or p_method not in ('Bank Transfer', 'Crypto (USDT)', 'Mobile Wallet') then
        raise exception 'Please choose a payment method';
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

    insert into public.deposits (user_id, plan_id, amount, note, payment_method)
    values (uid, pl.id, round(p_amount, 2), left(p_note, 200), p_method)
    returning id into new_id;

    return new_id;
end;
$$;

create or replace function public.request_withdrawal(p_amount numeric, p_note text default null, p_method text default null)
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

    if public.is_suspended(uid) then
        raise exception 'Your account is suspended. Please contact support.';
    end if;

    if p_amount is null then
        raise exception 'Please enter an amount';
    end if;

    if p_method is null or p_method not in ('Bank Transfer', 'Crypto (USDT)', 'Mobile Wallet') then
        raise exception 'Please choose a payment method';
    end if;

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

    insert into public.withdrawals (user_id, amount, note, payment_method)
    values (uid, round(p_amount, 2), left(p_note, 200), p_method)
    returning id into new_id;

    return new_id;
end;
$$;

revoke all on function public.request_deposit(text, numeric, text, text)  from public, anon;
revoke all on function public.request_withdrawal(numeric, text, text)     from public, anon;
grant execute on function public.request_deposit(text, numeric, text, text) to authenticated;
grant execute on function public.request_withdrawal(numeric, text, text)    to authenticated;

-- 6) ADMIN FUNCTIONS (same as before, now they also write the activity log)
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

        perform public.audit('deposit_rejected', 'deposits', p_id::text,
            jsonb_build_object('user_id', d.user_id, 'amount', d.amount, 'plan', d.plan_id, 'method', d.payment_method));
        return;
    end if;

    select * into pl from public.plans where id = d.plan_id;

    update public.deposits
    set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid()
    where id = p_id;

    insert into public.investments (user_id, deposit_id, plan_id, amount, daily_rate, duration_days)
    values (d.user_id, d.id, d.plan_id, d.amount, pl.daily_rate, pl.duration_days);

    select referred_by into ref from public.profiles where id = d.user_id;

    if ref is not null and pl.referral_rate > 0 then
        insert into public.referral_earnings (referrer_id, referred_id, deposit_id, rate, amount)
        values (ref, d.user_id, d.id, pl.referral_rate, round(d.amount * pl.referral_rate / 100, 2));
    end if;

    perform public.audit('deposit_approved', 'deposits', p_id::text,
        jsonb_build_object('user_id', d.user_id, 'amount', d.amount, 'plan', d.plan_id, 'method', d.payment_method));
end;
$$;

create or replace function public.admin_review_withdrawal(p_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    w public.withdrawals;
begin
    if not public.is_admin() then
        raise exception 'Admins only';
    end if;

    update public.withdrawals
    set status = case when p_approve then 'approved' else 'rejected' end,
        reviewed_at = now(),
        reviewed_by = auth.uid()
    where id = p_id and status = 'pending'
    returning * into w;

    if not found then
        raise exception 'Withdrawal not found or already reviewed';
    end if;

    perform public.audit(case when p_approve then 'withdrawal_approved' else 'withdrawal_rejected' end,
        'withdrawals', p_id::text,
        jsonb_build_object('user_id', w.user_id, 'amount', w.amount, 'method', w.payment_method));
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

    perform public.audit('plan_updated', 'plans', p_id,
        jsonb_build_object('min', p_min, 'max', p_max, 'days', p_days, 'daily_rate', p_rate, 'referral_rate', p_ref, 'active', p_active));
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

    perform public.audit('settings_min_withdraw', 'settings', '1', jsonb_build_object('min_withdraw', p_min_withdraw));
end;
$$;

-- 7) NEW ADMIN FUNCTIONS
create or replace function public.admin_set_return_principal(p_value boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'Admins only';
    end if;

    update public.settings set return_principal = coalesce(p_value, true) where id = 1;

    perform public.audit('settings_return_principal', 'settings', '1', jsonb_build_object('return_principal', p_value));
end;
$$;

create or replace function public.admin_set_suspended(p_user uuid, p_suspended boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    target public.profiles;
begin
    if not public.is_admin() then
        raise exception 'Admins only';
    end if;

    select * into target from public.profiles where id = p_user;

    if not found then
        raise exception 'User not found';
    end if;

    if target.role = 'admin' then
        raise exception 'An admin account cannot be suspended';
    end if;

    update public.profiles
    set suspended = p_suspended,
        suspended_at = case when p_suspended then now() else null end
    where id = p_user;

    perform public.audit(case when p_suspended then 'user_suspended' else 'user_unsuspended' end,
        'profiles', p_user::text, jsonb_build_object('email', target.email));
end;
$$;

create or replace function public.admin_user_summary(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'Admins only';
    end if;

    perform public.accrue_profits(p_user);

    return jsonb_build_object(
        'available',   public.balance_of(p_user),
        'profit',      coalesce((select sum(amount) from public.profit_logs where user_id = p_user), 0),
        'referral',    coalesce((select sum(amount) from public.referral_earnings where referrer_id = p_user), 0),
        'active',      coalesce((select sum(amount) from public.investments where user_id = p_user and status = 'running'), 0),
        'withdrawn',   coalesce((select sum(amount) from public.withdrawals where user_id = p_user and status = 'approved'), 0),
        'pending_wd',  coalesce((select sum(amount) from public.withdrawals where user_id = p_user and status = 'pending'), 0),
        'deposited',   coalesce((select sum(amount) from public.deposits where user_id = p_user and status = 'approved'), 0)
    );
end;
$$;

-- 8) SUPPORT CHAT
create or replace function public.send_support_message(p_body text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    uid    uuid := auth.uid();
    txt    text := trim(coalesce(p_body, ''));
    new_id bigint;
begin
    if uid is null then
        raise exception 'Please login first';
    end if;

    if char_length(txt) < 1 or char_length(txt) > 1000 then
        raise exception 'Message must be between 1 and 1000 characters';
    end if;

    if (select count(*) from public.support_messages
        where user_id = uid and sender = 'user' and created_at > now() - interval '10 minutes') >= 10 then
        raise exception 'You are sending messages too fast. Please wait a few minutes.';
    end if;

    insert into public.support_messages (user_id, sender, body, read_by_user)
    values (uid, 'user', txt, true)
    returning id into new_id;

    return new_id;
end;
$$;

create or replace function public.mark_support_read()
returns void
language sql
security definer
set search_path = public
as $$
    update public.support_messages
    set read_by_user = true
    where user_id = auth.uid() and sender = 'admin' and not read_by_user;
$$;

create or replace function public.admin_reply_support(p_user uuid, p_body text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    txt    text := trim(coalesce(p_body, ''));
    new_id bigint;
begin
    if not public.is_admin() then
        raise exception 'Admins only';
    end if;

    if char_length(txt) < 1 or char_length(txt) > 1000 then
        raise exception 'Reply must be between 1 and 1000 characters';
    end if;

    if not exists (select 1 from public.profiles where id = p_user) then
        raise exception 'User not found';
    end if;

    insert into public.support_messages (user_id, sender, body, read_by_admin)
    values (p_user, 'admin', txt, true)
    returning id into new_id;

    update public.support_messages set read_by_admin = true where user_id = p_user and sender = 'user' and not read_by_admin;

    perform public.audit('support_reply', 'support_messages', new_id::text, jsonb_build_object('user_id', p_user));

    return new_id;
end;
$$;

create or replace function public.admin_mark_support_read(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'Admins only';
    end if;

    update public.support_messages set read_by_admin = true where user_id = p_user and sender = 'user' and not read_by_admin;
end;
$$;

create or replace function public.admin_support_threads()
returns table (
    t_user_id uuid,
    t_name    text,
    t_email   text,
    t_last    text,
    t_sender  text,
    t_at      timestamptz,
    t_unread  int
)
language sql
security definer
stable
set search_path = public
as $$
    select
        p.id,
        trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')),
        p.email,
        m.body,
        m.sender,
        m.created_at,
        (select count(*)::int from public.support_messages x where x.user_id = p.id and x.sender = 'user' and not x.read_by_admin)
    from public.profiles p
    join lateral (
        select body, sender, created_at from public.support_messages
        where user_id = p.id order by created_at desc, id desc limit 1
    ) m on true
    where public.is_admin()
    order by 7 desc, m.created_at desc;
$$;

-- 9) WHO CAN CALL WHAT
revoke all on function public.admin_set_return_principal(boolean)       from public, anon;
revoke all on function public.admin_set_suspended(uuid, boolean)        from public, anon;
revoke all on function public.admin_user_summary(uuid)                  from public, anon;
revoke all on function public.send_support_message(text)                from public, anon;
revoke all on function public.mark_support_read()                       from public, anon;
revoke all on function public.admin_reply_support(uuid, text)           from public, anon;
revoke all on function public.admin_mark_support_read(uuid)             from public, anon;
revoke all on function public.admin_support_threads()                   from public, anon;

grant execute on function public.admin_set_return_principal(boolean)    to authenticated;
grant execute on function public.admin_set_suspended(uuid, boolean)     to authenticated;
grant execute on function public.admin_user_summary(uuid)               to authenticated;
grant execute on function public.send_support_message(text)             to authenticated;
grant execute on function public.mark_support_read()                    to authenticated;
grant execute on function public.admin_reply_support(uuid, text)        to authenticated;
grant execute on function public.admin_mark_support_read(uuid)          to authenticated;
grant execute on function public.admin_support_threads()                to authenticated;

-- the review / plan / settings functions were re-created above, so give them the same access again
revoke all on function public.admin_review_deposit(uuid, boolean)    from public, anon;
revoke all on function public.admin_review_withdrawal(uuid, boolean) from public, anon;
revoke all on function public.admin_update_plan(text, numeric, numeric, int, numeric, numeric, boolean) from public, anon;
revoke all on function public.admin_update_settings(numeric)         from public, anon;
grant execute on function public.admin_review_deposit(uuid, boolean)    to authenticated;
grant execute on function public.admin_review_withdrawal(uuid, boolean) to authenticated;
grant execute on function public.admin_update_plan(text, numeric, numeric, int, numeric, numeric, boolean) to authenticated;
grant execute on function public.admin_update_settings(numeric)         to authenticated;
