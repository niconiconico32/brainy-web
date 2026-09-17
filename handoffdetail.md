# Handoff Web → App — contrato real (Brainy)

Documento del contrato **vigente** entre el funnel web (`funnel.html`) y la app
móvil. La app ya está implementada: la web **termina en Success/Handoff** y no
ejecuta login, OTP, Supabase Auth, redención ni materialización.

Última actualización: 2026-09-17.

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
      "egg": { "catalogId": 6 }
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

### 2.2 `egg.catalogId` — RESUELTO

El backend confirmó los 8 huevos **common** canónicos; el funnel usa esa lista
como fuente de verdad. `egg.catalogId` viaja siempre como **número 1–8** y la
app resuelve el asset por ese id. No se crean slugs nuevos.

| id | nombre  |
| -- | ------- |
| 1  | Terra   |
| 2  | Aqua    |
| 3  | Flame   |
| 4  | Storm   |
| 5  | Leaf    |
| 6  | Stone   |
| 7  | Crystal |
| 8  | Shadow  |

Reglas:
- Solo se envían ids 1–8 (nunca `huevo_*`).
- El slug viejo (`huevo_nebulosa`, …) queda **solo** como compatibilidad de
  `localStorage`; `canonicalEgg()` lo normaliza a número antes de asignar/enviar.
- 1 rutina = 1 huevo; hasta 5 rutinas usan huevos distintos.
- Preview y resumen muestran el nombre canónico del mismo id que se envía.

La regresión cubre esto en `EGG catálogo canónico 1-8` y
`EGG 1:1 + distintas + payload numérico + display` (el test `PAYLOAD` verifica
`typeof catalogId === 'number'`).

### 2.3 Creación del plan (`create-funnel-plan`)

`ensurePlan()`:

- Antes de crear el plan genera/persiste `clientPlanKey` (`crypto.randomUUID()`)
  en `localStorage['brainy_funnel_client_plan_key']` y en el estado
  (`clientPlanKey`).
- Envía `client_plan_key` a la Edge Function.
- Guarda `planId` + `claimToken` en el estado (`brainy_funnel_state`).
- **Idempotencia por `client_plan_key`**, no por email.

Respuestas de `create-funnel-plan` que el front contempla:

| HTTP | `error` | Acción del front |
|---|---|---|
| 200 | — | guarda `planId` + `claimToken` |
| 409 | `plan_expired` | rota la clave (`resetClientPlanKey`) y reintenta **una** vez |
| 409 | `plan_already_claiming` | no reintenta → `checkout_blocked_no_plan` |
| 409 | `plan_already_claimed` | no reintenta → `checkout_blocked_no_plan` |
| 400 | `invalid_client_plan_key` | bug de front: un UUID válido |
| 5xx | varios | recovery (“No pudimos preparar tu plan”) |

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

## 3. Backend — `web_funnel_plans` (canónica)

> **La fuente de verdad es `public.web_funnel_plans`.** La tabla legacy
> `public.funnel_plans` queda **intacta y fuera de uso**: la web no la lee ni la
> escribe. Las migraciones de este repo pasaron a `supabase/superseded/` (este
> repo web **no** crea ni aplica migraciones); la migración canónica ya fue
> aplicada por el equipo de backend/app.

Shape vigente (introspección en vivo del proyecto `wdqwqgfisiteswbbdurg`):

```
id                         uuid PK DEFAULT gen_random_uuid()
version                    integer NOT NULL DEFAULT 1
status                     text NOT NULL DEFAULT 'pending'   -- pending | claiming | claimed | expired
plan                       jsonb NOT NULL DEFAULT '{}'        -- CHECK jsonb_typeof = 'object'
email                      text NULL
marketing_opt_in           boolean NOT NULL DEFAULT false
claim_token_hash           text NOT NULL UNIQUE              -- SHA-256(claimToken), CHECK ^[a-f0-9]{64}$
source                     text NULL
campaign                   text NULL
expires_at                 timestamptz NULL                  -- NO existe claim_expires_at
claimed_at                 timestamptz NULL
created_at                 timestamptz NOT NULL DEFAULT now()
updated_at                 timestamptz NOT NULL DEFAULT now() -- trigger set_web_funnel_plans_updated_at
revenuecat_redemption_url  text NULL
claimed_by_user_id         uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
client_plan_key            uuid NOT NULL UNIQUE
```

Índices: `web_funnel_plans_client_plan_key_uq`, `web_funnel_plans_claim_token_hash_uq`,
`idx_web_funnel_plans_email_status_created`, `idx_web_funnel_plans_status_created`,
`idx_web_funnel_plans_claimed_by_user_id`.

- **Nunca se guarda `claimToken` en texto plano.**
  `claim_token_hash = SHA-256(claimToken)` (hex minúsculas, 64 chars).
- **La columna de expiración es `expires_at`** (la web fija `now() + 7 días` al
  crear). `claim_expires_at` era de la tabla legacy: **no usarla**.
- `claimed_by_user_id`, `claimed_at` y `revenuecat_redemption_url` los escribe la
  app/backend; la web los deja `NULL`. La web **nunca** hace UPDATE directo.
- Estados: `pending → claiming → claimed | expired`.
  - La **web solo crea `pending`** (`version = 1`).
  - La **app/backend** gestiona `claiming → claimed | expired` y materializa vía
    el RPC `public.claim_funnel_plan` (row lock + state machine + marcador
    `__materialized`).
- RLS habilitada. Única policy: `anon` INSERT con `with_check (status = 'pending')`;
  no hay SELECT/UPDATE público. El acceso real es `service_role` desde Edge Functions.

### 3.1 `create-funnel-plan` (web)

Request: `{ plan, client_plan_key, email?, marketing_opt_in?, source?, campaign? }`.

- `client_plan_key`: si falta se genera; si viene debe ser **UUID válido** (si no,
  `400 invalid_client_plan_key`).
- Genera `claimToken` con `crypto.getRandomValues` (32 bytes → 64 hex) y persiste
  **solo** `SHA-256(claimToken)` (`crypto.subtle.digest`).
- Inserta `{ id, version: 1, status: 'pending', plan, email, marketing_opt_in,
  source, campaign, claim_token_hash, client_plan_key, expires_at }`.
- Devuelve `{ planId, claimToken }` (texto plano **una sola vez**).
- Idempotencia por `client_plan_key`:
  - **`pending` vigente** → reemite **NUEVO** `claimToken` (reemplaza el hash,
    invalida el anterior) y actualiza `plan`/`email`/`marketing_opt_in`/`source`/
    `campaign`. Mismo `planId`.
  - **`claiming`** → `409 plan_already_claiming` (no se toca la fila).
  - **`claimed`** → `409 plan_already_claimed` (no se toca la fila).
  - **`expired` o TTL vencido** → `409 plan_expired` (no se recicla como `pending`).
  - Carrera de inserción (`23505` en `client_plan_key`) → se re-resuelve con la
    misma lógica idempotente.

### 3.2 `claim-funnel-plan` / `restore-funnel-plan` (app/backend)

**No son parte de este repo web** (viven en el backend; descargadas solo como
referencia local). La web no las llama ni las implementa.

- `claim-funnel-plan`: requiere JWT; busca por `claim_token_hash`, valida estado y
  delega la materialización al RPC.
- `restore-funnel-plan`: resolución **server-side por email** verificado del JWT
  (sin body); status `IN (pending, claiming, claimed)` y no vencido; top-1 por
  `created_at DESC`.

> Referencia usada para congelar el contrato (2026-09-17, proyecto
> `wdqwqgfisiteswbbdurg`): `claim-funnel-plan` **v6** y `restore-funnel-plan`
> **v4**, inspeccionadas con `supabase functions download`. No se copiaron al
> repo web (ver `.gitignore`).

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

### 6.1 Regresión backend (`create-funnel-plan`, `testers/create-plan-regression.cjs`)

Escenarios:

| # | Escenario | Cubre |
|---|-----------|-------|
| A | creación nueva | fila `pending` en `web_funnel_plans`, `claim_token_hash` = hash, sin plaintext |
| B | retry `pending` | mismo `planId`, **nuevo** `claimToken`, hash reemplazado |
| C | `claiming` | `409 plan_already_claiming`, fila intacta |
| D | `claimed` | `409 plan_already_claimed`, fila intacta |
| E | demo | checkout bloqueado (`hasRealPlan() === false`) |
| F | payload | difficulty sin `medium`, durations number, counts, rangos |
| G | deep link | token + redeem_url + email URL-encoded |
| H | tabla | la web solo consulta/escribe `web_funnel_plans`, nunca `funnel_plans` |

---

## 7. Pendientes / coordinación con la app

1. **Verificar materialización de huevos**: `egg.catalogId` ya viaja numérico
   (1–8) y `_shared/funnel.ts` lo resuelve con `Number(catalogId)`. Falta
   confirmar de punta a punta que la app muestra el asset del id enviado.
2. **Email server-side**: reemplazar `email` en el deep link por resolución
   server-side (hoy es temporal).
3. `iosStoreUrl` / `androidStoreUrl` (`FUNNEL_CONFIG`, hoy vacíos → sin botones
   de tienda).
4. `revenuecatTermsUrl` (hoy vacío).
5. `revenuecat_redemption_url` en `web_funnel_plans`: hoy queda `NULL` (la web lo
   manda solo por deep link). Definir si algún endpoint debe persistirlo para que
   `restore-funnel-plan` reporte `redemption.pending`.
6. Confirmar el orden app: redeem → verificar `brainy Pro` → claim → materializar
   (ya implementado: `claim-funnel-plan` + `restore-funnel-plan` + RPC
   `claim_funnel_plan`).
