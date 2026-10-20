# Documentation

The six feature implementations are merged. Start with the current setup guides; individual implementation guides retain historical test evidence and more detailed recovery procedures. Provider configuration and production activation remain environment-specific operations.

## Configuration, in order

1. [Platform, Supabase and deployment](setup/platform.md).
2. [Tenants, memberships and roles](setup/tenants.md).
3. [Stripe, entitlement policy and worker](setup/stripe.md).
4. [Environment reference](setup/environment.md).

## Feature rollout and recovery

| Feature | Detailed guide |
| --- | --- |
| Membership identities, roles and mailbox replacement | [01 membership](implementation/01-membership-rollout.md) |
| Email OTP, SMTP and abuse controls | [02 email OTP](implementation/02-email-otp-rollout.md) |
| Member views, privacy and paged history | [03 member dashboard](implementation/03-member-dashboard-rollout.md) |
| Explicit drafts and idempotent onboarding | [04 tenant onboarding](implementation/04-tenant-onboarding-rollout.md) |
| Stripe evidence, inbox and reconciliation | [05 billing](implementation/05-stripe-billing-rollout.md) |
| Entitlement enforcement, cohorts and bounded exceptions | [06 entitlements](implementation/06-subscription-entitlements-rollout.md) |

Design background: [PRD](product/PRD-family-access-and-saas.md) and [specification index](specifications/README.md). Product proposals in the design documents are not default deployment values. Actual commercial configuration comes from environment variables and provider records.
