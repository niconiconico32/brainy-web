# TODO — Pipeline web-to-app de Brainy (funnel)

Estado actual: flujo completo (instalado + guardado de plan) certificado en 127/127 e2e + 15/15 backend-mode + 4/4 mobile.
Monetización RevenueCat web implementada y testada (51/51 en `paywall_test.js`), esperando configuración externa (RC Web API key + Stripe Billing) para sandbox.
Todo lo de abajo requiere decisiones/información del equipo o la app.

## 1. Supabase ✅

- [x] Project-ref: `wdqwqgfisiteswbbdurg` (smartlist-backend).
- [x] Anon key y URL pegadas en `FUNNEL_CONFIG` (funnel.html).
- [x] Edge Function `create-funnel-plan` deployada.
- [x] Migración aplicada (tabla `funnel_plans` + trigger `brainy_set_updated_at` + RLS). Aplicada manualmente en el SQL Editor.
- [x] Endpoint probado en vivo: crea `{ planId, claimToken }` y es idempotente por email (<24h) — testeado con curl (HTTP 200).
- [x] `enableBackend: true` en `FUNNEL_CONFIG`.
- [x] Tests con backend activo: 127/127 e2e, 15/15 backend-mode, 4/4 mobile.

Contrato de la EF (ya se envía desde el front):
```json
POST {plan, email, marketing_opt_in, source: "website", campaign: "brainy_onboarding_v1"}
→ 200 { planId, claimToken }
```

## 2. Huevos → contrato con la app

Decisión: **no hace falta `egg_catalog` compartido.** El funnel pasa la identidad del huevo en el payload y la app valida contra su catálogo local/usando sus assets.

Lo que ya viaja en el payload (por rutina):
```json
"egg": { "catalogId": "huevo_nebulosa", "name": "Nebulosa" }
```

- [ ] Confirmar si la app valida por `catalogId` o por `name` (define la lista que hay que congelar).
- [ ] Congelar en el funnel la lista exacta que espera la app (hoy: Nebulosa, Solar, Océano, Bosque, Cielo, Lava, Flor, Estrella, con `catalogId` `huevo_*`).
- [ ] Verificar de punta a punta que `funnel_plans.plan.routines[].egg` llega a la app y resuelve asset local.

## 3. App Store links

- [ ] Completar `iosStoreUrl` y `androidStoreUrl` en `FUNNEL_CONFIG`.
  - Hasta que no estén, los botones de tiendas **no se muestran** en el handoff.
- [ ] Confirmar el deep link `brainy://claim?token=...` está registrado en la app (ASWebAuthenticationURLs/App Links) antes de depender de él.

## 4. Analytics

Hoy hay un tracker liviano (cola `window.brainyAnalyticsQueue` + `navigator.sendBeacon` opcional).

- [ ] Elegir plataforma (PostHog / Firebase Analytics / etc.).
- [ ] Completar `analyticsEndpoint` o conectar el SDK en `track()`.
- [ ] Definir si se envían los eventos de la cola a un proxy propio.

## 5. Envío por email (no prometido en el funnel)

El handoff **no promete** envío del plan por mail: no hay backend de email conectado.

- [ ] Si se quiere, crear una Edge Function de envío (o servicio externo) que mande el enlace `brainy://claim?token=...` al email capturado.
- [ ] De lo contrario, mantener el flujo actual (copiar enlace / abrir app en el celu).

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
- [ ] Inyectar la key sandbox via `window.__BRAINY_FUNNEL_CONFIG__ = { revenuecatWebApiKey: 'strp_sb_mozjaozAfCdAQiBTzzSUnwQD' }` en el entorno de sandbox (NO hardcodear en `funnel.html`, hoy `''`). Para producción se usará la key pública de producción (probablemente `strp_...`).
- [ ] Stripe Billing conectado + Web Config Stripe + productos importados + packages configurados.
- [ ] Offering web `web_default` (FUNNEL_CONFIG.revenuecatOfferingId) con paquetes anual/mensual.
- [ ] Productos vinculados al entitlement exacto **`brainy Pro`** (FUNNEL_CONFIG.revenuecatEntitlementId).
- [ ] **Redemption Links activados** (para que `redemptionInfo.redeemUrl` exista en el PurchaseResult).
- [ ] Custom URL scheme en la app: `brainy://claim?token=...&redeem_url=...` + flujo `Purchases.logIn` → `parseAsWebPurchaseRedemption` → `redeemWebPurchase` → `claim-funnel-plan` → check `brainy Pro`.
- [ ] `iosStoreUrl`/`androidStoreUrl` (hoy vacíos → no se muestran botones de tienda).
- [ ] Test sandbox completo: mensual/anual, checkout complete/cancel/error, refresh antes/después de pagar, doble click, sin offering, entitlement, redemptionInfo, encoding deep link, iPhone/Android/desktop+QR.
- [ ] `revenuecatTermsUrl` (hoy vacío → sin footer legal en paywall).

## Documentación del proyecto web

- [ ] Unificar config: los placeholders viven solo en `FUNNEL_CONFIG` (no hardcodear credenciales ni URLs en otro lado).