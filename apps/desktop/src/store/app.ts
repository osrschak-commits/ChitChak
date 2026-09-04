import type {
  Channel,
  ChannelOverwrite,
  Guild,
  GuildMember,
  Message,
  PresenceStatus,
  Rank,
  SelfUser,
  ServerMessage,
  VoiceState,
} from '@chitchak/protocol';
import { create } from 'zustand';
import { api } from '../lib/api.js';
import { gateway, type GatewayStatus } from '../lib/gateway.js';
import {
  VoiceEngine,
  defaultAudioSettings,
  type AudioSettings,
  type VideoFeed,
  type VoiceConnectionState,
} from '../lib/voice.js';

/**
 * Single client-side store.
 *
 * The server's `ready` snapshot is the source of truth and every gateway event
 * is a patch on top of it. Nothing is derived on the client that the server
 * also derives, which is what stops the two drifting into disagreement about
 * who is in a channel.
 */

export type TransmitMode = 'voice-activity' | 'push-to-talk';

interface AppState {
  user: SelfUser | null;
  gatewayStatus: GatewayStatus;

  guilds: Guild[];
  channels: Map<string, Channel>;
  members: Map<string, GuildMember>;
  ranks: Map<string, Rank>;
  /** Keyed `channelId:rankId`, the natural key for a lookup. */
  overwrites: Map<string, ChannelOverwrite>;
  voiceStates: Map<string, VoiceState>;
  presences: Map<string, PresenceStatus>;
  messages: Map<string, Message[]>;

  selectedGuildId: string | null;
  selectedTextChannelId: string | null;
  /**
   * What the main pane shows. A call is a place you go, not a strip bolted on
   * top of a text channel - so being in a call and reading a channel are
   * separate views you switch between.
   */
  mainView: 'chat' | 'call';

  voiceChannelId: string | null;
  voiceConnection: VoiceConnectionState;
  speaking: Set<string>;
  /** Continuous 0..1 audio level per user, sampled from the SFU. Drives the meters. */
  levels: Map<string, number>;
  videoFeeds: VideoFeed[];
  selfMuted: boolean;
  selfDeafened: boolean;
  cameraOn: boolean;
  screenShareOn: boolean;
  transmitMode: TransmitMode;
  pushToTalkActive: boolean;
  audioSettings: AudioSettings;
  voiceError: string | null;

  boot(): Promise<void>;
  signOut(): Promise<void>;
  selectGuild(guildId: string): void;
  selectTextChannel(channelId: string): void;
  setMainView(view: 'chat' | 'call'): void;
  loadMessages(channelId: string): Promise<void>;
  sendMessage(channelId: string, content: string): void;
  editMessage(messageId: string, content: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  joinVoice(channelId: string): void;
  leaveVoice(): Promise<void>;
  toggleMute(): void;
  toggleDeafen(): void;
  toggleCamera(): Promise<void>;
  /** Pass a source id from the picker; omit to stop sharing. */
  startScreenShare(sourceId: string): Promise<void>;
  stopScreenShare(): Promise<void>;
  setTransmitMode(mode: TransmitMode): void;
  setPushToTalkActive(active: boolean): void;
  setAudioSettings(settings: Partial<AudioSettings>): Promise<void>;
  applySelfUser(user: SelfUser): void;
  dismissVoiceError(): void;
}

const memberKey = (guildId: string, userId: string) => `${guildId}:${userId}`;

/**
 * The voice engine is deliberately module-scoped rather than stored in state:
 * it holds a live WebRTC connection, device handles and audio elements, none of
 * which are serialisable or safe to recreate on a re-render.
 */
let engine: VoiceEngine | null = null;

/** The live engine, for the few places that need it directly (per-user volume). */
export function voiceEngine(): VoiceEngine | null {
  return engine;
}

function getEngine(): VoiceEngine {
  engine ??= new VoiceEngine({
    onSpeakingChanged: (ids) => useApp.setState({ speaking: new Set(ids) }),
    onLevelsChanged: (levels) => useApp.setState({ levels }),
    onConnectionStateChanged: (state) => useApp.setState({ voiceConnection: state }),
    onVideoFeedsChanged: (videoFeeds) => useApp.setState({ videoFeeds }),
    onParticipantsChanged: () => {
      // Membership is authoritative from the gateway's voice states; the SFU's
      // view is only used to know that media is actually flowing.
    },
    onError: (message) => useApp.setState({ voiceError: message }),
  });
  return engine;
}

/**
 * Gateway listeners are bound exactly once for the life of the process.
 *
 * `boot()` is called from an effect, and React StrictMode invokes effects twice
 * in development. Subscribing inside `boot()` therefore registered two message
 * handlers, so every `voice:credentials` frame opened *two* SFU connections
 * with the same identity - the SFU evicted one as a duplicate, its peer
 * connection closed mid-negotiation, and the rejected promise surfaced as a
 * connection error while the other connection was working perfectly.
 *
 * Binding at module scope makes the subscription independent of how many times
 * boot runs.
 */
let listenersBound = false;

function bindGatewayListeners(): void {
  if (listenersBound) return;
  listenersBound = true;
  gateway.onStatus((gatewayStatus) => useApp.setState({ gatewayStatus }));
  gateway.onMessage((message) =>
    applyServerMessage(message, useApp.setState, useApp.getState),
  );
}

/** Tells the server what our local media state is, so others can render it. */
function pushVoiceState(state: AppState): void {
  gateway.send({
    op: 'voice:update',
    d: {
      selfMuted: state.selfMuted,
      selfDeafened: state.selfDeafened,
      selfVideo: state.cameraOn,
      selfScreenShare: state.screenShareOn,
    },
  });
}

export const useApp = create<AppState>((set, get) => ({
  user: api.user,
  gatewayStatus: 'idle',

  guilds: [],
  channels: new Map(),
  members: new Map(),
  ranks: new Map(),
  overwrites: new Map(),
  voiceStates: new Map(),
  presences: new Map(),
  messages: new Map(),

  selectedGuildId: null,
  selectedTextChannelId: null,
  mainView: 'chat',

  voiceChannelId: null,
  voiceConnection: 'disconnected',
  speaking: new Set(),
  levels: new Map(),
  videoFeeds: [],
  selfMuted: false,
  selfDeafened: false,
  cameraOn: false,
  screenShareOn: false,
  transmitMode: (localStorage.getItem('chitchak.transmitMode') as TransmitMode) ?? 'voice-activity',
  pushToTalkActive: false,
  audioSettings: loadAudioSettings(),
  voiceError: null,

  async boot() {
    if (!api.isAuthenticated) return;
    bindGatewayListeners();
    await gateway.connect();
  },

  async signOut() {
    await get().leaveVoice();
    gateway.close();
    await api.logout();
    set({
      user: null,
      guilds: [],
      channels: new Map(),
      members: new Map(),
      voiceStates: new Map(),
      presences: new Map(),
      messages: new Map(),
      selectedGuildId: null,
      selectedTextChannelId: null,
      gatewayStatus: 'closed',
    });
  },

  selectGuild(guildId) {
    const firstText = [...get().channels.values()]
      .filter((c) => c.guildId === guildId && c.kind === 'text')
      .sort((a, b) => a.position - b.position)[0];

    set({ selectedGuildId: guildId, selectedTextChannelId: firstText?.id ?? null });
    if (firstText) void get().loadMessages(firstText.id);
  },

  selectTextChannel(channelId) {
    // Opening a text channel leaves the call view but not the call itself.
    set({ selectedTextChannelId: channelId, mainView: 'chat' });
    void get().loadMessages(channelId);
  },

  setMainView(view) {
    if (view === 'call' && !get().voiceChannelId) return;
    set({ mainView: view });
  },

  async loadMessages(channelId) {
    // Already loaded once; the gateway keeps it current from here.
    if (get().messages.has(channelId)) return;
    try {
      const history = await api.listMessages(channelId);
      set((state) => ({ messages: new Map(state.messages).set(channelId, history) }));
    } catch {
      set((state) => ({ messages: new Map(state.messages).set(channelId, []) }));
    }
  },

  sendMessage(channelId, content) {
    const trimmed = content.trim();
    if (!trimmed) return;
    gateway.send({ op: 'message:create', d: { channelId, content: trimmed } });
  },

  async editMessage(messageId, content) {
    // Over REST rather than the gateway: the caller needs to know whether it
    // was rejected, and the gateway is fire-and-forget.
    await api.editMessage(messageId, content);
  },

  async deleteMessage(messageId) {
    await api.deleteMessage(messageId);
  },

  joinVoice(channelId) {
    // Clicking the channel you are already in must not re-join it. Every join
    // mints a fresh token and reconnects to the SFU, which sees the same
    // identity twice and evicts the older session - so a stray second click
    // tears down a working call and rebuilds it. Switch to the call view
    // instead, which is what a second click is actually asking for.
    if (get().voiceChannelId === channelId && get().voiceConnection !== 'disconnected') {
      set({ mainView: 'call' });
      return;
    }

    set({ voiceError: null, mainView: 'call' });
    // The server replies with `voice:credentials`, which is where the SFU
    // connection is actually established - see applyServerMessage.
    gateway.send({ op: 'voice:join', d: { channelId } });
  },

  async leaveVoice() {
    gateway.send({ op: 'voice:leave', d: {} });
    await getEngine().disconnect();
    set({
      voiceChannelId: null,
      speaking: new Set(),
      levels: new Map(),
      videoFeeds: [],
      cameraOn: false,
      screenShareOn: false,
      pushToTalkActive: false,
      // Nothing left to look at in the call view.
      mainView: 'chat',
    });
  },

  toggleMute() {
    const selfMuted = !get().selfMuted;
    // Un-muting while deafened has to lift the deafen too, otherwise you would
    // be talking to people you cannot hear.
    const selfDeafened = selfMuted ? get().selfDeafened : false;
    set({ selfMuted, selfDeafened });
    pushVoiceState(get());
    void getEngine().setDeafened(selfDeafened);
    void syncTransmission(get());
  },

  toggleDeafen() {
    const selfDeafened = !get().selfDeafened;
    const selfMuted = selfDeafened ? true : get().selfMuted;
    set({ selfDeafened, selfMuted });
    pushVoiceState(get());
    void getEngine().setDeafened(selfDeafened);
    void syncTransmission(get());
  },

  async toggleCamera() {
    if (!get().voiceChannelId) return;
    const next = !get().cameraOn;
    try {
      if (next) await getEngine().startCamera();
      else await getEngine().stopCamera();
      set({ cameraOn: next });
      pushVoiceState(get());
    } catch {
      // The engine has already surfaced a readable message via onError; keep
      // the button in its real state rather than optimistically flipping it.
      set({ cameraOn: getEngine().cameraOn });
    }
  },

  async startScreenShare(sourceId) {
    if (!get().voiceChannelId) return;
    try {
      // Electron has no built-in source chooser: the main process is told which
      // screen to hand over, and only then does getDisplayMedia succeed.
      await window.chitchak?.selectScreenSource(sourceId);
      await getEngine().startScreenShare();
    } catch {
      // The engine surfaces a readable message through onError.
      await window.chitchak?.selectScreenSource(null);
    }
    set({ screenShareOn: getEngine().screenShareOn });
    pushVoiceState(get());
  },

  async stopScreenShare() {
    await getEngine().stopScreenShare().catch(() => {});
    set({ screenShareOn: getEngine().screenShareOn });
    pushVoiceState(get());
  },

  setTransmitMode(mode) {
    set({ transmitMode: mode, pushToTalkActive: false });
    localStorage.setItem('chitchak.transmitMode', mode);
    void syncTransmission(get());
  },

  setPushToTalkActive(active) {
    if (get().pushToTalkActive === active) return;
    set({ pushToTalkActive: active });
    void syncTransmission(get());
  },

  async setAudioSettings(patch) {
    const audioSettings = { ...get().audioSettings, ...patch };
    set({ audioSettings });
    localStorage.setItem('chitchak.audio', JSON.stringify(audioSettings));
    if (get().voiceChannelId) await getEngine().applySettings(audioSettings);
  },

  applySelfUser(user) {
    set({ user });
  },

  dismissVoiceError() {
    set({ voiceError: null });
  },
}));

/**
 * Decides whether the microphone should currently be open.
 *
 * One place, one rule, so the mute button, the deafen button, push-to-talk and
 * mode switching cannot disagree about the answer.
 */
async function syncTransmission(state: AppState): Promise<void> {
  if (!state.voiceChannelId) return;
  const allowed =
    !state.selfMuted &&
    !state.selfDeafened &&
    (state.transmitMode === 'voice-activity' || state.pushToTalkActive);
  await getEngine().setTransmitting(allowed);
}

function applyServerMessage(
  message: ServerMessage,
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
): void {
  switch (message.op) {
    case 'ready': {
      const { user, guilds, channels, members, ranks, overwrites, voiceStates, presences } =
        message.d;
      const channelMap = new Map(channels.map((c) => [c.id, c]));

      // Keep the current selection across a reconnect if it still exists, so a
      // dropped connection does not also lose your place.
      const previousGuild = get().selectedGuildId;
      const guildId = guilds.some((g) => g.id === previousGuild)
        ? previousGuild
        : (guilds[0]?.id ?? null);

      const previousText = get().selectedTextChannelId;
      const textStillValid =
        previousText && channelMap.get(previousText)?.guildId === guildId ? previousText : null;
      const firstText = channels
        .filter((c) => c.guildId === guildId && c.kind === 'text')
        .sort((a, b) => a.position - b.position)[0];

      set({
        user,
        guilds,
        channels: channelMap,
        members: new Map(members.map((m) => [memberKey(m.guildId, m.userId), m])),
        ranks: new Map(ranks.map((r) => [r.id, r])),
        overwrites: new Map(overwrites.map((o) => [`${o.channelId}:${o.rankId}`, o])),
        voiceStates: new Map(voiceStates.map((v) => [v.userId, v])),
        presences: new Map(presences.map((p) => [p.userId, p.status])),
        selectedGuildId: guildId,
        selectedTextChannelId: textStillValid ?? firstText?.id ?? null,
      });

      const channelToLoad = get().selectedTextChannelId;
      if (channelToLoad) void get().loadMessages(channelToLoad);
      return;
    }

    case 'voice:credentials': {
      const { url, token, channelId } = message.d;
      set({ voiceChannelId: channelId, cameraOn: false, screenShareOn: false });
      void getEngine()
        .connect(url, token, get().audioSettings)
        .then(() => syncTransmission(get()))
        .catch((error: Error) => set({ voiceError: error.message, voiceChannelId: null }));
      return;
    }

    case 'voice:state': {
      const state = message.d;
      set((s) => {
        const voiceStates = new Map(s.voiceStates);
        if (state.channelId === null) voiceStates.delete(state.userId);
        else voiceStates.set(state.userId, state);
        return { voiceStates };
      });
      // Our own state can be changed by a moderator (server mute) or by another
      // of our clients, so mirror it rather than assuming we caused it.
      if (state.userId === get().user?.id) {
        set({ selfMuted: state.selfMuted, selfDeafened: state.selfDeafened });
        if (state.channelId === null) {
          void getEngine().disconnect();
          set({ voiceChannelId: null, cameraOn: false, screenShareOn: false, mainView: 'chat' });
        }
      }
      return;
    }

    case 'presence:update': {
      set((s) => ({ presences: new Map(s.presences).set(message.d.userId, message.d.status) }));
      return;
    }

    case 'user:update': {
      const updated = message.d;
      set((s) => {
        // The same user appears once per guild they share with us; every copy
        // has to be refreshed or their old name lingers in some member lists.
        const members = new Map(s.members);
        for (const [key, member] of members) {
          if (member.userId === updated.id) members.set(key, { ...member, user: updated });
        }
        return { members };
      });
      if (updated.id === get().user?.id) {
        set((s) => ({ user: s.user ? { ...s.user, ...updated } : s.user }));
      }
      return;
    }

    case 'message:create': {
      const created = message.d;
      set((s) => {
        const messages = new Map(s.messages);
        const existing = messages.get(created.channelId) ?? [];
        // The gateway echoes the author's own message back to them; drop it if
        // it is already present rather than rendering a duplicate.
        if (existing.some((m) => m.id === created.id)) return { messages: s.messages };
        messages.set(created.channelId, [...existing, created]);
        return { messages };
      });
      return;
    }

    case 'channel:create':
    case 'channel:update': {
      set((s) => ({ channels: new Map(s.channels).set(message.d.id, message.d) }));
      return;
    }

    case 'channel:delete': {
      set((s) => {
        const channels = new Map(s.channels);
        channels.delete(message.d.channelId);
        const messages = new Map(s.messages);
        messages.delete(message.d.channelId);

        // Fall back to another text channel rather than leaving a blank pane.
        const replacement =
          s.selectedTextChannelId === message.d.channelId
            ? ([...channels.values()]
                .filter((c) => c.guildId === message.d.guildId && c.kind === 'text')
                .sort((a, b) => a.position - b.position)[0]?.id ?? null)
            : s.selectedTextChannelId;

        return { channels, messages, selectedTextChannelId: replacement };
      });
      if (get().voiceChannelId === message.d.channelId) void get().leaveVoice();
      return;
    }

    case 'guild:update': {
      set((s) => ({ guilds: s.guilds.map((g) => (g.id === message.d.id ? message.d : g)) }));
      return;
    }

    case 'guild:delete': {
      const { guildId } = message.d;
      set((s) => {
        const guilds = s.guilds.filter((g) => g.id !== guildId);
        const channels = new Map([...s.channels].filter(([, c]) => c.guildId !== guildId));
        const members = new Map([...s.members].filter(([, m]) => m.guildId !== guildId));
        const ranks = new Map([...s.ranks].filter(([, r]) => r.guildId !== guildId));

        const nextGuild = s.selectedGuildId === guildId ? (guilds[0]?.id ?? null) : s.selectedGuildId;
        const nextText = [...channels.values()]
          .filter((c) => c.guildId === nextGuild && c.kind === 'text')
          .sort((a, b) => a.position - b.position)[0];

        return {
          guilds,
          channels,
          members,
          ranks,
          selectedGuildId: nextGuild,
          selectedTextChannelId:
            s.selectedGuildId === guildId ? (nextText?.id ?? null) : s.selectedTextChannelId,
        };
      });
      return;
    }

    case 'guild:member_add':
    case 'guild:member_update': {
      const member = message.d;
      set((s) => ({
        members: new Map(s.members).set(memberKey(member.guildId, member.userId), member),
      }));
      return;
    }

    case 'rank:create':
    case 'rank:update': {
      set((s) => ({ ranks: new Map(s.ranks).set(message.d.id, message.d) }));
      return;
    }

    case 'rank:delete': {
      set((s) => {
        const ranks = new Map(s.ranks);
        ranks.delete(message.d.rankId);
        // Overwrites for a deleted rank cascade server-side; drop them here too
        // rather than leaving entries pointing at a rank that no longer exists.
        const overwrites = new Map(
          [...s.overwrites].filter(([, o]) => o.rankId !== message.d.rankId),
        );
        // Members keep a list of rank ids; strip the dead one.
        const members = new Map(s.members);
        for (const [key, member] of members) {
          if (member.rankIds.includes(message.d.rankId)) {
            members.set(key, {
              ...member,
              rankIds: member.rankIds.filter((id) => id !== message.d.rankId),
            });
          }
        }
        return { ranks, overwrites, members };
      });
      return;
    }

    case 'channel:overwrites': {
      set((s) => {
        // Replace the whole set for this channel: the server sends the full
        // list, and merging would leave removed overwrites behind.
        const overwrites = new Map(
          [...s.overwrites].filter(([, o]) => o.channelId !== message.d.channelId),
        );
        for (const overwrite of message.d.overwrites) {
          overwrites.set(`${overwrite.channelId}:${overwrite.rankId}`, overwrite);
        }
        return { overwrites };
      });
      return;
    }

    case 'message:update': {
      set((s) => {
        const messages = new Map(s.messages);
        const existing = messages.get(message.d.channelId);
        if (!existing) return { messages: s.messages };
        messages.set(
          message.d.channelId,
          existing.map((m) => (m.id === message.d.id ? message.d : m)),
        );
        return { messages };
      });
      return;
    }

    case 'message:delete': {
      set((s) => {
        const messages = new Map(s.messages);
        const existing = messages.get(message.d.channelId);
        if (!existing) return { messages: s.messages };
        messages.set(
          message.d.channelId,
          existing.filter((m) => m.id !== message.d.messageId),
        );
        return { messages };
      });
      return;
    }

    case 'guild:member_remove': {
      set((s) => {
        const members = new Map(s.members);
        members.delete(memberKey(message.d.guildId, message.d.userId));
        return { members };
      });
      return;
    }

    case 'error': {
      if (message.d.code === 'channel_full' || message.d.code === 'forbidden') {
        set({ voiceError: message.d.message });
      }
      return;
    }

    default:
      return;
  }
}

function loadAudioSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem('chitchak.audio');
    return raw ? { ...defaultAudioSettings, ...(JSON.parse(raw) as AudioSettings) } : defaultAudioSettings;
  } catch {
    return defaultAudioSettings;
  }
}

// Dev only: lets the store be inspected and driven from a debugger or the
// DevTools console, e.g. `__chitchak.getState().joinVoice(id)`. Never in a build.
if (import.meta.env.DEV) {
  (window as unknown as { __chitchak?: typeof useApp }).__chitchak = useApp;
}

/** Stable colour for a user with no chosen accent, derived from their id. */
export function fallbackAccent(userId: string): string {
  const palette = ['#c9954a', '#4fd6c4', '#8a7fd4', '#d97b6c', '#6ca9d9', '#b0c05f', '#d48fb8'];
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length] ?? '#c9954a';
}
