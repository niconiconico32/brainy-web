// Regresion de la pantalla "sistema de huevos y mascotas" (interstitial_3).
// Frontend only: verifica contenido, accesibilidad y que la pantalla siga siendo
// informativa (no escribe estado, no llama al backend).
//
// Run: npm run test:interstitial-3
//   EGG_HEADFUL=1   muestra el navegador

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const STEP = 'interstitial_3';

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\//, '') || 'index.html';
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
    try {
      const type = file.endsWith('.html') ? 'text/html'
        : file.endsWith('.json') ? 'application/json'
          : file.endsWith('.png') ? 'image/png'
            : file.endsWith('.jpg') ? 'image/jpeg'
              : 'application/javascript';
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

  const html = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: !process.env.EGG_HEADFUL });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  const page = await ctx.newPage();

  const offsite = [];
  page.on('pageerror', () => {});
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(base) && !u.startsWith('data:')) offsite.push(`${r.method()} ${u}`);
  });

  const at = async (locale = 'en') => {
    await page.goto(`${base}/funnel.html`);
    await page.evaluate(() => localStorage.clear());
    await page.evaluate((l) => localStorage.setItem('brainy_funnel_state', JSON.stringify({ locale: l })), locale);
    await page.goto(`${base}/funnel.html`);
    await page.evaluate((w) => {
      localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === w)));
    }, STEP);
    await page.goto(`${base}/funnel.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(450);
  };

  const text = () => page.evaluate(() => document.getElementById('funnelRoot').innerText);
  const cur = () => page.evaluate(() => stepList()[currentStepIndex].id);

  let failed = 0;

  try {
    check('1. interstitial_3 sigue existiendo una sola vez', async () => {
      await at();
      const n = await page.evaluate(() => stepList().filter((s) => s.id === 'interstitial_3').length);
      assert.equal(n, 1);
    });

    check('2. mantiene la misma posicion (indice 28 de 48)', async () => {
      const r = await page.evaluate(() => {
        const l = stepList();
        return { i: l.findIndex((s) => s.id === 'interstitial_3'), total: l.length };
      });
      assert.deepEqual(r, { i: 28, total: 48 });
    });

    check('3. mantiene el mismo paso anterior y siguiente', async () => {
      const r = await page.evaluate(() => {
        const l = stepList();
        const i = l.findIndex((s) => s.id === 'interstitial_3');
        return { prev: l[i - 1].id, prevKey: l[i - 1].key, next: l[i + 1].id };
      });
      assert.deepEqual(r, { prev: 'nq22', prevKey: 'nq22_doing_for', next: 'nq23' });
    });

    check('4. mantiene la misma etapa (0 = Creando tu Perfil)', async () => {
      const stage = await page.evaluate(() => stageIndexOfStep(stepList()[currentStepIndex]));
      assert.equal(stage, 0);
      const stages = await page.evaluate(() => [...document.querySelectorAll('.funnel-stage')]
        .map((n) => [n.dataset.stage, n.dataset.state]));
      assert.deepEqual(stages, [['profile', 'active'], ['plan', 'idle']]);
    });

    check('5. el copy antiguo de interstitial_3 fue reemplazado', async () => {
      const t = await text();
      for (const old of [
        'Así se ve intentarlo solo',
        'Trying alone versus having a system',
        'No necesitás más disciplina',
        'You do not need more discipline',
        'curva sostenida',
        'Willpower alone'
      ]) {
        assert.equal(t.includes(old), false, `queda copy viejo: ${old}`);
      }
      assert.equal(/curves/.test(html.split('const FUNNEL_STEPS')[1] || ''), false);
    });

    check('6. aparece "Your consistency brings them to life"', async () => {
      assert.equal((await page.evaluate(() => document.querySelector('h1').textContent)).trim(),
        'Your consistency brings them to life');
      assert.ok((await text()).includes('Your consistency brings them to life'));
    });

    check('7. aparece "First evolution: 3 completed days"', async () => {
      assert.ok((await text()).includes('First evolution: 3 completed days'));
    });

    check('8. aparecen exactamente los tres pasos explicativos', async () => {
      const r = await page.evaluate(() => ({
        n: document.querySelectorAll('.egg-step').length,
        titles: [...document.querySelectorAll('.egg-step strong')].map((n) => n.textContent.trim()),
        texts: [...document.querySelectorAll('.egg-step p')].map((n) => n.textContent.trim())
      }));
      assert.equal(r.n, 3);
      assert.deepEqual(r.titles, [
        'Choose a manageable habit',
        'Complete its daily mini-step',
        'Watch your companion grow'
      ]);
      assert.deepEqual(r.texts, [
        'Start with one action small enough to complete today.',
        'Each completed action adds visible progress.',
        'After 3 completed days, its first evolution unlocks.'
      ]);
    });

    check('9. aparece la aclaracion de que el habito no queda formado en tres dias', async () => {
      const t = await text();
      assert.ok(t.includes('not the moment a habit is fully formed'), 'falta la aclaracion');
      assert.ok(t.includes('early milestone'), 'falta "early milestone"');
    });

    check('10. no aparece "scientifically proven"', async () => {
      assert.equal((await text()).toLowerCase().includes('scientifically proven'), false);
      assert.equal(/scientifically proven/i.test(html), false);
    });

    check('11. no aparece "habit formed in 3 days"', async () => {
      const t = (await text()).toLowerCase();
      assert.equal(t.includes('habit formed in 3 days'), false);
      assert.equal(t.includes('form a habit in 3 days'), false);
      assert.equal(t.includes('hábito queda formado en 3 días'), false);
    });

    check('12. la galeria usa una unica fuente de verdad', async () => {
      const r = await page.evaluate(() => ({
        defined: typeof BRAINY_EGG_SHOWCASE !== 'undefined' ? BRAINY_EGG_SHOWCASE.length : -1,
        derived: typeof BRAINY_EGG_SHOWCASE !== 'undefined'
          ? BRAINY_EGG_SHOWCASE.every((e, i) => e.src === EGGS.filter((g) => g.imageUrl)[i].imageUrl)
          : false
      }));
      assert.equal(r.defined, 8, 'el manifiesto debe existir y traer los 8 huevos');
      assert.equal(r.derived, true, 'el manifiesto debe derivarse de EGGS, no duplicar rutas');
    });

    check('13. todos los huevos reales encontrados aparecen una vez', async () => {
      const r = await page.evaluate(() => {
        const thumbs = [...document.querySelectorAll('.egg-thumb img')].map((i) => i.getAttribute('src'));
        return { thumbs, unique: new Set(thumbs).size, showcase: BRAINY_EGG_SHOWCASE.map((e) => e.src) };
      });
      assert.equal(r.thumbs.length, 8);
      assert.equal(r.unique, 8, 'no hay src repetidos');
      assert.deepEqual(r.thumbs, r.showcase, 'las miniaturas siguen el manifiesto en orden');
      // Los 8 archivos existen realmente en disco.
      const onDisk = fs.readdirSync(path.join(ROOT, 'assets/eggs'))
        .filter((f) => f.endsWith('.png'))
        .map((f) => `assets/eggs/${f}`)
        .sort();
      assert.deepEqual([...r.showcase].sort(), onDisk, 'el manifiesto debe cubrir los PNG reales');
    });

    check('14. no hay URLs de imagen externas', async () => {
      const r = await page.evaluate(() => ({
        remote: [...document.querySelectorAll('#funnelRoot img')]
          .map((i) => i.src).filter((s) => !s.startsWith(location.origin)),
        srcs: [...document.querySelectorAll('#funnelRoot img')].map((i) => i.getAttribute('src'))
      }));
      assert.deepEqual(r.remote, []);
      r.srcs.forEach((s) => assert.ok(s.startsWith('assets/'), `ruta no local: ${s}`));
      assert.equal(/src="https?:/.test(html), false);
    });

    check('15. no hay base64', async () => {
      assert.equal(/base64/i.test(html), false);
      const r = await page.evaluate(() => [...document.querySelectorAll('#funnelRoot img')]
        .filter((i) => i.src.startsWith('data:')).length);
      assert.equal(r, 0);
    });

    check('16. seleccionar una miniatura cambia el preview', async () => {
      await at();
      const before = await page.evaluate(() => document.getElementById('eggPreviewImg').getAttribute('src'));
      await page.click('[data-egg-index="4"]');
      await page.waitForTimeout(220);
      const after = await page.evaluate(() => ({
        src: document.getElementById('eggPreviewImg').getAttribute('src'),
        alt: document.getElementById('eggPreviewImg').getAttribute('alt')
      }));
      assert.notEqual(after.src, before, 'el preview debe cambiar');
      assert.equal(after.src, 'assets/eggs/eggfinal5.png');
      assert.ok(after.alt.includes('Leaf'), `alt no describe el huevo: ${after.alt}`);
    });

    check('17. solo una miniatura tiene aria-pressed="true"', async () => {
      await at();
      const count = async () => page.evaluate(() => document.querySelectorAll('.egg-thumb[aria-pressed="true"]').length);
      assert.equal(await count(), 1);
      await page.click('[data-egg-index="6"]');
      await page.waitForTimeout(220);
      assert.equal(await count(), 1);
      const which = await page.evaluate(() => [...document.querySelectorAll('.egg-thumb')]
        .findIndex((t) => t.getAttribute('aria-pressed') === 'true'));
      assert.equal(which, 6);
    });

    check('18. la seleccion funciona con teclado', async () => {
      await at();
      await page.focus('[data-egg-index="0"]');
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(160);
      assert.equal(await page.evaluate(() => document.getElementById('eggPreviewImg').getAttribute('src')),
        'assets/eggs/eggfinal2.png');
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(160);
      assert.equal(await page.evaluate(() => document.getElementById('eggPreviewImg').getAttribute('src')),
        'assets/eggs/eggfinal1.png');
      // Space y Enter activan el boton y no deben navegar.
      await page.focus('[data-egg-index="2"]');
      await page.keyboard.press('Space');
      await page.waitForTimeout(160);
      assert.equal(await cur(), STEP, 'Space no debe avanzar de paso');
      assert.equal(await page.evaluate(() => document.getElementById('eggPreviewImg').getAttribute('src')),
        'assets/eggs/eggfinal3.png');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(160);
      assert.equal(await cur(), STEP, 'Enter no debe avanzar de paso');
    });

    check('19. la seleccion no modifica answers', async () => {
      await at();
      const before = await page.evaluate(() => JSON.stringify(window.brainyFunnelState));
      await page.click('[data-egg-index="5"]');
      await page.waitForTimeout(200);
      await page.click('[data-egg-index="2"]');
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => JSON.stringify(window.brainyFunnelState));
      assert.equal(after, before, 'el estado no puede cambiar al previsualizar');
      assert.equal(await page.evaluate(() => (window.brainyFunnelState.assignedRoutines || []).length), 0,
        'no se asigna mascota');
    });

    check('20. la seleccion no modifica el payload', async () => {
      await at();
      // createdAt es un timestamp de reloj: se excluye para comparar el resto.
      const stable = () => page.evaluate(() => {
        const p = buildUserPlanPayload();
        delete p.metadata.createdAt;
        return JSON.stringify(p);
      });
      const before = await stable();
      await page.click('[data-egg-index="7"]');
      await page.waitForTimeout(220);
      assert.equal(await stable(), before, 'el payload no puede cambiar al previsualizar');
      const keys = await page.evaluate(() => Object.keys(buildUserPlanPayload()).sort());
      assert.equal(keys.includes('previewEgg'), false);
      assert.equal(keys.includes('selectedEgg'), false);
      assert.equal(keys.includes('companion'), false);
      assert.deepEqual(keys, ['answers', 'metadata', 'preview', 'routines', 'tasks', 'version']);
    });

    check('21. el CTA usa la navegacion original (goNext, un paso)', async () => {
      await at();
      assert.equal(await page.evaluate(() => document.getElementById('nextBtn').textContent.trim()),
        'Build my plan →');
      await page.click('#nextBtn');
      await page.waitForTimeout(400);
      assert.equal(await cur(), 'nq23');
    });

    check('22. Back usa la navegacion original (nq22)', async () => {
      await at();
      await page.click('#funnelBackBtn');
      await page.waitForTimeout(400);
      assert.equal(await cur(), 'nq22');
    });

    check('23. un doble clic en CTA no duplica la transicion', async () => {
      await at();
      const r = await page.evaluate(() => {
        const btn = document.getElementById('nextBtn');
        btn.click();
        btn.click();
        return stepList()[currentStepIndex].id;
      });
      assert.equal(r, 'nq23', 'dos clics no pueden avanzar dos pasos');
      await at();
      await page.dblclick('#nextBtn');
      await page.waitForTimeout(400);
      assert.equal(await cur(), 'nq23');
    });

    check('24. no hay llamadas HTTP nuevas', async () => {
      offsite.length = 0;
      await at();
      await page.click('[data-egg-index="3"]');
      await page.waitForTimeout(250);
      assert.deepEqual(offsite, [], `red externa: ${offsite.join(', ')}`);
    });

    check('25. no hay llamadas a Supabase', async () => {
      const r = await page.evaluate(async () => {
        const calls = [];
        const real = window.fetch;
        window.fetch = (...a) => { calls.push(String(a[0])); return real(...a); };
        document.getElementById('funnelBackBtn').click();
        await new Promise((res) => setTimeout(res, 400));
        window.fetch = real;
        return calls;
      });
      assert.deepEqual(r, [], `llamadas en la pantalla: ${r.join(', ')}`);
    });

    check('26. no hay llamadas a RevenueCat', async () => {
      const r = await page.evaluate(() => ({
        sdkTag: !!document.querySelector('script[src*="revenuecat-sdk"]'),
        purchase: !!document.querySelector('#purchaseBtn'),
        rcCalls: window.brainyRevenueCatCalls || 0
      }));
      assert.equal(r.purchase, false, 'no debe haber boton de compra en esta pantalla');
      assert.equal(r.rcCalls, 0);
      const rcSrc = /purchase\(|rcPurchase|RevenueCat\.purchase/.test(html);
      const inShowcase = rcSrc ? /renderEggShowcase[\s\S]{0,6000}?(purchase\(|rcPurchase)/.test(
        html.slice(html.indexOf('function renderEggShowcase'), html.indexOf('function renderInterstitial'))) : false;
      assert.equal(inShowcase, false, 'el renderer no debe comprar nada');
    });

    check('27. prefers-reduced-motion desactiva la flotacion', async () => {
      const p2 = await ctx.newPage();
      await p2.emulateMedia({ reducedMotion: 'reduce' });
      await p2.goto(`${base}/funnel.html`);
      await p2.evaluate(() => localStorage.setItem('brainy_funnel_state', JSON.stringify({ locale: 'en' })));
      await p2.goto(`${base}/funnel.html`);
      await p2.evaluate(() => {
        localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === 'interstitial_3')));
      });
      await p2.goto(`${base}/funnel.html`, { waitUntil: 'networkidle' });
      await p2.waitForTimeout(350);
      const r = await p2.evaluate(() => ({
        anim: getComputedStyle(document.getElementById('eggPreviewImg')).animationName
      }));
      assert.equal(r.anim, 'none', 'la flotacion debe desactivarse');
      await p2.close();
      // Sin reduced-motion debe estar presente.
      await at();
      const on = await page.evaluate(() => getComputedStyle(document.getElementById('eggPreviewImg')).animationName);
      assert.equal(on, 'eggFloat');
    });

    check('28. no hay overflow general en 320, 390 y 430 px', async () => {
      for (const w of [320, 390, 430]) {
        await page.setViewportSize({ width: w, height: 800 });
        await at();
        const r = await page.evaluate(() => ({
          over: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth
        }));
        assert.equal(r.over, false, `overflow horizontal en ${w}px (${r.sw} > ${r.cw})`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
    });

    check('29. el huevo principal no se recorta', async () => {
      for (const w of [320, 390, 1440]) {
        await page.setViewportSize({ width: w, height: 900 });
        await at();
        const r = await page.evaluate(() => {
          const img = document.getElementById('eggPreviewImg');
          const stage = document.querySelector('.egg-preview-stage');
          const i = img.getBoundingClientRect();
          const s = stage.getBoundingClientRect();
          return {
            inside: i.left >= s.left - 1 && i.right <= s.right + 1 && i.top >= s.top - 1 && i.bottom <= s.bottom + 1,
            ratio: i.width / i.height,
            natural: img.naturalWidth / img.naturalHeight,
            loaded: img.naturalWidth > 0
          };
        });
        assert.equal(r.loaded, true, `la imagen no cargo en ${w}px`);
        assert.equal(r.inside, true, `el huevo se recorta en ${w}px`);
        assert.ok(Math.abs(r.ratio - r.natural) < 0.02, `la imagen se deforma en ${w}px`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
    });

    check('30. las preguntas y demas interstitials permanecen sin cambios', async () => {
      const r = await page.evaluate(() => {
        const l = stepList();
        return { questions: l.filter((s) => s.type === 'question').length,
          interstitials: l.filter((s) => s.type === 'interstitial').length,
          counts: ['good_hands', 'not_alone', 'mini_steps_science', 'gamified_progress_science',
            'profile_diagnosis', 'plan_personalization_loading', 'interstitial_1', 'interstitial_2']
            .map((id) => [id, l.filter((s) => s.id === id).length]) };
      });
      assert.equal(r.questions, 29, 'deben seguir siendo 29 pasos de pregunta (nq01-nq28 + p4)');
      assert.equal(r.interstitials, 9, 'deben seguir siendo 9 intersticiales');
      assert.equal(await page.evaluate(() => stepList().length), 48, 'el total de pasos no cambia');
      r.counts.forEach(([id, n]) => assert.equal(n, 1, `${id} deberia aparecer una vez`));

      // Los otros intersticiales siguen renderizando su propio contenido.
      for (const [id, needle] of [
        ['good_hands', 'You’re in good hands.'],
        ['not_alone', 'You’re not alone.'],
        ['mini_steps_science', 'Big tasks feel easier'],
        ['gamified_progress_science', 'Unlock progress'],
        ['interstitial_2', 'This is how a brain with a system works']
      ]) {
        await page.goto(`${base}/funnel.html`);
        await page.evaluate(() => localStorage.setItem('brainy_funnel_state', JSON.stringify({ locale: 'en' })));
        await page.goto(`${base}/funnel.html`);
        await page.evaluate((w) => {
          localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === w)));
        }, id);
        await page.goto(`${base}/funnel.html`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(320);
        const t = await text();
        assert.ok(t.toLowerCase().includes(needle.toLowerCase()), `${id} cambio su contenido`);
      }
    });

    // Los checks corren aqui, con el navegador todavia abierto.
    for (const [name, fn] of checks) {
      try {
        await fn();
        console.log(`ok   - ${name}`);
      } catch (err) {
        failed++;
        console.log(`FAIL - ${name}`);
        console.log(`       ${err.message.split('\n').slice(0, 6).join('\n       ')}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${checks.length - failed}/${checks.length} checks ok`);
  process.exit(failed ? 1 : 0);
}

main();