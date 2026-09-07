import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { errors } from '../lib/errors.js';
import * as paddle from '../services/paddle.js';
import { authenticate, requireUser } from './authenticate.js';

/**
 * Taking money, and being told that money arrived.
 *
 * Registered as its own plugin because of the raw body. The webhook's signature
 * covers the exact bytes Paddle sent, so this route must not have them parsed
 * and re-serialised - `JSON.stringify(JSON.parse(x))` is very rarely `x`, and
 * every signature would fail for reasons that look like a wrong secret.
 */

/** What can be bought, and what it is worth here. */
const PACKS: Record<string, { price: () => string | undefined; keys?: number }> = {
  subscription: { price: () => config.PADDLE_PRICE_SUBSCRIPTION },
  keys5: { price: () => config.PADDLE_PRICE_KEYS_5, keys: 5 },
  keys15: { price: () => config.PADDLE_PRICE_KEYS_15, keys: 15 },
  keys40: { price: () => config.PADDLE_PRICE_KEYS_40, keys: 40 },
};

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The raw body, for this route only.
   *
   * Scoped by checking the URL rather than registered globally: everything else
   * in the app wants parsed JSON, and a server-wide raw parser would make every
   * other handler do the parsing itself.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      if (request.url.startsWith('/api/webhooks/paddle')) {
        done(null, { raw: body.toString('utf8') });
        return;
      }
      try {
        done(null, body.length === 0 ? undefined : JSON.parse(body.toString('utf8')));
      } catch {
        done(errors.invalid('Malformed JSON'), undefined);
      }
    },
  );

  /**
   * Paddle telling us something happened.
   *
   * Unauthenticated by necessity - Paddle has no session here - so the
   * signature is the entire authentication, and nothing is read out of the body
   * before it has been checked.
   *
   * Answers 200 to anything correctly signed, including events it does not act
   * on. Paddle retries a non-2xx for days, and retrying something we were never
   * going to do anything with helps nobody.
   */
  app.post<{ Body: { raw?: string } }>('/api/webhooks/paddle', {
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const raw = request.body?.raw;
      if (typeof raw !== 'string') return reply.code(400).send({ error: 'expected a body' });

      const check = paddle.checkSignature(
        request.headers['paddle-signature'] as string | undefined,
        raw,
      );
      if (check !== 'ok') {
        // The log says which way it failed - a wrong secret and a wrong clock
        // are indistinguishable from outside and want completely different
        // fixes. The reply stays terse: the only party who needs the detail is
        // us, and telling a forger why they failed only helps them.
        request.log.warn({ reason: check }, '[paddle] webhook refused');
        return reply.code(401).send({ error: 'bad signature' });
      }

      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: 'malformed json' });
      }

      try {
        const result = await paddle.handleEvent(event as Parameters<typeof paddle.handleEvent>[0]);
        request.log.info({ result }, '[paddle] webhook');
        return reply.send({ ok: true });
      } catch (error) {
        // A 500 here is right: Paddle should retry, because the money is real
        // and the entitlement has not been applied.
        request.log.error({ err: error }, '[paddle] failed to apply a webhook');
        return reply.code(500).send({ error: 'could not apply' });
      }
    },
  });

  /**
   * Somewhere to go and pay.
   *
   * Returns a URL rather than doing anything itself. The desktop app opens it
   * in a real browser, where somebody typing a card number can see the address
   * bar - which an Electron window cannot honestly offer.
   */
  app.post<{ Body: { pack?: string } }>('/api/premium/checkout', {
    preHandler: authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request) => {
      const { userId } = requireUser(request);

      if (!paddle.isConfigured()) {
        throw errors.invalid('Buying is not open yet');
      }

      const pack = PACKS[request.body?.pack ?? ''];
      if (!pack) throw errors.invalid('No such thing to buy');

      const priceId = pack.price();
      if (!priceId) throw errors.invalid('That is not for sale on this server');

      try {
        return await paddle.createCheckout({ userId, priceId, keys: pack.keys });
      } catch (error) {
        // Paddle's own words go to the log, not to the person: they can name
        // internals, and they are addressed to us. What reaches the screen says
        // what happened and what to do, which "Something went wrong" does not.
        request.log.error({ err: error }, '[paddle] could not create a checkout');
        throw errors.invalid('Could not open the checkout just now. Try again in a moment.');
      }
    },
  });

  /** What this server can actually sell, so the client knows what to show. */
  app.get('/api/premium/store', {
    preHandler: authenticate,
    handler: async (request) => {
      requireUser(request);
      return {
        open: paddle.isConfigured(),
        packs: Object.entries(PACKS)
          .filter(([, pack]) => Boolean(pack.price()))
          .map(([id, pack]) => ({ id, keys: pack.keys ?? null })),
      };
    },
  });
}
