// Regresión E2E del funnel Brainy (Playwright + Chromium headless).
//
// Prerequisitos:
//   - Servir el sitio en http://localhost:8000 (ej: python3 -m http.server 8000)
//   - Navegadores de Playwright instalados (npx playwright install chromium)
//   - node_modules con playwright (npm install)
//
// Run:
//   npm run test:e2e:funnel
//
// Config por env (opcional):
//   FUNNEL_BASE_URL  -> http://localhost:8000 (default)
//   FUNNEL_RC_KEY    -> key de sandbox RevenueCat Web Billing (default la key pública sandbox)
//
// Escenarios:
//   WALK   onboarding completo desktop -> paywall (backend en modo demo, offline)
//   PAY    pago sandbox completo -> éxito (backend real, tarjeta 4242)
//   MOBILE modal checkout en emulación iPhone (sin pagar)
//   HOME   index + CTA "Comenzar el onboarding" -> funnel.html
//   STATIC 6 páginas estáticas 200 y sin errores
//   GATE   sin key no se muestra el paywall
//
// Nota: en logs/consola, emails, tokens de redención, claim tokens y JWTs se
// enmascaran siempre (nunca se imprime contenido sensible).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.FUNNEL_BASE_URL || 'http://localhost:8000';
const KEY = process.env.FUNNEL_RC_KEY || 'strp_sb_mozjaozAfCdAQiBTzzSUnwQD';
const ARTIFACTS = path.join(__dirname, '.e2e-artifacts');

const STATE = {
    q1_estado_actual: 'a', q2_dolor: ['b'], q3_intentos_previos: 'c', q4_causa_fracaso: 'd', q5_identidad_futura: 'e',
    q6_area_prioritaria: 'f', q7_compromiso: 'g', q8_tiempo_disponible: 'h', q9_listo: 'i', q10_cuando_empezar: 'j',
    edad: 25, email: 'sb-checkout@brainyadhd.com',
    selectedTasks: [{ templateId: 't', id: 't1', title: 'T', emoji: '', subtasks: [{ title: 'P', duration: 5 }] }],
    selectedRoutines: [{ templateId: 'r', id: 'r1', name: 'R', title: 'R', icon: '', tasks: [{ title: 'T', position: 1 }], subtasks: [{ title: 'T', duration: null }] }],
    assignedRoutines: [{ catalogId: 'h', name: 'H', emoji: 'x', color: '#fff' }], emailSubmitted: true,
    planId: 'sb-plan-test', claimToken: 'sbtok1234567890abcdef', purchaseCompleted: false, selectedPackageId: null, pendingRedemptionUrl: null
};

function maskText(s) {
    if (typeof s !== 'string') return s;
    return s
        .replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '[email redacted]')
        .replace(/(redemption[_-]?token[=:]["']?)[A-Za-z0-9_.\-]+/gi, '$1[redacted]')
        .replace(/(claim[_-]?token[=:]["']?)[A-Za-z0-9_.\-]+/gi, '$1[redacted]')
        .replace(/eyJ[A-Za-z0-9_.\-]+(\.[A-Za-z0-9_.\-]+)+/g, '[jwt redacted]')
        .replace(/\b(rk_|sk_|strp_|tok_|req_|whsec_|rcb_)[A-Za-z0-9_]{8,}/g, '[key redacted]');
}

const results = [];
function rec(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok ? '' : ' :: ' + String(maskText(detail) || '').slice(0, 300)));
}

fs.mkdirSync(ARTIFACTS, { recursive: true });
const logPath = path.join(ARTIFACTS, 'reg_pay.log');
const log = (...x) => fs.appendFileSync(logPath, x.join(' ') + '\n');

const DISPATCHER = () => {
    const vis = (el) => !!el && el.offsetParent !== null;
    const el = (s) => document.querySelector(s);
    const step = parseInt(localStorage.getItem('brainy_funnel_step'), 10);
    const ta = { step, action: 'none', hasBuy: !!el('#purchaseBtn'), hasSuccess: !!document.querySelector('.success-checks') };
    if (vis(el('#startBtn'))) { el('#startBtn').click(); return { ...ta, action: 'begin' }; }
    const age = el('#ageInput');
    if (vis(age)) {
        if (!age.value) { age.value = '30'; age.dispatchEvent(new Event('input', { bubbles: true })); return { ...ta, action: 'age' }; }
    }
    const email = el('#emailInput');
    if (vis(email)) { email.value = 'sb-checkout@brainyadhd.com'; email.dispatchEvent(new Event('input', { bubbles: true })); const n = el('#nextBtn'); if (n && !n.disabled) n.click(); return { ...ta, action: 'email' }; }
    const opt = Array.from(document.querySelectorAll('.opt')).find((o) => vis(o) && !o.classList.contains('selected'));
    if (opt) { opt.click(); const n = el('#nextBtn'); if (n && !n.disabled) n.click(); return { ...ta, action: 'question' }; }
    const selBtn = Array.from(document.querySelectorAll('[data-select]')).find((b) => {
        const card = b.closest('.pick-card');
        return vis(b) && card && !card.classList.contains('selected');
    });
    if (selBtn) { selBtn.click(); const n = el('#nextBtn'); if (n && !n.disabled) n.click(); return { ...ta, action: 'picker' }; }
    const pvDone = Array.from(document.querySelectorAll('.pv-step')).some((p) => p.classList.contains('done'));
    if (!pvDone) { const pv = Array.from(document.querySelectorAll('.pv-step')).find((p) => vis(p)); if (pv) { pv.click(); return { ...ta, action: 'preview' }; } }
    if (vis(el('#purchaseBtn'))) return { ...ta, action: 'PAYWALL' };
    if (vis(el('#openAppBtn')) || vis(document.querySelector('.handoff-open'))) return { ...ta, action: 'HANDOFF' };
    const n = el('#nextBtn');
    if (vis(n) && !n.disabled) { n.click(); return { ...ta, action: 'next' }; }
    if (ta.hasSuccess) return { ...ta, action: 'SUCCESS' };
    return { ...ta, action: 'STUCK' };
};

async function makePage(browser, opts = {}) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 900 }, locale: 'es-AR' }, opts.ctx || {}));
    const page = await ctx.newPage();
    const errs = [];
    const analytics = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
    page.on('console', (m) => { const t = m.text(); if (/funnel-analytics/.test(t)) analytics.push(t.slice(0, 220)); });
    page.setDefaultTimeout(20000);
    const key = opts.key !== undefined ? opts.key : KEY;
    const extra = opts.cfgExtra || null;
    await page.addInitScript(([k, ex]) => {
        const cfg = { revenuecatWebApiKey: k };
        if (ex) Object.assign(cfg, ex);
        window.__BRAINY_FUNNEL_CONFIG__ = cfg;
    }, [key, extra]);
    return { page, ctx, errs, analytics };
}

async function seed(page, state = STATE, step = 21) {
    await page.evaluate(([s, st]) => {
        localStorage.setItem('brainy_funnel_state', JSON.stringify(s));
        localStorage.setItem('brainy_funnel_step', String(st));
        localStorage.removeItem('brainy_funnel_step_marker');
    }, [state, step]);
}

async function walk(page, maxIters = 60) {
    let last = null;
    for (let i = 0; i < maxIters; i++) {
        const r = await page.evaluate(DISPATCHER);
        if (r.action === 'PAYWALL' || r.action === 'HANDOFF' || r.action === 'SUCCESS') return r;
        if (r.action === 'STUCK') {
            if (last === r.step) await page.waitForTimeout(1200);
            else last = r.step;
        } else {
            last = r.step;
            await page.waitForTimeout(420);
        }
    }
    return null;
}

async function payModalFlow(page) {
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        const f = page.frames().find((fr) => /embedded-checkout-inner/.test(fr.url()) && !/origin-frame|preview/.test(fr.url())) || null;
        if (f) return f;
    }
    return null;
}

async function continueClick(page) {
    const sel = () => page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => /continuar/i.test((x.textContent || '').trim()));
        if (b) { b.click(); return true; }
        return false;
    });
    for (let i = 0; i < 8; i++) {
        if (await sel()) return true;
        await page.waitForTimeout(500);
    }
    return false;
}

async function payWithCard(page, inner) {
    await inner.fill('#billingName', 'Test Sandbox').catch(() => {});
    await inner.fill('#cardNumber', '4242424242424242').catch(() => {});
    await inner.fill('#cardExpiry', '12/34').catch(() => {});
    await inner.fill('#cardCvc', '123').catch(() => {});
    await page.waitForTimeout(700);
    const tail = await inner.evaluate(() => (document.body.innerText || '').replace(/\n+/g, ' ').slice(-800)).catch(() => '');
    log('AFTER-FILL TAIL: ' + maskText(tail));
    await inner.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => /Comenzar prueba|Probar|Pagar|Suscribir|Start|Subscribe|Pay now/i.test(x.textContent || '') && !x.disabled);
        if (b) b.click();
    });
    log('SUBMIT intentado');
    const t0 = Date.now();
    while (Date.now() - t0 < 150000) {
        await page.waitForTimeout(1200);
        const gone = !page.frames().some((fr) => /embedded-checkout-inner/.test(fr.url()) && !/origin-frame|preview/.test(fr.url()));
        const ready = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some((b) => /continuar/i.test((b.textContent || '')))).catch(() => false);
        const done = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}'); return !!s.purchaseCompleted; }).catch(() => false);
        if (done) return { ok: true, after: 'done' };
        if (ready) {
            log('t+' + Math.round((Date.now() - t0) / 1000) + 's CONTINUAR visible');
            const cl = await continueClick(page);
            if (cl) return { ok: true, after: 'continue-clicked' };
        }
        if (gone && Date.now() - t0 > 4000) {
            const mainTail = await page.evaluate(() => (document.body.innerText || '').replace(/\n+/g, ' ').slice(-500)).catch(() => '');
            const innerTail = await inner.evaluate(() => (document.body.innerText || '').replace(/\n+/g, ' ').slice(-500)).catch(() => '');
            log('t+' + Math.round((Date.now() - t0) / 1000) + 's FRAME GONE | main: ' + maskText(mainTail) + ' | inner: ' + maskText(innerTail));
        }
    }
    const lastTail = await inner.evaluate(() => (document.body.innerText || '').replace(/\n+/g, ' ').slice(-900)).catch(() => '');
    log('TIMEOUT tail: ' + maskText(lastTail));
    return { ok: false, after: 'timeout' };
}

(async () => {
    fs.rmSync(logPath, { force: true });
    const browser = await chromium.launch({ headless: true });

    // S1 WALK: onboarding completo desktop (backend offline)
    try {
        const { page, errs } = await makePage(browser, { cfgExtra: { enableBackend: false } });
        await page.goto(BASE + '/funnel.html');
        await page.waitForTimeout(500);
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await page.waitForTimeout(800);
        const r = await walk(page);
        const state = await page.evaluate(() => {
            const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
            const keys = ['q1_estado_actual', 'q2_dolor', 'q3_intentos_previos', 'q4_causa_fracaso', 'q5_identidad_futura', 'q6_area_prioritaria', 'q7_compromiso', 'q8_tiempo_disponible', 'q9_listo', 'q10_cuando_empezar'];
            return { step: parseInt(localStorage.getItem('brainy_funnel_step'), 10), answered: keys.filter((k) => k === 'q2_dolor' ? (Array.isArray(s[k]) && s[k].length > 0) : s[k] !== null && s[k] !== undefined).length, tasks: s.selectedTasks ? s.selectedTasks.length : 0, routines: s.selectedRoutines ? s.selectedRoutines.length : 0, purchaseCompleted: !!s.purchaseCompleted };
        });
        const cta = await page.evaluate(() => !!document.getElementById('purchaseBtn') && !!document.querySelector('.plan-card'));
        await page.screenshot({ path: path.join(ARTIFACTS, 'reg_walk.png'), fullPage: true }).catch(() => {});
        const ok = r && r.action === 'PAYWALL' && state.step === 21 && state.answered === 10 && state.tasks >= 1 && state.routines >= 1 && cta && errs.length === 0;
        rec('WALK onboarding desktop -> paywall', ok, JSON.stringify({ r, state, cta, errs }));
        await page.close();
    } catch (e) { rec('WALK onboarding desktop -> paywall', false, e.message); }

    // S2 PAY: pago completo sandbox (backend real)
    try {
        const { page, errs, analytics } = await makePage(browser, { ctx: { locale: 'es-AR' } });
        await page.goto(BASE + '/funnel.html');
        await seed(page);
        await page.reload();
        await page.waitForTimeout(1800);
        await page.click('#purchaseBtn');
        const inner = await payModalFlow(page);
        if (!inner) { rec('PAY flujo completo', false, 'modal checkout no abrió'); await page.close(); }
        else {
            const payRes = await payWithCard(page, inner);
            if (!payRes.ok) { log('\nANALYTICS:\n' + maskText(analytics.join('\n'))); rec('PAY flujo completo', false, 'pago no completó: ' + payRes.after); await page.close(); }
            else {
                await page.waitForTimeout(1500);
                const st = await page.evaluate(() => {
                    const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
                    const mask = (u) => !u ? null : u.replace(/([?&](?!redemption_)[a-zA-Z0-9_]+=)[^&#]+/g, '$1[redacted]').replace(/redemption_token=.[^&]*/, 'redemption_token=[redacted]');
                    return { step: parseInt(localStorage.getItem('brainy_funnel_step'), 10), purchaseCompleted: !!s.purchaseCompleted, pendingRedemptionUrl: mask(s.pendingRedemptionUrl),
                             headline: document.querySelector('.card-head h1') ? document.querySelector('.card-head h1').textContent : null, hasSuccess: !!document.querySelector('.success-checks') };
                });
                await page.screenshot({ path: path.join(ARTIFACTS, 'reg_pay.png'), fullPage: true }).catch(() => {});
                const aOk = analytics.some((l) => /purchase_success/.test(l) && /entitlementActive: true/.test(l));
                const ok = st.step === 22 && st.purchaseCompleted && st.hasSuccess && errs.length === 0 && aOk;
                rec('PAY flujo completo', ok, JSON.stringify({ st, aOk, errs }));
                await page.close();
            }
        }
    } catch (e) { rec('PAY flujo completo -> éxito', false, e.message); }

    // S3 MOBILE: modal de pago en iPhone (sin pagar)
    try {
        const { page, errs } = await makePage(browser, { ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
        await page.goto(BASE + '/funnel.html');
        await seed(page);
        await page.reload();
        await page.waitForTimeout(1800);
        await page.click('#purchaseBtn').catch(() => {});
        const inner = await payModalFlow(page);
        await page.screenshot({ path: path.join(ARTIFACTS, 'reg_mobile.png') }).catch(() => {});
        rec('MOBILE modal checkout on iPhone', !!inner, 'modal: ' + (inner ? 'open' : 'absent') + ' | errs: ' + errs.length);
        await page.close();
    } catch (e) { rec('MOBILE modal checkout on iPhone', false, e.message); }

    // S4 HOME: index + CTA
    try {
        const { page, errs } = await makePage(browser, { key: '' });
        const resp = await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(800);
        const info = await page.evaluate(() => ({
            title: document.title,
            ctaHref: document.querySelector('.primary-cta a') ? document.querySelector('.primary-cta a').getAttribute('href') : null,
            badges: document.querySelectorAll('.store-badge').length
        }));
        const ok = resp.status() === 200 && /brainy/i.test(info.title) && info.ctaHref && info.ctaHref.indexOf('funnel.html') !== -1 && errs.length === 0;
        rec('HOME index + CTA al funnel', ok, JSON.stringify({ info, errs }));
        await page.close();
    } catch (e) { rec('HOME index + CTA al funnel', false, e.message); }

    // S5 STATIC: páginas estáticas
    try {
        const { page, errs } = await makePage(browser, { key: '' });
        const pages = ['privacy.html', 'terms.html', 'contact.html', 'support.html', 'testers.html', 'testers/index.html'];
        let all = true;
        const details = [];
        for (const p of pages) {
            const r = await page.goto(BASE + '/' + p, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(300);
            const pe = await page.evaluate(() => (window.pageErrorList ? window.pageErrorList.length : 0));
            const okPage = r.status() === 200 && pe === 0;
            details.push(p + ':' + (okPage ? 'ok' : 'status_' + r.status()));
            all = all && okPage;
        }
        rec('STATIC 6 páginas 200 sin errores', all, details.join(', '));
        await page.close();
    } catch (e) { rec('STATIC 6 páginas 200 sin errores', false, e.message); }

    // S6 GATE: sin clave no se muestra paywall
    try {
        const { page, errs } = await makePage(browser, { key: '' });
        await page.goto(BASE + '/funnel.html');
        const gate = await page.evaluate(() => ({ checkout: typeof window.funnelWebCheckout === 'function' ? !!window.funnelWebCheckout() : null }));
        await seed(page);
        await page.reload();
        await page.waitForTimeout(1200);
        const hasPaywall = await page.evaluate(() => ({ buy: !!document.getElementById('purchaseBtn'), text: /activa tu plan/i.test(document.body.innerText) }));
        const ok = gate.checkout === false && !hasPaywall.buy && !hasPaywall.text && errs.length === 0;
        rec('GATE sin key -> sin paywall', ok, JSON.stringify({ gate, hasPaywall, errs }));
        await page.close();
    } catch (e) { rec('GATE sin key -> sin paywall', false, e.message); }

    await browser.close();
    const fails = results.filter((r) => !r.ok);
    console.log('\nRESUMEN: ' + (results.length - fails.length) + '/' + results.length + ' ok');
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });