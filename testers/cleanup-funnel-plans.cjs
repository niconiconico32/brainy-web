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
//   TEST_EMAILS                 emails de test (el funnel crea con source=website)
//                               default: sb+checkout@brainyadhd.com
//   EMAIL_LIKE                  patrón LIKE (PostgREST) para emails únicos del
//                               checkout sandbox (sb+checkout-<stamp>@...)
//                               default: sb%2Bcheckout-%25%40brainyadhd.com
//   INCLUDE_LEGACY=1            también borra la fila de test de `funnel_plans` legacy
//   KEEP_PLAN_ID                planId a CONSERVAR (no se borra) — útil para no
//                               limpiar la fila de la compra sandbox real del E2E móvil
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
const TEST_EMAILS = (process.env.TEST_EMAILS || 'sb+checkout@brainyadhd.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const EMAIL_LIKE = process.env.EMAIL_LIKE || 'sb%2Bcheckout-%25%40brainyadhd.com';
const KEEP_PLAN_ID = (process.env.KEEP_PLAN_ID || '').trim().toLowerCase();
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

  if (TEST_EMAILS.length) {
    const emailList = TEST_EMAILS.map((e) => '"' + encodeURIComponent(e) + '"').join(',');
    console.log('Emails de test: ' + TEST_EMAILS.join(', '));
    const filter = `web_funnel_plans?email=in.(${emailList})&select=id,status,source`;
    const found = await rest(filter);
    const rows = Array.isArray(found) ? found : [];
    console.log('Filas con email de test: ' + rows.length);
    if (!DRY_RUN && rows.length > 0) {
      const deleted = await rest(filter, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
      const del = Array.isArray(deleted) ? deleted : [];
      console.log('Borradas por email: ' + del.length);
      for (const r of del) console.log('  - ' + r.id + ' [' + r.source + '] ' + r.status);
    }
  }

  // emails únicos del checkout sandbox (sb+checkout-<stamp>@...)
  console.log('Email LIKE (sandbox): ' + decodeURIComponent(EMAIL_LIKE));
  const likeList = `web_funnel_plans?email=like.${EMAIL_LIKE}&select=id,status,source&order=created_at.desc`;
  const likeAll = await rest(likeList);
  const likeRows = Array.isArray(likeAll) ? likeAll : [];
  let likeFilter = `web_funnel_plans?email=like.${EMAIL_LIKE}&select=id,status,source`;
  if (KEEP_PLAN_ID) {
    likeFilter += `&id=neq.${KEEP_PLAN_ID}`;
    console.log('Filas sandbox (email único): ' + likeRows.length + ' · CONSERVA planId ' + KEEP_PLAN_ID);
  } else if (likeRows.length > 1) {
    const kept = likeRows[0].id;
    likeFilter += `&id=neq.${kept}`;
    console.log('Filas sandbox (email único): ' + likeRows.length + ' · CONSERVA la más reciente: ' + kept + ' [' + (likeRows[0].status || '') + '] · KEEP_PLAN_ID para elegir otra');
  } else {
    console.log('Filas sandbox (email único): ' + likeRows.length);
  }
  if (!DRY_RUN && likeRows.length > 0) {
    const deleted = await rest(likeFilter, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    });
    const del = Array.isArray(deleted) ? deleted : [];
    console.log('Borradas por LIKE: ' + del.length);
    for (const r of del) console.log('  - ' + r.id + ' [' + r.source + '] ' + r.status);
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
