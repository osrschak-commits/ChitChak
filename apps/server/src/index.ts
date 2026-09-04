import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { GatewayCloseCode } from '@chitchak/protocol';
import Fastify from 'fastify';
import { config, isProduction } from './config.js';
import { closeDatabase, sql } from './db/client.js';
import { gatewayPlugin } from './gateway/index.js';
import * as presence from './gateway/presence.js';
import { registry } from './gateway/registry.js';
import { authRoutes } from './http/auth.routes.js';
import { guildRoutes } from './http/guilds.routes.js';
import { imageRoutes } from './http/images.routes.js';
import { moderationRoutes } from './http/moderation.routes.js';
import { rankRoutes } from './http/ranks.routes.js';
import { userRoutes } from './http/users.routes.js';
import { isAppError } from './lib/errors.js';

const app = Fastify({
  logger: isProduction
    ? { level: 'info' }
    : {
        level: 'debug',
        transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
      },
  // Behind a reverse proxy this is what makes rate limiting see the real client
  // IP instead of limiting the proxy itself.
  trustProxy: isProduction,
  bodyLimit: 256 * 1024,
});

app.decorate('isShuttingDown', false);

await app.register(cors, {
  // Electron renderers load from file:// or the dev server, so the origin is
  // either the Vite URL or absent entirely. An allowlist rather than `*`,
  // because credentials are involved.
  origin: (origin, cb) => cb(null, !origin || origin === config.CLIENT_ORIGIN),
  credentials: true,
});

await app.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: '1 minute',
  // Rate limit state is per-instance. Move this to the Redis store before
  // running more than one API process, or the effective limit multiplies.
  keyGenerator: (request) => request.user?.userId ?? request.ip,
});

/**
 * One error handler for the whole API. Expected failures (AppError) carry their
 * own status and a message meant for humans; anything else is a bug, and is
 * logged in full but reported as a bare 500 so internals never reach a client.
 */
app.setErrorHandler((error, request, reply) => {
  if (isAppError(error)) {
    return reply.code(error.status).send({
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }

  if (typeof (error as { statusCode?: number }).statusCode === 'number') {
    const statusCode = (error as { statusCode: number }).statusCode;
    if (statusCode < 500) {
      const message = error instanceof Error ? error.message : 'Bad request';
      return reply.code(statusCode).send({ error: 'bad_request', message });
    }
  }

  request.log.error({ err: error }, 'unhandled error');
  return reply.code(500).send({ error: 'internal', message: 'Something went wrong' });
});

app.setNotFoundHandler((request, reply) =>
  reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` }),
);

app.get('/health', async () => {
  await sql`select 1`;
  return { status: 'ok', sessions: registry.localSessionCount, uptime: process.uptime() };
});

await app.register(authRoutes);
await app.register(imageRoutes);
await app.register(userRoutes);
await app.register(guildRoutes);
await app.register(rankRoutes);
await app.register(moderationRoutes);
await app.register(gatewayPlugin);

await presence.startPresence();
await registry.start();

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(`gateway ready at ws://localhost:${config.PORT}/gateway`);

/**
 * Graceful shutdown: stop accepting new work, tell connected clients to
 * reconnect (rather than letting their sockets die and look like a network
 * fault), then release the pools.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.isShuttingDown = true;
  app.log.info({ signal }, 'shutting down');

  registry.closeAll(GatewayCloseCode.SessionTimeout, 'server restarting');

  try {
    await app.close();
    await registry.stop();
    await presence.stopPresence();
    await closeDatabase();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
