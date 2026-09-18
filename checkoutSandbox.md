# Checkout sandbox RevenueCat — Funnel Brainy (web)

Estado: **checkout anual sandbox real OK + regresiones 21/21**. Cambios web
completos: rutinas con `steps[]`, persistencia server-side del redemption URL,
estados independientes compra/persistencia y recovery que reintenta SOLO persistir.

- Scripts: `testers/e2e-regression.cjs`, `testers/sandbox-checkout.cjs`, `testers/create-plan-regression.cjs`
- Comandos: `npm run test:e2e:funnel`, `npm run test:e2e:sandbox`, `npm run test:e2e:create-plan`
- Requiere sitio servido en `http://localhost:8000` (ej: `python3 -m http.server 8000`).

---

## 1. Resultado del checkout sandbox real (2026-09-18)

```
planReal              true   (hasPlanId + hasClaimToken + hasClientPlanKey)
purchase resolved     true
entitlement           active=true, periodType="trial"   <- anual CON trial
redemption persist    redemption_persisted {status: set}
handoffReady          true      step 22
payload               rutina con steps[] (sin tasks) + egg catalogId numérico
redemptionScheme      rc-f91d4f2118
errores de página     0         RESULT: OK
```

La fila usada fue un plan **real** en `web_funnel_plans` (no el ficticio
`sb-plan-test` de las regresiones): el funnel llamó a `create-funnel-plan`
(`plan_created`) y a `set-funnel-redemption` (`redemption_persisted {status:set}`).

El entitlement quedó activo con `periodType trial` → el **plan anual tiene trial**
en sandbox.

## 2. Cambios web implementados

| Archivo | Cambio |
| --- | --- |
| `funnel.html` | `FUNNEL_CONFIG`: `setRedemptionUrl='https://auth.brainyadhd.com/functions/v1/set-funnel-redemption'` (merge `__BRAINY_FUNNEL_CONFIG__`). `DEFAULT_STATE`: `redemptionPersisted:false`. `buildUserPlanPayload()`: rutinas → `steps[]` (`{title,duration}`), sin `tasks`/`position`; tareas independientes siguen en `plan.tasks`. Helpers módulo-scope `persistRedemptionUrl()` y `retryPendingRedemption()`. Manejador de compra: RC confirma → `purchaseCompleted` (independiente) → persist URL → `redemptionPersisted`+`handoffReady`. Recovery reintenta SOLO persistir, NUNCA recomprar. `renderSuccess()` exige `purchaseCompleted && redemptionPersisted && handoffReady`. |
| `assets/revenuecat.js` | `redemptionUrlOf()` endurecido + `primaryRedemptionUrlOf()` (usa SOLO `redeemUrl`, exportado en `window.BrainyRevenueCat`). |
| `testers/e2e-regression.cjs` | 21 tests: S2 PAY con plan real + persistencia real; S13 steps; S17 redeploy; nuevos S18 REDEEM_SET, S19 REDEEM_UNCHANGED, S20 REDEEM_FAIL_RETRY (1º falla, retry OK, `purchase===1` siempre), S21 PAYLOAD-STEPS. Stubs con `primaryRedemptionUrlOf` + `opts.redemptionRoute`. |
| `testers/sandbox-checkout.cjs` | Checkout real: estado `redemptionPersisted`, payload con `steps[]`, verificación server-side opcional (`SUPABASE_SERVICE_ROLE_KEY`), `planId` visible, tokens/URLs enmascarados. |
| `testers/cleanup-funnel-plans.cjs` | Limpieza por email exacto + `EMAIL_LIKE` (emails únicos `sb+checkout-<stamp>@...`). |
| `package.json` | Scripts `test:e2e:sandbox` (+ funnel/create-plan preexistentes). |

## 3. Root cause descubierto durante la corrida

`set-funnel-redemption` devuelve **409 `redemption_conflict`** si un plan pending
ya tiene un `revenuecat_redemption_url` distinto seteado (anti-abusos: una vez
el claim se asocia a una suscripción, no se reemplaza). El test S2 reutilizaba el
mismo `client_plan_key` (`11111111-…`) en cada corrida → reusa el MISMO planId cuyos
`claim_token_hash` se rota, y su URL ya estaba persistida de una corrida anterior →
conflicto en todos los reintentos. Fix de TEST (no de producto): `client_plan_key`
**único por corrida** + email único (`sb+checkout-<stamp>@brainyadhd.com`), como
usuarios reales distintos. Con eso: persist OK y 21/21.

## 4. Estados y recovery (contrato)

- RC confirma entitlement → `purchaseCompleted=true` (independiente de persistencia).
- Persist OK (`status=set|unchanged`) → `redemptionPersisted=true` y `handoffReady=true` → `goNext`.
- Persist falla → `purchaseCompleted=true`, `redemptionPersisted=false`, `handoffReady=false`,
  `pendingRedemptionUrl` conservado, recovery: **reintenta SOLO persistir** (nunca `purchase()`).
- `localStorage` `brainy_funnel_state`: `claimToken` y `pendingRedemptionUrl` propiedades de
  primer nivel del JSON.
- Deep link navegador sigue como fallback/compat; cierre de navegador → app → email+OTP → restore.

## 5. Seguridad

Nunca se imprime/loguea: `claimToken`, `redemption_token`, redemption URL completa,
email, keys Supabase. La URL se reduce a su esquema; tokens a `[redacted]`.
`funnel.html` NO hardcodea `revenuecatWebApiKey` (viene de `window.__BRAINY_FUNNEL_CONFIG__`;
en vida, key `''`).

## 6. Pendiente

1. **Verificación server-side de la fila** (`revenuecat_redemption_url NOT NULL`,
   `plan.routines[].steps` guardado, `status`) — requiere `SUPABASE_SERVICE_ROLE_KEY`:
   `exporer`… `SUPABASE_SERVICE_ROLE_KEY` + `npm run test:e2e:sandbox` (bloque opcional ya implementado).
2. **Limpieza de filas de test** (S2/sandbox `sb+checkout-*`, probes `probe+*`):
   `read -s SUPABASE_SERVICE_ROLE_KEY; export SUPABASE_SERVICE_ROLE_KEY; npm run cleanup:funnel-plans`
   (default exacto `sb+checkout@…` + `EMAIL_LIKE sb+checkout-%@…`; probes con `TEST_EMAILS=probe+...`).
3. `npm run test:e2e:create-plan` sigue en **7/7** (sin cambios) — verificar de nuevo antes de merge.

## 7. Cómo reproducir

```bash
python3 -m http.server 8000

npm run test:e2e:funnel          # 21/21 (incluye pago real S2)
npm run test:e2e:sandbox         # checkout real + persist {status:set}
npm run test:e2e:create-plan     # 7/7

# verificación server-side + limpieza
read -s SUPABASE_SERVICE_ROLE_KEY; export SUPABASE_SERVICE_ROLE_KEY
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY npm run test:e2e:sandbox
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY npm run cleanup:funnel-plans   # DRY_RUN=1 lista primero
```