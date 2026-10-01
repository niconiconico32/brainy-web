// Regresion de plan_personalization_loading con reloj falso determinista.
//
// Falsifica performance.now() y requestAnimationFrame() ANTES de que corra el
// script del funnel, de modo que las barras avanzan solo cuando el test lo
// decide. Sin sleeps reales.
//
// Run: npm run test:plan-loading
//   PLAN_LOADING_HEADFUL=1  muestra el navegador

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const STEP = 'plan_personalization_loading';
const BAR_MS = 3000;

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

// Reloj falso instalado antes de cualquier script de la pagina.
const FAKE_CLOCK = `
window.__fakeClock = { t: 0, frames: [], id: 0 };
Object.defineProperty(window.performance, 'now', { value: () => window.__fakeClock.t, configurable: true });
window.requestAnimationFrame = (cb) => { window.__fakeClock.frames.push(cb); window.__fakeClock.id += 1; return window.__fakeClock.id; };
window.cancelAnimationFrame = () => {};
window.__fakeClock.advance = (totalMs, chunk) => {
  const step = chunk || 50;
  let done = 0;
  while (done < totalMs) {
    const delta = Math.min(step, totalMs - done);
    window.__fakeClock.t += delta;
    const pending = window.__fakeClock.frames;
    window.__fakeClock.frames = [];
    pending.forEach((cb) => { try { cb(window.__fakeClock.t); } catch (e) {} });
    done += delta;
  }
  return window.__fakeClock.t;
};
`;

async function main() {
  const checks = [];
  const check = (name, fn) => checks.push([name, fn]);
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: !process.env.PLAN_LOADING_HEADFUL });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(FAKE_CLOCK);
  const page = await ctx.newPage();

  // Atajo: siembra estado y avanza el reloj en pasos de 50ms.
  const seed = async (state, step = STEP) => {
    await page.goto(`${base}/funnel.html`);
    await page.evaluate((a) => {
      localStorage.setItem('brainy_funnel_state', JSON.stringify(Object.assign({ locale: 'en' }, a.st)));
      localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === a.step)));
    }, { st: state, step });
    await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
    // Espera sin rAF: Playwright sondea con requestAnimationFrame, que aqui
    // esta falsificado y nunca dispara.
    for (let i = 0; i < 100; i += 1) {
      const ready = await page.evaluate((s) => {
        const root = document.getElementById('funnelRoot');
        if (!root || !root.innerHTML.trim()) return false;
        return s === 'begin' ? !!document.querySelector('[data-action="reset"], [data-action="start"]') : !!document.getElementById('nextBtn');
      }, step);
      if (ready) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`la pantalla ${step} no renderizo`);
  };
  const advance = (ms) => page.evaluate((n) => window.__fakeClock.advance(n), ms);
  const progress = () => page.evaluate(() => planLoadingProgress());
  const view = () => page.evaluate(() => ({
    phase: planLoadingProgress().phase,
    bars: [...document.querySelectorAll('.plan-bar-value')].map((n) => n.textContent),
    aria: [...document.querySelectorAll('.plan-bar-track')].map((n) => n.getAttribute('aria-valuenow')),
    dialog: !!document.querySelector('dialog[open]'),
    dialogTitle: (document.querySelector('.plan-dialog-title') || {}).textContent || null,
    ctaDisabled: document.getElementById('nextBtn').disabled,
    stage: [...document.querySelectorAll('.funnel-stage')].map((n) => n.dataset.state)
  }));
  const answer = (which) => page.evaluate((w) => {
    document.querySelector('[data-plan-answer="' + w + '"]').click();
  }, which);

  try {
    check('1. el paso aparece inmediatamente despues de profile_diagnosis', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      const r = await page.evaluate(() => {
        const l = stepList();
        const i = l.findIndex((s) => s.id === 'plan_personalization_loading');
        return { count: l.filter((s) => s.id === 'plan_personalization_loading').length,
          prev: l[i - 1].id, next: l[i + 1].id };
      });
      assert.equal(r.count, 1);
      assert.equal(r.prev, 'profile_diagnosis');
      assert.equal(r.next, 'task_select');
    });

    check('2. es el primer paso de Disenando tu Plan', async () => {
      const r = await page.evaluate(() => {
        const l = stepList();
        const first = l.find((s) => stageIndexOfStep(s) === 1 && s.id !== 'language' && s.id !== 'begin');
        const lastProfile = [...l].reverse().find((s) => stageIndexOfStep(s) === 0);
        return { firstPlan: first.id, lastProfile: lastProfile.id };
      });
      assert.equal(r.firstPlan, STEP);
      assert.equal(r.lastProfile, 'profile_diagnosis');
    });

    check('3. la barra 1 tarda 3000 ms logicos', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(1500);
      const half = await view();
      assert.equal(half.phase, 'bar_1_running');
      assert.ok(Number(half.bars[0].replace('%', '')) >= 45 && Number(half.bars[0].replace('%', '')) <= 55,
        `a mitad de tiempo iba en ${half.bars[0]}`);
      await advance(1400);
      const almost = await view();
      assert.equal(almost.phase, 'bar_1_running', 'no debe completar antes de tiempo');
      assert.ok(Number(almost.bars[0].replace('%', '')) < 100);
      await advance(200);
      const done = await view();
      assert.equal(done.bars[0], '100%');
    });

    check('4. la pregunta 1 no aparece antes del 100%', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(2990);
      assert.equal((await view()).dialog, false, 'el modal abrio antes de completar');
      await advance(20);
      assert.equal((await view()).dialog, true);
    });

    check('5. la barra 2 no comienza sin respuesta 1', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      const atModal = await view();
      assert.equal(atModal.phase, 'question_1');
      await advance(2000);
      const still = await view();
      assert.equal(still.bars[1], '0%', 'la barra 2 avanzo sin responder');
      assert.equal(still.dialog, true, 'el modal debe seguir abierto');
    });

    check('6. Yes permite continuar', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await answer('yes');
      const r = await progress();
      assert.equal(r.rushedMornings, true);
      assert.equal(r.phase, 'bar_2_running');
    });

    check('7. No permite continuar', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await answer('no');
      const r = await progress();
      assert.equal(r.rushedMornings, false, 'false es una respuesta valida');
      assert.equal(r.phase, 'bar_2_running');
    });

    check('8. la barra 2 tarda 3000 ms logicos', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await answer('yes');
      await advance(1500);
      assert.ok(Number((await view()).bars[1].replace('%', '')) >= 45);
      await advance(1400);
      assert.equal((await view()).phase, 'bar_2_running');
      await advance(200);
      assert.equal((await view()).bars[1], '100%');
    });

    check('9. la pregunta 2 no aparece antes del 100%', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await answer('yes');
      await advance(2990);
      assert.equal((await view()).dialog, false);
      await advance(20);
      assert.equal((await view()).dialog, true);
      assert.equal((await view()).dialogTitle,
        'Would you like to learn a new science-based method for developing new healthy habits?');
    });

    check('10. la barra 3 no comienza sin respuesta 2', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await answer('yes');
      await advance(3100);
      await advance(1000);
      assert.equal((await view()).bars[2], '0%');
      assert.equal((await view()).dialog, true);
    });

    check('11. Yes y No funcionan en la pregunta 2', async () => {
      for (const w of ['yes', 'no']) {
        await seed({ profileDiagnosisVariant: 'follow_through' });
        await advance(3100);
        await answer('yes');
        await advance(3100);
        await answer(w);
        const r = await progress();
        assert.equal(r.wantsScienceBasedMethod, w === 'yes');
        assert.equal(r.phase, 'bar_3_running');
      }
    });

    check('12. la barra 3 tarda 3000 ms logicos', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await answer('yes');
      await advance(3100);
      await answer('no');
      await advance(1500);
      assert.ok(Number((await view()).bars[2].replace('%', '')) >= 45);
      await advance(1600);
      assert.equal((await progress()).phase, 'ready');
    });

    check('13. el CTA permanece bloqueado antes de ready', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      for (const t of [500, 1500, 3100, 3400, 6400, 7000]) {
        await advance(t === 500 ? 500 : 0);
        if (t !== 500) continue;
        const v = await view();
        assert.equal(v.ctaDisabled, true);
      }
      await advance(2600);
      await answer('yes');
      const v = await view();
      assert.equal(v.ctaDisabled, true, 'con solo la primera respuesta el CTA sigue bloqueado');
      assert.equal(v.aria[2], '0', 'aria-valuenow es un numero sin %');
    });

    check('14. el CTA se habilita solo con tres barras y dos respuestas', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await answer('yes');
      await advance(3100);
      await answer('no');
      await advance(3100);
      const v = await view();
      assert.deepEqual(v.bars, ['100%', '100%', '100%']);
      assert.equal(v.phase, 'ready');
      assert.equal(v.ctaDisabled, false);
      const r = await progress();
      assert.equal(r.rushedMornings, true);
      assert.equal(r.wantsScienceBasedMethod, false);
      // Casos parciales no habilitan.
      const cases = [
        { phase: 'bar_3_running', bar1: 100, bar2: 100, bar3: 50, rushedMornings: true, wantsScienceBasedMethod: true },
        { phase: 'ready', bar1: 100, bar2: 100, bar3: 99, rushedMornings: true, wantsScienceBasedMethod: true },
        { phase: 'ready', bar1: 100, bar2: 100, bar3: 100, rushedMornings: true, wantsScienceBasedMethod: null }
      ];
      for (const c of cases) {
        const ready = await page.evaluate((s) => isPlanLoadingReady(sanitizePlanLoadingProgress(s)), c);
        assert.equal(ready, false, `no debe habilitar con ${JSON.stringify(c)}`);
      }
    });

    check('15. no hay autoavance al completar', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await answer('yes');
      await advance(3100);
      await answer('no');
      await advance(3200);
      await page.waitForTimeout(300);
      const still = await page.evaluate(() => stepList()[currentStepIndex].id);
      assert.equal(still, STEP, 'la pantalla no debe avanzar sola');
    });

    check('16. cada pregunta aparece exactamente una vez', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      // Cada pregunta aparece, se responde una vez y desaparece del DOM.
      await advance(3100);
      assert.equal(await page.evaluate(() => document.querySelectorAll('dialog[open]').length), 1);
      await answer('yes');
      assert.equal(await page.evaluate(() => document.querySelectorAll('dialog[open]').length), 0);
      // Sobra tiempo sin responder: la pregunta 2 no reaparece ni se duplica.
      await advance(9000);
      assert.equal(await page.evaluate(() => document.querySelectorAll('dialog[open]').length), 1,
        'debe haber exactamente una pregunta 2 abierta');
      await answer('no');
      await advance(9000);
      const open = await page.evaluate(() => document.querySelectorAll('dialog[open]').length);
      assert.equal(open, 0, 'no debe quedar ningun modal abierto');
      const total = await page.evaluate(() => document.querySelectorAll('.plan-dialog').length);
      assert.equal(total, 0, 'los modales deben retirarse del DOM');
      assert.equal((await progress()).phase, 'ready');
    });

    check('17. doble clic no registra dos respuestas', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await page.evaluate(() => {
        const b = document.querySelectorAll('[data-plan-answer]');
        b[0].click(); b[0].click(); b[1].click(); b[1].click();
      });
      const r = await progress();
      assert.equal(r.rushedMornings, true, 'solo la primera pulsacion debe contar');
      await advance(3100);
      const second = await progress();
      assert.equal(second.wantsScienceBasedMethod, null, 'la segunda pregunta no se respondsio');
    });

    check('18. Back cancela la animacion activa', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(1000);
      assert.equal(await page.evaluate(() => planLoadingRuntime.active), 'bar1');
      await page.evaluate(() => document.getElementById('funnelBackBtn').click());
      await page.waitForTimeout(200);
      const r = await page.evaluate(() => ({ active: planLoadingRuntime.active, frame: planLoadingRuntime.frame }));
      assert.equal(r.active, null, 'el runner sigue activo tras salir');
      assert.equal(r.frame, null);
      assert.equal(await page.evaluate(() => stepList()[currentStepIndex].id), 'profile_diagnosis');
      // Y el reloj ya no mueve la barra.
      const before = (await progress()).bar1;
      await advance(3000);
      assert.equal((await progress()).bar1, before, 'la barra siguio avanzando tras salir');
    });

    check('19. volver conserva la fase y las barras completadas', async () => {
      await seed({ profileDiagnosisVariant: 'analysis_paralysis' });
      await advance(3100);
      await answer('no');
      await advance(1500);
      const mid = await progress();
      await page.evaluate(() => document.getElementById('funnelBackBtn').click());
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const l = stepList();
        currentStepIndex = l.findIndex((s) => s.id === 'plan_personalization_loading');
        renderStep();
      });
      const after = await progress();
      assert.equal(after.bar1, 100, 'la barra completada sigue al 100%');
      assert.equal(after.bar2, mid.bar2, 'la barra en curso conserva su porcentaje');
      assert.equal(after.rushedMornings, false);
      assert.equal(after.dialog === undefined, true);
      assert.equal(await page.evaluate(() => document.querySelector('dialog[open]') === null), true,
        'la pregunta ya respondida no debe reaparecer');
    });

    check('20. reload no repite preguntas respondidas', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await answer('yes');
      await advance(3100);
      await answer('no');
      await advance(3100);
      await page.reload({ waitUntil: 'domcontentloaded' });
      for (let i = 0; i < 100; i += 1) {
        if (await page.evaluate(() => !!document.getElementById('nextBtn'))) break;
        await page.waitForTimeout(50);
      }
      const v = await view();
      assert.equal(v.phase, 'ready');
      assert.deepEqual(v.bars, ['100%', '100%', '100%']);
      assert.equal(v.dialog, false, 'no debe reaparecer ninguna pregunta');
      assert.equal(v.ctaDisabled, false);
    });

    check('21. reset elimina el progreso', async () => {
      await seed({
        nq01_gender: 'Female',
        planPersonalizationProgress: { phase: 'ready', bar1: 100, bar2: 100, bar3: 100, rushedMornings: true, wantsScienceBasedMethod: true }
      }, 'begin');
      assert.equal(await page.evaluate(() => !!document.querySelector('[data-action="reset"]')), true);
      await page.evaluate(() => document.querySelector('[data-action="reset"]').click());
      await page.waitForTimeout(300);
      const v = await page.evaluate(() => JSON.parse(localStorage.getItem('brainy_funnel_state')).planPersonalizationProgress);
      assert.equal(v, null, 'reset debe borrar el progreso');
    });

    check('22. valores persistidos invalidos se sanean', async () => {
      const cases = [
        [{ phase: 'inventado', bar1: 'x', bar2: 999, bar3: -5, rushedMornings: 'si', wantsScienceBasedMethod: 3 },
          { phase: 'bar_1_running', bar1: 0, bar2: 100, bar3: 0, rushedMornings: null, wantsScienceBasedMethod: null }],
        [{ phase: 'ready', bar1: 20, rushedMornings: null },
          { phase: 'bar_1_running', bar1: 20, bar2: 0, bar3: 0, rushedMornings: null, wantsScienceBasedMethod: null }],
        [{ phase: 'bar_3_running', bar1: 100, bar2: 100, rushedMornings: false, wantsScienceBasedMethod: null },
          { phase: 'question_2', bar1: 100, bar2: 100, bar3: 0, rushedMornings: false, wantsScienceBasedMethod: null }]
      ];
      for (const [input, expected] of cases) {
        const r = await page.evaluate((s) => sanitizePlanLoadingProgress(s), input);
        assert.deepEqual(r, expected, `sanitize(${JSON.stringify(input)})`);
        assert.ok(['bar_1_running', 'question_1', 'bar_2_running', 'question_2', 'bar_3_running', 'ready'].includes(r.phase),
          'la fase debe ser siempre valida');
        for (const b of ['bar1', 'bar2', 'bar3']) {
          assert.ok(r[b] >= 0 && r[b] <= 100, 'las barras quedan en 0-100');
        }
      }
    });

    check('23. las respuestas no entran en answers', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await answer('yes');
      const r = await page.evaluate(() => {
        const st = JSON.parse(localStorage.getItem('brainy_funnel_state'));
        return { has: Object.prototype.hasOwnProperty.call(st, 'planPersonalizationProgress'),
          keys: Object.keys(st).filter((k) => /rushed|science|personal/i.test(k)),
          nested: st.answers === undefined };
      });
      assert.equal(r.has, true);
      assert.deepEqual(r.keys, ['planPersonalizationProgress']);
    });

    check('24. las respuestas no entran en el payload', async () => {
      const html = fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8');
      for (const field of ['rushedMornings', 'wantsScienceBasedMethod', 'planPersonalizationProgress']) {
        const answers = /answers: \{[\s\S]*?\n                \},/.exec(html);
        assert.equal(answers[0].includes(field), false, `${field} en answers`);
        const body = /body: JSON\.stringify\(\{[\s\S]*?\n                        \}\)/.exec(html);
        assert.equal(body[0].includes(field), false, `${field} en el body del POST`);
        assert.equal(/metadata[^{]*\{[^}]*planPersonalization/.test(html), false, `${field} en metadata`);
        assert.equal(/track\([^)]*(rushedMornings|wantsScienceBasedMethod|planPersonalizationProgress)/.test(html), false,
          `${field} en analytics`);
        assert.equal(/createClaimLink|buildClaimLink[\s\S]{0,400}(rushedMornings|wantsScienceBasedMethod)/.test(html), false,
          `${field} en la URL/QR`);
      }
    });

    check('25. existen exactamente tres placeholders testimoniales', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      const r = await page.evaluate(() => ({
        cards: document.querySelectorAll('.testimonial-placeholder').length,
        avatars: document.querySelectorAll('.testimonial-placeholder__avatar').length,
        stars: document.querySelectorAll('.testimonial-placeholder__stars').length,
        starsPer: [...document.querySelectorAll('.testimonial-placeholder')]
          .map((c) => c.querySelectorAll('.testimonial-placeholder__stars span').length),
        lines: document.querySelectorAll('.testimonial-placeholder__line').length,
        names: document.querySelectorAll('.testimonial-placeholder__name').length,
        hidden: document.querySelector('.testimonials').getAttribute('aria-hidden')
      }));
      assert.equal(r.cards, 3);
      assert.equal(r.avatars, 3);
      assert.equal(r.stars, 3);
      assert.deepEqual(r.starsPer, [5, 5, 5], 'cinco estrellas por tarjeta');
      assert.ok(r.lines >= 6);
      assert.equal(r.names, 3);
      assert.equal(r.hidden, 'true');
    });

    check('26. no hay testimonios ni nombres reales', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      const text = await page.evaluate(() => document.querySelector('.testimonials').textContent.trim());
      assert.equal(text, '', 'los placeholders no deben contener texto');
      assert.equal(await page.evaluate(() => document.querySelectorAll('.testimonials img, .testimonials svg').length), 0);
      const all = await page.evaluate(() => document.getElementById('funnelRoot').textContent);
      for (const bad of ['MellowFlow', 'million', '% results', 'verified results']) {
        assert.equal(all.includes(bad), false, `afirmacion no permitida: ${bad}`);
      }
    });

    check('27. no existen imagenes externas', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      const r = await page.evaluate(() => ({
        remotes: [...document.querySelectorAll('img')].map((i) => i.src).filter((s) => /^https?:|base64|^data:/.test(s)),
        inTestimonials: document.querySelectorAll('.testimonials img').length
      }));
      assert.deepEqual(r.remotes, []);
      assert.equal(r.inTestimonials, 0);
    });

    check('28. los progressbars tienen ARIA correcto', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(1500);
      const r = await page.evaluate(() => [...document.querySelectorAll('.plan-bar-track')].map((n) => ({
        role: n.getAttribute('role'),
        min: n.getAttribute('aria-valuemin'),
        max: n.getAttribute('aria-valuemax'),
        now: n.getAttribute('aria-valuenow'),
        label: n.getAttribute('aria-label'),
        tag: n.tagName
      })));
      assert.equal(r.length, 3);
      for (const bar of r) {
        assert.equal(bar.role, 'progressbar');
        assert.equal(bar.min, '0');
        assert.equal(bar.max, '100');
        assert.ok(Number(bar.now) >= 0 && Number(bar.now) <= 100);
        assert.ok(bar.label && bar.label.length > 3);
      }
      // El porcentaje visible es entero.
      const shown = await page.evaluate(() => [...document.querySelectorAll('.plan-bar-value')].map((n) => n.textContent));
      for (const v of shown) assert.match(v, /^\d+%$/);
      // Un unico live region, discreto.
      const live = await page.evaluate(() => ({
        n: document.querySelectorAll('.step-plan-loading [aria-live]').length,
        text: document.getElementById('planLoadingStatus').textContent
      }));
      assert.equal(live.n, 1, 'un unico live region en la pantalla');
      assert.equal(live.text, '', 'los incrementos no se anuncian');
      // Los hitos si se anuncian.
      await advance(1700);
      const milestone = await page.evaluate(() => document.getElementById('planLoadingStatus').textContent);
      assert.match(milestone, /Understanding your patterns complete\./);
    });

    check('29. el modal atrapa el foco y no se cierra sin responder', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      assert.equal((await view()).dialog, true);
      // Escape no cierra.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
      assert.equal((await view()).dialog, true, 'Escape cerro el modal sin responder');
      // Click en backdrop no cierra.
      await page.mouse.click(10, 10);
      await page.waitForTimeout(120);
      assert.equal((await view()).dialog, true, 'el backdrop cerro el modal');
      // Foco dentro y atrapado tras varios Tab.
      const inside = async () => page.evaluate(() => !!(document.activeElement.closest && document.activeElement.closest('dialog[open]')));
      assert.equal(await inside(), true, 'el foco debe entrar al modal');
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('Tab');
      assert.equal(await inside(), true, 'el foco escapo del modal');
      // Yes y No con teclado, sin respuesta por defecto.
      const selected = await page.evaluate(() => document.querySelectorAll('[data-plan-answer][aria-pressed], [data-plan-answer].selected').length);
      assert.equal(selected, 0, 'no debe haber respuesta por defecto');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      const r = await progress();
      assert.notEqual(r.rushedMornings, null, 'el teclado no registro la respuesta');
      // El foco vuelve a la pantalla.
      const back = await page.evaluate(() => document.activeElement.tagName);
      assert.equal(back, 'H1', 'el foco debe volver al contenido logico');
    });

    check('30. sin overflow horizontal en 320, 390 y 430', async () => {
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
        await seed({ profileDiagnosisVariant: 'follow_through' });
        await advance(3100);
        for (const state of ['modal', 'screen']) {
          const r = await page.evaluate(() => {
            const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
            const tracks = [...document.querySelectorAll('.plan-bar-track')].map((n) => n.getBoundingClientRect());
            const fits = tracks.every((t) => t.left >= 0 && t.right <= document.documentElement.clientWidth && t.width > 0);
            let optionsFit = true;
            const dialog = document.querySelector('dialog[open]');
            if (dialog) {
              const d = dialog.getBoundingClientRect();
              optionsFit = d.left >= 0 && d.right <= document.documentElement.clientWidth;
              for (const b of dialog.querySelectorAll('[data-plan-answer]')) {
                if (b.getBoundingClientRect().height < 44) optionsFit = false;
              }
            }
            return { over, fits, optionsFit };
          });
          assert.equal(r.over, 0, `overflow de ${r.over}px a ${width}px (${state})`);
          assert.equal(r.fits, true, `barras fuera del viewport a ${width}px`);
          if (state === 'modal') assert.equal(r.optionsFit, true, `modal inutilizable a ${width}px`);
        }
        await answer('yes');
      }
    });

    check('31. profile_diagnosis sigue siendo el ultimo paso de la etapa 1', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      const r = await page.evaluate(() => {
        const l = stepList();
        const i = l.findIndex((s) => s.id === 'profile_diagnosis');
        return { stage: stageIndexOfStep(l[i]), nextStage: stageIndexOfStep(l[i + 1]),
          prevStage: stageIndexOfStep(l[i - 1]) };
      });
      assert.equal(r.stage, 0);
      assert.equal(r.nextStage, 1);
      assert.equal(r.prevStage, 0);
    });

    check('32. el anterior primer paso de etapa 2 sigue inmediatamente despues', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      await advance(3100);
      await answer('yes');
      await advance(3100);
      await answer('yes');
      await advance(3100);
      assert.equal((await view()).ctaDisabled, false);
      await page.evaluate(() => document.getElementById('nextBtn').click());
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({
        step: stepList()[currentStepIndex].id,
        variant: JSON.parse(localStorage.getItem('brainy_funnel_state')).profileDiagnosisVariant,
        prog: planLoadingProgress().phase
      }));
      assert.equal(r.step, 'task_select', 'Continue avanzo al paso real siguiente');
      assert.equal(r.variant, 'follow_through', 'el diagnostico no se recrea');
      assert.equal(r.prog, 'ready');
    });

    check('33. preguntas y pantallas anteriores permanecen intactas', async () => {
      await seed({ profileDiagnosisVariant: 'follow_through' });
      const r = await page.evaluate(() => {
        const l = stepList();
        const i = (id) => l.findIndex((s) => s.id === id);
        return {
          gh: l.filter((s) => s.id === 'good_hands').length,
          na: l.filter((s) => s.id === 'not_alone').length,
          ms: l.filter((s) => s.id === 'mini_steps_science').length,
          gp: l.filter((s) => s.id === 'gamified_progress_science').length,
          pd: l.filter((s) => s.id === 'profile_diagnosis').length,
          ghPrev: l[i('good_hands') - 1].key,
          naPrev: l[i('not_alone') - 1].key,
          gpNext: l[i('gamified_progress_science') + 1].id,
          pdNext: l[i('profile_diagnosis') + 1].id
        };
      });
      assert.deepEqual(r, {
        gh: 1, na: 1, ms: 1, gp: 1, pd: 1,
        ghPrev: 'nq10_phone', naPrev: 'nq15_struggle',
        gpNext: 'nq25', pdNext: STEP
      });
      // Y el copy de preguntas sigue igual que en main.
      const { execFileSync } = require('node:child_process');
      const base = execFileSync('git', ['show', 'origin/main:funnel.html'], { cwd: ROOT, encoding: 'utf8' });
      const grab = (src) => {
        const m = /const FUNNEL_STEPS = \[[\s\S]*?\n        \];/.exec(src)[0];
        return [...m.matchAll(/value: '([^']*)'/g)].map((x) => x[1]).join('|');
      };
      assert.equal(grab(fs.readFileSync(path.join(ROOT, 'funnel.html'), 'utf8')), grab(base));
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