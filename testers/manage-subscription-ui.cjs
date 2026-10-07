/* UI de /manage-subscription/ contra el sitio servido en local.
 *
 * Verifica la redireccion real al login del Stripe Customer Portal.
 * billing.stripe.com SIEMPRE se intercepta y responde con una pagina inerte:
 * nunca se abre sesion autenticada real, nunca se envia correo, nunca se
 * toca una suscripcion. Cero compras, cero cancelaciones.
 *
 * Run: npm run test:manage-subscription:ui
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORTAL_HOST = 'billing.stripe.com';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const VIEWPORTS = [['320x568', 320, 568], ['375x812', 375, 812], ['390x844', 390, 844], ['desktop', 1280, 900]];

function startServer() {
  const server = http.createServer((req, res) => {
    let file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  })));
}

/* Intercepta Stripe y registra la navegacion. Nunca sale a la red real. */
async function newPage(browser, viewport, baseUrl) {
  const context = await browser.newContext({ viewport: { width: viewport[1], height: viewport[2] } });
  const page = await context.newPage();
  const state = { navigations: [], consoleLines: [], pageErrors: [], otherExternal: [] };
  state.count = () => state.navigations.length;
  // El orden importa: Playwright evalúa de la más reciente a la más antigua,
  // así que la regla catch-all se registra PRIMERO y Stripe después.
  await page.route((u) => u.hostname !== '127.0.0.1', (route) => {
    state.otherExternal.push(new URL(route.request().url()).hostname);
    return route.abort();
  });
  await page.route((u) => u.hostname === PORTAL_HOST, (route) => {
    state.navigations.push(route.request().url());
    return route.fulfill({ body: '<!doctype html><title>Customer Portal (mock)</title>', contentType: 'text/html' });
  });
  page.on('console', (m) => state.consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => state.pageErrors.push(e.message));
  return { context, page, state };
}

async function waitForPortal(state, expected = 1) {
  for (let i = 0; i < 100 && state.navigations.length < expected; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return state.navigations;
}

function portalUrl() {
  const sandbox = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'assets/site-config.js'), 'utf8'))(sandbox);
  return sandbox.__BRAINY_FUNNEL_CONFIG__.stripeCustomerPortalUrl;
}

/* Sirve assets/site-config.js con otra stripeCustomerPortalUrl, para probar
 * el camino fail-closed con el resto de la pagina real. */
async function withPortalUrl(page, url) {
  const real = fs.readFileSync(path.join(ROOT, 'assets/site-config.js'), 'utf8');
  const patched = real.replace(/(stripeCustomerPortalUrl:\s*)'[^']*'/, "$1'" + url.replace(/'/g, "\\'") + "'");
  await page.route((u) => u.pathname.endsWith('/assets/site-config.js'), (route) =>
    route.fulfill({ body: patched, contentType: 'application/javascript' }));
}

async function testRedirectsOnce(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], baseUrl);
  await page.goto(`${baseUrl}/manage-subscription/`, { waitUntil: 'domcontentloaded' });
  const navs = await waitForPortal(state, 1);
  assert.equal(navs.length, 1, 'debe navegar exactamente una vez');
  assert.equal(navs[0], portalUrl(), 'debe ir al login público de Stripe');
  const parsed = new URL(navs[0]);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.hostname, PORTAL_HOST);
  assert.ok(parsed.pathname.startsWith('/p/login/'));
  // No lleva nada de identificacion hacia Stripe.
  assert.equal(parsed.search, '', 'sin query hacia Stripe');
  assert.equal(parsed.hash, '', 'sin fragmento hacia Stripe');
  // Si la pagina no redirige sola, el boton tambien lleva al portal.
  assert.deepEqual(state.pageErrors, [], 'sin errores de JS');
  await context.close();
  console.log('PASS redirects once to the Stripe Customer Portal login');
}

async function testFallbackButton(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], baseUrl);
  // Bloquea la redireccion automatica para poder pulsar el boton.
  await page.addInitScript(() => {
    const real = window.setTimeout;
    window.setTimeout = function (fn, ms) {
      if (ms === 250) return 0; // no auto-redirige en este test
      return real.apply(this, arguments);
    };
  });
  await page.goto(`${baseUrl}/manage-subscription/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#continueBtn', { timeout: 10000 });
  assert.equal(await page.isVisible('#openingState'), true);
  assert.equal(await page.textContent('#openingState .status span:last-child'), 'Opening your secure subscription portal…');
  await page.click('#continueBtn');
  const navs = await waitForPortal(state, 1);
  assert.equal(navs.length, 1);
  assert.equal(navs[0], portalUrl());
  await context.close();
  console.log('PASS fallback button continues to Stripe');
}

async function testInvalidPortalUrlFailsClosed(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], baseUrl);
  // Config con URL maliciosa: la pagina NO debe navegar.
  await withPortalUrl(page, 'https://evil.example.com/p/login/x');
  await page.goto(`${baseUrl}/manage-subscription/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#errorState:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(800);
  assert.deepEqual(state.navigations, [], 'no debe navegar con una URL inválida');
  assert.equal(await page.isVisible('#continueBtn'), false, 'el botón se oculta si no hay URL válida');
  assert.match(await page.textContent('#errorState'), /hello@brainyadhd\.com/);
  await context.close();

  // Y lo mismo con http: y con javascript:.
  for (const bad of ['http://billing.stripe.com/p/login/x', 'javascript:alert(1)', 'https://billing.stripe.com/p/login/x#f']) {
    const t = await newPage(browser, VIEWPORTS[1], baseUrl);
    await withPortalUrl(t.page, bad);
    await t.page.goto(`${baseUrl}/manage-subscription/`, { waitUntil: 'domcontentloaded' });
    await t.page.waitForSelector('#errorState:not([hidden])', { timeout: 10000 });
    await t.page.waitForTimeout(600);
    assert.deepEqual(t.state.navigations, [], `no debe navegar con ${bad}`);
    await t.context.close();
  }
  console.log('PASS invalid portal URLs fail closed with support link');
}

async function testNoConfigFailsClosed(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], baseUrl);
  await page.route((u) => u.pathname.endsWith('/assets/site-config.js'), (route) =>
    route.fulfill({ body: 'window.__BRAINY_FUNNEL_CONFIG__={revenuecatWebApiKey:"strp_x"};', contentType: 'application/javascript' }));
  await page.goto(`${baseUrl}/manage-subscription/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#errorState:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(600);
  assert.deepEqual(state.navigations, [], 'sin URL configurada no navega');
  assert.match(await page.textContent('#errorState'), /hello@brainyadhd\.com/);
  await context.close();
  console.log('PASS missing portal URL shows support, never navigates');
}

async function testScrubsOwnQueryAndFragment(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], baseUrl);
  await page.addInitScript(() => {
    window.__scrub = [];
    const orig = history.replaceState;
    history.replaceState = function (a, b, url) { window.__scrub.push(url); return orig.apply(history, arguments); };
  });
  await page.goto(`${baseUrl}/manage-subscription/?email=ana@example.com&userId=11111111-1111-4111-8111-111111111111#access_token=secreto`,
    { waitUntil: 'domcontentloaded' });
  const navs = await waitForPortal(state, 1);
  assert.equal(navs.length, 1);
  assert.equal(new URL(navs[0]).search, '', 'no viaja el query a Stripe');
  assert.equal(new URL(navs[0]).hash, '', 'no viaja el fragmento a Stripe');
  const joined = navs[0];
  for (const secret of ['ana@example.com', '11111111-1111-4111-8111-111111111111', 'secreto']) {
    assert.equal(joined.includes(secret), false, `no debe pasar ${secret} a Stripe`);
  }
  await context.close();
  console.log('PASS own query and fragment are scrubbed before redirecting');
}

async function testNoPiiOrSecretLeak(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], baseUrl);
  await page.goto(`${baseUrl}/manage-subscription/`, { waitUntil: 'domcontentloaded' });
  await waitForPortal(state, 1);
  const logs = state.consoleLines.join(' | ');
  assert.equal(/billing\.stripe\.com/.test(logs), false, 'no registra la URL del portal en consola');
  assert.equal(/strp_/.test(logs), false, 'no registra la key en consola');
  // Y en la pagina no hay nada que enviar.
  const inputs = await page.evaluate(() => document.querySelectorAll('input, form, [name=email], [name=password]').length);
  assert.equal(inputs, 0, 'sin campos de email/password');
  await context.close();
  console.log('PASS no PII, no portal URL and no key in console output');
}

async function testNoScriptsResources(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], baseUrl);
  // Se frena la redireccion para poder inspeccionar los recursos de la pagina.
  await page.addInitScript(() => {
    const real = window.setTimeout;
    window.setTimeout = function (fn, ms) { return ms === 250 ? 0 : real.apply(this, arguments); };
  });
  await page.goto(`${baseUrl}/manage-subscription/`, { waitUntil: 'networkidle' });
  const loaded = await page.evaluate(() => [...document.querySelectorAll('script[src], link[href]')].map((e) => e.getAttribute('src') || e.getAttribute('href')));
  const joined = loaded.join(' ');
  assert.equal(/supabase/i.test(joined), false, 'no carga Supabase');
  assert.equal(/revenuecat/i.test(joined), false, 'no carga RevenueCat');
  assert.match(joined, /stripe-portal\.js/);
  assert.match(joined, /site-config\.js/);
  assert.deepEqual(state.otherExternal, [], 'sin peticiones externas inesperadas');
  await context.close();
  console.log('PASS page loads only site-config and stripe-portal');
}

async function testResponsiveAndAccessibility(browser, baseUrl) {
  for (const vp of VIEWPORTS) {
    const { context, page } = await newPage(browser, vp, baseUrl);
    await page.addInitScript(() => {
      const real = window.setTimeout;
      window.setTimeout = function (fn, ms) { return ms === 250 ? 0 : real.apply(this, arguments); };
    });
    await page.goto(`${baseUrl}/manage-subscription/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#continueBtn', { timeout: 10000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `sin overflow horizontal en ${vp[0]}`);
    const fits = await page.evaluate(() => {
      const card = document.querySelector('main').getBoundingClientRect();
      const btn = document.getElementById('continueBtn').getBoundingClientRect();
      return btn.right <= card.right + 1 && btn.left >= card.left - 1;
    });
    assert.ok(fits, `botón dentro de la tarjeta en ${vp[0]}`);
    if (vp[0] !== 'desktop') {
      const h = await page.evaluate(() => document.getElementById('continueBtn').getBoundingClientRect().height);
      assert.ok(h >= 40, `altura de botón ${h}px en ${vp[0]}`);
    }
    // Foco visible y navegable por teclado.
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement.id);
    assert.ok(focused.length > 0, `el primer tabulador enfoca algo en ${vp[0]}`);
    const outline = await page.evaluate(() => {
      const el = document.getElementById('continueBtn');
      el.focus();
      return getComputedStyle(el).outlineStyle;
    });
    assert.notEqual(outline, 'none', 'foco visible');
    // prefers-reduced-motion respetado.
    const rm = await page.evaluate(() => !!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    assert.equal(typeof rm, 'boolean');
    await context.close();
    console.log(`PASS responsive and a11y ${vp[0]}`);
  }
}

async function testReducedMotion(browser, baseUrl) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const state = { navigations: [] };
  await page.route((u) => u.hostname !== '127.0.0.1', (r) => r.abort());
  await page.route((u) => u.hostname === PORTAL_HOST, (r) => { state.navigations.push(r.request().url()); return r.fulfill({ body: 'mock', contentType: 'text/html' }); });
  await page.goto(`${baseUrl}/manage-subscription/`, { waitUntil: 'domcontentloaded' });
  await waitForPortal(state, 1);
  assert.equal(state.navigations.length, 1, 'con reduced-motion también redirige (y más rápido)');
  await context.close();
  console.log('PASS prefers-reduced-motion still redirects');
}

async function testNoscriptMessage(browser, baseUrl) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.route((u) => u.hostname !== '127.0.0.1', (r) => r.abort());
  await page.goto(`${baseUrl}/manage-subscription/`, { waitUntil: 'domcontentloaded' });
  const visible = await page.locator('#noScriptNotice').isVisible();
  assert.ok(visible, 'sin JavaScript debe mostrarse un mensaje útil');
  const text = await page.textContent('#noScriptNotice');
  assert.match(text, /hello@brainyadhd\.com/, 'mensaje útil con salida por soporte');
  await context.close();
  console.log('PASS useful message without JavaScript');
}

async function testFunnelAndSupportLinks(browser, baseUrl) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route((u) => u.hostname !== '127.0.0.1', (r) => r.abort());
  await page.goto(`${baseUrl}/support.html`, { waitUntil: 'domcontentloaded' });
  const links = await page.locator('a[href="/manage-subscription/"]').allTextContents();
  assert.ok(links.includes('Manage subscription'), `support enlaza a /manage-subscription/: ${JSON.stringify(links)}`);
  // El funnel enlaza a /manage-subscription/, nunca directo a Stripe.
  const funnelHtml = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
  // El funnel ya no enlaza a /manage-subscription/: la pantalla terminal lo
  // elimino por requisito de diseno. support.html sigue siendo la via de entrada.
  assert.equal((funnelHtml.match(/<a href="\/manage-subscription\/">/g) || []).length, 0);
  assert.match(funnelHtml, /manage-subscription-note/, 'el paywall conserva la aclaracion en texto');
  assert.equal(/href="https:\/\/billing\.stripe\.com/.test(funnelHtml), false, 'el funnel no enlaza directo a Stripe');
  // El funnel carga la config Live desde site-config.js.
  assert.match(funnelHtml, /assets\/site-config\.js/);
  await context.close();
  console.log('PASS funnel and support link to /manage-subscription/ only');
}

async function main() {
  const { server, base: baseUrl } = await startServer();
  const browser = await chromium.launch();
  const cases = [
    ['redirects once', testRedirectsOnce],
    ['fallback button', testFallbackButton],
    ['invalid URL fails closed', testInvalidPortalUrlFailsClosed],
    ['missing config fails closed', testNoConfigFailsClosed],
    ['scrubs own query/fragment', testScrubsOwnQueryAndFragment],
    ['no PII leak', testNoPiiOrSecretLeak],
    ['only two scripts', testNoScriptsResources],
    ['reduced motion', testReducedMotion],
    ['noscript message', testNoscriptMessage],
    ['funnel and support links', testFunnelAndSupportLinks],
  ];
  let passed = 0;
  try {
    for (const [name, run] of cases) {
      await run(browser, baseUrl);
      passed += 1;
    }
    await testResponsiveAndAccessibility(browser, baseUrl);
    passed += 1;
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`manage-subscription UI: ${passed}/${cases.length + 1} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});