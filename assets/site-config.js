/* Configuracion publica del sitio — FUENTE UNICA.
 *
 * La leen funnel.html y manage-subscription/index.html. No hay segunda copia
 * de estos valores en ningun otro fichero.
 *
 * Solo claves PUBLICAS:
 *   - revenuecatWebApiKey: RevenueCat Web Billing key. Publica por diseno.
 *   - stripeCustomerPortalUrl: login publico del Stripe Customer Portal.
 * Ninguna secret key (sk_, rk_, service_role) vive en el frontend.
 *
 * El sitio arranca fail-closed: si este fichero no carga, FUNNEL_CONFIG se
 * queda con la key vacia y el checkout se desactiva. No hay fallback a sandbox.
 *
 * Generado con las variables FUNNEL_RC_LIVE_KEY y STRIPE_CUSTOMER_PORTAL_URL.
 */
(function () {
    'use strict';
    window.__BRAINY_FUNNEL_CONFIG__ = {
        revenuecatWebApiKey: 'strp_WUyJwcvTdADAgwbSPAAyhWifGNL',
        revenuecatOfferingId: 'web_default',
        revenuecatEntitlementId: 'brainy Pro',
        stripeCustomerPortalUrl: 'https://billing.stripe.com/p/login/5kQ5kEbKXdRz4pAgs21Fe00'
    };
})();
