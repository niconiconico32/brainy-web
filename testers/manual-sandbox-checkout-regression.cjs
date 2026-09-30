const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const runner = fs.readFileSync(require.resolve('./manual-sandbox-checkout.cjs'), 'utf8');

function testContract() {
  assert.match(runner, /headless:\s*false/);
  assert.match(runner, /context\.addInitScript/);
  assert.match(runner, /https:\/\/brainyadhd\.com\/funnel\.html\?reset/);
  assert.match(runner, /process\.env\.FUNNEL_RC_KEY/);
  assert.match(runner, /process\.env\.FUNNEL_TEST_EMAIL/);
  assert.doesNotMatch(runner, /FUNNEL_RC_KEY\s*\|\|/);
  assert.doesNotMatch(runner, /4242|cardNumber|cvc|cvv|purchase\s*\(/);
  assert.match(runner, /calls\.purchase\s*\+=\s*1/);
  assert.match(runner, /manual_sandbox_duplicate_purchase_blocked/);
  assert.match(runner, /metadataKeys/);
  assert.match(runner, /No se ejecutó ninguna compra/);
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
