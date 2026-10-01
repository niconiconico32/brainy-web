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
  assert.ok(html.includes("button.setAttribute('aria-label', ui('back'))"), 'la flecha debe conservar su aria-label localizado');
  assert.ok(/const BACK_ARROW_SVG = '<svg/.test(html), 'la flecha debe ser un SVG inline');
  assert.equal(html.includes('id="funnelBackBtn"'), true, 'debe existir un unico boton de flecha en el encabezado');
  assert.equal((html.match(/id="funnelBackBtn"/g) || []).length, 1, 'la flecha debe ser un unico boton persistente');
  assert.equal(/MutationObserver/.test(html), false, 'no debe mover nodos: nada de MutationObserver ni appendChild de la flecha');
  assert.equal(/funnelBackSlot/.test(html), false, 'no debe quedar el slot que acumulaba flechas');
  assert.ok(html.includes("return `<div class=\"step-top\" ${BACK_SLOT_MARKER} hidden"), 'backButtonHtml debe marcar que se puede volver');
  assert.ok(/\.opt:focus-visible/.test(html) && /\.back-btn:focus-visible/.test(html), 'debe haber focus-visible');
  assert.ok(/\.back-btn \{[^}]*width: 44px/.test(html), 'la flecha debe tener area tactil de 44px');
}

function testQuestionPlaceholder() {
  assert.ok(html.includes('class="question-illustration"'), 'falta el contenedor .question-illustration');
  assert.ok(html.includes('const QUESTION_ILLUSTRATIONS = {}'), 'falta el mapping por question id');
  assert.ok(html.includes('function questionIllustrationHtml(step)'), 'falta el fallback de ilustracion');
  assert.ok(html.includes("const QUESTION_PLACEHOLDER_LOGO = 'assets/logomain.png'"), 'debe usar assets/logomain.png como imagen base');
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

function stepBlocks(src, type) {
  const steps = /const FUNNEL_STEPS = \[[\s\S]*?\n        \];/.exec(src);
  assert.ok(steps, 'no se encontro FUNNEL_STEPS');
  const blocks = [];
  const re = /\{\s*id: '[^']+',[\s\S]*?\n            \}/g;
  let match = re.exec(steps[0]);
  while (match) {
    if (new RegExp(`type: '${type}'`).test(match[0])) blocks.push(match[0]);
    match = re.exec(steps[0]);
  }
  return blocks;
}

function testOptionValuesUnchanged() {
  const base = baseFile('funnel.html');
  // Solo se permite cambiar el copy de la pantalla de inicio (begin).
  const questions = stepBlocks(html, 'question');
  const baseQuestions = stepBlocks(base, 'question');
  assert.equal(questions.length, baseQuestions.length, 'cambio la cantidad de preguntas');
  assert.deepEqual(questions, baseQuestions, 'cambio el copy, los IDs o los valores de una pregunta');
  // good_hands es una pantalla intermedia nueva; el resto no puede cambiar.
  const strip = (src) => stepBlocks(src, 'interstitial')
    .filter((b) => !b.includes('variant: '))
    .join('\n');
  assert.equal(strip(html), strip(base), 'cambio el copy de un interstitial existente');
  assert.deepEqual(
    stepBlocks(html, 'task_select').concat(stepBlocks(html, 'routine_select')).join('\n'),
    stepBlocks(base, 'task_select').concat(stepBlocks(base, 'routine_select')).join('\n'),
    'cambio task_select o routine_select'
  );
}

function testQuestionCopyUnchanged() {
  const base = baseFile('funnel.html');
  const mine = stepBlocks(html, 'question');
  const theirs = stepBlocks(base, 'question');
  assert.deepEqual(
    mine.map((b) => (/headline: '([^']*)'/.exec(b) || [])[1]),
    theirs.map((b) => (/headline: '([^']*)'/.exec(b) || [])[1]),
    'cambio el titulo de alguna pregunta'
  );
}

function testStepOrderUnchanged() {
  const base = baseFile('funnel.html');
  const ids = (src) => (src.match(/^\s{16}id: '([^']+)',$/gm) || []).map((line) => line.trim());
  // good_hands es una insercion permitida: al quitarla, el orden debe ser
  // identico a main.
  const mine = ids(html);
  assert.equal(mine.filter((id) => id.includes("'good_hands'")).length, 1, 'good_hands debe existir una sola vez');
  assert.deepEqual(mine.filter((id) => !id.includes("'good_hands'")), ids(base), 'el orden de pasos cambio');
  // good_hands es un interstitial nuevo: al quitarlo los tipos deben coincidir.
  const types = (src) => {
    const out = [];
    let skip = false;
    for (const line of src.split('\n')) {
      const id = /^\s{16}id: '([^']+)',$/.exec(line);
      if (id) {
        skip = id[1] === 'good_hands';
        if (skip) continue;
      }
      if (skip) continue;
      const t = /type: '([^']+)'/.exec(line);
      if (t) out.push(t[0].trim());
    }
    return out;
  };
  assert.deepEqual(types(html), types(base), 'los tipos de paso cambiaron');
}

function testHeaderHiddenUntilProfile() {
  assert.ok(/\.funnel-header\[hidden\] \{\s*display: none;/.test(html), 'el encabezado debe ocultarse en begin/language');
  assert.ok(
    /if \(step\.type === 'begin' \|\| step\.type === 'language'\) \{\s*document\.getElementById\('funnelProgress'\)\.hidden = true;/.test(html),
    'begin/language deben ocultar el encabezado'
  );
}

function testBeginScreen() {
  assert.ok(html.includes('Hecho para cerebros que piensan diferente'), 'falta el titulo de la pantalla de inicio');
  assert.ok(html.includes('Da el primer paso para vencer la procrastinación y la paralisis por análisis.'), 'falta el subtitulo');
  assert.ok(html.includes("start: 'Iniciar'"), 'el CTA debe decir Iniciar');
  assert.ok(html.includes('class="begin-top"') && html.includes('class="begin-bottom"'), 'debe separar copy arriba y CTA abajo');
  assert.ok(/\.begin-mid \{[^}]*flex: 1 1 auto/.test(html), 'el medio debe ser el espacio vacio flexible');
  assert.ok(html.includes('body.begin-active') && html.includes("--begin-bg:"), 'debe tener fondo de color plano');
  assert.ok(html.includes('Términos de Uso') && html.includes('Política de Privacidad') && html.includes('Política de Reembolso'), 'falta el aviso legal');
  assert.ok(html.includes('href="terms.html"') && html.includes('href="privacy.html"'), 'los enlaces legales deben apuntar a paginas existentes');
  assert.equal(/\.mascot-hero/.test(html), false, 'la pantalla de inicio ya no usa la mascota');
  assert.equal(/\.footer-note/.test(html), false, 'la pantalla de inicio ya no usa footer-note');
}

function testCompactLayout() {
  assert.ok(/\.question-illustration \{[^}]*width: 104px/.test(html), 'la ilustracion debe ser pequena');
  assert.ok(/\.opt \{[^}]*min-height: 64px/.test(html), 'las opciones deben ser compactas');
  assert.ok(!/\.opt \{[^}]*min-height: (9[2-9]|[1-9][0-9]{2})px/.test(html), 'las opciones no deben volver a ser mas altas de 64px');
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
    file === 'funnel.html' || file === 'package.json' || file.startsWith('testers/') || file.startsWith('captures/'));
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
    ['copy de preguntas contra main', testQuestionCopyUnchanged],
    ['orden de pasos intacto', testStepOrderUnchanged],
    ['encabezado oculto en begin/language', testHeaderHiddenUntilProfile],
    ['pantalla de inicio', testBeginScreen],
    ['layout compacto', testCompactLayout],
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