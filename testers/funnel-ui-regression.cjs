// Regresion de UI del funnel (solo frontend, sin compras ni backend).
//
// Verifica el rediseño visual sin tocar copy, IDs, state machine ni backend:
//   - los dos nombres de etapa existen exactamente como se definieron;
//   - no hay logo superior en el funnel;
//   - la flecha de regreso sigue disponible con su data-action original;
//   - existe el placeholder de ilustracion sobre la pregunta;
//   - las opciones siguen siendo <button> reales con su mismo texto/valor;
//   - el orden de pasos no cambio respecto de main;
//   - no se modificaron llamadas backend ni archivos prohibidos.
//
// Run: npm run test:funnel-ui

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE_REF = process.env.FUNNEL_BASE_REF || 'origin/main';
const FORBIDDEN_FILES = [
  'assets/revenuecat.js',
  'assets/revenuecat-sdk.js',
  'assets/funnel-identity.js'
];

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function baseFile(file) {
  return execFileSync('git', ['show', `${BASE_REF}:${file}`], { cwd: ROOT, encoding: 'utf8' });
}

function changedFiles() {
  return execFileSync('git', ['diff', '--name-only', BASE_REF, '--'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const html = read('funnel.html');

function testStageNames() {
  assert.ok(html.includes('>Creando tu Perfil<'), 'falta la etapa "Creando tu Perfil"');
  assert.ok(html.includes('>Diseñando tu Plan<'), 'falta la etapa "Diseñando tu Plan"');
  assert.equal((html.match(/Creando tu Perfil/g) || []).length, 2, 'la etapa profile debe estar en markup y metadata');
  assert.equal((html.match(/Diseñando tu Plan/g) || []).length, 2, 'la etapa plan debe estar en markup y metadata');
}

function testNoTopLogo() {
  assert.equal(/class="brand-row"/.test(html), false, 'el logo superior sigue presente');
  assert.equal(/class="brand-name"/.test(html), false, 'el wordmark superior sigue presente');
  assert.equal(/\.brand-row\s*\{/.test(html), false, 'quedo CSS de brand-row sin usar');
}

function testBackButtonPreserved() {
  assert.ok(html.includes('data-action="back"'), 'la flecha debe conservar data-action="back"');
  assert.ok(html.includes("aria-label=\"${ui('back')}\""), 'la flecha debe conservar su aria-label localizado');
  assert.ok(/const BACK_ARROW_SVG = '<svg/.test(html), 'la flecha debe ser un SVG inline');
  assert.equal(html.includes('>${ui(\'back\')}</button>'), false, 'la flecha ya no debe usar texto como icono');
  assert.ok(html.includes('funnelBackObserver.observe('), 'la flecha debe seguir enganchada al slot del encabezado');
  assert.ok(html.includes('.back-btn:focus-visible'), 'la flecha debe tener focus-visible');
  assert.ok(/\.back-btn \{[^}]*width: 44px/.test(html), 'la flecha debe tener area tactil de 44px');
}

function testQuestionPlaceholder() {
  assert.ok(html.includes('class="question-illustration"'), 'falta el contenedor .question-illustration');
  assert.ok(html.includes('const QUESTION_ILLUSTRATIONS = {}'), 'falta el mapping por question id');
  assert.ok(html.includes('function questionIllustrationHtml(step)'), 'falta el fallback de ilustracion');
  assert.equal(/placeholder/i.test(html.split('QUESTION_PLACEHOLDER_SVG')[1] || ''), false, 'no debe verse el texto "placeholder"');
  const order = ['${questionIllustrationHtml(step)}', '${headHtml(step)}', '<div class="options">'];
  let cursor = -1;
  for (const token of order) {
    const at = html.indexOf(token, cursor + 1);
    assert.ok(at > cursor, `orden incorrecto en pantalla de pregunta: falta ${token}`);
    cursor = at;
  }
}

function testOptionsAreButtons() {
  assert.ok(html.includes('<button class="opt '), 'las opciones deben seguir siendo botones');
  assert.ok(html.includes('aria-pressed='), 'las opciones deben exponer el estado accesible');
  assert.ok(html.includes('.opt {'), 'deben seguir estilos de .opt');
}

function testOptionValuesUnchanged() {
  const base = baseFile('funnel.html');
  const block = /const FUNNEL_STEPS = \[[\s\S]*?\n        \];/.exec(html);
  const baseBlock = /const FUNNEL_STEPS = \[[\s\S]*?\n        \];/.exec(base);
  assert.ok(block && baseBlock, 'no se encontro FUNNEL_STEPS');
  assert.equal(block[0], baseBlock[0], 'FUNNEL_STEPS cambio: copy, IDs, valores u orden de pasos');
}

function testStepOrderUnchanged() {
  const base = baseFile('funnel.html');
  const ids = (src) => (src.match(/^\s{16}id: '([^']+)',$/gm) || []).map((line) => line.trim());
  assert.deepEqual(ids(html), ids(base), 'el orden de pasos cambio');
  const types = (src) => (src.match(/type: '([^']+)'/g) || []).map((line) => line.trim());
  assert.deepEqual(types(html), types(base), 'los tipos de paso cambiaron');
}

function testHeaderHiddenUntilProfile() {
  assert.ok(/\.funnel-header\[hidden\] \{\s*display: none;/.test(html), 'el encabezado debe ocultarse en begin/language');
  assert.ok(
    /if \(step\.type === 'begin' \|\| step\.type === 'language'\) \{\s*document\.getElementById\('funnelProgress'\)\.hidden = true;/.test(html),
    'begin/language deben ocultar el encabezado'
  );
}

function testBackendCallsUnchanged() {
  const base = baseFile('funnel.html');
  const net = (src) => (src.match(/fetch\([^\n]*/g) || []).map((line) => line.trim()).sort();
  assert.deepEqual(net(html), net(base), 'las llamadas HTTP del funnel cambiaron');
  const supabase = (src) => (src.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s'"`]*/gi) || []).map((line) => line.trim()).sort();
  assert.deepEqual(supabase(html), supabase(base), 'cambio una URL de backend');
  assert.equal(
    html.match(/revenuecatWebApiKey: '[^']+'/)[0],
    base.match(/revenuecatWebApiKey: '[^']+'/)[0],
    'revenuecatWebApiKey no debe cambiar'
  );
}

function testForbiddenFilesUntouched() {
  const changed = changedFiles();
  for (const file of FORBIDDEN_FILES) {
    assert.equal(changed.includes(file), false, `archivo prohibido modificado: ${file}`);
  }
  const supabaseChanged = changed.filter((file) => file.startsWith('supabase/'));
  assert.deepEqual(supabaseChanged, [], 'se modificaron Edge Functions');
  const scopeOk = changed.every((file) =>
    file === 'funnel.html' || file === 'package.json' || file.startsWith('testers/'));
  assert.equal(scopeOk, true, `archivos fuera de alcance: ${changed.join(', ')}`);
}

async function main() {
  const tests = [
    ['nombres de etapa', testStageNames],
    ['logo superior eliminado', testNoTopLogo],
    ['flecha de regreso preservada', testBackButtonPreserved],
    ['placeholder de ilustracion', testQuestionPlaceholder],
    ['opciones son botones', testOptionsAreButtons],
    ['valores de opciones intactos', testOptionValuesUnchanged],
    ['orden de pasos intacto', testStepOrderUnchanged],
    ['encabezado oculto en begin/language', testHeaderHiddenUntilProfile],
    ['llamadas backend intactas', testBackendCallsUnchanged],
    ['archivos prohibidos intactos', testForbiddenFilesUntouched]
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`ok   - ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL - ${name}`);
      console.log(`       ${err.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} checks ok`);
  if (failed) {
    process.exitCode = 1;
  }
}

main();