import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';

/**
 * Two-token auth.
 *
 * Access tokens are short-lived, stateless JWTs - they are verified with a
 * signature check and no database round trip, which matters because the gateway
 * verifies one on every connection.
 *
 * Refresh tokens are long-lived opaque random strings. They are stateful (a row
 * per token) specifically so they can be revoked: logging out, or a password
 * change, invalidates them immediately, which a stateless token cannot do.
 */

const secret = new TextEncoder().encode(config.JWT_SECRET);
const ISSUER = 'chitchak';
const AUDIENCE = 'chitchak-client';

export interface AccessTokenClaims {
  userId: string;
  username: string;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ username: claims.username })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.username !== 'string') return null;
    return { userId: payload.sub, username: payload.username };
  } catch {
    // Expired, wrong signature, malformed - all indistinguishable to the caller
    // on purpose. The client's response is the same either way: re-authenticate.
    return null;
  }
}

/** A new refresh token: the value to hand the client, and the hash to store. */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/**
 * Refresh tokens are stored hashed so that a leaked database dump does not hand
 * an attacker usable sessions. SHA-256 with no salt is correct here (unlike for
 * passwords): the input is 48 bytes of entropy, so there is nothing to brute
 * force and lookup by hash needs to be an indexed equality check.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function refreshTokensMatch(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash);
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function refreshTokenExpiry(): Date {
  return new Date(Date.now() + config.REFRESH_TOKEN_TTL * 1000);
}
