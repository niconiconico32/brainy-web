/* Smoke visual del paywall rediseñado. Mocks locales, sin red y sin compras.
 * Run: node testers/paywall-visual-smoke.cjs
 *   SALIDA=dir  guarda capturas ahí
 */
const fs = require('node:fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.SALIDA || path.join(ROOT, 'captures', 'paywall-visual');
const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const TRIAL = process.env.TRIAL_DAYS ? Number(process.env.TRIAL_DAYS) : 0;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

// Precios identicos a los productos Live reales.
const MOCK = {
  usd: {
    annual: { amountMicros: 39900000, currency: 'USD', formattedPrice: '$39.90' },
    monthly: { amountMicros: 4990000, currency: 'USD', formattedPrice: '$4.99' },
  },
};

const MOCK_SCRIPT = `
const mockPrice = ${JSON.stringify(MOCK.usd)};
function mkPkg(id, kind, price, trialDays) {
  return {
    identifier: id, type: 'subscription',
    webBillingProduct: {
      title: id, identifier: 'price_' + id,
      period: { unit: kind === 'annual' ? 'year' : 'month', number: 1, iso: kind === 'annual' ? 'P1Y' : 'P1M' },
      price: price,
      trialInfo: trialDays ? { title: '${TRIAL} days free', period: { number: trialDays, unit: 'DAY' }, price: { amountMicros: 0, currency: price.currency, formattedPrice: '$0.00' } } : null
    }
  };
}
window.Purchases = { Purchases: {
  setLogLevel() {},
  configure(cfg) {
    return {
      getAppUserId: () => cfg.appUserId,
      getCustomerInfo: async () => ({ entitlements: { active: {} }, managementURL: null }),
      getOfferings: async () => {
        const annual = mkPkg('annual_mock', 'annual', mockPrice.annual, ${TRIAL});
        const monthly = mkPkg('monthly_mock', 'monthly', mockPrice.monthly, 0);
        const pkg = (p) => ({ identifier: p.identifier, type: 'subscription', offeringIdentifier: 'web_default', rcPackage: p, webBillingProduct: p.webBillingProduct, productCategory: 'SUBSCRIPTION' });
        return { all: { web_default: { identifier: 'web_default', availablePackages: [pkg(annual), pkg(monthly)], annual: pkg(annual), monthly: pkg(monthly) } }, current: { identifier: 'web_default', availablePackages: [pkg(annual), pkg(monthly)], annual: pkg(annual), monthly: pkg(monthly) } };
      },
      purchase() { throw new Error('COMPRA BLOQUEADA EN ESTE TEST'); },
      restorePurchases() { throw new Error('never'); },
    };
  }
} };
window.__purchaseCalls = 0;
`;

function startServer() {
  const server = http.createServer((req, res) => {
    let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

async function openPaywall(browser, base, width, height, locale) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('    [pageerror] ' + String(e).slice(0, 400)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('    [console] ' + m.text().slice(0, 400)); });
  await page.route((u) => u.pathname.endsWith('/assets/revenuecat-sdk.js'), (r) => r.fulfill({ body: MOCK_SCRIPT, contentType: 'application/javascript' }));
  await page.addInitScript((planId) => {
    const real = window.fetch;
    window.fetch = function (u, i) {
      const h = String(u && u.url ? u.url : u);
      if (h.indexOf('prepare-funnel-account') > -1) return Promise.resolve({ ok: true, status: 200, json: async () => ({ userId: '11111111-1111-4111-8111-111111111111', alreadyPro: false }) });
      if (h.indexOf('create-funnel-plan') > -1) return Promise.resolve({ ok: true, status: 200, json: async () => ({ planId, claimToken: 'claim-test' }) });
      return real.apply(this, arguments);
    };
  }, PLAN_ID);
  await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof stepList === 'function', null, { timeout: 20000 });
  await page.evaluate((loc) => {
    localStorage.clear();
    localStorage.setItem('brainy_funnel_state', JSON.stringify({
      locale: loc, nq01_gender: 'Female', selectedTasks: ['foco_productividad'], selectedRoutines: ['top_3_dia'],
      email: 'buyer@example.com', planId: '11111111-1111-4111-8111-111111111111', claimToken: 'claim-test'
    }));
    localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === 'paywall')));
  }, locale);
  await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.plan-card', { timeout: 20000 });
  return { ctx, page };
}

// El label puede recibir el clic durante un re-render del offering: reintenta
// hasta que la seleccion quede reflejada en el DOM.
async function selectPlan(page, kind) {
  for (let i = 0; i < 6; i++) {
    const found = await page.evaluate((k) => {
      const label = document.querySelector(`label[for="plan-${k}"]`);
      if (!label) return false;
      label.click();
      return true;
    }, kind);
    if (!found) continue;
    await page.waitForTimeout(120);
    const sel = await page.evaluate(() => {
      const c = document.querySelector('.plan-card.selected');
      return c ? c.getAttribute('data-pkg') : null;
    });
    if (sel && sel.startsWith(kind)) return;
  }
  const info = await page.evaluate((k) => ({
    cards: [...document.querySelectorAll('.plan-card')].map((c) => ({
      pkg: c.getAttribute('data-pkg'),
      cls: c.className,
      for: c.getAttribute('for'),
      radioChecked: c.querySelector('input') ? c.querySelector('input').checked : null,
    })),
    queried: (() => { const el = document.querySelector(`#plan-${k}`); return el ? { id: el.id, value: el.value, checked: el.checked } : null; })(),
    stateSelected: typeof readState === 'function' ? null : null,
    hasSelectedClass: !!document.querySelector('.plan-card.selected'),
  }), kind);
  throw new Error('no se pudo seleccionar ' + kind + ' · ' + JSON.stringify(info.cards));
}


async function readState(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.plan-card')];
    const sel = cards.find((c) => c.classList.contains('selected'));
    return {
      selected: sel ? sel.getAttribute('data-pkg') : null,
      cta: (document.getElementById('purchaseBtn') || {}).textContent || '',
      ctaNote: (document.querySelector('.paywall-cta-note') || {}).textContent || '',
      timeline: [...document.querySelectorAll('.paywall-timeline-point')].map((p) => p.textContent.trim().replace(/\s+/g, ' ')),
      annualCard: (cards.find((c) => c.textContent.includes('Anual') || c.textContent.includes('Annual')) || {}).textContent || '',
      monthlyCard: (cards.find((c) => c.textContent.includes('Mensual') || c.textContent.includes('Monthly')) || {}).textContent || '',
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ctaHeight: Math.round(document.getElementById('purchaseBtn').getBoundingClientRect().height),
      logoW: Math.round((document.querySelector('.paywall-logo') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width),
    };
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, base } = await startServer();
  const browser = await chromium.launch();
  const tag = TRIAL ? `-trial${TRIAL}` : '';
  try {
    // ES movil, mensual (default actual) y luego anual.
    let { ctx, page } = await openPaywall(browser, base, 390, 844, 'es');
    let st = await readState(page);
    console.log(`\n── ES 390x844 · MENSUAL (default actual) ──`);
    console.log('  seleccionado : ' + st.selected);
    console.log('  CTA          : "' + st.cta + '"');
    console.log('  nota CTA     : "' + st.ctaNote + '"');
    console.log('  timeline     : ' + (st.timeline.length ? JSON.stringify(st.timeline) : '(oculto)'));
    console.log('  alto CTA     : ' + st.ctaHeight + ' px · logo ' + st.logoW + ' px · overflow-x ' + st.overflow);
    console.log('  mensual      : ' + st.monthlyCard.replace(/\s+/g, ' ').trim());
    await page.screenshot({ path: path.join(OUT, `es-mensual-390x844${tag}.png`), fullPage: true });

    await selectPlan(page, 'annual');
    st = await readState(page);
    console.log('\n── ES 390x844 · ANUAL seleccionado ──');
    console.log('  seleccionado : ' + st.selected);
    console.log('  CTA          : "' + st.cta + '"');
    console.log('  nota CTA     : "' + st.ctaNote + '"');
    console.log('  timeline     : ' + (st.timeline.length ? JSON.stringify(st.timeline) : '(oculto)'));
    console.log('  anual        : ' + st.annualCard.replace(/\s+/g, ' ').trim());
    await page.screenshot({ path: path.join(OUT, `es-anual-390x844${tag}.png`), fullPage: true });
    const handlerIntacto = await page.evaluate(() => document.getElementById('purchaseBtn').onclick === null);
    const botones = await page.evaluate(() => document.querySelectorAll('#purchaseBtn').length);
    const compras = await page.evaluate(() => window.__purchaseCalls);
    console.log('  botones #purchaseBtn : ' + botones + ' · purchase() llamado : ' + compras);
    await ctx.close();

    // 320 y desktop
    ({ ctx, page } = await openPaywall(browser, base, 320, 568, 'es'));
    console.log('\n── ES 320x568 ──');
    const st320 = await readState(page);
    console.log('  overflow-x : ' + st320.overflow);
    const culprits = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out = [];
      document.querySelectorAll('*').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.right > vw + 0.5 || b.left < -0.5) {
          out.push(el.tagName + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + '  [' + Math.round(b.left) + '→' + Math.round(b.right) + ' w=' + Math.round(b.width) + ']');
        }
      });
      return { scrollW: document.documentElement.scrollWidth, list: out.slice(0, 12) };
    });
    console.log('  scrollWidth: ' + culprits.scrollW);
    culprits.list.forEach((c) => console.log('    ' + c));
    await selectPlan(page, 'annual');
    await page.screenshot({ path: path.join(OUT, `es-anual-320x568${tag}.png`), fullPage: true });
    await ctx.close();

    ({ ctx, page } = await openPaywall(browser, base, 1280, 900, 'es'));
    console.log('\n── ES 1280x900 (desktop) ──');
    await selectPlan(page, 'annual');
    const d = await readState(page);
    console.log('  logo ' + d.logoW + ' px · overflow-x ' + d.overflow + ' · alto CTA ' + d.ctaHeight + ' px');
    await page.screenshot({ path: path.join(OUT, `es-anual-1280x900${tag}.png`), fullPage: true });
    await ctx.close();

    // EN
    ({ ctx, page } = await openPaywall(browser, base, 390, 844, 'en'));
    console.log('\n── EN 390x844 ──');
    console.log('  mensual CTA : "' + (await readState(page)).cta + '"');
    await selectPlan(page, 'annual');
    const en = await readState(page);
    console.log('  anual  CTA  : "' + en.cta + '"');
    console.log('  anual  nota : "' + en.ctaNote + '"');
    console.log('  anual  card : ' + en.annualCard.replace(/\s+/g, ' ').trim());
    await page.screenshot({ path: path.join(OUT, `en-anual-390x844${tag}.png`), fullPage: true });
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\ncapturas en ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });