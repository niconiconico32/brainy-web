# Manage subscription — manual sandbox procedure & email copy

This page is a **fallback** for the primary path (the "Manage subscription" link
that RevenueCat includes in the payment confirmation email).

- Primary path: the personal Customer Portal link in the payment confirmation email.
- Fallback path: `/manage-subscription/` — sign in with the Brainy credentials
  received by email, then the web opens the same RevenueCat Customer Portal.

The page never cancels anything. It only authenticates, resolves the Supabase
UUID, asks RevenueCat for `customerInfo.managementURL` and redirects there.

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

Confirmation steps in the RevenueCat Dashboard (do **not** be changed from this repo):

1. Confirm Web Billing is enabled and the Customer Portal is available for the
   RevenueCat project used by `brainyadhd.com`.
2. Confirm the sandbox production email for Web Billing payments includes the
   personal "Manage subscription" link pointing at the Customer Portal.
3. Confirm `subscriber.management_url` is populated for a sandbox subscriber with
   an active trial/subscription, which is what makes `customerInfo.managementURL`
   non-null.

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