import type { GatewayErrorCode } from '@chitchak/protocol';

/**
 * One error type for expected, client-facing failures.
 *
 * Carrying both an HTTP status and a gateway error code means the same service
 * function can be called from a REST route and from a WebSocket handler and
 * produce a sensible failure in either shape. Anything that is *not* an AppError
 * is a bug, and is logged and reported as a generic 500 rather than leaking
 * internals to the client.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: GatewayErrorCode;
  readonly details: Record<string, string> | undefined;

  constructor(
    status: number,
    code: GatewayErrorCode,
    message: string,
    details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  unauthorized: (message = 'Authentication required') => new AppError(401, 'invalid_token', message),
  forbidden: (message = 'You do not have access to that') => new AppError(403, 'forbidden', message),
  /**
   * The account is locked out, and the message says why.
   *
   * 403 rather than 401 on purpose: a 401 makes the client refresh and retry,
   * then sign in again, which for a suspended account is a loop that cannot
   * succeed and never shows anybody the reason.
   */
  suspended: (message: string) => new AppError(403, 'suspended', message),
  /**
   * `not_found`, not `unknown_channel`.
   *
   * Every 404 in the app used to claim to be about a channel, including "no such
   * message", "no such item", and "nobody here is called that". The code is
   * meant to be the machine-readable half of the answer, and one that is wrong
   * most of the time is worse than none.
   */
  notFound: (message = 'Not found') => new AppError(404, 'not_found', message),
  channelFull: (message = 'That voice channel is full') => new AppError(409, 'channel_full', message),
  invalid: (message: string, details?: Record<string, string>) =>
    new AppError(422, 'invalid_payload', message, details),
  rateLimited: (message = 'Slow down') => new AppError(429, 'rate_limited', message),
  conflict: (message: string) => new AppError(409, 'invalid_payload', message),
};

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
