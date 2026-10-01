// Capturas de validación visual del rediseño del funnel.
// No compra, no toca backend ni checkout: solo navega el frontend local.
//
// Run: npm run shots:funnel-ui
// OUT_DIR=./captures para cambiar el destino.

const { chromium } = require('playwright');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || 'captures');

const VIEWPORTS = [
  { name: '320x568', width: 320, height: 568 },
  { name: '375x812', width: 375, height: 812 },
  { name: '390x844', width: 390, height: 844 },
  { name: '430x932', width: 430, height: 932 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 900 },
  { name: '1440', width: 1440, height: 900 }
];

const STEPS = {
  single: 3,
  multi: 10,
  five: 4,
  plan: 34
};

function startServer() {
  const server = http.createServer((request, response) => {
    const requestPath = decodeURIComponent((request.url || '/').split('?')[0]);
    const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\//, '');
    const filePath = path.resolve(ROOT, relative);
    if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const body = fs.readFileSync(filePath);
      const type = filePath.endsWith('.html') ? 'text/html'
        : filePath.endsWith('.json') ? 'application/json' : 'application/javascript';
      response.writeHead(200, { 'Content-Type': type });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function openAtStep(page, base, stepIndex) {
  await page.goto(`${base}/funnel.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((index) => {
    localStorage.setItem('brainy_funnel_state', JSON.stringify({ locale: 'en' }));
    localStorage.setItem('brainy_funnel_step', String(index));
  }, stepIndex);
  await page.goto(`${base}/funnel.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
}

async function shot(page, file) {
  const target = path.join(OUT_DIR, file);
  await page.screenshot({ path: target, fullPage: false });
  console.log(`  ${file}`);
}

async function measure(page, label, opts = {}) {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - doc.clientWidth;
    const header = document.getElementById('funnelProgress');
    const stages = [...document.querySelectorAll('.funnel-stage')].map((node) => ({
      name: node.querySelector('.funnel-stage-name').textContent.trim(),
      state: node.dataset.state,
      width: node.querySelector('.funnel-stage-fill').style.width
    }));
    const back = document.querySelector('#funnelBackSlot .back-btn');
    const illustration = document.querySelector('.question-illustration');
    const options = [...document.querySelectorAll('.opt')].map((opt) => {
      const rect = opt.getBoundingClientRect();
      return {
        label: opt.querySelector('.opt-label').textContent.trim(),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        overflow: Math.round(rect.right - doc.clientWidth),
        tag: opt.tagName
      };
    });
    const arrow = back ? back.getBoundingClientRect() : null;
    const firstStage = document.querySelector('.funnel-stage');
    const collision = arrow && firstStage
      ? Math.round(arrow.right - firstStage.getBoundingClientRect().left)
      : null;
    const question = document.querySelector('.step-question h1');
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      pageHeight: doc.scrollHeight,
      viewportHeight: window.innerHeight,
      overflow,
      headerVisible: header ? !header.hidden : false,
      stages,
      backVisible: !!back,
      backSize: arrow ? `${Math.round(arrow.width)}x${Math.round(arrow.height)}` : null,
      backLabel: back ? back.getAttribute('aria-label') : null,
      arrowStageCollision: collision,
      illustration: illustration
        ? { w: Math.round(illustration.getBoundingClientRect().width), h: Math.round(illustration.getBoundingClientRect().height) }
        : null,
      question: question ? question.textContent.trim() : null,
      options
    };
  });
  const problems = [];
  if (report.overflow > 0) problems.push(`overflow horizontal ${report.overflow}px`);
  // En desktop una pantalla de pregunta debe caber sin scroll. En mobile el
  // scroll vertical es natural y las listas largas (task/routine select)
  // scrollean por diseno.
  if (opts.requireNoScroll && report.pageHeight > report.viewportHeight) {
    problems.push(`desborda verticalmente ${report.pageHeight - report.viewportHeight}px`);
  }
  if (report.backVisible && report.backSize !== '44x44') problems.push(`flecha ${report.backSize}`);
  if (report.arrowStageCollision !== null && report.arrowStageCollision > 0) problems.push('flecha pisa el progreso');
  for (const opt of report.options) {
    if (opt.tag !== 'BUTTON') problems.push(`opcion no es button: ${opt.tag}`);
    if (opt.overflow > 0) problems.push(`opcion desborda ${opt.overflow}px: ${opt.label}`);
    if (opt.h < 44) problems.push(`opcion baja ${opt.h}px: ${opt.label}`);
  }
  console.log(`  [${label}] ${problems.length ? 'PROBLEMAS: ' + problems.join(' | ') : 'ok'}`);
  return { report, problems };
}

async function walkAndCheckArrows(page, base) {
  await openAtStep(page, base, 1);
  await page.evaluate(() => {
    const locale = document.querySelector('[data-locale="en"]');
    if (locale) locale.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const start = document.getElementById('startBtn');
    if (start) start.click();
  });
  await page.waitForTimeout(400);
  const counts = [];
  for (let i = 0; i < 5; i += 1) {
    counts.push(await page.evaluate(() => document.querySelectorAll('.funnel-header .back-btn').length));
    await page.evaluate(() => {
      const option = document.querySelector('.opt');
      if (option) option.click();
    });
    await page.waitForTimeout(120);
    const next = await page.$('#nextBtn');
    if (next && await next.isEnabled()) await next.click();
    await page.waitForTimeout(350);
  }
  const unique = [...new Set(counts)];
  if (unique.length !== 1 || unique[0] !== 1) {
    problems.push(`la flecha se acumula al avanzar: ${counts.join(',')}`);
  }
  return counts;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const problems = [];

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (err) => errors.push(String(err)));

      console.log(`\n${viewport.name}`);
      await walkAndCheckArrows(page, base);
      for (const [label, stepIndex] of Object.entries(STEPS)) {
        await openAtStep(page, base, stepIndex);
        const { problems: found } = await measure(page, `${viewport.name}/${label}`, {
          requireNoScroll: label === 'five' && viewport.width >= 768
        });
        problems.push(...found);
        if (label === 'plan') {
          const ok = await page.evaluate(() => {
            const pick = document.querySelector('.pick-check');
            return !!pick && pick.tagName === 'BUTTON' && !!document.getElementById('nextBtn');
          });
          if (!ok) problems.push(`${viewport.name}/${label}: falta el selector de tareas/rutinas`);
        } else {
          const selected = await page.evaluate(() => {
            const first = document.querySelector('.opt');
            if (!first) return false;
            first.click();
            const ok = first.getAttribute('aria-pressed') === 'true' && first.classList.contains('selected');
            return ok;
          });
          if (!selected) problems.push(`${viewport.name}/${label}: el estado seleccionado no se refleja`);
        }
        await page.waitForTimeout(120);
        await shot(page, `${viewport.name}-${label}.png`);
      }

      await openAtStep(page, base, STEPS.single);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
      await shot(page, `${viewport.name}-single-full.png`);

      if (errors.length) {
        console.log(`  ERRORES JS: ${errors.join(' | ')}`);
        problems.push(`${viewport.name}: errores JS`);
      }
      await context.close();
    }

    await context_close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n---');
  if (problems.length) {
    console.log(`PROBLEMAS (${problems.length}):`);
    problems.forEach((p) => console.log(` - ${p}`));
    process.exitCode = 1;
  } else {
    console.log('Sin problemas visuales detectados.');
  }
}

async function context_close() {
  return undefined;
}

main();