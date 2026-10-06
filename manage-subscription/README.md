# /manage-subscription/

Trampolín al login público del **Stripe Customer Portal**. No autentica a nadie
y no cancela nada.

```
Usuario pulsa "Manage subscription"
  -> /manage-subscription/
  -> valida stripeCustomerPortalUrl (fail closed)
  -> limpia su propia query y fragment
  -> location.replace() al login de Stripe, misma pestaña
  -> Stripe pide el correo y envia el acceso
  -> el usuario administra o cancela ahi
```

## Lo que esta pagina NO hace

- No pide correo ni contrasena de Brainy.
- No crea sesion de Supabase ni usa `signInWithPassword`.
- No configura RevenueCat ni pide `CustomerInfo` / `getManagementURL`.
- No busca clientes por email con ninguna API publica.
- No guarda ni transmite correos, UUID, JWT ni tokens.
- No cancela. **Stripe es el unico sitio donde se cancela.**

El antiguo flujo (login de Brainy -> `managementURL` de RevenueCat) quedo
eliminado junto con `assets/manage-subscription.js`, que era codigo muerto.

## Configuracion

Fuente unica: `assets/site-config.js`, cargada por `funnel.html` y por esta
pagina.

| Clave | Uso |
| --- | --- |
| `revenuecatWebApiKey` | RevenueCat Web Billing (Stripe Live) |
| `revenuecatOfferingId` | `web_default` |
| `revenuecatEntitlementId` | `brainy Pro` |
| `stripeCustomerPortalUrl` | login publico de Stripe |

La URL del portal **no esta duplicada** en ningun otro fichero. Si falta o es
invalida, la pagina no navega y muestra el contacto de soporte.

El sitio es fail-closed: si `site-config.js` no carga, la key de RevenueCat
queda vacia y el checkout se desactiva. **No hay fallback a sandbox.**

## Validacion de la URL (fail closed)

`assets/stripe-portal.js` acepta **solo** `https://billing.stripe.com/p/login/<id>`.
Rechaza `http:`, otro hostname, subdominio atacante, credenciales embebidas,
`javascript:`, `data:`, fragmentos, espacios, saltos de linea, puertos no
estandar y paths que no sean `/p/login/`.

## Procedimiento manual (NO ejecutado)

Requiere autorizacion. Ninguno de estos pasos se ha realizado.

| # | Paso | Resultado esperado |
| --- | --- | --- |
| 1 | Abrir `/manage-subscription/` | Muestra "Opening your secure subscription portal..." y redirige sola |
| 2 | Confirmar el destino | `billing.stripe.com/p/login/...`, misma pestana, sin parametros |
| 3 | Usar "Continue to Stripe" | Lleva al mismo login de Stripe |
| 4 | En Stripe, escribir un correo de prueba | Stripe pide el correo y envia el acceso por email |
| 5 | Cancelar desde el portal | Cancelacion al final del periodo; acceso hasta expirar |
| 6 | Entrar con `?email=x@y.z#token` | Query y fragmento se limpian y no llegan a Stripe |
| 7 | Sin JavaScript | Mensaje util con contacto de soporte |
| 8 | Con `prefers-reduced-motion` | Redirige igual, sin spinner |

## Nota sobre el trial

En la configuracion Live leida, **ninguno de los dos productos tiene trial**
(anual y mensual se cobran desde el primer dia). El "cobra 0 hoy" y la
duracion del trial hay que confirmarlos en el Dashboard de Stripe antes de
comunicar nada sobre ello.

## Dependencias externas

- **Stripe**: la URL del portal debe seguir habilitada en la cuenta Live. Si se
  regenera, hay que actualizar `stripeCustomerPortalUrl`.
- **RevenueCat**: la configuracion Stripe Billing debe seguir conectada a la
  cuenta Live y `web_default` debe conservar `$rc_monthly` y `$rc_annual`.
