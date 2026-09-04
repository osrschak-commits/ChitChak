import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors } from '../lib/errors.js';
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

  request.user = claims;
}

/** Narrows `request.user` for handlers behind `authenticate`. */
export function requireUser(request: FastifyRequest): { userId: string; username: string } {
  if (!request.user) throw errors.unauthorized();
  return request.user;
}
