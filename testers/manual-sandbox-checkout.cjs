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

function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return () => fs.rmSync(LOCK_PATH, { force: true });
  } catch (error) {
    let owner = 'unknown';
    try { owner = fs.readFileSync(LOCK_PATH, 'utf8').trim(); } catch {}
    if (/^\d+$/.test(owner)) {
      try {
        process.kill(Number(owner), 0);
        fail('another manual sandbox runner is already active');
      } catch {}
    }
    try { fs.rmSync(LOCK_PATH, { force: true }); } catch {}
    return acquireLock();
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

function installBrowserInstrumentation(context, key) {
  return context.addInitScript(({ sandboxKey }) => {
    const calls = {
      configure: 0,
      getOfferings: 0,
      purchase: 0,
      purchaseMetadataKeys: null,
      appUserId: null,
      events: [],
    };
    Object.defineProperty(window, '__MANUAL_SANDBOX__', { value: calls, configurable: false });

    let service = null;
    Object.defineProperty(window, 'BrainyRevenueCat', {
      configurable: true,
      get: () => service,
      set: (next) => {
        if (!next || next.__manualSandboxWrapped) {
          service = next;
          return;
        }
        const configure = next.configure;
        const getOfferings = next.getOfferings;
        const purchase = next.purchase;
        next.configure = function (config) {
          calls.configure += 1;
          calls.appUserId = config && config.appUserId ? config.appUserId : null;
          calls.events.push('configure');
          return configure.apply(this, arguments);
        };
        next.getOfferings = function () {
          calls.getOfferings += 1;
          calls.events.push('getOfferings');
          return getOfferings.apply(this, arguments);
        };
        next.purchase = function (options) {
          calls.purchase += 1;
          calls.purchaseMetadataKeys = options && options.metadata ? Object.keys(options.metadata) : null;
          calls.events.push('purchase');
          if (calls.purchase > 1) {
            return Promise.reject(new Error('manual_sandbox_duplicate_purchase_blocked'));
          }
          return purchase.apply(this, arguments);
        };
        Object.defineProperty(next, '__manualSandboxWrapped', { value: true });
        service = next;
      },
    });

    window.__BRAINY_FUNNEL_CONFIG__ = {
      revenuecatWebApiKey: sandboxKey,
      revenuecatOfferingId: 'web_default',
      revenuecatEntitlementId: 'brainy Pro',
    };
  }, { sandboxKey: key });
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
      offeringsCalls: calls.getOfferings || 0,
      purchaseCalls: calls.purchase || 0,
      appUserIdIsUuid: typeof calls.appUserId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(calls.appUserId),
      offeringVisible: document.querySelectorAll('.plan-card').length > 0,
      planIdIsUuid: typeof planId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(planId),
      alreadyPro: state.alreadyPro === true,
      metadataKeys: ['brainy_plan_id'],
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
    console.log(`[${new Date().toISOString()}] Pre-checkout: ${JSON.stringify({ ...checks, metadataKeys: checks.metadataKeys })}`);
    const valid = checks.checkoutEnabled && checks.serviceAvailable && checks.configureCalls > 0 &&
      checks.offeringsCalls > 0 && checks.offeringVisible && checks.planIdIsUuid &&
      checks.appUserIdIsUuid && !checks.alreadyPro && checks.purchaseCalls === 0;
    if (!valid) {
      console.log('Pre-checkout inválido; no se permite continuar y no se ejecutó ninguna compra.');
      await waitForEnter();
      return;
    }

    console.log('Pre-checkout válido. Haz clic manualmente una sola vez y completa el checkout sandbox.');
    await waitForEnter();
    const finalState = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
      const calls = window.__MANUAL_SANDBOX__ || {};
      return { purchaseCalls: calls.purchase || 0, purchaseCompleted: !!state.purchaseCompleted, handoffReady: !!state.handoffReady };
    });
    console.log(`[${new Date().toISOString()}] Final: ${JSON.stringify(finalState)}`);
    console.log(`HTTP create-plan=${http.createPlan.join(',') || 'none'} prepare-account=${http.prepareAccount.join(',') || 'none'} RevenueCat=${http.revenuecat.length}`);
    console.log(`Errores de página: ${errors.length}`);
  } finally {
    if (browser) await browser.close();
    releaseLock();
  }
}

main().catch(error => {
  console.error(redact(error.message, [process.env.FUNNEL_RC_KEY, process.env.FUNNEL_TEST_EMAIL]));
  process.exitCode = 1;
});
