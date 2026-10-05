// Regresion de la pantalla final de perfil "Your Focus Profile".
// Un solo paso con tres variantes de contenido elegidas al azar una vez.
// Run: npm run test:profile-diagnosis
//   PROFILE_DIAGNOSIS_HEADFUL=1  muestra el navegador

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const STEP = 'profile_diagnosis';
const IDS = ['task_initiation', 'analysis_paralysis', 'follow_through'];

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

// Navega sembrando el estado. variant = id a forzar, o null para que sortee.
const at = async (page, base, { variant = null, step = STEP, extra = {} } = {}) => {
  await page.goto(`${base}/funnel.html`);
  await page.evaluate(({ sd, i, x }) => {
    localStorage.setItem('brainy_funnel_state', JSON.stringify(Object.assign({ locale: 'en' }, x,
      sd === null ? {} : { profileDiagnosisVariant: sd })));
    localStorage.setItem('brainy_funnel_step', String(i));
  }, { sd: variant, i: await page.evaluate((w) => stepList().findIndex((s) => s.id === w), step), x: extra });
  await page.goto(`${base}/funnel.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(450);
};

async function main() {
  const checks = [];
  const check = (name, fn) => checks.push([name, fn]);
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: !process.env.PROFILE_DIAGNOSIS_HEADFUL });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  try {
    check('1. existe un solo paso profile_diagnosis', async () => {
      await at(page, base);
      const r = await page.evaluate(() => {
        const l = stepList();
        return { n: l.filter((s) => s.id === 'profile_diagnosis').length, total: l.length };
      });
      assert.equal(r.n, 1, 'debe existir exactamente un paso de diagnostico');
    });

    check('2. es el ultimo paso de Creando tu Perfil', async () => {
      const r = await page.evaluate(() => {
        const l = stepList();
        // Por etapa, no por tipo: plan_personalization_loading es interstitial
        // pero abre la etapa 2.
        let last = -1;
        l.forEach((s, i) => { if (stageIndexOfStep(s) === 0) last = i; });
        return { last: l[last].id, diagStage: stageIndexOfStep(l.find((s) => s.id === 'profile_diagnosis')) };
      });
      assert.equal(r.last, STEP, 'el diagnostico debe ser el ultimo de la etapa 1');
      assert.equal(r.diagStage, 0, 'debe seguir contando como paso de Creando tu Perfil');
    });

    check('3. el siguiente paso es el primero de Disenando tu Plan', async () => {
      const r = await page.evaluate(() => {
        const l = stepList();
        const i = l.findIndex((s) => s.id === 'profile_diagnosis');
        return { next: l[i + 1].id, prev: l[i - 1].id, nextStage: stageIndexOfStep(l[i + 1]) };
      });
      assert.equal(r.next, 'plan_personalization_loading', 'la etapa 2 arranca con la pantalla de generacion');
      assert.equal(r.nextStage, 1);
      assert.equal(r.prev, 'nq28', 'debe venir tras la ultima pregunta de perfil');
    });

    check('4. existen exactamente tres variantes', async () => {
      const r = await page.evaluate(() => PROFILE_DIAGNOSIS_IDS.slice());
      assert.deepEqual(r, IDS);
    });

    check('5. las tres muestran HIGH level', async () => {
      for (const v of IDS) {
        await at(page, base, { variant: v });
        const t = await page.evaluate(() => ({
          badge: document.querySelector('.diagnosis-badge').textContent.trim(),
          title: document.querySelector('.diagnosis-alert-title').textContent.trim()
        }));
        assert.equal(t.badge, 'HIGH', `badge incorrecto en ${v}`);
        assert.equal(t.title, 'HIGH level', `titulo incorrecto en ${v}`);
      }
    });

    check('6. las tres contienen textos diferentes', async () => {
      const seen = { headline: new Set(), main: new Set(), moment: new Set(), trigger: new Set(), visual: new Set() };
      for (const v of IDS) {
        await at(page, base, { variant: v });
        const t = await page.evaluate(() => ({
          headline: document.querySelector('.diagnosis-alert-copy').textContent.trim(),
          main: document.querySelectorAll('.diagnosis-detail p')[0].textContent.trim(),
          moment: document.querySelectorAll('.diagnosis-detail p')[1].textContent.trim(),
          trigger: document.querySelectorAll('.diagnosis-detail p')[2].textContent.trim(),
          visual: document.querySelector('.diagnosis-visual').className
        }));
        for (const k of Object.keys(seen)) seen[k].add(t[k]);
      }
      for (const k of Object.keys(seen)) assert.equal(seen[k].size, 3, `${k} no difiere entre variantes`);
    });

    check('7. los tres intervalos eligen la variante correcta', async () => {
      const r = await page.evaluate(() => {
        const pick = (v) => selectProfileDiagnosisVariant(v);
        return {
          low: [0, 0.1, 0.32, 0.333].map(pick),
          mid: [0.34, 0.5, 0.66, 0.666].map(pick),
          high: [0.667, 0.8, 0.99].map(pick)
        };
      });
      assert.deepEqual([...new Set(r.low)], ['task_initiation']);
      assert.deepEqual([...new Set(r.mid)], ['analysis_paralysis']);
      assert.deepEqual([...new Set(r.high)], ['follow_through']);
    });

    check('8. la seleccion es uniforme por contrato de intervalos', async () => {
      // Barrido denso: cada intervalo debe cubrir 1/3 del rango.
      const r = await page.evaluate(() => {
        const counts = {};
        const steps = 30000;
        for (let i = 0; i < steps; i += 1) {
          const id = selectProfileDiagnosisVariant(i / steps);
          counts[id] = (counts[id] || 0) + 1;
        }
        return { counts, steps };
      });
      for (const id of IDS) {
        const share = r.counts[id] / r.steps;
        assert.ok(Math.abs(share - 1 / 3) < 0.01, `${id} obtuvo ${share.toFixed(3)} (esperado 0.333)`);
      }
    });

    check('9. la variante permanece al volver atras', async () => {
      await at(page, base, { variant: 'analysis_paralysis' });
      await page.evaluate(() => document.getElementById('nextBtn').click());
      await page.waitForTimeout(420);
      await page.evaluate(() => document.getElementById('funnelBackBtn').click());
      await page.waitForTimeout(420);
      const v = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).profileDiagnosisVariant);
      assert.equal(v, 'analysis_paralysis');
    });

    check('10. la variante permanece al recargar y al restaurar localStorage', async () => {
      await at(page, base, { variant: 'follow_through' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      const afterReload = await page.evaluate(() => ({
        v: JSON.parse(localStorage.getItem('brainy_funnel_state')).profileDiagnosisVariant,
        main: document.querySelector('.diagnosis-detail p').textContent.trim()
      }));
      assert.equal(afterReload.v, 'follow_through');
      assert.equal(afterReload.main, 'Following through');
      // Cerrar "la pestana": nueva pagina del mismo contexto = mismo storage.
      const page2 = await ctx.newPage();
      await page2.goto(`${base}/funnel.html`, { waitUntil: 'networkidle' });
      await page2.waitForTimeout(400);
      const v2 = await page2.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).profileDiagnosisVariant);
      assert.equal(v2, 'follow_through', 'la variante debe sobrevivir a restaurar el funnel');
      await page2.close();
    });

    check('11. reset elimina la seleccion anterior', async () => {
      await at(page, base, { variant: 'analysis_paralysis', step: 'begin', extra: { nq01_gender: 'Female' } });
      const before = await page.evaluate(() => ({
        hasBtn: !!document.querySelector('[data-action="reset"]'),
        v: JSON.parse(localStorage.getItem('brainy_funnel_state')).profileDiagnosisVariant
      }));
      assert.equal(before.hasBtn, true, 'el boton reset solo aparece con progreso');
      assert.equal(before.v, 'analysis_paralysis');
      await page.evaluate(() => document.querySelector('[data-action="reset"]').click());
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).profileDiagnosisVariant);
      assert.equal(after, null, 'reset debe limpiar la variante');
    });

    check('12. un valor almacenado invalido se recupera', async () => {
      for (const bad of ['basura', 42, '', 'TASK_INITIATION']) {
        await at(page, base, { variant: bad });
        const r = await page.evaluate(() => ({
          v: JSON.parse(localStorage.getItem('brainy_funnel_state')).profileDiagnosisVariant,
          rendered: document.querySelector('.diagnosis-visual').className
        }));
        assert.ok(IDS.includes(r.v), `valor invalido ${bad} no se recupero (quedo ${r.v})`);
        assert.ok(r.rendered.includes('diagnosis-visual--'), 'debe renderizar una variante valida');
      }
    });

    check('13. solamente se renderiza una variante', async () => {
      await at(page, base);
      const r = await page.evaluate(() => ({
        visuals: document.querySelectorAll('.diagnosis-visual').length,
        cores: document.querySelectorAll('.diagnosis-visual > *').length > 0,
        blocks: document.querySelectorAll('[class*="diagnosis-block"], [class*="diagnosis-node"], [class*="diagnosis-stage"]').length
      }));
      assert.equal(r.visuals, 1, 'solo un placeholder central');
      assert.equal(r.cores, true);
      assert.ok(r.blocks > 0);
      // El texto corresponde a una unica variante.
      const mains = await page.evaluate(() => document.querySelectorAll('.diagnosis-detail p').length);
      assert.equal(mains, 3, 'tres tarjetas secundarias, no tres variantes');
    });

    check('14. no se guarda en answers', async () => {
      await at(page, base, { variant: 'follow_through' });
      const r = await page.evaluate(() => {
        const st = JSON.parse(localStorage.getItem('brainy_funnel_state'));
        return { top: Object.prototype.hasOwnProperty.call(st, 'profileDiagnosisVariant'),
                 inAnswers: Object.keys(st).some((k) => /answers/i.test(k)),
                 keys: Object.keys(st).filter((k) => !k.startsWith('nq') && !k.startsWith('q4') && !k.startsWith('p26')) };
      });
      assert.equal(r.top, true, 'la variante vive en el estado del funnel');
      assert.equal(r.inAnswers, false, 'no debe vivir dentro de answers');
      assert.ok(!r.keys.includes('answers'));
    });

    check('15. no aparece en el payload del backend', async () => {
      const html = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
      const answersBlock = /answers: \{[\s\S]*?\n                \},/.exec(html);
      assert.ok(answersBlock, 'no se encontro el bloque answers del payload');
      assert.equal(answersBlock[0].includes('profileDiagnosisVariant'), false,
        'la variante no debe enviarse en el payload');
      assert.equal(/metadata[^{]*\{[^}]*profileDiagnosisVariant/.test(html), false,
        'la variante tampoco debe ir en metadata');
      assert.equal(/track\([^)]*profileDiagnosisVariant/.test(html), false,
        'la variante no debe registrarse en analytics');
      // Tampoco aparece en el body del POST.
      const body = /body: JSON\.stringify\(\{[\s\S]*?\n                        \}\)/.exec(html);
      assert.ok(body);
      assert.equal(body[0].includes('profileDiagnosisVariant'), false);
    });

    check('16. Continue entra a Disenando tu Plan', async () => {
      for (const v of IDS) {
        await at(page, base, { variant: v });
        await page.evaluate(() => document.getElementById('nextBtn').click());
        await page.waitForTimeout(420);
        const r = await page.evaluate(() => ({
          h: (document.querySelector('.step h1') || {}).textContent,
          stage: [...document.querySelectorAll('.funnel-stage')].map((n) => n.dataset.state)
        }));
        assert.match(r.h, /personalized plan/, `Continue no entro a la etapa 2 desde ${v}`);
        assert.deepEqual(r.stage, ['done', 'active']);
      }
    });

    check('17. Back desde la etapa 2 vuelve al diagnostico con la misma variante', async () => {
      for (const v of IDS) {
        await at(page, base, { variant: v });
        await page.evaluate(() => document.getElementById('nextBtn').click());
        await page.waitForTimeout(420);
        await page.evaluate(() => document.getElementById('funnelBackBtn').click());
        await page.waitForTimeout(420);
        const r = await page.evaluate(() => ({
          h: (document.querySelector('.step h1') || {}).textContent,
          v: JSON.parse(localStorage.getItem('brainy_funnel_state')).profileDiagnosisVariant,
          main: document.querySelector('.diagnosis-detail p').textContent.trim()
        }));
        assert.equal(r.h, 'Your Focus Profile');
        assert.equal(r.v, v, 'la variante debe ser la misma al volver');
        assert.ok(r.main.length > 0);
      }
    });

    check('18. las tres variantes conservan intacto el copy de preguntas', async () => {
      const before = await page.evaluate(() => {
        const l = stepList();
        const i = l.findIndex((s) => s.id === 'profile_diagnosis');
        return l.slice(0, i).map((s) => ({ id: s.id, key: s.key, q: s.questionIndex,
          h: s.headline, o: (s.options || []).map((o) => `${o.value}|${o.label}`) }));
      });
      for (const v of IDS) {
        await at(page, base, { variant: v });
        const after = await page.evaluate(() => {
          const l = stepList();
          const i = l.findIndex((s) => s.id === 'profile_diagnosis');
          return l.slice(0, i).map((s) => ({ id: s.id, key: s.key, q: s.questionIndex,
            h: s.headline, o: (s.options || []).map((o) => `${o.value}|${o.label}`) }));
        });
        assert.deepEqual(after, before, `la variante ${v} altero el copy previo`);
      }
    });

    check('19. sin afirmaciones medicas', async () => {
      for (const v of IDS) {
        await at(page, base, { variant: v });
        const text = (await page.evaluate(() => document.getElementById('funnelRoot').textContent)).toLowerCase();
        for (const bad of ['adhd', 'tda h', 'disorder', 'diagnostic of', 'you have', 'clinical',
          'severe', 'medium level', 'low level', 'mild', 'cure', 'treat', 'patient',
          'scientifically proven', 'guaranteed', 'score of', 'percent']) {
          assert.equal(text.includes(bad), false, `afirmacion prohibida "${bad}" en ${v}`);
        }
        // El badge de nivel alto es el unico allowed, y es texto.
        assert.ok(text.includes('high level'));
      }
      // El aviso obligatorio esta presente.
      await at(page, base);
      const note = await page.evaluate(() => document.querySelector('.diagnosis-note').textContent);
      assert.equal(note, 'This profile reflects your quiz experience and is not a medical diagnosis.');
    });

    check('20. no existen imagenes remotas', async () => {
      const html = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
      assert.equal(/diagnosis-visual[^}]*(https?:|base64)/.test(html), false);
      await at(page, base);
      const r = await page.evaluate(() => {
        const base = location.origin;
        const imgs = [...document.querySelectorAll('.diagnosis-visual img, .diagnosis-visual svg')];
        return {
        remotes: [...document.querySelectorAll('img')].map((i) => i.src)
          .filter((s) => !s.startsWith(base) || /^data:/.test(s)),
        // La ilustracion del paciente es una imagen LOCAL; lo que no se
        // permite es una fuente remota ni base64.
        deco: imgs.length,
        todasLocales: imgs.every((i) => (i.getAttribute('src') || '').startsWith('assets/')),
        cargadas: imgs.every((i) => i.tagName !== 'IMG' || i.naturalWidth > 0),
        aria: document.querySelector('.diagnosis-visual').getAttribute('aria-hidden'),
        focusable: document.querySelectorAll('.diagnosis-visual a, .diagnosis-visual button, .diagnosis-visual [tabindex]').length,
        meterTag: document.querySelector('.diagnosis-meter').tagName,
        meterAria: document.querySelector('.diagnosis-meter').getAttribute('aria-label'),
        h1: (document.querySelector('#funnelRoot h1') || {}).textContent || ''
      };
      });
      assert.deepEqual(r.remotes, []);
      assert.equal(r.deco, 1, 'debe haber exactamente la imagen del paciente');
      assert.equal(r.todasLocales, true);
      assert.equal(r.cargadas, true);
      assert.equal(r.aria, 'true');
      assert.equal(r.focusable, 0);
      assert.equal(r.meterTag, 'DIV', 'la barra no debe ser input');
      assert.ok(r.meterAria && r.meterAria.length > 0, 'la barra necesita aria-label');
      assert.ok(r.h1.length > 0, 'la pantalla debe tener un h1');
      // El indicador cae en el rango alto en las tres variantes.
      for (const v of IDS) {
        await at(page, base, { variant: v });
        const pct = await page.evaluate(() => {
          const d = document.querySelector('.diagnosis-meter-dot').getBoundingClientRect();
          const t = document.querySelector('.diagnosis-meter-track').getBoundingClientRect();
          return Math.round(((d.left + d.width / 2) - t.left) / t.width * 100);
        });
        assert.ok(pct >= 78 && pct <= 85, `indicador en ${pct}% (esperado 78-85) para ${v}`);
        const numeric = await page.evaluate(() => document.querySelector('.diagnosis-meter').textContent);
        assert.equal(numeric.trim(), '', 'no debe mostrarse porcentaje numerico');
      }
    });

    check('21. sin overflow horizontal en 320, 390 y 430', async () => {
      for (const width of [320, 390, 430]) {
        for (const v of IDS) {
          await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
          await at(page, base, { variant: v });
          const r = await page.evaluate(() => {
            const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
            const btn = document.getElementById('nextBtn').getBoundingClientRect();
            return { over, btnOk: btn.left >= 0 && btn.right <= document.documentElement.clientWidth,
              note: document.querySelector('.diagnosis-note').getBoundingClientRect().width > 0 };
          });
          assert.equal(r.over, 0, `overflow de ${r.over}px (${v} @ ${width})`);
          assert.equal(r.btnOk, true, `boton fuera del viewport (${v} @ ${width})`);
          assert.equal(r.note, true);
        }
      }
    });

    check('22. las pantallas informativas anteriores siguen presentes y ordenadas', async () => {
      const r = await page.evaluate(() => {
        const l = stepList();
        const i = (id) => l.findIndex((s) => s.id === id);
        return {
          gh: l.filter((s) => s.id === 'good_hands').length,
          na: l.filter((s) => s.id === 'not_alone').length,
          ms: l.filter((s) => s.id === 'mini_steps_science').length,
          gp: l.filter((s) => s.id === 'gamified_progress_science').length,
          ghPrev: l[i('good_hands') - 1].key,
          naPrev: l[i('not_alone') - 1].key,
          msNext: l[i('mini_steps_science') + 1].id,
          gpNext: l[i('gamified_progress_science') + 1].id
        };
      });
      assert.deepEqual(r, {
        gh: 1, na: 1, ms: 1, gp: 1,
        ghPrev: 'nq10_phone', naPrev: 'nq15_struggle',
        msNext: 'gamified_progress_science', gpNext: 'nq25'
      });
    });

    check('23. el boton es accesible por teclado', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await at(page, base);
      await page.evaluate(() => document.getElementById('funnelBackBtn').focus());
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'nextBtn');
      const outline = await page.evaluate(() => {
        const btn = document.getElementById('nextBtn');
        btn.focus();
        return getComputedStyle(btn).outlineWidth;
      });
      assert.notEqual(outline, '0px', 'el boton debe tener focus-visible');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(420);
      assert.match(await page.evaluate(() => (document.querySelector('.step h1') || {}).textContent || ''), /personalized plan/);
    });

    check('24. un clic produce exactamente una transicion', async () => {
      for (const v of IDS) {
        await at(page, base, { variant: v });
        const before = await page.evaluate(() => stepList()[currentStepIndex].id);
        await page.evaluate(() => document.getElementById('nextBtn').click());
        await page.waitForTimeout(500);
        const after = await page.evaluate(() => ({
          id: stepList()[currentStepIndex].id,
          delta: currentStepIndex,
          rendered: document.querySelectorAll('.step').length
        }));
        assert.equal(before, STEP);
        assert.equal(after.id, 'plan_personalization_loading', 'un clic avanzo de mas o de menos');
        assert.equal(after.delta, (await page.evaluate((s) => stepList().findIndex((x) => x.id === s), STEP)) + 1,
          'el indice debe avanzar exactamente una posicion');
        assert.equal(after.rendered, 1, 'solo un paso renderizado, sin duplicados');
      }
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