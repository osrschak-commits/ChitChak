import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors } from '../lib/errors.js';
import { sessionIsStillValid } from '../lib/session-validity.js';
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
  // been deleted, or had every session revoked by a password reset, since this
  // token was minted.
  if (!(await sessionIsStillValid(claims))) {
    throw errors.unauthorized('Session is no longer valid, please sign in again');
  }

  request.user = claims;
}

/** Narrows `request.user` for handlers behind `authenticate`. */
export function requireUser(request: FastifyRequest): { userId: string; username: string } {
  if (!request.user) throw errors.unauthorized();
  return request.user;
}
