import { getServiceRoleClient } from '../../config/supabase.js';
import { AppError } from '../../shared/errors/index.js';
import { mutationIdentity } from './access.store.js';
const errors: Record<string, number> = {
  SUBSCRIPTION_EXISTS: 409,
  PLAN_UNAVAILABLE: 422,
  BILLING_UNAVAILABLE: 503,
  BILLING_FENCE_LOST: 409,
  IDEMPOTENCY_CONFLICT: 409,
  TENANT_ASSOCIATION_CONFLICT: 409,
  EMAIL_VERIFICATION_REQUIRED: 403,
  SIGNUP_UNAVAILABLE: 503,
  TENANT_ACCESS_RESTRICTED: 403,
  ACCESS_VERSION_CONFLICT: 409,
  ACCESS_CONFLICT: 409,
  ACCESS_REVOKED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  EMAIL_CHANGE_REQUIRED: 422,
  INVALID_EMAIL_CHANGE: 422,
  TASK_ALREADY_COMPLETED: 409,
  INSUFFICIENT_POINTS: 422,
  NOT_DONE: 422,
};
export async function accessRpc<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await getServiceRoleClient().rpc(name, args);
  if (error) {
    const code = Object.keys(errors).find((k) => error.message === k);
    if (code)
      throw new AppError(
        code === 'NOT_DONE' ? 'VALIDATION' : code,
        errors[code]!,
        code === 'ACCESS_CONFLICT'
          ? 'Access could not be safely associated'
          : code.replaceAll('_', ' ').toLowerCase(),
      );
    throw error;
  }
  return data as T;
}
export async function resourceWrite<T>(
  table: string,
  operation: 'insert' | 'update' | 'delete',
  family: string,
  id: string | null,
  data: unknown,
): Promise<T[]> {
  const actor = mutationIdentity();
  if (actor.family !== family)
    throw new AppError('NOT_FOUND', 404, 'Resource not found');
  return accessRpc<T[]>('authorized_resource_write', {
    p_auth: actor.auth,
    p_family: family,
    p_table: table,
    p_operation: operation,
    p_id: id,
    p_data: data,
    p_correlation: actor.correlation,
  });
}
export function familyAction<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const actor = mutationIdentity();
  return accessRpc<T>('authorized_family_action', {
    p_auth: actor.auth,
    p_family: actor.family,
    p_action: name,
    p_args: args,
  });
}
