// Regresion de la pantalla intermedia "You're not alone." (frontend only).
// Run: npm run test:not-alone
//   NOT_ALONE_HEADFUL=1  muestra el navegador

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const NEW_ID = 'not_alone';
const ANCHOR_KEY = 'nq15_struggle';

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
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: !process.env.NOT_ALONE_HEADFUL });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  try {
    check('1. aparece exactamente despues de la pregunta ancla', async () => {
      await at(page, base, NEW_ID);
      const r = await page.evaluate(() => {
        const l = stepList();
        const i = l.findIndex((s) => s.id === 'not_alone');
        return {
          count: l.filter((s) => s.id === 'not_alone').length,
          prev: l[i - 1] && l[i - 1].key,
          next: l[i + 1] && l[i + 1].id
        };
      });
      assert.equal(r.count, 1, 'el paso no debe duplicarse');
      assert.equal(r.prev, ANCHOR_KEY);
      assert.equal(r.next, 'interstitial_2', 'el siguiente paso original debe preservarse');
    });

    check('2. Back vuelve a la pregunta ancla', async () => {
      await page.evaluate(() => document.getElementById('funnelBackBtn').click());
      await page.waitForTimeout(450);
      assert.match(await headline(page), /struggling with the most/);
    });

    check('3. Continue avanza al siguiente paso original', async () => {
      // Volvemos a la pantalla para probar Continue desde un estado limpio.
      await at(page, base, NEW_ID);
      await page.evaluate(() => document.getElementById('nextBtn').click());
      await page.waitForTimeout(450);
      const landed = await page.evaluate(() => {
        const l = stepList();
        return { id: l[l.findIndex((s) => s.id === 'interstitial_2') - 1].id, h: (document.querySelector('.step h1') || {}).textContent };
      });
      assert.equal(landed.id, NEW_ID, 'Continue debe landingar en interstitial_2');
      assert.match(landed.h, /brain with a system works/);
    });

    check('4. pertenece a Creando tu Perfil', async () => {
      await at(page, base, NEW_ID);
      const stages = await page.evaluate(() => [...document.querySelectorAll('.funnel-stage')]
        .map((n) => [n.dataset.stage, n.dataset.state]));
      assert.deepEqual(stages, [['profile', 'active'], ['plan', 'idle']]);
    });

    check('5. no crea respuestas', async () => {
      const diff = await page.evaluate(async () => {
        const before = JSON.parse(localStorage.getItem('brainy_funnel_state'));
        document.getElementById('nextBtn').click();
        await new Promise((r) => setTimeout(r, 500));
        const after = JSON.parse(localStorage.getItem('brainy_funnel_state'));
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      });
      assert.deepEqual(diff, [], `escribio: ${diff.join(', ')}`);
    });

    check('6. no modifica el payload', async () => {
      await at(page, base, NEW_ID);
      const calls = await page.evaluate(async () => {
        const seen = [];
        const real = window.fetch;
        window.fetch = (...a) => { seen.push(String(a[0])); return real(...a); };
        document.getElementById('nextBtn').click();
        await new Promise((r) => setTimeout(r, 500));
        window.fetch = real;
        return seen;
      });
      assert.deepEqual(calls, [], `disparo red: ${calls.join(', ')}`);
    });

    check('7. existe un placeholder central', async () => {
      await at(page, base, NEW_ID);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.social-proof-avatar--center').length), 1);
    });

    check('8. existen exactamente nueve placeholders secundarios', async () => {
      const n = await page.evaluate(() => document.querySelectorAll('.social-proof-avatar:not(.social-proof-avatar--center)').length);
      assert.equal(n, 9);
    });

    check('9. no aparecen nombres ni logos de medios', async () => {
      const text = await page.evaluate(() => document.getElementById('funnelRoot').textContent);
      for (const outlet of ['Forbes', 'Business Insider', 'The New York Times', 'NYT', 'As featured on', 'TechCrunch', 'Wired']) {
        assert.equal(text.includes(outlet), false, `aparece ${outlet}`);
      }
    });

    check('10. sin MellowFlow ni cifras no verificadas en la pantalla nueva', async () => {
      const text = await page.evaluate(() => document.getElementById('funnelRoot').textContent);
      assert.equal(/MellowFlow/i.test(text), false, 'no debe aparecer MellowFlow en esta pantalla');
      for (const metric of ['1.3 million', '1 million', 'million people', 'millón', 'usuarios']) {
        assert.equal(new RegExp(metric, 'i').test(text), false, `afirmacion no verificada: ${metric}`);
      }
      // Sin testimonios atribuidos: ni nombre, cargo ni puntuacion.
      assert.equal(/[0-9](\.\d)?\s*\/\s*5/.test(text), false, 'no debe haber puntuacion');
    });

    check('11. no existen imagenes remotas', async () => {
      const remotes = await page.evaluate(() => [...document.querySelectorAll('img')]
        .map((i) => i.src).filter((s) => /^https?:|base64|^data:/.test(s)));
      assert.deepEqual(remotes, []);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.social-proof-figure img, .social-proof-figure svg').length), 0);
    });

    check('12. la composicion decorativa no recibe foco', async () => {
      await at(page, base, NEW_ID);
      const r = await page.evaluate(() => {
        const fig = document.querySelector('.social-proof-figure');
        return {
          ariaHidden: fig.getAttribute('aria-hidden'),
          focusable: fig.querySelectorAll('a, button, input, [tabindex]').length,
          quotesAria: [...document.querySelectorAll('.not-alone-quote')].map((q) => q.getAttribute('aria-hidden'))
        };
      });
      assert.equal(r.ariaHidden, 'true');
      assert.equal(r.focusable, 0);
      assert.deepEqual(r.quotesAria, ['true', 'true']);
    });

    check('13. el boton funciona con teclado', async () => {
      await at(page, base, NEW_ID);
      await page.evaluate(() => document.getElementById('funnelBackBtn').focus());
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'nextBtn');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(450);
      assert.match(await headline(page), /brain with a system works/);
    });

    check('14. sin overflow horizontal en 320, 390 y 430', async () => {
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
        await at(page, base, NEW_ID);
        const r = await page.evaluate(() => ({
          over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          fig: Math.round(document.querySelector('.social-proof-figure').getBoundingClientRect().width)
        }));
        assert.equal(r.over, 0, `overflow de ${r.over}px a ${width}px`);
      }
    });

    check('15. la pantalla anterior sigue funcionando y en su posicion', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const pos = await page.evaluate(() => {
        const l = stepList();
        const i = l.findIndex((s) => s.id === 'good_hands');
        return { count: l.filter((s) => s.id === 'good_hands').length, prevKey: l[i - 1].key, prev: l[i - 1].id };
      });
      assert.equal(pos.count, 1);
      assert.equal(pos.prevKey, 'nq10_phone');
      await at(page, base, 'good_hands');
      const r = await page.evaluate(() => ({
        t: (document.querySelector('.step h1') || {}).textContent,
        outer: document.querySelectorAll('.good-hands-avatar:not(.good-hands-avatar--center)').length,
        orbits: document.querySelectorAll('.good-hands-orbit').length
      }));
      assert.equal(r.t, 'You’re in good hands.');
      assert.equal(r.outer, 8);
      assert.equal(r.orbits, 3);
      await page.evaluate(() => document.getElementById('funnelBackBtn').click());
      await page.waitForTimeout(450);
      assert.match(await headline(page), /on your phone too much/);
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