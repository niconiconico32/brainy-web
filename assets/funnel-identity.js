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

    async function requestOtp(client, email) {
        if (!client || !client.auth || !isNonEmptyString(email)) {
            return { ok: false, error: 'invalid_request' };
        }
        var result = await client.auth.signInWithOtp({
            email: normalizeEmail(email),
            options: { shouldCreateUser: true }
        });
        return result && result.error
            ? { ok: false, error: 'otp_request_failed' }
            : { ok: true };
    }

    async function verifiedUser(client) {
        if (!client || !client.auth || typeof client.auth.getUser !== 'function') {
            return null;
        }
        var result = await client.auth.getUser();
        var user = result && result.data && result.data.user;
        return !result.error && user && isNonEmptyString(user.id) ? user : null;
    }

    async function verifyOtp(client, email, token) {
        if (!client || !client.auth || !isNonEmptyString(email) || !/^\d{6}$/.test(String(token).trim())) {
            return { ok: false, error: 'invalid_otp' };
        }
        var result = await client.auth.verifyOtp({
            email: normalizeEmail(email),
            token: String(token).trim(),
            type: 'email'
        });
        if (result && result.error) {
            return { ok: false, error: 'otp_verify_failed' };
        }
        var user = await verifiedUser(client);
        return user ? { ok: true, user: user } : { ok: false, error: 'session_unavailable' };
    }

    async function prepareFunnelAccount(options) {
        var client = options && options.client;
        var fetchImpl = options && options.fetchImpl;
        var url = options && options.url;
        var planId = options && options.planId;
        var claimToken = options && options.claimToken;
        var email = options && options.email;
        if (!client || !fetchImpl || !isNonEmptyString(url) || !isNonEmptyString(planId) ||
            !isNonEmptyString(claimToken) || !isNonEmptyString(email)) {
            return { ok: false, error: 'invalid_prepare_request' };
        }

        try {
            var sessionResult = await client.auth.getSession();
            var session = sessionResult && sessionResult.data && sessionResult.data.session;
            var user = await verifiedUser(client);
            if (!session || !session.access_token || !session.user || !session.user.id || !user ||
                user.id !== session.user.id || normalizeEmail(user.email) !== normalizeEmail(email)) {
                return { ok: false, error: 'session_unavailable' };
            }

            var response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': options.anonKey || '',
                    'Authorization': 'Bearer ' + session.access_token
                },
                body: JSON.stringify({ planId: planId, claimToken: claimToken, email: normalizeEmail(email) })
            });
            var data = null;
            try { data = await response.json(); } catch (e) { data = null; }
            if (!response.ok || !data || !isNonEmptyString(data.userId) || data.userId !== user.id) {
                return { ok: false, error: response.ok ? 'identity_mismatch' : 'prepare_failed' };
            }
            return { ok: true, userId: data.userId, session: session };
        } catch (error) {
            return { ok: false, error: 'prepare_network_error' };
        }
    }

    return {
        requestOtp: requestOtp,
        verifyOtp: verifyOtp,
        verifiedUser: verifiedUser,
        prepareFunnelAccount: prepareFunnelAccount
    };
});
