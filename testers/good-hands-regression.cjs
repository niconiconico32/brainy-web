// Regresion de la pantalla intermedia "You're in good hands." (frontend only).
// Run: npm run test:good-hands
//   GOOD_HANDS_HEADFUL=1  muestra el navegador
//   FUNNEL_BASE_REF=main  rama de referencia para comparar copy/payload

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ANCHOR_KEY = 'nq10_phone';
const NEW_ID = 'good_hands';

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

const at = async (page, base, id) => {
  await page.goto(`${base}/funnel.html`);
  await page.evaluate(() => localStorage.setItem('brainy_funnel_state', JSON.stringify({ locale: 'en' })));
  await page.goto(`${base}/funnel.html`);
  await page.evaluate((wanted) => {
    const i = stepList().findIndex((s) => s.id === wanted);
    localStorage.setItem('brainy_funnel_step', String(i));
  }, id);
  await page.goto(`${base}/funnel.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
};

const headline = (page) => page.evaluate(() => (document.querySelector('.step h1') || {}).textContent || '');

async function main() {
  const checks = [];
  const check = (name, fn) => checks.push([name, fn]);

  const html = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: !process.env.GOOD_HANDS_HEADFUL });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  try {
    check('1. el paso va justo despues de la pregunta ancla', async () => {
      await at(page, base, NEW_ID);
      const order = await page.evaluate(() => stepList().map((s) => s.id));
      assert.equal(order.filter((id) => id === NEW_ID).length, 1, 'el paso no debe duplicarse al reconstruir stepList()');
      const i = order.indexOf(NEW_ID);
      assert.equal(order[i - 1], 'nq10');
      assert.equal(await page.evaluate(() => stepList()[stepList().findIndex((s) => s.id === 'good_hands') - 1].key), ANCHOR_KEY);
    });

    check('2. Continue lleva al siguiente paso original', async () => {
      await at(page, base, NEW_ID);
      await page.evaluate(() => document.getElementById('nextBtn').click());
      await page.waitForTimeout(400);
      assert.match(await headline(page), /put off important tasks/);
    });

    check('3. Back vuelve a la pregunta del telefono', async () => {
      await page.evaluate(() => document.getElementById('funnelBackBtn').click());
      await page.waitForTimeout(400);
      assert.equal(await headline(page), 'You’re in good hands.');
      await page.evaluate(() => document.getElementById('funnelBackBtn').click());
      await page.waitForTimeout(400);
      assert.match(await headline(page), /on your phone too much/);
    });

    check('4. el paso no escribe ninguna respuesta', async () => {
      await at(page, base, NEW_ID);
      const diff = await page.evaluate(async () => {
        const before = JSON.parse(localStorage.getItem('brainy_funnel_state'));
        document.getElementById('nextBtn').click();
        await new Promise((r) => setTimeout(r, 500));
        const after = JSON.parse(localStorage.getItem('brainy_funnel_state'));
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      });
      assert.deepEqual(diff, [], `el paso escribio: ${diff.join(', ')}`);
    });

    check('5. el paso no modifica el payload', async () => {
      const payload = await page.evaluate(async () => {
        const calls = [];
        const real = window.fetch;
        window.fetch = (...a) => { calls.push(String(a[0])); return real(...a); };
        document.getElementById("funnelBackBtn").click();
        await new Promise((r) => setTimeout(r, 400));
        window.fetch = real;
        return calls;
      });
      assert.deepEqual(payload, [], `el paso disparo red: ${payload.join(', ')}`);
    });

    check('6. el paso pertenece a Creando tu Perfil', async () => {
      await at(page, base, NEW_ID);
      const stages = await page.evaluate(() => [...document.querySelectorAll('.funnel-stage')]
        .map((n) => [n.dataset.stage, n.dataset.state]));
      assert.deepEqual(stages, [['profile', 'active'], ['plan', 'idle']]);
    });

    check('7. hay 1 circulo central y exactamente 8 exteriores', async () => {
      await at(page, base, NEW_ID);
      const n = await page.evaluate(() => ({
        center: document.querySelectorAll('.good-hands-avatar--center').length,
        outer: document.querySelectorAll('.good-hands-avatar:not(.good-hands-avatar--center)').length,
        orbits: document.querySelectorAll('.good-hands-orbit').length
      }));
      assert.deepEqual(n, { center: 1, outer: 8, orbits: 3 });
    });

    check('8. sin imagenes remotas, base64 ni datos personales', async () => {
      assert.equal(/good-hands[^}]*(https?:|\/\/|base64)/.test(html), false, 'la ilustracion no debe usar assets remotos');
      // img.src siempre es absoluta, asi que un asset local del propio sitio
      // tambien empieza por http://. Lo remoto es lo de otro origen.
      const remotes = await page.evaluate(() => [...document.querySelectorAll('img')]
        .map((i) => i.src).filter((s) => new URL(s, location.href).origin !== location.origin));
      assert.deepEqual(remotes, []);
      // Solo la pantalla nueva: MellowFlow ya existe en nq24_expert y no se toca.
      const mine = await page.evaluate(() => document.getElementById('funnelRoot').textContent);
      assert.equal(/MellowFlow/i.test(mine), false, 'la pantalla nueva no debe usar la marca de la referencia');
      assert.equal(/1 million|millón/i.test(html), false, 'no debe publicarse la cifra no verificada');
      assert.equal(/[\w.+-]+@[\w-]+\.[a-z]{2,}/.test(mine), false, 'no debe haber emails en pantalla');
    });

    check('9. no aparece el logo superior', async () => {
      assert.equal(await page.evaluate(() => document.querySelectorAll('.brand-row, .brand-name').length), 0);
    });

    check('10. sin overflow horizontal en 320/390/430', async () => {
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
        await at(page, base, NEW_ID);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(over, 0, `overflow de ${over}px a ${width}px`);
      }
    });

    check('11. el boton es accesible por teclado', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await at(page, base, NEW_ID);
      await page.evaluate(() => document.getElementById('funnelBackBtn').focus());
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'nextBtn');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      assert.match(await headline(page), /put off important tasks/);
    });

    check('12. la ilustracion decorativa no recibe foco', async () => {
      await at(page, base, NEW_ID);
      const r = await page.evaluate(() => {
        const fig = document.querySelector('.good-hands-figure');
        return {
          ariaHidden: fig.getAttribute('aria-hidden'),
          focusable: fig.querySelectorAll('a, button, input, [tabindex]').length
        };
      });
      assert.deepEqual(r, { ariaHidden: 'true', focusable: 0 });
    });
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
  } finally {
    await browser.close();
    server.close();
  }
}

main();