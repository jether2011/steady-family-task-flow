import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../shared/errors/index.js';
import { env } from '../../config/env.js';
import { accessRpc } from '../access/access.repository.js';
import { verifiedIdentity } from '../access/access.service.js';
import { FamilyResponse } from '../family/family.schemas.js';
const profile = z
  .object({
    name: z.string().trim().min(1).max(120),
    responsible_name: z.string().trim().min(1).max(120),
    relationship: z.enum(['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER']),
  })
  .strict();
export const OnboardingResponse = z.object({
  family: FamilyResponse.shape.family,
  lifecycle: z.enum(['DRAFT', 'ESTABLISHED']),
  profileCompleted: z.boolean(),
  nextAction: z.enum(['COMPLETE_PROFILE', 'SUBSCRIBE', 'OPEN_DASHBOARD']),
  billingAvailable: z.boolean(),
});
type Result = z.infer<typeof OnboardingResponse> & { created?: boolean };
export function tenantRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/families',
    {
      schema: {
        body: profile,
        headers: z.object({ 'idempotency-key': z.uuid() }).passthrough(),
        response: { 200: OnboardingResponse, 201: OnboardingResponse },
      },
    },
    async (req, reply) => {
      const identity = await verifiedIdentity(req.authUserId!);
      if (!identity.email)
        throw new AppError(
          'EMAIL_VERIFICATION_REQUIRED',
          403,
          'Verify your email before creating a family',
        );
      const body = req.body;
      const hash = createHash('sha256')
        .update(
          JSON.stringify([body.name, body.responsible_name, body.relationship]),
        )
        .digest('hex');
      const result = await accessRpc<Result>('create_tenant', {
        p_auth: req.authUserId!,
        p_email: identity.email,
        p_key: req.headers['idempotency-key'],
        p_hash: hash,
        p_input: body,
        p_enabled: env.SELF_SERVICE_SIGNUP_ENABLED,
      });
      return reply
        .code(result.created ? 201 : 200)
        .send({ ...result, billingAvailable: env.BILLING_AVAILABLE });
    },
  );
  typed.get(
    '/family/onboarding',
    { schema: { response: { 200: OnboardingResponse } } },
    async (req) => ({
      ...(await accessRpc<Result>('tenant_onboarding', {
        p_auth: req.authUserId!,
      })),
      billingAvailable: env.BILLING_AVAILABLE,
    }),
  );
  typed.patch(
    '/family/onboarding',
    {
      schema: {
        body: profile.partial().strict(),
        response: { 200: OnboardingResponse },
      },
    },
    async (req) => ({
      ...(await accessRpc<Result>('tenant_onboarding', {
        p_auth: req.authUserId!,
        p_input: req.body,
      })),
      billingAvailable: env.BILLING_AVAILABLE,
    }),
  );
}
