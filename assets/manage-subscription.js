/* Manage subscription — flujo de respaldo para abrir el Customer Portal de
 * RevenueCat desde la web de Brainy.
 *
 * Reglas de seguridad que este módulo hace cumplir:
 *   - El App User ID de RevenueCat sale EXCLUSIVAMENTE de `session.user.id`
 *     devuelto por Supabase tras `signInWithPassword`. Nunca de query params,
 *     hash, localStorage, formularios ni ningún dato controlado por el usuario.
 *   - La URL de destino sale EXCLUSIVAMENTE de `customerInfo.managementURL`
 *    devuelto por el RevenueCat Web SDK. Nunca se acepta una URL del llamador.
 *   - La contraseña nunca se guarda, no se registra en consola ni se persiste.
 *     Se borra del estado y del DOM en cuanto Supabase responde.
 *   - Este módulo no cancela nada: solo redirige al Customer Portal oficial.
 *   - No hay analytics ni beacons en esta página.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.BrainyManageSubscription = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    function isUuid(value) {
        return typeof value === 'string' && UUID_RE.test(value);
    }

    function isNonEmptyString(value) {
        return typeof value === 'string' && value.trim().length > 0;
    }

    function normalizeEmail(value) {
        return String(value == null ? '' : value).trim().toLowerCase();
    }

    function isValidHttpsUrl(value) {
        if (typeof value !== 'string') {
            return false;
        }
        var trimmed = value.trim();
        if (!trimmed || /\s/.test(trimmed)) {
            return false;
        }
        var parsed = null;
        try {
            parsed = new URL(trimmed);
        } catch (error) {
            return false;
        }
        return parsed.protocol === 'https:' && !!parsed.hostname;
    }

    // Clasificación de un fallo de red sin filtrar el mensaje del proveedor.
    // `kind: 'network'` es recuperable y NO debe cerrar la sesión.
    function looksLikeNetworkError(error) {
        if (!error) {
            return false;
        }
        var code = typeof error.errorCode === 'number' ? error.errorCode : null;
        // 10 = NETWORK_ERROR en purchases-js; 0 en GoTrue suele ser fetch fallido.
        if (code === 10) {
            return true;
        }
        var status = typeof error.status === 'number' ? error.status : null;
        if (status !== null && status >= 500) {
            return true;
        }
        var name = typeof error.name === 'string' ? error.name : '';
        if (name === 'TypeError') {
            return true;
        }
        var message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
        return message.indexOf('fetch') !== -1 ||
            message.indexOf('network') !== -1 ||
            message.indexOf('timeout') !== -1 ||
            message.indexOf('timed out') !== -1 ||
            message.indexOf('load failed') !== -1;
    }

    function readSessionUserId(sessionData) {
        var user = sessionData && sessionData.user;
        if (!user || typeof user !== 'object') {
            return null;
        }
        // Única fuente admitida: session.user.id.
        return isUuid(user.id) ? user.id : null;
    }

    /* Crea el controlador del flujo.
     *
     * deps:
     *   supabase   { auth: { signInWithPassword } }   cliente aislado, persistSession:false
     *   revenuecat { configure, getManagementURL, getSdkAppUserId }
     *   apiKey     RevenueCat Web SDK key pública
     *   navigate   function(url)  navegación en la MISMA pestaña
     *   clearPassword  function()  limpia el input de contraseña del DOM
     *   onState    function(state, detail)  notifica el estado a la vista
     */
    function createFlow(deps) {
        var supabase = deps.supabase;
        var revenuecat = deps.revenuecat;
        var apiKey = deps.apiKey;
        var navigate = deps.navigate;
        var clearPassword = deps.clearPassword || function () {};
        var onState = deps.onState || function () {};

        var busy = false;
        // Solo en memoria, y SOLO el UUID ya autenticado: permite reintentar el
        // paso de RevenueCat sin volver a pedir la contraseña. No se persiste.
        var verifiedUserId = null;

        function emit(state, detail) {
            onState(state, detail || {});
        }

        function isBusy() {
            return busy;
        }

        function hasVerifiedSession() {
            return isUuid(verifiedUserId);
        }

        function retryRevenueCatStep() {
            // Un error de red nunca debe cerrar la sesión: si ya hubo login
            // verificado, se reintenta solo el paso de RevenueCat.
            if (!busy && isUuid(verifiedUserId)) {
                return resolveManagementUrl(verifiedUserId);
            }
            return Promise.resolve(null);
        }

        function signIn(email, password) {
            if (busy) {
                return Promise.resolve('busy');
            }
            var normalizedEmail = normalizeEmail(email);
            if (!isNonEmptyString(normalizedEmail) || !isNonEmptyString(password)) {
                emit('form', { reason: 'missing_credentials' });
                return Promise.resolve('invalid');
            }
            if (!supabase || !supabase.auth || typeof supabase.auth.signInWithPassword !== 'function') {
                emit('unavailable', { reason: 'auth_unavailable' });
                return Promise.resolve('unavailable');
            }

            busy = true;
            emit('authenticating', {});

            return Promise.resolve(supabase.auth.signInWithPassword({
                email: normalizedEmail,
                password: password
            })).then(function (result) {
                // La contraseña se descarta del estado y del DOM de inmediato.
                clearPassword();
                if (!result || result.error) {
                    busy = false;
                    if (looksLikeNetworkError(result && result.error)) {
                        emit('network-error', { phase: 'auth' });
                        return 'network-error';
                    }
                    // Genérico: no revela si el correo existe.
                    emit('form', { reason: 'invalid_credentials' });
                    return 'invalid';
                }
                var userId = readSessionUserId(result.data);
                if (!userId) {
                    busy = false;
                    emit('unavailable', { reason: 'identity_missing' });
                    return 'unavailable';
                }
                verifiedUserId = userId;
                emit('configuring', {});
                return resolveManagementUrl(userId);
            }).catch(function () {
                clearPassword();
                busy = false;
                emit('network-error', { phase: 'auth' });
                return 'network-error';
            });
        }

        function resolveManagementUrl(userId) {
            if (!isUuid(userId)) {
                busy = false;
                emit('unavailable', { reason: 'identity_invalid' });
                return Promise.resolve('unavailable');
            }
            if (!revenuecat || typeof revenuecat.configure !== 'function' ||
                typeof revenuecat.getManagementURL !== 'function') {
                busy = false;
                emit('unavailable', { reason: 'revenuecat_unavailable' });
                return Promise.resolve('unavailable');
            }
            if (!isNonEmptyString(apiKey)) {
                busy = false;
                emit('unavailable', { reason: 'revenuecat_key_missing' });
                return Promise.resolve('unavailable');
            }

            var configured = null;
            try {
                configured = revenuecat.configure({ apiKey: apiKey, appUserId: userId });
            } catch (error) {
                busy = false;
                emit('unavailable', { reason: 'revenuecat_configuration_failed' });
                return Promise.resolve('unavailable');
            }
            if (!configured) {
                busy = false;
                emit('unavailable', { reason: 'revenuecat_configuration_failed' });
                return Promise.resolve('unavailable');
            }
            // Comprobación de que RevenueCat quedó con el UUID autenticado.
            if (typeof revenuecat.getSdkAppUserId === 'function') {
                if (revenuecat.getSdkAppUserId() !== userId) {
                    busy = false;
                    emit('unavailable', { reason: 'revenuecat_identity_mismatch' });
                    return Promise.resolve('unavailable');
                }
            }

            return Promise.resolve(revenuecat.getManagementURL()).then(function (url) {
                if (url === null || url === undefined) {
                    busy = false;
                    emit('no-subscription', {});
                    return 'no-subscription';
                }
                // Fail closed: la URL viene de RevenueCat, pero se revalida
                // aquí antes de navegar. Una URL no-HTTPS nunca se abre.
                if (!isValidHttpsUrl(url)) {
                    busy = false;
                    emit('invalid-url', {});
                    return 'invalid-url';
                }
                busy = false;
                emit('redirecting', {});
                navigate(url);
                return 'redirected';
            }).catch(function (error) {
                busy = false;
                // Fallo recuperable: no se cierra sesión, se ofrece Retry.
                if (looksLikeNetworkError(error)) {
                    emit('network-error', { phase: 'revenuecat' });
                    return 'network-error';
                }
                emit('unavailable', { reason: 'revenuecat_lookup_failed' });
                return 'unavailable';
            });
        }

        return {
            signIn: signIn,
            retryRevenueCatStep: retryRevenueCatStep,
            hasVerifiedSession: hasVerifiedSession,
            isBusy: isBusy
        };
    }

    /* Borra de la URL cualquier parámetro de identidad o de gestión. La página
     * jamás los lee: esta limpieza solo evita que queden visibles o en historial.
     */
    function scrubIdentityParams(location, history) {
        if (!history || typeof history.replaceState !== 'function' || !location) {
            return;
        }
        var removed = false;
        ['userId', 'user_id', 'appUserId', 'app_user_id', 'managementURL',
            'managementUrl', 'management_url', 'cancelUrl', 'email', 'token'
        ].forEach(function (key) {
            if (location.search && location.search.indexOf(key + '=') !== -1) {
                removed = true;
            }
        });
        if (typeof location.hash === 'string' && location.hash.length > 1) {
            removed = true;
        }
        if (removed) {
            history.replaceState({}, '', location.pathname);
        }
    }

    return {
        createFlow: createFlow,
        scrubIdentityParams: scrubIdentityParams,
        isValidHttpsUrl: isValidHttpsUrl,
        isUuid: isUuid,
        looksLikeNetworkError: looksLikeNetworkError,
        readSessionUserId: readSessionUserId,
        normalizeEmail: normalizeEmail
    };
});