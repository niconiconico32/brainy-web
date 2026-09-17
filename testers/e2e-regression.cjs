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
//   WALK    onboarding completo desktop -> paywall (backend demo, checkout bloqueado)
//   PAY     pago sandbox real completo -> success/handoff (backend real, tarjeta 4242)
//   MOBILE  modal checkout en emulación iPhone (sin pagar)
//   HOME    index + CTA "Comenzar el onboarding" -> funnel.html
//   STATIC  6 páginas estáticas 200 y sin errores
//   GATE    sin key no se muestra el paywall
//   DEMO    backend demo -> checkout bloqueado por falta de plan real
//   NOPLAN  create-funnel-plan falla -> checkout bloqueado
//   CANCEL  checkout cancelado -> vuelve al paywall, plan permanece
//   NOREDEEM purchase sin redemptionInfo -> recovery, sin segundo cobro
//   REFRESH refresh post-compra -> success sin recomprar
//   DEEPLINK deep link contiene token + redeem_url + email URL-encoded
//   PAYLOAD difficulty nunca "medium" + counts + rangos 1-3 / 1-5
//   EGG canónico 1-8 (numérico, sin slugs) + 1:1 + distintas + display
//
// Nota: en logs/consola, emails, tokens (claim/redeem), hashes y JWTs se
// enmascaran siempre (nunca se imprime contenido sensible).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.FUNNEL_BASE_URL || 'http://localhost:8000';
const KEY = process.env.FUNNEL_RC_KEY || 'strp_sb_mozjaozAfCdAQiBTzzSUnwQD';
const ARTIFACTS = path.join(__dirname, '.e2e-artifacts');

const PLAN_ID = 'sb-plan-test';
const CLAIM_TOKEN = 'sbtok1234567890abcdef';
const EMAIL = 'sb+checkout@brainyadhd.com';

const STATE = {
    q1_estado_actual: 'a', q2_dolor: ['b'], q3_intentos_previos: 'c', q4_causa_fracaso: 'd', q5_identidad_futura: 'e',
    q6_area_prioritaria: 'f', q7_compromiso: 'g', q8_tiempo_disponible: 'h', q9_listo: 'i', q10_cuando_empezar: 'j',
    edad: 25, email: EMAIL,
    selectedTasks: [{ templateId: 't', id: 't1', title: 'T', emoji: '', subtasks: [{ title: 'P', duration: 5 }] }],
    selectedRoutines: [{ templateId: 'r', id: 'r1', name: 'R', title: 'R', icon: '', tasks: [{ title: 'T', position: 1 }], subtasks: [{ title: 'T', duration: null }] }],
    assignedRoutines: [{ catalogId: 'h', name: 'H', emoji: 'x', color: '#fff' }], emailSubmitted: true,
    planId: PLAN_ID, claimToken: CLAIM_TOKEN, clientPlanKey: '11111111-1111-4111-8111-111111111111',
    purchaseCompleted: false, handoffReady: false, selectedPackageId: null, pendingRedemptionUrl: null
};

function state(overrides) {
    return Object.assign({}, JSON.parse(JSON.stringify(STATE)), overrides || {});
}

const SUCCESS_STATE = state({
    purchaseCompleted: true, handoffReady: true,
    pendingRedemptionUrl: 'rc-stub://redeem_web_purchase?redemption_token=stubsecret'
});

function maskText(s) {
    if (typeof s !== 'string') return s;
    return s
        .replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '[email redacted]')
        .replace(/(redemption[_-]?token[=:]["']?)[A-Za-z0-9_.\-]+/gi, '$1[redacted]')
        .replace(/(claim[_-]?token[=:]["']?)[A-Za-z0-9_.\-]+/gi, '$1[redacted]')
        .replace(/([?&]email=)[^&#]+/gi, '$1[email redacted]')
        .replace(/([?&]token=)[^&#]+/gi, '$1[token redacted]')
        .replace(/eyJ[A-Za-z0-9_.\-]+(\.[A-Za-z0-9_.\-]+)+/g, '[jwt redacted]')
        .replace(/\b(rk_|sk_|strp_|tok_|req_|whsec_|rcb_)[A-Za-z0-9_]{8,}/g, '[key redacted]');
}

const results = [];
function rec(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok ? '' : ' :: ' + String(maskText(detail) || '').slice(0, 400)));
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
    if (vis(email)) { email.value = 'sb+checkout@brainyadhd.com'; email.dispatchEvent(new Event('input', { bubbles: true })); const n = el('#nextBtn'); if (n && !n.disabled) n.click(); return { ...ta, action: 'email' }; }
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
    page.on('console', (m) => { const t = m.text(); if (/funnel-analytics/.test(t)) analytics.push(t.slice(0, 240)); });
    page.setDefaultTimeout(20000);
    const key = opts.key !== undefined ? opts.key : KEY;
    const extra = opts.cfgExtra || null;
    const stub = opts.stub || null;
    await page.addInitScript(([k, ex, st]) => {
        const cfg = { revenuecatWebApiKey: k };
        if (ex) Object.assign(cfg, ex);
        window.__BRAINY_FUNNEL_CONFIG__ = cfg;
        if (st) {
            const calls = { purchase: 0, configure: 0 };
            window.__RC_STUB_CALLS__ = calls;
            const svc = {
                isAvailable: () => true,
                keyKind: () => 'ok',
                isSafePublicKey: () => true,
                configure: () => { calls.configure++; return {}; },
                isEntitledTo: (ci, id) => !!(ci && ci.entitlements && ci.entitlements.active && ci.entitlements.active[id] && ci.entitlements.active[id].isActive),
                getOfferings: () => Promise.resolve({
                    identifier: cfg.revenuecatOfferingId || 'web_default',
                    annual: { identifier: '$rc_annual', webBillingProduct: { title: 'Anual', price: { formattedPrice: '$39.90', currency: 'ARS' }, period: { unit: 'year', number: 1 } } },
                    monthly: { identifier: '$rc_monthly', webBillingProduct: { title: 'Mensual', price: { formattedPrice: '$4.99', currency: 'ARS' }, period: { unit: 'month', number: 1 } } }
                }),
                purchase: () => {
                    calls.purchase++;
                    if (st === 'cancel') return Promise.reject(Object.assign(new Error('cancel'), { errorCode: 1 }));
                    if (st === 'no_redemption') return Promise.resolve({ customerInfo: { entitlements: { active: { 'brainy Pro': { isActive: true } } } }, redemptionInfo: null });
                    return Promise.resolve({ customerInfo: { entitlements: { active: { 'brainy Pro': { isActive: true } } } }, redemptionInfo: { redeemUrl: 'rc-stub://redeem_web_purchase?redemption_token=stubsecret' } });
                },
                classifyError: (err) => { const code = err && typeof err.errorCode === 'number' ? err.errorCode : null; return { kind: code === 1 ? 'cancel' : 'other', code, isCancel: code === 1 }; },
                redemptionUrlOf: (r) => (r && r.redemptionInfo ? (r.redemptionInfo.redeemUrl || r.redemptionInfo.redeemUrlRedirect || null) : null)
            };
            Object.defineProperty(window, 'BrainyRevenueCat', { configurable: true, get: () => svc, set: () => {} });
        }
    }, [key, extra, stub]);
    return { page, ctx, errs, analytics };
}

async function seed(page, st = STATE, step = 21) {
    await page.evaluate(([s, n]) => {
        localStorage.setItem('brainy_funnel_state', JSON.stringify(s));
        localStorage.setItem('brainy_funnel_step', String(n));
    }, [st, step]);
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

function stubCalls(page) {
    return page.evaluate(() => window.__RC_STUB_CALLS__ || null).catch(() => null);
}

(async () => {
    fs.rmSync(logPath, { force: true });
    const browser = await chromium.launch({ headless: true });

    // S1 WALK: onboarding completo desktop (backend demo, checkout bloqueado)
    try {
        const { page, errs } = await makePage(browser, { cfgExtra: { enableBackend: false } });
        await page.goto(BASE + '/funnel.html');
        await page.waitForTimeout(500);
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await page.waitForTimeout(800);
        const r = await walk(page);
        const stateObj = await page.evaluate(() => {
            const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
            const keys = ['q1_estado_actual', 'q2_dolor', 'q3_intentos_previos', 'q4_causa_fracaso', 'q5_identidad_futura', 'q6_area_prioritaria', 'q7_compromiso', 'q8_tiempo_disponible', 'q9_listo', 'q10_cuando_empezar'];
            return { step: parseInt(localStorage.getItem('brainy_funnel_step'), 10), answered: keys.filter((k) => k === 'q2_dolor' ? (Array.isArray(s[k]) && s[k].length > 0) : s[k] !== null && s[k] !== undefined).length, tasks: s.selectedTasks ? s.selectedTasks.length : 0, routines: s.selectedRoutines ? s.selectedRoutines.length : 0, clientPlanKey: !!s.clientPlanKey };
        });
        const cta = await page.evaluate(() => {
            const b = document.getElementById('purchaseBtn');
            return { hasBtn: !!b, disabled: !!(b && b.disabled), hasCard: !!document.querySelector('.plan-card') };
        });
        await page.screenshot({ path: path.join(ARTIFACTS, 'reg_walk.png'), fullPage: true }).catch(() => {});
        const ok = r && r.action === 'PAYWALL' && stateObj.step === 21 && stateObj.answered === 10 && stateObj.tasks >= 1 && stateObj.routines >= 1 && stateObj.clientPlanKey && cta.hasBtn && cta.hasCard && errs.length === 0;
        rec('WALK onboarding desktop -> paywall', ok, JSON.stringify({ r, stateObj, cta, errs }));
        await page.close();
    } catch (e) { rec('WALK onboarding desktop -> paywall', false, e.message); }

    // S2 PAY: pago completo sandbox real (backend real)
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
                    return { step: parseInt(localStorage.getItem('brainy_funnel_step'), 10), purchaseCompleted: !!s.purchaseCompleted, handoffReady: !!s.handoffReady, pendingRedemptionUrl: mask(s.pendingRedemptionUrl),
                             headline: document.querySelector('.card-head h1') ? document.querySelector('.card-head h1').textContent : null, hasSuccess: !!document.querySelector('.success-checks'), hasHandoff: !!(document.getElementById('openAppBtn') || document.getElementById('copyLinkBtn')) };
                });
                await page.screenshot({ path: path.join(ARTIFACTS, 'reg_pay.png'), fullPage: true }).catch(() => {});
                const aOk = analytics.some((l) => /purchase_success/.test(l) && /entitlementActive: true/.test(l));
                const ok = st.step === 22 && st.purchaseCompleted && st.handoffReady && st.hasSuccess && st.hasHandoff && errs.length === 0 && aOk;
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

    // S7 DEMO: backend demo -> checkout bloqueado por no haber plan real
    try {
        const { page, errs, analytics } = await makePage(browser, { cfgExtra: { enableBackend: false }, stub: 'entitled_ok' });
        await page.goto(BASE + '/funnel.html');
        await seed(page);
        await page.reload();
        await page.waitForTimeout(1000);
        const ui = await page.evaluate(() => {
            const b = document.getElementById('purchaseBtn');
            return { hasBtn: !!b, disabled: !!(b && b.disabled), text: b ? b.textContent.trim() : '', hasCard: !!document.querySelector('.plan-card') };
        });
        await page.click('#purchaseBtn').catch(() => {});
        await page.waitForTimeout(400);
        const calls = await stubCalls(page);
        const blocked = analytics.some((l) => /checkout_blocked_no_plan/.test(l));
        const ok = ui.hasBtn && ui.disabled && /demo mode/i.test(ui.text) && ui.hasCard && calls && calls.purchase === 0 && blocked && errs.length === 0;
        rec('DEMO checkout bloqueado (no real plan)', ok, JSON.stringify({ ui, calls, blocked, errs }));
        await page.close();
    } catch (e) { rec('DEMO checkout bloqueado (no real plan)', false, e.message); }

    // S8 NOPLAN: create-funnel-plan falla -> checkout bloqueado
    try {
        const { page, errs } = await makePage(browser, { cfgExtra: { enableBackend: true, createPlanUrl: 'http://127.0.0.1:9/none' }, stub: 'entitled_ok' });
        await page.goto(BASE + '/funnel.html');
        await seed(page, state({ planId: null, claimToken: null }));
        await page.reload();
        await page.waitForTimeout(1500);
        const ui = await page.evaluate(() => ({ recovery: !!document.querySelector('.paywall-recovery'), text: (document.body.innerText || '').slice(0, 300), buy: !!document.getElementById('purchaseBtn') }));
        const calls = await stubCalls(page);
        const ok = ui.recovery && /no pudimos preparar tu plan/i.test(ui.text) && calls && calls.purchase === 0 && errs.length === 0;
        rec('NOPLAN create-plan falla -> bloqueado', ok, JSON.stringify({ ui, calls, errs }));
        await page.close();
    } catch (e) { rec('NOPLAN create-plan falla -> bloqueado', false, e.message); }

    // S9 CANCEL: checkout cancelado -> vuelve al paywall, plan permanece
    try {
        const { page, errs } = await makePage(browser, { stub: 'cancel' });
        await page.goto(BASE + '/funnel.html');
        await seed(page);
        await page.reload();
        await page.waitForTimeout(1000);
        await page.click('#purchaseBtn');
        await page.waitForTimeout(900);
        const ui = await page.evaluate(() => {
            const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
            const b = document.getElementById('purchaseBtn');
            return { planId: s.planId, purchaseCompleted: !!s.purchaseCompleted, hasBtn: !!b, disabled: !!(b && b.disabled), hasCard: !!document.querySelector('.plan-card') };
        });
        const calls = await stubCalls(page);
        const ok = ui.planId === PLAN_ID && !ui.purchaseCompleted && ui.hasBtn && !ui.disabled && ui.hasCard && calls && calls.purchase === 1 && errs.length === 0;
        rec('CANCEL checkout cancelado -> paywall', ok, JSON.stringify({ ui, calls, errs }));
        await page.close();
    } catch (e) { rec('CANCEL checkout cancelado -> paywall', false, e.message); }

    // S10 NOREDEEM: purchase sin redemptionInfo -> recovery, sin segundo cobro
    try {
        const { page, errs, analytics } = await makePage(browser, { stub: 'no_redemption' });
        await page.goto(BASE + '/funnel.html');
        await seed(page);
        await page.reload();
        await page.waitForTimeout(1000);
        await page.click('#purchaseBtn');
        await page.waitForTimeout(900);
        const ui = await page.evaluate(() => {
            const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
            return { purchaseCompleted: !!s.purchaseCompleted, handoffReady: !!s.handoffReady, recovery: !!document.querySelector('.paywall-recovery'), text: (document.body.innerText || '').slice(0, 400), step: parseInt(localStorage.getItem('brainy_funnel_step'), 10) };
        });
        const recoveryTracked = analytics.some((l) => /handoff_recovery_required/.test(l));
        const ok = ui.purchaseCompleted === true && ui.handoffReady === false && ui.recovery && /no pudimos preparar el enlace/i.test(ui.text) && ui.step === 21 && recoveryTracked && errs.length === 0;
        rec('NOREDEEM sin redemption -> recovery', ok, JSON.stringify({ ui, recoveryTracked, errs }));
        await page.close();
    } catch (e) { rec('NOREDEEM sin redemption -> recovery', false, e.message); }

    // S11 REFRESH: refresh post-compra -> success sin recomprar
    try {
        const { page, errs } = await makePage(browser, { stub: 'entitled_ok' });
        await page.goto(BASE + '/funnel.html');
        await seed(page, SUCCESS_STATE, 22);
        await page.reload();
        await page.waitForTimeout(1200);
        const ui = await page.evaluate(() => ({ success: !!document.querySelector('.success-checks'), handoff: !!(document.getElementById('openAppBtn') || document.getElementById('copyLinkBtn')), buy: !!document.getElementById('purchaseBtn') }));
        const calls = await stubCalls(page);
        const ok = ui.success && ui.handoff && !ui.buy && calls && calls.purchase === 0 && errs.length === 0;
        rec('REFRESH post-compra -> success', ok, JSON.stringify({ ui, calls, errs }));
        await page.close();
    } catch (e) { rec('REFRESH post-compra -> success', false, e.message); }

    // S12 DEEPLINK: token + redeem_url + email URL-encoded
    try {
        const { page, errs } = await makePage(browser, { stub: 'entitled_ok' });
        await page.goto(BASE + '/funnel.html');
        await seed(page, SUCCESS_STATE, 22);
        await page.reload();
        await page.waitForTimeout(800);
        const link = await page.evaluate(() => (typeof window.buildClaimLink === 'function' ? window.buildClaimLink('rc-stub://redeem_web_purchase?redemption_token=stubsecret') : null));
        const checks = { link: maskText(link || ''), ok: false };
        if (link) {
            const u = new URL(link.replace(/^brainy:\/\//, 'https://'));
            const params = u.searchParams;
            checks.token = params.get('token') === CLAIM_TOKEN;
            checks.redeemUrl = params.get('redeem_url') === 'rc-stub://redeem_web_purchase?redemption_token=stubsecret';
            checks.email = params.get('email') === EMAIL;
            checks.encodedEmail = /email=sb%2Bcheckout%40brainyadhd\.com/.test(link);
            checks.encodedRedeem = /redeem_url=rc-stub%3A%2F%2F/.test(link);
            checks.ok = checks.token && checks.redeemUrl && checks.email && checks.encodedEmail && checks.encodedRedeem;
        }
        delete checks.link;
        rec('DEEPLINK token + redeem_url + email', checks.ok && errs.length === 0, JSON.stringify({ checks, errs }));
        await page.close();
    } catch (e) { rec('DEEPLINK token + redeem_url + email', false, e.message); }

    // S13 PAYLOAD: difficulty normalizada + counts + rangos
    try {
        const { page, errs } = await makePage(browser, { stub: 'entitled_ok' });
        await page.goto(BASE + '/funnel.html');
        const payloadState = state({
            selectedTasks: [
                { templateId: 't1', id: 't1', title: 'T1', emoji: '', difficulty: 'medium', subtasks: [{ title: 's1', duration: 10 }, { title: 's2' }] },
                { templateId: 't2', id: 't2', title: 'T2', emoji: '', difficulty: 'high', subtasks: [{ title: 's3', duration: null }] }
            ],
            selectedRoutines: [
                { templateId: 'r1', id: 'r1', name: 'R1', title: 'R1', icon: '', days: ['daily'], tasks: [{ title: 'a', position: 1 }] },
                { templateId: 'r2', id: 'r2', name: 'R2', title: 'R2', icon: '', days: ['daily'], tasks: [{ title: 'b', position: 1 }] }
            ]
        });
        await seed(page, payloadState, 23);
        await page.reload();
        await page.waitForTimeout(800);
        const p = await page.evaluate(() => (typeof window.buildUserPlanPayload === 'function' ? window.buildUserPlanPayload() : null));
        const diffs = p ? p.tasks.map((t) => t.difficulty) : [];
        const durations = p ? p.tasks.flatMap((t) => t.subtasks.map((s) => s.duration)) : [];
        const checks = {
            difficultyNeverMedium: diffs.length > 0 && diffs.every((d) => d !== 'medium') && diffs.every((d) => ['easy', 'moderate', 'hard'].includes(d)),
            durationsNumber: durations.length > 0 && durations.every((d) => typeof d === 'number' && d > 0),
            counts: !!p && p.metadata.tasksCount === p.tasks.length && p.metadata.routinesCount === p.routines.length && p.metadata.totalSelectedCount === (p.tasks.length + p.routines.length),
            tasksRange: !!p && p.tasks.length >= 1 && p.tasks.length <= 3,
            routinesRange: !!p && p.routines.length >= 1 && p.routines.length <= 5,
            eggCatalogId: !!p && p.routines.every((r) => typeof r.egg.catalogId === 'number' && r.egg.catalogId >= 1 && r.egg.catalogId <= 8),
            eggNoSlug: !!p && !/huevo_/.test(JSON.stringify(p.routines.map((r) => r.egg)))
        };
        const ok = Object.keys(checks).every((k) => checks[k]) && errs.length === 0;
        rec('PAYLOAD difficulty + counts + rangos', ok, JSON.stringify({ checks, diffs, durations, errs }));
        await page.close();
    } catch (e) { rec('PAYLOAD difficulty + counts + rangos', false, e.message); }

    // S14 EGG: catálogo canónico 1-8 (ids numéricos, nombres canónicos, sin slugs)
    try {
        const { page, errs } = await makePage(browser, { key: '' });
        await page.goto(BASE + '/funnel.html');
        await page.waitForTimeout(300);
        const info = await page.evaluate(() => {
            const cat = (typeof EGGS !== 'undefined') ? EGGS : [];
            return {
                ids: cat.map((e) => e.catalogId),
                names: cat.map((e) => e.name),
                types: cat.map((e) => typeof e.catalogId),
                hasSlug: cat.some((e) => typeof e.catalogId !== 'number' || String(e.catalogId).indexOf('huevo') !== -1)
            };
        });
        const canonical = ['Terra', 'Aqua', 'Flame', 'Storm', 'Leaf', 'Stone', 'Crystal', 'Shadow'];
        const checks = {
            eight: info.ids.length === 8,
            ids1to8: JSON.stringify(info.ids) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]),
            namesExact: JSON.stringify(info.names) === JSON.stringify(canonical),
            allNumeric: info.types.every((t) => t === 'number'),
            noSlug: !info.hasSlug
        };
        const ok = Object.keys(checks).every((k) => checks[k]) && errs.length === 0;
        rec('EGG catálogo canónico 1-8', ok, JSON.stringify({ checks, errs }));
        await page.close();
    } catch (e) { rec('EGG catálogo canónico 1-8', false, e.message); }

    // S15 EGG: 1 rutina = 1 huevo, hasta 5 distintas, payload numérico y display
    try {
        const { page, errs } = await makePage(browser, { key: '' });
        await page.goto(BASE + '/funnel.html');
        const mkRoutines = (n) => Array.from({ length: n }, (_, i) => ({
            templateId: 'rt' + i, id: 'rt' + i, name: 'R' + i, title: 'R' + i, icon: '', days: ['daily'], tasks: [{ title: 't', position: 1 }]
        }));

        // 1 rutina -> 1 huevo
        await seed(page, state({ selectedRoutines: mkRoutines(1), assignedRoutines: [] }), 21);
        await page.reload();
        await page.waitForTimeout(500);
        const one = await page.evaluate(() => ({ assigned: assignedRoutines(), payload: buildUserPlanPayload() }));

        // 5 rutinas -> 5 huevos distintos
        await seed(page, state({ selectedRoutines: mkRoutines(5), assignedRoutines: [] }), 21);
        await page.reload();
        await page.waitForTimeout(500);
        const five = await page.evaluate(() => ({ assigned: assignedRoutines(), payload: buildUserPlanPayload() }));

        // display: el resumen muestra el mismo huevo asignado
        const shownStep = await page.evaluate(() => {
            const idx = stepList().findIndex((s) => s.type === 'plan_summary');
            localStorage.setItem('brainy_funnel_step', String(idx));
            return idx;
        });
        await page.reload();
        await page.waitForTimeout(700);
        const display = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.plan-row')).filter((r) => r.querySelector('.plan-egg'));
            const names = rows.map((r) => (r.querySelector('.plan-name').textContent || '').split('—')[0].trim());
            return { names, bodyHasInvented: /Nebulosa|Solar|Océano|Bosque|Cielo|Lava|Flor|Estrella/.test(document.body.innerText) };
        });

        // slugs legacy en localStorage -> se normalizan a ids numéricos
        const legacySlugs = ['huevo_nebulosa', 'huevo_solar', 'huevo_oceano', 'huevo_bosque', 'huevo_cielo'];
        await page.evaluate(([rs, slugs]) => {
            const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
            s.selectedRoutines = rs;
            s.assignedRoutines = slugs.map((sl) => ({ catalogId: sl, name: sl, emoji: 'x', color: '#000' }));
            localStorage.setItem('brainy_funnel_state', JSON.stringify(s));
        }, [mkRoutines(5), legacySlugs]);
        await page.reload();
        await page.waitForTimeout(500);
        const legacy = await page.evaluate(() => ({ assigned: assignedRoutines(), payload: buildUserPlanPayload() }));

        const canonical = ['Terra', 'Aqua', 'Flame', 'Storm', 'Leaf', 'Stone', 'Crystal', 'Shadow'];
        const payloadIds = five.payload.routines.map((r) => r.egg.catalogId);
        const checks = {
            oneRoutineOneEgg: one.assigned.length === 1 && one.payload.routines.length === 1,
            oneNumeric: one.assigned.every((a) => typeof a.catalogId === 'number' && a.catalogId >= 1 && a.catalogId <= 8) && one.payload.routines.every((r) => typeof r.egg.catalogId === 'number'),
            fiveCount: five.assigned.length === 5 && five.payload.routines.length === 5,
            fiveDistinct: new Set(five.assigned.map((a) => a.catalogId)).size === 5,
            payloadNumeric: payloadIds.length === 5 && payloadIds.every((x) => typeof x === 'number' && x >= 1 && x <= 8),
            payloadNoSlug: !/huevo_/.test(JSON.stringify(five.payload)),
            namesMatchIds: five.assigned.every((a) => canonical[a.catalogId - 1] === a.name),
            displayMatches: display.names.length === 5 && display.names.every((n, i) => n === five.assigned[i].name),
            noInventedDisplay: !display.bodyHasInvented,
            legacyNormalized: legacy.assigned.length === 5 && legacy.assigned.every((a) => typeof a.catalogId === 'number') && legacy.assigned.every((a) => canonical.includes(a.name)),
            legacyPayloadNumeric: legacy.payload.routines.every((r) => typeof r.egg.catalogId === 'number') && !/huevo_/.test(JSON.stringify(legacy.payload))
        };
        const ok = Object.keys(checks).every((k) => checks[k]) && errs.length === 0;
        rec('EGG 1:1 + distintas + payload numérico + display', ok, JSON.stringify({ checks, shownStep, errs }));
        await page.close();
    } catch (e) { rec('EGG 1:1 + distintas + payload numérico + display', false, e.message); }

    await browser.close();
    const fails = results.filter((r) => !r.ok);
    console.log('\nRESUMEN: ' + (results.length - fails.length) + '/' + results.length + ' ok');
    process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });
