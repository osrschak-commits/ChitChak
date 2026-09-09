import type { FastifyInstance } from 'fastify';
import { errors } from '../lib/errors.js';
import { issueBlackCard, issuedCards, revokeBlackCard } from '../services/blackcard.js';
import * as reports from '../services/reports.js';
import { isPlatformStaff, requirePlatformStaff } from '../services/staff.js';
import * as suspensions from '../services/suspensions.js';
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

  app.delete<{ Body: { username?: string } }>('/api/admin/black-card', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { userId } = requireUser(request);
      requirePlatformStaff(userId);

      const username = request.body?.username;
      if (typeof username !== 'string' || username.trim().length === 0) {
        throw errors.invalid('Whose card is it?');
      }

      const result = await revokeBlackCard({ actorId: userId, username });
      request.log.warn(
        { actor: userId, subject: result.username, keysTaken: result.keysTaken },
        '[staff] black card revoked',
      );
      return result;
    },
  });

  app.get('/api/admin/black-cards', async (request) => {
    const { userId } = requireUser(request);
    requirePlatformStaff(userId);
    return { cards: await issuedCards() };
  });

  // --- Suspensions ---------------------------------------------------------

  app.post<{ Body: { username?: string; reason?: string; days?: number | null } }>(
    '/api/admin/suspend',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      handler: async (request) => {
        const { userId } = requireUser(request);
        requirePlatformStaff(userId);

        const username = request.body?.username;
        if (typeof username !== 'string' || username.trim().length === 0) {
          throw errors.invalid('Who is it about?');
        }
        const reason = request.body?.reason;
        if (typeof reason !== 'string') throw errors.invalid('Say why - the person is shown this');

        const result = await suspensions.suspend({
          actorId: userId,
          username,
          reason,
          days: request.body?.days ?? null,
        });
        request.log.warn(
          { actor: userId, subject: result.username, until: result.until },
          '[staff] account suspended',
        );
        return result;
      },
    },
  );

  app.delete<{ Body: { username?: string } }>('/api/admin/suspend', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { userId } = requireUser(request);
      requirePlatformStaff(userId);

      const username = request.body?.username;
      if (typeof username !== 'string' || username.trim().length === 0) {
        throw errors.invalid('Whose suspension is it?');
      }

      const result = await suspensions.lift({ actorId: userId, username });
      request.log.warn({ actor: userId, subject: result.username }, '[staff] suspension lifted');
      return result;
    },
  });

  app.get('/api/admin/suspended', async (request) => {
    const { userId } = requireUser(request);
    requirePlatformStaff(userId);
    return { accounts: await suspensions.suspended() };
  });

  // --- Reports -------------------------------------------------------------

  app.get<{ Querystring: { status?: string } }>('/api/admin/reports', async (request) => {
    const { userId } = requireUser(request);
    requirePlatformStaff(userId);

    const status = request.query?.status;
    const filter =
      status === 'open' || status === 'actioned' || status === 'dismissed' ? status : undefined;
    return { reports: await reports.queue(filter), open: await reports.openCount() };
  });

  app.post<{ Params: { reportId: string }; Body: { status?: string; outcome?: string } }>(
    '/api/admin/reports/:reportId',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      handler: async (request) => {
        const { userId } = requireUser(request);
        requirePlatformStaff(userId);

        const status = request.body?.status;
        if (status !== 'actioned' && status !== 'dismissed') {
          throw errors.invalid('A report is either actioned or dismissed');
        }

        const report = await reports.resolve({
          actorId: userId,
          reportId: request.params.reportId,
          status,
          outcome: request.body?.outcome ?? null,
        });
        request.log.info(
          { actor: userId, report: report.id, status },
          '[staff] report resolved',
        );
        return report;
      },
    },
  );
}
