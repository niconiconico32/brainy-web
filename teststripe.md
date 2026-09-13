# Test manual de compra (sandbox Stripe) — Funnel Brainy

## Estado actual
- **TEST COMPLETADO** (Safari, 2026-09-13): el pago sandbox confirmó íntegro.
  - `purchase()` resolvió y emitió `purchase_success` con
    `entitlementActive: true` y `redemptionAvailable: true`.
  - Pantalla final: "Tu plan Brainy está activado 🎉".
  - El error CORS de `https://r.stripe.com/b` (beacon de telemetría, por servir en
    `http://localhost`) NO bloquea el cargo; solo generó una recarga en Safari.
- Hoy `funnel.html` corre con `revenuecatWebApiKey: ''`: para reproducir el test
  manual hay que reinyectar la key de sandbox (paso 0) antes de servir la página.

## Cómo abrir la consola en Safari
1. Una vez: **Safari → Ajustes → Avanzado** → marcar **"Mostrar funciones para desarrolladores"**.
2. Con el funnel abierto: **Desarrollar → Mostrar consola de JavaScript** (o **⌥+⌘+C**).
3. Importante: la URL debe ser `http://localhost:8000/funnel.html` (la consola ve solo la página activa).

## Paso 0 — Reinyectar la key de sandbox (solo si se quiere reproducir)
Las pruebas usan una config temporal que ya se revirtió. Para repetir el test, agregá
en `<head>` de `funnel.html` (y borrá este bloque al terminar):

```html
<!-- TEMP-SANDBOX-KEY: remove after manual pay test -->
<script>window.__BRAINY_FUNNEL_CONFIG__ = window.__BRAINY_FUNNEL_CONFIG__ || {"revenuecatWebApiKey": "strp_sb_mozjaozAfCdAQiBTzzSUnwQD"};</script>
```

## Paso 1 — Confirmar que la consola responde
Pegá esto (una línea) y presioná Enter; debe mostrar el título de la página:

```js
document.title
```

> En la consola de Safari, los bloques multilínea a veces no se ejecutan con Enter.
> Usá las versiones de UNA SOLA LÍNEA de abajo. Si aparece un botón ▶ **Run** al lado del input, cliclealo.

## Paso 2 — Posicionar en el paso de pago (paso 21)
Pegá esto (una línea) y presioná Enter; debe responder `saved`:

```js
localStorage.setItem('brainy_funnel_step','21'); localStorage.setItem('brainy_funnel_state', '{"q1_estado_actual":"a","q2_dolor":["b"],"q3_intentos_previos":"c","q4_causa_fracaso":"d","q5_identidad_futura":"e","q6_area_prioritaria":"f","q7_compromiso":"g","q8_tiempo_disponible":"h","q9_listo":"i","q10_cuando_empezar":"j","edad":25,"email":"sb-checkout@brainyadhd.com","selectedTasks":[{"templateId":"t","id":"t1","title":"T","emoji":"","subtasks":[{"title":"P","duration":5}]}],"selectedRoutines":[{"templateId":"r","id":"r1","name":"R","title":"R","icon":"","tasks":[{"title":"T","position":1}],"subtasks":[{"title":"T","duration":null}]}],"assignedRoutines":[{"catalogId":"h","name":"H","emoji":"x","color":"#fff"}],"emailSubmitted":true,"planId":"sb-plan-test","claimToken":"sbtok1234567890abcdef","purchaseCompleted":false,"selectedPackageId":null,"pendingRedemptionUrl":null}'); 'saved'
```

Después **recargá la página** (⌘+R): deberías ver la pantalla de pago ("Activa tu plan Brainy").

## Paso 3 — Pagar (SOLO tarjeta de prueba)
- Clic en **"Activar mi plan →"**.
- En el modal (modo SANDBOX):
  - Tarjeta: `4242 4242 4242 4242`
  - Vencimiento: `12/34`
  - CVC: `123`
  - Nombre del titular: cualquiera
- Clic en **"Comenzar prueba"**.
- Cuando aparezca **"Pago completado"**, clic en **"Continuar"**.
  (Si Safari recarga por el error del beacon, no es grave: verificá el paso 4.)
- Resultado esperado: pantalla **"Tu plan Brainy está activado 🎉"**

## Paso 4 — Verificar entitlement activo
En la consola (tras cargar/recargar el funnel), una línea:

```js
window.Purchases.Purchases.instance.getCustomerInfo().then(ci => console.log('brainy Pro activo:', !!(ci.entitlements.active['brainy Pro'] && ci.entitlements.active['brainy Pro'].isActive)))
```

Estado guardado (purchaseCompleted / step), una línea:

```js
JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}').purchaseCompleted + ' | step ' + localStorage.getItem('brainy_funnel_step')
```

Link de redención guardado (sin exponer el token), una línea:

```js
(r => r ? r.replace(/redemption_token=.*/, 'redemption_token=[redactado]') : null)(JSON.parse(localStorage.getItem('brainy_funnel_state') || '{}').pendingRedemptionUrl)
```

## Lectura de resultados
- `brainy Pro activo: true` → el pago confirmó y el entitlement está activo. Listo.
- `brainy Pro activo: false` y `purchaseCompleted: false` → el cargo no confirmó;
  reintentar, o automatizar en Chromium cuando haya RAM libre (el driver ya cliclea "Continuar").

> Resultado logrado el 13/09: `brainy Pro activo: true` (via `purchase_success`),
> `step 22`, `purchaseCompleted: true`, `pendingRedemptionUrl` con token enmascarado.