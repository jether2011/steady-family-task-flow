import { accessRpc } from '../access/access.repository.js';
import { AppError } from '../../shared/errors/index.js';
import { billingUnavailable } from './billing.provider.js';
/** Preserve deliberate contract errors; never expose storage/provider diagnostics. */
export async function billingRpc<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  try {
    return await accessRpc<T>(name, args);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw billingUnavailable();
  }
}
