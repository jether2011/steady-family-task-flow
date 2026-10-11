import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Forbidden } from '../../shared/errors/index.js';
export const requestStore = new AsyncLocalStorage<FastifyRequest>();
export function registerRequestScope(app: FastifyInstance) {
  app.addHook('onRequest', (request, _reply, done) =>
    requestStore.run(request, done),
  );
}
export function mutationIdentity() {
  const request = requestStore.getStore();
  if (
    !request?.ctx?.familyId ||
    !request.authUserId ||
    !request.ctx.role ||
    !['OWNER', 'MANAGER'].includes(request.ctx.role)
  )
    throw new Forbidden();
  return {
    auth: request.authUserId,
    family: request.ctx.familyId,
    correlation: request.id,
  };
}
