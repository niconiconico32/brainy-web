/* BrainyRevenueCat — servicio cliente de RevenueCat Web SDK para el funnel.
 *
 * Encapsula: identidad Supabase verificada, configuración única, offerings,
 * compra con locales ES, clasificación de errores y la URL de gestión de la
 * suscripción (Customer Portal). Nunca maneja ni expone claves privadas,
 * tokens de redención ni datos de pago sensibles.
 */
(function () {
    'use strict';

    var instance = null;
    var configured = false;
    var configuredAppUserId = null;

    function sdk() {
        // window.Purchases es el namespace UMD; la clase con configure/statics
        // está en window.Purchases.Purchases (fallback por compat con tests).
        const g = (typeof window !== 'undefined' && window.Purchases) || null;
        return (g && g.Purchases) || g;
    }

    function isAvailable() {
        return !!sdk();
    }

    function keyKind(key) {
        if (!key || typeof key !== 'string') {
            return 'invalid';
        }
        if (/^(sk|rk|rp|whsec|tok|req)_/i.test(key)) {
            return 'secret';
        }
        if (/(secret|restricted)/i.test(key)) {
            return 'secret';
        }
        return 'ok';
    }

    function isSafePublicKey(key) {
        return keyKind(key) === 'ok';
    }

    function configure(cfg) {
        if (!cfg || !cfg.apiKey || !cfg.appUserId) {
            return null;
        }
        if (!isSafePublicKey(cfg.apiKey)) {
            return null;
        }
        if (!isAvailable()) {
            return null;
        }
        if (configured && instance) {
            if (configuredAppUserId !== cfg.appUserId) {
                throw new Error('RevenueCat is already configured for a different App User ID');
            }
            var currentSdkUserId = getSdkAppUserId();
            if (currentSdkUserId && currentSdkUserId !== cfg.appUserId) {
                throw new Error('RevenueCat SDK identity does not match the verified Supabase user');
            }
            return instance;
        }
        instance = sdk().configure({
            apiKey: cfg.apiKey,
            appUserId: cfg.appUserId
        });
        configured = true;
        configuredAppUserId = cfg.appUserId;
        var configuredSdkUserId = getSdkAppUserId();
        if (configuredSdkUserId && configuredSdkUserId !== cfg.appUserId) {
            throw new Error('RevenueCat SDK rejected the verified Supabase identity');
        }
        return instance;
    }

    function getSdkAppUserId() {
        if (!instance || typeof instance.getAppUserId !== 'function') {
            return null;
        }
        var value = instance.getAppUserId();
        return typeof value === 'string' && value ? value : null;
    }

    function getOffering(offerings, preferredId) {
        if (!offerings) {
            return null;
        }
        if (preferredId && offerings.all && offerings.all[preferredId]) {
            return offerings.all[preferredId];
        }
        return offerings.current || null;
    }

    function getOfferings(preferredId) {
        if (!instance) {
            return Promise.resolve(null);
        }
        return instance.getOfferings().then(function (offerings) {
            return getOffering(offerings, preferredId);
        });
    }

    function getCustomerInfo() {
        if (!instance || typeof instance.getCustomerInfo !== 'function') {
            return Promise.reject(new Error('RevenueCat customer info is unavailable'));
        }
        return instance.getCustomerInfo();
    }

    // Contrato verificado contra el SDK vendorizado (purchases-js 1.60.1) y sus
    // tipos (`CustomerInfo.managementURL: string | null`):
    //   - método de customer info: `instance.getCustomerInfo()` -> Promise<CustomerInfo>
    //   - propiedad de la URL de gestión: `customerInfo.managementURL`
    //     (mapeada desde `subscriber.management_url`; null cuando no existe)
    // No hay ningún método `manageSubscription`/`cancel` en el Web SDK: la
    // cancelación se hace exclusivamente en el Customer Portal que abre esa URL.
    function isValidManagementUrl(value) {
        if (typeof value !== 'string') {
            return false;
        }
        var trimmed = value.trim();
        if (!trimmed) {
            return false;
        }
        var parsed = null;
        try {
            parsed = new URL(trimmed);
        } catch (error) {
            return false;
        }
        // Fail closed: solo Customer Portal HTTPS. Nada de http:, javascript:,
        // data: ni esquemas propios.
        return parsed.protocol === 'https:' && !!parsed.hostname && !/\s/.test(trimmed);
    }

    // Devuelve la URL HTTPS del Customer Portal para el App User ID configurado,
    // o `null` si RevenueCat no expone ninguna. Nunca compra, nunca consulta
    // offerings, nunca restaura compras, nunca toca entitlements y nunca acepta
    // una URL aportada por el llamador.
    function getManagementURL() {
        if (!instance) {
            return Promise.reject(new Error('RevenueCat is not configured'));
        }
        var appUserId = getSdkAppUserId();
        if (!isUuid(appUserId)) {
            return Promise.reject(new Error('RevenueCat management URL requires a valid UUID App User ID'));
        }
        return getCustomerInfo().then(function (customerInfo) {
            if (!customerInfo || typeof customerInfo !== 'object') {
                return null;
            }
            var url = customerInfo.managementURL;
            return isValidManagementUrl(url) ? url.trim() : null;
        });
    }

    function isUuid(value) {
        return typeof value === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    }

    function isValidPlanId(planId) {
        return isUuid(planId);
    }

    function isEntitledTo(customerInfo, entitlementId) {
        return !!(
            customerInfo &&
            customerInfo.entitlements &&
            customerInfo.entitlements.active &&
            customerInfo.entitlements.active[entitlementId] &&
            customerInfo.entitlements.active[entitlementId].isActive
        );
    }

    function purchase(opts) {
        if (!opts || !isValidPlanId(opts.planId)) {
            return Promise.reject(new Error('purchase_requires_real_plan_id'));
        }
        var params = {
            rcPackage: opts.rcPackage,
            customerEmail: opts.customerEmail,
            selectedLocale: opts.selectedLocale || 'es',
            defaultLocale: opts.defaultLocale || 'es',
            metadata: { brainy_plan_id: opts.planId }
        };
        if (opts.termsAndConditionsUrl) {
            params.termsAndConditionsUrl = opts.termsAndConditionsUrl;
        }
        return instance.purchase(params);
    }

    function classifyError(err) {
        if (!err) {
            return { kind: 'unknown', code: null, isCancel: false };
        }
        var code = typeof err.errorCode === 'number' ? err.errorCode : null;
        var isCancel = code === 1;
        var isNetwork = code === 10;
        return {
            kind: isCancel ? 'cancel' : (isNetwork ? 'network' : 'other'),
            code: code,
            isCancel: isCancel
        };
    }

    // Extrae el Redemption URL de PurchaseResult.redemptionInfo.
    // Estructura real de purchases-js 1.60.1:
    //   RedemptionInfo { redeemUrl: string | null; redeemUrlRedirect?: string | null }
    // Defensivo: acepta solo strings no vacíos con esquema (rc-...://, https://, …).
    // No se inventan propiedades: solo `redeemUrl` y `redeemUrlRedirect`.
    function firstValidRedemptionUrl(candidates) {
        for (var i = 0; i < candidates.length; i++) {
            var value = candidates[i];
            if (typeof value === 'string') {
                var trimmed = value.trim();
                if (trimmed && /^[a-z][a-z0-9+.\-]*:\/\//i.test(trimmed)) {
                    return trimmed;
                }
            }
        }
        return null;
    }

    function redemptionUrlOf(result) {
        var info = result && result.redemptionInfo;
        if (!info || typeof info !== 'object') {
            return null;
        }
        return firstValidRedemptionUrl([info.redeemUrl, info.redeemUrlRedirect]);
    }

    // Persistencia server-side: usa SOLO `redeemUrl` (el backend ignora
    // redeemUrlRedirect). Si el único enlace disponible es el redirect,
    // devuelve null para NO persistir una URL no canónica.
    function primaryRedemptionUrlOf(result) {
        var info = result && result.redemptionInfo;
        if (!info || typeof info !== 'object') {
            return null;
        }
        return firstValidRedemptionUrl([info.redeemUrl]);
    }

    window.BrainyRevenueCat = {
        isAvailable: isAvailable,
        keyKind: keyKind,
        isSafePublicKey: isSafePublicKey,
        configure: configure,
        getSdkAppUserId: getSdkAppUserId,
        getOfferings: getOfferings,
        getCustomerInfo: getCustomerInfo,
        isUuid: isUuid,
        isValidManagementUrl: isValidManagementUrl,
        getManagementURL: getManagementURL,
        isValidPlanId: isValidPlanId,
        isEntitledTo: isEntitledTo,
        purchase: purchase,
        classifyError: classifyError,
        redemptionUrlOf: redemptionUrlOf,
        primaryRedemptionUrlOf: primaryRedemptionUrlOf
    };
})();
