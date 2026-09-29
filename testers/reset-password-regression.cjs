const assert = require('node:assert/strict');
const recovery = require('../assets/reset-password.js');

const ACCESS = 'access-token-test';
const REFRESH = 'refresh-token-test';

function testParsing() {
  const parsed = recovery.parseRecoveryFragment(`#access_token=${ACCESS}&refresh_token=${REFRESH}&type=recovery`);
  assert.deepEqual(parsed, {
    ok: true,
    state: 'parsed',
    accessToken: ACCESS,
    refreshToken: REFRESH,
  });
  assert.equal(recovery.parseRecoveryFragment('#type=magiclink&access_token=a&refresh_token=b').ok, false);
  assert.equal(recovery.parseRecoveryFragment('#type=recovery&access_token=a').error, 'missing_recovery_tokens');
}

async function testSessionAndFragmentCleanup() {
  let session;
  let cleanedUrl;
  const client = {
    auth: {
      setSession: async (value) => {
        session = value;
        return { data: {}, error: null };
      },
    },
  };
  const result = await recovery.establishRecoverySession(
    client,
    `#access_token=${ACCESS}&refresh_token=${REFRESH}&type=recovery`,
    { replaceState: (_state, _title, url) => { cleanedUrl = url; } },
    { pathname: '/reset-password/', search: '' },
  );
  assert.deepEqual(session, { access_token: ACCESS, refresh_token: REFRESH });
  assert.deepEqual(result, { ok: true, state: 'ready' });
  assert.equal(cleanedUrl, '/reset-password/');
}

async function testPasswordStates() {
  let updated;
  let signedOut = false;
  const client = {
    auth: {
      updateUser: async (value) => { updated = value; return { data: {}, error: null }; },
      signOut: async (value) => { signedOut = value; return { error: null }; },
    },
  };
  assert.equal((await recovery.updatePassword(client, 'short', 'short')).error, 'password_too_short');
  assert.equal((await recovery.updatePassword(client, 'long-password', 'different-password')).error, 'password_mismatch');
  assert.deepEqual(await recovery.updatePassword(client, 'long-password', 'long-password'), { ok: true, state: 'complete' });
  assert.deepEqual(updated, { password: 'long-password' });
  assert.deepEqual(signedOut, { scope: 'local' });
}

async function main() {
  const cases = [
    ['fragment parsing', testParsing],
    ['session establishment and cleanup', testSessionAndFragmentCleanup],
    ['password states and local sign-out', testPasswordStates],
  ];
  let passed = 0;
  for (const [name, run] of cases) {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  }
  console.log(`reset-password regression: ${passed}/${cases.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
