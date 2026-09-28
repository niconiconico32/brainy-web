const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const identity = require('../assets/funnel-identity.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'person@example.com';

function authClient(overrides = {}) {
  return {
    auth: {
      signInWithOtp: async () => ({ data: {}, error: null }),
      verifyOtp: async () => ({ data: {}, error: null }),
      getUser: async () => ({ data: { user: { id: USER_ID, email: EMAIL } }, error: null }),
      getSession: async () => ({
        data: { session: { access_token: 'test-access-token', user: { id: USER_ID } } },
        error: null,
      }),
      ...overrides,
    },
  };
}

async function testOtpAndPreparation() {
  let request;
  const client = authClient({
    signInWithOtp: async (params) => {
      request = params;
      return { data: {}, error: null };
    },
  });
  assert.deepEqual(await identity.requestOtp(client, EMAIL), { ok: true });
  assert.equal(request.email, EMAIL);
  assert.equal(request.options.shouldCreateUser, true);

  const verified = await identity.verifyOtp(client, EMAIL, '123456');
  assert.equal(verified.ok, true);
  assert.equal(verified.user.id, USER_ID);

  let prepareBody;
  const prepared = await identity.prepareFunnelAccount({
    client,
    fetchImpl: async (_url, options) => {
      prepareBody = JSON.parse(options.body);
      assert.equal(options.headers.Authorization, 'Bearer test-access-token');
      return { ok: true, json: async () => ({ userId: USER_ID }) };
    },
    url: 'https://example.test/prepare-funnel-account',
    anonKey: 'public-anon-key',
    planId: 'plan-id',
    claimToken: 'claim-token',
    email: EMAIL,
  });
  assert.deepEqual(prepared, {
    ok: true,
    userId: USER_ID,
    alreadyPro: false,
    accountState: null,
    session: { access_token: 'test-access-token', user: { id: USER_ID } },
  });
  assert.deepEqual(prepareBody, { planId: 'plan-id', claimToken: 'claim-token', email: EMAIL });
}

async function testOtpResend() {
  let requests = 0;
  const client = authClient({
    signInWithOtp: async () => {
      requests += 1;
      return { data: {}, error: null };
    },
  });
  assert.equal((await identity.requestOtp(client, EMAIL)).ok, true);
  assert.equal((await identity.requestOtp(client, EMAIL)).ok, true);
  assert.equal(requests, 2);
}

async function testAlreadyProIsReturned() {
  const result = await identity.prepareFunnelAccount({
    client: authClient(),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ userId: USER_ID, alreadyPro: true, accountState: 'existing_used' }),
    }),
    url: 'https://example.test/prepare-funnel-account',
    planId: 'plan-id',
    claimToken: 'claim-token',
    email: EMAIL,
  });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyPro, true);
  assert.equal(result.accountState, 'existing_used');
}

async function testIdentityMismatchBlocksPreparation() {
  const result = await identity.prepareFunnelAccount({
    client: authClient(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ userId: 'different-user' }) }),
    url: 'https://example.test/prepare-funnel-account',
    planId: 'plan-id',
    claimToken: 'claim-token',
    email: EMAIL,
  });
  assert.deepEqual(result, { ok: false, error: 'identity_mismatch' });
}

async function testMissingSessionBlocksPreparation() {
  const result = await identity.prepareFunnelAccount({
    client: authClient({
      getSession: async () => ({ data: { session: null }, error: null }),
    }),
    fetchImpl: async () => {
      throw new Error('must not call network');
    },
    url: 'https://example.test/prepare-funnel-account',
    planId: 'plan-id',
    claimToken: 'claim-token',
    email: EMAIL,
  });
  assert.deepEqual(result, { ok: false, error: 'session_unavailable' });
}

function testRevenueCatUsesVerifiedUuid() {
  let config;
  const sdkInstance = { getOfferings: async () => ({}), getAppUserId: () => USER_ID };
  const context = {
    window: {
      Purchases: {
        Purchases: {
          configure: (value) => {
            config = value;
            return sdkInstance;
          },
          setLogLevel: () => {},
        },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/revenuecat.js'), 'utf8'), context);
  const service = context.window.BrainyRevenueCat;
  assert.equal(service.configure({ apiKey: 'strp_sb_public', appUserId: USER_ID }) !== null, true);
  assert.equal(config.appUserId, USER_ID);
  assert.equal(service.configure({ apiKey: 'strp_sb_public' }), null);
  assert.throws(
    () => service.configure({ apiKey: 'strp_sb_public', appUserId: '22222222-2222-4222-8222-222222222222' }),
    /different App User ID/,
  );
}

async function main() {
  const funnel = fs.readFileSync(require.resolve('../funnel.html'), 'utf8');
  const cases = [
    ['otp and preparation', testOtpAndPreparation],
    ['otp resend', testOtpResend],
    ['alreadyPro propagation', testAlreadyProIsReturned],
    ['identity mismatch', testIdentityMismatchBlocksPreparation],
    ['missing session', testMissingSessionBlocksPreparation],
    ['RevenueCat UUID and stale identity', testRevenueCatUsesVerifiedUuid],
    ['no-redemption recovery contract', () => {
      assert.match(funnel, /requestEmailOtp\(email, document\.getElementById\('resendOtpBtn'\)\)/);
      assert.match(funnel, /if \(!redeemUrl\)[\s\S]*setState\('handoffReady', true\)[\s\S]*goNext\(\)/);
      assert.match(funnel, /NUNCA vuelve a ejecutar purchase\(\)/);
      assert.doesNotMatch(funnel, /link \+= `&email=/);
      assert.ok(funnel.indexOf('if (identity.alreadyPro)') < funnel.indexOf('svc.purchase('));
    }],
  ];
  let passed = 0;
  for (const [name, run] of cases) {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  }
  console.log(`identity regression: ${passed}/${cases.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
