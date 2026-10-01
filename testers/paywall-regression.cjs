// Regresion del paywall rediseñado, con offerings mockeados y SIN compras reales.
// Se instrumenta la frontera del SDK para comprobar qué package llega a purchase().
//
// Run: npm run test:paywall
//   PAYWALL_HEADFUL=1  muestra el navegador

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PLAN_ID = '11111111-1111-4111-8111-111111111111';

// Precios de prueba claramente identified. NO son datos de RevenueCat.
const MOCK = {
  usd: {
    annual: { amountMicros: 39990000, currency: 'USD', formattedPrice: '$39.99' },
    monthly: { amountMicros: 4990000, currency: 'USD', formattedPrice: '$4.99' }
  },
  // Sin datos numericos fiables.
  noNumbers: {
    annual: { formattedPrice: 'From $39.99' },
    monthly: { formattedPrice: 'From $4.99' }
  },
  // Monedas distintas: no debe compararse.
  mixed: {
    annual: { amountMicros: 39990000, currency: 'USD', formattedPrice: '$39.99' },
    monthly: { amountMicros: 4990000, currency: 'EUR', formattedPrice: '4,99 €' }
  },
  // Cero decimales.
  jpy: {
    annual: { amountMicros: 6000000000, currency: 'JPY', formattedPrice: '¥6,000' },
    monthly: { amountMicros: 700000000, currency: 'JPY', formattedPrice: '¥700' }
  },
  // Anual mas caro que 12 mensuales: sin ahorro.
  noSavings: {
    annual: { amountMicros: 99990000, currency: 'USD', formattedPrice: '$99.99' },
    monthly: { amountMicros: 4990000, currency: 'USD', formattedPrice: '$4.99' }
  }
};

const MOCK_UUID = '11111111-1111-4111-8111-111111111111';

const MOCK_SCRIPT = (mock, opts) => `
window.__sdk = { purchaseCalls: [] };
const mockOffering = ${JSON.stringify(mock)};
const mockPro = ${JSON.stringify(!!(opts && opts.alreadyPro))};
function pkg(id, kind, price, extra) {
  return Object.assign({
    identifier: id,
    type: 'subscription',
    webBillingProduct: Object.assign({
      title: id,
      period: { unit: kind === 'annual' ? 'year' : 'month', number: 1, iso: kind === 'annual' ? 'P1Y' : 'P1M' }
    }, extra || {}, { price: price })
  });
}
function mockOfferingObject() {
  return {
    identifier: 'web_default',
    serverDescription: 'Mock offering (test data only)',
    annual: pkg('annual_mock_id', 'annual', mockOffering.annual, mockOffering.annualTrial ? { trialInfo: mockOffering.annualTrial } : null),
    monthly: pkg('monthly_mock_id', 'monthly', mockOffering.monthly, mockOffering.monthlyTrial ? { trialInfo: mockOffering.monthlyTrial } : null)
  };
}
window.Purchases = { Purchases: {
  // El SDK debe reportar el MISMO appUserId que la identidad verificada, y
  // configure() debe devolver la instancia completa.
  configure: () => window.__sdkInstance,
  setLogLevel: () => {},
  getCustomerInfo: async () => ({ entitlements: { active: mockPro ? { 'brainy Pro': { isActive: true } } : {} } }),
  // El envoltorio lee offerings.all[id] o offerings.current.
  getOfferings: async () => ({
    all: { web_default: mockOfferingObject() },
    current: mockOfferingObject()
  }),
  purchase: async (params) => {
    window.__sdk.purchaseCalls.push(params);
    return { customerInfo: { entitlements: { active: {} } }, redemptionInfo: null };
  }
} };
window.__sdkInstance = {
  getAppUserId: () => '${MOCK_UUID}',
  getCustomerInfo: window.Purchases.Purchases.getCustomerInfo,
  getOfferings: window.Purchases.Purchases.getOfferings,
  purchase: window.Purchases.Purchases.purchase
};
`;

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\//, '') || 'index.html';
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
    try {
      const type = file.endsWith('.html') ? 'text/html'
        : file.endsWith('.json') ? 'application/json'
        : file.endsWith('.png') ? 'image/png' : 'application/javascript';
      res.writeHead(200, { 'Content-Type': type });
      res.end(fs.readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function main() {
  const checks = [];
  const check = (name, fn) => checks.push([name, fn]);
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: !process.env.PAYWALL_HEADFUL });

  // Abre el paywall con backend "mockeado" para llegar a las tarjetas reales.
  async function openPaywall(ctx, mock, extraState = {}, opts = {}) {
    const page = await ctx.newPage();
    // Aislamiento total: el SDK real NO se descarga, solo nuestro mock.
    await page.route('**/revenuecat-sdk.js', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript', body: ''
    }));
    await page.route('**/revenuecat-sdk*.js', (route) => route.fulfill({
      status: 200, contentType: 'application/javascript', body: ''
    }));
    await page.addInitScript(MOCK_SCRIPT(mock, opts));
    // Interceptamos fetch para la preparacion de cuenta: el modulo real de
    // identidad se mantiene intacto y no se llama a Supabase.
    await page.addInitScript(`
      (function () {
        const real = window.fetch;
        window.fetch = function (url) {
          const href = String(url && url.url ? url.url : url);
          if (href.indexOf('prepare-funnel-account') > -1) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({ userId: '${MOCK_UUID}', alreadyPro: false })
            });
          }
          return real.apply(this, arguments);
        };
      })();
    `);
    await page.goto(`${base}/funnel.html`);
    await page.evaluate((a) => {
      localStorage.setItem('brainy_funnel_state', JSON.stringify(Object.assign({
        locale: 'en',
        nq01_gender: 'Female',
        selectedTasks: ['task-1'],
        selectedRoutines: ['routine-1'],
        email: 'buyer@example.com',
        planId: '11111111-1111-4111-8111-111111111111',
        claimToken: 'claim-abc'
      }, a.extra)));
      localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === 'paywall')));
    }, { extra: extraState });
    await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    // La identidad y el offering vienen del SDK mockeado; esperamos las tarjetas.
    for (let i = 0; i < 120; i += 1) {
      if (await page.evaluate(() => document.querySelectorAll('.plan-card').length === 2)) break;
      await page.waitForTimeout(100);
    }
    return page;
  }

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

  try {
    check('1-4. dos ofertas, anual primero, badge, mensual por defecto', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const r = await page.evaluate(() => ({
        count: document.querySelectorAll('.plan-card').length,
        order: [...document.querySelectorAll('.plan-card')].map((c) => c.querySelector('.plan-card-title').textContent.trim()),
        badges: [...document.querySelectorAll('.plan-card')].map((c) => {
          const b = c.querySelector('.plan-badge');
          return b ? b.textContent.trim() : null;
        }),
        checked: [...document.querySelectorAll('.plan-card-radio')].map((c) => c.checked),
        checkedValue: (document.querySelector('.plan-card-radio:checked') || {}).value
      }));
      assert.equal(r.count, 2);
      assert.deepEqual(r.order, ['Annual plan', 'Monthly plan']);
      assert.deepEqual(r.badges, ['Most popular', null], 'solo el anual lleva el badge');
      assert.deepEqual(r.checked, [false, true], 'mensual seleccionado por defecto');
      assert.equal(r.checkedValue, 'monthly_mock_id');
      await page.close();
    });

    check('5. la seleccion mensual por defecto coincide con el package comprado', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const r = await page.evaluate(async () => {
        document.getElementById('purchaseBtn').click();
        await new Promise((res) => setTimeout(res, 400));
        return window.__sdk.purchaseCalls.map((p) => p.rcPackage.identifier);
      });
      assert.deepEqual(r, ['monthly_mock_id'], 'el SDK debe recibir el package mensual');
      await page.close();
    });

    check('6. cambiar al anual compra el package anual', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const r = await page.evaluate(async () => {
        document.getElementById('plan-annual').click();
        await new Promise((res) => setTimeout(res, 200));
        const checked = document.querySelector('.plan-card-radio:checked').value;
        document.getElementById('purchaseBtn').click();
        await new Promise((res) => setTimeout(res, 400));
        return { checked, calls: window.__sdk.purchaseCalls.map((p) => p.rcPackage.identifier) };
      });
      assert.equal(r.checked, 'annual_mock_id');
      assert.deepEqual(r.calls, ['annual_mock_id']);
      await page.close();
    });

    check('7. el precio completo coincide exactamente con RevenueCat', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const r = await page.evaluate(() => [...document.querySelectorAll('.plan-card-price')].map((n) => n.textContent.trim()));
      assert.deepEqual(r, ['$39.99', '$4.99'], 'usa el formattedPrice del SDK, sin reformatear');
      await page.close();
    });

    check('8-11. daily, comparable y ahorro con Math.floor', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const r = await page.evaluate(() => ({
        math: {
          annualDaily: 39.99 / 365.25,
          monthlyDaily: 4.99 / (365.25 / 12),
          equivalent: 4.99 * 12,
          savings: Math.floor((1 - 39.99 / (4.99 * 12)) * 100)
        },
        daily: [...document.querySelectorAll('.plan-card-daily')].map((n) => n.textContent.trim()),
        compare: (document.querySelector('.plan-card-compare') || {}).textContent,
        save: (document.querySelector('.plan-card-save') || {}).textContent,
        periods: [...document.querySelectorAll('.plan-card-period')].map((n) => n.textContent.trim())
      }));
      // 4.99 * 12 = 59.88; ahorro = floor((1 - 39.99/59.88)*100) = 33
      assert.equal(r.math.equivalent, 59.88);
      assert.equal(r.math.savings, 33);
      assert.ok(r.daily[0].startsWith('About $0.11 per day'), `anual: ${r.daily[0]}`);
      assert.ok(r.daily[1].startsWith('About $0.16 per day'), `mensual: ${r.daily[1]}`);
      assert.match(r.compare, /^12 monthly payments: \$59\.88/);
      assert.equal(r.save, 'Save 33%');
      assert.deepEqual(r.periods, ['per year', 'per month']);
      await page.close();
    });

    check('12. sin ahorro cuando el anual no es mas barato', async () => {
      const page = await openPaywall(ctx, MOCK.noSavings);
      const r = await page.evaluate(() => ({
        save: !!document.querySelector('.plan-card-save'),
        compare: !!document.querySelector('.plan-card-compare'),
        prices: [...document.querySelectorAll('.plan-card-price')].map((n) => n.textContent.trim())
      }));
      assert.equal(r.save, false, 'no debe inventar descuento');
      assert.equal(r.compare, true, 'la comparacion si aplica: misma moneda y datos');
      assert.deepEqual(r.prices, ['$99.99', '$4.99']);
      await page.close();
    });

    check('13. no se compara con monedas distintas', async () => {
      const page = await openPaywall(ctx, MOCK.mixed);
      const r = await page.evaluate(() => ({
        save: !!document.querySelector('.plan-card-save'),
        compare: !!document.querySelector('.plan-card-compare'),
        daily: [...document.querySelectorAll('.plan-card-daily')].map((n) => n.textContent.trim())
      }));
      assert.equal(r.save, false);
      assert.equal(r.compare, false, 'monedas distintas: sin comparacion');
      // El daily de cada plan si puede mostrarse con su propia moneda.
      assert.equal(r.daily.length, 2);
      await page.close();
    });

    check('14. sin derivados cuando faltan datos numericos', async () => {
      const page = await openPaywall(ctx, MOCK.noNumbers);
      const r = await page.evaluate(() => ({
        prices: [...document.querySelectorAll('.plan-card-price')].map((n) => n.textContent.trim()),
        daily: document.querySelectorAll('.plan-card-daily').length,
        compare: document.querySelectorAll('.plan-card-compare').length,
        save: document.querySelectorAll('.plan-card-save').length,
        cta: document.getElementById('purchaseBtn').disabled
      }));
      assert.deepEqual(r.prices, ['From $39.99', 'From $4.99']);
      assert.equal(r.daily, 0);
      assert.equal(r.compare, 0);
      assert.equal(r.save, 0);
      assert.equal(r.cta, false, 'sin derivados el checkout sigue disponible');
      await page.close();
    });

    check('15. no se parsea el precio desde el string localizado', async () => {
      const html = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
      const body = html.slice(html.indexOf('function paywallProductPrice'), html.indexOf('function formatPaywallMoney'));
      assert.equal(/parseFloat|replace\(|match\(/.test(body), false,
        'paywallProductPrice no debe interpretar el string de precio');
      assert.ok(body.includes('amountMicros'), 'usa los campos numericos del SDK');
      // Un formattedPrice conFormato imposible de parsear no rompe nada.
      const page = await openPaywall(ctx, {
        annual: { amountMicros: 12340000, currency: 'BRL', formattedPrice: 'R$ 12.349,00 (aprox.)' },
        monthly: { amountMicros: 4990000, currency: 'BRL', formattedPrice: 'R$ 49,99' }
      });
      const r = await page.evaluate(() => ({
        price: document.querySelector('.plan-card-price').textContent.trim(),
        daily: document.querySelector('.plan-card-daily').textContent.trim()
      }));
      assert.equal(r.price, 'R$ 12.349,00 (aprox.)');
      assert.ok(r.daily.includes('About'), 'el daily si se deriva del numeric price');
      await page.close();
    });

    check('16. monedas de cero decimales se formatean con sus reglas', async () => {
      const page = await openPaywall(ctx, MOCK.jpy);
      const r = await page.evaluate(() => ({
        prices: [...document.querySelectorAll('.plan-card-price')].map((n) => n.textContent.trim()),
        daily: [...document.querySelectorAll('.plan-card-daily')].map((n) => n.textContent.trim()),
        compare: (document.querySelector('.plan-card-compare') || {}).textContent
      }));
      assert.deepEqual(r.prices, ['¥6,000', '¥700']);
      // JPY no admite decimales: el daily se formatea sin ellos.
      assert.equal(r.daily[0], 'About ¥16 per day');
      assert.equal(r.daily[1], 'About ¥23 per day');
      assert.match(r.compare, /^12 monthly payments: ¥8,400/);
      await page.close();
    });

    check('17. el mensual no muestra descuento inventado', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const r = await page.evaluate(() => {
        const monthly = [...document.querySelectorAll('.plan-card')].find((c) => c.classList.contains('plan-card--monthly'))
          || [...document.querySelectorAll('.plan-card')][1];
        return {
          save: monthly.querySelectorAll('.plan-card-save').length,
          compare: monthly.querySelectorAll('.plan-card-compare').length,
          note: (monthly.querySelector('.plan-card-note') || {}).textContent,
          discount: /%/i.test(monthly.textContent) && /save/i.test(monthly.textContent)
        };
      });
      assert.equal(r.save, 0);
      assert.equal(r.compare, 0);
      assert.equal(r.note, 'Flexible monthly billing');
      assert.equal(r.discount, false);
      await page.close();
    });

    check('18-19. trial solo si existe; sin trial no se menciona', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const r = await page.evaluate(() => ({
        trialTags: document.querySelectorAll('.plan-card-trial').length,
        text: document.getElementById('funnelRoot').textContent
      }));
      assert.equal(r.trialTags, 0);
      assert.equal(/trial|free days|d[ií]as gratis/i.test(r.text), false, 'sin trial no se menciona ninguna prueba');
      await page.close();

      const page2 = await openPaywall(ctx, {
        annual: MOCK.usd.annual,
        monthly: MOCK.usd.monthly,
        annualTrial: { period: { number: 7, unit: 'DAY' } }
      });
      const r2 = await page2.evaluate(async () => {
        const before = document.querySelector('.paywall-disclosure').textContent;
        document.getElementById('plan-annual').click();
        await new Promise((res) => setTimeout(res, 250));
        return {
          tags: [...document.querySelectorAll('.plan-card-trial')].map((n) => n.textContent.trim()),
          before,
          disclosure: document.querySelector('.paywall-disclosure').textContent
        };
      });
      assert.equal(/trial/i.test(r2.before), false, 'el mensual sin trial no menciona prueba');
      assert.equal(r2.tags.length, 1);
      assert.match(r2.tags[0], /7 days/);
      assert.match(r2.disclosure, /7 days trial/);
      await page2.close();
    });

    check('20-21. el contador se crea al entrar por primera vez', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const r = await page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('brainy_funnel_state'));
        const banner = document.querySelector('.paywall-banner-label').textContent.trim();
        const minutes = document.getElementById('paywallMinutes').textContent;
        const seconds = document.getElementById('paywallSeconds').textContent;
        return {
          stored: state.paywallOfferExpiresAt,
          now: Date.now(),
          banner, minutes, seconds,
          numbers: document.querySelector('.paywall-countdown-numbers').textContent.replace(/\s+/g, ' ').trim()
        };
      });
      assert.equal(r.banner, 'THIS OFFER ENDS IN');
      assert.ok(r.stored > r.now, 'el timestamp debe estar en el futuro');
      assert.ok(r.stored - r.now <= 15 * 60 * 1000, 'dura como maximo 15 minutos');
      assert.ok(r.stored - r.now > 14 * 60 * 1000, 'empieza practicamente en 15:00');
      assert.ok(/^\d{2}$/.test(r.minutes) && /^\d{2}$/.test(r.seconds));
      assert.match(r.numbers, /MINUTES.*:.*SECONDS/);
      await page.close();
    });

    check('22. recargar no reinicia el contador', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const before = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt);
      await page.reload({ waitUntil: 'domcontentloaded' });
      for (let i = 0; i < 120; i += 1) {
        if (await page.evaluate(() => document.querySelectorAll('.plan-card').length === 2)) break;
        await page.waitForTimeout(100);
      }
      const after = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt);
      assert.equal(after, before, 'el vencimiento debe ser identico tras recargar');
      await page.close();
    });

    check('23-24. volver atras y cambiar de plan no reinician el contador', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const before = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt);
      // Cambiar de plan rerenderiza.
      await page.evaluate(() => document.getElementById('plan-annual').click());
      await page.waitForTimeout(250);
      const afterSelect = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt);
      assert.equal(afterSelect, before, 'cambiar de plan no reinicia');
      // Volver atras y regresar.
      await page.evaluate(() => document.getElementById('funnelBackBtn').click());
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        currentStepIndex = stepList().findIndex((s) => s.id === 'paywall');
        renderStep();
      });
      for (let i = 0; i < 120; i += 1) {
        if (await page.evaluate(() => document.querySelectorAll('.plan-card').length === 2)) break;
        await page.waitForTimeout(100);
      }
      const afterBack = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt);
      assert.equal(afterBack, before, 'volver atras no reinicia');
      await page.close();
    });

    check('25. dos pestanas observan el mismo vencimiento', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const page2 = await ctx.newPage();
      await page2.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
      for (let i = 0; i < 120; i += 1) {
        if (await page2.evaluate(() => document.querySelectorAll('.plan-card').length === 2)) break;
        await page2.waitForTimeout(100);
      }
      const a = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt);
      const b = await page2.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt);
      assert.equal(a, b, 'ambas pestanas comparten el vencimiento');
      // Y el evento storage: escribir en una pestana actualiza la otra.
      await page2.evaluate(() => {
        const st = JSON.parse(localStorage.getItem('brainy_funnel_state'));
        st.paywallOfferExpiresAt = st.paywallOfferExpiresAt - 60000;
        localStorage.setItem('brainy_funnel_state', JSON.stringify(st));
      });
      await page.waitForTimeout(700);
      const synced = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt);
      assert.ok(synced <= b - 60000, 'la pestana que escucha storage se sincroniza');
      await page2.close();
      await page.close();
    });

    check('26-27. a 00:00 el CTA se bloquea y purchase() no se ejecuta', async () => {
      const page = await openPaywall(ctx, MOCK.usd, { paywallOfferExpiresAt: Date.now() + 1200 });
      await page.waitForTimeout(1800);
      const r = await page.evaluate(async () => {
        const btn = document.getElementById('purchaseBtn');
        const snap = () => ({
          disabled: !!(btn && btn.disabled),
          text: btn ? btn.textContent.trim() : null,
          noteHidden: document.getElementById('paywallExpired') ? document.getElementById('paywallExpired').hidden : null,
          minutes: (document.getElementById('paywallMinutes') || {}).textContent,
          seconds: (document.getElementById('paywallSeconds') || {}).textContent,
          onScreen: !!document.querySelector('.step-paywall')
        });
        const before = snap();
        // Aunque se fuerce el click, no debe salir ninguna llamada.
        if (btn) btn.click();
        await new Promise((res) => setTimeout(res, 600));
        return { before, after: snap(), calls: window.__sdk.purchaseCalls.length,
          stored: JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt };
      });
      assert.equal(r.before.onScreen, true, 'el paywall debe seguir en pantalla al vencer');
      assert.equal(r.before.disabled, true, `el CTA debe quedar deshabilitado: ${JSON.stringify(r.before)}`);
      assert.equal(r.before.noteHidden, false, 'debe mostrarse "This offer has expired."');
      assert.equal(r.before.text, 'This offer has expired.');
      assert.equal(r.before.minutes, '00');
      assert.equal(r.before.seconds, '00');
      assert.equal(r.calls, 0, 'purchase() no debe recibir ninguna llamada tras vencer');
      const again = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt);
      assert.equal(again, r.stored, 'el vencimiento no se renueva solo');
      await page.close();
    });

    check('28. el reset completo elimina el timestamp', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt > 0));
      await page.evaluate(() => {
        const st = JSON.parse(localStorage.getItem('brainy_funnel_state'));
        st.nq01_gender = 'Male';
        localStorage.setItem('brainy_funnel_state', JSON.stringify(st));
        localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === 'begin')));
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      await page.evaluate(() => document.querySelector('[data-action="reset"]').click());
      await page.waitForTimeout(500);
      const v = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).paywallOfferExpiresAt);
      assert.equal(v, null, 'reset debe borrar el timestamp');
      await page.close();
    });

    check('29-30. el CTA llama una vez; doble clic no duplica', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const r = await page.evaluate(async () => {
        const btn = document.getElementById('purchaseBtn');
        btn.click();
        btn.click();
        btn.click();
        await new Promise((res) => setTimeout(res, 600));
        return window.__sdk.purchaseCalls.length;
      });
      assert.equal(r, 1, 'exactamente una llamada a purchase()');
      await page.close();
    });

    check('31-32. metadata exacta y sin PII', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const calls = await page.evaluate(async () => {
        document.getElementById('purchaseBtn').click();
        await new Promise((res) => setTimeout(res, 500));
        return window.__sdk.purchaseCalls;
      });
      assert.equal(calls.length, 1);
      // El wrapper RC construye metadata; aqui comprobamos el contrato del SDK.
      // Frontera real del SDK: lo que llega a Purchases.purchase().
      const params = calls[0];
      assert.deepEqual(params.metadata, { brainy_plan_id: PLAN_ID }, 'metadata exactamente brainy_plan_id');
      assert.deepEqual(Object.keys(params.metadata), ['brainy_plan_id'], 'sin claves extra');
      const serialized = JSON.stringify(params.metadata);
      assert.equal(/claim|token|@|email|user/i.test(serialized), false, `PII en metadata: ${serialized}`);
      assert.equal(params.rcPackage.identifier, 'monthly_mock_id');
      assert.ok(params.customerEmail, 'el email sigue viajando al checkout como antes');
      const html = fs.readFileSync(path.join(ROOT, 'assets/revenuecat.js'), 'utf8');
      assert.match(html, /metadata: \{ brainy_plan_id: opts\.planId \}/);
      await page.close();
    });

    check('33. alreadyPro sigue sin comprar', async () => {
      const page = await ctx.newPage();
      await page.route('**/revenuecat-sdk*.js', (route) => route.fulfill({
        status: 200, contentType: 'application/javascript', body: ''
      }));
      await page.route('**/revenuecat-sdk*.js', (route) => route.fulfill({
        status: 200, contentType: 'application/javascript', body: ''
      }));
      await page.addInitScript(MOCK_SCRIPT(MOCK.usd, { alreadyPro: true }));
      await page.addInitScript(`(() => {
        const real = window.fetch;
        window.fetch = function (url, init) {
          const href = String(url && url.url ? url.url : url);
          if (href.indexOf('prepare-funnel-account') > -1) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({ userId: '11111111-1111-4111-8111-111111111111', alreadyPro: true })
            });
          }
          return real.apply(this, arguments);
        };
      })()`);
      await page.goto(`${base}/funnel.html`);
      await page.evaluate(() => {
        localStorage.setItem('brainy_funnel_state', JSON.stringify({
          locale: 'en', nq01_gender: 'Female', selectedTasks: ['t'], selectedRoutines: ['r'],
          planId: '11111111-1111-4111-8111-111111111111', claimToken: 'claim-abc',
          email: 'pro@example.com'
        }));
        localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === 'paywall')));
      });
      await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
      // Determinista: esperamos la resolucion en vez de dormir un tiempo fijo.
      for (let i = 0; i < 120; i += 1) {
        const done = await page.evaluate(() => funnelState.entitlementConfirmed
          || funnelState.alreadyPro !== undefined && funnelState.alreadyPro !== null
          || window.__sdk.purchaseCalls.length > 0
          || !!document.querySelector('.paywall-recovery'));
        if (done) break;
        await page.waitForTimeout(50);
      }
      const r = await page.evaluate(() => ({
        calls: window.__sdk.purchaseCalls.length,
        handoff: funnelState.handoffReady,
        confirmed: funnelState.entitlementConfirmed,
        alreadyPro: funnelState.alreadyPro,
        recovery: !!document.querySelector('.paywall-recovery'),
        cards: document.querySelectorAll('.plan-card').length
      }));
      assert.equal(r.recovery, false, 'alreadyPro no debe caer en la pantalla de recuperacion');
      assert.equal(r.alreadyPro, true, 'la identidad debe reportar alreadyPro');
      assert.equal(r.calls, 0, 'alreadyPro no debe comprar');
      assert.equal(r.confirmed, true, 'alreadyPro se resuelve por handoff');
      assert.equal(r.handoff, true);
      await page.close();
    });

    check('35. la explicacion cambia al cambiar de plan', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const monthly = await page.evaluate(() => document.querySelector('.paywall-disclosure').textContent);
      await page.evaluate(() => document.getElementById('plan-annual').click());
      await page.waitForTimeout(250);
      const annual = await page.evaluate(() => document.querySelector('.paywall-disclosure').textContent);
      assert.match(monthly, /monthly Brainy subscription for \$4\.99 per month/);
      assert.match(annual, /annual Brainy subscription for \$39\.99 per year/);
      assert.notEqual(monthly, annual);
      assert.match(annual, /charged today/);
      assert.match(annual, /renews automatically/);
      await page.close();
    });

    check('36-39. sin garantia falsa, links reales, sin marcas externas', async () => {
      const page = await openPaywall(ctx, MOCK.usd);
      const r = await page.evaluate(() => ({
        text: document.getElementById('funnelRoot').textContent,
        secure: document.querySelector('.paywall-secure-title').textContent.trim(),
        secureText: document.querySelector('.paywall-secure-text').textContent,
        links: [...document.querySelectorAll('.paywall-legal a')].map((a) => a.getAttribute('href')),
        imgs: [...document.querySelectorAll('img')].map((i) => i.src).filter((s) => /^https?:|base64/.test(s))
      }));
      assert.equal(r.secure, 'SECURE CHECKOUT');
      assert.match(r.secureText, /processed securely/);
      for (const bad of ['money-back', 'money back', 'risk-free', 'refund guarantee', '30-day', '30 day', 'full refund']) {
        assert.equal(r.text.toLowerCase().includes(bad.toLowerCase()), false, `garantia falsa: ${bad}`);
      }
      for (const bad of ['MellowFlow', 'Visa', 'Mastercard', 'mellowflow.com']) {
        assert.equal(r.text.includes(bad), false, `marca externa: ${bad}`);
      }
      assert.deepEqual(r.links, ['terms.html', 'privacy.html', 'support.html']);
      for (const href of r.links) {
        const res = await page.request.get(`${base}/${href}`);
        assert.equal(res.status(), 200, `${href} debe existir`);
      }
      assert.deepEqual(r.imgs, []);
      await page.close();
    });

    check('40. sin overflow horizontal en 320, 390 y 430', async () => {
      for (const width of [320, 390, 430]) {
        const c = await browser.newContext({ viewport: { width, height: width === 320 ? 568 : 844 } });
        const page = await openPaywall(c, MOCK.usd);
        const r = await page.evaluate(() => {
          const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          const prices = [...document.querySelectorAll('.plan-card-price')].map((n) => {
            const b = n.getBoundingClientRect();
            return { w: Math.round(b.width), clipped: b.right > document.documentElement.clientWidth };
          });
          const badge = document.querySelector('.plan-badge').getBoundingClientRect();
          const cta = document.getElementById('purchaseBtn').getBoundingClientRect();
          const daily = [...document.querySelectorAll('.plan-card-daily')].map((n) => {
            const b = n.getBoundingClientRect();
            return b.top >= 0 && b.width > 0;
          });
          return {
            over,
            pricesClipped: prices.some((p) => p.clipped),
            badgeVisible: badge.width > 0 && badge.top >= 0,
            ctaWide: cta.width > document.documentElement.clientWidth * 0.7,
            ctaInside: cta.left >= 0 && cta.right <= document.documentElement.clientWidth,
            dailyOk: daily.every(Boolean),
            disclose: (() => { const d = document.querySelector('.paywall-disclosure').getBoundingClientRect(); return d.width > 0; })()
          };
        });
        assert.equal(r.over, 0, `overflow de ${r.over}px a ${width}px`);
        assert.equal(r.pricesClipped, false);
        assert.equal(r.badgeVisible, true);
        assert.equal(r.ctaWide, true);
        assert.equal(r.ctaInside, true);
        assert.equal(r.dailyOk, true);
        assert.equal(r.disclose, true);
        await page.close();
        await c.close();
      }
    });

    check('41. backend, Edge Functions y Supabase sin cambios', async () => {
      const { execFileSync } = require('node:child_process');
      const changed = execFileSync('git', ['diff', '--name-only', 'origin/main', '--'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').map((x) => x.trim()).filter(Boolean);
      const forbidden = changed.filter((f) => f.startsWith('supabase/')
        || f === 'assets/revenuecat.js' || f === 'assets/revenuecat-sdk.js' || f === 'assets/funnel-identity.js');
      assert.deepEqual(forbidden, [], `archivos prohibidos: ${forbidden.join(', ')}`);
      // Config de RevenueCat identica a main: no se toco producto ni precio.
      const base = execFileSync('git', ['show', 'origin/main:funnel.html'], { cwd: ROOT, encoding: 'utf8' });
      const html = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
      const configOf = (src) => /const FUNNEL_CONFIG = \{[\s\S]*?\n        \};/.exec(src)[0];
      assert.equal(configOf(html), configOf(base), 'la configuracion de RevenueCat no debe cambiar');
    });
  } finally {
    let failed = 0;
    for (const [name, fn] of checks) {
      try {
        await fn();
        console.log(`ok   - ${name}`);
      } catch (err) {
        failed += 1;
        console.log(`FAIL - ${name}\n       ${err.message}`);
      }
    }
    console.log(`\n${checks.length - failed}/${checks.length} checks ok`);
    if (failed) process.exitCode = 1;
    await browser.close();
    server.close();
  }
}

main();