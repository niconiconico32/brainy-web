import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

interface FunnelPlanRequest {
  plan: Record<string, unknown>
  email?: string
  marketing_opt_in?: boolean
  source?: string
  campaign?: string
  client_plan_key?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Token criptográficamente seguro (32 bytes -> 64 hex). Nunca se persiste:
// en la base solo queda su SHA-256.
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
    const raw = await req.json()
    const body = raw as FunnelPlanRequest

    if (!body.plan || typeof body.plan !== 'object' || Array.isArray(body.plan)) {
      return json({ error: 'plan_required' }, 400)
    }
    const planSize = JSON.stringify(body.plan).length
    if (planSize > 256 * 1024) {
      return json({ error: 'plan_too_large' }, 413)
    }

    // Idempotencia por client_plan_key (NO por email): el front genera la clave
    // una vez y la reutiliza en reintentos.
    let clientPlanKey: string
    if (body.client_plan_key === undefined || body.client_plan_key === null) {
      clientPlanKey = crypto.randomUUID()
    } else if (typeof body.client_plan_key === 'string' && UUID_RE.test(body.client_plan_key)) {
      clientPlanKey = body.client_plan_key.toLowerCase()
    } else {
      return json({ error: 'invalid_client_plan_key' }, 400)
    }

    const email = body.email && typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : null
    const marketingOptIn = !!body.marketing_opt_in
    const source = typeof body.source === 'string' && body.source ? body.source : 'website'
    const campaign = typeof body.campaign === 'string' && body.campaign ? body.campaign : 'brainy_onboarding_v1'

    const { data: existing, error: selectError } = await sb
      .from('funnel_plans')
      .select('id, status, claim_expires_at')
      .eq('client_plan_key', clientPlanKey)
      .maybeSingle()

    if (selectError) {
      console.error('select error', selectError.message)
      return json({ error: 'lookup_failed' }, 500)
    }

    if (existing) {
      const expired = existing.claim_expires_at
        ? new Date(existing.claim_expires_at).getTime() < Date.now()
        : false

      if (existing.status !== 'pending' || expired) {
        // El plan ya fue reclamado/en proceso o venció: no se reemite token.
        return json({ error: 'plan_not_pending', status: existing.status }, 409)
      }

      // Retry seguro: misma fila pending, NUEVO claimToken que invalida el anterior.
      const newToken = generateClaimToken()
      const newHash = await sha256Hex(newToken)
      const { error: updateError } = await sb
        .from('funnel_plans')
        .update({ claim_token_hash: newHash })
        .eq('id', existing.id)
        .eq('status', 'pending')

      if (updateError) {
        console.error('update error', updateError.message)
        return json({ error: 'update_failed' }, 500)
      }
      return json({ planId: existing.id, claimToken: newToken })
    }

    const planId = crypto.randomUUID()
    const claimToken = generateClaimToken()
    const claimTokenHash = await sha256Hex(claimToken)

    const { error } = await sb.from('funnel_plans').insert({
      id: planId,
      plan: body.plan,
      email,
      marketing_opt_in: marketingOptIn,
      source,
      campaign,
      client_plan_key: clientPlanKey,
      claim_token_hash: claimTokenHash,
      status: 'pending',
    })

    if (error) {
      console.error('insert error', error.message)
      return json({ error: 'insert_failed' }, 500)
    }

    return json({ planId, claimToken })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unexpected_error'
    console.error('create-funnel-plan error', message)
    return json({ error: 'unexpected_error' }, 500)
  }
})
