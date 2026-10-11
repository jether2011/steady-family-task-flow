import { z } from 'zod';
export const LoginEmail = z.string().trim().max(254).email();
export const AccessProvision = z
  .object({
    enabled: z.literal(true),
    email: LoginEmail,
    role: z.enum(['MEMBER', 'MANAGER']).default('MEMBER'),
  })
  .strict();
