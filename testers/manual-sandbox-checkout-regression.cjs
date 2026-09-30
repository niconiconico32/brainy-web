const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const {
  LOCK_PATH,
  acquireLock,
  installBrowserInstrumentation,
  installPreflightClickGuard,
  instrumentSdkInstance,
} = require('./manual-sandbox-checkout.cjs');

const runner = fs.readFileSync(require.resolve('./manual-sandbox-checkout.cjs'), 'utf8');
const PLAN_ID = '11111111-1111-4111-8111-111111111111';

function testContract() {
  assert.match(runner, /headless:\s*false/);
  assert.match(runner, /context\.addInitScript/);
  assert.match(runner, /https:\/\/brainyadhd\.com\/funnel\.html\?reset/);
  assert.match(runner, /process\.env\.FUNNEL_RC_KEY/);
  assert.match(runner, /process\.env\.FUNNEL_TEST_EMAIL/);
  assert.doesNotMatch(runner, /FUNNEL_RC_KEY\s*\|\|/);
  assert.doesNotMatch(runner, /4242|cardNumber|cvc|cvv|purchase\s*\(/);
  assert.doesNotMatch(runner, /strp_sb_[A-Za-z0-9]{20,}/);
  assert.match(runner, /calls\.brainyPurchaseCalls\s*\+=\s*1/);
  assert.match(runner, /calls\.sdkPurchaseCalls\s*\+=\s*1/);
  assert.match(runner, /manual_sandbox_duplicate_sdk_purchase_blocked/);
  assert.match(runner, /sdkMetadataExact/);
  assert.doesNotMatch(runner, /metadataKeys:\s*\[['"]brainy_plan_id['"]\]/);
  assert.match(runner, /waitForManualCompletion/);
  assert.match(runner, /purchaseCompleted/);
  assert.match(runner, /sdkPurchaseCalls > 0[\s\S]*purchaseCompleted/);
}

function findDeadPid() {
  let pid = process.pid + 100000;
  while (pid < 2147480000) {
    try {
      process.kill(pid, 0);
      pid += 1;
    } catch (error) {
      if (error.code === 'ESRCH') return pid;
      pid += 1;
    }
  }
  throw new Error('could not find a dead pid for lock test');
}

function testLockBehavior() {
  fs.rmSync(LOCK_PATH, { force: true });
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  assert.throws(() => acquireLock(), /another manual sandbox runner is already active/);
  assert.equal(fs.readFileSync(LOCK_PATH, 'utf8'), String(process.pid));
  fs.rmSync(LOCK_PATH, { force: true });

  fs.writeFileSync(LOCK_PATH, String(findDeadPid()));
  const release = acquireLock();
  assert.equal(fs.readFileSync(LOCK_PATH, 'utf8'), String(process.pid));
  release();
  assert.equal(fs.existsSync(LOCK_PATH), false);
}

async function testClickGuardBehavior() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="purchaseBtn">purchase</button>');
    await page.evaluate(() => { window.__MANUAL_SANDBOX__ = { preflightPassed: false }; });
    await page.evaluate(installPreflightClickGuard);
    const blocked = await page.evaluate(() => {
      let clicks = 0;
      document.getElementById('purchaseBtn').addEventListener('click', () => { clicks += 1; });
      document.getElementById('purchaseBtn').click();
      return { clicks, blocked: window.__MANUAL_SANDBOX__.preflightBlockedClicks };
    });
    assert.deepEqual(blocked, { clicks: 0, blocked: 1 });
    const allowed = await page.evaluate(() => {
      window.__MANUAL_SANDBOX__.preflightPassed = true;
      let clicks = 0;
      document.getElementById('purchaseBtn').addEventListener('click', () => { clicks += 1; });
      document.getElementById('purchaseBtn').click();
      return clicks;
    });
    assert.equal(allowed, 1);
  } finally {
    await browser.close();
  }
}

async function testSdkWrapperBehavior() {
  const previousStorage = global.localStorage;
  global.localStorage = { getItem: () => JSON.stringify({ planId: PLAN_ID }) };
  try {
    const calls = {
      sdkPurchaseCalls: 0,
      sdkGetOfferingsCalls: 0,
      sdkMetadataKeys: null,
      sdkPlanIdIsUuid: false,
      sdkPlanMatchesState: false,
      sdkMetadataExact: false,
      events: [],
    };
    const expectedThis = { marker: true };
    let receivedThis;
    const instance = {
      getOfferings: function () { return 'offerings'; },
      purchase: function (params) {
        receivedThis = this;
        return Promise.resolve(params.result);
      },
    };
    instrumentSdkInstance(instance, calls);
    const result = await instance.purchase.call(expectedThis, {
      metadata: { brainy_plan_id: PLAN_ID },
      result: 'preserved-result',
    });
    assert.equal(result, 'preserved-result');
    assert.equal(receivedThis, expectedThis);
    assert.deepEqual(calls.sdkMetadataKeys, ['brainy_plan_id']);
    assert.equal(calls.sdkPlanIdIsUuid, true);
    assert.equal(calls.sdkPlanMatchesState, true);
    assert.equal(calls.sdkMetadataExact, true);

    const extraCalls = { ...calls, sdkPurchaseCalls: 0, events: [] };
    const extraInstance = { getOfferings() {}, purchase: instance.purchase.bind(null) };
    // Use a fresh original to test metadata validation, not a second call on the first instance.
    extraInstance.purchase = function () { return Promise.resolve('extra'); };
    instrumentSdkInstance(extraInstance, extraCalls);
    await extraInstance.purchase({ metadata: { brainy_plan_id: PLAN_ID, extra: 'x' } });
    assert.equal(extraCalls.sdkMetadataExact, false);

    const mismatchCalls = { ...calls, sdkPurchaseCalls: 0, events: [] };
    const mismatchInstance = { getOfferings() {}, purchase: function () { return Promise.resolve('mismatch'); } };
    instrumentSdkInstance(mismatchInstance, mismatchCalls);
    await mismatchInstance.purchase({ metadata: { brainy_plan_id: '22222222-2222-4222-8222-222222222222' } });
    assert.equal(mismatchCalls.sdkPlanIdIsUuid, true);
    assert.equal(mismatchCalls.sdkPlanMatchesState, false);
    assert.equal(mismatchCalls.sdkMetadataExact, false);

    await assert.rejects(instance.purchase({ metadata: { brainy_plan_id: PLAN_ID } }), /duplicate_sdk_purchase_blocked/);
    assert.equal(calls.sdkPurchaseCalls, 2);

    const rejectionCalls = { ...calls, sdkPurchaseCalls: 0, events: [] };
    const rejectionInstance = { getOfferings() {}, purchase: function () { return Promise.reject(new Error('original-rejection')); } };
    instrumentSdkInstance(rejectionInstance, rejectionCalls);
    await assert.rejects(rejectionInstance.purchase({ metadata: { brainy_plan_id: PLAN_ID } }), /original-rejection/);
    assert.equal(rejectionCalls.sdkPurchaseCalls, 1);
  } finally {
    if (previousStorage === undefined) delete global.localStorage;
    else global.localStorage = previousStorage;
  }
}

async function testBrowserSdkBoundaryInstrumentation() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await installBrowserInstrumentation(context, 'strp_sb_test_public_key');
    const page = await context.newPage();
    await page.setContent('<p>SDK boundary test</p>');
    const result = await page.evaluate(async (planId) => {
      window.__MANUAL_SANDBOX_PLAN_ID__ = planId;
      window.Purchases = {
        Purchases: {
          configure: function () {
            return {
              getOfferings: function () { return Promise.resolve({}); },
              purchase: function (params) { return Promise.resolve({ params, thisValue: this }); },
            };
          },
        },
      };
      const instance = window.Purchases.Purchases.configure({ appUserId: '22222222-2222-4222-8222-222222222222' });
      const purchaseResult = await instance.purchase({ metadata: { brainy_plan_id: planId } });
      return {
        sdkCalls: window.__MANUAL_SANDBOX__.sdkPurchaseCalls,
        keys: window.__MANUAL_SANDBOX__.sdkMetadataKeys,
        exact: window.__MANUAL_SANDBOX__.sdkMetadataExact,
        sameParams: purchaseResult.params.metadata.brainy_plan_id === planId,
      };
    }, PLAN_ID);
    assert.deepEqual(result, {
      sdkCalls: 1,
      keys: ['brainy_plan_id'],
      exact: true,
      sameParams: true,
    });
  } finally {
    await browser.close();
  }
}

function testMissingEnvironment() {
  const result = spawnSync(process.execPath, [require.resolve('./manual-sandbox-checkout.cjs')], {
    env: { ...process.env, FUNNEL_RC_KEY: '', FUNNEL_TEST_EMAIL: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FUNNEL_RC_KEY is required/);
  assert.doesNotMatch(result.stdout + result.stderr, /strp_sb_|@/);
}

async function main() {
  const cases = [
    ['runner contract', testContract],
    ['live lock behavior', testLockBehavior],
    ['preflight click guard behavior', testClickGuardBehavior],
    ['SDK wrapper preserves behavior and metadata checks', testSdkWrapperBehavior],
    ['browser SDK boundary instrumentation', testBrowserSdkBoundaryInstrumentation],
    ['missing environment fails safely', testMissingEnvironment],
  ];
  let passed = 0;
  for (const [name, run] of cases) {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  }
  console.log(`manual sandbox runner regression: ${passed}/${cases.length} passed`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
