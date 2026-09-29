/* Password recovery flow. Tokens stay in memory and are never logged. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.BrainyPasswordRecovery = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function invalidResult(error) {
        return { ok: false, state: 'invalid', error: error };
    }

    function parseRecoveryFragment(hash) {
        var raw = typeof hash === 'string' && hash.charAt(0) === '#' ? hash.slice(1) : '';
        var params = new URLSearchParams(raw);
        var type = params.get('type');
        var accessToken = params.get('access_token');
        var refreshToken = params.get('refresh_token');
        if (type !== 'recovery') return invalidResult('invalid_recovery_type');
        if (!accessToken || !refreshToken) return invalidResult('missing_recovery_tokens');
        return {
            ok: true,
            state: 'parsed',
            accessToken: accessToken,
            refreshToken: refreshToken
        };
    }

    function clearRecoveryFragment(history, location) {
        if (!history || typeof history.replaceState !== 'function' || !location) return;
        history.replaceState({}, '', location.pathname + location.search);
    }

    async function establishRecoverySession(client, hash, history, location) {
        var parsed = parseRecoveryFragment(hash);
        // Remove the fragment before any UI or later navigation can expose it.
        if (hash) clearRecoveryFragment(history, location);
        if (!parsed.ok) return parsed;
        if (!client || !client.auth || typeof client.auth.setSession !== 'function') {
            return invalidResult('auth_unavailable');
        }
        try {
            var result = await client.auth.setSession({
                access_token: parsed.accessToken,
                refresh_token: parsed.refreshToken
            });
            return result && result.error
                ? invalidResult('recovery_session_rejected')
                : { ok: true, state: 'ready' };
        } catch (error) {
            return invalidResult('recovery_session_rejected');
        }
    }

    async function updatePassword(client, password, confirmation) {
        if (!client || !client.auth || typeof client.auth.updateUser !== 'function') {
            return { ok: false, state: 'error', error: 'auth_unavailable' };
        }
        if (typeof password !== 'string' || password.length < 8) {
            return { ok: false, state: 'error', error: 'password_too_short' };
        }
        if (password !== confirmation) {
            return { ok: false, state: 'error', error: 'password_mismatch' };
        }
        try {
            var result = await client.auth.updateUser({ password: password });
            if (result && result.error) {
                return { ok: false, state: 'error', error: 'password_update_failed' };
            }
            if (typeof client.auth.signOut !== 'function') {
                return { ok: false, state: 'error', error: 'recovery_session_cleanup_failed' };
            }
            var signOut = await client.auth.signOut({ scope: 'local' });
            if (signOut && signOut.error) {
                return { ok: false, state: 'error', error: 'recovery_session_cleanup_failed' };
            }
            return { ok: true, state: 'complete' };
        } catch (error) {
            return { ok: false, state: 'error', error: 'password_update_failed' };
        }
    }

    return {
        parseRecoveryFragment: parseRecoveryFragment,
        clearRecoveryFragment: clearRecoveryFragment,
        establishRecoverySession: establishRecoverySession,
        updatePassword: updatePassword
    };
});
