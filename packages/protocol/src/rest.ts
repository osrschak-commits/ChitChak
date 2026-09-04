import { z } from 'zod';
import type { Channel, Guild, SelfUser } from './entities.js';

/**
 * Request schemas for the HTTP API. Shared so the client validates before
 * sending and the server validates on receipt from the same definition -
 * they cannot drift apart.
 */

export const usernameSchema = z
  .string()
  .min(2, 'Username must be at least 2 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(/^[a-z0-9._-]+$/, 'Username may only contain lowercase letters, digits, dot, underscore and hyphen');

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password must be at most 200 characters');

/** Six-digit hex, with the hash. Anything looser lets `red` or `url(...)` into a style attribute. */
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Pick a colour in #rrggbb form');

export const registerSchema = z.object({
  email: z.string().email(),
  username: usernameSchema,
  displayName: z.string().min(1).max(48).optional(),
  password: passwordSchema,
  /** Required only when the server is configured with a signup code. */
  signupCode: z.string().max(200).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const updateProfileSchema = z
  .object({
    displayName: z.string().min(1, 'Display name cannot be empty').max(48),
    username: usernameSchema,
    bio: z.string().max(280, 'Bio must be at most 280 characters'),
    accentColor: hexColorSchema,
  })
  // Every field optional: the profile form sends only what changed, so an
  // untouched field is never at risk of being blanked by an empty string.
  .partial();

/**
 * Images arrive as data URLs rather than multipart.
 *
 * The client resizes to 256x256 in a canvas before upload, so payloads are tens
 * of kilobytes and the alternative - a multipart parser plus an image pipeline -
 * buys nothing. The size ceiling is enforced again on the server.
 */
export const imageUploadSchema = z.object({
  dataUrl: z
    .string()
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/, 'Upload a PNG, JPEG or WebP image')
    .max(700_000, 'That image is too large'),
});

export const createGuildSchema = z.object({
  name: z.string().min(2).max(64),
});

export const updateGuildSchema = z
  .object({
    name: z.string().min(2, 'Server name must be at least 2 characters').max(64),
  })
  .partial();

export const channelNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\s#@][^#@]*$/, 'Channel name may not start with whitespace or contain # or @');

export const createChannelSchema = z.object({
  name: channelNameSchema,
  kind: z.enum(['text', 'voice']),
  topic: z.string().max(200).optional(),
  userLimit: z.number().int().min(0).max(99).optional(),
});

export const updateChannelSchema = z
  .object({
    name: channelNameSchema,
    topic: z.string().max(200).nullable(),
    position: z.number().int().min(0).max(999),
    userLimit: z.number().int().min(0).max(99),
  })
  .partial();

export const joinByInviteSchema = z.object({
  code: z.string().min(4).max(16),
});

// --- Ranks ------------------------------------------------------------------

/** Bitfields are validated as safe integers, not just "a number". */
const permissionBitsSchema = z
  .number()
  .int('Permissions must be a whole number')
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const createRankSchema = z.object({
  name: z.string().min(1, 'Ranks need a name').max(32),
  color: hexColorSchema.nullable().optional(),
  permissions: permissionBitsSchema.optional(),
});

export const updateRankSchema = z
  .object({
    name: z.string().min(1).max(32),
    color: hexColorSchema.nullable(),
    permissions: permissionBitsSchema,
  })
  .partial();

export const reorderRanksSchema = z.object({
  /** Rank ids, most senior first. */
  order: z.array(z.string()).max(100),
});

export const setMemberRanksSchema = z.object({
  rankIds: z.array(z.string()).max(50),
});

export const updateNicknameSchema = z.object({
  nickname: z.string().max(48).nullable(),
});

// --- Channel overwrites -----------------------------------------------------

export const setOverwriteSchema = z.object({
  rankId: z.string().min(1),
  allow: permissionBitsSchema,
  deny: permissionBitsSchema,
});

// --- Moderation -------------------------------------------------------------

export const banMemberSchema = z.object({
  reason: z.string().max(500).nullable().optional(),
  /** Also delete their recent messages. */
  deleteMessages: z.boolean().optional(),
});

export const voiceModerationSchema = z.object({
  serverMuted: z.boolean().optional(),
  serverDeafened: z.boolean().optional(),
  /** Move them to this channel, or null to disconnect them from voice. */
  channelId: z.string().nullable().optional(),
});

// --- Messages ---------------------------------------------------------------

export const editMessageSchema = z.object({
  content: z.string().min(1, 'A message cannot be empty').max(4000),
});

// --- Invites ----------------------------------------------------------------

export const createInviteSchema = z
  .object({
    /** Seconds until it expires; 0 or omitted means never. */
    expiresIn: z.number().int().min(0).max(60 * 60 * 24 * 30),
    /** 0 means unlimited. */
    maxUses: z.number().int().min(0).max(1000),
  })
  .partial();

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;
export type UpdateProfileBody = z.infer<typeof updateProfileSchema>;
export type ImageUploadBody = z.infer<typeof imageUploadSchema>;
export type CreateGuildBody = z.infer<typeof createGuildSchema>;
export type UpdateGuildBody = z.infer<typeof updateGuildSchema>;
export type CreateChannelBody = z.infer<typeof createChannelSchema>;
export type UpdateChannelBody = z.infer<typeof updateChannelSchema>;
export type JoinByInviteBody = z.infer<typeof joinByInviteSchema>;
export type CreateRankBody = z.infer<typeof createRankSchema>;
export type UpdateRankBody = z.infer<typeof updateRankSchema>;
export type SetMemberRanksBody = z.infer<typeof setMemberRanksSchema>;
export type SetOverwriteBody = z.infer<typeof setOverwriteSchema>;
export type BanMemberBody = z.infer<typeof banMemberSchema>;
export type VoiceModerationBody = z.infer<typeof voiceModerationSchema>;
export type EditMessageBody = z.infer<typeof editMessageSchema>;
export type CreateInviteBody = z.infer<typeof createInviteSchema>;

export interface AuthResponse {
  user: SelfUser;
  accessToken: string;
  refreshToken: string;
  /** Seconds until `accessToken` expires. */
  expiresIn: number;
}

export interface CreateGuildResponse {
  guild: Guild;
  channels: Channel[];
}

export interface ApiError {
  error: string;
  message: string;
  /** Present for 422s: field path -> problem. */
  details?: Record<string, string>;
}
