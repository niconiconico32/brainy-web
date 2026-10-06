/* BrainyStripePortal — redirección al login público del Stripe Customer Portal.
 *
 * Este módulo reemplaza al antiguo login de Brainy. NO autentica a nadie:
 *   - no pide correo ni contraseña;
 *   - no crea sesión de Supabase;
 *   - no configura RevenueCat ni pide CustomerInfo;
 *   - no busca clientes por email;
 *   - no cancela nada.
 *
 * Stripe es el único sitio donde se cancela. Esta página solo lleva al usuario
 * al login del portal, y es Stripe quien le pide el correo y le envía el acceso.
 *
 * La URL del portal es pública y compartible, pero se valida estrictamente
 * antes de navegar: solo https://billing.stripe.com/p/login/...
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.BrainyStripePortal = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var PORTAL_HOST = 'billing.stripe.com';
    var PORTAL_PATH_PREFIX = '/p/login/';

    /* Fail closed. Acepta EXCLUSIVAMENTE:
     *   https://billing.stripe.com/p/login/<algo>
     * Rechaza http:, otro hostname, credenciales embebidas, javascript:,
     * data:, fragmentos, espacios y saltos de línea. */
    function isValidPortalUrl(value) {
        if (typeof value !== 'string') {
            return false;
        }
        if (value !== value.trim() || /\s/.test(value)) {
            return false;
        }
        var parsed = null;
        try {
            parsed = new URL(value);
        } catch (error) {
            return false;
        }
        if (parsed.protocol !== 'https:') {
            return false;
        }
        if (parsed.hostname !== PORTAL_HOST) {
            return false;
        }
        // Solo el puerto HTTPS por defecto: nada de puertos alternativos.
        if (parsed.port !== '' && parsed.port !== '443') {
            return false;
        }
        // Sin credenciales embebidas (https://user:pass@host/...).
        if (parsed.username !== '' || parsed.password !== '') {
            return false;
        }
        // Fragmento inesperado: el portal no lo usa y podría inyectar UI.
        if (parsed.hash && parsed.hash.length > 0) {
            return false;
        }
        // Path exacto del login público de Stripe.
        if (typeof parsed.pathname !== 'string' ||
            parsed.pathname.indexOf(PORTAL_PATH_PREFIX) !== 0 ||
            parsed.pathname.length <= PORTAL_PATH_PREFIX.length) {
            return false;
        }
        return true;
    }

    /* Lee SOLO stripeCustomerPortalUrl de la configuracion publica.
     * No lee revenuecatWebApiKey ni ninguna otra clave. */
    function portalUrlFromConfig(config) {
        if (!config || typeof config !== 'object') {
            return null;
        }
        var value = config.stripeCustomerPortalUrl;
        return isValidPortalUrl(value) ? value : null;
    }

    /* Quita el query string y el fragmento de la URL propia antes de
     * redirigir, para que ni el correo ni un token del visitante viajen a
     * Stripe ni queden en el historial. */
    function scrubOwnUrl(location, history) {
        if (!location || !history || typeof history.replaceState !== 'function') {
            return;
        }
        var dirty = (typeof location.search === 'string' && location.search.length > 1) ||
            (typeof location.hash === 'string' && location.hash.length > 1);
        if (!dirty) {
            return;
        }
        try {
            history.replaceState({}, '', location.pathname);
        } catch (error) {
            /* Si replaceState falla se redirige igualmente: la URL de destino
             * nunca incluye lo que venga en la nuestra. */
        }
    }

    return {
        PORTAL_HOST: PORTAL_HOST,
        PORTAL_PATH_PREFIX: PORTAL_PATH_PREFIX,
        isValidPortalUrl: isValidPortalUrl,
        portalUrlFromConfig: portalUrlFromConfig,
        scrubOwnUrl: scrubOwnUrl
    };
});