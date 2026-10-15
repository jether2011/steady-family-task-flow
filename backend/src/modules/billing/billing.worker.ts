import type Stripe from 'stripe';
import { env } from '../../config/env.js';
import { getServiceRoleClient } from '../../config/supabase.js';
import { billingRpc as accessRpc } from './billing.repository.js';
import {
  iso,
  refId,
  stripeClient,
  verifyMerchant,
  providerUrl,
} from './billing.provider.js';
import type {
  BillingAccount,
  CheckoutAttempt,
  InboxEvent,
  SubscriptionFacts,
} from './billing.types.js';
class Quarantine extends Error {}
function assertBilling(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Quarantine(reason);
}
export async function attemptsFor(account: string) {
  const { data, error } = await getServiceRoleClient()
    .from('billing_checkout_attempts')
    .select('*')
    .eq('account_id', account)
    .order('created_at');
  if (error) throw error;
  return data as CheckoutAttempt[];
}
async function finish(
  a: BillingAccount,
  customer?: string,
  t?: CheckoutAttempt,
  session?: Record<string, unknown>,
) {
  await accessRpc('billing_finish_operation', {
    p_id: a.id,
    p_token: a.lease_token,
    p_version: a.version,
    ...(customer ? { p_customer: customer } : {}),
    ...(t ? { p_attempt: t.id, p_session: session } : {}),
  });
}
function matchesMode(object: { livemode: boolean }) {
  return object.livemode === (env.STRIPE_MODE === 'LIVE');
}
async function customerFor(a: BillingAccount) {
  const stripe = stripeClient();
  let id = a.customer_id;
  if (!id) {
    if (Date.now() - Date.parse(a.created_at) >= 23 * 3600000) {
      const found = await stripe.customers.search({
        query: `metadata['billing_account']:'${a.id}'`,
        limit: 100,
      });
      assertBilling(
        !found.has_more && found.data.length === 1,
        'CUSTOMER_OPERATION_AMBIGUOUS',
      );
      id = found.data[0]!.id;
    } else {
      const created = await stripe.customers.create(
        { metadata: { billing_account: a.id, family: a.family_id } },
        { idempotencyKey: `customer:${a.id}` },
      );
      id = created.id;
    }
    await finish(a, id);
    a.customer_id = id;
  }
  const customer = await stripe.customers.retrieve(id);
  assertBilling(
    !customer.deleted &&
      matchesMode(customer) &&
      customer.metadata.billing_account === a.id &&
      customer.metadata.family === a.family_id,
    'CUSTOMER_LINK_MISMATCH',
  );
  return id;
}
async function checkoutSession(
  a: BillingAccount,
  t: CheckoutAttempt,
  customer: string,
) {
  const stripe = stripeClient();
  let session: Stripe.Checkout.Session;
  if (t.session_id) {
    session = await stripe.checkout.sessions.retrieve(t.session_id);
  } else {
    if (Date.now() - Date.parse(t.created_at) >= 23 * 3600000) {
      const sessions = await stripe.checkout.sessions
        .list({ customer, limit: 100 })
        .autoPagingToArray({ limit: 100 });
      const found = sessions.filter((s) => s.metadata?.attempt === t.id);
      assertBilling(found.length === 1, 'CHECKOUT_OPERATION_AMBIGUOUS');
      session = found[0]!;
    } else {
      const p = t.parameters;
      session = await stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer,
          client_reference_id: t.id,
          line_items: [{ price: p.price, quantity: 1 }],
          allowed_payment_method_types: ['card'],
          automatic_tax: { enabled: p.automaticTax },
          allow_promotion_codes: false,
          consent_collection: { terms_of_service: 'required' },
          success_url: new URL('/billing/return?attempt=' + t.id, p.origin)
            .href,
          cancel_url: new URL('/subscribe?checkout=canceled', p.origin).href,
          metadata: {
            family: a.family_id,
            attempt: t.id,
            billing_account: a.id,
          },
          subscription_data: {
            metadata: {
              family: a.family_id,
              attempt: t.id,
              billing_account: a.id,
            },
          },
        },
        { idempotencyKey: `checkout:${t.id}` },
      );
    }
  }
  assertBilling(
    matchesMode(session) &&
      refId(session.customer) === customer &&
      session.mode === 'subscription' &&
      session.client_reference_id === t.id &&
      session.metadata?.family === a.family_id &&
      session.metadata.attempt === t.id &&
      session.metadata.billing_account === a.id,
    'SESSION_LINK_MISMATCH',
  );
  const state =
    session.status === 'expired'
      ? 'EXPIRED'
      : session.status === 'complete'
        ? 'COMPLETED'
        : 'OPEN';
  await finish(a, undefined, t, {
    id: session.id,
    state,
    ...(session.url ? { url: providerUrl(session.url, 'checkout') } : {}),
    expiresAt: iso(session.expires_at),
    subscription: refId(session.subscription),
  });
  t.session_id = session.id;
  t.subscription_id = refId(session.subscription);
  t.state = state;
}
/** API-version-specific settled-invoice evidence; active status is insufficient. */
export async function paidEvidence(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  customer: string,
) {
  const stripe = stripeClient();
  if (
    invoice.status !== 'paid' ||
    !invoice.status_transitions.paid_at ||
    invoice.collection_method !== 'charge_automatically' ||
    invoice.amount_due <= 0 ||
    invoice.amount_paid < invoice.amount_due ||
    (invoice.amount_paid_off_stripe ?? 0) > 0 ||
    refId(invoice.customer) !== customer ||
    refId(invoice.parent?.subscription_details?.subscription) !==
      subscription.id ||
    !matchesMode(invoice)
  )
    return null;
  const payments = await stripe.invoicePayments
    .list({ invoice: invoice.id, status: 'paid', limit: 100 })
    .autoPagingToArray({ limit: 100 });
  let settled = 0;
  for (const payment of payments) {
    if (payment.payment.type !== 'payment_intent') continue;
    const pi = await stripe.paymentIntents.retrieve(
      refId(payment.payment.payment_intent)!,
      { expand: ['latest_charge'] },
    );
    const charge = pi.latest_charge;
    assertBilling(
      typeof charge !== 'string' &&
        charge &&
        !charge.disputed &&
        !charge.refunded &&
        charge.amount_refunded === 0,
      'PAYMENT_REVIEW_REQUIRED',
    );
    if (
      pi.status === 'succeeded' &&
      pi.currency === invoice.currency &&
      refId(pi.customer) === customer &&
      matchesMode(pi) &&
      charge.paid &&
      charge.captured
    )
      settled += payment.amount_paid ?? 0;
  }
  if (settled < invoice.amount_due) return null;
  const lines = await stripe.invoices
    .listLineItems(invoice.id, { limit: 100 })
    .autoPagingToArray({ limit: 100 });
  const matching = lines.filter(
    (l) =>
      refId(l.subscription) === subscription.id &&
      l.pricing?.price_details?.price ===
        subscription.items.data[0]?.price.id &&
      !l.parent?.subscription_item_details?.proration &&
      l.quantity === 1,
  );
  return matching.length
    ? iso(Math.max(...matching.map((l) => l.period.end)))
    : null;
}
async function snapshots(
  a: BillingAccount,
  customer: string,
  attempts: CheckoutAttempt[],
) {
  const stripe = stripeClient();
  const subs = await stripe.subscriptions
    .list({ customer, status: 'all', limit: 100 })
    .autoPagingToArray({ limit: 100 });
  const facts: SubscriptionFacts[] = [];
  let alert: string | null = null;
  for (const sub of subs) {
    const attempt = attempts.find((t) => t.id === sub.metadata.attempt);
    assertBilling(
      matchesMode(sub) &&
        refId(sub.customer) === customer &&
        sub.metadata.family === a.family_id &&
        sub.metadata.billing_account === a.id &&
        attempt &&
        attempt.subscription_id === sub.id &&
        attempt.session_id,
      'SUBSCRIPTION_LINK_MISMATCH',
    );
    assertBilling(
      [
        'active',
        'past_due',
        'canceled',
        'unpaid',
        'paused',
        'incomplete',
        'incomplete_expired',
        'trialing',
      ].includes(sub.status),
      'UNKNOWN_PROVIDER_STATUS',
    );
    const item = sub.items.data[0];
    assertBilling(
      item &&
        !sub.items.has_more &&
        sub.items.data.length === 1 &&
        item.price.id === attempt.parameters.price &&
        item.quantity === 1 &&
        sub.collection_method === 'charge_automatically',
      'SUBSCRIPTION_PRICE_MISMATCH',
    );
    if (sub.status === 'trialing' && !env.ENTITLEMENT_TRIALS_ENABLED)
      alert = 'UNAPPROVED_TRIAL';
    const latestId = refId(sub.latest_invoice);
    const latest = latestId ? await stripe.invoices.retrieve(latestId) : null;
    const paid = await stripe.invoices.list({
      subscription: sub.id,
      status: 'paid',
      limit: 1,
    });
    const invoice = paid.data[0];
    const paidThrough = invoice
      ? await paidEvidence(invoice, sub, customer)
      : null;
    facts.push({
      id: sub.id,
      price: item.price.id,
      status: sub.status,
      cancelAtPeriodEnd:
        sub.cancel_at_period_end ||
        (sub.cancel_at !== null && sub.cancel_at === item.current_period_end),
      cancelAt: iso(sub.cancel_at),
      periodStart: iso(item.current_period_start),
      periodEnd: iso(item.current_period_end),
      trialEnd: iso(sub.trial_end),
      invoiceId: latestId,
      invoiceStatus: latest?.status ?? null,
      paidThrough,
    });
  }
  return { facts, alert };
}
export async function runAccount(accountId?: string) {
  if (!env.STRIPE_ACCOUNT_ID) return false;
  const a = await accessRpc<BillingAccount | null>('billing_claim_account', {
    p_mode: env.STRIPE_MODE,
    p_merchant: env.STRIPE_ACCOUNT_ID,
    ...(accountId ? { p_id: accountId } : {}),
  });
  if (!a) return false;
  try {
    if (a.quarantined)
      throw new Quarantine(a.alert ?? 'OPERATOR_REVIEW_REQUIRED');
    await verifyMerchant();
    const customer = await customerFor(a);
    const attempts = await attemptsFor(a.id);
    // Once a customer exists, discover current subscriptions before opening a session.
    // Unknown subscriptions quarantine rather than authorize a second charge.
    const existing = await stripeClient()
      .subscriptions.list({ customer, status: 'all', limit: 100 })
      .autoPagingToArray({ limit: 100 });
    for (const sub of existing)
      assertBilling(
        attempts.some((t) => t.id === sub.metadata.attempt),
        'UNRECOGNIZED_SUBSCRIPTION',
      );
    for (const t of attempts.filter((t) =>
      ['CREATING', 'OPEN', 'UNKNOWN', 'COMPLETED'].includes(t.state),
    )) {
      if (
        !t.session_id &&
        existing.some(
          (s) => !['canceled', 'incomplete_expired'].includes(s.status),
        )
      ) {
        // A lost checkout response may already have created this subscription;
        // recover the session instead of issuing any create request.
        const sessions = await stripeClient()
          .checkout.sessions.list({ customer, limit: 100 })
          .autoPagingToArray({ limit: 100 });
        const match = sessions.filter((s) => s.metadata?.attempt === t.id);
        assertBilling(match.length === 1, 'SUBSCRIPTION_WITHOUT_SESSION');
        t.session_id = match[0]!.id;
      }
      await checkoutSession(a, t, customer);
    }
    const { facts, alert } = await snapshots(a, customer, attempts);
    await accessRpc('billing_apply_snapshot', {
      p_id: a.id,
      p_token: a.lease_token,
      p_version: a.version,
      p_subscriptions: facts,
      p_alert: alert,
    });
    return true;
  } catch (error) {
    const reason =
      error instanceof Quarantine ? error.message : 'PROVIDER_UNAVAILABLE';
    // Never release uncertain creation as terminal FAILED/new-charge eligible.
    try {
      const attempts = await attemptsFor(a.id);
      for (const t of attempts.filter((t) => t.state === 'CREATING'))
        await finish(a, undefined, t, { state: 'UNKNOWN' });
    } catch {
      /* expired fence cannot overwrite a newer worker */
    }
    await accessRpc('billing_fail_account', {
      p_id: a.id,
      p_token: a.lease_token,
      p_error: reason,
      p_quarantine: error instanceof Quarantine,
      p_limit: env.BILLING_MAX_RETRIES,
    });
    return false;
  }
}
export async function runInbox() {
  if (!env.STRIPE_ACCOUNT_ID) return false;
  const e = await accessRpc<InboxEvent | null>('billing_claim_event', {
    p_mode: env.STRIPE_MODE,
    p_merchant: env.STRIPE_ACCOUNT_ID,
  });
  if (!e) return false;
  let reason = 'UNMAPPED_EVENT';
  try {
    let customer = e.customer_id;
    if (
      !customer &&
      e.object_id &&
      (e.type.startsWith('charge.dispute.') || e.type.startsWith('refund.'))
    ) {
      await verifyMerchant();
      const item = e.type.startsWith('refund.')
        ? await stripeClient().refunds.retrieve(e.object_id)
        : await stripeClient().disputes.retrieve(e.object_id);
      const chargeId = refId(item.charge);
      if (chargeId) {
        const charge = await stripeClient().charges.retrieve(chargeId);
        assertBilling(matchesMode(charge), 'CHARGE_ENVIRONMENT_MISMATCH');
        customer = refId(charge.customer);
      }
    }
    const { data, error } = await getServiceRoleClient()
      .from('billing_accounts')
      .select('id')
      .eq('mode', env.STRIPE_MODE)
      .eq('merchant', env.STRIPE_ACCOUNT_ID)
      .eq('customer_id', customer ?? '')
      .maybeSingle();
    if (error) throw error;
    if (data) {
      if (e.type.startsWith('charge.') || e.type.startsWith('refund.')) {
        const a = await accessRpc<BillingAccount | null>(
          'billing_claim_account',
          {
            p_mode: env.STRIPE_MODE,
            p_merchant: env.STRIPE_ACCOUNT_ID,
            p_id: data.id,
          },
        );
        if (a)
          await accessRpc('billing_fail_account', {
            p_id: a.id,
            p_token: a.lease_token,
            p_error: 'PAYMENT_REVIEW_REQUIRED',
            p_quarantine: true,
          });
        reason = 'PAYMENT_REVIEW_REQUIRED';
      } else if (await runAccount(data.id)) {
        await accessRpc('billing_finish_event', {
          p_id: e.id,
          p_token: e.lease_token,
          p_state: 'APPLIED',
        });
        return true;
      } else reason = 'RECONCILIATION_PENDING';
    }
  } catch {
    reason = 'RECONCILIATION_UNAVAILABLE';
  }
  await accessRpc('billing_finish_event', {
    p_id: e.id,
    p_token: e.lease_token,
    p_state: e.attempts >= env.BILLING_MAX_RETRIES ? 'FAILED' : 'PENDING',
    p_error: reason,
    p_delay: Math.min(3600, 2 ** e.attempts + Math.floor(Math.random() * 5)),
  });
  return true;
}
