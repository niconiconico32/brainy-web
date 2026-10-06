/* Regresion de /manage-subscription/ — redireccion directa al Stripe Customer Portal.
 *
 * En esta pagina NO debe quedar nada del antiguo login de Brainy:
 * sin formulario de email, sin password, sin Supabase, sin RevenueCat,
 * sin CustomerInfo, sin getManagementURL, sin reset de contrasena.
 *
 * Mocks: no hay red. La validacion se ejerce contra el modulo real.
 * Run: npm run test:manage-subscription
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const portal = require('../assets/stripe-portal.js');

const ROOT = path.join(__dirname, '..');
const PAGE_PATH = 'manage-subscription/index.html';
const CONFIG_PATH = 'assets/site-config.js';

const page = fs.readFileSync(path.join(ROOT, PAGE_PATH), 'utf8');
const portalSource = fs.readFileSync(path.join(ROOT, 'assets/stripe-portal.js'), 'utf8');
const configSource = fs.readFileSync(path.join(ROOT, CONFIG_PATH), 'utf8');
const funnel = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
const support = fs.readFileSync(path.join(ROOT, 'support.html'), 'utf8');
const wrapper = fs.readFileSync(path.join(ROOT, 'assets/revenuecat.js'), 'utf8');

// Lee la config publica sin imprimir valores secretos.
function publicConfig() {
  const sandbox = {};
  // eslint-disable-next-line no-new-func
  new Function('window', configSource)(sandbox);
  return sandbox.__BRAINY_FUNNEL_CONFIG__;
}

/* ---------- 1. la ruta existe ---------- */
function testRouteExists() {
  assert.ok(fs.existsSync(path.join(ROOT, PAGE_PATH)), 'manage-subscription/index.html must exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/stripe-portal.js')), 'assets/stripe-portal.js must exist');
  assert.ok(fs.existsSync(path.join(ROOT, CONFIG_PATH)), 'assets/site-config.js must exist');
  // Sirve tanto /manage-subscription/ como /manage-subscription/index.html.
  assert.match(page, /\.\.\/assets\/site-config\.js/);
  assert.match(page, /\.\.\/assets\/stripe-portal\.js/);
  // El script de autenticacion eliminado ya no existe.
  assert.equal(fs.existsSync(path.join(ROOT, 'assets/manage-subscription.js')), false,
    'assets/manage-subscription.js debe estar eliminado (codigo muerto)');
  // Sin build ni framework.
  assert.equal(/type="module"|<script[^>]+import\s/.test(page), false);
}

/* ---------- 2-6. sin login de Brainy, sin Supabase, sin RevenueCat ---------- */
function testNoBrainyLogin() {
  // 2. Sin campos email/password ni formulario.
  assert.equal(/type="password"/.test(page), false, 'sin campo de password');
  assert.equal(/<input/.test(page), false, 'sin ningun input');
  assert.equal(/<form/.test(page), false, 'sin formulario');
  assert.equal(/autocomplete="email"|autocomplete="current-password"/.test(page), false);
  assert.equal(/emailInput|passwordInput|resetEmailInput/.test(page), false);

  // 3. No carga Supabase.
  assert.equal(/supabase-js/.test(page), false, 'no debe cargar el SDK de Supabase');
  assert.equal(/cdn\.jsdelivr\.net/.test(page), false, 'no debe cargar nada de un CDN');
  assert.equal(/auth\.brainyadhd\.com/.test(page), false, 'no debe hablar con Supabase Auth');

  // 4-6. Sin RevenueCat ni customer info.
  assert.equal(/revenuecat-sdk/.test(page), false, 'no debe cargar el SDK de RevenueCat');
  assert.equal(/\bPurchases\b/.test(page), false, 'no debe usar el namespace Purchases');
  assert.equal(/BrainyRevenueCat/.test(page), false, 'no debe usar el wrapper de RevenueCat');
  assert.equal(/signInWithPassword|signUp|resetPasswordForEmail/.test(page), false);
  assert.equal(/configure\(/.test(page), false, 'no debe configurar RevenueCat');
  assert.equal(/getCustomerInfo|getManagementURL|getOfferings/.test(page), false);
  assert.equal(/window\.brainyFunnelState|brainy_funnel/.test(page), false, 'sin estado del funnel');
  // Sin almacenamiento de credenciales.
  assert.equal(/localStorage|sessionStorage|document\.cookie|indexedDB/.test(page), false);
  assert.equal(/console\.(log|debug|info|warn|error)\s*\(/.test(page), false, 'sin salida por consola');
  assert.equal(/sendBeacon|posthog|analytics/i.test(page), false, 'sin analytics');
}

/* ---------- 7-9. solo stripeCustomerPortalUrl, validado estrictamente ---------- */
function testUsesOnlyPortalUrl() {
  assert.match(page, /stripeCustomerPortalUrl/);
  const cfg = publicConfig();
  const key = cfg.revenuecatWebApiKey;
  const url = cfg.stripeCustomerPortalUrl;
  // Son dos valores independientes: ninguno se deriva del otro ni se mezcla.
  assert.notEqual(key, url, 'key y URL son valores distintos');
  assert.equal(url.includes(key), false, 'la URL del portal no contiene la key');
  assert.equal(key.includes(url), false, 'la key no contiene la URL del portal');
  assert.equal(/^https:\/\/billing\.stripe\.com/.test(key), false);
  assert.equal(/^strp/.test(url), false, 'la URL del portal no parece una key');
  // Propiedades separadas del objeto de configuración.
  assert.match(configSource, /revenuecatWebApiKey:\s*'[^']+'/);
  assert.match(configSource, /stripeCustomerPortalUrl:\s*'[^']+'/);
  // El modulo lee SOLO esa propiedad.
  const reader = portalSource.slice(portalSource.indexOf('function portalUrlFromConfig'));
  assert.match(reader, /config\.stripeCustomerPortalUrl/);
  assert.equal(/revenuecatWebApiKey/.test(reader), false, 'el lector no toca la key de RevenueCat');
}

function testAcceptsOnlyStripeLoginUrl() {
  const good = [
    'https://billing.stripe.com/p/login/test_abc123',
    'https://billing.stripe.com/p/login/test_1a2b3c4d5e',
  ];
  for (const url of good) {
    assert.equal(portal.isValidPortalUrl(url), true, `debe aceptar ${url}`);
  }
  // Rechazos exigidos (fail closed).
  const bad = [
    ['http:', 'http://billing.stripe.com/p/login/test_abc'],
    ['otro hostname', 'https://evil.example.com/p/login/test_abc'],
    ['subdominio atacante', 'https://billing.stripe.com.evil.io/p/login/test_abc'],
    ['credenciales', 'https://user:pass@billing.stripe.com/p/login/test_abc'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['fragment inesperado', 'https://billing.stripe.com/p/login/test_abc#x'],
    ['path incorrecto', 'https://billing.stripe.com/p/session/test_abc'],
    ['path vacio tras el prefijo', 'https://billing.stripe.com/p/login/'],
    ['sin path de login', 'https://billing.stripe.com/'],
    ['otro puerto', 'https://billing.stripe.com:8443/p/login/test_abc'],
    ['espacios', 'https://billing.stripe.com/p/login/test abc'],
    ['espacios al borde', ' https://billing.stripe.com/p/login/test_abc'],
    ['nueva linea', 'https://billing.stripe.com/p/login/test_abc\nX: 1'],
    ['null', null], ['undefined', undefined], ['vacio', ''], ['numero', 12345],
  ];
  for (const [label, url] of bad) {
    assert.equal(portal.isValidPortalUrl(url), false, `debe rechazar (${label}): ${String(url)}`);
  }
}

function testPortalUrlFromConfig() {
  assert.equal(portal.portalUrlFromConfig({ stripeCustomerPortalUrl: 'https://billing.stripe.com/p/login/t_ok' }), 'https://billing.stripe.com/p/login/t_ok');
  assert.equal(portal.portalUrlFromConfig({ stripeCustomerPortalUrl: 'http://billing.stripe.com/p/login/t' }), null);
  assert.equal(portal.portalUrlFromConfig({ stripeCustomerPortalUrl: 'https://otro.io/p/login/t' }), null);
  assert.equal(portal.portalUrlFromConfig({}), null);
  assert.equal(portal.portalUrlFromConfig(null), null);
  assert.equal(portal.portalUrlFromConfig(undefined), null);
  // La config real del sitio debe ser válida.
  const real = publicConfig();
  assert.ok(portal.isValidPortalUrl(real.stripeCustomerPortalUrl), 'la URL configurada debe ser válida');
}

/* ---------- 10-12. limpia su URL, redirige una vez, botón fallback ---------- */
function testScrubsOwnUrl() {
  let replaced = null;
  const hist = { replaceState: (_s, _t, url) => { replaced = url; } };
  portal.scrubOwnUrl({ pathname: '/manage-subscription/', search: '?email=ana@ejemplo.com', hash: '#token' }, hist);
  assert.equal(replaced, '/manage-subscription/', 'debe quitar query y fragment');
  replaced = null;
  portal.scrubOwnUrl({ pathname: '/manage-subscription/', search: '', hash: '' }, hist);
  assert.equal(replaced, null, 'una URL limpia no se toca');
  assert.match(page, /scrubOwnUrl\(window\.location, window\.history\)/);
  assert.match(page, /location\.replace\(url\)/, 'redirige con location.replace');
  assert.equal(/window\.open|target="_blank"/.test(page), false, 'sin ventana nueva');
  // Fallback manual presente.
  assert.match(page, /id="continueBtn"[^>]*>Continue to Stripe</);
  assert.match(page, /Opening your secure subscription portal…/);
  assert.match(page, /<noscript>/, 'mensaje útil sin JavaScript');
  assert.match(page, /hello@brainyadhd\.com/, 'enlace a soporte');
  // Accesibilidad y responsive.
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /aria-live="assertive"/);
  assert.match(page, /:focus-visible/);
  assert.match(page, /prefers-reduced-motion/);
  assert.match(page, /@media \(max-width: 380px\)/);
  assert.equal(/class="logo"|logomain\.png/.test(page), false, 'sin logo, como las páginas de utilidad');
}

/* ---------- 13. no expone PII ---------- */
// Sin claves secretas en ningun sitio del frontend.
// Se evalua el CODIGO, no los comentarios (que nombran los prefijos prohibidos).
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

function testNoPiiExposure() {
  // La pagina no tiene ningun valor de identidad que enviar.
  for (const pat of [/session\.user\.id/, /access_token/, /refresh_token/, /Bearer /, /apikey/i, /service_role/]) {
    assert.equal(pat.test(page), false, `no debe aparecer ${pat}`);
  }
  // No envia nada a Stripe: la navegacion no lleva query ni fragment propios.
  assert.match(page, /scrubOwnUrl/);
  // Sin claves secretas en ningun sitio del frontend.
  for (const f of [PAGE_PATH, CONFIG_PATH, 'assets/stripe-portal.js', 'assets/revenuecat.js']) {
    const src = code(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.equal(/\bsk_[A-Za-z0-9]{8,}/.test(src), false, `sin sk_ en ${f}`);
    assert.equal(/\brk_[A-Za-z0-9]{8,}/.test(src), false, `sin rk_ en ${f}`);
    assert.equal(/service_role|sb_secret/.test(src), false, `sin service_role en ${f}`);
    assert.equal(/whsec_|\btok_[A-Za-z0-9]{8,}/.test(src), false, `sin whsec_/tok_ en ${f}`);
  }
  // Sin cancelacion local en ninguna parte.
  for (const f of [PAGE_PATH, 'assets/stripe-portal.js', 'assets/revenuecat.js', 'funnel.html']) {
    const src = code(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.equal(/cancelSubscription|deleteCustomer|cancelImmediate|\.refund\(/.test(src), false, `sin cancelacion local en ${f}`);
  }
}

/* ---------- 14. los enlaces internos siguen apuntando a /manage-subscription/ ---------- */
function testInternalLinks() {
  assert.match(support, /<a href="\/manage-subscription\/">Manage subscription<\/a>/);
  assert.match(support, /footer-links[\s\S]*\/manage-subscription\//);
  assert.equal((funnel.match(/<a href="\/manage-subscription\/">/g) || []).length, 2,
    'paywall/success y handoff enlazan a /manage-subscription/');
  // Ningun enlace interno va directo a Stripe: la pagina es el unico punto.
  for (const f of ['funnel.html', 'support.html', PAGE_PATH]) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.equal(/href="https:\/\/billing\.stripe\.com/.test(src), false, `${f} no debe enlazar directo a Stripe`);
  }
}

/* ---------- 15. config publica activa = Live, no sandbox ---------- */
function testActiveConfigIsLive() {
  const cfg = publicConfig();
  const key = cfg.revenuecatWebApiKey;
  assert.equal(typeof key, 'string');
  assert.ok(key.length > 0, 'debe haber key configurada');
  assert.match(key, /^strp_/, 'prefijo strp_ de Web Billing key');
  assert.equal(/^strp_sb_/.test(key), false, 'NO debe ser la key de sandbox');
  assert.equal(/^sk_/.test(key), false, 'NO debe ser una secret key');
  assert.equal(cfg.revenuecatOfferingId, 'web_default', 'offering esperado');
  assert.equal(cfg.revenuecatEntitlementId, 'brainy Pro', 'entitlement exacto');
  // Fail-closed: el default del funnel sigue vacio.
  assert.match(funnel, /revenuecatWebApiKey: ''/, 'default fail-closed');
  assert.match(funnel, /assets\/site-config\.js/, 'el funnel lee la fuente unica');
  assert.equal(/window\.__BRAINY_FUNNEL_CONFIG__\s*=\s*\{[\s\S]*strp_sb_/.test(funnel), false,
    'sin config sandbox inline en el funnel');
  // La URL del portal vive en un unico fichero.
  const hits = ['funnel.html', 'support.html', PAGE_PATH, 'assets/revenuecat.js']
    .filter((f) => (new RegExp(String(publicConfig().stripeCustomerPortalUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(hits, [], 'la URL del portal no puede estar duplicada fuera de site-config.js');
}

/* ---------- 16. ids de offering/entitlement para la lectura Live ---------- */
function testOfferingContract() {
  const cfg = publicConfig();
  assert.equal(cfg.revenuecatOfferingId, 'web_default');
  assert.equal(cfg.revenuecatEntitlementId, 'brainy Pro');
  // El wrapper resuelve el offering por identificador exacto.
  assert.match(wrapper, /offerings\.all\[preferredId\]/);
  // El funnel usa el offering y el entitlement configurados.
  assert.match(funnel, /offeringId: FUNNEL_CONFIG\.revenuecatOfferingId \|\| 'web_default'/);
  assert.match(funnel, /entitlementId: FUNNEL_CONFIG\.revenuecatEntitlementId \|\| 'brainy Pro'/);
  assert.match(funnel, /svc\.getOfferings\(rcConfig\.offeringId\)/);
}

/* ---------- 17-20. checkout intacto ---------- */
function testCheckoutUnchanged() {
  // Metadata exacta.
  assert.match(wrapper, /metadata: \{ brainy_plan_id: opts\.planId \}/);
  // alreadyPro antes de purchase.
  const alreadyPro = funnel.indexOf('if (identity.alreadyPro)');
  const purchase = funnel.indexOf('svc.purchase(');
  assert.ok(alreadyPro >= 0 && alreadyPro < purchase, 'alreadyPro debe precede a purchase()');
  // Recovery sin recompra.
  const rs = funnel.indexOf('async function retryPendingRedemption');
  const re2 = funnel.indexOf('\n        }', rs);
  assert.ok(rs >= 0 && re2 > rs);
  assert.equal(funnel.slice(rs, re2).includes('purchase('), false, 'recovery no recompra');
  // Monthly por defecto aunque el anual se muestre primero.
  assert.match(funnel, /packages\.find\(\(entry\) => entry\.kind === 'monthly'\)[\s\S]{0,80}entry\.kind === 'annual'/,
    'el mensual tiene prioridad en la seleccion inicial');
  assert.match(funnel, /isAnnual[\s\S]{0,200}plan-badge[\s\S]{0,120}Most popular/,
    'el anual se marca como popular');
  // /manage-subscription/ no compra nada.
  assert.equal(/purchase\(/.test(page), false);
  assert.equal(/purchase\(/.test(portalSource), false);
}

/* ---------- 21. preguntas y orden intactos ---------- */
function testFunnelContentUnchanged() {
  const base = execFileSync('git', ['show', 'origin/main:funnel.html'], { cwd: ROOT, encoding: 'utf8' });
  const keys = (src) => [...new Set([...src.matchAll(/key:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(keys(funnel), keys(base), 'las claves de pregunta no cambian');
  assert.equal(JSON.stringify(funnel.match(/FUNNEL_STEPS = \[[\s\S]*?\n        \];/)[0]),
    JSON.stringify(base.match(/FUNNEL_STEPS = \[[\s\S]*?\n        \];/)[0]),
    'FUNNEL_STEPS idéntico: ni orden ni contenido del rediseño UI');
  for (const f of ['brainy-tasks-steps.json', 'brainy-daily-routines.json']) {
    const now = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const before = execFileSync('git', ['show', `origin/main:${f}`], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(now, before, `${f} sin cambios`);
  }
}

/* ---------- 22. supabase/ sin cambios ---------- */
function testSupabaseUnchanged() {
  const changed = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).map((l) => l.slice(3));
  const backend = changed.filter((f) => f.startsWith('supabase/') || /\.sql$/.test(f) || /webhook/i.test(f));
  assert.deepEqual(backend, [], `sin cambios en backend: ${backend.join(', ')}`);
  assert.ok(fs.existsSync(path.join(ROOT, 'supabase/functions/create-funnel-plan/index.ts')));
}

/* ---------- sintaxis ---------- */
function testSyntax() {
  const vm = require('node:vm');
  for (const f of ['funnel.html', 'support.html', PAGE_PATH]) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) new vm.Script(m[1], { filename: f });
  }
}

async function main() {
  const cases = [
    ['route exists and auth module removed', testRouteExists],
    ['no Brainy login, no Supabase, no RevenueCat', testNoBrainyLogin],
    ['uses only stripeCustomerPortalUrl', testUsesOnlyPortalUrl],
    ['accepts only https://billing.stripe.com/p/login/...', testAcceptsOnlyStripeLoginUrl],
    ['portal url read from config is valid', testPortalUrlFromConfig],
    ['scrubs own url, redirects once, has fallback', testScrubsOwnUrl],
    ['exposes no PII and no secret keys', testNoPiiExposure],
    ['internal links point to /manage-subscription/', testInternalLinks],
    ['active public config is Live, not sandbox', testActiveConfigIsLive],
    ['offering and entitlement contract', testOfferingContract],
    ['checkout logic unchanged', testCheckoutUnchanged],
    ['funnel questions and order unchanged', testFunnelContentUnchanged],
    ['supabase/ unchanged', testSupabaseUnchanged],
    ['inline scripts parse', testSyntax],
  ];
  let passed = 0;
  for (const [name, run] of cases) {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  }
  console.log(`manage-subscription regression: ${passed}/${cases.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});