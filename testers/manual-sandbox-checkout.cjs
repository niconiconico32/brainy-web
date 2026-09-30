const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { chromium } = require('playwright');

const BASE_URL = 'https://brainyadhd.com/funnel.html?reset';
const LOCK_PATH = path.join(require('node:os').tmpdir(), 'brainy-manual-sandbox-checkout.lock');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_SANDBOX_KEY_RE = /^strp_sb_[A-Za-z0-9_-]{10,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(message) {
  throw new Error(message);
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function redact(value, secrets) {
  let text = String(value || '');
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/(?:access_token|refresh_token|redemption_token)=[^&\s]+/gi, '$1=[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:eyJ|strp_sb_)[A-Za-z0-9._-]+/g, '[redacted]')
    .slice(0, 180);
}

function instrumentSdkInstance(instance, calls) {
  if (!instance || instance.__manualSandboxSdkWrapped) return instance;
  const sdkPurchase = instance.purchase;
  const sdkGetOfferings = instance.getOfferings;
  instance.getOfferings = function () {
    calls.sdkGetOfferingsCalls = (calls.sdkGetOfferingsCalls || 0) + 1;
    calls.events.push('sdk_getOfferings');
    return sdkGetOfferings.apply(this, arguments);
  };
  instance.purchase = function (params) {
    calls.sdkPurchaseCalls += 1;
    const metadata = params && params.metadata && typeof params.metadata === 'object' ? params.metadata : {};
    const keys = Object.keys(metadata);
    let state = {};
    try { state = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}'); } catch {}
    const planId = metadata.brainy_plan_id;
    calls.sdkMetadataKeys = keys;
    calls.sdkPlanIdIsUuid = typeof planId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(planId);
    calls.sdkPlanMatchesState = calls.sdkPlanIdIsUuid && planId === (state.planId || globalThis.__MANUAL_SANDBOX_PLAN_ID__);
    calls.sdkMetadataExact = keys.length === 1 && keys[0] === 'brainy_plan_id' && calls.sdkPlanMatchesState;
    calls.events.push('sdk_purchase');
    if (calls.sdkPurchaseCalls > 1) {
      return Promise.reject(new Error('manual_sandbox_duplicate_sdk_purchase_blocked'));
    }
    return sdkPurchase.apply(this, arguments);
  };
  Object.defineProperty(instance, '__manualSandboxSdkWrapped', { value: true });
  return instance;
}

function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return () => fs.rmSync(LOCK_PATH, { force: true });
  } catch (error) {
    let owner = 'unknown';
    try { owner = fs.readFileSync(LOCK_PATH, 'utf8').trim(); } catch {}
    let ownerAlive = false;
    if (/^\d+$/.test(owner)) {
      try {
        process.kill(Number(owner), 0);
        ownerAlive = true;
      } catch (processError) {
        if (processError && processError.code === 'EPERM') ownerAlive = true;
      }
    }
    if (ownerAlive) {
      fail('another manual sandbox runner is already active');
    }
    try { fs.rmSync(LOCK_PATH, { force: true }); } catch {}
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.rmSync(LOCK_PATH, { force: true });
    } catch (retryError) {
      if (retryError && retryError.code === 'EEXIST') {
        fail('another manual sandbox runner is already active');
      }
      throw retryError;
    }
  }
}

function validateEnvironment() {
  const key = process.env.FUNNEL_RC_KEY;
  const email = process.env.FUNNEL_TEST_EMAIL;
  if (!key) fail('FUNNEL_RC_KEY is required');
  if (!email) fail('FUNNEL_TEST_EMAIL is required');
  if (!PUBLIC_SANDBOX_KEY_RE.test(key)) fail('FUNNEL_RC_KEY is not a public sandbox key');
  if (!EMAIL_RE.test(email)) fail('FUNNEL_TEST_EMAIL is invalid');
  return { key, email };
}

function installPreflightClickGuard() {
  const state = window.__MANUAL_SANDBOX__;
  document.addEventListener('click', event => {
    const target = event.target && event.target.closest ? event.target.closest('#purchaseBtn') : null;
    if (target && state.preflightPassed !== true) {
      state.preflightBlockedClicks = (state.preflightBlockedClicks || 0) + 1;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
}

function installBrowserInstrumentation(context, key) {
  return context.addInitScript(({ sandboxKey, sandboxInstrumentSource }) => {
    const calls = {
      configure: 0,
      brainyPurchaseCalls: 0,
      sdkPurchaseCalls: 0,
      sdkGetOfferingsCalls: 0,
      sdkMetadataKeys: null,
      sdkPlanIdIsUuid: false,
      sdkPlanMatchesState: false,
      sdkMetadataExact: false,
      appUserId: null,
      preflightPassed: false,
      preflightBlockedClicks: 0,
      events: [],
    };
    Object.defineProperty(window, '__MANUAL_SANDBOX__', { value: calls, configurable: false });

    const instrumentSdkInstance = (0, eval)(`(${sandboxInstrumentSource})`);

    const wrapConfigure = namespace => {
      const ctor = namespace && namespace.Purchases ? namespace.Purchases : namespace;
      if (!ctor || typeof ctor.configure !== 'function' || ctor.__manualSandboxConfigureWrapped) return;
      const configure = ctor.configure;
      ctor.configure = function (config) {
        calls.configure += 1;
        calls.appUserId = config && config.appUserId ? config.appUserId : null;
        calls.events.push('configure');
        return instrumentSdkInstance(configure.apply(this, arguments), calls);
      };
      Object.defineProperty(ctor, '__manualSandboxConfigureWrapped', { value: true });
    };

    const watchNamespace = namespace => {
      if (!namespace || typeof namespace !== 'object' || namespace.__manualSandboxNamespaceWatched) {
        return namespace;
      }
      const existing = namespace.Purchases;
      let purchases = existing;
      Object.defineProperty(namespace, 'Purchases', {
        configurable: true,
        enumerable: true,
        get: () => purchases,
        set: next => {
          purchases = next;
          wrapConfigure(next);
        },
      });
      Object.defineProperty(namespace, '__manualSandboxNamespaceWatched', { value: true });
      if (existing) wrapConfigure(existing);
      return namespace;
    };

    let purchasesNamespace = {};
    let currentNamespace = null;
    const namespaceProxy = new Proxy(purchasesNamespace, {
      set(target, property, value) {
        target[property] = value;
        if (property === 'Purchases') wrapConfigure(value);
        return true;
      },
    });
    Object.defineProperty(window, 'Purchases', {
      configurable: true,
      get: () => currentNamespace || namespaceProxy,
      set: next => {
        currentNamespace = watchNamespace(next || {});
        purchasesNamespace = currentNamespace;
        wrapConfigure(currentNamespace);
      },
    });

    let brainyService = null;
    Object.defineProperty(window, 'BrainyRevenueCat', {
      configurable: true,
      get: () => brainyService,
      set: next => {
        if (next && !next.__manualSandboxBrainyWrapped && typeof next.purchase === 'function') {
          const brainyPurchase = next.purchase;
          next.purchase = function () {
            calls.brainyPurchaseCalls += 1;
            calls.events.push('brainy_purchase');
            return brainyPurchase.apply(this, arguments);
          };
          Object.defineProperty(next, '__manualSandboxBrainyWrapped', { value: true });
        }
        brainyService = next;
      },
    });

    window.__BRAINY_FUNNEL_CONFIG__ = {
      revenuecatWebApiKey: sandboxKey,
      revenuecatOfferingId: 'web_default',
      revenuecatEntitlementId: 'brainy Pro',
    };
  }, { sandboxKey: key, sandboxInstrumentSource: instrumentSdkInstance.toString() })
    .then(() => context.addInitScript(installPreflightClickGuard));
}

async function waitForPaywall(page, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await page.locator('#purchaseBtn').count()) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function prefillEmail(page, email, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const input = page.locator('#emailInput');
    if (await input.count()) {
      await input.fill(email);
      console.log(`[${new Date().toISOString()}] Email prellenado (enmascarado): ${maskEmail(email)}`);
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function readPrePurchaseState(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('brainy_funnel_state');
    const state = raw ? JSON.parse(raw) : {};
    const service = window.BrainyRevenueCat;
    const calls = window.__MANUAL_SANDBOX__ || {};
    const planId = state.planId || null;
    return {
      checkoutEnabled: typeof window.funnelWebCheckout === 'function' && window.funnelWebCheckout() === true,
      serviceAvailable: !!service && typeof service.isAvailable === 'function' && service.isAvailable(),
      configureCalls: calls.configure || 0,
      sdkGetOfferingsCalls: calls.sdkGetOfferingsCalls || 0,
      brainyPurchaseCalls: calls.brainyPurchaseCalls || 0,
      sdkPurchaseCalls: calls.sdkPurchaseCalls || 0,
      sdkMetadataKeys: calls.sdkMetadataKeys,
      sdkPlanIdIsUuid: !!calls.sdkPlanIdIsUuid,
      sdkPlanMatchesState: !!calls.sdkPlanMatchesState,
      sdkMetadataExact: !!calls.sdkMetadataExact,
      appUserIdIsUuid: typeof calls.appUserId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(calls.appUserId),
      offeringVisible: document.querySelectorAll('.plan-card').length > 0,
      planIdIsUuid: typeof planId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(planId),
      alreadyPro: state.alreadyPro === true,
      preflightPassed: calls.preflightPassed === true,
      preflightBlockedClicks: calls.preflightBlockedClicks || 0,
    };
  });
}

async function waitForEnter() {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  await terminal.question('Presiona Enter para cerrar el navegador y terminar el runner. ');
  terminal.close();
}

async function main() {
  const { key, email } = validateEnvironment();
  const releaseLock = acquireLock();
  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installBrowserInstrumentation(context, key);
    const page = await context.newPage();
    const secrets = [key, email];
    const errors = [];
    const http = { createPlan: [], prepareAccount: [], revenuecat: [] };
    page.on('pageerror', error => errors.push({ type: 'pageerror', message: redact(error.message, secrets) }));
    page.on('console', message => {
      if (message.type() === 'error') errors.push({ type: 'console', message: redact(message.text(), secrets) });
    });
    page.on('response', response => {
      const url = response.url();
      const status = response.status();
      if (url.includes('/functions/v1/create-funnel-plan')) http.createPlan.push(status);
      if (url.includes('/functions/v1/prepare-funnel-account')) http.prepareAccount.push(status);
      if (url.includes('api.revenuecat.com') || url.includes('e.revenue.cat')) http.revenuecat.push(status);
    });

    console.log(`[${new Date().toISOString()}] Abriendo Chromium visible en viewport desktop.`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await prefillEmail(page, email, 30 * 60 * 1000);
    console.log(`[${new Date().toISOString()}] Completa manualmente el funnel; no se enviará el email automáticamente.`);

    const paywallVisible = await waitForPaywall(page, 60 * 60 * 1000);
    if (!paywallVisible) {
      console.log('No apareció el paywall dentro del tiempo de espera. No se ejecutó ninguna compra.');
      await waitForEnter();
      return;
    }

    const checks = await readPrePurchaseState(page);
    console.log(`[${new Date().toISOString()}] Pre-checkout: ${JSON.stringify(checks)}`);
    const valid = checks.checkoutEnabled && checks.serviceAvailable && checks.configureCalls > 0 &&
      checks.sdkGetOfferingsCalls > 0 && checks.sdkPurchaseCalls === 0 && checks.offeringVisible && checks.planIdIsUuid &&
      checks.appUserIdIsUuid && !checks.alreadyPro && checks.brainyPurchaseCalls === 0;
    if (!valid) {
      console.log('Pre-checkout inválido; no se permite continuar y no se ejecutó ninguna compra.');
      await waitForEnter();
      return;
    }

    await page.evaluate(() => {
      if (window.__MANUAL_SANDBOX__) window.__MANUAL_SANDBOX__.preflightPassed = true;
    });
    console.log('Pre-checkout válido. Haz clic manualmente una sola vez y completa el checkout sandbox.');
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    const earlyEnter = terminal.question('Completa manualmente la compra. Presiona Enter solo después de que termine. ')
      .then(() => ({ kind: 'early_enter' }));
    const outcomePromise = waitForManualCompletion(page, 20 * 60 * 1000);
    const result = await Promise.race([earlyEnter, outcomePromise]);
    terminal.close();
    const finalState = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
      const calls = window.__MANUAL_SANDBOX__ || {};
      return {
        brainyPurchaseCalls: calls.brainyPurchaseCalls || 0,
        sdkPurchaseCalls: calls.sdkPurchaseCalls || 0,
        sdkMetadataKeys: calls.sdkMetadataKeys,
        sdkPlanIdIsUuid: !!calls.sdkPlanIdIsUuid,
        sdkPlanMatchesState: !!calls.sdkPlanMatchesState,
        sdkMetadataExact: !!calls.sdkMetadataExact,
        purchaseCompleted: !!state.purchaseCompleted,
        handoffReady: !!state.handoffReady,
      };
    });
    if (result.kind === 'early_enter') {
      console.log(`[${new Date().toISOString()}] Prueba incompleta: Enter fue presionado antes de confirmar el resultado.`);
    } else {
      console.log(`[${new Date().toISOString()}] Resultado manual: ${result.kind}.`);
    }
    console.log(`[${new Date().toISOString()}] Final: ${JSON.stringify(finalState)}`);
    console.log(`HTTP create-plan=${http.createPlan.join(',') || 'none'} prepare-account=${http.prepareAccount.join(',') || 'none'} RevenueCat=${http.revenuecat.length}`);
    console.log(`Errores de página: ${errors.length}`);
  } finally {
    if (browser) await browser.close();
    releaseLock();
  }
}

async function waitForManualCompletion(page, timeoutMs) {
  const started = Date.now();
  let purchaseLogged = false;
  while (Date.now() - started < timeoutMs) {
    if (page.isClosed()) return { kind: 'browser_closed' };
    const snapshot = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
      const calls = window.__MANUAL_SANDBOX__ || {};
      return {
        sdkPurchaseCalls: calls.sdkPurchaseCalls || 0,
        purchaseCompleted: !!state.purchaseCompleted,
        handoffReady: !!state.handoffReady,
        recoveryVisible: !!document.querySelector('.paywall-recovery'),
        successVisible: !!document.querySelector('.success-checks'),
      };
    });
    if (snapshot.sdkPurchaseCalls > 0 && !purchaseLogged) {
      console.log(`[${new Date().toISOString()}] SDK purchase invocado: ${snapshot.sdkPurchaseCalls}`);
      purchaseLogged = true;
    }
    if (snapshot.purchaseCompleted && (snapshot.handoffReady || snapshot.successVisible)) {
      return { kind: 'success' };
    }
    if (snapshot.sdkPurchaseCalls > 0 && snapshot.recoveryVisible) {
      return { kind: 'terminal_error' };
    }
    await page.waitForTimeout(500);
  }
  return { kind: 'timeout' };
}

if (require.main === module) {
  main().catch(error => {
    console.error(redact(error.message, [process.env.FUNNEL_RC_KEY, process.env.FUNNEL_TEST_EMAIL]));
    process.exitCode = 1;
  });
}

module.exports = {
  LOCK_PATH,
  acquireLock,
  installBrowserInstrumentation,
  installPreflightClickGuard,
  instrumentSdkInstance,
  waitForManualCompletion,
};
