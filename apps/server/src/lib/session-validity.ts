import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { currentSuspension, explain } from '../services/suspensions.js';
import type { AccessTokenClaims } from './tokens.js';

/**
 * The half of authentication a signature cannot do.
 *
 * An access token is stateless: it is valid because it is signed and unexpired,
 * and nothing about it can be withdrawn. That is fine for the fifteen minutes
 * it lives, right up until the moment someone resets a password because their
 * account was stolen, or deletes it entirely - both of which are supposed to
 * end every session immediately, and neither of which can touch a token that is
 * already out there.
 *
 * `users.tokensValidFrom` is the answer, and it existed before this file did:
 * bumped on password reset and on deletion, and documented in the schema as
 * making older tokens invalid. It simply was not read anywhere, so a stolen
 * token kept working for the rest of its lifetime and a deleted account could
 * keep using the API. This is where it is enforced.
 *
 * The cost is one indexed primary-key lookup per authenticated request. If that
 * ever shows up in a profile, the value is a natural fit for a short-lived
 * Redis entry - Redis is already in the stack - but a query is the honest
 * starting point and correctness comes first.
 */

/**
 * Why a session was refused, where saying so is useful.
 *
 * A boolean was enough while the only answers were "deleted" and "revoked",
 * both of which mean the same thing to a client: sign in again. Suspension does
 * not - "sign in again" sends somebody round a loop that cannot succeed and
 * tells them nothing. So the verdict carries the message the person should
 * actually be shown.
 */
export type SessionVerdict =
  | { ok: true }
  | { ok: false; reason: 'gone'; message: string }
  | { ok: false; reason: 'suspended'; message: string };

const GONE: SessionVerdict = {
  ok: false,
  reason: 'gone',
  message: 'Session is no longer valid, please sign in again',
};

export async function checkSession(claims: AccessTokenClaims): Promise<SessionVerdict> {
  const user = await db.query.users.findFirst({
    columns: {
      tokensValidFrom: true,
      deletedAt: true,
      suspendedAt: true,
      suspendedUntil: true,
      suspendedReason: true,
    },
    where: eq(users.id, claims.userId),
  });

  if (!user || user.deletedAt) return GONE;

  /*
    Asked before the token cutoff, and that order is the whole point.

    Suspending also bumps `tokensValidFrom`, so a suspended person fails both
    checks and whichever runs first decides what they are told. Behind the
    cutoff the answer was a coin toss on the clock: `iat` is whole seconds and
    gets the benefit of the boundary, so a token minted in the same second as
    the suspension came back "suspended" and one minted a second earlier came
    back "sign in again" - the same account, the same moment, two different
    answers depending on when they last refreshed.

    Suspension is also the more specific statement of the two. "Your account is
    suspended until Tuesday" is what somebody needs; "sign in again" is what
    they get told when we do not know.
  */
  const suspension = currentSuspension(user);
  if (suspension) {
    return { ok: false, reason: 'suspended', message: explain(suspension) };
  }

  // `iat` is whole seconds, and tokensValidFrom is a millisecond timestamp. A
  // token issued in the same second as the cutoff would otherwise be rejected
  // by rounding alone, so the comparison is done in seconds and the token gets
  // the benefit of the boundary.
  const validFrom = Math.floor(user.tokensValidFrom.getTime() / 1000);
  if (claims.issuedAt < validFrom) return GONE;

  return { ok: true };
}

/** The old boolean shape, for call sites that only need to know yes or no. */
export async function sessionIsStillValid(claims: AccessTokenClaims): Promise<boolean> {
  return (await checkSession(claims)).ok;
}
