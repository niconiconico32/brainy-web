const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const identity = require('../assets/funnel-identity.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'person@example.com';

async function prepare(fetchResult, extra = {}) {
  let body;
  const result = await identity.prepareFunnelAccount({
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => fetchResult };
    },
    url: 'https://example.test/prepare-funnel-account',
    anonKey: 'public-anon-key',
    planId: 'plan-id',
    claimToken: 'claim-token',
    email: EMAIL,
    ...extra,
  });
  return { result, body };
}

async function testIdentityWithoutOtp() {
  const { result, body } = await prepare({ userId: USER_ID, alreadyPro: false });
  assert.equal(result.ok, true);
  assert.equal(result.userId, USER_ID);
  assert.equal(result.alreadyPro, false);
  assert.deepEqual(body, { planId: 'plan-id', claimToken: 'claim-token', email: EMAIL });
}

async function testAlreadyProIsReturned() {
  const { result } = await prepare({
    userId: USER_ID,
    alreadyPro: true,
    accountState: 'existing_used',
  });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyPro, true);
  assert.equal(result.accountState, 'existing_used');
}

async function testMissingIdentityBlocksCheckout() {
  const { result } = await prepare({ alreadyPro: false });
  assert.deepEqual(result, { ok: false, error: 'identity_missing' });
}

function testRevenueCatUsesVerifiedUuidAndRejectsStaleIdentity() {
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
  assert.throws(
    () => service.configure({ apiKey: 'strp_sb_public', appUserId: '22222222-2222-4222-8222-222222222222' }),
    /different App User ID/,
  );
}

function testNoOtpCredentialsOrRedemptionContract() {
  const funnel = fs.readFileSync(require.resolve('../funnel.html'), 'utf8');
  const identitySource = fs.readFileSync(require.resolve('../assets/funnel-identity.js'), 'utf8');
  assert.doesNotMatch(funnel, /signInWithOtp|verifyOtp|requestEmailOtp|verifyOtpBtn|resendOtpBtn/);
  assert.doesNotMatch(funnel, /password|credentials/i);
  assert.doesNotMatch(identitySource, /signInWithOtp|verifyOtp|password/i);
  assert.match(funnel, /if \(!redeemUrl\)[\s\S]*setState\('handoffReady', true\)[\s\S]*goNext\(\)/);
  assert.match(funnel, /NUNCA vuelve a ejecutar purchase\(\)/);
  assert.doesNotMatch(funnel, /link \+= `&email=/);
  assert.ok(funnel.indexOf('if (identity.alreadyPro)') < funnel.indexOf('svc.purchase('));
}

async function main() {
  const cases = [
    ['identity without OTP', testIdentityWithoutOtp],
    ['alreadyPro propagation', testAlreadyProIsReturned],
    ['missing identity blocks checkout', testMissingIdentityBlocksCheckout],
    ['RevenueCat UUID and stale identity', testRevenueCatUsesVerifiedUuidAndRejectsStaleIdentity],
    ['no OTP, credentials, and redemption contract', testNoOtpCredentialsOrRedemptionContract],
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
