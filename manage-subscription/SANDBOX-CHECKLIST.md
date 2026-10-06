# Manage subscription — manual sandbox procedure & email copy

This page is a **fallback** for the primary path (the "Manage subscription" link
that RevenueCat includes in the payment confirmation email).

- Primary path: the personal Customer Portal link in the payment confirmation email.
- Fallback path: `/manage-subscription/` — sign in with the Brainy credentials
  received by email, then the web opens the same RevenueCat Customer Portal.

The page never cancels anything. It only authenticates, resolves the Supabase
UUID, asks RevenueCat for `customerInfo.managementURL` and redirects there.

It also hosts the **password reset request** flow: "Forgot your password?" opens
a form inside `/manage-subscription/` that calls
`supabase.auth.resetPasswordForEmail(email, { redirectTo: 'https://brainyadhd.com/reset-password/' })`.
It does **not** navigate to `/reset-password/`, because that page only consumes a
recovery callback that must already exist. The response is always the same
generic message, so the page cannot be used to discover whether an email is
registered.

---

## 1. Copy to add to the credentials / payment confirmation email

Add this block to the backend email that delivers the Brainy credentials
(the mobile/backend repository owns that template; this web repository does not):

> Manage your subscription
>
> You can cancel your free trial or subscription at any time using the
> "Manage subscription" link in your payment confirmation email or by visiting:
>
> https://brainyadhd.com/manage-subscription/
>
> Cancelling stops future renewals. You'll keep access until the end of your
> current free trial or billing period.

The Spanish equivalent for localized templates:

> Gestiona tu suscripción
>
> Puedes cancelar tu prueba gratuita o suscripción cuando quieras usando el enlace
> "Gestionar suscripción" del correo de confirmación de pago o visiting:
>
> https://brainyadhd.com/manage-subscription/
>
> Al cancelar se detienen las renovaciones futuras. Conservarás el acceso hasta
> que termine tu prueba gratuita o tu periodo de facturación actual.

### Owner and status

| Item | Owner | Status |
| --- | --- | --- |
| Credentials email template | backend / mobile repo | **pending** — not in this repo |
| Customer Portal link inside the payment confirmation email | RevenueCat Dashboard | **unverified** — must be confirmed manually |
| RevenueCat Customer Portal enabled for the project | RevenueCat Dashboard | **unverified** — must be confirmed manually |
| `https://brainyadhd.com/reset-password/` allowed as a Supabase Auth redirect URL | Supabase Dashboard | **unverified** — must be confirmed manually |
| Recovery email template sends the personal recovery link | Supabase Dashboard | **unverified** — must be confirmed manually |

Confirmation steps in the RevenueCat Dashboard (do **not** be changed from this repo):

1. Confirm Web Billing is enabled and the Customer Portal is available for the
   RevenueCat project used by `brainyadhd.com`.
2. Confirm the sandbox production email for Web Billing payments includes the
   personal "Manage subscription" link pointing at the Customer Portal.
3. Confirm `subscriber.management_url` is populated for a sandbox subscriber with
   an active trial/subscription, which is what makes `customerInfo.managementURL`
   non-null.

Confirmation steps in the Supabase Dashboard (do **not** be changed from this repo):

1. Confirm `https://brainyadhd.com/reset-password/` is listed under
   **Authentication → URL Configuration → Redirect URLs**, otherwise
   `resetPasswordForEmail` silently falls back to `SITE_URL` and the recovery
   link never reaches `/reset-password/`.
2. Confirm the **Reset Password** email template renders the personal recovery
   link, so the message "Open the link in your browser" is truthful.
3. Confirm the recovery link shape matches what `reset-password/` already parses:
   a URL fragment with `type=recovery`, `access_token` and `refresh_token`
   (see `assets/reset-password.js` → `parseRecoveryFragment`). This repo did not
   change `/reset-password/`; if the project is configured for the PKCE flow
   (`?code=` in the query string) instead, that is a **pre-existing** mismatch in
   the callback contract, not something introduced here, and must be raised
   before changing anything.

---

## 2. Manual sandbox procedure (DO NOT RUN without authorization)

None of the steps below have been executed. Everything in this repository was
verified with local mocks only.

Prerequisites:

- A sandbox Brainy account whose credentials were delivered by email.
- A sandbox RevenueCat subscription (trial active) for that account's Supabase UUID.
- `revenuecatWebApiKey` on `manage-subscription/index.html` set to the RevenueCat
  **sandbox** Web SDK key (currently `strp_sb_…`, injected via
  `window.__BRAINY_MANAGE_SUBSCRIPTION_CONFIG__`).

| # | Step | Expected result |
| --- | --- | --- |
| 1 | Open `https://brainyadhd.com/manage-subscription/` and sign in with the email credentials. | The button disables with a spinner, then the status changes to "Looking up your subscription." |
| 2 | Confirm RevenueCat receives the Supabase UUID. | The App User ID used by the Web SDK equals `session.user.id`. Verifiable in the browser network panel: `GET https://api.revenuecat.com/v1/subscribers/<supabase-uuid>` is issued with the sandbox key header. |
| 3 | Confirm the Customer Portal opens. | The browser navigates (same tab) to the RevenueCat Customer Portal URL returned as `managementURL`. No popup is used, so popup blockers do not interfere. |
| 4 | Cancel the sandbox trial from the Customer Portal. | RevenueCat shows the subscription as cancelled / renewal off. |
| 5 | Confirm the renewal is disabled. | RevenueCat reflects the subscription with renewal turned off. |
| 6 | Confirm the entitlement survives until expiry. | Access continues until the end of the current free trial or billing period. |
| 7 | Confirm RevenueCat reflects `willRenew: false`. | `GET /v1/subscribers/<uuid>` reports `will_renew: false` for the subscription. |
| 8 | Confirm nothing was deleted manually. | No user, plan or entitlement is deleted from Supabase, RevenueCat or Stripe as part of this flow. |
| 9 | Confirm no second credentials email is sent. | Cancelling through the Customer Portal does not trigger the backend credentials email again. |

Negative checks to run in the same sandbox account:

- An account **without** an active subscription must land on
  "We couldn't find an active subscription for this account." with a Retry
  button and a support contact, and must not navigate anywhere.
- A wrong password must show only
  "We couldn't sign you in. Check your email and password and try again."
- Visiting `/manage-subscription/?userId=<other-uuid>&managementURL=https://example.com`
  must be ignored: the params are stripped from the URL and the flow still uses
  the authenticated session's UUID.

### Password reset request

| # | Step | Expected result |
| --- | --- | --- |
| 10 | Click "Forgot your password?" on `/manage-subscription/`. | No navigation. A reset request view opens with an Email field, "Send reset link" and "Back to subscription login". |
| 11 | Submit a **registered** email. | "Check your inbox" + "If an account exists for this email, we've sent a password reset link…". A recovery email arrives. |
| 12 | Submit an **unregistered** email. | **Byte-identical** response to step 11. No email arrives. Nothing on screen differs. |
| 13 | Open the link from step 11. | The browser lands on `https://brainyadhd.com/reset-password/#access_token=…&refresh_token=…&type=recovery` and shows the "Restablecer contraseña" form. |
| 14 | Set a new password and reopen `/manage-subscription/`. | The new password works on the login form. |
| 15 | Submit `nope`, `a@`, `a b@c.co`. | "Enter a valid email address." and no request is sent to Supabase. |
| 16 | Disable the network and submit a valid email. | "Connection problem" with Retry and Back to subscription login; no navigation, no account data revealed. |
| 17 | After any reset step, check DevTools. | `localStorage`, `sessionStorage` and cookies are empty, the URL contains no email, and the console prints nothing. |