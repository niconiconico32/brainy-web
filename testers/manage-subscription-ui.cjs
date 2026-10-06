/* Playwright UI test for /manage-subscription/.
 *
 * Todo está mockeado: Supabase, RevenueCat y el Customer Portal. No hay red
 * real, ni login real, ni compras, ni cancelaciones, ni escrituras a Supabase.
 *
 * - La página se sirve desde un servidor HTTP local efímero en 127.0.0.1.
 * - El SDK vendorizado de RevenueCat y el SDK de Supabase del CDN se sustituyen
 *   por stubs: no se ejecuta el SDK real (evita fingerprinting y cualquier
 *   llamada real a RevenueCat).
 * - El dominio del Customer Portal se intercepta y se responde con una página
 *   inerte: nunca se abre una sesión autenticada real.
 * - Las aserciones sobre el estado interno del flujo se recogen en Node mediante
 *   un binding (window.__record), porque la navegación destruye el contexto de
 *   ejecución de la página.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORTAL_HOST = 'billing.revenuecat.com';
const PORTAL = `https://${PORTAL_HOST}/customer/portal/abc123`;
const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
};

const VIEWPORTS = [
  ['320x568', 320, 568],
  ['375x812', 375, 812],
  ['390x844', 390, 844],
  ['desktop', 1280, 900],
];

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    // Rutas con barra final (p. ej. /manage-subscription/) sirven su index.html.
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* Mocks que se inyectan antes de cada script de la página. Registran todo lo
   relevante en Node a través de window.__record, sin volcar credenciales. */
const MOCK_SCRIPT = ({ managementURL, failMode }) => `
  window.__managementURL = ${JSON.stringify(managementURL === undefined ? PORTAL : managementURL)};
  window.__failMode = ${JSON.stringify(failMode || '')};
  window.__sdkStubLoaded = false;
  window.__supabaseStubLoaded = false;

  window.__record('page:script'); // confirma que el binding está disponible

  document.addEventListener('DOMContentLoaded', function () {
    var input = document.getElementById('passwordInput');
    if (!input) return;
    var proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    Object.defineProperty(input, 'value', {
      get: function () { return proto.get.call(this); },
      set: function (next) {
        proto.set.call(this, next);
        window.__record(next === '' ? 'page:passwordCleared' : 'page:passwordFilled');
      }
    });
  });

  window.supabase = {
    createClient: function (url, key, options) {
      window.__record('supabase:createClient', {
        url: url,
        role: 'anon',
        persistSession: options && options.auth && options.auth.persistSession,
        autoRefreshToken: options && options.auth && options.auth.autoRefreshToken,
        detectSessionInUrl: options && options.auth && options.auth.detectSessionInUrl,
        storageOverridden: !!options.storage
      });
      return {
        auth: {
          signInWithPassword: function (credentials) {
            window.__record('supabase:signInWithPassword', {
              email: credentials.email,
              hasPassword: typeof credentials.password === 'string' && credentials.password.length > 0,
              extraKeys: Object.keys(credentials).filter(function (k) { return k !== 'email' && k !== 'password'; })
            });
            if (window.__failMode === 'authNetwork') {
              return Promise.resolve({ data: null, error: Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }) });
            }
            if (window.__failMode === 'badCredentials') {
              return Promise.resolve({ data: null, error: { message: 'Invalid login credentials', status: 400 } });
            }
            var userId = ${JSON.stringify(failMode === 'badUuid' ? 'anon' : UUID)};
            return Promise.resolve({ data: { user: { id: userId } }, error: null });
          },
          resetPasswordForEmail: function (email, options) {
            window.__record('supabase:resetPasswordForEmail', {
              email: email,
              optionsKeys: Object.keys(options || {}).sort(),
              redirectTo: options && options.redirectTo
            });
            if (window.__failMode === 'resetNetwork') {
              return Promise.reject(Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }));
            }
            if (window.__failMode === 'resetUnknownUser') {
              return Promise.resolve({ data: null, error: { message: 'User not found', status: 404 } });
            }
            return Promise.resolve({ data: {}, error: null });
          },
          signOut: function () { window.__record('supabase:signOut'); return Promise.resolve({ error: null }); }
        }
      };
    }
  };

  window.Purchases = {
    Purchases: {
      setLogLevel: function () {},
      configure: function (cfg) {
        window.__record('rc:configure', { appUserId: cfg.appUserId, hasApiKey: typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0 });
        return {
          getAppUserId: function () { return cfg.appUserId; },
          getCustomerInfo: function () {
            window.__record('rc:getCustomerInfo');
            var url = window.__managementURL;
            if (url === '__network__') {
              return Promise.reject(Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }));
            }
            return Promise.resolve({ managementURL: url, entitlements: { active: {} } });
          },
          getOfferings: function () { window.__record('rc:getOfferings'); return Promise.resolve({}); },
          purchase: function () { window.__record('rc:purchase'); throw new Error('never'); },
          restorePurchases: function () { window.__record('rc:restorePurchases'); throw new Error('never'); }
        };
      }
    }
  };
`;

async function newPage(browser, viewport, mocks, baseUrl) {
  const context = await browser.newContext({ viewport: { width: viewport[1], height: viewport[2] } });
  const page = await context.newPage();

  const state = {
    navigations: [],
    external: [],
    consoleLines: [],
    pageErrors: [],
    events: [],
  };
  state.count = (name) => state.events.filter((event) => event.name === name).length;
  state.first = (name) => state.events.find((event) => event.name === name);
  state.names = () => state.events.map((event) => event.name);

  // El orden importa: Playwright evalúa las rutas de la más reciente a la más
  // antigua, así que el catch-all externo se registra PRIMERO.
  await page.route((url) => url.hostname !== '127.0.0.1', (route) => {
    state.external.push(route.request().url());
    return route.abort();
  });
  // El Customer Portal se intercepta y se responde con una página inerte: nunca
  // se abre una sesión real ni se llama a su API autenticada.
  await page.route((url) => url.hostname === PORTAL_HOST, (route) => {
    state.navigations.push(route.request().url());
    return route.fulfill({ body: '<!doctype html><title>Customer Portal (mock)</title>', contentType: 'text/html' });
  });
  // El SDK real de Supabase del CDN no se descarga: el mock local hace de anon key.
  await page.route((url) => url.hostname === 'cdn.jsdelivr.net', (route) => route.fulfill({
    body: 'window.__supabaseStubLoaded = true;',
    contentType: 'application/javascript',
  }));
  // El SDK real de RevenueCat no se descarga: evita fingerprinting y cualquier
  // llamada real a RevenueCat.
  await page.route((url) => url.pathname.endsWith('/assets/revenuecat-sdk.js'), (route) => route.fulfill({
    body: 'window.__sdkStubLoaded = true;',
    contentType: 'application/javascript',
  }));

  page.on('console', (message) => state.consoleLines.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  await page.exposeBinding('__record', (_source, name, detail) => {
    state.events.push({ name, detail: detail || {} });
  });

  await page.addInitScript(MOCK_SCRIPT(mocks));
  await page.goto(baseUrl + '/manage-subscription/');
  assert.deepEqual(state.pageErrors, [], `errores de JS en la página: ${state.pageErrors.join(' | ')}`);
  assert.equal(await page.evaluate(() => window.__sdkStubLoaded), true, 'el SDK real de RevenueCat debe estar sustituido');
  assert.equal(await page.evaluate(() => window.__supabaseStubLoaded), true, 'el SDK real de Supabase debe estar sustituido');
  assert.deepEqual(state.external, [], `peticiones externas inesperadas: ${state.external.join(', ')}`);
  return { context, page, state };
}

function visibleStates(page) {
  return page.evaluate(() => ['formState', 'workingState', 'noSubscriptionState', 'networkErrorState',
    'invalidUrlState', 'unavailableState', 'resetRequestState', 'resetSentState', 'resetNetworkErrorState']
    .filter((id) => !document.getElementById(id).hidden));
}

const ALL_STATES = ['formState', 'workingState', 'noSubscriptionState', 'networkErrorState',
  'invalidUrlState', 'unavailableState', 'resetRequestState', 'resetSentState', 'resetNetworkErrorState'];

async function fillCredentials(page, email = 'user@example.com', password = 'secret-1') {
  await page.fill('#emailInput', email);
  await page.fill('#passwordInput', password);
  // requestSubmit en vez de page.click: el click de Playwright esperaría a que
  // terminase la navegación al Customer Portal, que aquí está mockeada.
  await page.evaluate(() => document.getElementById('loginForm').requestSubmit());
}

async function waitForPortal(state, expected = 1) {
  for (let i = 0; i < 100 && state.navigations.length < expected; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return state.navigations;
}

async function closeContext(context, state) {
  await context.close();
}

/* ---------- tests ---------- */

async function testResponsive(browser, baseUrl) {
  for (const viewport of VIEWPORTS) {
    const { context, page, state } = await newPage(browser, viewport, { managementURL: PORTAL }, baseUrl);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `overflow horizontal en ${viewport[0]}: ${overflow}px`);
    const fits = await page.evaluate(() => {
      const button = document.getElementById('submitButton').getBoundingClientRect();
      const card = document.querySelector('main').getBoundingClientRect();
      return button.right <= card.right + 1 && button.left >= card.left - 1 && button.width > 100;
    });
    assert.ok(fits, `el botón no cabe en la tarjeta en ${viewport[0]}`);
    if (viewport[0] !== 'desktop') {
      const height = await page.evaluate(() => document.getElementById('submitButton').getBoundingClientRect().height);
      assert.ok(height >= 40, `altura de botón ${height}px en ${viewport[0]}`);
      const fontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
      assert.ok(fontSize >= 16, `texto base ${fontSize}px en ${viewport[0]}`);
    }
    assert.equal(state.count('supabase:signInWithPassword'), 0, 'no se autentica nada al cargar');
    await closeContext(context, state);
    console.log(`PASS responsive ${viewport[0]}`);
  }
}

async function testKeyboardNavigation(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  // Autofocus en el email: el primer tabulador va al password.
  assert.equal(await page.evaluate(() => document.activeElement.id), 'emailInput', 'el email recibe el foco inicial');
  const order = [];
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => {
      const el = document.activeElement;
      return el.tagName === 'A' ? `link:${el.getAttribute('href')}` : el.id;
    }));
  }
  assert.deepEqual(order, ['passwordInput', 'submitButton', 'forgotPasswordBtn'], `orden de tabulación inesperado: ${order.join(' > ')}`);
  await page.focus('#submitButton');
  const outline = await page.evaluate(() => getComputedStyle(document.getElementById('submitButton')).outlineStyle);
  assert.notEqual(outline, 'none', 'el botón debe tener foco visible');
  // Se puede enviar con Enter desde el campo de contraseña.
  await page.fill('#emailInput', 'user@example.com');
  await page.fill('#passwordInput', 'secret-1');
  await page.keyboard.press('Enter');
  assert.deepEqual(await waitForPortal(state), [PORTAL]);
  await closeContext(context, state);
  console.log('PASS keyboard navigation and visible focus');
}

async function testSuccessRedirect(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  await fillCredentials(page);
  assert.deepEqual(await waitForPortal(state), [PORTAL]);

  assert.equal(state.count('supabase:signInWithPassword'), 1);
  assert.equal(state.count('rc:configure'), 1);
  assert.equal(state.count('rc:getCustomerInfo'), 1);
  assert.equal(state.count('rc:purchase'), 0, 'no debe haber compra');
  assert.equal(state.count('rc:getOfferings'), 0, 'no debe consultar offerings');
  assert.equal(state.count('rc:restorePurchases'), 0, 'no debe restaurar compras');
  assert.equal(state.first('rc:configure').detail.appUserId, UUID, 'RevenueCat recibe el UUID de la sesión');
  assert.equal(state.first('supabase:signInWithPassword').detail.extraKeys.length, 0, 'solo email y password');
  assert.ok(state.count('page:passwordCleared') >= 1, 'la contraseña se borra del DOM tras autenticar');
  assert.deepEqual(state.external, [], `peticiones externas inesperadas: ${state.external.join(', ')}`);
  await closeContext(context, state);
  console.log('PASS success redirects to Customer Portal with the authenticated UUID');
}

async function testBadCredentials(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL, failMode: 'badCredentials' }, baseUrl);
  await fillCredentials(page, 'nobody@example.com', 'wrong-password');
  await page.waitForSelector('#loginError:not([hidden])');
  assert.equal(await page.textContent('#loginError'), 'We couldn’t sign you in. Check your email and password and try again.');
  assert.deepEqual(await visibleStates(page), ['formState'], 'vuelve al formulario');
  assert.equal(state.count('rc:configure'), 0, 'no configura RevenueCat sin sesión');
  assert.equal(state.count('rc:getCustomerInfo'), 0);
  assert.ok(state.count('page:passwordCleared') >= 1, 'la contraseña se borra del DOM');
  assert.deepEqual(state.navigations, []);
  await closeContext(context, state);
  console.log('PASS invalid credentials show a generic message');
}

async function testNoManagementUrl(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: null }, baseUrl);
  await fillCredentials(page);
  await page.waitForSelector('#noSubscriptionState:not([hidden])');
  assert.deepEqual(state.navigations, [], 'no navega sin managementURL');
  const text = await page.textContent('#noSubscriptionState');
  assert.match(text, /We couldn’t find an active subscription for this account\./);
  assert.match(text, /Manage subscription/);
  assert.match(text, /hello@brainyadhd\.com/);
  assert.equal(await page.isVisible('#noSubscriptionRetry'), true);
  await page.click('#noSubscriptionRetry');
  await page.waitForSelector('#formState:not([hidden])');
  await closeContext(context, state);
  console.log('PASS missing managementURL shows the fallback with Retry');
}

async function testNonHttpsRejected(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: `http://${PORTAL_HOST}/customer/portal/abc123` }, baseUrl);
  await fillCredentials(page);
  // El wrapper descarta la URL no-HTTPS y devuelve null, así que la página cae en
  // el estado "sin suscripción". Nunca navega (fail closed).
  await page.waitForSelector('#noSubscriptionState:not([hidden])');
  assert.deepEqual(state.navigations, [], 'fail closed: no navega');
  assert.deepEqual(state.external, [], 'no intenta abrir la URL no-HTTPS');
  assert.equal(state.count('rc:getCustomerInfo'), 1);
  await closeContext(context, state);
  console.log('PASS non-https managementURL is discarded and never opened');
}

async function testNetworkErrorRetry(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: '__network__' }, baseUrl);
  await fillCredentials(page);
  await page.waitForSelector('#networkErrorState:not([hidden])');
  assert.match(await page.textContent('#networkErrorMessage'), /your session stays open/);
  assert.equal(state.count('supabase:signOut'), 0, 'un error temporal no cierra la sesión');
  const signInsBefore = state.count('supabase:signInWithPassword');
  // Retry reintenta RevenueCat sin volver a pedir la contraseña.
  await page.evaluate((url) => { window.__managementURL = url; }, PORTAL);
  await page.click('#networkRetry');
  assert.deepEqual(await waitForPortal(state), [PORTAL]);
  assert.equal(state.count('supabase:signInWithPassword'), signInsBefore, 'Retry no vuelve a iniciar sesión');
  assert.equal(state.count('rc:configure'), 1, 'la configuración de RevenueCat es única e idempotente');
  assert.equal(state.count('rc:getCustomerInfo'), 2, 'Retry vuelve a pedir el CustomerInfo con el mismo UUID');
  await closeContext(context, state);
  console.log('PASS network error allows Retry without signing in again');
}

async function testQueryParamsIgnored(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  await page.goto(baseUrl + `/manage-subscription/?userId=${UUID_OTHER}&managementURL=${encodeURIComponent('https://evil.example.com/')}`);
  assert.match(page.url(), /\/manage-subscription\/$/, 'los parámetros se limpian de la URL');
  await fillCredentials(page);
  assert.deepEqual(await waitForPortal(state), [PORTAL]);
  assert.equal(state.first('rc:configure').detail.appUserId, UUID, 'el UUID de la sesión gana');
  await closeContext(context, state);
  console.log('PASS query params cannot inject userId or managementURL');
}

async function testDoubleClickSingleLogin(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  await page.fill('#emailInput', 'user@example.com');
  await page.fill('#passwordInput', 'secret-1');
  await page.evaluate(() => {
    const form = document.getElementById('loginForm');
    form.requestSubmit();
    form.requestSubmit();
    form.requestSubmit();
  });
  assert.deepEqual(await waitForPortal(state), [PORTAL]);
  assert.equal(state.count('supabase:signInWithPassword'), 1, 'un solo signInWithPassword');
  assert.equal(state.count('rc:configure'), 1, 'una sola configuración de RevenueCat');
  assert.equal(state.count('rc:getCustomerInfo'), 1, 'un solo lookup');
  await closeContext(context, state);
  console.log('PASS double submit does not duplicate login or configuration');
}

async function testNoConsoleLeaks(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  await fillCredentials(page, 'private.user@example.com', 'super-secret-password');
  assert.deepEqual(await waitForPortal(state), [PORTAL]);
  const joined = state.consoleLines.join(' | ');
  for (const secret of ['super-secret-password', 'private.user@example.com', UUID, PORTAL]) {
    assert.equal(joined.includes(secret), false, `fuga en consola: ${secret}`);
  }
  await closeContext(context, state);
  console.log('PASS no credentials, uuid or portal URL in console output');
}

async function testNoBrowserStorage(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL, failMode: 'authNetwork' }, baseUrl);
  await fillCredentials(page, 'private.user@example.com', 'super-secret-password');
  await page.waitForSelector('#networkErrorState:not([hidden])');
  const storage = await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
    cookie: document.cookie,
    passwordValue: document.getElementById('passwordInput').value
  }));
  assert.deepEqual(storage.local, [], 'localStorage vacío');
  assert.deepEqual(storage.session, [], 'sessionStorage vacío');
  assert.equal(storage.cookie, '', 'sin cookies');
  assert.equal(storage.passwordValue, '', 'la contraseña se borra del DOM');
  const client = state.first('supabase:createClient');
  assert.equal(client.detail.persistSession, false, 'persistSession: false');
  assert.equal(client.detail.autoRefreshToken, false);
  assert.equal(client.detail.detectSessionInUrl, false);
  assert.equal(client.detail.storageOverridden, false, 'sin storage propio');
  assert.equal(client.detail.url, 'https://auth.brainyadhd.com');
  assert.deepEqual(state.navigations, []);
  await closeContext(context, state);
  console.log('PASS session is in-memory only: nothing persisted, nothing leaked');
}

/* ---------- recuperación de contraseña ---------- */

const RESET_REDIRECT = 'https://brainyadhd.com/reset-password/';

async function openResetView(page) {
  await page.click('#forgotPasswordBtn');
  await page.waitForSelector('#resetRequestState:not([hidden])');
}

async function testForgotDoesNotNavigate(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  // "Forgot your password?" no es un enlace ni navega a /reset-password/.
  assert.equal(await page.locator('a[href="/reset-password/"]').count(), 0, 'no debe haber enlace directo a /reset-password/');
  assert.equal(await page.evaluate(() => document.getElementById('forgotPasswordBtn').tagName), 'BUTTON');
  assert.equal(await page.evaluate(() => document.getElementById('forgotPasswordBtn').type), 'button');
  const before = page.url();
  await openResetView(page);
  assert.equal(page.url(), before, 'no navega: solo cambia de estado');
  assert.deepEqual(state.navigations, [], 'no navega a ninguna URL');
  assert.equal(state.count('supabase:resetPasswordForEmail'), 0, 'abrir la vista no envía nada');
  // Contenido exigido.
  assert.equal(await page.textContent('#resetSubmitButton'), 'Send reset link');
  assert.equal(await page.textContent('#resetBackBtn'), 'Back to subscription login');
  assert.equal(await page.inputValue('#resetEmailInput'), '');
  assert.equal(await page.getAttribute('#resetEmailInput', 'autocomplete'), 'email');
  // Foco visible y en el campo de email.
  assert.equal(await page.evaluate(() => document.activeElement.id), 'resetEmailInput');
  await closeContext(context, state);
  console.log('PASS Forgot your password? opens the reset request state without navigating');
}

async function testResetRequestSendsExactRedirect(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  await openResetView(page);
  await page.fill('#resetEmailInput', '  User@Example.COM  ');
  await page.evaluate(() => document.getElementById('resetForm').requestSubmit());
  await page.waitForSelector('#resetSentState:not([hidden])');
  const call = state.first('supabase:resetPasswordForEmail');
  assert.ok(call, 'debe llamar a resetPasswordForEmail');
  assert.equal(call.detail.email, 'user@example.com', 'el email se normaliza');
  assert.equal(call.detail.redirectTo, RESET_REDIRECT, 'callback exacto');
  assert.deepEqual(call.detail.optionsKeys, ['redirectTo'], 'solo redirectTo');
  assert.equal(state.count('supabase:signInWithPassword'), 0, 'no inicia sesión');
  assert.equal(state.count('rc:configure'), 0, 'no toca RevenueCat');
  assert.deepEqual(state.navigations, []);
  await closeContext(context, state);
  console.log('PASS reset request uses resetPasswordForEmail with the exact redirect');
}

async function testResetRequestGenericForExistingAndMissing(browser, baseUrl) {
  const existing = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  await openResetView(existing.page);
  await existing.page.fill('#resetEmailInput', 'real.user@example.com');
  await existing.page.evaluate(() => document.getElementById('resetForm').requestSubmit());
  await existing.page.waitForSelector('#resetSentState:not([hidden])');
  const existingCopy = {
    title: await existing.page.textContent('#resetSentState h1'),
    body: await existing.page.textContent('#resetSentState p[role="status"]'),
    visible: await visibleStates(existing.page),
  };
  assert.equal(existingCopy.title, 'Check your inbox');
  assert.equal(existingCopy.body, 'If an account exists for this email, we’ve sent a password reset link. Open the link in your browser to choose a new password.');
  assert.deepEqual(existingCopy.visible, ['resetSentState']);
  // El email se borra del DOM tras la respuesta genérica.
  assert.equal(await existing.page.inputValue('#resetEmailInput'), '');
  await closeContext(existing.context, existing.state);

  // Cuenta inexistente: Supabase devuelve "User not found".
  const missing = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL, failMode: 'resetUnknownUser' }, baseUrl);
  await openResetView(missing.page);
  await missing.page.fill('#resetEmailInput', 'ghost@example.com');
  await missing.page.evaluate(() => document.getElementById('resetForm').requestSubmit());
  await missing.page.waitForSelector('#resetSentState:not([hidden])');
  const missingCopy = {
    title: await missing.page.textContent('#resetSentState h1'),
    body: await missing.page.textContent('#resetSentState p[role="status"]'),
    visible: await visibleStates(missing.page),
  };
  // Respuesta IDÉNTICA: no hay forma de distinguir los dos casos.
  assert.deepEqual(missingCopy, existingCopy, 'la respuesta debe ser idéntico exista o no la cuenta');
  assert.equal(await missing.page.inputValue('#resetEmailInput'), '');
  const text = await missing.page.textContent('main');
  assert.equal(/not found|no such user|does not exist|registered/i.test(text), false, 'sin texto que revele existencia');
  const joinedLogs = missing.state.consoleLines.join(' | ');
  assert.equal(/not found|ghost@example\.com/.test(joinedLogs), false, 'sin PII ni motivo en consola');
  await closeContext(missing.context, missing.state);
  console.log('PASS generic response: identical output for existing and missing accounts');
}

async function testResetRequestInvalidEmail(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  await openResetView(page);
  for (const bad of ['nope', 'a@', '@b.co', 'a b@c.co']) {
    await page.fill('#resetEmailInput', bad);
    await page.evaluate(() => document.getElementById('resetForm').requestSubmit());
    await page.waitForSelector('#resetError:not([hidden])');
    assert.equal(await page.textContent('#resetError'), 'Enter a valid email address.');
    assert.deepEqual(await visibleStates(page), ['resetRequestState']);
  }
  assert.equal(state.count('supabase:resetPasswordForEmail'), 0, 'un email inválido no llega a Supabase');
  await closeContext(context, state);
  console.log('PASS invalid email is rejected before any request');
}

async function testResetRequestDoubleClick(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  await openResetView(page);
  await page.fill('#resetEmailInput', 'user@example.com');
  await page.evaluate(() => {
    const form = document.getElementById('resetForm');
    form.requestSubmit();
    form.requestSubmit();
    form.requestSubmit();
  });
  await page.waitForSelector('#resetSentState:not([hidden])');
  assert.equal(state.count('supabase:resetPasswordForEmail'), 1, 'un solo resetPasswordForEmail');
  await closeContext(context, state);
  console.log('PASS double click does not duplicate the reset request');
}

async function testResetRequestNetworkRetry(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL, failMode: 'resetNetwork' }, baseUrl);
  await openResetView(page);
  await page.fill('#resetEmailInput', 'user@example.com');
  await page.evaluate(() => document.getElementById('resetForm').requestSubmit());
  await page.waitForSelector('#resetNetworkErrorState:not([hidden])');
  assert.match(await page.textContent('#resetNetworkErrorState p[role="alert"]'), /We couldn’t reach the service to send your reset link\./);
  assert.equal(await page.isVisible('#resetRetry'), true);
  const callsBefore = state.count('supabase:resetPasswordForEmail');
  // Retry reintenta con el email ya capturado, sin volver a pedirlo.
  await page.click('#resetRetry');
  await page.waitForSelector('#resetNetworkErrorState:not([hidden])');
  assert.equal(state.count('supabase:resetPasswordForEmail'), callsBefore + 1, 'Retry reenvía la solicitud');
  assert.equal(state.count('supabase:resetPasswordForEmail'), 2);
  const second = state.events.filter((e) => e.name === 'supabase:resetPasswordForEmail').pop();
  assert.equal(second.detail.email, 'user@example.com', 'Retry reutiliza el email pendiente');
  assert.equal(second.detail.redirectTo, RESET_REDIRECT);
  // Volver al login funciona desde el estado de error.
  await page.click('#resetNetworkBackBtn');
  await page.waitForSelector('#formState:not([hidden])');
  assert.deepEqual(await visibleStates(page), ['formState']);
  await closeContext(context, state);
  console.log('PASS network error allows Retry and Back to subscription login');
}

async function testResetRequestNoPiiPersisted(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  await openResetView(page);
  await page.fill('#resetEmailInput', 'private.person@example.com');
  await page.evaluate(() => document.getElementById('resetForm').requestSubmit());
  await page.waitForSelector('#resetSentState:not([hidden])');
  const storage = await page.evaluate(() => ({
    local: JSON.stringify(Object.entries(window.localStorage)),
    session: JSON.stringify(Object.entries(window.sessionStorage)),
    cookie: document.cookie,
  }));
  assert.equal(storage.local, '[]', 'localStorage vacío');
  assert.equal(storage.session, '[]', 'sessionStorage vacío');
  assert.equal(storage.cookie, '', 'sin cookies');
  assert.equal(page.url().includes('private.person'), false, 'el email no va en la URL');
  const joined = state.consoleLines.join(' | ');
  assert.equal(joined.includes('private.person@example.com'), false, 'el email no se imprime');
  await closeContext(context, state);
  console.log('PASS reset request persists no PII and prints nothing');
}

async function testResetRequestKeyboard(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  // Se llega al botón con el teclado y se activa con Enter.
  await page.focus('#forgotPasswordBtn');
  const outline = await page.evaluate(() => getComputedStyle(document.getElementById('forgotPasswordBtn')).outlineStyle);
  assert.notEqual(outline, 'none', 'el botón necesita foco visible');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#resetRequestState:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'resetEmailInput', 'el foco pasa al email');
  // Orden de tabulación en la vista de reset.
  const order = [];
  for (let i = 0; i < 2; i += 1) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement.id));
  }
  assert.deepEqual(order, ['resetSubmitButton', 'resetBackBtn'], `orden inesperado: ${order.join(' > ')}`);
  // Se envía con Enter desde el email.
  await page.focus('#resetEmailInput');
  await page.keyboard.type('user@example.com');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#resetSentState:not([hidden])');
  assert.equal(state.count('supabase:resetPasswordForEmail'), 1);
  assert.equal(state.first('supabase:resetPasswordForEmail').detail.redirectTo, RESET_REDIRECT);
  // Y se vuelve al login con Enter en el botón.
  await page.focus('#resetSentBackBtn');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#formState:not([hidden])');
  assert.equal(await page.inputValue('#resetEmailInput'), '', 'el email se limpia al volver');
  await closeContext(context, state);
  console.log('PASS reset request is fully keyboard operable with aria-live feedback');
}

async function testSubscriptionFlowStillWorksAfterReset(browser, baseUrl) {
  const { context, page, state } = await newPage(browser, VIEWPORTS[1], { managementURL: PORTAL }, baseUrl);
  // 1)_RESET completo y de vuelta al login.
  await openResetView(page);
  await page.fill('#resetEmailInput', 'user@example.com');
  await page.evaluate(() => document.getElementById('resetForm').requestSubmit());
  await page.waitForSelector('#resetSentState:not([hidden])');
  await page.click('#resetSentBackBtn');
  await page.waitForSelector('#formState:not([hidden])');
  // 2) Login + Customer Portal siguen funcionando igual.
  await fillCredentials(page);
  assert.deepEqual(await waitForPortal(state), [PORTAL]);
  assert.equal(state.count('supabase:signInWithPassword'), 1);
  assert.equal(state.count('rc:configure'), 1);
  assert.equal(state.count('rc:getCustomerInfo'), 1);
  assert.equal(state.first('rc:configure').detail.appUserId, UUID, 'RevenueCat sigue recibiendo el UUID de la sesión');
  assert.equal(state.count('rc:purchase'), 0);
  assert.equal(state.count('rc:getOfferings'), 0);
  assert.equal(state.count('rc:restorePurchases'), 0);
  await closeContext(context, state);
  console.log('PASS subscription management still works after using the reset flow');
}

async function testResetPageUnchanged(browser, baseUrl) {
  // /reset-password/ sigue siendo la página que consume el callback, sin cambios.
  const resetPage = fs.readFileSync(path.join(ROOT, 'reset-password', 'index.html'), 'utf8');
  assert.match(resetPage, /hash/);
  assert.equal(/resetPasswordForEmail/.test(resetPage), false, '/reset-password/ no inicia solicitudes, solo consume el callback');
  assert.equal(/request-password-reset|resetRequestState/.test(resetPage), false);
  // Y sigue funcionando.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route((url) => url.hostname !== '127.0.0.1', (route) => route.abort());
  await page.goto(baseUrl + '/reset-password/');
  assert.equal(await page.isVisible('#invalidState'), true, 'sin token muestra el estado de enlace no válido');
  await context.close();
  console.log('PASS /reset-password/ is unchanged and still only consumes the callback');
}

async function testSiteLinks(browser, baseUrl) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl + '/support.html');
  const supportLinks = await page.locator('a[href="/manage-subscription/"]').allTextContents();
  assert.ok(supportLinks.includes('Manage subscription'), `enlace visible en support: ${JSON.stringify(supportLinks)}`);
  // El funnel muestra el enlace secundario en success/handoff y la aclaración
  // del paywall.
  const funnelHtml = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
  assert.equal((funnelHtml.match(/<a href="\/manage-subscription\/">/g) || []).length, 2, 'enlace secundario en success y handoff');
  assert.match(funnelHtml, /Cancel anytime from your payment confirmation email or at brainyadhd\.com\/manage-subscription\/\./);
  await context.close();
  console.log('PASS site links Manage subscription from support and the funnel');
}

async function main() {
  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  const cases = [
    ['responsive', testResponsive],
    ['keyboard navigation', testKeyboardNavigation],
    ['success redirect', testSuccessRedirect],
    ['invalid credentials', testBadCredentials],
    ['missing managementURL', testNoManagementUrl],
    ['non-https rejected', testNonHttpsRejected],
    ['network error retry', testNetworkErrorRetry],
    ['query params ignored', testQueryParamsIgnored],
    ['double submit', testDoubleClickSingleLogin],
    ['no console leaks', testNoConsoleLeaks],
    ['no browser storage', testNoBrowserStorage],
    ['forgot does not navigate', testForgotDoesNotNavigate],
    ['reset request redirect exact', testResetRequestSendsExactRedirect],
    ['reset request generic response', testResetRequestGenericForExistingAndMissing],
    ['reset request invalid email', testResetRequestInvalidEmail],
    ['reset request double click', testResetRequestDoubleClick],
    ['reset request network retry', testResetRequestNetworkRetry],
    ['reset request no pii persisted', testResetRequestNoPiiPersisted],
    ['reset request keyboard', testResetRequestKeyboard],
    ['subscription flow after reset', testSubscriptionFlowStillWorksAfterReset],
    ['reset-password page unchanged', testResetPageUnchanged],
    ['site links', testSiteLinks],
  ];
  let passed = 0;
  try {
    for (const [name, run] of cases) {
      await run(browser, baseUrl);
      passed += 1;
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`manage-subscription UI: ${passed}/${cases.length} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});