// Regresion de las pantallas educativas mini pasos + progreso gamificado.
// Run: npm run test:science-screens
//   SCIENCE_HEADFUL=1  muestra el navegador

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MINI = 'mini_steps_science';
const GAM = 'gamified_progress_science';
const SELF = 'nq25';
const SELF_KEY = 'nq25_discipline';

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
const back = async (page) => { await page.evaluate(() => document.getElementById('funnelBackBtn').click()); await page.waitForTimeout(420); };
const forward = async (page) => { await page.evaluate(() => document.getElementById('nextBtn').click()); await page.waitForTimeout(420); };

async function main() {
  const checks = [];
  const check = (name, fn) => checks.push([name, fn]);
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: !process.env.SCIENCE_HEADFUL });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  try {
    check('1. ambas pantallas aparecen justo antes de self-discipline', async () => {
      await at(page, base, MINI);
      const r = await page.evaluate((selfKey) => {
        const l = stepList();
        const i = l.findIndex((s) => s.key === selfKey);
        return {
          mini: l.filter((s) => s.id === 'mini_steps_science').length,
          gam: l.filter((s) => s.id === 'gamified_progress_science').length,
          before: [l[i - 2].id, l[i - 1].id],
          at: l[i].id
        };
      }, SELF_KEY);
      assert.equal(r.mini, 1);
      assert.equal(r.gam, 1);
      assert.deepEqual(r.before, [MINI, GAM]);
      assert.equal(r.at, SELF);
    });

    check('2. orden mini pasos -> gamificacion -> self-discipline', async () => {
      await at(page, base, MINI);
      assert.match(await headline(page), /Big tasks feel easier/);
      await forward(page);
      assert.match(await headline(page), /Unlock progress/);
      await forward(page);
      assert.match(await headline(page), /connection to self-discipline/);
    });

    check('3. back y continue funcionan en ambas direcciones', async () => {
      await at(page, base, SELF);
      await back(page);
      assert.match(await headline(page), /Unlock progress/);
      await back(page);
      assert.match(await headline(page), /Big tasks feel easier/);
      await back(page);
      assert.match(await headline(page), /expert recommend/, 'mini pasos debe volver al paso original anterior');
      // Ida y vuelta limpia desde la Pantalla 1 (3 Continue).
      await at(page, base, MINI);
      await forward(page);
      assert.match(await headline(page), /Unlock progress/);
      await forward(page);
      assert.match(await headline(page), /connection to self-discipline/);
      // Volver a avanzar desde self-discipline no debe saltarse una pantalla.
      await back(page);
      assert.match(await headline(page), /Unlock progress/);
      await forward(page);
      assert.match(await headline(page), /connection to self-discipline/);
    });

    check('4. ambas pertenecen a Creando tu Perfil', async () => {
      for (const id of [MINI, GAM]) {
        await at(page, base, id);
        const stages = await page.evaluate(() => [...document.querySelectorAll('.funnel-stage')]
          .map((n) => [n.dataset.stage, n.dataset.state]));
        assert.deepEqual(stages, [['profile', 'active'], ['plan', 'idle']], `etapa incorrecta en ${id}`);
      }
    });

    check('5. no crean respuestas', async () => {
      for (const id of [MINI, GAM]) {
        await at(page, base, id);
        const diff = await page.evaluate(async () => {
          const before = JSON.parse(localStorage.getItem('brainy_funnel_state'));
          document.getElementById('nextBtn').click();
          await new Promise((r) => setTimeout(r, 500));
          const after = JSON.parse(localStorage.getItem('brainy_funnel_state'));
          const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
          return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
        });
        assert.deepEqual(diff, [], `${id} escribio: ${diff.join(', ')}`);
      }
    });

    check('6. no modifican el payload', async () => {
      for (const id of [MINI, GAM]) {
        await at(page, base, id);
        const calls = await page.evaluate(async () => {
          const seen = [];
          const real = window.fetch;
          window.fetch = (...a) => { seen.push(String(a[0])); return real(...a); };
          document.getElementById('nextBtn').click();
          await new Promise((r) => setTimeout(r, 500));
          window.fetch = real;
          return seen;
        });
        assert.deepEqual(calls, [], `${id} disparo red: ${calls.join(', ')}`);
      }
    });

    check('7. no cambian preguntas, alternativas, IDs ni values', async () => {
      await at(page, base, SELF);
      const q = await page.evaluate(() => {
        const step = stepList().find((s) => s.id === 'nq25');
        return {
          key: step.key,
          index: step.questionIndex,
          multi: !!step.multi,
          headline: step.headline,
          options: step.options.map((o) => `${o.value}|${o.label}`),
          rendered: [...document.querySelectorAll('.opt .opt-label')].map((n) => n.textContent.trim())
        };
      });
      assert.equal(q.key, SELF_KEY);
      assert.equal(q.index, 25);
      assert.equal(q.multi, false);
      assert.equal(q.headline, 'How would you describe your connection to self-discipline?');
      assert.deepEqual(q.options, [
        'I have none|I have none',
        'It comes in phases|It comes in phases',
        'I’m usually pretty structured|I’m usually pretty structured'
      ]);
      assert.deepEqual(q.rendered, q.options.map((o) => o.split('|')[1]));
    });

    check('8. la Pantalla 1 tiene exactamente tres tarjetas', async () => {
      await at(page, base, MINI);
      const r = await page.evaluate(() => ({
        n: document.querySelectorAll('.mini-step-card').length,
        cls: [...document.querySelectorAll('.mini-step-card')].map((c) => c.className),
        glyphs: document.querySelectorAll('.mini-step-card-glyph').length
      }));
      assert.equal(r.n, 3);
      assert.equal(r.glyphs, 3);
      for (const id of ['break-down', 'next-move', 'momentum']) {
        assert.ok(r.cls.some((c) => c.includes(`mini-step-card--${id}`)), `falta mini-step-card--${id}`);
      }
    });

    check('9. la Pantalla 2 tiene exactamente tres etiquetas', async () => {
      await at(page, base, GAM);
      const r = await page.evaluate(() => ({
        n: document.querySelectorAll('.gamification-label').length,
        texts: [...document.querySelectorAll('.gamification-label')].map((l) => l.textContent.trim()),
        core: document.querySelectorAll('.gamification-core-placeholder').length
      }));
      assert.equal(r.n, 3);
      assert.equal(r.core, 1);
      assert.deepEqual(r.texts, ['Clear next step', 'Visible progress', 'Small reward']);
    });

    check('10. no aparecen universidades', async () => {
      const html = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
      await at(page, base, MINI);
      const text = await page.evaluate(() => document.getElementById('funnelRoot').textContent);
      for (const uni of ['Harvard', 'Stanford', 'Duke', 'Oxford', 'MIT', 'Yale', 'university', 'universidad']) {
        assert.equal(text.includes(uni), false, `aparece ${uni} en pantalla`);
      }
      // Las pantallas nuevas no deben introducir ninguna.
      const mine = /id: 'mini_steps_science'[\s\S]*?id: 'nq25'/.exec(html)[0];
      for (const uni of ['Harvard', 'Stanford', 'Duke', 'university', 'universidad']) {
        assert.equal(mine.includes(uni), false, `el copy nuevo menciona ${uni}`);
      }
    });

    check('11. no aparecen nombres de expertos', async () => {
      await at(page, base, GAM);
      const text = await page.evaluate(() => document.getElementById('funnelRoot').textContent);
      assert.equal(/PhD|Ph\.D|MD\b|Dr\.|doctor|therapist|coach|expert/i.test(text), false, 'no debe haber experto');
      const note = await page.evaluate(() => document.querySelector('.explain-note').textContent);
      assert.match(note, /Evidence-informed, pressure-free/);
      assert.match(note, /Designed to reinforce action—not perfection\./);
    });

    check('12. sin afirmaciones cientificas absolutas', async () => {
      const html = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
      const mine = /id: 'mini_steps_science'[\s\S]*?id: 'nq25'/.exec(html)[0];
      for (const claim of ['scientifically proven', 'guaranteed', 'cures', 'cure ', 'eliminates ADHD',
        'removes symptoms', 'clinically proven', '100%', 'will work', 'certified', 'accredited']) {
        assert.equal(mine.toLowerCase().includes(claim.toLowerCase()), false, `afirmacion absoluta: ${claim}`);
      }
      await at(page, base, MINI);
      const text = (await page.evaluate(() => document.getElementById('funnelRoot').textContent)).toLowerCase();
      assert.equal(/cures|cure adhd|eliminates adhd|guaranteed|scientifically proven/.test(text), false);
      // El copy debe usar lenguaje Sugerente, no asertivo.
      assert.ok(text.includes('research suggests'), 'debe attributable la evidencia');
    });

    check('13. sin imagenes ni fuentes externas nuevas', async () => {
      const html = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
      assert.equal(/mini-step-card[^}]*(https?:|base64)/.test(html), false);
      assert.equal(/gamification-(diagram|label|core)[^}]*(https?:|base64)/.test(html), false);
      await at(page, base, GAM);
      // El nucleo ahora lleva una imagen LOCAL (assets/brainymap.png). Lo que
      // no se permite es una fuente remota ni base64.
      const r = await page.evaluate(() => {
        const base = location.origin;
        const imgs = [...document.querySelectorAll('.gamification-diagram img, .gamification-diagram svg')];
        return {
          remotes: [...document.querySelectorAll('img')].map((i) => i.src)
            .filter((s) => !s.startsWith(base) || /^data:/.test(s)),
          deco: imgs.length,
          todasLocales: imgs.every((i) => (i.getAttribute('src') || '').startsWith('assets/')),
          cargadas: imgs.every((i) => i.tagName !== 'IMG' || i.naturalWidth > 0)
        };
      });
      assert.deepEqual(r.remotes, []);
      assert.deepEqual(r.deco, 1, 'el nucleo debe tener exactamente una imagen');
      assert.equal(r.todasLocales, true, 'la imagen debe ser local');
      assert.equal(r.cargadas, true, 'la imagen debe cargar');
    });

    check('13b. los glifos tienen emoji y la imagen no se deforma', async () => {
      await at(page, base, MINI);
      const mini = await page.evaluate(() => [...document.querySelectorAll('.mini-step-card-glyph')]
        .map((n) => n.textContent.trim()));
      assert.equal(mini.length, 3);
      mini.forEach((g, i) => assert.ok(g && g.length > 0, `glifo ${i + 1} sin emoji`));
      assert.equal(new Set(mini).size, 3, 'los emojis deben ser distintos');

      await at(page, base, GAM);
      const gam = await page.evaluate(() => {
        const img = document.querySelector('.gamification-core-image');
        const core = document.querySelector('.gamification-core-placeholder');
        const ir = img.getBoundingClientRect();
        const cr = core.getBoundingClientRect();
        return {
          nota: document.querySelector('.explain-note-glyph').textContent.trim(),
          notaDistinta: document.querySelector('.explain-note-glyph').textContent.trim().length > 0,
          ratio: ir.width / ir.height,
          natural: img.naturalWidth / img.naturalHeight,
          // La imagen debe sobresalir del circulo, no quedar dentro.
          sobresale: ir.width > cr.width && ir.top < cr.top
        };
      });
      assert.ok(gam.notaDistinta, 'el circulo de la nota necesita un emoji');
      assert.ok(Math.abs(gam.ratio - gam.natural) < 0.02, 'la imagen del nucleo esta deformada');
      assert.equal(gam.sobresale, true, 'la imagen debe sobresalir sobre el circulo');
    });

    check('14. sin overflow horizontal en mobile', async () => {
      for (const width of [320, 390, 430]) {
        for (const id of [MINI, GAM]) {
          await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
          await at(page, base, id);
          const r = await page.evaluate(() => {
            const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
            const btn = document.getElementById('nextBtn').getBoundingClientRect();
            const labelsOut = [...document.querySelectorAll('.gamification-label')]
              .filter((e) => {
                const r = e.getBoundingClientRect();
                return r.left < 0 || r.right > document.documentElement.clientWidth;
              }).length;
            return { over, labelsOut, btnOk: btn.width > 0 && btn.left >= 0 && btn.right <= document.documentElement.clientWidth };
          });
          assert.equal(r.over, 0, `${id} overflow de ${r.over}px a ${width}px`);
          assert.equal(r.labelsOut, 0, `${id}: etiqueta fuera del viewport a ${width}px`);
          assert.equal(r.btnOk, true, `${id}: boton fuera del viewport a ${width}px`);
        }
      }
    });

    check('15. las pantallas informativas anteriores conservan posicion y funcionamiento', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const pos = await page.evaluate(() => {
        const l = stepList();
        const at_ = (id) => l.findIndex((s) => s.id === id);
        return {
          gh: l.filter((s) => s.id === 'good_hands').length,
          na: l.filter((s) => s.id === 'not_alone').length,
          ghPrev: l[at_('good_hands') - 1].key,
          naPrev: l[at_('not_alone') - 1].key,
          ghNext: l[at_('good_hands') + 1].id,
          naNext: l[at_('not_alone') + 1].id
        };
      });
      assert.deepEqual(pos, { gh: 1, na: 1, ghPrev: 'nq10_phone', naPrev: 'nq15_struggle', ghNext: 'nq11', naNext: 'interstitial_2' });
      await at(page, base, 'good_hands');
      assert.equal(await headline(page), 'You’re in good hands.');
      assert.equal(await page.evaluate(() => document.querySelectorAll('.good-hands-avatar:not(.good-hands-avatar--center)').length), 8);
      await at(page, base, 'not_alone');
      assert.equal(await headline(page), 'You’re not alone.');
      assert.equal(await page.evaluate(() => document.querySelectorAll('.social-proof-avatar:not(.social-proof-avatar--center)').length), 9);
    });

    check('16. self-discipline conserva copy, alternativas, key y comportamiento', async () => {
      await at(page, base, SELF);
      // Seleccion simple: al elegir, se marca y habilita el CTA.
      await page.evaluate(() => document.querySelector('.opt').click());
      await page.waitForTimeout(200);
      const sel = await page.evaluate(() => ({
        selected: document.querySelectorAll('.opt.selected').length,
        pressed: document.querySelector('.opt').getAttribute('aria-pressed'),
        nextEnabled: !document.getElementById('nextBtn').disabled,
        stored: JSON.parse(localStorage.getItem('brainy_funnel_state')).nq25_discipline
      }));
      assert.equal(sel.selected, 1);
      assert.equal(sel.pressed, 'true');
      assert.equal(sel.nextEnabled, true);
      assert.equal(sel.stored, 'I have none');
      // Y avanza a la pregunta original siguiente.
      await forward(page);
      assert.equal(await page.evaluate(() => stepList()[stepList().findIndex((s) => s.id === 'p4') - 1].id), SELF);
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