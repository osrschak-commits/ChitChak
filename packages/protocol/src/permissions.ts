/**
 * Ranks and permissions.
 *
 * A rank is a named bundle of permissions plus a position in a hierarchy. Every
 * member holds the guild's default rank implicitly, and any number of others on
 * top; their effective permissions are the union.
 *
 * Permissions are a bitfield. `number` rather than `bigint`: JS integers are
 * exact to 2^53, which leaves room for 53 flags - far more than this will grow
 * to - and avoids BigInt serialisation at every boundary.
 */

export const Permission = {
  /** See the channel at all. Denying this hides it from the client entirely. */
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  /** Delete or pin anyone's messages. Deleting your own never needs this. */
  MANAGE_MESSAGES: 1 << 2,

  /** Join a voice channel. */
  CONNECT: 1 << 3,
  /** Transmit audio once connected. Without it you are in the room, listening. */
  SPEAK: 1 << 4,
  VIDEO: 1 << 5,
  SCREEN_SHARE: 1 << 6,

  /** Server-mute someone, enforced by the SFU rather than by their client. */
  MUTE_MEMBERS: 1 << 7,
  /** Move someone between voice channels, or disconnect them. */
  MOVE_MEMBERS: 1 << 8,
  KICK_MEMBERS: 1 << 9,
  BAN_MEMBERS: 1 << 10,

  MANAGE_CHANNELS: 1 << 11,
  MANAGE_RANKS: 1 << 12,
  /** Rename the server, change its icon. */
  MANAGE_SERVER: 1 << 13,
  CREATE_INVITE: 1 << 14,
  /** Revoke invites made by other people. */
  MANAGE_INVITES: 1 << 15,

  /** Grants everything, and bypasses channel overwrites. */
  ADMINISTRATOR: 1 << 16,
} as const;

export type PermissionName = keyof typeof Permission;

export const ALL_PERMISSIONS = Object.values(Permission).reduce((acc, bit) => acc | bit, 0);

/** What a brand new server's default rank gets: participate fully, administer nothing. */
export const DEFAULT_RANK_PERMISSIONS =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.VIDEO |
  Permission.SCREEN_SHARE |
  Permission.CREATE_INVITE;

/**
 * Grouped for the permission editor, so the UI does not have to hold its own
 * copy of this list and drift out of step with the model.
 */
export const PERMISSION_GROUPS: Array<{
  label: string;
  permissions: Array<{ key: PermissionName; label: string; description: string }>;
}> = [
  {
    label: 'General',
    permissions: [
      { key: 'VIEW_CHANNEL', label: 'View channels', description: 'See channels and their history.' },
      { key: 'CREATE_INVITE', label: 'Create invites', description: 'Generate codes that let others join.' },
      { key: 'ADMINISTRATOR', label: 'Administrator', description: 'Every permission, and bypasses channel restrictions. Give sparingly.' },
    ],
  },
  {
    label: 'Text',
    permissions: [
      { key: 'SEND_MESSAGES', label: 'Send messages', description: 'Write in text channels.' },
      { key: 'MANAGE_MESSAGES', label: 'Manage messages', description: "Delete other people's messages." },
    ],
  },
  {
    label: 'Voice',
    permissions: [
      { key: 'CONNECT', label: 'Connect', description: 'Join voice channels.' },
      { key: 'SPEAK', label: 'Speak', description: 'Transmit audio. Without it, listen only.' },
      { key: 'VIDEO', label: 'Use camera', description: 'Turn a camera on in a call.' },
      { key: 'SCREEN_SHARE', label: 'Share screen', description: 'Present a screen or window.' },
    ],
  },
  {
    label: 'Moderation',
    permissions: [
      { key: 'MUTE_MEMBERS', label: 'Mute members', description: 'Silence someone for everyone, enforced by the server.' },
      { key: 'MOVE_MEMBERS', label: 'Move members', description: 'Move people between voice channels, or disconnect them.' },
      { key: 'KICK_MEMBERS', label: 'Kick members', description: 'Remove someone. They can rejoin with an invite.' },
      { key: 'BAN_MEMBERS', label: 'Ban members', description: 'Remove someone and stop them rejoining.' },
    ],
  },
  {
    label: 'Server',
    permissions: [
      { key: 'MANAGE_CHANNELS', label: 'Manage channels', description: 'Create, edit, reorder and delete channels.' },
      { key: 'MANAGE_RANKS', label: 'Manage ranks', description: 'Create ranks and assign them, below your own.' },
      { key: 'MANAGE_SERVER', label: 'Manage server', description: 'Rename the server and change its icon.' },
      { key: 'MANAGE_INVITES', label: 'Manage invites', description: 'Revoke invites created by others.' },
    ],
  },
];

export function has(permissions: number, permission: number): boolean {
  // ADMINISTRATOR is a superset by definition; checking it here means no call
  // site can forget to.
  if ((permissions & Permission.ADMINISTRATOR) !== 0) return true;
  return (permissions & permission) === permission;
}

export function hasAll(permissions: number, ...required: number[]): boolean {
  return required.every((permission) => has(permissions, permission));
}

/**
 * Applies a channel's overwrites to a base permission set.
 *
 * Denies are applied before allows, so an explicit allow on a more specific
 * rank wins over a broad deny - the behaviour people expect when they grant one
 * rank access to an otherwise-closed channel.
 */
export function applyOverwrites(
  base: number,
  overwrites: Array<{ allow: number; deny: number }>,
): number {
  if ((base & Permission.ADMINISTRATOR) !== 0) return ALL_PERMISSIONS;

  let deny = 0;
  let allow = 0;
  for (const overwrite of overwrites) {
    deny |= overwrite.deny;
    allow |= overwrite.allow;
  }
  return (base & ~deny) | allow;
}

export function permissionNames(permissions: number): PermissionName[] {
  return (Object.keys(Permission) as PermissionName[]).filter(
    (name) => (permissions & Permission[name]) !== 0,
  );
}
