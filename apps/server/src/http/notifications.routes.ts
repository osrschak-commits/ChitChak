import { markNotificationsReadSchema } from '@chitchak/protocol';
import type { FastifyInstance } from 'fastify';
import { registry } from '../gateway/registry.js';
import { errors } from '../lib/errors.js';
import { listNotifications, markNotificationsRead } from '../services/notifications.js';
import { authenticate, requireUser } from './authenticate.js';

/**
 * The notifications inbox.
 *
 * Reading is over HTTP, not the gateway: the snapshot already carries the
 * recent ones, and this is only the panel's "load older" and the mark-read
 * calls, neither of which needs to be realtime. Marking read does publish a
 * `notification:read` back through the gateway so the person's other devices
 * clear the same badge.
 */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get<{ Querystring: { before?: string; limit?: string } }>(
    '/api/notifications',
    async (request) => {
      const { userId } = requireUser(request);
      return listNotifications({
        userId,
        before: request.query.before,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      });
    },
  );

  app.post('/api/notifications/read', async (request) => {
    const { userId } = requireUser(request);
    const parsed = markNotificationsReadSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw errors.invalid(parsed.error.issues[0]?.message ?? 'Invalid request');
    }

    const ids = await markNotificationsRead({ userId, ...parsed.data });
    if (ids.length > 0) {
      registry.publishToUsers([userId], { op: 'notification:read', d: { ids } });
    }
    return { ids };
  });
}
