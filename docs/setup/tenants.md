# Tenants, members and access

A family is a tenant. Its `family_id` scopes product, membership and billing data. The application currently reserves at most one membership per authentication account, including revoked access. There is no tenant switcher, cross-household transfer, owner-transfer UI or self-service account merge.

## 1. Enable the required features

Apply migrations 001–011 and complete [authentication setup](platform.md). Enable `MEMBERSHIP_ACCESS_ENABLED` for membership claims/provisioning and `MEMBER_VIEWS_ENABLED` for member pages after acceptance. Public creation additionally requires `SELF_SERVICE_SIGNUP_ENABLED=true`. Keep signup closed until [billing and entitlement setup](stripe.md) is ready to serve customers.

Existing households are migrated as legacy families without changing their participant or ledger IDs. An existing Owner signs in and resumes that same family; do not create a replacement tenant or seed demo data to recover access.

## 2. Create a new tenant explicitly

1. Sign in through `/login` using a verified Google account or enabled email OTP.
2. An eligible unassociated identity sees the explicit family-creation action. `/me` never creates a family. If signup is disabled, creation is unavailable; if the address/account is reserved or revoked, resolve the existing membership through authorized support.
3. Submit family name, responsible name and relationship. The browser calls `POST /api/v1/families` with a UUID `Idempotency-Key`. One transaction creates the profile, family, OWNER membership and request association. Retry the same body/key after transport failures; a different body with that key conflicts.
4. Resume saved profile through `GET`/`PATCH /api/v1/family/onboarding` and `/onboarding`. A profile-complete unpaid draft goes to `/subscribe`.
5. Complete Checkout. The billing worker must verify matching payment facts and commit the entitlement projection and activation receipt before the same family becomes ESTABLISHED and `/me` allows the dashboard. Closing Checkout or refreshing never grants access.

Do not set lifecycle or entitlement rows manually to simulate a purchase. For development without payment, use a separate disposable demo environment and the documented optional seed; it does not verify SaaS onboarding.

## 3. Add participants and optional login access

1. As an Owner or authorized Manager with write access, open Members and add a participant with name, type and optional profile details.
2. Enable login access only for the intended person's verified mailbox and choose MANAGER or MEMBER. Participant type (for example CHILD) does not assign authorization role.
3. Have that person sign in with the configured mailbox using Google or email OTP. The backend resolves the verified provider identity and claims the existing provisioned membership; the user should arrive in the intended family with the assigned role.
4. Verify their own history and allowed navigation, then test management denial for a Member. Login alone cannot elevate a role, change family or restore revoked access.

| Role | With writable entitlement | With established read-only entitlement |
| --- | --- | --- |
| OWNER | Product management, member access, owner onboarding and billing | Authorized views/history, billing recovery and narrow security revocation |
| MANAGER | Authorized product/member management; no owner billing or ownership changes | Authorized management reads/history and narrow security revocation |
| MEMBER | Personal dashboard/points/history, permitted shared board, standings, catalog and view-only Wall | Same authorized read views; never product mutations or private member history |

The backend's capabilities are authoritative. A subscription never overrides an inactive/revoked membership. Member views preserve privacy across read-only transitions; they do not expose individual foreign ledger entries or private completion actors.

## 4. Manage mailbox changes and revocation

Revoke through the member access controls when login should stop. In read-only mode, the narrow revoke operation checks `expectedVersion` and permits only revocation; it cannot grant access, edit a profile or increase a role. Revocation preserves participant IDs, task/points history and audit records. Concurrent revocation and product writes serialize in the database.

Replacing an already claimed login mailbox requires confirmation. Configure `ACCESS_EMAIL_DELIVERY_URL`, `ACCESS_EMAIL_DELIVERY_TOKEN` and `PUBLIC_APP_URL` on the backend; this is a separate authenticated HTTPS delivery adapter, not the Supabase SMTP configuration used for OTP. The app sends the delivery request described in the [membership rollout contract](../implementation/01-membership-rollout.md). Preserve `/access-email-confirm` routing and test the new mailbox before relying on this workflow. Do not rebind an app-user based only on email equality.

## 5. Understand tenant states

| State | Expected behavior |
| --- | --- |
| Unassociated identity | NO_ACCESS; explicit create action only if eligible and signup is enabled |
| Incomplete owner profile | ONBOARDING_REQUIRED; resume same tenant |
| Profile-complete unpaid draft | PAYMENT_REQUIRED; owner subscribes, other roles wait |
| Paid/trial/grace or eligible legacy access | READY with role-dependent capabilities |
| Established expired/restricted entitlement | READY with read-only product capabilities; owner billing remains available |
| Missing/unavailable entitlement projection | Product access fails closed; authenticated owner can recover through `/billing` |
| Revoked/inactive membership | Access denied independently of payment |

Exact deadlines and trial availability come from the published environment policy. Migration access is temporary policy, never evidence of a Stripe payment. Once converted, a family cannot regain legacy access when payment ends.

## 6. Roll out existing tenants

Record legacy cohorts, communicate the approved deadline and publish the reviewed entitlement policy. Enroll reviewed families using the privileged worker CLI in the [entitlement runbook](../implementation/06-subscription-entitlements-rollout.md). Enrollment pins the legacy deadline; disabling a global switch does not restore indefinite access. Exceptions require an explicit expiry and incident/review reference and cannot activate a draft.

## Troubleshooting

- Wrong/no family after login: inspect `/me` with the current session; verify provider project, verified mailbox, subject binding and membership status. Never infer ownership from billing email.
- Creation unavailable: check signup eligibility and `SELF_SERVICE_SIGNUP_ENABLED`; existing/reserved members resume their membership.
- Payment complete but draft persists: inspect worker, billing recognition, quarantine and activation receipt, following [Stripe recovery](stripe.md).
- Buttons disappear after expiry: expected read-only behavior. The Owner opens billing; Managers cannot purchase for the tenant.
- Identity conflict: use the reviewed support process in the membership/OTP guides. There is no automatic subject-transfer recovery UI.
