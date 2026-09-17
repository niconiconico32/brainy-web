import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Crea el plan del funnel web en la tabla CANÓNICA `public.web_funnel_plans`.
//
// Contrato (ver handoffdetail.md):
//   * La web SOLO escribe en `web_funnel_plans` (nunca en `funnel_plans` legacy).
//   * Insert nuevo: status 'pending', version 1, client_plan_key (uuid),
//     expires_at, y SOLO el SHA-256(claimToken) en `claim_token_hash`.
//   * El claimToken en texto plano se devuelve UNA vez al navegador; nunca se
//     persiste (la columna está restringida a `^[a-f0-9]{64}$`).
//   * `claimed_by_user_id`, `claimed_at` y `revenuecat_redemption_url` los
//     gestiona la app/backend; la web los deja NULL.
//
// Idempotencia por `client_plan_key`:
//   * pending (vigente)      -> se reemite un NUEVO claimToken (reemplaza el
//                               hash, invalida el anterior) y se actualiza el
//                               payload/email.
//   * claiming / claimed     -> 409 (plan_already_claiming / plan_already_claimed).
//   * expired o TTL vencido  -> 409 (plan_expired): no se recicla como pending.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const PLAN_TABLE = 'web_funnel_plans'

// Ventana de vida de un plan sin reclamar antes de considerarse vencido.
const PLAN_TTL_MS = 7 * 24 * 60 * 60 * 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface FunnelPlanRequest {
  plan: Record<string, unknown>
  client_plan_key?: string
  email?: string
  marketing_opt_in?: boolean
  source?: string
  campaign?: string
}

interface ExistingRow {
  id: string
  status: string
  expires_at: string | null
}

interface PlanFields {
  plan: Record<string, unknown>
  email: string | null
  marketingOptIn: boolean
  source: string
  campaign: string
}

// Token de 32 bytes -> 64 hex minúsculas. Solo su SHA-256 toca la base.
function generateClaimToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function classifyExisting(existing: ExistingRow): 'retry' | 'claiming' | 'claimed' | 'expired' {
  const expired = !!existing.expires_at && new Date(existing.expires_at).getTime() < Date.now()
  if (existing.status === 'pending' && !expired) return 'retry'
  if (existing.status === 'claiming') return 'claiming'
  if (existing.status === 'claimed') return 'claimed'
  // status 'expired' o 'pending' con TTL vencido.
  return 'expired'
}

// Reintento seguro: misma fila pending, NUEVO claimToken que invalida el anterior.
async function reissueToken(
  sb: ReturnType<typeof createClient>,
  row: ExistingRow,
  fields: PlanFields,
): Promise<Response> {
  const newToken = generateClaimToken()
  const newHash = await sha256Hex(newToken)

  const { data: updated, error } = await sb
    .from(PLAN_TABLE)
    .update({
      claim_token_hash: newHash,
      plan: fields.plan,
      email: fields.email,
      marketing_opt_in: fields.marketingOptIn,
      source: fields.source,
      campaign: fields.campaign,
    })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')

  if (error) {
    console.error('retry update error', error.message)
    return json({ error: 'update_failed' }, 500)
  }
  if (!updated || updated.length === 0) {
    // Otra request cambió el estado entre el SELECT y el UPDATE.
    return json({ error: 'plan_not_pending' }, 409)
  }

  return json({ planId: row.id, claimToken: newToken })
}

async function resolveExisting(
  sb: ReturnType<typeof createClient>,
  existing: ExistingRow,
  fields: PlanFields,
): Promise<Response> {
  switch (classifyExisting(existing)) {
    case 'retry':
      return reissueToken(sb, existing, fields)
    case 'claiming':
      return json({ error: 'plan_already_claiming' }, 409)
    case 'claimed':
      return json({ error: 'plan_already_claimed' }, 409)
    case 'expired':
      return json({ error: 'plan_expired' }, 409)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceRole) {
    return json({ error: 'server_misconfigured' }, 500)
  }
  const sb = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  try {
    const raw = await req.json().catch(() => null)
    if (!raw || typeof raw !== 'object') {
      return json({ error: 'invalid_request' }, 400)
    }
    const body = raw as FunnelPlanRequest

    if (!body.plan || typeof body.plan !== 'object' || Array.isArray(body.plan)) {
      return json({ error: 'plan_required' }, 400)
    }
    const planSize = JSON.stringify(body.plan).length
    if (planSize > 256 * 1024) {
      return json({ error: 'plan_too_large' }, 413)
    }

    let clientPlanKey: string
    if (body.client_plan_key === undefined || body.client_plan_key === null) {
      clientPlanKey = crypto.randomUUID()
    } else if (typeof body.client_plan_key === 'string' && UUID_RE.test(body.client_plan_key)) {
      clientPlanKey = body.client_plan_key.toLowerCase()
    } else {
      return json({ error: 'invalid_client_plan_key' }, 400)
    }

    const fields: PlanFields = {
      plan: body.plan,
      email:
        typeof body.email === 'string' && body.email.trim()
          ? body.email.trim().toLowerCase()
          : null,
      marketingOptIn: !!body.marketing_opt_in,
      source: typeof body.source === 'string' && body.source ? body.source : 'website',
      campaign:
        typeof body.campaign === 'string' && body.campaign
          ? body.campaign
          : 'brainy_onboarding_v1',
    }

    // Idempotencia: la clave la genera el front UNA vez y la reutiliza en reintentos.
    const { data: existing, error: selectError } = await sb
      .from(PLAN_TABLE)
      .select('id, status, expires_at')
      .eq('client_plan_key', clientPlanKey)
      .maybeSingle()

    if (selectError) {
      console.error('select error', selectError.message)
      return json({ error: 'lookup_failed' }, 500)
    }

    if (existing) {
      return await resolveExisting(sb, existing as ExistingRow, fields)
    }

    const planId = crypto.randomUUID()
    const claimToken = generateClaimToken()
    const claimTokenHash = await sha256Hex(claimToken)
    const expiresAt = new Date(Date.now() + PLAN_TTL_MS).toISOString()

    const { error: insertError } = await sb.from(PLAN_TABLE).insert({
      id: planId,
      version: 1,
      status: 'pending',
      plan: fields.plan,
      email: fields.email,
      marketing_opt_in: fields.marketingOptIn,
      claim_token_hash: claimTokenHash,
      source: fields.source,
      campaign: fields.campaign,
      client_plan_key: clientPlanKey,
      expires_at: expiresAt,
    })

    if (insertError) {
      // Carrera: otra request insertó el mismo client_plan_key (unique).
      if (insertError.code === '23505') {
        const { data: raced } = await sb
          .from(PLAN_TABLE)
          .select('id, status, expires_at')
          .eq('client_plan_key', clientPlanKey)
          .maybeSingle()
        if (raced) {
          return await resolveExisting(sb, raced as ExistingRow, fields)
        }
      }
      console.error('insert error', insertError.message)
      return json({ error: 'insert_failed' }, 500)
    }

    return json({ planId, claimToken })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unexpected_error'
    console.error('create-funnel-plan error', message)
    return json({ error: 'unexpected_error' }, 500)
  }
})
