/* Regresion de la pantalla terminal post-compra.
 *
 * Comprueba que la confirmacion final es informativa y sin acciones:
 * sin QR, sin redemption URL, sin copiar enlace, sin App Store ni Google
 * Play, sin deep links, sin Gestionar suscripcion, sin flecha Atras y sin
 * ningun elemento enfocable.
 *
 * Mocks locales, sin red, sin compras, sin cancelaciones.
 * Run: npm run test:minimal-success
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const funnel = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
const UUID = '11111111-1111-4111-8111-111111111111';

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

/* Monta el funnel en la pantalla terminal.
 * extraState permite construir el caso de compra nueva y el de alreadyPro. */
async function openTerminal(ctx, base, extraState) {
  const page = await ctx.newPage();
  await page.route((u) => u.pathname.endsWith('/assets/revenuecat-sdk.js'), (r) =>
    r.fulfill({ body: '/* SDK sustituido */', contentType: 'application/javascript' }));
  await page.addInitScript(`
    (function () {
      window.__purchaseCalls = 0;
      window.__planCalls = [];
      var real = window.fetch;
      window.fetch = function (url, init) {
        var href = String(url && url.url ? url.url : url);
        if (href.indexOf('prepare-funnel-account') > -1) {
          return Promise.resolve({ ok: true, status: 200,
            json: async () => ({ userId: '${UUID}', alreadyPro: false }) });
        }
        if (href.indexOf('create-funnel-plan') > -1) {
          window.__planCalls.push(href);
          var body = {};
          try { body = JSON.parse(init && init.body); } catch (e) {}
          if (window.__planCalls.length === 1) {
            return Promise.resolve({ ok: true, status: 200,
              json: async () => ({ planId: '${UUID}', claimToken: 'claim-test' }) });
          }
          return Promise.resolve({ ok: true, status: 200,
            json: async () => ({ planId: '${UUID}', claimToken: 'claim-test' }) });
        }
        return real.apply(this, arguments);
      };
    })();
  `);
  await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof stepList === 'function', null, { timeout: 20000 });
  await page.evaluate((extra) => {
    localStorage.clear();
    localStorage.setItem('brainy_funnel_state', JSON.stringify(Object.assign({
      locale: 'en',
      nq01_gender: 'Female',
      selectedTasks: ['foco_productividad'],
      selectedRoutines: ['top_3_dia'],
      email: 'buyer@example.com',
      planId: '11111111-1111-4111-8111-111111111111',
      claimToken: 'claim-test'
    }, extra)));
    localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === 'success')));
  }, extraState);
  await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof stepList === 'function', null, { timeout: 20000 });
  await page.waitForSelector('.step-done', { timeout: 20000 });
  return page;
}

const PURCHASED = {
  purchaseCompleted: true,
  handoffReady: true,
  entitlementConfirmed: true,
  redemptionPersisted: true,
  alreadyPro: false,
  pendingRedemptionUrl: null,
};

const ALREADY_PRO = {
  alreadyPro: true,
  handoffReady: true,
  planId: '11111111-1111-4111-8111-111111111111',
  claimToken: 'claim-test',
  pendingRedemptionUrl: null,
};

async function main() {
  const { server, base } = await startServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const cases = [];
  const check = (name, run) => cases.push([name, run]);
  let purchasedPage = null;
  let proPage = null;

  try {
    /* --- 1-8: la pantalla normal no tiene acciones --- */
    check('normal: sin QR, redemption URL, copiar enlace ni stores', async () => {
      purchasedPage = await openTerminal(ctx, base, PURCHASED);
      const r = await purchasedPage.evaluate(() => {
        const root = document.getElementById('funnelRoot');
        const html = root.innerHTML;
        return {
          hasQr: !!root.querySelector('svg[data-qr], .qr, canvas') || /qrSvg/i.test(html),
          hasCopy: /copyLinkBtn|Copiar enlace|Copy link/i.test(html),
          hasStores: /apps\.apple\.com|play\.google\.com|App Store|Google Play/i.test(html),
          hasDeepLink: /brainy:\/\//i.test(html),
          hasManage: /manage-subscription|Gestionar suscripción|Manage subscription/i.test(html),
          hasClaim: /redeem|redemption|claimToken/i.test(html),
          hasInstall: /Instala Brainy|Install Brainy|Continúa en tu teléfono|Continue on your phone/i.test(html),
          hasChecklist: !!root.querySelector('.success-checks'),
          hasPhoneSection: /handoff-steps|handoff-stores|openAppBtn/i.test(html),
          buttons: root.querySelectorAll('button, a, input, select, textarea').length,
        };
      });
      assert.equal(r.hasQr, false, 'sin QR');
      assert.equal(r.hasCopy, false, 'sin copiar enlace');
      assert.equal(r.hasStores, false, 'sin App Store ni Google Play');
      assert.equal(r.hasDeepLink, false, 'sin deep links');
      assert.equal(r.hasManage, false, 'sin Gestionar suscripción');
      assert.equal(r.hasClaim, false, 'sin redemption URL ni claimToken');
      assert.equal(r.hasInstall, false, 'sin instrucciones de instalación');
      assert.equal(r.hasChecklist, false, 'sin checklist');
      assert.equal(r.hasPhoneSection, false, 'sin sección de teléfono');
      assert.equal(r.buttons, 0, 'ningún botón, enlace ni campo');
    });

    /* --- 9-10: copy de correo --- */
    check('normal: mensaje de correo presente y copy completo', async () => {
      const t = await purchasedPage.evaluate(() => {
        const root = document.getElementById('funnelRoot');
        return {
          eyebrow: (root.querySelector('.done-eyebrow') || {}).textContent || '',
          h1: (root.querySelector('h1') || {}).textContent || '',
          lede: (root.querySelector('.done-lede') || {}).textContent || '',
          mailTitle: (root.querySelector('.done-mail-title') || {}).textContent || '',
          mailText: (root.querySelector('.done-mail-text') || {}).textContent || '',
          note: (root.querySelector('.done-note') || {}).textContent || '',
          close: (root.querySelector('.done-close') || {}).textContent || '',
        };
      });
      assert.equal(t.eyebrow.toLowerCase(), 'all set');
      assert.equal(t.h1, 'Your plan is ready');
      assert.match(t.lede, /purchase completed successfully/i);
      assert.equal(t.mailTitle, 'Check your email');
      assert.match(t.mailText, /In a few seconds you’ll receive an email with your access details/);
      assert.match(t.note, /Spam or Promotions/);
      assert.equal(t.close, 'You can close this window.');
      // "recibirás", nunca "hemos enviado".
      const all = JSON.stringify(t);
      assert.equal(/we (have )?sent|we('|’)ve sent|already sent|email sent/i.test(all), false,
        'no debe afirmar que el correo ya fue enviado');
    });

    /* --- alreadyPro --- */
    check('alreadyPro: copy propio y SIN mensaje de correo', async () => {
      proPage = await openTerminal(ctx, base, ALREADY_PRO);
      const r = await proPage.evaluate(() => {
        const root = document.getElementById('funnelRoot');
        return {
          h1: (root.querySelector('h1') || {}).textContent || '',
          lede: (root.querySelector('.done-lede') || {}).textContent || '',
          mail: !!root.querySelector('.done-mail'),
          note: !!root.querySelector('.done-note'),
          buttons: root.querySelectorAll('button, a, input').length,
        };
      });
      assert.equal(r.h1, 'Your Pro access is already active');
      assert.match(r.lede, /already has access to Brainy Pro/i);
      assert.match(r.lede, /sign in with your usual account/i);
      assert.equal(r.mail, false, 'alreadyPro NO debe prometer un correo nuevo');
      assert.equal(r.note, false);
      assert.equal(r.buttons, 0, 'sin acciones');
      await proPage.close();
    });

    /* --- 11: progreso al 100% --- */
    check('ambas etapas al 100% en la pantalla terminal', async () => {
      const r = await purchasedPage.evaluate(() => ({
        w0: document.getElementById('funnelProfileFill').style.width,
        w1: document.getElementById('funnelPlanFill').style.width,
        states: [...document.querySelectorAll('.funnel-stage')].map((n) => n.dataset.state),
        headerVisible: !document.getElementById('funnelProgress').hidden,
      }));
      assert.equal(r.w0, '100%', 'etapa 1 al 100%');
      assert.equal(r.w1, '100%', 'etapa 2 al 100%');
      assert.deepEqual(r.states, ['done', 'done'], 'ambas etapas en done');
      assert.equal(r.headerVisible, true, 'el encabezado de etapas sigue visible');
    });

    /* --- 12: flecha atrás --- */
    check('flecha Atrás oculta en el estado terminal', async () => {
      const hidden = await purchasedPage.evaluate(() => {
        const b = document.getElementById('funnelBackBtn');
        return { hidden: b.hidden, visible: b.offsetParent === null };
      });
      assert.equal(hidden.hidden, true, 'el botón Atrás debe estar oculto');
      assert.equal(hidden.visible, true, 'no debe ser visible');
    });

    /* --- 13: accesibilidad --- */
    check('accesibilidad: role=status, aria-live, check decorativo, sin focusables', async () => {
      const r = await purchasedPage.evaluate(() => {
        const inner = document.querySelector('.step-done-inner');
        const badge = document.querySelector('.done-badge');
        const h1s = [...document.querySelectorAll('.step-done h1')];
        const focusables = [...document.querySelectorAll('.step-done a, .step-done button, .step-done [tabindex]')];
        return {
          role: inner && inner.getAttribute('role'),
          live: inner && inner.getAttribute('aria-live'),
          badgeHidden: badge && badge.getAttribute('aria-hidden'),
          h1Count: h1s.length,
          h1Text: h1s[0] ? h1s[0].textContent : '',
          focusables: focusables.length,
        };
      });
      assert.equal(r.role, 'status');
      assert.equal(r.live, 'polite');
      assert.equal(r.badgeHidden, 'true', 'el check decorativo es aria-hidden');
      assert.equal(r.h1Count, 1, 'un solo h1');
      assert.ok(r.h1Text.length > 0);
      assert.equal(r.focusables, 0, 'nada enfocable');
    });

    /* --- 14: purchase() no se repite --- */
    check('purchase() no se ejecuta al montar, recargar ni volver a renderizar', async () => {
      // Instrumentado en el SDK sustituido: cualquier llamada a purchase() graba.
      await purchasedPage.evaluate(() => { window.__purchaseCalls = 0; });
      await purchasedPage.reload({ waitUntil: 'domcontentloaded' });
      await purchasedPage.waitForSelector('.step-done', { timeout: 20000 });
      const afterReload = await purchasedPage.evaluate(() => window.__purchaseCalls);
      assert.equal(afterReload, 0, 'recargar no debe comprar');
      // Re-montar el componente tampoco.
      const remounts = await purchasedPage.evaluate(() => {
        for (let i = 0; i < 5; i += 1) renderTerminalDone(false);
        return window.__purchaseCalls;
      });
      assert.equal(remounts, 0, 'volver a montar no debe comprar');
      // Y no hay ninguna llamada a purchase() en la pantalla terminal.
      const code = funnel.slice(funnel.indexOf('function renderTerminalDone'), funnel.indexOf('function renderSuccess'));
      assert.equal(/purchase\(/.test(code), false, 'la pantalla terminal no llama a purchase()');
    });

    /* --- 15: recovery intacto --- */
    check('recovery sigue presente y no recompra', async () => {
      const rs = funnel.indexOf('async function retryPendingRedemption');
      const re2 = funnel.indexOf('\n        }', rs);
      assert.ok(rs >= 0 && re2 > rs, 'retryPendingRedemption sigue existiendo');
      assert.equal(funnel.slice(rs, re2).includes('purchase('), false, 'recovery no recompra');
      // La rama de recovery de la pantalla terminal sigue intacta.
      assert.match(funnel, /id="retryHandoffBtn"/, 'el botón de recovery sigue en el código');
      assert.match(funnel, /handoff_recovery_required/);
      // Las guardas de compra no se han tocado.
      assert.match(funnel, /const ready = \(existingPro \|\| \(!!funnelState\.purchaseCompleted && entitlementConfirmed\)\) &&/);
      assert.match(funnel, /!!funnelState\.handoffReady && hasRealPlan\(\)/);
    });

    /* --- 16: backend, RevenueCat y Supabase sin cambios --- */
    check('backend, RevenueCat y Supabase sin cambios', async () => {
      const changed = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter(Boolean).map((l) => l.slice(3));
      assert.deepEqual(changed.filter((f) => f.startsWith('supabase/') || /\.sql$/.test(f) || /webhook/i.test(f)), [],
        'sin cambios en backend');
      // Config pública intacta.
      assert.match(funnel, /assets\/site-config\.js/);
      const cfg = fs.readFileSync(path.join(ROOT, 'assets/site-config.js'), 'utf8');
      assert.match(cfg, /revenuecatOfferingId: 'web_default'/);
      assert.match(cfg, /revenuecatEntitlementId: 'brainy Pro'/);
      // Metadata de compra intacta.
      const wrapper = fs.readFileSync(path.join(ROOT, 'assets/revenuecat.js'), 'utf8');
      assert.match(wrapper, /metadata: \{ brainy_plan_id: opts\.planId \}/);
      assert.equal(/purchase\(\)/.test(fs.readFileSync(path.join(ROOT, 'manage-subscription/index.html'), 'utf8')), false);
    });

    /* --- 17: el resto del funnel intacto --- */
    check('preguntas, orden del funnel y otros pasos sin cambios', async () => {
      const baseFunnel = execFileSync('git', ['show', 'origin/main:funnel.html'], { cwd: ROOT, encoding: 'utf8' });
      const stepsOf = (s) => (s.match(/FUNNEL_STEPS = \[[\s\S]*?\n        \];/) || [''])[0];
      assert.equal(JSON.stringify(stepsOf(funnel)), JSON.stringify(stepsOf(baseFunnel)),
        'FUNNEL_STEPS idéntico: orden y contenido intactos');
      const keys = (s) => [...new Set([...s.matchAll(/key:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]))].sort();
      assert.deepEqual(keys(funnel), keys(baseFunnel), 'claves de pregunta idénticas');
      for (const f of ['brainy-tasks-steps.json', 'brainy-daily-routines.json']) {
        assert.equal(fs.readFileSync(path.join(ROOT, f), 'utf8'),
          execFileSync('git', ['show', `origin/main:${f}`], { cwd: ROOT, encoding: 'utf8' }), `${f} sin cambios`);
      }
      // Pantallas anteriores intactas.
      for (const fn of ['renderQuestion', 'renderPicker', 'renderPlanSummary', 'renderContact', 'renderPaywall', 'renderBegin', 'renderInterstitial']) {
        const a = (baseFunnel.match(new RegExp(`function ${fn}\\(`)) || []).length;
        const b = (funnel.match(new RegExp(`function ${fn}\\(`)) || []).length;
        assert.equal(a, b, `${fn} sigue presente`);
      }
    });

    let passed = 0;
    for (const [name, run] of cases) {
      await run();
      passed += 1;
      console.log(`PASS ${name}`);
    }
    console.log(`minimal-success regression: ${passed}/${cases.length} passed`);
  } finally {
    await ctx.close();
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});