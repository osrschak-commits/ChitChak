import type {
  ApiError,
  AuthResponse,
  Ban,
  Channel,
  ChannelOverwrite,
  CreateGuildResponse,
  Guild,
  GuildMember,
  Invite,
  Message,
  Rank,
  SelfUser,
} from '@chitchak/protocol';

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
    this.session = session;
    try {
      if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Non-fatal: the session simply will not survive a restart.
    }
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

    if (!response.ok) throw new ApiRequestError(response.status, payload as ApiError);
    return payload as T;
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

/** Absolute URL for an avatar or icon path returned by the API. */
export function mediaUrl(path: string | null): string | null {
  return path ? `${API_BASE}${path}` : null;
}

export const api = new ApiClient();
export const apiBase = API_BASE;
