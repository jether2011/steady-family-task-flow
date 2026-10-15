import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { billingRpc as accessRpc } from './billing.repository.js';
import { AppError } from '../../shared/errors/index.js';
import { STRIPE_API_VERSION, stripeClient } from './billing.provider.js';
export const supportedEvents = new Set([
  'checkout.session.completed',
  'checkout.session.expired',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'refund.created',
  'refund.updated',
  'refund.failed',
]);
function reference(value: unknown) {
  return typeof value === 'string'
    ? value
    : value &&
        typeof value === 'object' &&
        'id' in value &&
        typeof value.id === 'string'
      ? value.id
      : null;
}
/** Register outside the Supabase authentication scope. Only this parser sees raw buffers. */
export async function billingWebhook(app: FastifyInstance) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 262144 },
    (_req, body, done) => done(null, body),
  );
  app.post(
    '/api/v1/billing/webhooks/stripe',
    { bodyLimit: 262144 },
    async (req) => {
      if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_ACCOUNT_ID)
        throw new AppError(
          'BILLING_UNAVAILABLE',
          503,
          'Webhook ingestion is not configured',
        );
      const signature = req.headers['stripe-signature'];
      if (
        typeof signature !== 'string' ||
        signature.length > 4096 ||
        !Buffer.isBuffer(req.body)
      )
        throw new AppError('INVALID_WEBHOOK', 400, 'Invalid webhook');
      let event;
      const timestamp = Number(signature.match(/(?:^|,)t=(\d+)(?:,|$)/)?.[1]);
      if (
        !Number.isFinite(timestamp) ||
        Math.abs(Date.now() / 1000 - timestamp) > 300
      )
        throw new AppError('INVALID_WEBHOOK', 400, 'Invalid webhook timestamp');
      try {
        event = z
          .object({
            id: z.string().startsWith('evt_').max(255),
            type: z.string().min(1).max(255),
            api_version: z.string(),
            livemode: z.boolean(),
            account: z.string().optional(),
            created: z.number().int().nonnegative(),
            data: z.object({
              object: z
                .object({ id: z.string().min(1).max(255) })
                .catchall(z.unknown()),
            }),
          })
          .parse(
            stripeClient().webhooks.constructEvent(
              req.body,
              signature,
              env.STRIPE_WEBHOOK_SECRET,
              300,
            ),
          );
        if (
          event.livemode !== (env.STRIPE_MODE === 'LIVE') ||
          (event.account && event.account !== env.STRIPE_ACCOUNT_ID) ||
          event.api_version !== STRIPE_API_VERSION
        )
          throw new Error('environment');
      } catch {
        throw new AppError(
          'INVALID_WEBHOOK',
          400,
          'Invalid webhook signature or environment',
        );
      }
      // Store only verified references. No cards, signature, raw body, email or payment tokens.
      const object = event.data.object as unknown as Record<string, unknown>;
      try {
        await accessRpc('billing_ingest', {
          p_mode: env.STRIPE_MODE,
          p_merchant: env.STRIPE_ACCOUNT_ID,
          p_event: event.id,
          p_type: event.type,
          p_object: reference(object.id),
          p_customer: reference(object.customer),
          p_created: new Date(event.created * 1000).toISOString(),
          p_supported: supportedEvents.has(event.type),
        });
      } catch {
        throw new AppError(
          'BILLING_UNAVAILABLE',
          503,
          'Webhook storage is temporarily unavailable',
        );
      }
      return { received: true };
    },
  );
}
