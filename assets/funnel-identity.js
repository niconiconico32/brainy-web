/* Web funnel identity helpers. No credentials are logged or persisted here. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.BrainyFunnelIdentity = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function isNonEmptyString(value) {
        return typeof value === 'string' && value.trim().length > 0;
    }

    function normalizeEmail(value) {
        return String(value || '').trim().toLowerCase();
    }

    async function prepareFunnelAccount(options) {
        var fetchImpl = options && options.fetchImpl;
        var url = options && options.url;
        var planId = options && options.planId;
        var claimToken = options && options.claimToken;
        var email = options && options.email;
        if (!fetchImpl || !isNonEmptyString(url) || !isNonEmptyString(planId) ||
            !isNonEmptyString(claimToken) || !isNonEmptyString(email)) {
            return { ok: false, error: 'invalid_prepare_request' };
        }

        try {
            var response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': options.anonKey || ''
                },
                body: JSON.stringify({ planId: planId, claimToken: claimToken, email: normalizeEmail(email) })
            });
            var data = null;
            try { data = await response.json(); } catch (e) { data = null; }
            if (!response.ok || !data || !isNonEmptyString(data.userId)) {
                return { ok: false, error: response.ok ? 'identity_missing' : 'prepare_failed' };
            }
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.userId)) {
                return { ok: false, error: 'identity_invalid' };
            }
            return {
                ok: true,
                userId: data.userId,
                alreadyPro: data.alreadyPro === true,
                accountState: isNonEmptyString(data.accountState) ? data.accountState : null,
            };
        } catch (error) {
            return { ok: false, error: 'prepare_network_error' };
        }
    }

    return {
        prepareFunnelAccount: prepareFunnelAccount
    };
});
