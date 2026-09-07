import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import * as keys from './keys.js';
import { applyFromProvider, type Status } from './subscriptions.js';

/**
 * Paddle, and only Paddle-shaped things.
 *
 * Everything Paddle-specific stops here. Above this file the app knows that
 * somebody is subscribed until a date and that keys arrived; it does not know
 * who took the money. Swapping providers means writing another file like this
 * one and changing nothing else.
 *
 * Paddle rather than Stripe because Paddle is merchant of record: they are the
 * legal seller, so VAT in every country a customer lives in is theirs to
 * calculate, collect and file. For a one-person operation that is the expensive
 * part, not the integration.
 */

const API_BASE = () =>
  config.PADDLE_ENV === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';

/**
 * How old a signed request may be.
 *
 * Paddle suggest five seconds. That is too tight to be safe here, and the
 * reason is worth writing down: five seconds asks three clocks to agree -
 * Paddle's, ours, and whatever the network added - and when they do not, the
 * failure is a webhook rejected, which means money taken and nothing delivered.
 * That is the worst outcome in this file. A machine an innocent ten seconds out
 * would break every payment it ever received, and look exactly like a wrong
 * secret while doing it.
 *
 * Widening it costs almost nothing, because the age check is not what stops a
 * replay: the ledger's unique index on (user, reason, reference) is. A captured
 * webhook replayed a thousand times pays out once whatever this number says.
 * The window is here to stop something signed last year turning up, and five
 * minutes does that as well as five seconds does.
 */
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/** Why a webhook was refused. */
export type SignatureResult = 'ok' | 'no-secret' | 'malformed' | 'stale' | 'mismatch';

/**
 * Is this really from Paddle, and is it recent?
 *
 * The signature covers `timestamp:rawBody`, so the body has to be the exact
 * bytes that arrived - re-serialising the parsed JSON produces a different
 * string and every signature fails. That is why the webhook route takes the raw
 * buffer.
 *
 * Compared with `timingSafeEqual`, which is why the lengths are checked first:
 * a wrong-length input makes it throw rather than return false.
 *
 * Returns which way it failed rather than a boolean, because a wrong secret and
 * a wrong clock are indistinguishable from outside and want completely
 * different fixes. The log says which; the reply never does.
 */
export function checkSignature(header: string | undefined, rawBody: string): SignatureResult {
  const secret = config.PADDLE_WEBHOOK_SECRET;
  if (!secret) return 'no-secret';
  if (!header) return 'malformed';

  // Paddle-Signature: ts=1671552777;h1=eb4d0dc8...
  const parts = new Map(
    header.split(';').map((piece) => {
      const [key, ...rest] = piece.split('=');
      return [key?.trim() ?? '', rest.join('=').trim()];
    }),
  );

  const timestamp = parts.get('ts');
  const signature = parts.get('h1');
  if (!timestamp || !signature) return 'malformed';

  const age = Math.abs(Date.now() - Number(timestamp) * 1000);
  if (!Number.isFinite(age)) return 'malformed';
  if (age > MAX_SIGNATURE_AGE_MS) return 'stale';

  const expected = createHmac('sha256', secret).update(`${timestamp}:${rawBody}`).digest('hex');

  // Both are hex of a fixed length, but a wrong-length input would make
  // timingSafeEqual throw rather than return false.
  const given = Buffer.from(signature, 'hex');
  const mine = Buffer.from(expected, 'hex');
  if (given.length !== mine.length) return 'malformed';

  return timingSafeEqual(given, mine) ? 'ok' : 'mismatch';
}

export function verifySignature(header: string | undefined, rawBody: string): boolean {
  return checkSignature(header, rawBody) === 'ok';
}

/** Paddle's subscription statuses, as ours. */
function toStatus(paddleStatus: string): Status {
  switch (paddleStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'paused':
      return 'cancelled';
    default:
      return 'none';
  }
}

interface PaddleEvent {
  event_id?: string;
  event_type?: string;
  data?: {
    id?: string;
    status?: string;
    custom_data?: { userId?: string; keys?: number | string } | null;
    current_billing_period?: { ends_at?: string } | null;
    items?: Array<{ price?: { id?: string } }>;
  };
}

/**
 * One webhook, applied.
 *
 * Unknown event types are accepted and ignored rather than rejected: Paddle
 * sends whatever the notification setting subscribes to, that list grows, and a
 * 4xx makes them retry something we were never going to act on.
 *
 * `custom_data.userId` is how a payment finds its account. It is set when the
 * checkout is created, which is the only moment we know who is buying - Paddle
 * knows an email address, and an email address is not an identity here.
 */
export async function handleEvent(event: PaddleEvent): Promise<{ handled: string }> {
  const type = event.event_type ?? '';
  const data = event.data ?? {};
  const userId = data.custom_data?.userId;

  if (!userId) return { handled: 'ignored: no userId' };

  if (type.startsWith('subscription.')) {
    const periodEnd = data.current_billing_period?.ends_at
      ? new Date(data.current_billing_period.ends_at)
      : null;

    await applyFromProvider({
      userId,
      status: toStatus(data.status ?? ''),
      periodEnd,
      provider: 'paddle',
      providerId: data.id ?? null,
    });
    return { handled: type };
  }

  /**
   * A one-off key pack. The transaction id is the ledger reference, so Paddle
   * retrying this - which they do, for days, until we answer 200 - credits the
   * keys exactly once.
   */
  if (type === 'transaction.completed') {
    const amount = Number(data.custom_data?.keys ?? 0);
    if (!Number.isInteger(amount) || amount <= 0) return { handled: 'ignored: not a key pack' };

    await keys.record({
      userId,
      amount,
      reason: 'purchase',
      reference: data.id ?? event.event_id ?? null,
    });
    return { handled: type };
  }

  return { handled: `ignored: ${type}` };
}

/**
 * Start a checkout, and get back somewhere to send them.
 *
 * Created server-side rather than with Paddle.js in the renderer, for two
 * reasons. The price and the quantity are decided here, where they cannot be
 * edited before being sent; and a desktop app has nowhere good to put an
 * overlay checkout, so this hands back a URL to open in a real browser where
 * the person can see the address bar they are typing a card number into.
 */
export async function createCheckout(input: {
  userId: string;
  priceId: string;
  /** For a key pack: how many keys the purchase is worth. */
  keys?: number;
}): Promise<{ url: string }> {
  if (!config.PADDLE_API_KEY) {
    throw new Error('Paddle is not configured on this server');
  }

  const response = await fetch(`${API_BASE()}/transactions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.PADDLE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      items: [{ price_id: input.priceId, quantity: 1 }],
      // Comes back on every webhook about this purchase, and is the only thing
      // tying the money to an account here.
      custom_data: { userId: input.userId, ...(input.keys ? { keys: input.keys } : {}) },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Paddle refused the checkout: ${response.status} ${detail.slice(0, 200)}`);
  }

  const body = (await response.json()) as { data?: { checkout?: { url?: string } } };
  const url = body.data?.checkout?.url;
  if (!url) throw new Error('Paddle returned no checkout URL');

  return { url };
}

/** Whether this server can take money at all. */
export function isConfigured(): boolean {
  return Boolean(config.PADDLE_API_KEY && config.PADDLE_WEBHOOK_SECRET);
}
