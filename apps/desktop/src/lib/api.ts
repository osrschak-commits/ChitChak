import type {
  ApiError,
  Attachment,
  Emoji,
  Progress,
  AuthResponse,
  Ban,
  Channel,
  ChannelOverwrite,
  CreateGuildResponse,
  Guild,
  GuildMember,
  Invite,
  Message,
  PublicUser,
  Rank,
  SelfUser,
} from '@chitchak/protocol';

/** A badge somebody is wearing, with enough to draw it and to explain it. */
export interface WornBadge {
  id: string;
  name: string;
  /** What the badge is for. Shown on hover. */
  blurb: string;
  /** The glyph, drawn when there is no artwork for this badge yet. */
  value: string;
  rarity?: Rarity;
}

/** What somebody's card shows beyond their name. */
export interface Flair {
  level: number;
  /** A CSS background for the card's plate, or null. */
  plate: string | null;
  badge: WornBadge | null;
}

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export type ReportStatus = 'open' | 'actioned' | 'dismissed';

export interface QueuedReport {
  id: string;
  at: string;
  status: ReportStatus;
  reason: string;
  /** The message as it read when it was reported - kept even if it is deleted. */
  quoted: string | null;
  reporter: string;
  subject: string;
  subjectId: string;
  subjectSuspended: boolean;
  /** How many reports this person has in all. Context one row cannot give. */
  subjectReports: number;
  guildId: string | null;
  channelId: string | null;
  messageId: string | null;
  handledBy: string | null;
  handledAt: string | null;
  outcome: string | null;
}

export interface SuspendedAccount {
  userId: string;
  username: string;
  displayName: string;
  at: string;
  /** null means indefinitely. */
  until: string | null;
  reason: string;
}

export interface CosmeticItem {
  id: string;
  name: string;
  slot: 'plate' | 'badge';
  blurb: string;
  price: number;
  /** Present only for things the chest can give. */
  rarity?: Rarity;
  /** Included with a subscription rather than bought with keys. */
  requiresSubscription?: boolean;
  /** Given out rather than sold - the server only lists one you have. */
  awarded?: boolean;
  /** Earned by having had an account this long. */
  earnedAfterDays?: number;
  /** How to draw it - a gradient for a plate, a glyph for a badge. */
  value: string;
  owned: boolean;
  equipped: boolean;
  /** Whether it can be worn right now - bought, or included and subscribed. */
  available: boolean;
}

export interface PremiumState {
  subscription: { status: string; active: boolean; renewsAt: string | null };
  keys: number;
  keysPerPeriod: number;
  items: CosmeticItem[];
  chest: ChestStatus;
}

export interface ChestStatus {
  cost: number;
  /** Published odds, as percentages. The same numbers the server rolls against. */
  rates: Record<Rarity, number>;
  collected: number;
  total: number;
}

export interface ChestResult {
  cosmetic: CosmeticItem;
  keys: number;
  remaining: number;
  collected: number;
  total: number;
}

export interface KeyEntry {
  amount: number;
  reason: string;
  reference: string | null;
  at: string;
}

/** One row of the task list. Mirrors what GET /api/tasks returns. */
export interface TaskSummary {
  id: string;
  name: string;
  group: string;
  how: string;
  xp: number;
  goal: number;
  done: boolean;
  progress: number;
}

/**
 * HTTP client.
 *
 * Owns the token pair and the refresh dance so that no caller ever has to think
 * about expiry: a 401 triggers one refresh and one retry, transparently.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:4000';
const STORAGE_KEY = 'chitchak.session';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, string> | undefined;

  constructor(status: number, body: ApiError) {
    super(body.message || 'Request failed');
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.error;
    this.details = body.details;
  }
}

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: SelfUser;
}

function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    // Corrupt or unavailable storage should log the user out, not crash boot.
    return null;
  }
}

class ApiClient {
  private session: StoredSession | null = loadSession();
  /**
   * In-flight refresh, shared by every caller that 401s at the same moment.
   * Without this, six parallel requests on a cold start would each burn a
   * refresh token, and rotation would revoke five of them as replays.
   */
  private refreshing: Promise<boolean> | null = null;
  private sessionEndedHandlers = new Set<() => void>();

  /**
   * Called when a session ends, however it ends.
   *
   * Signing out is the obvious way. The one this exists for is the other one: a
   * refresh token the server no longer accepts clears the session from inside a
   * failed request, several layers below anything that renders. Without a way
   * to say so, the app keeps showing a signed-in shell for an account it can no
   * longer act as, and the only way out is to restart it.
   */
  onSessionEnded(handler: () => void): () => void {
    this.sessionEndedHandlers.add(handler);
    return () => this.sessionEndedHandlers.delete(handler);
  }

  get accessToken(): string | null {
    return this.session?.accessToken ?? null;
  }

  get user(): SelfUser | null {
    return this.session?.user ?? null;
  }

  get isAuthenticated(): boolean {
    return this.session !== null;
  }

  private persist(session: StoredSession | null): void {
    const ended = this.session !== null && session === null;
    this.session = session;
    try {
      if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Non-fatal: the session simply will not survive a restart.
    }
    // Announced after the write, so a handler that asks `isAuthenticated` gets
    // the answer that is now true rather than the one it is reacting to.
    if (ended) for (const handler of this.sessionEndedHandlers) handler();
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const headers = new Headers(init.headers);
    const method = (init.method ?? 'GET').toUpperCase();

    // Fastify rejects a body-bearing method with no Content-Type as 415, even
    // when the body is empty. Endpoints that take no arguments (create invite,
    // for instance) would otherwise fail before reaching their handler.
    const sendsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
    const requestBody = init.body ?? (sendsBody ? '{}' : undefined);
    if (requestBody !== undefined) headers.set('Content-Type', 'application/json');
    if (this.session) headers.set('Authorization', `Bearer ${this.session.accessToken}`);

    const response = await fetch(`${API_BASE}${path}`, { ...init, headers, body: requestBody });

    if (response.status === 401 && retry && this.session) {
      const refreshed = await this.refresh();
      if (refreshed) return this.request<T>(path, init, false);
      this.persist(null);
    }

    if (response.status === 204) return undefined as T;

    const payload = (await response.json().catch(() => ({
      error: 'network',
      message: `Unexpected ${response.status} response`,
    }))) as unknown;

    /*
      A suspension ends the session, wherever it is noticed.

      Every authenticated route answers this way once an account is locked out,
      so without it the app sits in a signed-in shell where nothing works and
      nothing explains itself. Clearing the session drops the person back to
      the sign-in screen, which then refuses them with the same reason - the
      one place where being told is any use.
    */
    if (!response.ok && (payload as ApiError)?.error === 'suspended') {
      this.suspendedMessage = (payload as ApiError).message;
      if (this.session) this.persist(null);
    }

    if (!response.ok) throw new ApiRequestError(response.status, payload as ApiError);
    return payload as T;
  }

  /**
   * Why the last session ended, when it ended in a suspension.
   *
   * Read by the sign-in screen so somebody who was thrown out mid-session sees
   * the reason immediately, rather than only after trying to sign in again and
   * being refused a second time.
   */
  suspendedMessage: string | null = null;

  /**
   * Ends the session because the account has been suspended.
   *
   * Called from the gateway, which learns about a suspension before any HTTP
   * request does - the socket is closed the moment staff act, while the next
   * API call might be minutes away. Without this the client would sit in a
   * signed-in shell reconnecting to a socket that will never accept it.
   */
  endSessionAsSuspended(message: string): void {
    this.suspendedMessage = message;
    if (this.session) this.persist(null);
  }

  private async refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      const refreshToken = this.session?.refreshToken;
      if (!refreshToken) return false;
      try {
        const response = await fetch(`${API_BASE}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!response.ok) return false;
        const auth = (await response.json()) as AuthResponse;
        this.persist({
          accessToken: auth.accessToken,
          refreshToken: auth.refreshToken,
          user: auth.user,
        });
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }

  // --- Auth ---------------------------------------------------------------

  /** Server capabilities the sign-up screen needs before anyone is signed in. */
  serverConfig(): Promise<{ signupCodeRequired: boolean }> {
    return this.request<{ signupCodeRequired: boolean }>('/api/config');
  }

  async register(input: {
    email: string;
    username: string;
    password: string;
    displayName?: string;
    signupCode?: string;
  }): Promise<SelfUser> {
    const auth = await this.request<AuthResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    this.persist({ accessToken: auth.accessToken, refreshToken: auth.refreshToken, user: auth.user });
    return auth.user;
  }

  async login(email: string, password: string): Promise<SelfUser> {
    const auth = await this.request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    this.persist({ accessToken: auth.accessToken, refreshToken: auth.refreshToken, user: auth.user });
    return auth.user;
  }

  /**
   * Ask for a reset link.
   *
   * Resolves the same way whether or not the address has an account - the
   * server answers 204 either way, on purpose, so that this cannot be used to
   * find out who is registered. The screen says "if that address has an
   * account" for the same reason.
   */
  async requestPasswordReset(email: string): Promise<void> {
    await this.request<void>('/api/auth/password/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  /**
   * Search one channel.
   *
   * The query goes to the server as typed: quoted phrases, `or`, and a leading
   * `-` to exclude all work, because Postgres' websearch parser understands
   * them and there is no reason to teach the client a second syntax.
   */
  searchMessages(
    channelId: string,
    options: { q: string; authorId?: string; before?: string; limit?: number },
  ): Promise<Message[]> {
    const query = new URLSearchParams({ q: options.q });
    if (options.authorId) query.set('authorId', options.authorId);
    if (options.before) query.set('before', options.before);
    if (options.limit) query.set('limit', String(options.limit));
    return this.request<Message[]>(`/api/channels/${channelId}/messages/search?${query}`);
  }

  // --- Staff ----------------------------------------------------------------

  /** Whether this account may act across every server. */
  amIStaff(): Promise<{ staff: boolean }> {
    return this.request('/api/admin/me');
  }

  /** A year of Brass, given rather than sold. */
  issueBlackCard(username: string): Promise<{ username: string; cardId: string }> {
    return this.request('/api/admin/black-card', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
  }

  /**
   * Takes a card back. Refuses on a subscription that was paid for.
   *
   * `keysTaken` is what was actually reclaimed, which may be fewer than the
   * twenty-four granted - the rest were already spent.
   */
  revokeBlackCard(username: string): Promise<{ username: string; keysTaken: number }> {
    return this.request('/api/admin/black-card', {
      method: 'DELETE',
      body: JSON.stringify({ username }),
    });
  }

  listBlackCards(): Promise<{
    cards: Array<{
      at: string;
      actor: string;
      subject: string | null;
      detail: string | null;
      action: string;
    }>;
  }> {
    return this.request('/api/admin/black-cards');
  }

  // --- Moderation -----------------------------------------------------------

  /**
   * Report a message, or a person.
   *
   * The only route in this section an ordinary account can call. Nothing comes
   * back but an id: what happens next is about somebody else's account, and is
   * not the reporter's to be told.
   */
  fileReport(input: {
    messageId?: string;
    username?: string;
    reason: string;
  }): Promise<{ id: string }> {
    return this.request('/api/reports', { method: 'POST', body: JSON.stringify(input) });
  }

  /** Lock an account out. `days` omitted means indefinitely. */
  suspendAccount(input: {
    username: string;
    reason: string;
    days?: number | null;
  }): Promise<{ username: string; until: string | null; reason: string }> {
    return this.request('/api/admin/suspend', { method: 'POST', body: JSON.stringify(input) });
  }

  liftSuspension(username: string): Promise<{ username: string }> {
    return this.request('/api/admin/suspend', {
      method: 'DELETE',
      body: JSON.stringify({ username }),
    });
  }

  listSuspended(): Promise<{ accounts: SuspendedAccount[] }> {
    return this.request('/api/admin/suspended');
  }

  listReports(status?: ReportStatus): Promise<{ reports: QueuedReport[]; open: number }> {
    return this.request(`/api/admin/reports${status ? `?status=${status}` : ''}`);
  }

  resolveReport(
    reportId: string,
    status: 'actioned' | 'dismissed',
    outcome?: string,
  ): Promise<QueuedReport> {
    return this.request(`/api/admin/reports/${reportId}`, {
      method: 'POST',
      body: JSON.stringify({ status, outcome }),
    });
  }

  // --- Premium --------------------------------------------------------------

  deleteEmoji(guildId: string, emojiId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/guilds/${guildId}/emoji/${emojiId}`, { method: 'DELETE' });
  }

  /** Catalogue, ownership, balance and subscription, in one request. */
  premium(): Promise<PremiumState> {
    return this.request('/api/premium');
  }

  /** Spends a key and returns what came out. The roll happens on the server. */
  openChest(): Promise<ChestResult> {
    return this.request('/api/premium/chest', { method: 'POST' });
  }

  buyCosmetic(cosmeticId: string): Promise<{ keys: number }> {
    return this.request('/api/premium/buy', {
      method: 'POST',
      body: JSON.stringify({ cosmeticId }),
    });
  }

  /** `cosmeticId: null` takes off whatever is in that slot. */
  equipCosmetic(cosmeticId: string | null, slot: string): Promise<{ worn: Record<string, string | null> }> {
    return this.request('/api/premium/equip', {
      method: 'POST',
      body: JSON.stringify({ cosmeticId, slot }),
    });
  }

  /** What this server can sell, if anything. */
  premiumStore(): Promise<{ open: boolean; packs: Array<{ id: string; keys: number | null }> }> {
    return this.request('/api/premium/store');
  }

  /** Start a checkout and get somewhere to send them. */
  checkout(pack: string): Promise<{ url: string }> {
    return this.request('/api/premium/checkout', {
      method: 'POST',
      body: JSON.stringify({ pack }),
    });
  }

  keyHistory(): Promise<{ entries: KeyEntry[] }> {
    return this.request('/api/premium/keys');
  }

  // --- Levels ---------------------------------------------------------------

  /**
   * Every task, with your progress through the unfinished ones.
   *
   * Fetched rather than bundled into the client: the names, thresholds and XP
   * live in the server's catalogue, and a second copy here would be wrong the
   * first time either changed.
   */
  listTasks(): Promise<{ tasks: TaskSummary[]; progress: Progress }> {
    return this.request('/api/tasks');
  }

  /**
   * Somebody else's level and what they are wearing, for their card.
   *
   * Not their XP or their tasks - see the route. Fetched when a card opens
   * rather than carried on every user payload.
   */
  flairOf(userId: string): Promise<Flair> {
    return this.request(`/api/users/${userId}/level`);
  }

  // --- Friends --------------------------------------------------------------

  /**
   * Ask someone to be your friend, by exact username.
   *
   * Returns `accepted` rather than `pending` when they had already asked you -
   * asking back is consent, so the server treats it as an acceptance and hands
   * over the conversation.
   */
  sendFriendRequest(username: string): Promise<{
    state: 'pending' | 'accepted';
    user: PublicUser;
    channel?: Channel;
  }> {
    return this.request('/api/friends/requests', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
  }

  acceptFriendRequest(userId: string): Promise<{ user: PublicUser; channel: Channel }> {
    return this.request(`/api/friends/requests/${userId}/accept`, { method: 'POST' });
  }

  /** Declines an incoming request, or cancels one you sent. */
  async dismissFriendRequest(userId: string): Promise<void> {
    await this.request<void>(`/api/friends/requests/${userId}`, { method: 'DELETE' });
  }

  async unfriend(userId: string): Promise<void> {
    await this.request<void>(`/api/friends/${userId}`, { method: 'DELETE' });
  }

  /** Opens the conversation with a friend. Idempotent - safe to call every time. */
  openDm(userId: string): Promise<Channel> {
    return this.request(`/api/friends/${userId}/dm`, { method: 'POST' });
  }

  async blockUser(userId: string): Promise<void> {
    await this.request<void>('/api/blocks', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async unblockUser(userId: string): Promise<void> {
    await this.request<void>(`/api/blocks/${userId}`, { method: 'DELETE' });
  }

  listBlocked(): Promise<PublicUser[]> {
    return this.request('/api/blocks');
  }

  /**
   * Deletes the signed-in account, permanently.
   *
   * The password goes with it because the session alone is not proof enough for
   * something irreversible. Throws with a readable message if the account still
   * owns servers - those have to be handed over or deleted first.
   */
  async deleteAccount(password: string): Promise<void> {
    await this.request<void>('/api/users/@me', {
      method: 'DELETE',
      body: JSON.stringify({ password }),
    });
    // The account is gone server-side; keeping its tokens would only produce a
    // shell that 401s on its first request.
    this.persist(null);
  }

  /** Sets a new password from an emailed token, ending every existing session. */
  async resetPassword(token: string, password: string): Promise<void> {
    await this.request<void>('/api/auth/password/reset', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  }

  async logout(): Promise<void> {
    const refreshToken = this.session?.refreshToken;
    this.persist(null);
    if (!refreshToken) return;
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {});
  }

  /**
   * A fresh access token for the gateway.
   *
   * The gateway verifies the token once at identify and then holds the socket
   * open, so handing it one that is about to expire would fail the connection
   * for no good reason.
   */
  async freshAccessToken(): Promise<string | null> {
    if (!this.session) return null;
    await this.refresh();
    return this.session?.accessToken ?? null;
  }

  // --- Resources ----------------------------------------------------------

  listGuilds(): Promise<Guild[]> {
    return this.request<Guild[]>('/api/guilds');
  }

  createGuild(name: string): Promise<CreateGuildResponse> {
    return this.request<CreateGuildResponse>('/api/guilds', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  createChannel(
    guildId: string,
    input: { name: string; kind: 'text' | 'voice'; topic?: string; userLimit?: number },
  ): Promise<Channel> {
    return this.request<Channel>(`/api/guilds/${guildId}/channels`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  deleteChannel(channelId: string): Promise<void> {
    return this.request<void>(`/api/channels/${channelId}`, { method: 'DELETE' });
  }

  listMessages(channelId: string, before?: string): Promise<Message[]> {
    const query = before ? `?before=${encodeURIComponent(before)}` : '';
    return this.request<Message[]>(`/api/channels/${channelId}/messages${query}`);
  }

  createInvite(
    guildId: string,
    input: { expiresIn?: number; maxUses?: number } = {},
  ): Promise<Invite> {
    return this.request<Invite>(`/api/guilds/${guildId}/invites`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  joinByInvite(code: string): Promise<{ guild: Guild; joined: boolean }> {
    return this.request('/api/invites/join', { method: 'POST', body: JSON.stringify({ code }) });
  }

  // --- Profile ------------------------------------------------------------

  async updateProfile(patch: {
    displayName?: string;
    username?: string;
    bio?: string;
    accentColor?: string;
  }): Promise<SelfUser> {
    const user = await this.request<SelfUser>('/api/users/@me', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    this.mergeUser(user);
    return user;
  }

  async uploadAvatar(dataUrl: string): Promise<SelfUser> {
    const user = await this.request<SelfUser>('/api/users/@me/avatar', {
      method: 'PUT',
      body: JSON.stringify({ dataUrl }),
    });
    this.mergeUser(user);
    return user;
  }

  async removeAvatar(): Promise<SelfUser> {
    const user = await this.request<SelfUser>('/api/users/@me/avatar', { method: 'DELETE' });
    this.mergeUser(user);
    return user;
  }

  // --- Server settings ----------------------------------------------------

  updateGuild(guildId: string, patch: { name?: string }): Promise<Guild> {
    return this.request<Guild>(`/api/guilds/${guildId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  uploadGuildIcon(guildId: string, dataUrl: string): Promise<Guild> {
    return this.request<Guild>(`/api/guilds/${guildId}/icon`, {
      method: 'PUT',
      body: JSON.stringify({ dataUrl }),
    });
  }

  deleteGuild(guildId: string): Promise<void> {
    return this.request<void>(`/api/guilds/${guildId}`, { method: 'DELETE' });
  }

  listMembers(guildId: string): Promise<GuildMember[]> {
    return this.request<GuildMember[]>(`/api/guilds/${guildId}/members`);
  }

  removeMember(guildId: string, userId: string): Promise<void> {
    return this.request<void>(`/api/guilds/${guildId}/members/${userId}`, { method: 'DELETE' });
  }

  updateChannel(
    channelId: string,
    patch: { name?: string; topic?: string | null; userLimit?: number; position?: number },
  ): Promise<Channel> {
    return this.request<Channel>(`/api/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  reorderChannels(guildId: string, order: string[]): Promise<Channel[]> {
    return this.request<Channel[]>(`/api/guilds/${guildId}/channels/order`, {
      method: 'PATCH',
      body: JSON.stringify({ order }),
    });
  }

  // --- Ranks --------------------------------------------------------------

  listRanks(guildId: string): Promise<Rank[]> {
    return this.request<Rank[]>(`/api/guilds/${guildId}/ranks`);
  }

  createRank(
    guildId: string,
    input: { name: string; color?: string | null; permissions?: number },
  ): Promise<Rank> {
    return this.request<Rank>(`/api/guilds/${guildId}/ranks`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  updateRank(
    rankId: string,
    patch: { name?: string; color?: string | null; permissions?: number },
  ): Promise<Rank> {
    return this.request<Rank>(`/api/ranks/${rankId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  deleteRank(rankId: string): Promise<void> {
    return this.request<void>(`/api/ranks/${rankId}`, { method: 'DELETE' });
  }

  reorderRanks(guildId: string, order: string[]): Promise<Rank[]> {
    return this.request<Rank[]>(`/api/guilds/${guildId}/ranks/order`, {
      method: 'PATCH',
      body: JSON.stringify({ order }),
    });
  }

  setMemberRanks(guildId: string, userId: string, rankIds: string[]): Promise<GuildMember> {
    return this.request<GuildMember>(`/api/guilds/${guildId}/members/${userId}/ranks`, {
      method: 'PUT',
      body: JSON.stringify({ rankIds }),
    });
  }

  setNickname(guildId: string, userId: string, nickname: string | null): Promise<GuildMember> {
    return this.request<GuildMember>(`/api/guilds/${guildId}/members/${userId}/nickname`, {
      method: 'PATCH',
      body: JSON.stringify({ nickname }),
    });
  }

  // --- Channel overwrites -------------------------------------------------

  listOverwrites(channelId: string): Promise<ChannelOverwrite[]> {
    return this.request<ChannelOverwrite[]>(`/api/channels/${channelId}/overwrites`);
  }

  setOverwrite(
    channelId: string,
    input: { rankId: string; allow: number; deny: number },
  ): Promise<ChannelOverwrite[]> {
    return this.request<ChannelOverwrite[]>(`/api/channels/${channelId}/overwrites`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  // --- Moderation ---------------------------------------------------------

  kickMember(guildId: string, userId: string): Promise<void> {
    return this.request<void>(`/api/guilds/${guildId}/members/${userId}`, { method: 'DELETE' });
  }

  listBans(guildId: string): Promise<Ban[]> {
    return this.request<Ban[]>(`/api/guilds/${guildId}/bans`);
  }

  banMember(
    guildId: string,
    userId: string,
    input: { reason?: string | null; deleteMessages?: boolean } = {},
  ): Promise<Ban> {
    return this.request<Ban>(`/api/guilds/${guildId}/bans/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  unbanMember(guildId: string, userId: string): Promise<void> {
    return this.request<void>(`/api/guilds/${guildId}/bans/${userId}`, { method: 'DELETE' });
  }

  moderateVoice(
    guildId: string,
    userId: string,
    input: { serverMuted?: boolean; serverDeafened?: boolean; channelId?: string | null },
  ): Promise<{ ok: boolean }> {
    return this.request(`/api/guilds/${guildId}/members/${userId}/voice`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  // --- Messages -----------------------------------------------------------

  editMessage(messageId: string, content: string): Promise<Message> {
    return this.request<Message>(`/api/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    });
  }

  deleteMessage(messageId: string): Promise<void> {
    return this.request<void>(`/api/messages/${messageId}`, { method: 'DELETE' });
  }

  // --- Invites ------------------------------------------------------------

  listInvites(guildId: string): Promise<Invite[]> {
    return this.request<Invite[]>(`/api/guilds/${guildId}/invites`);
  }

  revokeInvite(code: string): Promise<void> {
    return this.request<void>(`/api/invites/${code}`, { method: 'DELETE' });
  }

  /** Keeps the cached session in step after a profile change. */
  private mergeUser(user: SelfUser): void {
    if (!this.session) return;
    this.persist({ ...this.session, user });
  }
}

/**
 * Uploads one file and reports progress.
 *
 * XMLHttpRequest rather than fetch, for the one thing fetch still cannot do in
 * a browser: tell you how far a request body has got. A hundred-megabyte upload
 * with no progress is indistinguishable from a hung one, and the person waiting
 * has no way to tell whether to keep waiting.
 *
 * The body is the file itself rather than a multipart form. There is only ever
 * one file per request, so the envelope would carry nothing the query string and
 * the headers do not - and the browser streams a File body without reading it
 * into memory first.
 */
export function uploadFile(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const token = api.accessToken;
    if (!token) {
      reject(new Error('Not signed in'));
      return;
    }

    const request = new XMLHttpRequest();
    request.open('POST', `${API_BASE}/api/uploads?name=${encodeURIComponent(file.name)}`);
    request.setRequestHeader('Authorization', `Bearer ${token}`);
    // The server sniffs the bytes and ignores this, but sending nothing at all
    // makes some proxies guess, and a guess is worse than a declaration.
    request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText) as Attachment);
        } catch {
          reject(new Error('The server sent back something unreadable'));
        }
        return;
      }
      // The API's error shape, so a size refusal reads as the sentence the
      // server wrote rather than as a status code.
      let message = `Upload failed (${request.status})`;
      try {
        const body = JSON.parse(request.responseText) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        // Keep the status-code message.
      }
      reject(new Error(message));
    });

    request.addEventListener('error', () => reject(new Error('Upload failed. Check your connection.')));
    request.addEventListener('abort', () => reject(new DOMException('Upload cancelled', 'AbortError')));
    signal?.addEventListener('abort', () => request.abort(), { once: true });

    request.send(file);
  });
}

/**
 * Adds a custom emoji to a server.
 *
 * The same raw-body shape as an attachment upload - one picture per request, so
 * a multipart envelope would carry nothing the query string does not.
 */
export async function uploadEmoji(guildId: string, name: string, file: File): Promise<Emoji> {
  const token = api.accessToken;
  if (!token) throw new Error('Not signed in');

  const response = await fetch(
    `${API_BASE}/api/guilds/${guildId}/emoji?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': file.type || 'application/octet-stream',
      },
      body: file,
    },
  );

  if (!response.ok) {
    // The server's sentence, not a status code: "that name is taken" and "this
    // server is full" are things a person can act on.
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Could not add that emoji (${response.status})`);
  }
  return (await response.json()) as Emoji;
}

/** Absolute URL for an avatar or icon path returned by the API. */
export function mediaUrl(path: string | null): string | null {
  return path ? `${API_BASE}${path}` : null;
}

export const api = new ApiClient();
export const apiBase = API_BASE;

/**
 * The host this build actually talks to, for the screens that report not
 * reaching it.
 *
 * Named rather than described, because the same source is not always pointed at
 * the same place. These messages used to say "check that the API is running on
 * port 4000", which is true only in development and is misleading advice for
 * someone in a browser, or on a laptop whose wifi has dropped.
 */
export function serverHost(): string {
  try {
    return new URL(API_BASE).host;
  } catch {
    return API_BASE;
  }
}
