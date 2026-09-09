import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors } from '../lib/errors.js';
import { checkSession } from '../lib/session-validity.js';
import { verifyAccessToken } from '../lib/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the `authenticate` preHandler. Absent on public routes. */
    user?: { userId: string; username: string };
  }
}

/**
 * `preHandler` for routes that require a signed-in user.
 *
 * Access tokens only - refresh tokens are deliberately not accepted here, so a
 * stolen refresh token cannot be replayed against the API directly without
 * first going through the rotation endpoint, where reuse is detected.
 */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing Authorization: Bearer <token>');
  }

  const claims = await verifyAccessToken(header.slice('Bearer '.length).trim());
  if (!claims) throw errors.unauthorized('Access token is invalid or expired');

  // A valid signature is not the whole question: the account behind it may have
  // been deleted, suspended, or had every session revoked by a password reset,
  // since this token was minted.
  const verdict = await checkSession(claims);
  if (!verdict.ok) {
    // 403 for a suspension, not 401. The distinction is the whole point: a 401
    // sends the client round the sign-in loop, which for a suspended account
    // cannot succeed and explains nothing, while a 403 carries the reason
    // through to somebody who needs to read it.
    throw verdict.reason === 'suspended'
      ? errors.suspended(verdict.message)
      : errors.unauthorized(verdict.message);
  }

  request.user = claims;
}

/** Narrows `request.user` for handlers behind `authenticate`. */
export function requireUser(request: FastifyRequest): { userId: string; username: string } {
  if (!request.user) throw errors.unauthorized();
  return request.user;
}
