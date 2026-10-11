import { MePayloadSchema } from '../auth/auth.routes.js';
import { LoginEmail } from './access.schemas.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { accessSummary } from './access.types.js';
import {
  readMemberAccess,
  updateAccess,
  startEmailChange,
  confirmEmailChange,
} from './access.service.js';
import { bootstrapMe } from '../auth/auth.service.js';
const Summary = z.object({
  membershipId: z.uuid(),
  email: z.string().nullable(),
  role: z.enum(['OWNER', 'MANAGER', 'MEMBER']),
  status: z.enum(['PROVISIONED', 'ACTIVE', 'REVOKED']),
  accessVersion: z.number().int(),
});
const Response = z.object({ access: Summary.nullable() });
const Params = z.object({ id: z.uuid() }).strict();
export function accessRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get(
    '/family/members/:id/access',
    { schema: { params: Params, response: { 200: Response } } },
    async (req) => ({
      access: accessSummary(await readMemberAccess(req.params.id)),
    }),
  );
  api.patch(
    '/family/members/:id/access',
    {
      schema: {
        params: Params,
        body: z
          .object({
            enabled: z.boolean(),
            email: LoginEmail.optional(),
            role: z.enum(['MEMBER', 'MANAGER']).optional(),
            expectedVersion: z.number().int().nonnegative(),
          })
          .strict(),
        response: { 200: Response },
      },
    },
    async (req) => ({
      access: accessSummary(await updateAccess(req.params.id, req.body)),
    }),
  );
  api.post(
    '/family/members/:id/access/email-change',
    {
      schema: {
        params: Params,
        body: z
          .object({
            email: LoginEmail,
            expectedVersion: z.number().int().positive(),
          })
          .strict(),
        response: {
          200: z.object({
            status: z.literal('PENDING_VERIFICATION'),
            expiresAt: z.string(),
          }),
        },
      },
    },
    (req) =>
      startEmailChange(req.params.id, req.body.email, req.body.expectedVersion),
  );
  api.post(
    '/me/email-change/confirm',
    {
      schema: {
        body: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        response: { 200: MePayloadSchema },
      },
    },
    async (req) => {
      await confirmEmailChange(req.authUserId!, req.body.token, req.id);
      return bootstrapMe(req.authUserId!, {});
    },
  );
}
