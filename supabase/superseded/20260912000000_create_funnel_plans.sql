-- Funnel web-to-app: planes temporales creados desde funnel.html
-- Los planes NO tocan routines/routine_tasks/user_state/user_eggs:
-- solo se guarda el payload del plan y un token de claim para la app.

create extension if not exists pgcrypto;

create table if not exists public.funnel_plans (
    id uuid primary key default gen_random_uuid(),
    plan jsonb not null,
    email text,
    marketing_opt_in boolean not null default false,
    source text not null default 'website',
    campaign text not null default 'brainy_onboarding_v1',
    claim_token text not null unique,
    status text not null default 'pending' check (status in ('pending', 'claimed', 'expired')),
    claimed_at timestamptz,
    claim_expires_at timestamptz not null default (now() + interval '7 days'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists funnel_plans_email_idx on public.funnel_plans (email);
create index if not exists funnel_plans_claim_token_idx on public.funnel_plans (claim_token);

alter table public.funnel_plans enable row level security;

-- Sin políticas: la web inserta vía Edge Function con service_role (que saltea RLS).
-- La app reclama el plan luego con su propio backend/service role.
revoke all on table public.funnel_plans from anon, authenticated;
grant all on table public.funnel_plans to service_role;

create or replace function public.brainy_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists funnel_plans_set_updated_at on public.funnel_plans;
create trigger funnel_plans_set_updated_at
before update on public.funnel_plans
for each row execute function public.brainy_set_updated_at();