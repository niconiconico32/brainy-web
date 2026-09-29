export function classifyExisting(existing, now = Date.now()) {
  if (existing.purchase_confirmed_at) return 'paid'
  const expired = !!existing.expires_at && new Date(existing.expires_at).getTime() < now
  if (existing.status === 'pending' && !expired) return 'retry'
  if (existing.status === 'claiming') return 'claiming'
  if (existing.status === 'claimed') return 'claimed'
  return 'expired'
}

// Deliberately excludes funnel_user_id: a retry may refresh a pending payload,
// but it must never replace the identity already associated by the backend.
export function retryUpdateFields(fields, claimTokenHash) {
  return {
    claim_token_hash: claimTokenHash,
    plan: fields.plan,
    email: fields.email,
    marketing_opt_in: fields.marketingOptIn,
    source: fields.source,
    campaign: fields.campaign,
  }
}
