/* Capturas de la pantalla terminal post-compra.
 * Sin red externa, sin compras, sin cancelaciones.
 * Run: npm run shots:minimal-success
 *   SALIDA=ruta/para/guardar  cambia el directorio de salida
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.SALIDA || path.join(ROOT, 'captures', 'minimal-success');
const UUID = '11111111-1111-4111-8111-111111111111';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const SHOTS = [
  ['375x812', 375, 812],
  ['390x844', 390, 844],
  ['1280x900', 1280, 900],
];

const STATES = {
  compra: {
    locale: 'en',
    nq01_gender: 'Female',
    selectedTasks: ['foco_productividad'],
    selectedRoutines: ['top_3_dia'],
    email: 'buyer@example.com',
    planId: UUID,
    claimToken: 'claim-test',
    purchaseCompleted: true,
    handoffReady: true,
    entitlementConfirmed: true,
    redemptionPersisted: true,
    alreadyPro: false,
    pendingRedemptionUrl: null,
  },
  alreadyPro: {
    locale: 'en',
    nq01_gender: 'Female',
    selectedTasks: ['foco_productividad'],
    selectedRoutines: ['top_3_dia'],
    alreadyPro: true,
    handoffReady: true,
    planId: UUID,
    claimToken: 'claim-test',
    pendingRedemptionUrl: null,
  },
};

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

async function shoot(ctx, base, label, [name, width, height], state) {
  const page = await ctx.newPage();
  await page.route((u) => u.pathname.endsWith('/assets/revenuecat-sdk.js'), (r) =>
    r.fulfill({ body: '/* stub */', contentType: 'application/javascript' }));
  await page.addInitScript(`
    (function () {
      var real = window.fetch;
      window.fetch = function (url, init) {
        var href = String(url && url.url ? url.url : url);
        if (href.indexOf('prepare-funnel-account') > -1) {
          return Promise.resolve({ ok: true, status: 200,
            json: async () => ({ userId: '${UUID}', alreadyPro: false }) });
        }
        return real.apply(this, arguments);
      };
    })();
  `);
  await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof stepList === 'function', null, { timeout: 20000 });
  await page.evaluate((st) => {
    localStorage.clear();
    localStorage.setItem('brainy_funnel_state', JSON.stringify(st));
    localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === 'success')));
  }, state);
  await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.step-done', { timeout: 20000 });
  await page.waitForTimeout(400);
  const file = path.join(OUT, `${label}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  ${path.relative(ROOT, file)}`);
  await page.close();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, base } = await startServer();
  const browser = await chromium.launch();
  try {
    for (const [label, state] of Object.entries(STATES)) {
      for (const [name, width, height] of SHOTS) {
        // Un contexto por captura: el viewport del contexto manda, no el de la pagina.
        const ctx = await browser.newContext({ viewport: { width, height } });
        await shoot(ctx, base, label, [name, width, height], state);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`capturas guardadas en ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });