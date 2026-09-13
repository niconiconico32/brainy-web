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

    const email = body.email && typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : null
    const marketingOptIn = !!body.marketing_opt_in
    const source = typeof body.source === 'string' && body.source ? body.source : 'website'
    const campaign = typeof body.campaign === 'string' && body.campaign ? body.campaign : 'brainy_onboarding_v1'

    // Idempotencia: si ya existe un plan pendiente reciente con el mismo email,
    // reutilizamos su planId + claimToken en vez de crear un duplicado.
    if (email) {
      const { data: existing } = await sb
        .from('funnel_plans')
        .select('id, claim_token')
        .eq('email', email)
        .eq('status', 'pending')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
      if (existing && existing.length > 0) {
        return json({ planId: existing[0].id, claimToken: existing[0].claim_token })
      }
    }

    const planId = crypto.randomUUID()
    const claimToken = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')

    const { error } = await sb.from('funnel_plans').insert({
      id: planId,
      plan: body.plan,
      email,
      marketing_opt_in: marketingOptIn,
      source,
      campaign,
      claim_token: claimToken,
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