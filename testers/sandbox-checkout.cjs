// Checkout sandbox real de RevenueCat Web Billing (Playwright + Chromium headless).
//
// A diferencia de test:e2e:funnel (que usa un plan ficticio "sb-plan-test"),
// este script deja que el propio funnel CREE un plan REAL en web_funnel_plans
// (via create-funnel-plan) y luego ejecuta el checkout anual sandbox completo.
//
// Prerequisitos:
//   - Servir el sitio en http://localhost:8000 (ej: python3 -m http.server 8000)
//   - node_modules con playwright + navegador chromium instalado
//
// Run:
//   npm run test:e2e:sandbox
//
// Config por env (opcional):
//   FUNNEL_BASE_URL  -> http://localhost:8000 (default)
//   FUNNEL_RC_KEY    -> key de sandbox RevenueCat Web Billing (default la key publica sandbox)
//
// Seguridad: nunca se imprimen emails, claim/redeem tokens, hashes,
// JWTs, URLs de redemption completas ni keys. El redemption URL se reduce
// a su esquema; los tokens a "[redacted]".

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.FUNNEL_BASE_URL || 'http://localhost:8000';
const KEY = process.env.FUNNEL_RC_KEY || 'strp_sb_mozjaozAfCdAQiBTzzSUnwQD';
const ARTIFACTS = path.join(__dirname, '.e2e-artifacts');

const EMAIL = 'sb+checkout-' + Date.now() + '@brainyadhd.com';

// planId/claimToken null -> el funnel llama a ensurePlan() (create-funnel-plan real).
const STATE = {
    q1_estado_actual: 'a', q2_dolor: ['b'], q3_intentos_previos: 'c', q4_causa_fracaso: 'd', q5_identidad_futura: 'e',
    q6_area_prioritaria: 'f', q7_compromiso: 'g', q8_tiempo_disponible: 'h', q9_listo: 'i', q10_cuando_empezar: 'j',
    edad: 25, email: EMAIL,
    selectedTasks: [{ templateId: 't', id: 't1', title: 'T', emoji: '', subtasks: [{ title: 'P', duration: 5 }] }],
    selectedRoutines: [{ templateId: 'r', id: 'r1', name: 'R', title: 'R', icon: '', tasks: [{ title: 'T', position: 1 }], subtasks: [{ title: 'T', duration: null }] }],
    assignedRoutines: [], emailSubmitted: true,
    planId: null, claimToken: null, clientPlanKey: crypto.randomUUID(),
    purchaseCompleted: false, redemptionPersisted: false, handoffReady: false, selectedPackageId: null, pendingRedemptionUrl: null
};

function state(overrides) {
    return Object.assign({}, JSON.parse(JSON.stringify(STATE)), overrides || {});
}

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

function schemeOf(u) {
    if (typeof u !== 'string') return null;
    const m = /^([a-z][a-z0-9+.\-]*):\/\//i.exec(u.trim());
    return m ? m[1].toLowerCase() : null;
}

fs.mkdirSync(ARTIFACTS, { recursive: true });
const logPath = path.join(ARTIFACTS, 'sandbox_checkout.log');
const log = (...x) => fs.appendFileSync(logPath, x.join(' ') + '\n');

async function makePage(browser) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'es-AR' });
    const page = await ctx.newPage();
    const errs = [];
    const analytics = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
    page.on('console', (m) => { const t = m.text(); if (/funnel-analytics|purchase_success|handoff/.test(t)) analytics.push(t.slice(0, 240)); });
    page.setDefaultTimeout(20000);
    await page.addInitScript(([k]) => {
        window.__BRAINY_FUNNEL_CONFIG__ = Object.assign(window.__BRAINY_FUNNEL_CONFIG__ || {}, {
            revenuecatWebApiKey: k,
            revenuecatOfferingId: 'web_default',
            revenuecatEntitlementId: 'brainy Pro'
        });
    }, [KEY]);
    return { page, ctx, errs, analytics };
}

async function seed(page, st = STATE, step = 21) {
    await page.evaluate(([s, n]) => {
        localStorage.setItem('brainy_funnel_state', JSON.stringify(s));
        localStorage.setItem('brainy_funnel_step', String(n));
    }, [st, step]);
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
    await inner.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => /Comenzar prueba|Probar|Pagar|Suscribir|Start|Subscribe|Pay now/i.test(x.textContent || '') && !x.disabled);
        if (b) b.click();
    });
    log('SUBMIT intentado');
    const t0 = Date.now();
    while (Date.now() - t0 < 150000) {
        await page.waitForTimeout(1200);
        const done = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}'); return !!s.purchaseCompleted; }).catch(() => false);
        if (done) return { ok: true, after: 'done' };
        const ready = await page.evaluate(() => Array.from(document.querySelectorAll('button')).some((b) => /continuar/i.test((b.textContent || '')))).catch(() => false);
        if (ready) {
            const cl = await continueClick(page);
            if (cl) return { ok: true, after: 'continue-clicked' };
        }
    }
    return { ok: false, after: 'timeout' };
}

(async () => {
    fs.rmSync(logPath, { force: true });
    const report = { keyInjected: !!KEY, keyLength: KEY ? KEY.length : 0 };
    const browser = await chromium.launch({ headless: true });
    const { page, errs, analytics } = await makePage(browser);

    await page.goto(BASE + '/funnel.html');
    await seed(page, STATE, 21);
    await page.reload();

    // 1) esperar a que el funnel cree el plan real (ensurePlan) y habilite el botón
    const planOk = await page.waitForFunction(() => {
        const b = document.getElementById('purchaseBtn');
        return !!b && !b.disabled;
    }, null, { timeout: 45000 }).then(() => true).catch(() => false);

    const plan = await page.evaluate(() => {
        const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
        const isDemo = (v) => !v || String(v).startsWith('demo-') || String(v).startsWith('pending');
        return {
            planId: s.planId || null,
            hasClaimToken: !!s.claimToken,
            planReal: !!s.planId && !!s.claimToken && !isDemo(s.planId) && !isDemo(s.claimToken),
            hasClientPlanKey: !!s.clientPlanKey,
            source: s.planSource || null
        };
    });
    report.plan = plan;

    // 2) oferta anual: seleccionarla si no lo está y describir periodo/precio/trial
    const offering = await page.evaluate(async () => {
        const out = { available: false, annual: null, monthly: null, error: null };
        try {
            const svc = window.BrainyRevenueCat;
            if (!svc || !svc.getOfferings) { out.error = 'svc no disponible'; return out; }
            const off = await svc.getOfferings('web_default');
            if (!off) { out.error = 'sin offering'; return out; }
            const describe = (pkg) => {
                if (!pkg) return null;
                const p = pkg.webBillingProduct || {};
                const price = p.price || {};
                const period = p.period || {};
                const trial = Object.keys(p).some((k) => /trial|free/i.test(k) && p[k]);
                const phaseTrial = Array.isArray(p.subscriptionOptions)
                    ? p.subscriptionOptions.some((o) => /trial|free/i.test(JSON.stringify(o && o.trial ? o.trial : {})))
                    : false;
                return {
                    identifier: pkg.identifier,
                    title: p.title || null,
                    period: period.unit ? (period.number > 1 ? period.number + ' ' + period.unit : period.unit) : null,
                    price: price.formattedPrice || null,
                    hasTrialSignal: !!(trial || phaseTrial)
                };
            };
            out.available = true;
            out.annual = describe(off.annual);
            out.monthly = describe(off.monthly);
            return out;
        } catch (e) { out.error = String((e && e.message) || e).slice(0, 160); return out; }
    });
    report.offering = offering;

    const annualSelected = await page.evaluate(() => {
        const b = document.querySelector('.plan-card[data-pkg="$rc_annual"]');
        if (b && !b.classList.contains('selected')) { b.click(); return 'clicked'; }
        if (b) return 'already';
        return 'absent';
    });
    report.annualSelected = annualSelected;

    // 3) checkout sandbox real
    await page.click('#purchaseBtn');
    const inner = await payModalFlow(page);
    if (!inner) {
        report.purchaseResolved = false;
        report.error = 'modal checkout no abrió';
    } else {
        const payRes = await payWithCard(page, inner);
        await page.waitForFunction(() => {
            const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
            return !!s.redemptionPersisted || !!s.handoffReady || !!document.querySelector('.paywall-recovery');
        }, null, { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(500);
        report.purchaseResolved = !!payRes.ok;
        report.payAfter = payRes.after;

        // 4) recolección sin secretos
        report.state = await page.evaluate(() => {
            const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
            const u = s.pendingRedemptionUrl || null;
            return {
                step: parseInt(localStorage.getItem('brainy_funnel_step'), 10),
                purchaseCompleted: !!s.purchaseCompleted,
                redemptionPersisted: !!s.redemptionPersisted,
                handoffReady: !!s.handoffReady,
                redemptionInfoPresent: !!u,
                redemptionUrlPresent: !!u,
                redemptionScheme: /^([a-z][a-z0-9+.\-]*):\/\//i.exec(String(u || '').trim()) ? (/^([a-z][a-z0-9+.\-]*):\/\//i.exec(String(u || '').trim()))[1].toLowerCase() : null,
                headline: document.querySelector('.card-head h1') ? document.querySelector('.card-head h1').textContent : null,
                hasSuccess: !!document.querySelector('.success-checks'),
                hasHandoff: !!(document.getElementById('openAppBtn') || document.getElementById('copyLinkBtn'))
            };
        });

        report.payload = await page.evaluate(() => {
            const p = typeof window.buildUserPlanPayload === 'function' ? buildUserPlanPayload() : null;
            if (!p) return null;
            return {
                hasTasks: Array.isArray(p.tasks),
                tasks: p.tasks.map((t) => ({ title: t.title, duration: (t.subtasks || [])[0] ? (t.subtasks)[0].duration : null })),
                routines: p.routines.map((r) => ({
                    name: r.name,
                    steps: (r.steps || []).map((s) => ({ title: s.title, duration: s.duration })),
                    hasSteps: Array.isArray(r.steps) && r.steps.length > 0,
                    noTasks: !('tasks' in r),
                    eggCatalogId: r.egg && r.egg.catalogId
                }))
            };
        });
        report.redemptionScheme = await page.evaluate(() => {
            const s = JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}');
            const m = /^([a-z][a-z0-9+.\-]*):\/\//i.exec(String(s.pendingRedemptionUrl || '').trim());
            return m ? m[1].toLowerCase() : null;
        });

        report.entitlement = await page.evaluate(async () => {
            const out = { active: null, periodType: null, id: null, error: null };
            try {
                const inst = window.Purchases && window.Purchases.Purchases && window.Purchases.Purchases.instance;
                if (!inst || !inst.getCustomerInfo) { out.error = 'cliente RC no disponible'; return out; }
                const ci = await inst.getCustomerInfo();
                const ent = ci && ci.entitlements && ci.entitlements.active ? ci.entitlements.active['brainy Pro'] : null;
                out.id = 'brainy Pro';
                out.active = !!(ent && ent.isActive);
                out.periodType = ent ? (ent.periodType || null) : null;
                return out;
            } catch (e) { out.error = String((e && e.message) || e).slice(0, 160); return out; }
        });

        report.analytics = analytics.map((l) => maskText(l))
            .filter((l) => /purchase_success|handoff_ready|handoff_recovery|redemption_persisted|redemption_persist_failed|purchase_failed|checkout_cancelled|plan_created/.test(l));
        report.hasPurchaseSuccess = report.analytics.some((l) => /purchase_success/.test(l));
        report.hasRedemptionPersisted = report.analytics.some((l) => /redemption_persisted/.test(l));
        report.errs = errs.length;
    }

    await page.screenshot({ path: path.join(ARTIFACTS, 'sandbox_checkout.png'), fullPage: true }).catch(() => {});

    // 5) verificación server-side (requiere SUPABASE_SERVICE_ROLE_KEY; opcional)
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const planId = report.plan && report.plan.planId ? report.plan.planId : null;
        if (planId) {
            try {
                const res = await fetch(`${process.env.SUPABASE_URL || 'https://auth.brainyadhd.com'}/rest/v1/web_funnel_plans?id=eq.${planId}&select=id,status,claimed_by_user_id,revenuecat_redemption_url,plan`, {
                    headers: {
                        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
                        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
                    }
                });
                const text = await res.text();
                report.serverSide = { http: res.status, ok: res.ok };
                if (res.ok && text) {
                    const row = JSON.parse(text)[0];
                    if (row) {
                        report.serverSide.row = {
                            status: row.status,
                            claimedByUserId: row.claimed_by_user_id,
                            revenuecatRedemptionUrlNotNull: !!row.revenuecat_redemption_url,
                            revenuecatRedemptionUrlScheme: schemeOf(row.revenuecat_redemption_url),
                            planRoutinesSteps: Array.isArray(row.plan && row.plan.routines) ? row.plan.routines.map((r) => ({ name: r.name, steps: (r.steps || []).length, hasTasks: 'tasks' in r })) : null
                        };
                    } else {
                        report.serverSide.row = null;
                    }
                }
            } catch (e) {
                report.serverSide = { error: String((e && e.message) || e).slice(0, 160) };
            }
        } else {
            report.serverSide = { skipped: 'sin planId' };
        }
    } else {
        report.serverSide = { skipped: 'SUPABASE_SERVICE_ROLE_KEY no definida (usá env para verificar la fila)' };
    }

    console.log('\n===== SANDBOX CHECKOUT REPORT =====');
    console.log(JSON.stringify(report, null, 2));
    console.log('===================================');

    const ok = report.plan && report.plan.planReal && report.purchaseResolved && report.state
        && report.state.purchaseCompleted && report.state.redemptionPersisted && report.state.handoffReady
        && report.state.redemptionUrlPresent && report.hasPurchaseSuccess && report.hasRedemptionPersisted && report.errs === 0;
    console.log('RESULT: ' + (ok ? 'OK (sandbox checkout completo con plan real)' : 'INCOMPLETO/REVISAR'));
    await browser.close();
    process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL:', maskText(e && e.message)); process.exit(2); });
