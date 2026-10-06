# TODO — Pipeline web-to-app de Brainy (funnel)

Estado actual: flujo completo (instalado + guardado de plan) certificado en 127/127 e2e + 15/15 backend-mode + 4/4 mobile.
Monetización RevenueCat web implementada y testada (51/51 en `paywall_test.js`), esperando configuración externa (RC Web API key + Stripe Billing) para sandbox.
Todo lo de abajo requiere decisiones/información del equipo o la app.

## 1. Supabase ✅

- [x] Project-ref: `wdqwqgfisiteswbbdurg` (smartlist-backend).
- [x] Anon key y URL pegadas en `FUNNEL_CONFIG` (funnel.html).
- [x] **Tabla canónica `public.web_funnel_plans`** aplicada por el equipo de backend/app (source of truth). La legacy `public.funnel_plans` queda intacta y fuera de uso.
- [x] Migraciones locales retiradas a `supabase/superseded/` (este repo web **no** crea ni aplica migraciones).
- [x] `create-funnel-plan/index.ts` reescrito para `web_funnel_plans` (status `pending`, `version 1`, `claim_token_hash`, `client_plan_key`, `expires_at` +7d; idempotencia por `client_plan_key`).
- [ ] **Deploy** de `create-funnel-plan` (la versión en producción todavía apunta a `funnel_plans` legacy / token en texto plano).
- [ ] Prueba de creación real contra `web_funnel_plans` (script `testers/create-plan-regression.cjs`, escenarios A–H).
- [x] `enableBackend: true` en `FUNNEL_CONFIG`.
- [x] Tests front: 13/13 e2e.

Contrato de la EF (ya se envía desde el front):
```json
POST {plan, client_plan_key, email, marketing_opt_in, source: "website", campaign: "brainy_onboarding_v1"}
→ 200 { planId, claimToken }             # claimToken solo una vez
→ 409 plan_expired | plan_already_claiming | plan_already_claimed
→ 400 invalid_client_plan_key
```

## 2. Huevos → contrato con la app

Resuelto: el backend confirmó los 8 huevos **common** canónicos (`egg_catalog.id`
numérico 1–8). El funnel usa esa lista como fuente de verdad y ya no envía slugs.

```json
"egg": { "catalogId": 6 }   // número, siempre 1–8
```

| id | nombre |
| -- | ------ |
| 1  | Terra  |
| 2  | Aqua   |
| 3  | Flame  |
| 4  | Storm  |
| 5  | Leaf   |
| 6  | Stone  |
| 7  | Crystal|
| 8  | Shadow |

- [x] Funnel alineado al catálogo canónico (1 rutina = 1 huevo; hasta 5 distintos; slug legacy `huevo_*` solo se normaliza en `localStorage`, nunca viaja).
- [ ] Verificar de punta a punta que `funnel_plans.plan.routines[].egg.catalogId` llega a la app y resuelve el asset local.

## 3. App Store links

- [ ] Completar `iosStoreUrl` y `androidStoreUrl` en `FUNNEL_CONFIG`.
  - Hasta que no estén, los botones de tiendas **no se muestran** en el handoff.
- [ ] Confirmar el deep link `brainy://claim?token=...` está registrado en la app (ASWebAuthenticationURLs/App Links) antes de depender de él.

## 4. Analytics

Hoy hay un tracker liviano (cola `window.brainyAnalyticsQueue` + `navigator.sendBeacon` opcional).

- [ ] Elegir plataforma (PostHog / Firebase Analytics / etc.).
- [ ] Completar `analyticsEndpoint` o conectar el SDK en `track()`.
- [ ] Definir si se envían los eventos de la cola a un proxy propio.

## 5. Envío por email

> Verificado por el equipo el 2026-10-05: el correo de confirmación **funciona**
> y no está en este repo (rama aparte). Acá no hay backend de email ni cliente
> SMTP/Resend/SendGrid: el paso `contact` solo valida y guarda el email, y la
> Edge Function `create-funnel-plan` lo persiste como columna.

Lo que sí vive en este repo:

- `contact` valida el formato del email, lo guarda en `funnelState` y dispara
  `ensurePlan()` → `create-funnel-plan` con `{plan, email, marketing_opt_in,
  source, campaign, client_plan_key}`.
- El `claimToken` que se usa para el deep link se genera ahí y se muestra en
  `handoff`.

- [ ] Si se documenta el flujo para el equipo, dejar escrito dónde vive el envío
  (rama o servicio) para que no se vuelva a buscar en este repo.

## 6. Autenticación/claim del token

- [ ] Confirmar cómo la app consume `claimToken` al abrir `brainy://claim?token=...`.
- [ ] Definir expiración/invalidación del token tras integrar el plan.

## 7. Testing / A/B (opcional pero recomendable)

- [ ] Habilitar/metodología para A/B de:
  - `FUNNEL_EXPERIMENTS.interactivePreview` (preview interactivo vs estático).
  - `FUNNEL_EXPERIMENTS.showPrePaywall` (pre-paywall antes del paywall).
  - `FUNNEL_EXPERIMENTS.webCheckout` (paywall web abierto vs handoff sin checkout).
- [ ] Validar visual en 320–430px (mobile-first) y desktop.
- [ ] Extender el árbol de tests e2e para los experimentos apagados.

## 8. Monetización web — RevenueCat Web SDK + Stripe Billing (en curso) 🚧

Implementado en `funnel.html` + `assets/` (sin librería Stripe, sin claves privadas, sin isPro creado desde el web):

- [x] `@revenuecat/purchases-js@1.60.1` instalado y **self-hosted** en `assets/revenuecat-sdk.js` (build UMD).
- [x] Servicio `assets/revenuecat.js` → `window.BrainyRevenueCat`: anonymousId persistido (`brainy_rc_anonymous_id`), `configure()` una sola vez, `getOfferings(offeringId)`, `purchase()` con locales `es`, `isEntitledTo('brainy Pro')`, clasificación de errores (cancel/network/other), `redemptionUrlOf()`.
- [x] QR self-hosted (`assets/qrcode.min.js`, Kazuhiko Arase MIT) para el handoff desktop.
- [x] Steps nuevos: `contact → prepaywall → paywall → success → handoff` (paywall/success se filtran si `webCheckout:false`).
- [x] Precios reales vía `getOfferings()` / `webBillingProduct.price.formattedPrice` (+ `period`), anual+mensual si existen, badge "Recomendado" solo en anual. Nunca se inventan montos/descuentos.
- [x] Plan guardado ANTES del checkout (`ensurePlan()`), `claimToken` requerido; recompra bloqueada tras `purchaseCompleted`.
- [x] Estructura real del SDK 1.60.1 documentada: `PurchaseResult { customerInfo, redemptionInfo, operationSessionId, storeTransaction, customerEmail? }`, `RedemptionInfo { redeemUrl: string|null, redeemUrlRedirect?: string|null }`.
- [x] Deep link único: `brainy://claim?token=<CLAIM>&redeem_url=<encodeURIComponent(redemUrl)>` (buildClaimLink siempre usa `encodeURIComponent`).
- [x] Analytics seguros: `paywall_view, package_selected, checkout_start, checkout_cancelled, purchase_success, purchase_failed, purchase_handoff_view, purchase_handoff_click` — nunca email/claimToken/redeem URL.
- [x] **Verificación empírica de la sandbox key** (`strp_sb_mozjaozAfCdAQiBTzzSUnwQD`): probada con el SDK real vía `getOfferings()` → devuelve offering `web_default` ("Brainy Web") con `$rc_annual` ($39.90, trial 1 semana) y `$rc_monthly` ($4.99), precios Stripe (`price_1UF2SKIJoWpohQw96zbvShx3`). **El prefijo `strp_sb_` ES el formato público Web Billing 2026** (no es secret de Stripe). Guard re-ajustado: `strp_` ya no se bloquea; se bloquean `sk_/rk_/rp_/whsec_/tok_/req_` + patrones secret/restricted. `purchase()` requiere browser (abre checkout hosted de Stripe) → validado hasta getOffering en node; el pago E2E queda para browser con tarjeta sandbox.
- [x] Tests jsdom nuevos: `paywall_test.js` **65/65** (flujo pago éxito desktop/mobile, cancel, sin offering, entitlement inactiva, encoding deep link, no leak de tokens, `sk_test_`/`rk_` rechazadas, `rcb_sb_`/`strp_sb_` habilitan paywall). Suites previas: 127/127 + 15/15 + 4/4.

Pendiente de configuración externa (bloquea test sandbox/dinero real):

> Estado al cierre de esta sesión (2026-10-05): **el código de monetización está
> completo y testeado** (65/65 `paywall_test.js`, 127/127 e2e, 25/25 paywall,
> 4/4 revenuecat-metadata). No queda trabajo de frontend en este repo: todo lo que
> sigue es configuración en dashboards externos y código en la app móvil.

Orden sugerido para producción:

1. [ ] **RevenueCat**: conectar Stripe Web Billing, importar productos, configurar
   el offering `web_default` (FUNNEL_CONFIG.revenuecatOfferingId) con anual +
   mensual.
2. [ ] **Vincular los productos al entitlement exacto `brainy Pro`**
   (FUNNEL_CONFIG.revenuecatEntitlementId). Ojo: string exacto, con espacio y
   mayúscula.
3. [ ] **Activar Redemption Links.** Sin esto `redemptionInfo.redeemUrl` llega
   `null` y el deep link `brainy://claim?...` queda incompleto. Es el paso que
   más se olvida.
4. [ ] **App móvil**: manejar `brainy://claim?token=...&redeem_url=...` con el
   flujo `Purchases.logIn` → `parseAsWebPurchaseRedemption` → `redeemWebPurchase`
   → `claim-funnel-plan` → check `brainy Pro`. Si esto falta, el usuario paga y
   no puede vincular su plan.
5. [ ] **Cambiar la key** de `strp_sb_...` (sandbox) a `strp_...` (producción)
   en el bloque `window.__BRAINY_FUNNEL_CONFIG__` de `funnel.html`, y borrar el
   comentario de SANDBOX que la acompaña.
6. [ ] Completar placeholders vacíos que hoy ocultan funcionalidad:
   `revenuecatTermsUrl` (sin él el paywall no tiene footer legal),
   `iosStoreUrl` y `androidStoreUrl` (sin ellos no aparecen los botones de
   tienda).
7. [ ] Test sandbox completo: mensual/anual, checkout complete/cancel/error,
   refresh antes/después de pagar, doble click, sin offering, entitlement,
   redemptionInfo, encoding deep link, iPhone/Android/desktop+QR.

La key sandbox `strp_sb_mozjaozAfCdAQiBTzzSUnwQD` **ya está inyectada** en el
HTML vía `__BRAINY_FUNNEL_CONFIG__` (no hardcodeada en `FUNNEL_CONFIG`), así que
el paso 5 es únicamente reemplazarla por la de producción.

## Documentación del proyecto web

- [ ] Unificar config: los placeholders viven solo en `FUNNEL_CONFIG` (no hardcodear credenciales ni URLs en otro lado).

## Pantallas del funnel (rama `feat/funnel-ui-redesign`)

Contenido de producto de las pantallas intermedias, a julio del 2026-10-05.

### `interstitial_3` — sistema de huevos y mascotas

Reemplaza la pantalla de "curvas". Explica que cada hábito puede tener una mascota,
que empieza como huevo y desbloquea su primera evolución tras 3 días completados.

- Bloques: eyebrow + título + descripción → preview de un huevo con medidor
  ilustrativo de 3 segmentos → galería de los 8 huevos → 3 pasos explicativos →
  tarjeta "Why Brainy uses this" → CTA.
- `BRAINY_EGG_SHOWCASE` se **deriva de `EGGS`**: una sola fuente de verdad, sin
  duplicar rutas de imágenes.
- La galería es informativa: tocar un huevo cambia solo el preview, no escribe en
  `funnelState`, `localStorage`, payload ni backend. La selección vive en memoria
  mientras la pantalla está montada y no preasigna mascota.
- El medidor de 3 días lleva `aria-label` descriptivo y **no** usa
  `role="progressbar"` (sería progreso real del usuario).
- Assets: `assets/eggs/eggfinal1..8.png`. **Estaban sin trackear**: sin
  `git add` la pantalla se rompe en producción.
- Tests: `npm run test:interstitial-3` (30 checks).

### `task_select` / `routine_select` — selector por categorías

Estructura de tres niveles: categoría (card de color suave, plegable) → tarea
(fila que selecciona) → pasos (chevron que despliega).

- Tocar la fila **selecciona**; el chevron **despliega** los pasos. Son
  controles hermanos, no anidados: un `<button>` dentro de otro es HTML inválido
  y rompe teclado y lectores de pantalla.
- Desplegar no modifica el estado ni el payload.
- En mobile la galería es un carril con scroll-snap; en desktop, grid centrado.

### Localización

- Los JSON de tareas y rutinas son **bilingües** (`title`/`title_en`,
  `name`/`name_en`, `why`/`why_en`). `pickLocaleField()` resuelve en render y en
  el payload, así que la app recibe los pasos ya traducidos.
- **No hay diccionarios de traducción duplicados en el código**: se eliminaron
  `TASK_TITLE_EN` y `ROUTINE_NAME_EN`.
- Copy pendiente de revisar: `nq24` menciona "MellowFlow" (marca de la
  referencia). `good-hands-regression` lo prohíbe explícitamente, pero
  `funnel-ui-regression` congela el copy de preguntas contra `main`. Hay que
  decidir cuál de los dos se actualiza.

### Tests y regresiones conocidas

| Suite | Estado | Nota |
| --- | --- | --- |
| `test:interstitial-3` | 30/30 | |
| `test:science-screens` | 17/17 | |
| `test:profile-diagnosis` | 24/24 | |
| `test:good-hands` | 12/12 | |
| `test:plan-loading-screen` | 14/14 | |
| `test:funnel-payload` | ok | |
| `test:paywall` | 25/25 | |
| `test:funnel-ui` | **8/13** | 4 fallos preexistentes; uno compara intersticiales contra `main` y contradice el rediseño de `interstitial_3` |
| `test:not-alone` | **16/17** | `11c` asume que la foto de avatar es configurable; hoy están fijas |
| `test:plan-loading` | **30/33** | asserts de vecindad de `task_select`/`routine_select` |

### Pendientes de la auditoría

- [ ] `nq24`: quitar la marca MellowFlow (decidir el check a actualizar).
- [ ] `funnel.html:8399`: el botón de paywall queda en español si el usuario
  **cancela** la compra; las otras dos ramas sí traducen.
- [ ] `renderSuccess` (8549) tiene "Abrir Brainy →" hardcodeado en español,
  mientras `renderHandoff` (8626) usa `step.cta`. Ambos duplican el markup de
  handoff con los mismos IDs y texto desktop distinto.
- [ ] `.mini-step-card--break-down` no tiene regla CSS: cae al estilo por defecto
  (sus hermanos `--next-move` y `--momentum` sí lo tienen).
- [ ] Métrica nueva `messages_sent` (tarea `responder_mensaje_pendiente`): si la
  app no la reconoce, esa tarea no se puede medir.
- [ ] Limpiar assets sin uso (~2.9 MB): `brainyOverwhelmed.png`,
  `brainyPhone.png`, `icon-brain.svg`, `icon-focus.svg`, `icon-mobile.svg`,
  carpeta `not_alone_characters/`.
- [ ] Código muerto: `petStageHtml`, `PET_SVG`, `taskCategoryFor`, `priceText`,
  `todayLabel`, `PLAN_LOADING_PHASES`, 16 claves de `UI_COPY`, 17 reglas CSS
  (`.btn-primary` es byte-idéntico a `.btn-dopamine`), y las formas-placeholder
  de `profile_diagnosis` que se emiten pero siempre se ocultan con
  `display: none`.