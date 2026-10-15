import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resolveEntitlement } from '../entitlements/entitlements.service.js';
import { approvedPlan } from './billing.provider.js';
import {
  checkout,
  checkoutStatus,
  ownerState,
  portal,
} from './billing.service.js';
const plan = z.object({
  planKey: z.literal('family-monthly'),
  title: z.string().nullable(),
  currency: z.string().nullable(),
  unitAmount: z.number().int().nullable(),
  interval: z.literal('month'),
  features: z.array(z.string()),
  memberLimit: z.number().int().nullable(),
  termsUrl: z.string().nullable(),
  privacyUrl: z.string().nullable(),
  policyUrl: z.string().nullable(),
  taxDisclosure: z.string().nullable(),
  available: z.boolean(),
});
const hosted = z.object({
  attemptId: z.uuid(),
  url: z.url(),
  expiresAt: z.string().nullable(),
});
export function billingRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get(
    '/billing/plan',
    { schema: { querystring: z.object({}).strict(), response: { 200: plan } } },
    async () =>
      (await approvedPlan()) ?? {
        planKey: 'family-monthly' as const,
        title: null,
        currency: null,
        unitAmount: null,
        interval: 'month' as const,
        features: [],
        memberLimit: null,
        termsUrl: null,
        privacyUrl: null,
        policyUrl: null,
        taxDisclosure: null,
        available: false,
      },
  );
  api.get(
    '/billing/subscription',
    {
      schema: {
        querystring: z.object({}).strict(),
        response: {
          200: z.object({
            plan: plan.nullable(),
            entitlement: z.unknown().nullable().optional(),
            status: z.string().nullable(),
            cancelAtPeriodEnd: z.boolean(),
            paidThrough: z.string().nullable(),
            nextBillingAt: z.string().nullable(),
            accessState: z.string(),
            recoveryAction: z.string(),
            updatedAt: z.string().nullable(),
            attemptId: z.uuid().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const state = await ownerState(req.authUserId!, req.ctx!.familyId!);
      const current =
        state.subscriptions.find(
          (s) => !['canceled', 'incomplete_expired'].includes(s.status),
        ) ?? state.subscriptions[0];
      return {
        plan: await approvedPlan().catch(() => null),
        entitlement: await resolveEntitlement(
          req.authUserId!,
          req.ctx!.familyId!,
        ).catch(() => null),
        status: current?.status ?? null,
        cancelAtPeriodEnd: current?.cancel_at_period_end ?? false,
        paidThrough: current?.paid_through ?? null,
        nextBillingAt: current?.cancel_at_period_end
          ? null
          : (current?.period_end ?? null),
        accessState: state.activation ? 'CONFIRMED' : 'PENDING',
        recoveryAction: state.account?.quarantined
          ? 'CONTACT_SUPPORT'
          : current &&
              !['canceled', 'incomplete_expired'].includes(current.status)
            ? 'OPEN_PORTAL'
            : state.attempt &&
                ['CREATING', 'OPEN', 'UNKNOWN', 'COMPLETED'].includes(
                  state.attempt.state,
                )
              ? 'RESUME_CHECKOUT'
              : 'SUBSCRIBE',
        updatedAt: state.account?.verified_at ?? null,
        attemptId: state.attempt?.id ?? null,
      };
    },
  );
  api.post(
    '/billing/checkout',
    {
      schema: {
        headers: z.object({ 'idempotency-key': z.uuid() }).passthrough(),
        body: z.object({ planKey: z.literal('family-monthly') }).strict(),
        response: {
          200: hosted,
          201: hosted,
          202: z.object({
            attemptId: z.uuid().nullable(),
            state: z.literal('PROCESSING'),
          }),
        },
      },
    },
    async (req, reply) => {
      const result = await checkout(
        req.authUserId!,
        req.ctx!.familyId!,
        req.headers['idempotency-key'],
        req.id,
      );
      return reply.code(result.status).send(result.body);
    },
  );
  api.get(
    '/billing/checkout/:attemptId',
    {
      schema: {
        params: z.object({ attemptId: z.uuid() }),
        querystring: z.object({}).strict(),
        response: {
          200: z.object({
            attemptId: z.uuid(),
            state: z.string(),
            activation: z.enum(['PENDING', 'CONFIRMED', 'FAILED']),
            nextAction: z.string(),
            url: z.url().optional(),
          }),
        },
      },
    },
    async (req) =>
      checkoutStatus(
        await ownerState(
          req.authUserId!,
          req.ctx!.familyId!,
          req.params.attemptId,
        ),
      ),
  );
  api.post(
    '/billing/portal',
    {
      schema: {
        body: z.object({}).strict(),
        response: { 200: z.object({ url: z.url() }) },
      },
    },
    async (req) => portal(req.authUserId!, req.ctx!.familyId!, req.id),
  );
}
