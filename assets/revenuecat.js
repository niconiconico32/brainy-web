/* BrainyRevenueCat — servicio cliente de RevenueCat Web SDK para el funnel.
 *
 * Encapsula: identidad anónima persistente, configuración única, offerings,
 * compra con locales ES y clasificación de errores. Nunca maneja ni expone
 * claves privadas, tokens de redención ni datos de pago sensibles.
 */
(function () {
    'use strict';

    var ANON_ID_KEY = 'brainy_rc_anonymous_id';
    var instance = null;
    var configured = false;

    function sdk() {
        // window.Purchases es el namespace UMD; la clase con configure/statics
        // está en window.Purchases.Purchases (fallback por compat con tests).
        const g = (typeof window !== 'undefined' && window.Purchases) || null;
        return (g && g.Purchases) || g;
    }

    function isAvailable() {
        return !!sdk();
    }

    function getAnonymousId() {
        var existing = null;
        try {
            existing = localStorage.getItem(ANON_ID_KEY);
        } catch (e) {
            existing = null;
        }
        if (existing) {
            return existing;
        }
        var fresh = sdk().generateRevenueCatAnonymousAppUserId();
        try {
            localStorage.setItem(ANON_ID_KEY, fresh);
        } catch (e) {
            // sin localStorage: seguimos con la id recién generada
        }
        return fresh;
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
        if (!cfg || !cfg.apiKey) {
            return null;
        }
        if (!isSafePublicKey(cfg.apiKey)) {
            return null;
        }
        if (!isAvailable()) {
            return null;
        }
        if (configured && instance) {
            return instance;
        }
        instance = sdk().configure({
            apiKey: cfg.apiKey,
            appUserId: getAnonymousId()
        });
        configured = true;
        return instance;
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
        var params = {
            rcPackage: opts.rcPackage,
            customerEmail: opts.customerEmail,
            selectedLocale: opts.selectedLocale || 'es',
            defaultLocale: opts.defaultLocale || 'es'
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

    function redemptionUrlOf(result) {
        if (!result || !result.redemptionInfo) {
            return null;
        }
        return result.redemptionInfo.redeemUrl || result.redemptionInfo.redeemUrlRedirect || null;
    }

    window.BrainyRevenueCat = {
        isAvailable: isAvailable,
        keyKind: keyKind,
        isSafePublicKey: isSafePublicKey,
        configure: configure,
        getOfferings: getOfferings,
        isEntitledTo: isEntitledTo,
        purchase: purchase,
        classifyError: classifyError,
        redemptionUrlOf: redemptionUrlOf
    };
})();