import { accessRpc } from '../access/access.repository.js';
import { AppError } from '../../shared/errors/index.js';
export interface EntitlementAccess {
  state: 'DRAFT' | 'ACTIVE' | 'TRIAL' | 'GRACE' | 'READ_ONLY' | 'LEGACY';
  reason:
    | 'PAYMENT_PENDING'
    | 'PAID'
    | 'PAYMENT_ISSUE'
    | 'EXPIRED'
    | 'LEGACY'
    | 'TRIAL'
    | 'TEMPORARY';
  effectiveUntil: string | null;
  version: number;
  canManageBilling: boolean;
  canRead: boolean;
  canWrite: boolean;
  ownerDeadlines: Record<string, unknown> | null;
}
export async function resolveEntitlement(
  auth: string,
  family: string,
): Promise<EntitlementAccess> {
  try {
    const result = await accessRpc<EntitlementAccess>('entitlement_access', {
      p_auth: auth,
      p_family: family,
    });
    if (
      !result ||
      typeof result.canRead !== 'boolean' ||
      typeof result.canWrite !== 'boolean' ||
      !Number.isSafeInteger(result.version)
    )
      throw new Error('missing projection');
    return result;
  } catch (error) {
    if (
      error instanceof AppError &&
      ['ACCESS_REVOKED', 'FORBIDDEN'].includes(error.code)
    )
      throw error;
    throw new AppError(
      'ENTITLEMENT_UNAVAILABLE',
      503,
      'Family access is temporarily unavailable. Retry or use billing recovery.',
    );
  }
}
