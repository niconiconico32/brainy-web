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
  console.log('create-funnel-plan policy: 7/7 passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
