import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
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
export async function sessionIsStillValid(claims: AccessTokenClaims): Promise<boolean> {
  const user = await db.query.users.findFirst({
    columns: { tokensValidFrom: true, deletedAt: true },
    where: eq(users.id, claims.userId),
  });

  if (!user || user.deletedAt) return false;

  // `iat` is whole seconds, and tokensValidFrom is a millisecond timestamp. A
  // token issued in the same second as the cutoff would otherwise be rejected
  // by rounding alone, so the comparison is done in seconds and the token gets
  // the benefit of the boundary.
  const validFrom = Math.floor(user.tokensValidFrom.getTime() / 1000);
  return claims.issuedAt >= validFrom;
}
