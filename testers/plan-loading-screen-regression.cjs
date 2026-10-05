// Regresion acotada de la pantalla "Creando tu plan personalizado"
// (plan_personalization_loading). Verifica solo esta pantalla: los 3
// testimonios con datos reales y los 2 modales en ambos idiomas.
//
// Run: npm run test:plan-loading-screen
//   PLAN_LOADING_SCREEN_HEADFUL=1  muestra el navegador

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const STEP = 'plan_personalization_loading';

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
  const browser = await chromium.launch({ headless: !process.env.PLAN_LOADING_SCREEN_HEADFUL });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // Entra a la pantalla y responde los dos modales.
  const play = async (locale) => {
    await page.goto(`${base}/funnel.html`);
    await page.evaluate((l) => localStorage.setItem('brainy_funnel_state', JSON.stringify({ locale: l })), locale);
    await page.goto(`${base}/funnel.html`);
    await page.evaluate((w) => {
      localStorage.setItem('brainy_funnel_step', String(stepList().findIndex((s) => s.id === w)));
    }, STEP);
    await page.goto(`${base}/funnel.html`, { waitUntil: 'networkidle' });
    await page.waitForSelector('dialog.plan-dialog', { timeout: 20000 });
  };

  // Devuelve [popup1, popup2] y el texto del anuncio para lectores de pantalla.
  const runDialogs = async (locale, yes = 'yes') => {
    await play(locale);
    const first = await page.evaluate(() => ({
      title: document.querySelector('.plan-dialog-title').textContent.trim(),
      yes: document.querySelector('[data-plan-answer="yes"]').textContent.trim(),
      no: document.querySelector('[data-plan-answer="no"]').textContent.trim()
    }));
    await page.click(`[data-plan-answer="${yes}"]`);
    await page.waitForSelector('dialog.plan-dialog', { timeout: 20000 });
    const second = await page.evaluate(() => document.querySelector('.plan-dialog-title').textContent.trim());
    await page.click(`[data-plan-answer="${yes === 'yes' ? 'no' : 'yes'}"]`);
    await page.waitForTimeout(700);
    const announce = await page.evaluate(() => document.getElementById('planLoadingStatus').textContent.trim());
    return { first, second, announce };
  };

  const testimonials = () => page.evaluate(() => [...document.querySelectorAll('.testimonial-card')].map((c) => ({
    name: c.querySelector('.testimonial-card__name').textContent.trim(),
    stars: c.querySelector('.testimonial-card__stars').textContent.trim(),
    starsLabel: c.querySelector('.testimonial-card__stars').getAttribute('aria-label'),
    avatar: c.querySelector('.testimonial-card__avatar').getAttribute('src'),
    loaded: c.querySelector('.testimonial-card__avatar').naturalWidth > 0,
    quote: c.querySelector('.testimonial-card__quote').textContent.trim()
  })));

  let failed = 0;
  try {
    check('1. la pantalla sigue en su posicion y etapa', async () => {
      await play('es');
      const r = await page.evaluate(() => {
        const l = stepList();
        const i = l.findIndex((s) => s.id === 'plan_personalization_loading');
        return {
          count: l.filter((s) => s.id === 'plan_personalization_loading').length,
          stage: stageIndexOfStep(l[i]),
          total: l.length
        };
      });
      assert.deepEqual(r, { count: 1, stage: 1, total: 48 });
    });

    check('2. ya no quedan placeholders de testimonios', async () => {
      assert.equal(/testimonial-placeholder/.test(html), false, 'el CSS viejo debe estar eliminado');
      assert.equal(html.includes('testimonial-placeholder__line'), false);
      await play('es');
      const r = await page.evaluate(() => ({
        cards: document.querySelectorAll('.testimonial-card').length,
        placeholders: document.querySelectorAll('.testimonial-placeholder').length
      }));
      assert.equal(r.cards, 3);
      assert.equal(r.placeholders, 0);
    });

    check('3. los 3 testimonios tienen 5 estrellas y nombre', async () => {
      await play('es');
      const t = await testimonials();
      assert.equal(t.length, 3);
      t.forEach((x, i) => {
        assert.equal(x.stars, '★★★★★', `testimonio ${i + 1} sin 5 estrellas`);
        assert.ok(x.starsLabel && /5/.test(x.starsLabel), `falta aria-label de estrellas en ${i + 1}`);
        assert.ok(x.name.length > 2, `testimonio ${i + 1} sin nombre`);
      });
      const names = new Set(t.map((x) => x.name));
      assert.equal(names.size, 3, 'los nombres deben ser distintos');
    });

    check('4. los 3 testimonios tienen los textos pedidos (en)', async () => {
      await play('en');
      const t = await testimonials();
      const expected = [
        'Breaking big tasks into tiny steps made them less intimidating. Each completed step helped my egg grow, so progress finally felt clear and rewarding.',
        'Instead of facing one overwhelming task, I only had to complete the next small step. Unlocking my pet’s growth made me want to keep going.',
        'The mini-steps helped me start without overthinking, while the growing companion turned consistency into something visual, simple and genuinely fun.'
      ];
      assert.deepEqual(t.map((x) => x.quote), expected);
    });

    check('5. los 3 testimonios se traducen al espanol', async () => {
      await play('es');
      const t = await testimonials();
      assert.equal(t.length, 3);
      t.forEach((x, i) => {
        assert.ok(/[áéíóúñ¿¡]/.test(x.quote), `testimonio ${i + 1} sigue en ingles: ${x.quote.slice(0, 40)}`);
        assert.ok(x.quote.length > 40, `testimonio ${i + 1} demasiado corto`);
      });
      // No puede ser identico al ingles.
      const en = ['Breaking big tasks', 'Instead of facing', 'The mini-steps'];
      t.forEach((x, i) => assert.equal(x.quote.startsWith(en[i]), false));
    });

    check('6. las fotos de avatar salen de testimonialAvatars y cargan', async () => {
      await play('es');
      const t = await testimonials();
      const avail = fs.readdirSync(path.join(ROOT, 'assets/testimonialAvatars'));
      t.forEach((x, i) => {
        assert.ok(x.avatar.startsWith('assets/testimonialAvatars/'), `ruta no local: ${x.avatar}`);
        const file = x.avatar.replace('assets/testimonialAvatars/', '');
        assert.ok(avail.includes(file), `el archivo no existe: ${file}`);
        assert.equal(x.loaded, true, `la foto ${i + 1} no cargo`);
      });
      const unique = new Set(t.map((x) => x.avatar));
      assert.equal(unique.size, 3, 'las fotos deben ser distintas');
    });

    check('7. los modales aparecen en espanol', async () => {
      const r = await runDialogs('es');
      assert.equal(r.first.title, '¿Generally andás apurado/a en las mañanas?');
      assert.equal(r.first.yes, 'Sí');
      assert.equal(r.first.no, 'No');
      assert.equal(r.second, '¿Te gustaría aprender un método nuevo, basado en evidencia, para desarrollar hábitos saludables?');
      // Ningun texto en ingles.
      assert.equal(/rushed in the mornings|Yes|Would you like/.test(r.first.title + r.second), false);
    });

    check('8. los modales aparecen en ingles', async () => {
      const r = await runDialogs('en');
      assert.equal(r.first.title, 'Are you generally rushed in the mornings?');
      assert.equal(r.first.yes, 'Yes');
      assert.equal(r.second, 'Would you like to learn a new science-based method for developing new healthy habits?');
    });

    check('9. el modal tiene variante es y en en los datos', async () => {
      // El modal se abre con showModal() y trampa el foco: no se puede cambiar
      // de idioma con el abierto. Lo que hay que garantizar es que ambas
      // variantes existan, para que una refactorizacion no vuelva a dejar
      // el popup en un solo idioma.
      const variants = await page.evaluate(() => Object.fromEntries(
        Object.entries(PLAN_LOADING_QUESTIONS).map(([k, v]) => [k, Object.keys(v).sort()])
      ));
      assert.deepEqual(variants, {
        question_1: ['en', 'es'],
        question_2: ['en', 'es']
      });
      // Y que la resolucion por idioma devuelva strings, no objetos.
      const es = await page.evaluate(() => PLAN_LOADING_QUESTIONS.question_1.es.title);
      assert.equal(typeof es, 'string');
      assert.ok(/andás/.test(es), 'la variante es debe estar en espanol');
    });

    check('10. el anuncio para lectores de pantalla no dice [object Object]', async () => {
      const es = await runDialogs('es');
      const en = await runDialogs('en');
      [es, en].forEach((r) => {
        assert.equal(/\[object Object\]/.test(r.announce), false, `announce roto: ${r.announce}`);
        assert.ok(r.announce.length > 0, 'el anuncio esta vacio');
      });
      assert.equal(es.announce, 'Diseñando tus pasos chicos completado.');
      assert.equal(en.announce, 'Designing your mini-steps complete.');
    });

    check('11. las barras y el titulo se traducen', async () => {
      const grab = (locale) => play(locale).then(() => page.evaluate(() => ({
        h1: document.querySelector('.step-plan-loading h1').textContent.trim(),
        bars: [...document.querySelectorAll('.plan-bar-label')].map((n) => n.textContent.trim())
      })));
      const es = await grab('es');
      const en = await grab('en');
      assert.equal(es.h1, 'Creando tu plan personalizado');
      assert.equal(en.h1, 'Creating your personalized plan');
      assert.deepEqual(es.bars, ['Entendiendo tus patrones', 'Diseñando tus pasos chicos', 'Construyendo tu plan Brainy']);
      assert.deepEqual(en.bars, ['Understanding your patterns', 'Designing your mini-steps', 'Building your Brainy plan']);
    });

    check('12. el bloque de testimonios sigue siendo decorativo', async () => {
      await play('es');
      assert.equal(await page.evaluate(() => document.querySelector('.testimonials').getAttribute('aria-hidden')), 'true');
    });

    check('13. la pantalla no escribe estado ni dispara red', async () => {
      const net = [];
      const listener = (r) => {
        const u = r.url();
        if (!u.startsWith(base)) net.push(r.method() + ' ' + u);
      };
      page.on('request', listener);
      await play('es');
      const answersBefore = await page.evaluate(() => {
        const st = window.brainyFunnelState;
        const out = {};
        Object.keys(st).filter((k) => /^(nq|p4|p26|edad|email)/.test(k)).forEach((k) => { out[k] = st[k]; });
        return JSON.stringify(out);
      });
      await page.click('[data-plan-answer="yes"]');
      await page.waitForSelector('dialog.plan-dialog', { timeout: 20000 });
      await page.click('[data-plan-answer="no"]');
      await page.waitForTimeout(600);
      page.off('request', listener);
      assert.deepEqual(net, [], `red inesperada: ${net.join(', ')}`);
      // Las respuestas del quiz no pueden cambiar: solo se escriben los dos
      // campos del modal y el progreso de las barras de esta misma pantalla.
      const answersNow = await page.evaluate(() => {
        const st = window.brainyFunnelState;
        const out = {};
        Object.keys(st).filter((k) => /^(nq|p4|p26|edad|email)/.test(k)).forEach((k) => { out[k] = st[k]; });
        return JSON.stringify(out);
      });
      assert.equal(answersNow, answersBefore, 'las respuestas del quiz no pueden cambiar');
    });

    check('14. sin errores de consola en toda la pantalla', async () => {
      pageErrors.length = 0;
      await runDialogs('es');
      assert.deepEqual(pageErrors, []);
    });

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