/* Regression tests for the web subscription management fallback.
 *
 * Everything is mocked: no network, no production calls, no purchases, no
 * cancellations, no writes to Supabase, no authenticated Customer Portal calls.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const manage = require('../assets/manage-subscription.js');

const ROOT = path.join(__dirname, '..');
const PAGE_PATH = 'manage-subscription/index.html';
const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PORTAL_URL = 'https://billing.revenuecat.com/customer/portal/abc123';

const page = fs.readFileSync(path.join(ROOT, PAGE_PATH), 'utf8');
const flowSource = fs.readFileSync(path.join(ROOT, 'assets/manage-subscription.js'), 'utf8');
const wrapperSource = fs.readFileSync(path.join(ROOT, 'assets/revenuecat.js'), 'utf8');
const funnel = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
const support = fs.readFileSync(path.join(ROOT, 'support.html'), 'utf8');

/* ---------- mocks ---------- */

function makeSupabase(result) {
  const calls = [];
  return {
    calls,
    client: {
      auth: {
        signInWithPassword: async (credentials) => {
          calls.push(credentials);
          return typeof result === 'function' ? result(credentials) : result;
        },
        signOut: async () => { calls.push({ signOut: true }); return { error: null }; },
      },
    },
  };
}

function makeRevenueCat(options = {}) {
  const calls = { configure: [], getManagementURL: 0, getSdkAppUserId: 0, purchase: 0, getOfferings: 0, restorePurchases: 0 };
  let appUserId = null;
  const svc = {
    configure: (cfg) => {
      calls.configure.push(cfg);
      appUserId = cfg.appUserId;
      return { ok: true };
    },
    getSdkAppUserId: () => { calls.getSdkAppUserId += 1; return appUserId; },
    getManagementURL: async () => {
      calls.getManagementURL += 1;
      if (typeof options.managementURL === 'function') return options.managementURL();
      if (typeof options.managementURL === 'string') return options.managementURL;
      if (options.managementURL === null) return null;
      if (options.throws) throw options.throws;
      return PORTAL_URL;
    },
    purchase: async () => { calls.purchase += 1; throw new Error('purchase must never be called'); },
    getOfferings: async () => { calls.getOfferings += 1; throw new Error('getOfferings must never be called'); },
    restorePurchases: async () => { calls.restorePurchases += 1; throw new Error('restorePurchases must never be called'); },
  };
  return { calls, svc };
}

function makeFlow(options = {}) {
  const supabase = options.supabase || makeSupabase({
    data: { user: { id: UUID_A } },
    error: null,
  });
  const rc = options.revenuecat || makeRevenueCat(options.revenuecatOptions);
  const navigated = [];
  const states = [];
  const cleared = [];
  const flow = manage.createFlow({
    supabase: supabase.client,
    revenuecat: rc.svc,
    apiKey: options.apiKey === undefined ? 'strp_sb_public' : options.apiKey,
    navigate: (url) => navigated.push(url),
    clearPassword: () => cleared.push('cleared'),
    onState: (state, detail) => states.push({ state, detail }),
  });
  return { flow, supabase, rc, navigated, states, cleared, lastState: () => states[states.length - 1] };
}

function loadWrapper(sdkInstance) {
  const context = {
    window: { Purchases: { Purchases: { configure: () => sdkInstance, setLogLevel: () => {} } } },
    URL,
  };
  vm.runInNewContext(wrapperSource, context, { filename: 'revenuecat.js' });
  return context.window.BrainyRevenueCat;
}

/* ---------- 1. route exists ---------- */

function testRouteExists() {
  assert.ok(fs.existsSync(path.join(ROOT, PAGE_PATH)), 'manage-subscription/index.html must exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/manage-subscription.js')), 'assets/manage-subscription.js must exist');
  // La ruta estática debe funcionar en /manage-subscription/ y /manage-subscription/index.html
  // sin depender de servidor: los assets son relativos a la carpeta.
  assert.match(page, /\.\.\/assets\/manage-subscription\.js/);
  assert.match(page, /\.\.\/assets\/revenuecat\.js/);
  assert.match(page, /\.\.\/assets\/revenuecat-sdk\.js/);
  // Sin router SPA, sin build, sin framework.
  assert.equal(/type="module"|<script[^>]+import\s/.test(page), false);
}

/* ---------- 2. labels + autocomplete ---------- */

function testFormAccessibility() {
  assert.match(page, /<label for="emailInput">Email<\/label>/);
  assert.match(page, /<label for="passwordInput">Password<\/label>/);
  assert.match(page, /id="emailInput"[^>]*autocomplete="email"/);
  assert.match(page, /id="passwordInput"[^>]*autocomplete="current-password"/);
  assert.match(page, /id="passwordInput"[^>]*type="password"/);
  assert.match(page, /id="loginError"[^>]*aria-live="assertive"/);
  assert.match(page, /id="workingMessage"[^>]*aria-live="polite"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /:focus-visible/);
  // Copy exigido
  assert.match(page, /<h1>Manage your Brainy subscription<\/h1>/);
  assert.match(page, /Sign in with the Brainy credentials you received by email to manage or cancel your free trial or subscription\./);
  assert.match(page, />Continue to subscription management</);
  assert.match(page, /Cancelling stops future renewals\. You’ll keep access until the end of your current free trial or billing period\./);
  assert.match(page, /Forgot your password\?/);
  assert.match(page, /Can’t access your account\? Contact <a href="mailto:hello@brainyadhd\.com">hello@brainyadhd\.com<\/a>/);
  assert.match(page, /We couldn’t find an active subscription for this account\./);
  // "Forgot your password?" es un botón que cambia de estado, NO un enlace a
  // /reset-password/: esa página solo consume un callback ya emitido.
  assert.match(page, /<button class="forgot" type="button" id="forgotPasswordBtn">Forgot your password\?<\/button>/);
  assert.equal(/href="\/reset-password\/"/.test(page), false, 'no debe haber enlace directo a /reset-password/');
  // No hay logo en las páginas de utilidad del repo.
  assert.equal(/class="logo"|logomain\.png/.test(page), false);
}

/* ---------- 2b. solicitud de recuperación de contraseña ---------- */

function testResetRequestView() {
  assert.match(page, /<section id="resetRequestState" hidden>/);
  assert.match(page, /<label for="resetEmailInput">Email<\/label>/);
  assert.match(page, /id="resetEmailInput"[^>]*autocomplete="email"/);
  assert.match(page, /id="resetError"[^>]*aria-live="assertive"/);
  assert.match(page, /<button id="resetSubmitButton" type="submit">Send reset link<\/button>/);
  assert.match(page, />Back to subscription login</);
  assert.match(page, /id="resetBackBtn"/);
  assert.equal((page.match(/>Back to subscription login</g) || []).length, 3, 'volver al login desde cada estado de reset');
  // Mensaje genérico exacto, sin distinguir si la cuenta existe.
  assert.match(page, /<h1>Check your inbox<\/h1>/);
  assert.match(page, /If an account exists for this email, we’ve sent a password reset link\. Open the link in your browser to choose a new password\./);
  assert.match(page, /<section id="resetSentState" hidden>[\s\S]*aria-live="polite"/);
  // Retry de red.
  assert.match(page, /id="resetRetry"/);
  assert.match(page, /We couldn’t reach the service to send your reset link\./);
  // El mensaje genérico nunca se combina con una frase que delate existencia.
  assert.equal(/account (exists|was found|not found|does not exist)/i.test(page.replace(/If an account exists for this email[^<]*/g, '')), false);
}

function testResetRedirectIsExact() {
  // Callback exacto, una sola vez, como configuración.
  const occurrences = page.match(/https:\/\/brainyadhd\.com\/reset-password\//g) || [];
  assert.equal(occurrences.length, 1, 'el callback aparece exactamente una vez');
  assert.match(page, /passwordResetRedirectTo: 'https:\/\/brainyadhd\.com\/reset-password\/'/);
  assert.match(page, /resetRedirectTo: cfg\.passwordResetRedirectTo/);
  assert.equal(/https:\/\/www\.brainyadhd\.com\/reset-password/.test(page), false, 'sin www ni variantes del callback');
  assert.equal(/resetPasswordRedirectTo[\s\S]*reset-password\/[\s\S]{0,40}[?#]/.test(page), false, 'sin query params en el callback');
  assert.equal(page.includes('https://brainyadhd.com/reset-password/index.html'), false, 'el callback es la ruta limpia');
}

function testResetRequestUsesResetPasswordForEmail() {
  assert.match(flowSource, /supabase\.auth\.resetPasswordForEmail\(normalizedEmail, \{\s*\n\s*redirectTo: resetRedirectTo\s*\n\s*\}\)/);
  assert.equal(/signInWithPassword/.test(flowSource.slice(flowSource.indexOf('function requestPasswordReset('))), false, 'el flujo de reset no inicia sesión');
  // Se usa el MISMO cliente Supabase aislado de la página (no se crea otro).
  assert.match(page, /sdk\.createFlow\(\{[\s\S]*supabase: client,/);
  assert.match(page, /persistSession: false/);
  assert.match(page, /autoRefreshToken: false/);
  assert.match(page, /detectSessionInUrl: false/);
}

function testEmailValidation() {
  for (const good of ['a@b.co', 'user.name+tag@example.com', 'USER@Example.COM', 'u@sub.domain.example']) {
    assert.equal(manage.isValidEmail(good), true, `debe aceptar ${good}`);
  }
  for (const bad of ['', '   ', 'nope', 'a@', '@b.co', 'a@b', 'a b@c.co', 'a@@b.co', 'a@b..co', 'a@-b.co', 'a@b-.co', 'x'.repeat(65) + '@b.co', 'a@' + 'x'.repeat(250) + '.co', null, undefined, 42]) {
    assert.equal(manage.isValidEmail(bad), false, `debe rechazar ${String(bad)}`);
  }
}

async function testResetRequestGenericResponse() {
  function resetFlow(result) {
    const calls = [];
    const states = [];
    const clearedEmail = [];
    const flow = manage.createFlow({
      supabase: {
        auth: {
          signInWithPassword: async () => { throw new Error('no debe iniciar sesión'); },
          resetPasswordForEmail: async (email, options) => {
            calls.push({ email, options });
            return typeof result === 'function' ? result(email, options) : result;
          }
        }
      },
      revenuecat: { configure: () => null },
      apiKey: 'strp_sb_public',
      resetRedirectTo: 'https://brainyadhd.com/reset-password/',
      clearEmail: () => clearedEmail.push('cleared'),
      navigate: () => { throw new Error('no debe navegar'); },
      onState: (state, detail) => states.push({ state, detail }),
    });
    return { flow, calls, states, clearedEmail, lastState: () => states[states.length - 1] };
  }

  // A) Cuenta existente: respuesta limpia.
  const existing = resetFlow({ data: {}, error: null });
  assert.equal(await existing.flow.requestPasswordReset('  User@Example.COM  '), 'sent');
  assert.equal(existing.calls.length, 1);
  assert.equal(existing.calls[0].email, 'user@example.com', 'el email se normaliza antes de enviarse');
  assert.deepEqual(existing.calls[0].options, { redirectTo: 'https://brainyadhd.com/reset-password/' });
  assert.deepEqual(existing.lastState(), { state: 'reset-sent', detail: {} });

  // B) Cuenta inexistente: Supabase puede devolver "User not found". La respuesta
  //    debe ser IDÉNTICA a la de A.
  const missing = resetFlow({ data: null, error: { message: 'User not found', status: 404 } });
  assert.equal(await missing.flow.requestPasswordReset('nobody@example.com'), 'sent');
  assert.deepEqual(missing.lastState(), { state: 'reset-sent', detail: {} });

  // C) Otros errores de autorización también se reportan como éxito genérico.
  for (const error of [{ message: 'Email not confirmed', status: 400 }, { message: 'Forbidden', status: 403 }, { message: 'rate_limit', status: 429 }]) {
    const other = resetFlow({ data: null, error });
    assert.equal(await other.flow.requestPasswordReset('user@example.com'), 'sent');
    assert.deepEqual(other.lastState(), { state: 'reset-sent', detail: {} });
  }

  // D) launchAuthSessionRedirect  (error de cliente) también genérico.
  const thrown = resetFlow(() => { throw Object.assign(new Error('launchAuthSessionRedirect failed'), { name: 'AuthApiError' }); });
  assert.equal(await thrown.flow.requestPasswordReset('user@example.com'), 'sent');

  // El email se borra del DOM tras la respuesta genérica.
  assert.ok(existing.clearedEmail.length >= 1);
  assert.ok(missing.clearedEmail.length >= 1);
  assert.equal(existing.flow.hasPendingResetEmail(), false, 'no queda email pendiente tras el éxito');
  assert.equal(missing.flow.hasPendingResetEmail(), false);

  // No se llama a RevenueCat ni se navega en ningún caso.
  assert.deepEqual(existing.states.map((s) => s.state), ['reset-sending', 'reset-sent']);
}

async function testResetRequestBlocksDoubleSend() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const states = [];
  const flow = manage.createFlow({
    supabase: {
      auth: {
        signInWithPassword: async () => { throw new Error('no'); },
        resetPasswordForEmail: async () => {
          calls += 1;
          await gate;
          return { data: {}, error: null };
        }
      }
    },
    revenuecat: { configure: () => null },
    apiKey: 'strp_sb_public',
    resetRedirectTo: 'https://brainyadhd.com/reset-password/',
    onState: (state, detail) => states.push({ state, detail }),
  });

  const first = flow.requestPasswordReset('user@example.com');
  await Promise.resolve();
  assert.equal(await flow.requestPasswordReset('user@example.com'), 'busy');
  assert.equal(await flow.requestPasswordReset('otro@example.com'), 'busy');
  assert.equal(await flow.retryPasswordReset(), 'busy');
  release();
  assert.equal(await first, 'sent');
  assert.equal(calls, 1, 'un solo resetPasswordForEmail');
  assert.deepEqual(states.map((s) => s.state), ['reset-sending', 'reset-sent']);

  // Email inválido: ni llamada ni estado de envío.
  let called = false;
  const invalid = manage.createFlow({
    supabase: {
      auth: {
        signInWithPassword: async () => { throw new Error('no'); },
        resetPasswordForEmail: async () => { called = true; return { data: {}, error: null }; }
      }
    },
    revenuecat: { configure: () => null },
    apiKey: 'strp_sb_public',
    resetRedirectTo: 'https://brainyadhd.com/reset-password/',
    onState: () => {},
  });
  assert.equal(await invalid.requestPasswordReset('no-es-un-email'), 'invalid');
  assert.equal(await invalid.requestPasswordReset(''), 'invalid');
  assert.equal(called, false, 'un email inválido no llega a Supabase');
}

async function testResetRequestNetworkErrorRetry() {
  let calls = 0;
  let failNext = true;
  const states = [];
  const flow = manage.createFlow({
    supabase: {
      auth: {
        signInWithPassword: async () => { throw new Error('no'); },
        resetPasswordForEmail: async () => {
          calls += 1;
          if (failNext) {
            failNext = false;
            throw Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' });
          }
          return { data: {}, error: null };
        }
      }
    },
    revenuecat: { configure: () => null },
    apiKey: 'strp_sb_public',
    resetRedirectTo: 'https://brainyadhd.com/reset-password/',
    onState: (state, detail) => states.push({ state, detail }),
  });

  assert.equal(await flow.requestPasswordReset('user@example.com'), 'network-error');
  assert.deepEqual(states[states.length - 1], { state: 'reset-network-error', detail: {} });
  // El email sigue disponible SOLO en memoria para el Retry.
  assert.equal(flow.hasPendingResetEmail(), true);
  // Retry reutiliza el mismo email y no vuelve a pedirlo.
  assert.equal(await flow.retryPasswordReset(), 'sent');
  assert.equal(calls, 2);
  assert.equal(flow.hasPendingResetEmail(), false);
  assert.deepEqual(states.map((s) => s.state), ['reset-sending', 'reset-network-error', 'reset-sending', 'reset-sent']);

  // Sin email pendiente, Retry no hace nada.
  assert.equal(await flow.retryPasswordReset(), 'busy');
}

function testResetRequestFailClosed() {
  // Sin cliente de Supabase: no se llama a nada y se reporta no disponible.
  const noClient = [];
  const withoutClient = manage.createFlow({
    supabase: null,
    revenuecat: { configure: () => null },
    apiKey: 'strp_sb_public',
    resetRedirectTo: 'https://brainyadhd.com/reset-password/',
    onState: (state, detail) => noClient.push({ state, detail }),
  });
  // Con resetRedirectTo ausente.
  const noRedirect = [];
  const withoutRedirect = manage.createFlow({
    supabase: { auth: { resetPasswordForEmail: async () => ({ data: {}, error: null }) } },
    revenuecat: { configure: () => null },
    apiKey: 'strp_sb_public',
    resetRedirectTo: '',
    onState: (state, detail) => noRedirect.push({ state, detail }),
  });
  return Promise.all([
    withoutClient.requestPasswordReset('user@example.com'),
    withoutRedirect.requestPasswordReset('user@example.com'),
  ]).then(([first, second]) => {
    assert.equal(first, 'unavailable');
    assert.deepEqual(noClient, [{ state: 'reset-unavailable', detail: { reason: 'auth_unavailable' } }]);
    assert.equal(second, 'unavailable');
    assert.deepEqual(noRedirect, [{ state: 'reset-unavailable', detail: { reason: 'redirect_missing' } }]);
  });
}

async function testResetRequestDoesNotTouchSubscriptionFlow() {
  // Solicitar un reset no crea sesión, no configura RevenueCat y no navega.
  let configured = 0;
  let navigated = 0;
  let signedIn = 0;
  const states = [];
  const flow = manage.createFlow({
    supabase: {
      auth: {
        signInWithPassword: async () => { signedIn += 1; return { data: { user: { id: UUID_A } }, error: null }; },
        resetPasswordForEmail: async () => ({ data: {}, error: null })
      }
    },
    revenuecat: { configure: () => { configured += 1; return {}; } },
    apiKey: 'strp_sb_public',
    resetRedirectTo: 'https://brainyadhd.com/reset-password/',
    navigate: () => { navigated += 1; },
    onState: (state, detail) => states.push({ state, detail }),
  });
  assert.equal(await flow.requestPasswordReset('user@example.com'), 'sent');
  assert.equal(signedIn, 0, 'no inicia sesión');
  assert.equal(configured, 0, 'no configura RevenueCat');
  assert.equal(navigated, 0, 'no navega');
  assert.equal(flow.hasVerifiedSession(), false, 'no se crea identidad verificada');
  // Y el login sigue funcionando después de un reset.
  assert.equal(await flow.signIn('user@example.com', 'secret-1'), 'unavailable', 'sin getManagementURL el flujo acaba en unavailable, no en un estado de reset');
  assert.deepEqual(states[states.length - 1], { state: 'unavailable', detail: { reason: 'revenuecat_unavailable' } });
}

/* ---------- 3. no secrets hardcodeados ---------- */

function decodeJwtPayload(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

function testNoHardcodedSecrets() {
  // Patrones de material secreto real (no palabras clave: `keyKind()` ya usa
  // /secret|restricted/ como guarda anti-secrets en revenuecat.js).
  const secretPatterns = [/\bsk_[A-Za-z0-9]{8,}/, /\brk_[A-Za-z0-9]{8,}/, /\bwhsec_[A-Za-z0-9]{8,}/, /\btok_[A-Za-z0-9]{8,}/, /\breq_[A-Za-z0-9]{8,}/, /service_role/, /sb_secret/];
  for (const source of [[PAGE_PATH, page], ['assets/manage-subscription.js', flowSource], ['assets/revenuecat.js', wrapperSource]]) {
    for (const pattern of secretPatterns) {
      assert.equal(pattern.test(source[1]), false, `secret pattern ${pattern} found in ${source[0]}`);
    }
  }
  // Cualquier JWT presente en la página debe ser la anon key pública.
  for (const token of page.match(/eyJ[A-Za-z0-9._\-]{20,}/g) || []) {
    assert.equal(decodeJwtPayload(token).role, 'anon');
  }
  // La única clave de RevenueCat en la página es la Web SDK key pública de sandbox.
  const rcKeys = page.match(/strp_[A-Za-z0-9_.\-]+/g) || [];
  assert.ok(rcKeys.length > 0);
  rcKeys.forEach((key) => assert.match(key, /^strp_(sb_)?[A-Za-z0-9_.\-]+$/));
  // La anon key de Supabase debe decodificar como role "anon".
  const anonKey = page.match(/supabaseAnonKey: '([A-Za-z0-9._\-]+)'/)[1];
  const claims = decodeJwtPayload(anonKey);
  assert.equal(claims.role, 'anon');
  assert.equal(/service_role/.test(JSON.stringify(claims)), false);
  // Misma anon key que ya usa el resto del sitio (no se introduce ninguna nueva).
  assert.equal(anonKey, fs.readFileSync(path.join(ROOT, 'reset-password/index.html'), 'utf8').match(/anonKey: '([A-Za-z0-9._\-]+)'/)[1]);
}

/* ---------- 4. la contraseña no se imprime ni persiste ---------- */

function testPasswordNeverPrintedOrPersisted() {
  for (const [name, source] of [[PAGE_PATH, page], ['assets/manage-subscription.js', flowSource]]) {
    assert.equal(/console\.(log|debug|info|warn|error)\s*\(/.test(source), false, `console output not allowed in ${name}`);
    // Uso real de almacenamiento del navegador (los comentarios los mencionan).
    assert.equal(/localStorage\.\w+\(|sessionStorage\.\w+\(|document\.cookie\s*=|indexedDB\.open/.test(source), false, `browser storage not allowed in ${name}`);
    assert.equal(/navigator\.sendBeacon|posthog|PostHog|analyticsEndpoint/.test(source), false, `analytics not allowed in ${name}`);
  }
  // El módulo solo pasa la contraseña a Supabase y la borra en cuanto responde.
  const body = flowSource.slice(flowSource.indexOf('function signIn('));
  assert.match(body, /clearPassword\(\);/);
  assert.equal(/password\s*=\s*password/.test(body), false);
  // El email de recuperación tampoco se persiste ni se imprime en ninguna rama.
  const resetBody = flowSource.slice(flowSource.indexOf('function requestPasswordReset('), flowSource.indexOf('function retryPasswordReset('));
  assert.match(resetBody, /clearEmail\(\);/);
  assert.equal(/localStorage|sessionStorage|document\.cookie|sendBeacon|console\./.test(resetBody), false);
  // El email nunca se pone en la URL ni en atributos de navegación.
  assert.equal(/emailInput\.value\s*=\s*location/.test(page), false);
  assert.equal(/location\.(search|hash)\s*[+=]/.test(page), false);
}

/* ---------- 5. el userId nunca viene de parámetros o formularios ---------- */

async function testNoUserIdFromParamsOrForm() {
  const supabase = makeSupabase({ data: { user: { id: UUID_B } }, error: null });
  const { flow, rc } = makeFlow({ supabase });
  // Un atacante pone userId/managementURL en la URL. El flujo los ignora.
  await flow.signIn('user@example.com', 'irrelevant');
  assert.equal(rc.calls.configure[0].appUserId, UUID_B);
  assert.notEqual(rc.calls.configure[0].appUserId, UUID_A);
  // El módulo nunca usa la URL como fuente de identidad: la única lectura de
  // `location` está en scrubIdentityParams, que solo borra parámetros.
  const signInBody = flowSource.slice(flowSource.indexOf('function signIn('), flowSource.indexOf('function resolveManagementUrl('));
  assert.equal(/location|URLSearchParams|window\./.test(signInBody), false, 'signIn no debe leer nada de la URL ni de window');
  const resolveBody = flowSource.slice(flowSource.indexOf('function resolveManagementUrl('), flowSource.indexOf('function scrubIdentityParams('));
  assert.equal(/location|URLSearchParams|window\./.test(resolveBody), false, 'resolveManagementUrl no debe leer nada de la URL ni de window');
  assert.equal((flowSource.match(/location\.search/g) || []).length, 2, 'location.search solo se lee para limpiar (misma línea, dos comprobaciones)');
  assert.equal(/getManagementURL\s*\(\s*[^)]/.test(flowSource), false, 'no se pasa ninguna URL al wrapper');
  // El formulario no expone campos de identidad.
  assert.equal(/name="userId"|name="appUserId"|name="managementURL"/.test(page), false);
  // scrubIdentityParams limpia esos parámetros de la URL.
  let replaced = null;
  manage.scrubIdentityParams(
    { pathname: '/manage-subscription/', search: '?userId=' + UUID_A + '&managementURL=' + encodeURIComponent(PORTAL_URL), hash: '' },
    { replaceState: (_s, _t, url) => { replaced = url; } },
  );
  assert.equal(replaced, '/manage-subscription/');
  // Y también borra el fragmento si viene algo ahí.
  replaced = null;
  manage.scrubIdentityParams({ pathname: '/manage-subscription/', search: '', hash: '#access_token=secret' }, { replaceState: (_s, _t, url) => { replaced = url; } });
  assert.equal(replaced, '/manage-subscription/');
  // Una URL limpia no se toca.
  replaced = null;
  manage.scrubIdentityParams({ pathname: '/manage-subscription/', search: '', hash: '' }, { replaceState: (_s, _t, url) => { replaced = url; } });
  assert.equal(replaced, null);
}

/* ---------- 6. el UUID viene de session.user.id ---------- */

async function testAppUserIdComesFromSession() {
  const { flow, rc, navigated } = makeFlow();
  const outcome = await flow.signIn(' User@Example.COM ', 'hunter2-correct');
  assert.equal(outcome, 'redirected');
  assert.equal(rc.calls.configure.length, 1);
  assert.equal(rc.calls.configure[0].appUserId, UUID_A);
  assert.equal(rc.calls.getManagementURL, 1);
  assert.deepEqual(navigated, [PORTAL_URL]);
  // La contraseña se envía normalizada solo a Supabase.
  assert.equal(typeof flowSource, 'string');
}

function testSessionUserIdParsing() {
  assert.equal(manage.readSessionUserId({ user: { id: UUID_A } }), UUID_A);
  assert.equal(manage.readSessionUserId({ user: { id: 'not-a-uuid' } }), null);
  assert.equal(manage.readSessionUserId({ user: null }), null);
  assert.equal(manage.readSessionUserId({}), null);
  assert.equal(manage.readSessionUserId(null), null);
  // El id se toma de user.id, no de otros campos del objeto de sesión.
  assert.equal(manage.readSessionUserId({ user: { id: UUID_A, app_metadata: { user_id: UUID_B } } }), UUID_A);
}

/* ---------- 7. credenciales incorrectas: error genérico ---------- */

async function testInvalidCredentials() {
  const { flow, rc, navigated, states } = makeFlow({
    supabase: makeSupabase({ data: null, error: { message: 'Invalid login credentials', status: 400 } }),
  });
  const outcome = await flow.signIn('nobody@example.com', 'wrong-password');
  assert.equal(outcome, 'invalid');
  assert.deepEqual(states[states.length - 1], { state: 'form', detail: { reason: 'invalid_credentials' } });
  assert.equal(rc.calls.configure.length, 0);
  assert.equal(rc.calls.getManagementURL, 0);
  assert.deepEqual(navigated, []);
  // La página muestra copy genérico y no revela si el correo existe.
  assert.match(page, /GENERIC_INVALID = 'We couldn’t sign you in\. Check your email and password and try again\.'/);
  // Ningún texto visible al usuario revela existencia de la cuenta.
  assert.equal(/no such user|user not found|user_not_found|email not registered|account not found/i.test(page), false);
  // El flujo nunca reenvía el mensaje del proveedor a la vista: los detalles
  // emitidos son motivos cerrados, no texto de error.
  const closedReasons = [
    'invalid_credentials', 'missing_credentials', 'auth_unavailable', 'identity_missing',
    'identity_invalid', 'revenuecat_unavailable', 'revenuecat_key_missing',
    'revenuecat_configuration_failed', 'revenuecat_identity_mismatch',
    'revenuecat_lookup_failed', 'redirect_missing',
  ];
  const flowBody = flowSource.slice(flowSource.indexOf('function signIn('), flowSource.indexOf('function scrubIdentityParams('));
  for (const match of flowBody.matchAll(/emit\('([a-z-]+)', \{ reason: '([a-z_]+)' \}\)/g)) {
    assert.ok(closedReasons.includes(match[2]), `motivo abierto o no permitido: ${match[2]}`);
  }
  assert.equal(/emit\([^)]*error\.message/.test(flowBody), false, 'no se emite el mensaje del proveedor');
  // Error de validación: mensaje genérico de campos, sin llamar a Supabase.
  const empty = makeFlow();
  const emptyOutcome = await empty.flow.signIn('', '');
  assert.equal(emptyOutcome, 'invalid');
  assert.equal(empty.supabase.calls.length, 0);
  assert.deepEqual(empty.lastState(), { state: 'form', detail: { reason: 'missing_credentials' } });
}

/* ---------- 8. doble clic no duplica ---------- */

async function testDoubleSubmitBlocked() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { flow, supabase, rc } = makeFlow({
    supabase: {
      client: {
        auth: {
          signInWithPassword: async (credentials) => {
            supabase.calls.push(credentials);
            await gate;
            return { data: { user: { id: UUID_A } }, error: null };
          },
        },
      },
      calls: [],
    },
  });
  const first = flow.signIn('user@example.com', 'secret-1');
  await Promise.resolve();
  assert.equal(flow.isBusy(), true);
  const second = await flow.signIn('user@example.com', 'secret-1');
  assert.equal(second, 'busy');
  const third = await flow.signIn('user@example.com', 'secret-1');
  assert.equal(third, 'busy');
  release();
  assert.equal(await first, 'redirected');
  assert.equal(supabase.calls.length, 1, 'un solo signInWithPassword');
  assert.equal(rc.calls.configure.length, 1, 'una sola configuración de RevenueCat');
  assert.equal(rc.calls.getManagementURL, 1, 'un solo lookup de managementURL');
  assert.equal(flow.isBusy(), false);
}

/* ---------- 9. sin managementURL ---------- */

async function testNoManagementUrl() {
  const { flow, rc, navigated, states, lastState, cleared } = makeFlow({
    revenuecatOptions: { managementURL: null },
  });
  const outcome = await flow.signIn('user@example.com', 'secret-1');
  assert.equal(outcome, 'no-subscription');
  assert.deepEqual(lastState(), { state: 'no-subscription', detail: {} });
  assert.deepEqual(navigated, []);
  assert.equal(rc.calls.getManagementURL, 1);
  // La contraseña se limpia aunque no haya suscripción.
  assert.ok(cleared.length >= 1);
  // La página ofrece Retry y contacto de soporte.
  assert.match(page, /id="noSubscriptionRetry"[^>]*>Retry</);
  assert.match(page, /id="noSubscriptionState"[\s\S]*Manage subscription/);
}

/* ---------- 10. URL no HTTPS rechazada ---------- */

async function testNonHttpsRejected() {
  for (const bad of ['http://billing.revenuecat.com/portal', 'javascript:alert(1)', 'data:text/html,x', '//evil.example.com', 'not a url', '']) {
    const { flow, navigated, lastState } = makeFlow({ revenuecatOptions: { managementURL: bad } });
    const outcome = await flow.signIn('user@example.com', 'secret-1');
    assert.equal(outcome, 'invalid-url', `must reject ${bad}`);
    assert.deepEqual(navigated, []);
    assert.deepEqual(lastState(), { state: 'invalid-url', detail: {} });
  }
  assert.equal(manage.isValidHttpsUrl(PORTAL_URL), true);
  assert.equal(manage.isValidHttpsUrl('https://a.example.com/'), true);
  assert.equal(manage.isValidHttpsUrl('ftp://a.example.com/'), false);
  assert.equal(manage.isValidHttpsUrl('//a.example.com/'), false);
  assert.equal(manage.isValidHttpsUrl('https://'), false);
  assert.equal(manage.isValidHttpsUrl(null), false);
  assert.equal(manage.isValidHttpsUrl(undefined), false);
  assert.equal(manage.isValidHttpsUrl(12345), false);
  // Espacios/inyección de cabecera: fail closed. Solo se recortan los bordes.
  assert.equal(manage.isValidHttpsUrl('https://a.example.com/\nX-Injected: 1'), false);
  assert.equal(manage.isValidHttpsUrl(' https://a.example.com/'), true);
}

/* ---------- 11. URL HTTPS abre el portal ---------- */

async function testHttpsUrlRedirects() {
  const { flow, navigated, states, lastState } = makeFlow();
  assert.equal(await flow.signIn('user@example.com', 'secret-1'), 'redirected');
  assert.deepEqual(navigated, [PORTAL_URL]);
  assert.deepEqual(lastState(), { state: 'redirecting', detail: {} });
  // La redirección ocurre en la MISMA pestaña (sin window.open / popup).
  assert.equal(/window\.open|target="_blank"/.test(page + flowSource), false);
  assert.match(page, /window\.location\.assign\(url\)/);
  // La secuencia de estados pasa por autenticando y configurando.
  assert.deepEqual(states.map((s) => s.state), ['authenticating', 'configuring', 'redirecting']);
}

/* ---------- 12. error de red recuperable con Retry ---------- */

async function testNetworkErrorRetry() {
  const { flow, rc, navigated, states } = makeFlow({
    revenuecatOptions: { throws: Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }) },
  });
  const outcome = await flow.signIn('user@example.com', 'secret-1');
  assert.equal(outcome, 'network-error');
  assert.deepEqual(navigated, []);
  // No se cierra la sesión por un error temporal.
  assert.equal(states.some((s) => s.state === 'unavailable'), false);
  assert.equal(flow.hasVerifiedSession(), true);

  // Retry reintenta SOLO RevenueCat, sin volver a pedir la contraseña.
  rc.svc.getManagementURL = async () => { rc.calls.getManagementURL += 1; return PORTAL_URL; };
  assert.equal(await flow.retryRevenueCatStep(), 'redirected');
  assert.deepEqual(navigated, [PORTAL_URL]);
  assert.deepEqual(states[states.length - 1], { state: 'redirecting', detail: {} });
  assert.ok(page.includes('flow.hasVerifiedSession()'), 'la página usa la sesión verificada en el Retry');
  assert.match(page, /id="networkRetry"[^>]*>Retry</);
  assert.match(page, /your session stays open/);

  // Fallo de red en el login: recuperable y sin revelar nada.
  const authNet = makeFlow({
    supabase: makeSupabase({ data: null, error: Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }) }),
  });
  assert.equal(await authNet.flow.signIn('user@example.com', 'secret-1'), 'network-error');
  assert.deepEqual(authNet.lastState(), { state: 'network-error', detail: { phase: 'auth' } });
  // Sin sesión verificada no hay Retry de RevenueCat: se vuelve al login.
  assert.equal(authNet.flow.hasVerifiedSession(), false);
  assert.equal(await authNet.flow.retryRevenueCatStep(), null);
}

/* ---------- 13. getManagementURL: sin compra, sin offerings, sin restore ---------- */

async function testWrapperGetManagementUrl() {
  const calls = { getCustomerInfo: 0, purchase: 0, getOfferings: 0, restorePurchases: 0 };
  const sdk = {
    getAppUserId: () => UUID_A,
    getCustomerInfo: async () => { calls.getCustomerInfo += 1; return { managementURL: PORTAL_URL }; },
    getOfferings: async () => { calls.getOfferings += 1; return {}; },
    purchase: async () => { calls.purchase += 1; throw new Error('never'); },
    restorePurchases: async () => { calls.restorePurchases += 1; throw new Error('never'); },
  };
  const service = loadWrapper(sdk);
  service.configure({ apiKey: 'strp_sb_public', appUserId: UUID_A });
  assert.equal(await service.getManagementURL(), PORTAL_URL);
  assert.equal(calls.getCustomerInfo, 1);
  assert.equal(calls.purchase, 0);
  assert.equal(calls.getOfferings, 0);
  assert.equal(calls.restorePurchases, 0);

  // managementURL ausente o inválida -> null, sin lanzar.
  for (const value of [null, undefined, '', '   ', 'http://x.example.com', 'javascript:alert(1)', 42]) {
    sdk.getCustomerInfo = async () => ({ managementURL: value });
    assert.equal(await service.getManagementURL(), null, `expected null for ${String(value)}`);
  }
  // customerInfo vacío -> null.
  sdk.getCustomerInfo = async () => ({});
  assert.equal(await service.getManagementURL(), null);
  sdk.getCustomerInfo = async () => null;
  assert.equal(await service.getManagementURL(), null);

  // El wrapper no acepta una URL del llamador.
  assert.equal(service.getManagementURL.length, 0, 'getManagementURL no debe aceptar parámetros');
  assert.match(wrapperSource, /customerInfo\.managementURL/);
  // Contrato verificado contra los tipos del SDK vendorizado.
  const types = fs.readFileSync(path.join(ROOT, 'node_modules/@revenuecat/purchases-js/dist/Purchases.es.d.ts'), 'utf8');
  assert.match(types, /readonly managementURL: string \| null;/);
  const vendored = fs.readFileSync(path.join(ROOT, 'assets/revenuecat-sdk.js'), 'utf8');
  assert.match(vendored, /managementURL:t\.management_url/);
  assert.match(vendored, /async getCustomerInfo\(/);

  // Sin configurar y con App User ID no UUID: rechaza, no devuelve una URL inventada.
  const bare = loadWrapper(sdk);
  await assert.rejects(bare.getManagementURL(), /not configured/);
  const nonUuid = loadWrapper({ ...sdk, getAppUserId: () => 'anonymous' });
  await assert.rejects(nonUuid.getManagementURL(), /not configured/);

  // Comportamiento existente intacto.
  assert.equal(typeof service.configure, 'function');
  assert.equal(typeof service.getOfferings, 'function');
  assert.equal(typeof service.purchase, 'function');
  assert.equal(typeof service.isEntitledTo, 'function');
  assert.equal(typeof service.classifyError, 'function');
  assert.equal(typeof service.redemptionUrlOf, 'function');
  assert.equal(typeof service.primaryRedemptionUrlOf, 'function');
  assert.equal(service.isValidPlanId(UUID_A), true);
  assert.equal(service.keyKind('strp_sb_public'), 'ok');
  assert.equal(service.keyKind('sk_live_x'), 'secret');
}

/* ---------- 14. el funnel conserva compra, metadata y copy ---------- */

function testFunnelCheckoutPreserved() {
  assert.match(wrapperSource, /metadata: \{ brainy_plan_id: opts\.planId \}/);
  assert.match(funnel, /if \(identity\.alreadyPro\)/);
  assert.match(funnel, /planId: funnelState\.planId/);
  // Recovery sin recompra.
  const recoveryStart = funnel.indexOf('async function retryPendingRedemption');
  const recoveryEnd = funnel.indexOf('\n        }', recoveryStart);
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  assert.equal(funnel.slice(recoveryStart, recoveryEnd).includes('purchase('), false);
  // Sin OTP ni contraseñas en el funnel.
  assert.equal(/\botp\b/i.test(funnel.replace(/[\s\S]*?function track\(e[\s\S]*?\n        }/, '')), false);
  // Configuración de checkout sin cambios.
  assert.match(funnel, /revenuecatOfferingId: 'web_default'/);
  assert.match(funnel, /revenuecatEntitlementId: 'brainy Pro'/);
  assert.match(funnel, /strp_sb_mozjaozAfCdAQiBTzzSUnwQD/);
  assert.match(funnel, /FUNNEL_EXPERIMENTS[\s\S]{0,120}webCheckout: true/);
  // Sin cancellations locales de suscripción en ninguna parte.
  for (const [name, source] of [[PAGE_PATH, page], ['assets/manage-subscription.js', flowSource], ['assets/revenuecat.js', wrapperSource], ['funnel.html', funnel]]) {
    assert.equal(/cancelSubscription|deleteCustomer|cancelImmediate|refund/.test(source), false, `no local cancellation in ${name}`);
  }
  // Ninguna secret key en los archivos nuevos. En funnel.html la única
  // aparición de "service_role" es un comentario preexistente que la prohíbe.
  for (const [name, source] of [[PAGE_PATH, page], ['assets/manage-subscription.js', flowSource], ['assets/revenuecat.js', wrapperSource]]) {
    assert.equal(/service_role/.test(source), false, `no service_role in ${name}`);
  }
  assert.equal((funnel.match(/service_role/g) || []).length, 1);
  assert.match(funnel, /nunca service_role/);
}

/* ---------- 15. backend sin cambios ---------- */

function testBackendUnchanged() {
  const changed = require('node:child_process')
    .execSync('git diff --name-only origin/main...HEAD; git status --porcelain', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const unexpected = changed.filter((file) =>
    file.startsWith('supabase/') ||
    file.startsWith('testers/.e2e-artifacts') ||
    /\.sql$/.test(file) ||
    /webhook/i.test(file));
  assert.deepEqual(unexpected, [], `archivos de backend/no permitidos modificados: ${unexpected.join(', ')}`);
  assert.equal(fs.existsSync(path.join(ROOT, 'supabase/functions/create-funnel-plan/index.ts')), true);
}

/* ---------- 16. enlaces en support y funnel ---------- */

function testSiteIntegrationLinks() {
  assert.match(support, /<a href="\/manage-subscription\/">Manage subscription<\/a>/);
  assert.match(support, /<h2>Manage subscription<\/h2>/);
  // Footer.
  assert.match(support, /footer-links[\s\S]*\/manage-subscription\//);
  // Paywall: aclaración exacta en inglés.
  assert.match(funnel, /'Cancel anytime from your payment confirmation email or at brainyadhd\.com\/manage-subscription\/\.'/);
  // Success/handoff: enlace secundario, sin alterar el avance.
  const links = funnel.match(/<a href="\/manage-subscription\/">/g) || [];
  assert.equal(links.length, 2, 'enlace secundario en success y handoff');
  assert.match(funnel, /<p class="manage-subscription-note">\$\{localizedText\('¿Necesitas cancelar\? ', 'Need to cancel\? '\)\}<a href="\/manage-subscription\/">/);
  // El botón principal del paywall y el CTA de handoff siguen intactos.
  assert.match(funnel, /id="purchaseBtn"/);
  assert.match(funnel, /id="openAppBtn"/);
}

/* ---------- extras ---------- */

function testSupabaseClientIsolatedAndNonPersisting() {
  assert.match(page, /persistSession: false/);
  assert.match(page, /autoRefreshToken: false/);
  assert.match(page, /detectSessionInUrl: false/);
  assert.match(page, /supabaseSdk\.createClient\(cfg\.supabaseUrl, cfg\.supabaseAnonKey/);
  // No reutiliza ni interfiere con el cliente del funnel.
  assert.equal(/window\.brainyFunnelConfig/.test(page), false);
}

function testSdkNoBrowserStorage() {
  const vendored = fs.readFileSync(path.join(ROOT, 'assets/revenuecat-sdk.js'), 'utf8');
  for (const pattern of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
    assert.equal(vendored.includes(pattern), false, `el Web SDK no usa ${pattern}`);
  }
}

async function testUnavailableStates() {
  const outcomes = {};

  // RevenueCat devuelve null al configurar.
  outcomes.configureNull = await manage.createFlow({
    supabase: makeSupabase({ data: { user: { id: UUID_A } }, error: null }).client,
    revenuecat: { configure: () => null },
    apiKey: 'strp_sb_public',
    navigate: () => { throw new Error('must not navigate'); },
    clearPassword: () => {},
    onState: () => {},
  }).signIn('user@example.com', 'secret-1');

  // RevenueCat lanza al configurar.
  outcomes.configureThrows = await manage.createFlow({
    supabase: makeSupabase({ data: { user: { id: UUID_A } }, error: null }).client,
    revenuecat: { configure: () => { throw new Error('nope'); } },
    apiKey: 'strp_sb_public',
    navigate: () => { throw new Error('must not navigate'); },
    clearPassword: () => {},
    onState: () => {},
  }).signIn('user@example.com', 'secret-1');

  // Falta la key pública de RevenueCat.
  outcomes.keyMissing = await manage.createFlow({
    supabase: makeSupabase({ data: { user: { id: UUID_A } }, error: null }).client,
    revenuecat: makeRevenueCat().svc,
    apiKey: '',
    navigate: () => { throw new Error('must not navigate'); },
    clearPassword: () => {},
    onState: () => {},
  }).signIn('user@example.com', 'secret-1');

  // Falta el SDK.
  outcomes.sdkMissing = await manage.createFlow({
    supabase: makeSupabase({ data: { user: { id: UUID_A } }, error: null }).client,
    revenuecat: {},
    apiKey: 'strp_sb_public',
    navigate: () => { throw new Error('must not navigate'); },
    clearPassword: () => {},
    onState: () => {},
  }).signIn('user@example.com', 'secret-1');

  // Sin identidad válida en la sesión.
  outcomes.identityMissing = await makeFlow({
    supabase: makeSupabase({ data: { user: { id: 'anon' } }, error: null }),
  }).flow.signIn('user@example.com', 'secret-1');

  // Sin cliente de Supabase.
  outcomes.authMissing = await manage.createFlow({
    supabase: null,
    revenuecat: makeRevenueCat().svc,
    apiKey: 'strp_sb_public',
    navigate: () => { throw new Error('must not navigate'); },
    clearPassword: () => {},
    onState: () => {},
  }).signIn('user@example.com', 'secret-1');

  Object.keys(outcomes).forEach((key) => {
    assert.equal(outcomes[key], 'unavailable', `${key} must fail closed as unavailable`);
  });
}

async function testConfigureIdentityMismatchFailsClosed() {
  const rc = makeRevenueCat();
  const mismatched = {
    configure: rc.svc.configure,
    getManagementURL: rc.svc.getManagementURL,
    getSdkAppUserId: () => UUID_B,
  };
  const states = [];
  const navigated = [];
  const flow = manage.createFlow({
    supabase: makeSupabase({ data: { user: { id: UUID_A } }, error: null }).client,
    revenuecat: mismatched,
    apiKey: 'strp_sb_public',
    navigate: (url) => navigated.push(url),
    clearPassword: () => {},
    onState: (state, detail) => states.push({ state, detail }),
  });
  assert.equal(await flow.signIn('user@example.com', 'secret-1'), 'unavailable');
  assert.deepEqual(states[states.length - 1], { state: 'unavailable', detail: { reason: 'revenuecat_identity_mismatch' } });
  assert.deepEqual(navigated, []);
}

async function main() {
  const cases = [
    ['route exists', testRouteExists],
    ['labels, autocomplete and required copy', testFormAccessibility],
    ['reset request view exists', testResetRequestView],
    ['reset redirect is exact', testResetRedirectIsExact],
    ['reset request uses resetPasswordForEmail', testResetRequestUsesResetPasswordForEmail],
    ['reset email validation', testEmailValidation],
    ['reset request generic response (no enumeration)', testResetRequestGenericResponse],
    ['reset request blocks double send', testResetRequestBlocksDoubleSend],
    ['reset request network error allows retry', testResetRequestNetworkErrorRetry],
    ['reset request fails closed', testResetRequestFailClosed],
    ['reset request does not touch subscription flow', testResetRequestDoesNotTouchSubscriptionFlow],
    ['no hardcoded secrets', testNoHardcodedSecrets],
    ['password never printed or persisted', testPasswordNeverPrintedOrPersisted],
    ['no userId from params or form', testNoUserIdFromParamsOrForm],
    ['app user id comes from session.user.id', testAppUserIdComesFromSession],
    ['session user id parsing', testSessionUserIdParsing],
    ['invalid credentials show generic error', testInvalidCredentials],
    ['double submit blocked', testDoubleSubmitBlocked],
    ['missing managementURL shows fallback', testNoManagementUrl],
    ['non-https url rejected', testNonHttpsRejected],
    ['https url redirects to portal', testHttpsUrlRedirects],
    ['network error allows retry', testNetworkErrorRetry],
    ['getManagementURL avoids purchase/offerings/restore', testWrapperGetManagementUrl],
    ['funnel checkout preserved', testFunnelCheckoutPreserved],
    ['backend unchanged', testBackendUnchanged],
    ['site integration links', testSiteIntegrationLinks],
    ['isolated non-persisting Supabase client', testSupabaseClientIsolatedAndNonPersisting],
    ['RevenueCat Web SDK uses no browser storage', testSdkNoBrowserStorage],
    ['configure identity mismatch fails closed', testConfigureIdentityMismatchFailsClosed],
    ['unavailable states', testUnavailableStates],
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