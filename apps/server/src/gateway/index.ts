import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { Session } from './session.js';

/**
 * Mounts the realtime gateway at /gateway.
 *
 * Authentication happens *inside* the socket via the `identify` frame rather
 * than as a query parameter on the upgrade request. Query strings end up in
 * access logs and proxy logs, and an access token in a log file is a credential
 * in a log file.
 */
export async function gatewayPlugin(app: FastifyInstance): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024,
      // Reject upgrades once the process is shutting down so a draining
      // instance does not accept work it is about to abandon.
      verifyClient: (_info: unknown, done: (verified: boolean) => void) =>
        done(!app.isShuttingDown),
    },
  });

  app.get('/gateway', { websocket: true }, (socket) => {
    new Session(socket, app.log);
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    isShuttingDown: boolean;
  }
}
