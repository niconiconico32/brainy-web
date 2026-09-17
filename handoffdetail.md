# Handoff Web → App — contrato real (Brainy)

Documento del contrato **vigente** entre el funnel web (`funnel.html`) y la app
móvil. La app ya está implementada: la web **termina en Success/Handoff** y no
ejecuta login, OTP, Supabase Auth, redención ni materialización.

Última actualización: 2026-09-16.

---

## 1. Arquitectura final

```
WEB (funnel.html)
  Funnel
  → Email
  → create-funnel-plan        (Edge Function, service_role)
  → Paywall
  → Purchase / Free Trial     (RevenueCat Web Billing + Stripe)
  → Success
  → Handoff (deep link)

APP (ya implementada)
  Open Brainy
  → Login original / OTP
  → Supabase user
  → Purchases.logIn(user.id)
  → Redeem web purchase
  → verificar `brainy Pro`
  → Claim funnel plan (claim-funnel-plan)
  → Materializar
  → App
```

El orden app es: **redeem antes de claim**, y **claim NO se marca `claimed`
hasta que la materialización terminó bien**.

---

## 2. Lo que envía la WEB

### 2.1 Payload del plan (`buildUserPlanPayload`, `version: 1`)

```jsonc
{
  "version": 1,
  "answers": { "p1": "...", /* ... */ "p10": "..." },
  "tasks": [
    {
      "templateId": "string",
      "title": "string",
      "emoji": "string",
      "metric": "string | null",
      "difficulty": "easy | moderate | hard",
      "subtasks": [ { "title": "string", "duration": 5 } ]
    }
  ],
  "routines": [
    {
      "templateId": "string",
      "name": "string",
      "days": ["daily"],
      "icon": "string",
      "tasks": [ { "title": "string", "position": 1 } ],
      "egg": { "catalogId": "huevo_nebulosa", "name": "Nebulosa", "imageUrl": null }
    }
  ],
  "preview": { "interacted": true },
  "metadata": {
    "createdAt": "ISO-8601",
    "source": "website",
    "campaign": "brainy_onboarding_v1",
    "locale": "es-AR",
    "tasksCount": 2,
    "routinesCount": 2,
    "totalSelectedCount": 4
  }
}
```

Reglas garantizadas por el funnel:

- **Selección real del usuario**: 1–3 tareas y 1–5 rutinas. El payload
  representa exactamente lo elegido; **no existe una regla de “6 hábitos”**.
- `metadata.{tasksCount,routinesCount,totalSelectedCount}` son counts explícitos.
- `difficulty` se **normaliza** en `buildUserPlanPayload`:
  `low → easy`, `medium → moderate`, `high → hard`. Nunca se envía `"medium"`.
- `duration` siempre es `number` (> 0). Si falta, se usa
  `DEFAULT_SUBTASK_DURATION_MINUTES = 5` (nunca `null`).
- `metric` puede ser `null` (así lo consume la app).

### 2.2 `egg.catalogId` — PENDIENTE / BLOQUEANTE

La app móvil usa `egg_catalog.id` **numérico**, pero **en este repositorio no
existe ningún catálogo ni mapping de `egg_catalog`** (solo la lista local
`EGGS` con slugs `huevo_*`). Por indicación del contrato:

> Si no existe mapping fiable: detener implementación de esa parte y reportarlo.

Por eso hoy `egg.catalogId` sigue viajando como **slug** (`"huevo_nebulosa"`) y
la app resuelve el asset local. **No se inventaron IDs.**

Acción requerida (coordinación web↔app): congelar el mapping real
`slug → egg_catalog.id` (p. ej. `huevo_nebulosa → 4`) y recién entonces enviar
`catalogId` numérico. Al hacerlo hay que actualizar el test `PAYLOAD` de la
regresión (hoy verifica `typeof catalogId === 'string'` a propósito).

### 2.3 Creación del plan (`create-funnel-plan`)

`ensurePlan()`:

- Antes de crear el plan genera/persiste `clientPlanKey` (`crypto.randomUUID()`)
  en `localStorage['brainy_funnel_client_plan_key']` y en el estado
  (`clientPlanKey`).
- Envía `client_plan_key` a la Edge Function.
- Guarda `planId` + `claimToken` en el estado (`brainy_funnel_state`).
- **Idempotencia por `client_plan_key`**, no por email.

### 2.4 Checkout gating y recovery

- `hasRealPlan()` = `enableBackend && planId && claimToken` y ninguno es
  `demo-*`/vacío.
- **NO REAL PLAN = NO REAL CHECKOUT.** Si no hay plan real:
  - el botón de compra se muestra **deshabilitado**: “Checkout unavailable in
    demo mode” (modo demo/desarrollo), y
  - `startCheckout()` corta con `checkout_blocked_no_plan`.
- Compra web “lista” solo si `entitlementActive === true` **y** existe
  `redeemUrl`:
  - Sí → `purchaseCompleted = true`, `handoffReady = true`,
    `pendingRedemptionUrl`, y se avanza a Success.
  - No (entitlement activo pero sin `redemptionInfo`) → `purchaseCompleted = true`,
    `handoffReady = false`, estado de recovery (“Tu suscripción fue activada,
    pero no pudimos preparar el enlace para Brainy.”). **No se vuelve a cobrar**
    y no se genera handoff normal.

### 2.5 Deep link (`buildClaimLink`)

```
brainy://claim
  ?token=<CLAIM_TOKEN>              # 64 hex; solo existe token real
  &redeem_url=<ENCODED_REDEMPTION_URL>   # solo después de compra web válida
  &email=<ENCODED_EMAIL>            # encodeURIComponent(email)
```

- El deep link final contiene **token + redeem_url + email**.
- **Solo se renderiza Success/Handoff con CTA “Abrir Brainy” cuando** hay
  `planId` real, `claimToken` real, `purchaseCompleted`, `handoffReady` y
  `pendingRedemptionUrl` válidos.
- **El email va al deep link como solución TEMPORAL** para la implementación
  móvil actual (login original en modo funnel, prellenado y envío de OTP).

> **TODO:** reemplazar el email en la URL por resolución **server-side** del
> handoff para evitar PII dentro del deep link/QR.

### 2.6 Analytics

Se mantienen los eventos existentes y se agregan: `plan_created`,
`plan_creation_failed`, `checkout_blocked_no_plan`, `handoff_ready`,
`handoff_recovery_required`.

`track()` pasa todo por `safeAnalyticsMetadata()`, que **elimina** claves
prohibidas (`email`, `claim_token`, `claim_token_hash`, `redemption_url`,
`redemption_token`, `token`, `jwt`, `authorization`, `redeem_url`). Metadata
segura: `tasksCount`, `routinesCount`, `packageId`, `offeringId`, `platform`,
`campaign`, `locale`. Nunca se loguea el deep link completo.

### 2.7 localStorage

Se mantiene `brainy_funnel_state` y `brainy_funnel_step`. Además se persiste
`brainy_funnel_client_plan_key` (clave estable de idempotencia).

Estado adicional: `clientPlanKey`, `purchaseCompleted`, `handoffReady`,
`pendingRedemptionUrl`. Refresh post-compra: con `purchaseCompleted && handoffReady`
vuelve a Success/Handoff y **no** inicia otra compra.

---

## 3. Backend — `funnel_plans`

Nombre intacto: `funnel_plans`. Los cambios se aplican en una **nueva migración**
(`20260916000000_secure_funnel_plans_claim.sql`), no editando la ya aplicada.

Shape vigente:

```
id                uuid PK
client_plan_key   uuid UNIQUE NOT NULL
plan              jsonb NOT NULL
email             text
marketing_opt_in  boolean
source            text
campaign          text
claim_token_hash  text UNIQUE NOT NULL   -- SHA-256(claimToken)
status            text NOT NULL          -- pending | claiming | claimed | expired
claimed_by_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
claimed_at        timestamptz NULL
claim_expires_at  timestamptz NOT NULL   -- now() + 7 días
created_at, updated_at
```

- **Nunca se guarda `claimToken` en texto plano** (se eliminó `claim_token`).
- `claim_token_hash` = `SHA-256(claimToken)`.
- `claimed_by_user_id` **nunca lo escribe la web**; sirve para saber quién
  reclamó, idempotencia, impedir que otro usuario reclame el mismo plan y
  permitir que el mismo usuario repita claim con éxito.
- Estados:
  - La **web solo crea `pending`**.
  - La **app/backend** gestiona `claiming → claimed | expired`.
- Secuencia móvil correcta: `pending → claiming → materializar OK → claimed`.
  Si la materialización falla, **no** debe quedar `claimed`.
- RLS: habilitada, **sin acceso anon/authenticated**; `service_role` solo desde
  Edge Functions/backend. La web **no** hace UPDATE directo.

### 3.1 `create-funnel-plan` (web)

- Genera `claimToken` con `crypto.getRandomValues` (32 bytes → 64 hex) y
  persiste **solo** `SHA-256(claimToken)` (`crypto.subtle.digest`).
- Devuelve `{ planId, claimToken }` al navegador.
- Idempotencia por `client_plan_key`:
  - Primera llamada → crea fila `pending`, guarda hash, devuelve token.
  - Retry con el mismo `client_plan_key` y `status = pending` → reutiliza la
    fila, genera **NUEVO** `claimToken`, reemplaza el hash y devuelve el nuevo
    token (el anterior queda invalidado).
  - Si el plan ya no está `pending` (o venció) → `409 plan_not_pending`.

### 3.2 `claim-funnel-plan` (app/backend)

**No forma parte de este repo web.** Lo implementa la app/backend. La web no
lo llama ni lo implementa.

---

## 4. Lo que hace la APP (no la web)

- Login original y OTP (`sendOtp` → `verifyOtp`) → Supabase user.
- `Purchases.logIn(user.id)` (RevenueCat identity).
- `redeemWebPurchase` con el `redeem_url`.
- Verificación del entitlement `brainy Pro`.
- `claim-funnel-plan` + materialización.
- Routing final.

La web **no** implementa OTP, Supabase Auth ni claim.

---

## 5. Seguridad / logging

- Nunca se envían a analytics ni se imprimen: email, `claimToken`,
  `claim_token_hash`, `redemptionUrl`, `redemption_token`, JWT/Authorization.
- La regresión E2E enmascara emails, tokens (claim/redeem), hashes, JWTs y keys
  (`testers/e2e-regression.cjs` → `maskText`).

---

## 6. Regresión E2E (`npm run test:e2e:funnel`)

Escenarios (13):

| # | Escenario | Cubre |
|---|-----------|-------|
| 1 | `WALK` | onboarding completo → paywall (demo, checkout bloqueado) |
| 2 | `PAY` | pago sandbox real → success/handoff |
| 3 | `MOBILE` | modal checkout en iPhone |
| 4 | `HOME` | index + CTA → funnel |
| 5 | `STATIC` | páginas estáticas 200 |
| 6 | `GATE` | sin key no hay paywall |
| 7 | `DEMO` | backend demo → checkout bloqueado, sin purchase |
| 8 | `NOPLAN` | `create-funnel-plan` falla → bloqueado |
| 9 | `CANCEL` | checkout cancelado → vuelve al paywall, plan intacto |
| 10 | `NOREDEEM` | purchase sin `redemptionInfo` → recovery, sin 2º cobro |
| 11 | `REFRESH` | refresh post-compra → success, sin recomprar |
| 12 | `DEEPLINK` | token + redeem_url + email URL-encoded |
| 13 | `PAYLOAD` | difficulty sin “medium”, durations number, counts, rangos |

Resultado actual: **13/13 ok**.

---

## 7. Pendientes / coordinación con la app

1. **BLOQUEANTE — `egg_catalog.id`**: congelar mapping real
   `slug → egg_catalog.id` y cambiar `egg.catalogId` a número.
2. **Email server-side**: reemplazar `email` en el deep link por resolución
   server-side (hoy es temporal).
3. `iosStoreUrl` / `androidStoreUrl` (`FUNNEL_CONFIG`, hoy vacíos → sin botones
   de tienda).
4. `revenuecatTermsUrl` (hoy vacío).
5. App/backend: implementar `claim-funnel-plan` con
   `pending → claiming → claimed` y `claimed_by_user_id`; nunca marcar `claimed`
   antes de materializar.
6. Confirmar el orden app: redeem → verificar `brainy Pro` → claim → materializar.
