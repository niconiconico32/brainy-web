const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const CANONICAL_DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

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
      const type = filePath.endsWith('.html') ? 'text/html' :
        filePath.endsWith('.json') ? 'application/json' : 'application/javascript';
      response.writeHead(200, { 'Content-Type': type });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      localStorage.setItem('brainy_funnel_state', JSON.stringify({
        selectedTasks: [],
        selectedRoutines: [{
          templateId: 'hidratacion_anclaje',
          id: 'hidratacion_anclaje',
          name: 'Hidratación y anclaje matutino',
          icon: '💧',
          days: ['daily'],
          tasks: [
            { title: 'Paso 1', position: 1 },
            { title: 'Paso 2', position: 2 },
            { title: 'Paso 3', position: 3 },
            { title: 'Paso 4', position: 4 },
            { title: 'Paso 5', position: 5 },
          ],
        }],
        assignedRoutines: [{ catalogId: 1 }],
      }));
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/funnel.html`, { waitUntil: 'networkidle' });
    const payload = await page.evaluate(() => window.buildUserPlanPayload());
    const daySamples = await page.evaluate(() => ({
      numeric: window.canonicalRoutineDays([0, 2, 6]),
      englishDaily: window.canonicalRoutineDays(['every day']),
    }));
    const routine = payload.routines[0];
    assert.deepEqual(routine.days, CANONICAL_DAYS);
    assert.deepEqual(daySamples.numeric, ['Dom', 'Mar', 'Sáb']);
    assert.deepEqual(daySamples.englishDaily, CANONICAL_DAYS);
    assert.equal(routine.steps.length, 5);
    assert.equal(Object.hasOwn(routine, 'tasks'), false);
    assert.deepEqual(routine.steps.map((step) => step.title), ['Paso 1', 'Paso 2', 'Paso 3', 'Paso 4', 'Paso 5']);
    console.log('funnel payload regression: canonical days and steps verified');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
