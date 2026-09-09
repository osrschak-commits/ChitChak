import type { FastifyInstance } from 'fastify';
import { errors } from '../lib/errors.js';
import * as reports from '../services/reports.js';
import { authenticate, requireUser } from './authenticate.js';

/**
 * The one route here that is not for staff.
 *
 * Filing a report is a thing every ordinary user has to be able to do - it is
 * the only way anything reaches an operator from someone who has never met one -
 * so it lives apart from admin.routes.ts, where everything is gated on being
 * staff and nothing should be reachable without it.
 *
 * Reading the queue and acting on it are in admin.routes.ts. A reporter is
 * deliberately not told what happened to their report: the answer is almost
 * always about somebody else's account, and "we suspended them for a week" is
 * not the reporter's to know.
 */
export async function reportsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.post<{ Body: { messageId?: string; username?: string; reason?: string } }>('/api/reports', {
    // Well under the daily cap the service enforces. This one is here to stop a
    // script, not a person - the service's limit is the one about behaviour.
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    handler: async (request, reply) => {
      const { userId } = requireUser(request);

      const messageId = request.body?.messageId;
      const username = request.body?.username;
      if (typeof messageId !== 'string' && typeof username !== 'string') {
        throw errors.invalid('Report a message or a person');
      }

      const reason = request.body?.reason;
      if (typeof reason !== 'string') throw errors.invalid('Say what is wrong with it');

      const result = await reports.file({
        reporterId: userId,
        messageId: typeof messageId === 'string' ? messageId : null,
        username: typeof username === 'string' ? username : null,
        reason,
      });

      request.log.info({ reporter: userId, report: result.id }, 'report filed');
      return reply.code(201).send(result);
    },
  });
}
