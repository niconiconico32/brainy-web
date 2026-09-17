// Limpieza de filas de test en `public.web_funnel_plans`.
//
// Borra las filas creadas por los testers/handoff manual, identificadas por
// `source`. NUNCA toca planes reales de usuarios (otros source).
//
// Requiere (env, no lo imprimas en el comando):
//   SUPABASE_SERVICE_ROLE_KEY   service role (bypassa RLS)
// Opcionales:
//   SUPABASE_URL                default: https://auth.brainyadhd.com
//   TEST_SOURCES                lista separada por comas
//                               default: e2e-create-plan-regression,manual-claim-test
//   INCLUDE_LEGACY=1            también borra la fila de test de `funnel_plans` legacy
//   DRY_RUN=1                   solo lista, no borra
//
// Uso seguro (la key no queda en el historial):
//   read -s SUPABASE_SERVICE_ROLE_KEY; export SUPABASE_SERVICE_ROLE_KEY; npm run cleanup:funnel-plans

'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://auth.brainyadhd.com';
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TEST_SOURCES = (process.env.TEST_SOURCES ||
  'e2e-create-plan-regression,manual-claim-test')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const INCLUDE_LEGACY = process.env.INCLUDE_LEGACY === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const LEGACY_TEST_EMAIL = process.env.LEGACY_TEST_EMAIL || 'e2e+create-plan@brainyadhd.com';

if (!SERVICE_ROLE) {
  console.error(
    'Falta SUPABASE_SERVICE_ROLE_KEY. Corré:\n' +
      '  read -s SUPABASE_SERVICE_ROLE_KEY; export SUPABASE_SERVICE_ROLE_KEY; npm run cleanup:funnel-plans'
  );
  process.exit(2);
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
  if (!res.ok) throw new Error('rest_' + (opts.method || 'GET') + '_' + res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function countBySource(inList) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/web_funnel_plans?source=in.(${inList})&select=id`,
    {
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    }
  );
  if (!res.ok) throw new Error('rest_count_' + res.status);
  const total = (res.headers.get('content-range') || '').split('/')[1];
  return total && total !== '*' ? parseInt(total, 10) : null;
}

(async () => {
  const inList = TEST_SOURCES.map((s) => `"${s}"`).join(',');
  console.log('Fuentes de test: ' + TEST_SOURCES.join(', '));
  console.log('Modo: ' + (DRY_RUN ? 'DRY_RUN (no borra)' : 'DELETE'));

  const before = await countBySource(inList);
  console.log('Filas de test en web_funnel_plans: ' + before);

  if (!DRY_RUN) {
    const deleted = await rest(
      `web_funnel_plans?source=in.(${inList})&select=id,status,source`,
      { method: 'DELETE', headers: { Prefer: 'return=representation' } }
    );
    const rows = Array.isArray(deleted) ? deleted : [];
    console.log('Borradas: ' + rows.length);
    for (const r of rows) console.log('  - ' + r.id + ' [' + r.source + '] ' + r.status);
  }

  if (INCLUDE_LEGACY) {
    const found = await rest(
      `funnel_plans?email=eq.${encodeURIComponent(LEGACY_TEST_EMAIL)}&select=id`
    );
    const n = Array.isArray(found) ? found.length : 0;
    console.log('Legacy funnel_plans con email de test: ' + n);
    if (!DRY_RUN && n > 0) {
      await rest(`funnel_plans?email=eq.${encodeURIComponent(LEGACY_TEST_EMAIL)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      });
      console.log('Legacy borrado: ' + n);
    }
  }

  const after = await countBySource(inList);
  console.log('Filas de test restantes: ' + after);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
