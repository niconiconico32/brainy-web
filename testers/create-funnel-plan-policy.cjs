const assert = require('node:assert/strict');

async function main() {
  const policy = await import('../supabase/functions/create-funnel-plan/policy.mjs');
  const fields = {
    plan: { tasks: [{ title: 'new payload' }] },
    email: 'new@example.com',
    marketingOptIn: true,
    source: 'website',
    campaign: 'test',
  };

  assert.equal(policy.classifyExisting({ status: 'pending', expires_at: null, purchase_confirmed_at: null }), 'retry');
  assert.equal(policy.classifyExisting({ status: 'pending', expires_at: null, purchase_confirmed_at: '2026-09-29T00:00:00Z' }), 'paid');
  assert.equal(policy.classifyExisting({ status: 'claiming', expires_at: null, purchase_confirmed_at: null }), 'claiming');
  assert.equal(policy.classifyExisting({ status: 'claimed', expires_at: null, purchase_confirmed_at: null }), 'claimed');

  const linked = {
    id: 'plan-id',
    status: 'pending',
    email: 'owner@example.com',
    funnel_user_id: 'user-id',
    purchase_confirmed_at: null,
  };
  assert.equal(policy.hasIdentityConflict(linked, 'other@example.com'), true);
  assert.equal(policy.hasIdentityConflict(linked, 'OWNER@example.com'), false);
  assert.equal(policy.hasIdentityConflict({ ...linked, funnel_user_id: null }, 'other@example.com'), false);

  const update = policy.retryUpdateFields(fields, 'hash');
  assert.deepEqual(update, {
    claim_token_hash: 'hash',
    plan: fields.plan,
    email: fields.email,
    marketing_opt_in: true,
    source: 'website',
    campaign: 'test',
  });
  assert.equal(Object.hasOwn(update, 'funnel_user_id'), false);
  assert.equal(Object.hasOwn(update, 'purchase_confirmed_at'), false);

  const conditions = policy.retryUpdateConditions(linked);
  assert.equal(policy.matchesRetryConditions({ ...linked }, conditions), true);
  assert.equal(policy.matchesRetryConditions({ ...linked, funnel_user_id: 'new-user' }, conditions), false);
  assert.equal(policy.matchesRetryConditions({ ...linked, purchase_confirmed_at: 'paid' }, conditions), false);
  console.log('create-funnel-plan policy: 12/12 passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
