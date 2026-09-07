import type { FastifyInstance } from 'fastify';
import { errors } from '../lib/errors.js';
import { issueBlackCard, issuedCards } from '../services/blackcard.js';
import { isPlatformStaff, requirePlatformStaff } from '../services/staff.js';
import { authenticate, requireUser } from './authenticate.js';

/**
 * The operator's own routes.
 *
 * Everything here is gated on `requirePlatformStaff`, which refuses with the
 * same words an ordinary user gets for anything they may not do - confirming
 * that a staff route exists tells somebody probing for one that it is worth
 * probing.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  /**
   * Whether this account is staff.
   *
   * The one route here that answers for everybody, because the client needs to
   * know whether to draw the panel at all, and "am I staff" is not a secret from
   * the person it is about.
   */
  app.get('/api/admin/me', async (request) => {
    const { userId } = requireUser(request);
    return { staff: isPlatformStaff(userId) };
  });

  app.post<{ Body: { username?: string } }>('/api/admin/black-card', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { userId } = requireUser(request);
      requirePlatformStaff(userId);

      const username = request.body?.username;
      if (typeof username !== 'string' || username.trim().length === 0) {
        throw errors.invalid('Who is it for?');
      }

      const result = await issueBlackCard({ actorId: userId, username });
      request.log.info(
        { actor: userId, subject: result.username, card: result.cardId },
        '[staff] black card issued',
      );
      return result;
    },
  });

  app.get('/api/admin/black-cards', async (request) => {
    const { userId } = requireUser(request);
    requirePlatformStaff(userId);
    return { cards: await issuedCards() };
  });
}
