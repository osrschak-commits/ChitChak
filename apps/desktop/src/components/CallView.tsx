import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceState } from '@chitchak/protocol';
import type { VideoFeed } from '../lib/voice.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { usePersonPopover } from '../hooks/usePersonPopover.js';
import { useApp } from '../store/app.js';
import { Avatar, MemberName, Meter } from './primitives.js';

/**
 * The call: everyone in this voice room, and nothing else.
 *
 * A call is its own place rather than a strip above a text channel, so the
 * people you are talking to get the whole pane and a shared screen has room to
 * be legible.
 *
 * Two layouts. With nothing shared, participants tile evenly. With a screen
 * shared, that screen becomes the stage and everyone else drops to a filmstrip
 * beneath it - the presentation is what people are looking at, and it should
 * not compete with a grid of faces for space.
 */
export function CallView() {
  const voiceChannelId = useApp((s) => s.voiceChannelId);
  const channels = useApp((s) => s.channels);
  const voiceStates = useApp((s) => s.voiceStates);
  const videoFeeds = useApp((s) => s.videoFeeds);
  const voiceConnection = useApp((s) => s.voiceConnection);
  const selfId = useApp((s) => s.user?.id);
  const members = useApp((s) => s.members);

  /** A feed the viewer clicked to enlarge. Overrides the automatic stage. */
  const [spotlightSid, setSpotlightSid] = useState<string | null>(null);

  const channel = voiceChannelId ? channels.get(voiceChannelId) : undefined;
  // Left click on a tile already enlarges, so only right click opens a menu here.
  const person = usePersonPopover(channel?.guildId ?? null);

  if (!voiceChannelId) return null;
  const occupants = [...voiceStates.values()].filter((v) => v.channelId === voiceChannelId);

  const screenFeeds = videoFeeds.filter((f) => f.source === 'screen');
  // What is on the stage: whatever was clicked, otherwise a screen share, which
  // takes the stage on its own because that is what people are here to look at.
  // A spotlight survives until the feed behind it goes away.
  const spotlight = videoFeeds.find((f) => f.trackSid === spotlightSid) ?? null;
  const stage = spotlight ?? screenFeeds[0] ?? null;
  const stageIsChosen = spotlight !== null;

  // The spotlit person is on the stage already; showing them twice wastes the
  // strip. A screen share is different - its owner still belongs in the strip.
  const stripOccupants =
    spotlight && spotlight.source === 'camera'
      ? occupants.filter((state) => state.userId !== spotlight.userId)
      : occupants;

  const stageOwner = stage ? members.get(`${channel?.guildId}:${stage.userId}`) : undefined;
  const stageName = stageOwner?.nickname ?? stageOwner?.user.displayName ?? 'Unknown';

  return (
    <main className="pane">
      <header className="pane__header">
        <span className="callhead">
          <span className="strip__lamp" aria-hidden="true" />
          <span className="pane__title">{channel?.name}</span>
        </span>
        <span className="legend mono">
          {voiceConnection === 'connected'
            ? `${occupants.length} in the room`
            : voiceConnection === 'reconnecting'
              ? 'reconnecting'
              : 'connecting'}
        </span>

        {stageIsChosen && (
          <span className="callhead__switch">
            <button className="btn btn--ghost btn--sm" onClick={() => setSpotlightSid(null)}>
              ← Back to everyone
            </button>
          </span>
        )}
      </header>

      <div className={`call ${stage ? 'call--presenting' : ''}`}>
        {stage && (
          <div className="call__stage">
            {/* Always letterboxed on the stage. Cropping a shared screen cuts
                off what someone is pointing at, and cropping a camera to a tall
                pane leaves a face sliced down the middle. */}
            <VideoSurface
              feed={stage}
              contain
              mirrored={stage.source === 'camera' && stage.isLocal}
              allowFullscreen
            />
            <span className="call__stage-label">
              {stage.source === 'screen' ? `${stageName} is presenting` : stageName}
            </span>
          </div>
        )}

        <div
          className={stage ? 'call__filmstrip' : 'call__grid'}
          style={stage ? undefined : { gridTemplateColumns: `repeat(${gridColumns(stripOccupants.length)}, 1fr)` }}
        >
          {stripOccupants.map((state) => (
            <PersonTile
              key={state.userId}
              state={state}
              selfId={selfId}
              compact={Boolean(stage)}
              onEnlarge={(feed) => setSpotlightSid(feed.trackSid)}
              {...person.bindMenuOnly(state.userId)}
            />
          ))}

          {occupants.length === 1 && !stage && (
            <div className="call__alone">
              <p className="empty__title">You are the only one here</p>
              <p className="empty__body">
                Invite someone, or pick a text channel on the left while you wait.
              </p>
            </div>
          )}
        </div>
      </div>

      {person.popovers}
    </main>
  );
}

/**
 * How many columns to lay participants out in.
 *
 * Derived from the count rather than left to `auto-fit`, which does not
 * reliably collapse its empty tracks here - the symptom was one person getting
 * a third-width tile in a full-width pane. Roughly square arrangements read
 * best: two across for a pair, two-by-two for four, three across up to nine.
 */
function gridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  if (count <= 16) return 4;
  return 5;
}

function PersonTile({
  state,
  selfId,
  compact,
  onEnlarge,
  onContextMenu,
}: {
  state: VoiceState;
  selfId: string | undefined;
  compact: boolean;
  onEnlarge(feed: VideoFeed): void;
  onContextMenu(event: React.MouseEvent): void;
}) {
  const members = useApp((s) => s.members);
  const levels = useApp((s) => s.levels);
  const speaking = useApp((s) => s.speaking);
  const videoFeeds = useApp((s) => s.videoFeeds);
  const { resolve } = usePermissions();

  const member = members.get(`${state.guildId}:${state.userId}`);
  const name = member?.nickname ?? member?.user.displayName ?? 'Unknown';
  const camera = videoFeeds.find((f) => f.userId === state.userId && f.source === 'camera');
  const screen = videoFeeds.find((f) => f.userId === state.userId && f.source === 'screen');
  const level = state.selfMuted ? 0 : (levels.get(state.userId) ?? 0);
  const isSpeaking = speaking.has(state.userId) && !state.selfMuted;

  // A camera can be clicked to fill the stage, so the tile behaves as a button
  // when there is something to enlarge and as a plain panel when there is not.
  const enlargeable = camera ?? screen ?? null;

  return (
    <div
      className={[
        'tile',
        isSpeaking && 'tile--speaking',
        compact && 'tile--compact',
        enlargeable && 'tile--enlargeable',
      ]
        .filter(Boolean)
        .join(' ')}
      onContextMenu={onContextMenu}
      onClick={enlargeable ? () => onEnlarge(enlargeable) : undefined}
      role={enlargeable ? 'button' : undefined}
      tabIndex={enlargeable ? 0 : undefined}
      title={enlargeable ? 'Click to enlarge' : undefined}
      onKeyDown={
        enlargeable
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onEnlarge(enlargeable);
              }
            }
          : undefined
      }
    >
      {camera ? (
        <VideoSurface feed={camera} mirrored={camera.isLocal} />
      ) : (
        <Avatar
          user={
            member?.user ?? {
              id: state.userId,
              displayName: name,
              avatarUrl: null,
              accentColor: null,
            }
          }
          size={compact ? 40 : 72}
        />
      )}

      <div className="tile__footer">
        <Meter level={level} />
        <MemberName
          className="tile__name"
          name={state.userId === selfId ? `${name} (you)` : name}
          color={resolve(state.userId).color}
        />
        <span className="tile__flags">
          {state.serverMuted && <span title="Muted by a moderator">blocked</span>}
          {state.selfDeafened && <span title="Deafened">deaf</span>}
          {state.selfMuted && !state.selfDeafened && !state.serverMuted && (
            <span title="Muted">muted</span>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * Binds a LiveKit track to a <video> element, with optional fullscreen.
 *
 * The track is attached in an effect and detached on cleanup, so React owns the
 * element's lifetime and the engine never holds a reference to a node that has
 * been unmounted - which is what otherwise leaves black rectangles behind when
 * someone turns their camera off.
 */
export function VideoSurface({
  feed,
  mirrored = false,
  contain = false,
  allowFullscreen = false,
}: {
  feed: VideoFeed;
  mirrored?: boolean;
  contain?: boolean;
  allowFullscreen?: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    feed.attach(element);
    return () => feed.detach(element);
  }, [feed]);

  // Fullscreen can also be left with Escape or the system chrome, so the button
  // state follows the document rather than our own last click.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === wrapperRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const element = wrapperRef.current;
    if (!element) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch((error: Error) => {
        console.error('[voice] exitFullscreen failed', error);
      });
    } else {
      void element.requestFullscreen().catch((error: Error) => {
        // Swallowing this hid a real failure once already.
        console.error('[voice] requestFullscreen failed', error?.name, error?.message);
      });
    }
  }, []);

  return (
    <div className="surface" ref={wrapperRef}>
      <video
        ref={videoRef}
        className={`surface__video ${mirrored ? 'surface__video--mirror' : ''} ${
          contain ? 'surface__video--contain' : ''
        }`}
        autoPlay
        playsInline
        // Always muted: audio arrives on its own track through the engine, and
        // an unmuted video element would play everyone twice.
        muted
        onDoubleClick={allowFullscreen ? toggleFullscreen : undefined}
      />
      {allowFullscreen && (
        <button
          className="surface__expand"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <CollapseIcon /> : <ExpandIcon />}
        </button>
      )}
    </div>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" {...stroke}>
      <path d="M6 2H2v4M10 2h4v4M10 14h4v-4M6 14H2v-4" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" {...stroke}>
      <path d="M2 6h4V2M14 6h-4V2M14 10h-4v4M2 10h4v4" />
    </svg>
  );
}
