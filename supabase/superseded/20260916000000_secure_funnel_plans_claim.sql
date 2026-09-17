-- Funnel web-to-app: endurecer claim de funnel_plans.
--
-- Cambios:
--   * claim_token hash (SHA-256) en vez de token en texto plano;
--   * client_plan_key como clave de idempotencia (ya no email);
--   * claimed_by_user_id para que la app registre quién reclamó el plan;
--   * status 'claiming' antes de materializar.
--
-- La web SOLO crea planes en status 'pending' vía create-funnel-plan.
-- La app/backend gestiona claiming/claimed/expired (claim-funnel-plan).

-- 1. Nuevas columnas (nullables al inicio para backfill de filas existentes).
alter table public.funnel_plans
    add column if not exists client_plan_key uuid,
    add column if not exists claim_token_hash text,
    add column if not exists claimed_by_user_id uuid;

-- 2. Backfill de filas legacy.
update public.funnel_plans
set claim_token_hash = encode(digest(claim_token, 'sha256'), 'hex')
where claim_token_hash is null
  and claim_token is not null;

update public.funnel_plans
set client_plan_key = gen_random_uuid()
where client_plan_key is null;

-- 3. Restricciones objetivo.
alter table public.funnel_plans
    alter column client_plan_key set not null,
    alter column claim_token_hash set not null;

alter table public.funnel_plans
    drop constraint if exists funnel_plans_client_plan_key_key;
alter table public.funnel_plans
    add constraint funnel_plans_client_plan_key_key unique (client_plan_key);

alter table public.funnel_plans
    drop constraint if exists funnel_plans_claim_token_hash_key;
alter table public.funnel_plans
    add constraint funnel_plans_claim_token_hash_key unique (claim_token_hash);

alter table public.funnel_plans
    drop constraint if exists funnel_plans_claimed_by_user_id_fkey;
alter table public.funnel_plans
    add constraint funnel_plans_claimed_by_user_id_fkey
    foreign key (claimed_by_user_id) references auth.users(id) on delete set null;

-- 4. Estados: pending -> claiming -> claimed | expired.
alter table public.funnel_plans
    drop constraint if exists funnel_plans_status_check;
alter table public.funnel_plans
    add constraint funnel_plans_status_check
    check (status in ('pending', 'claiming', 'claimed', 'expired'));

-- 5. Índices.
drop index if exists public.funnel_plans_claim_token_idx;
create index if not exists funnel_plans_claim_token_hash_idx
    on public.funnel_plans (claim_token_hash);
create index if not exists funnel_plans_client_plan_key_idx
    on public.funnel_plans (client_plan_key);

-- 6. Eliminar el token en texto plano.
alter table public.funnel_plans drop column if exists claim_token;

-- 7. RLS sin cambios: sin acceso anon/authenticated, solo service_role.
alter table public.funnel_plans enable row level security;
revoke all on table public.funnel_plans from anon, authenticated;
grant all on table public.funnel_plans to service_role;
