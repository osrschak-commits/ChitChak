import { config } from '../config.js';
import { errors } from '../lib/errors.js';

/**
 * Platform staff: the small number of people who may act outside a server's own
 * hierarchy.
 *
 * This exists because somebody has to be able to deal with abuse in a server
 * they are not in and were never invited to. That is a real need for anything
 * hosted for other people, and pretending otherwise just means the only remedy
 * is a database query at three in the morning.
 *
 * It is deliberately narrow. Staff can *moderate* - remove people, remove
 * messages, quieten a call - and can issue black cards. Staff cannot read
 * private conversations, cannot join a channel they were not admitted to, and
 * get no standing inside a server they belong to as an ordinary member. The
 * power is over behaviour, not over content.
 *
 * The list is a deploy-time setting rather than a database column, so the answer
 * to "who can act on anyone" is one line of config, and no bug in the app can
 * add somebody to it.
 */

const admins = new Set(
  (config.PLATFORM_ADMINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
);

export function isPlatformStaff(userId: string): boolean {
  return admins.has(userId);
}

/** @throws unless this is one of the operators of this deployment. */
export function requirePlatformStaff(userId: string): void {
  if (!isPlatformStaff(userId)) {
    // Deliberately the same answer an ordinary user gets for anything they may
    // not do. Confirming that a staff-only route exists tells somebody probing
    // for one that it is worth probing.
    throw errors.forbidden('You do not have permission to do that');
  }
}

/** How many, for the boot log - so a deployment says out loud what it granted. */
export function platformStaffCount(): number {
  return admins.size;
}
