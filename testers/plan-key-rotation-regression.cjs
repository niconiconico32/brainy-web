// Regresion de la rotacion de client_plan_key ante 409 de create-funnel-plan.
//
// Contexto: el navegador guarda brainy_funnel_client_plan_key en localStorage.
// Si esa clave ya esta vinculada a una fila con funnel_user_id de OTRO email,
// el backend responde 409 identity_conflict. Antes el funnel solo rotaba la
// clave con plan_expired, asi que el usuario caia en un callejon sin salida:
// el toast decia "intentalo de nuevo" y reintentar fallaba igual.
//
// Aqui NO se llama a produccion: el endpoint create-funnel-plan esta mockeado
// en el navegador y el servidor es local (127.0.0.1).
//
// Run: npm run test:plan-key-rotation

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function serve() {
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

/* Monta el funnel en el paso prepaywall (el CTA "Continuar con mi plan") y
 * sustituye create-funnel-plan por una secuencia de respuestas.
 * `responses` se consume en orden; la ultima se repite si hace falta. */
async function openPrepaywall(ctx, base, responses) {
  const page = await ctx.newPage();
  await page.route('**/revenuecat-sdk*.js', (route) => route.fulfill({
    body: '/* SDK de RevenueCat sustituido: esta prueba no llama a RevenueCat */',
    contentType: 'application/javascript',
  }));

  await page.addInitScript(`
    (function () {
      window.__planCalls = [];
      window.__toasts = [];
      var real = window.fetch;
      window.fetch = function (url, init) {
        var href = String(url && url.url ? url.url : url);
        if (href.indexOf('prepare-funnel-account') > -1) {
          return Promise.resolve({
            ok: true, status: 200,
            json: async () => ({ userId: '${UUID_A}', alreadyPro: false })
          });
        }
        if (href.indexOf('create-funnel-plan') > -1) {
          var body = {};
          try { body = JSON.parse(init && init.body); } catch (e) { body = {}; }
          window.__planCalls.push({
            client_plan_key: body.client_plan_key || null,
            email: body.email || null
          });
          var queue = ${JSON.stringify(responses)};
          var step = window.__planCalls.length - 1;
          var answer = queue[Math.min(step, queue.length - 1)];
          return Promise.resolve({
            ok: answer.status < 400,
            status: answer.status,
            json: async () => answer.body
          });
        }
        return real.apply(this, arguments);
      };
    })();
  `);

  await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
  // El script del funnel define stepList al cargar: espera a que exista.
  await page.waitForFunction(() => typeof stepList === 'function', null, { timeout: 20000 });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('brainy_funnel_state', JSON.stringify({
      locale: 'en',
      nq01_gender: 'Female',
      selectedTasks: ['foco_productividad'],
      selectedRoutines: ['top_3_dia'],
      email: 'nuevo@example.com'
    }));
    localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === 'prepaywall')));
  });
  await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof stepList === 'function', null, { timeout: 20000 });
  await page.waitForSelector('#nextBtn', { timeout: 20000 });
  return page;
}

const clickAndWait = async (page, ms = 2500) => {
  await page.click('#nextBtn');
  await page.waitForTimeout(ms);
  return page.evaluate(() => ({
    calls: window.__planCalls,
    hasPlanId: !!(window.brainyFunnelState && window.brainyFunnelState.planId),
    planId: (window.brainyFunnelState || {}).planId || null,
    toast: (document.getElementById('toast') || {}).textContent || ''
  }));
};

async function main() {
  const { server, base } = await serve();
  const browser = await chromium.launch();
  const cases = [];
  const check = (name, run) => cases.push([name, run]);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

  try {
    // 1) identity_conflict: rota la clave y reintenta. Este es el bug arreglado.
    check('identity_conflict rota la clave y reintenta con una nueva', async () => {
      const page = await openPrepaywall(ctx, base, [
        { status: 409, body: { error: 'identity_conflict' } },
        { status: 200, body: { planId: 'plan-ok', claimToken: 'claim-ok' } },
      ]);
      const r = await clickAndWait(page);
      assert.equal(r.calls.length, 2, 'debe haber dos intentos');
      assert.ok(r.calls[0].client_plan_key, 'el primer intento debe enviar client_plan_key');
      assert.ok(r.calls[1].client_plan_key, 'el segundo intento debe enviar client_plan_key');
      assert.notEqual(r.calls[0].client_plan_key, r.calls[1].client_plan_key,
        'el segundo intento debe usar una client_plan_key DISTINTA');
      assert.equal(r.calls[1].email, r.calls[0].email, 'el email se mantiene en el reintento');
      assert.equal(r.hasPlanId, true, 'debe terminar con plan creado');
      assert.equal(r.planId, 'plan-ok');
      await page.close();
    });

    // 2) plan_expired: el comportamiento anterior se conserva.
    check('plan_expired sigue rotando la clave', async () => {
      const page = await openPrepaywall(ctx, base, [
        { status: 409, body: { error: 'plan_expired' } },
        { status: 200, body: { planId: 'plan-ok-2', claimToken: 'claim-ok-2' } },
      ]);
      const r = await clickAndWait(page);
      assert.equal(r.calls.length, 2);
      assert.notEqual(r.calls[0].client_plan_key, r.calls[1].client_plan_key);
      assert.equal(r.planId, 'plan-ok-2');
      await page.close();
    });

    // 3) 409 con plan real en curso o pagado: NO se rota (lo dejaría huérfano).
    for (const code of ['plan_already_claiming', 'plan_already_claimed', 'plan_already_paid']) {
      check(`${code} NO rota la clave`, async () => {
        const page = await openPrepaywall(ctx, base, [
          { status: 409, body: { error: code } },
          { status: 200, body: { planId: 'no-debe-usarse', claimToken: 'x' } },
        ]);
        const r = await clickAndWait(page);
        assert.equal(r.calls.length, 1, `no debe reintentar con ${code}`);
        assert.equal(r.hasPlanId, false, 'no debe crear plan');
        assert.match(r.toast, /No pudimos crear tu plan|We could not create your plan/,
          'debe avisar al usuario');
        await page.close();
      });
    }

    // 4) Error de servidor: no se reintenta automáticamente.
    check('500 no reintenta ni rota la clave', async () => {
      const page = await openPrepaywall(ctx, base, [
        { status: 500, body: { error: 'insert_failed' } },
        { status: 200, body: { planId: 'no-debe-usarse', claimToken: 'x' } },
      ]);
      const r = await clickAndWait(page);
      assert.equal(r.calls.length, 1);
      assert.equal(r.hasPlanId, false);
      await page.close();
    });

    // 5) Sin 409: un solo intento, sin rotación.
    check('200 directo no rota la clave', async () => {
      const page = await openPrepaywall(ctx, base, [
        { status: 200, body: { planId: 'plan-directo', claimToken: 'c' } },
      ]);
      const r = await clickAndWait(page);
      assert.equal(r.calls.length, 1);
      assert.equal(r.planId, 'plan-directo');
      await page.close();
    });

    let passed = 0;
    for (const [name, run] of cases) {
      await run();
      passed += 1;
      console.log(`PASS ${name}`);
    }
    console.log(`plan-key-rotation regression: ${passed}/${cases.length} passed`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});