import { useMemo, useState } from 'react';
import type { Channel } from '@chitchak/protocol';
import { Permission } from '@chitchak/protocol';
import { usePermissions } from '../hooks/usePermissions.js';
import { usePersonPopover } from '../hooks/usePersonPopover.js';
import { useApp } from '../store/app.js';
import { Avatar, MemberName, Meter } from './primitives.js';
import { CreateChannelDialog } from './CreateChannelDialog.js';
import { ScreenPicker } from './ScreenPicker.js';

/**
 * Channel list and the self panel.
 *
 * Voice channels show who is in them and how loud they are, so a conversation
 * is visible from the outside and you can decide to join it - which is the
 * whole point of the product.
 */
export function Sidebar({
  onOpenServerSettings,
}: {
  onOpenServerSettings(tab: 'overview' | 'invites'): void;
}) {
  const guilds = useApp((s) => s.guilds);
  const selectedGuildId = useApp((s) => s.selectedGuildId);
  const channels = useApp((s) => s.channels);
  const selectedTextChannelId = useApp((s) => s.selectedTextChannelId);
  const selectTextChannel = useApp((s) => s.selectTextChannel);
  const mainView = useApp((s) => s.mainView);
  const joinVoice = useApp((s) => s.joinVoice);
  const voiceChannelId = useApp((s) => s.voiceChannelId);
  const voiceStates = useApp((s) => s.voiceStates);

  const [creating, setCreating] = useState<'text' | 'voice' | null>(null);

  const guild = guilds.find((g) => g.id === selectedGuildId);
  const { can } = usePermissions();
  const mayManageChannels = can(Permission.MANAGE_CHANNELS);
  // Anything that makes the settings dialog worth opening.
  const mayManage =
    can(Permission.MANAGE_SERVER) ||
    can(Permission.MANAGE_CHANNELS) ||
    can(Permission.MANAGE_RANKS) ||
    can(Permission.KICK_MEMBERS) ||
    can(Permission.BAN_MEMBERS);
  const mayInvite = can(Permission.CREATE_INVITE);

  const { textChannels, voiceChannels } = useMemo(() => {
    const all = [...channels.values()]
      .filter((c) => c.guildId === selectedGuildId)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    return {
      textChannels: all.filter((c) => c.kind === 'text'),
      voiceChannels: all.filter((c) => c.kind === 'voice'),
    };
  }, [channels, selectedGuildId]);

  return (
    <aside className="sidebar">
      <div className="sidebar__scroll">
        {!guild && (
          <p className="row__hint" style={{ padding: '8px 6px' }}>
            Create a server or join one with an invite to get started.
          </p>
        )}

        {guild && (
          <>
            {/* Server-level actions sit above the channels: they belong to this
                server, so they belong in this server's column - not in the top
                bar, which is now about you rather than about here. */}
            {(mayManage || mayInvite) && (
              <div className="serverbar">
                {mayManage && (
                  <button className="serverbar__item" onClick={() => onOpenServerSettings('overview')}>
                    <SettingsIcon />
                    <span className="chan__name">Server settings</span>
                  </button>
                )}
                {mayInvite && (
                  <button className="serverbar__item" onClick={() => onOpenServerSettings('invites')}>
                    <InviteIcon />
                    <span className="chan__name">Invite people</span>
                  </button>
                )}
              </div>
            )}

            <div className="group">
              <div className="group__header">
                <span className="legend">Text</span>
                {mayManageChannels && (
                  <button
                    className="icon-btn"
                    style={{ width: 22, height: 22 }}
                    onClick={() => setCreating('text')}
                    title="New text channel"
                    aria-label="New text channel"
                  >
                    +
                  </button>
                )}
              </div>
              {textChannels.map((channel) => {
                const active = channel.id === selectedTextChannelId && mainView === 'chat';
                return (
                  <button
                    key={channel.id}
                    className={`chan ${active ? 'chan--active' : ''}`}
                    onClick={() => selectTextChannel(channel.id)}
                  >
                    <span className="chan__tick" aria-hidden="true" />
                    <span className="chan__name">{channel.name}</span>
                  </button>
                );
              })}
            </div>

            <div className="group">
              <div className="group__header">
                <span className="legend">Rooms</span>
                {mayManageChannels && (
                  <button
                    className="icon-btn"
                    style={{ width: 22, height: 22 }}
                    onClick={() => setCreating('voice')}
                    title="New voice channel"
                    aria-label="New voice channel"
                  >
                    +
                  </button>
                )}
              </div>
              {voiceChannels.map((channel) => (
                <VoiceRow
                  key={channel.id}
                  channel={channel}
                  connected={channel.id === voiceChannelId}
                  occupants={[...voiceStates.values()].filter((v) => v.channelId === channel.id)}
                  onJoin={() => joinVoice(channel.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Your identity and settings live in the top bar; this column ends with
          the call, which is the only thing here that needs to stay reachable. */}
      <CallBar />

      {creating && guild && (
        <CreateChannelDialog
          guildId={guild.id}
          kind={creating}
          onClose={() => setCreating(null)}
        />
      )}
    </aside>
  );
}

function VoiceRow({
  channel,
  connected,
  occupants,
  onJoin,
}: {
  channel: Channel;
  connected: boolean;
  occupants: import('@chitchak/protocol').VoiceState[];
  onJoin(): void;
}) {
  const members = useApp((s) => s.members);
  const levels = useApp((s) => s.levels);
  const speaking = useApp((s) => s.speaking);
  const { canInChannel, resolve } = usePermissions();
  const person = usePersonPopover(channel.guildId);

  const full = channel.userLimit > 0 && occupants.length >= channel.userLimit && !connected;
  const mayConnect = canInChannel(channel.id, Permission.CONNECT);
  const blocked = full || !mayConnect;

  // Anyone talking in this room lights its signal rail, so an active
  // conversation is visible from the outside without opening anything.
  const someoneTalking = occupants.some(
    (state) => speaking.has(state.userId) && !state.selfMuted,
  );

  return (
    <>
      <button
        className={[
          'room',
          connected && 'room--joined',
          !connected && occupants.length > 0 && 'room--occupied',
          someoneTalking && 'room--active',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={onJoin}
        disabled={blocked}
        title={
          !mayConnect
            ? 'Your rank cannot join this room'
            : full
              ? 'This room is full'
              : connected
                ? `Open ${channel.name}`
                : `Join ${channel.name}`
        }
      >
        <span className="room__head">
          <span className="room__name">{channel.name}</span>
          <span className="room__count">
            {channel.userLimit > 0
              ? `${String(occupants.length).padStart(2, '0')}/${String(channel.userLimit).padStart(2, '0')}`
              : occupants.length > 0
                ? String(occupants.length).padStart(2, '0')
                : '—'}
          </span>
        </span>

        {/* Collapsed rooms show faces; the one you are in shows the full roster
            below instead, so the two never compete for the same space. */}
        {!connected && occupants.length > 0 && (
          <span className="room__faces">
            {occupants.slice(0, 5).map((state) => {
              const member = members.get(`${state.guildId}:${state.userId}`);
              return (
                <Avatar
                  key={state.userId}
                  user={
                    member?.user ?? {
                      id: state.userId,
                      displayName: member?.user.displayName ?? '?',
                      avatarUrl: null,
                      accentColor: null,
                    }
                  }
                  size={20}
                  speaking={speaking.has(state.userId) && !state.selfMuted}
                />
              );
            })}
            {occupants.length > 5 && <span className="room__more">+{occupants.length - 5}</span>}
          </span>
        )}
      </button>

      {connected && occupants.length > 0 && (
        <div className="roster roster--attached">
          {occupants.map((state) => {
            const member = members.get(`${state.guildId}:${state.userId}`);
            const name = member?.nickname ?? member?.user.displayName ?? 'Unknown';
            const isSpeaking = speaking.has(state.userId) && !state.selfMuted;
            const level = state.selfMuted ? 0 : (levels.get(state.userId) ?? 0);

            return (
              <div
                key={state.userId}
                className={`roster__row roster__row--interactive ${isSpeaking ? 'roster__row--speaking' : ''}`}
                title={`${name} — click for profile, right-click to moderate`}
                {...person.bind(state.userId)}
              >
                <Avatar
                  user={
                    member?.user ?? {
                      id: state.userId,
                      displayName: name,
                      avatarUrl: null,
                      accentColor: null,
                    }
                  }
                  size={20}
                  speaking={isSpeaking}
                />
                <MemberName
                  className="roster__name"
                  name={name}
                  color={resolve(state.userId).color}
                />
                <span className="roster__flags">
                  {state.serverMuted && (
                    <span className="is-alert" title="Muted by a moderator">
                      ⛔
                    </span>
                  )}
                  {state.selfScreenShare && <span title="Sharing their screen">▣</span>}
                  {state.selfVideo && <span title="Camera on">◉</span>}
                  {state.selfDeafened ? (
                    <span className="is-alert" title="Deafened">
                      ⊘
                    </span>
                  ) : state.selfMuted ? (
                    <span className="is-alert" title="Muted">
                      ⊗
                    </span>
                  ) : null}
                </span>
                {!state.selfMuted && <Meter level={level} />}
              </div>
            );
          })}
        </div>
      )}

      {person.popovers}
    </>
  );
}

/** The live-call controls. Only rendered while actually in a channel. */
function CallBar() {
  const voiceChannelId = useApp((s) => s.voiceChannelId);
  const voiceConnection = useApp((s) => s.voiceConnection);
  const channels = useApp((s) => s.channels);
  const selfMuted = useApp((s) => s.selfMuted);
  const selfDeafened = useApp((s) => s.selfDeafened);
  const cameraOn = useApp((s) => s.cameraOn);
  const screenShareOn = useApp((s) => s.screenShareOn);
  const transmitMode = useApp((s) => s.transmitMode);
  const pushToTalkActive = useApp((s) => s.pushToTalkActive);
  const toggleMute = useApp((s) => s.toggleMute);
  const toggleDeafen = useApp((s) => s.toggleDeafen);
  const toggleCamera = useApp((s) => s.toggleCamera);
  const startScreenShare = useApp((s) => s.startScreenShare);
  const stopScreenShare = useApp((s) => s.stopScreenShare);
  const leaveVoice = useApp((s) => s.leaveVoice);
  const { canInChannel } = usePermissions();
  const [picking, setPicking] = useState(false);

  if (!voiceChannelId) return null;

  // Camera and screen share are gated per channel, and the SFU token enforces
  // the same thing - so a disabled button here is a hint, not the boundary.
  const mayUseCamera = canInChannel(voiceChannelId, Permission.VIDEO);
  const mayShareScreen = canInChannel(voiceChannelId, Permission.SCREEN_SHARE);

  const channel = channels.get(voiceChannelId);
  const connecting = voiceConnection === 'connecting' || voiceConnection === 'reconnecting';
  const stateLabel =
    voiceConnection === 'connected'
      ? transmitMode === 'push-to-talk'
        ? pushToTalkActive
          ? 'Transmitting'
          : 'Hold to talk'
        : 'Connected'
      : voiceConnection === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting';

  return (
    <div className="callbar">
      <div className="callbar__head">
        <span className={`callbar__state ${connecting ? 'callbar__state--pending' : ''}`}>
          {stateLabel}
        </span>
      </div>
      <div className="callbar__where">{channel?.name}</div>

      <div className="callbar__controls">
        <button
          className={`ctl ${selfMuted ? 'ctl--muted' : ''}`}
          onClick={toggleMute}
          aria-pressed={selfMuted}
          title={selfMuted ? 'Unmute' : 'Mute'}
        >
          {selfMuted ? <MicOffIcon /> : <MicIcon />}
        </button>
        <button
          className={`ctl ${selfDeafened ? 'ctl--muted' : ''}`}
          onClick={toggleDeafen}
          aria-pressed={selfDeafened}
          title={selfDeafened ? 'Undeafen' : 'Deafen'}
        >
          {selfDeafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
        </button>
        <button
          className={`ctl ${cameraOn ? 'ctl--engaged' : ''}`}
          onClick={() => void toggleCamera()}
          aria-pressed={cameraOn}
          disabled={!mayUseCamera}
          title={
            mayUseCamera
              ? cameraOn
                ? 'Turn camera off'
                : 'Turn camera on'
              : 'Your rank cannot use a camera here'
          }
        >
          <CameraIcon on={cameraOn} />
        </button>
        <button
          className={`ctl ${screenShareOn ? 'ctl--engaged' : ''}`}
          onClick={() => (screenShareOn ? void stopScreenShare() : setPicking(true))}
          aria-pressed={screenShareOn}
          disabled={!mayShareScreen}
          title={
            mayShareScreen
              ? screenShareOn
                ? 'Stop sharing'
                : 'Share your screen'
              : 'Your rank cannot share a screen here'
          }
        >
          <ScreenIcon />
        </button>
        <button className="ctl ctl--leave" onClick={() => void leaveVoice()} title="Leave call">
          <LeaveIcon />
        </button>
      </div>

      {picking && (
        <ScreenPicker
          onPick={(sourceId, withAudio) => {
            setPicking(false);
            void startScreenShare(sourceId, withAudio);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/* Inline SVG rather than an icon font or emoji: emoji render differently on
   every platform and would break the restrained look on Windows in particular. */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" {...stroke}>
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V14.5" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" {...stroke}>
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V14.5M2 2l12 12" />
    </svg>
  );
}

function HeadphonesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" {...stroke}>
      <path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2" />
      <rect x="1.5" y="9.5" width="3" height="4.5" rx="1.2" />
      <rect x="11.5" y="9.5" width="3" height="4.5" rx="1.2" />
    </svg>
  );
}

function HeadphonesOffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" {...stroke}>
      <path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2" />
      <rect x="1.5" y="9.5" width="3" height="4.5" rx="1.2" />
      <rect x="11.5" y="9.5" width="3" height="4.5" rx="1.2" />
      <path d="M2 2l12 12" />
    </svg>
  );
}

function CameraIcon({ on }: { on: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" {...stroke}>
      <rect x="1.5" y="4" width="9" height="8" rx="1.8" />
      <path d="M10.5 7.2 14.5 5v6l-4-2.2z" />
      {!on && <path d="M2 2l12 12" />}
    </svg>
  );
}

function ScreenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" {...stroke}>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M6 14h4" />
    </svg>
  );
}

function LeaveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" {...stroke}>
      <path d="M10 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5h-4A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h4a1.5 1.5 0 0 0 1.5-1.5v-2M7 8h7.5m0 0-2.2-2.2M14.5 8l-2.2 2.2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" {...stroke}>
      <path d="M2 4.5h12M2 8h12M2 11.5h12" />
      <circle cx="5.5" cy="4.5" r="1.4" fill="var(--graphite-900)" />
      <circle cx="10" cy="8" r="1.4" fill="var(--graphite-900)" />
      <circle cx="6.5" cy="11.5" r="1.4" fill="var(--graphite-900)" />
    </svg>
  );
}

function InviteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" {...stroke}>
      <path d="M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5" />
      <path d="M12.5 5v4M14.5 7h-4" />
    </svg>
  );
}
