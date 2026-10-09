/**
 * Process entrypoint: start the HTTP listener and handle graceful shutdown.
 *
 * Importing `env` first triggers startup config validation, so the process fails
 * fast with a descriptive (secret-free) error before a socket is ever opened (R29.9).
 */
import { env } from './config/env.js';
import { buildApp } from './app.js';

const app = buildApp();

async function start(): Promise<void> {
  try {
    // Host 0.0.0.0 so the service is reachable inside a Docker network (R29.5).
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err, 'Failed to start server');
    process.exit(1);
  }
}

/** Close the Fastify instance on a termination signal, then exit cleanly. */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'Received shutdown signal, closing server');
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'Error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

void start();
