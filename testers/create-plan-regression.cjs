// Regresión backend de `create-funnel-plan` contra la tabla canónica
// `public.web_funnel_plans`.
//
// Cubre los escenarios A–D, X y H (los E/F/G son de front y viven en
// `testers/e2e-regression.cjs`):
//   A  creación nueva            -> fila pending, hash correcto, sin plaintext
//   B  retry pending             -> mismo planId, NUEVO token, hash reemplazado
//   C  status claiming           -> 409 plan_already_claiming, fila intacta
//   D  status claimed            -> 409 plan_already_claimed, fila intacta
//   X  client_plan_key inválido  -> 400 invalid_client_plan_key
//   Z  plan pending de handoff   -> se deja UNO para probar el claim desde la app
//   H  aislamiento de tabla      -> la web no toca `funnel_plans` legacy
//
// La verificación de DB usa una de dos vías (en este orden):
//   1) SUPABASE_SERVICE_ROLE_KEY -> PostgREST (más estable)
//   2) SUPABASE_ACCESS_TOKEN     -> Management API database/query
//
// Prerequisitos (env):
//   SUPABASE_ANON_KEY            anon key (JWT válido para verify_jwt)
//   SUPABASE_SERVICE_ROLE_KEY    service role (verificación REST)  [o]
//   SUPABASE_ACCESS_TOKEN        personal access token (verificación SQL)
//   SUPABASE_PROJECT_REF         default: wdwqwgfisiteswbbdurg
//   SUPABASE_URL                 default: https://auth.brainyadhd.com
//   CREATE_PLAN_URL              default: <SUPABASE_URL>/functions/v1/create-funnel-plan
//   CLEANUP_ALL=1                no deja el plan pending de handoff
//
// Run (REST):
//   SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm run test:e2e:create-plan
// Run (SQL):
//   SUPABASE_ANON_KEY=... SUPABASE_ACCESS_TOKEN=... npm run test:e2e:create-plan
//
// Seguridad: nunca se imprimen tokens, hashes ni emails (maskText).

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REF = process.env.SUPABASE_PROJECT_REF || 'wdqwqgfisiteswbbdurg';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://auth.brainyadhd.com';
const CREATE_URL =
  process.env.CREATE_PLAN_URL || `${SUPABASE_URL}/functions/v1/create-funnel-plan`;
// Fallback: usa la anon key real embebida en funnel.html si no hay env.
function loadAnonFromHtml() {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'funnel.html'), 'utf8');
    const m = html.match(/anonKey:\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

const ANON_KEY = process.env.SUPABASE_ANON_KEY || loadAnonFromHtml();
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MGMT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';

// Diagnóstico seguro de la anon key (sin exponerla): ref/rol del JWT.
function jwtPayload(key) {
  try {
    return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
}

function describeAnon(key) {
  const p = jwtPayload(key);
  if (!p) return key.startsWith('sb_publishable_') ? 'publishable key' : 'formato no-JWT';
  return `ref=${p.ref} role=${p.role} exp=${new Date(p.exp * 1000).toISOString().slice(0, 10)}`;
}

// Ref autoritativa: la del service role si está; si no, SUPABASE_PROJECT_REF.
const EXPECTED_REF = (jwtPayload(SERVICE_ROLE) || {}).ref || REF;

const ARTIFACTS = path.join(__dirname, '.e2e-artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

const TEST_SOURCE = 'e2e-create-plan-regression';
const TEST_EMAIL = 'e2e+create-plan@brainyadhd.com';
const SELECT_COLS =
  'id,version,status,claim_token_hash,claimed_by_user_id,claimed_at,revenuecat_redemption_url,client_plan_key,email,expires_at,plan';

const PLAN = {
  version: 1,
  answers: {},
  tasks: [],
  routines: [],
  metadata: {
    source: 'website',
    campaign: TEST_SOURCE,
    locale: 'es-AR',
    tasksCount: 0,
    routinesCount: 0,
    totalSelectedCount: 0,
  },
};

function maskText(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '[email redacted]')
    .replace(/[a-f0-9]{64}/gi, '[hash/token redacted]')
    .replace(/eyJ[A-Za-z0-9_.\-]+(\.[A-Za-z0-9_.\-]+)+/g, '[jwt redacted]')
    .replace(/\b(sbp_|rk_|sk_|strp_)[A-Za-z0-9_]{8,}/g, '[key redacted]');
}

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok });
  console.log(
    (ok ? 'PASS' : 'FAIL') +
      ' ' +
      name +
      (ok ? '' : ' :: ' + String(maskText(detail) || '').slice(0, 400))
  );
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function isUuid(v) {
  return (
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

const DB_MODE = SERVICE_ROLE ? 'rest' : MGMT_TOKEN ? 'sql' : null;

async function mgmtSql(query) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MGMT_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'supabase-cli/2.75.0',
      },
      body: JSON.stringify({ query }),
    }
  );
  if (!res.ok) throw new Error('mgmt_sql_http_' + res.status);
  const data = await res.json();
  if (data && data.message) throw new Error('mgmt_sql: ' + data.message);
  return data;
}

async function rest(pathname, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (opts.raw) {
    if (!res.ok) throw new Error('rest_' + (opts.method || 'GET') + '_' + res.status);
    return res;
  }
  if (!res.ok) throw new Error('rest_' + (opts.method || 'GET') + '_' + res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function dbGetRow(key) {
  if (DB_MODE === 'rest') {
    const rows = await rest(
      `web_funnel_plans?client_plan_key=eq.${key}&select=${SELECT_COLS}`
    );
    return Array.isArray(rows) ? rows[0] || null : null;
  }
  const rows = await mgmtSql(
    `select ${SELECT_COLS} from public.web_funnel_plans where client_plan_key = '${key}'`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function dbSetStatus(key, status, setClaimedAt) {
  if (DB_MODE === 'rest') {
    const patch = { status };
    if (setClaimedAt) patch.claimed_at = new Date().toISOString();
    await rest(`web_funnel_plans?client_plan_key=eq.${key}`, {
      method: 'PATCH',
      body: patch,
      headers: { Prefer: 'return=minimal' },
    });
    return;
  }
  const extra = setClaimedAt ? ', claimed_at = now()' : '';
  await mgmtSql(
    `update public.web_funnel_plans set status = '${status}'${extra} where client_plan_key = '${key}'`
  );
}

async function dbDeleteTestRows(keepKey) {
  if (DB_MODE === 'rest') {
    let q = `web_funnel_plans?source=eq.${encodeURIComponent(TEST_SOURCE)}`;
    if (keepKey) q += `&client_plan_key=neq.${keepKey}`;
    await rest(q, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return;
  }
  const keep = keepKey ? ` and client_plan_key <> '${keepKey}'` : '';
  await mgmtSql(
    `delete from public.web_funnel_plans where source = '${TEST_SOURCE}'${keep}`
  );
}

async function legacyCount() {
  if (DB_MODE === 'rest') {
    const res = await rest('funnel_plans?select=id&limit=1', {
      raw: true,
      headers: { Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = res.headers.get('content-range') || '';
    const total = cr.split('/')[1];
    if (total && total !== '*') return parseInt(total, 10);
    const text = await res.text();
    const arr = text ? JSON.parse(text) : [];
    return Array.isArray(arr) ? arr.length : 0;
  }
  const rows = await mgmtSql('select count(*)::int as n from public.funnel_plans');
  return Array.isArray(rows) && rows[0] ? rows[0].n : null;
}

async function legacyHasEmail(email) {
  if (DB_MODE === 'rest') {
    const rows = await rest(
      `funnel_plans?email=eq.${encodeURIComponent(email)}&select=id&limit=1`
    );
    return Array.isArray(rows) && rows.length > 0;
  }
  const rows = await mgmtSql(
    `select id from public.funnel_plans where email = '${email}' limit 1`
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function createPlan(body) {
  const headers = { 'Content-Type': 'application/json' };
  if (ANON_KEY) {
    headers.apikey = ANON_KEY;
    headers.Authorization = `Bearer ${ANON_KEY}`;
  }
  const res = await fetch(CREATE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

const KEY = (extra) => ({ plan: PLAN, email: TEST_EMAIL, source: TEST_SOURCE, campaign: TEST_SOURCE, ...extra });

(async () => {
  if (!ANON_KEY || !DB_MODE) {
    console.error(
      'Faltan credenciales: anon key (funnel.html o SUPABASE_ANON_KEY) y (SUPABASE_SERVICE_ROLE_KEY o SUPABASE_ACCESS_TOKEN).'
    );
    process.exit(2);
  }
  console.log('DB verification mode: ' + DB_MODE);
  console.log(
    'anon key [' +
      (process.env.SUPABASE_ANON_KEY ? 'env' : 'funnel.html') +
      '] ' +
      describeAnon(ANON_KEY)
  );
  const anonPayload = jwtPayload(ANON_KEY);
  if (anonPayload && anonPayload.ref !== EXPECTED_REF) {
    console.warn(
      'ADVERTENCIA: anon key ref=' + anonPayload.ref + ' != project esperado ' + EXPECTED_REF
    );
  }

  let legacyBefore = null;
  try {
    legacyBefore = await legacyCount();
  } catch (e) {
    rec('H baseline legacy', false, e.message);
  }
  const legacyHadTestRow = await legacyHasEmail(TEST_EMAIL).catch(() => false);

  const keyA = crypto.randomUUID();
  let planIdA = null;
  let tokenA = null;
  let tokenB = null;

  // A) creación nueva
  try {
    const r = await createPlan(KEY({ client_plan_key: keyA }));
    const row = await dbGetRow(keyA);
    const checks = {
      http200: r.status === 200,
      planIdUuid: isUuid((r.data || {}).planId),
      token64: /^[a-f0-9]{64}$/.test((r.data || {}).claimToken || ''),
      rowExists: !!row,
      statusPending: !!row && row.status === 'pending',
      version1: !!row && row.version === 1,
      hashMatches: !!row && !!r.data && row.claim_token_hash === sha256Hex(r.data.claimToken),
      noPlaintextCol: !!row && !('claim_token' in row),
      hashNotPlaintext: !!row && !!r.data && row.claim_token_hash !== r.data.claimToken,
      noOwner: !!row && row.claimed_by_user_id === null,
      noClaimedAt: !!row && row.claimed_at === null,
      noRcUrl: !!row && row.revenuecat_redemption_url === null,
      emailStored: !!row && row.email === TEST_EMAIL,
      planObject: !!row && row.plan && typeof row.plan === 'object' && !Array.isArray(row.plan),
      expiresFuture: !!row && !!row.expires_at && new Date(row.expires_at).getTime() > Date.now(),
      keyStored: !!row && String(row.client_plan_key).toLowerCase() === keyA.toLowerCase(),
    };
    planIdA = (r.data || {}).planId || null;
    tokenA = (r.data || {}).claimToken || null;
    const ok = Object.values(checks).every(Boolean);
    rec('A creación nueva -> pending sin plaintext', ok, JSON.stringify({ status: r.status, error: (r.data || {}).error, checks }));
  } catch (e) {
    rec('A creación nueva -> pending sin plaintext', false, e.message);
  }

  // B) retry pending -> mismo planId, nuevo token
  try {
    const r = await createPlan(KEY({ client_plan_key: keyA }));
    tokenB = (r.data || {}).claimToken || null;
    const row = await dbGetRow(keyA);
    const checks = {
      http200: r.status === 200,
      samePlanId: !!planIdA && (r.data || {}).planId === planIdA,
      newToken: !!tokenA && !!tokenB && tokenB !== tokenA,
      hashReplaced: !!row && row.claim_token_hash === sha256Hex(tokenB),
      oldHashInvalidated: !!row && row.claim_token_hash !== sha256Hex(tokenA),
      stillPending: !!row && row.status === 'pending',
    };
    const ok = Object.values(checks).every(Boolean);
    rec('B retry pending -> nuevo token', ok, JSON.stringify({ status: r.status, checks }));
  } catch (e) {
    rec('B retry pending -> nuevo token', false, e.message);
  }

  // C) claiming -> 409, fila intacta
  try {
    await dbSetStatus(keyA, 'claiming', false);
    const before = await dbGetRow(keyA);
    const r = await createPlan(KEY({ client_plan_key: keyA }));
    const after = await dbGetRow(keyA);
    const checks = {
      http409: r.status === 409,
      errorCode: (r.data || {}).error === 'plan_already_claiming',
      statusIntact: !!before && !!after && before.status === 'claiming' && after.status === 'claiming',
      hashIntact: !!before && !!after && before.claim_token_hash === after.claim_token_hash,
    };
    const ok = Object.values(checks).every(Boolean);
    rec('C claiming -> 409 plan_already_claiming', ok, JSON.stringify({ status: r.status, error: (r.data || {}).error, checks }));
  } catch (e) {
    rec('C claiming -> 409 plan_already_claiming', false, e.message);
  }

  // D) claimed -> 409, fila intacta
  try {
    await dbSetStatus(keyA, 'claimed', true);
    const before = await dbGetRow(keyA);
    const r = await createPlan(KEY({ client_plan_key: keyA }));
    const after = await dbGetRow(keyA);
    const checks = {
      http409: r.status === 409,
      errorCode: (r.data || {}).error === 'plan_already_claimed',
      statusIntact: !!before && !!after && before.status === 'claimed' && after.status === 'claimed',
      hashIntact: !!before && !!after && before.claim_token_hash === after.claim_token_hash,
    };
    const ok = Object.values(checks).every(Boolean);
    rec('D claimed -> 409 plan_already_claimed', ok, JSON.stringify({ status: r.status, error: (r.data || {}).error, checks }));
  } catch (e) {
    rec('D claimed -> 409 plan_already_claimed', false, e.message);
  }

  // X) client_plan_key inválido -> 400
  try {
    const r = await createPlan(KEY({ client_plan_key: 'not-a-uuid' }));
    const ok = r.status === 400 && (r.data || {}).error === 'invalid_client_plan_key';
    rec('X client_plan_key inválido -> 400', ok, JSON.stringify({ status: r.status, error: (r.data || {}).error }));
  } catch (e) {
    rec('X client_plan_key inválido -> 400', false, e.message);
  }

  // H) no se tocó la tabla legacy
  try {
    const legacyAfter = await legacyCount();
    const legacyRowAfter = await legacyHasEmail(TEST_EMAIL);
    const checks = {
      countUnchanged: legacyAfter === legacyBefore,
      stillNoTestRow: legacyHadTestRow || !legacyRowAfter,
      testRowInCanonical: !!(await dbGetRow(keyA)),
    };
    const ok = Object.values(checks).every(Boolean);
    rec('H solo web_funnel_plans (legacy intacto)', ok, JSON.stringify(checks));
  } catch (e) {
    rec('H solo web_funnel_plans (legacy intacto)', false, e.message);
  }

  // Z) dejar UN plan pending real para coordinar con la app (sin secretos).
  let handoff = null;
  try {
    const keyZ = crypto.randomUUID();
    const r = await createPlan(KEY({ client_plan_key: keyZ }));
    const row = await dbGetRow(keyZ);
    const ok = r.status === 200 && !!row && row.status === 'pending' && row.claimed_by_user_id === null;
    handoff = {
      planId: (r.data || {}).planId || null,
      clientPlanKey: keyZ,
      kept: ok && process.env.CLEANUP_ALL !== '1',
    };
    rec('Z plan pending para handoff app', ok, 'planId=' + (handoff.planId || 'n/a'));
  } catch (e) {
    rec('Z plan pending para handoff app', false, e.message);
  }

  // Cleanup: se conserva SOLO el plan Z (salvo CLEANUP_ALL=1).
  try {
    await dbDeleteTestRows(handoff && handoff.kept ? handoff.clientPlanKey : null);
  } catch (e) {
    console.error('cleanup falló:', maskText(e.message));
  }

  if (handoff && handoff.kept) {
    console.log('\nHANDOFF planId (sin secretos): ' + handoff.planId);
    console.log('client_plan_key: ' + handoff.clientPlanKey);
  }

  const fails = results.filter((r) => !r.ok);
  console.log('\nRESUMEN: ' + (results.length - fails.length) + '/' + results.length + ' ok');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', maskText(e.message));
  process.exit(2);
});
