const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const PLAN_ID = '11111111-1111-4111-8111-111111111111';

function loadService() {
  let purchaseParams;
  const sdkInstance = {
    getAppUserId: () => '22222222-2222-4222-8222-222222222222',
    getCustomerInfo: async () => ({ entitlements: { active: {} } }),
    getOfferings: async () => ({}),
    purchase: async (params) => {
      purchaseParams = params;
      return { customerInfo: { entitlements: { active: {} } }, redemptionInfo: null };
    },
  };
  const context = {
    window: {
      Purchases: {
        Purchases: {
          configure: () => sdkInstance,
          setLogLevel: () => {},
        },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../assets/revenuecat.js'), 'utf8'), context);
  const service = context.window.BrainyRevenueCat;
  service.configure({ apiKey: 'strp_sb_public', appUserId: sdkInstance.getAppUserId() });
  return { service, getPurchaseParams: () => purchaseParams };
}

async function testMetadataForwarding() {
  const { service, getPurchaseParams } = loadService();
  await service.purchase({ rcPackage: { identifier: 'annual' }, planId: PLAN_ID, customerEmail: 'not-metadata@example.com' });
  assert.equal(getPurchaseParams().metadata.brainy_plan_id, PLAN_ID);
  assert.equal(Object.keys(getPurchaseParams().metadata).length, 1);
  assert.equal(Object.hasOwn(getPurchaseParams().metadata, 'claimToken'), false);
  assert.equal(Object.hasOwn(getPurchaseParams().metadata, 'email'), false);
}

async function testMissingPlanDoesNotCallSdk() {
  const { service, getPurchaseParams } = loadService();
  await assert.rejects(
    service.purchase({ rcPackage: { identifier: 'annual' } }),
    /purchase_requires_real_plan_id/,
  );
  assert.equal(getPurchaseParams(), undefined);
}

function testAlreadyProAndRecoveryGuards() {
  const funnel = fs.readFileSync(require.resolve('../funnel.html'), 'utf8');
  const alreadyProIndex = funnel.indexOf('if (identity.alreadyPro)');
  const purchaseIndex = funnel.indexOf('svc.purchase(');
  const recoveryStart = funnel.indexOf('async function retryPendingRedemption');
  const recoveryEnd = funnel.indexOf('\n        }', recoveryStart);
  assert.ok(alreadyProIndex >= 0 && alreadyProIndex < purchaseIndex);
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  assert.equal(funnel.slice(recoveryStart, recoveryEnd).includes('purchase('), false);
  assert.match(funnel, /planId: funnelState\.planId/);
}

function testLoadedSdkSupportsMetadata() {
  const sdk = fs.readFileSync(require.resolve('../assets/revenuecat-sdk.js'), 'utf8');
  assert.match(sdk, /const Og="1\.60\.1"/);
  assert.match(sdk, /async purchase\(e\)/);
  assert.match(sdk, /metadata:e\.metadata/);
}

async function main() {
  const cases = [
    ['metadata forwarding', testMetadataForwarding],
    ['missing plan blocks SDK purchase', testMissingPlanDoesNotCallSdk],
    ['alreadyPro and recovery guards', testAlreadyProAndRecoveryGuards],
    ['loaded SDK metadata support', testLoadedSdkSupportsMetadata],
  ];
  let passed = 0;
  for (const [name, run] of cases) {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  }
  console.log(`RevenueCat metadata regression: ${passed}/${cases.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
