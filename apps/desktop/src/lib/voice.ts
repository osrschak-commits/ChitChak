import {
  ConnectionQuality,
  ConnectionState,
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteAudioTrack,
  // A value import, not a type one: volume is applied with an instanceof check,
  // because getParticipantByIdentity can also return the local participant.
  RemoteParticipant,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  createLocalVideoTrack,
} from 'livekit-client';
import type { LocalTrack, Participant, RemoteTrack, RemoteTrackPublication } from 'livekit-client';

/**
 * The voice engine: everything that touches actual media.
 *
 * This is the one part of the client that is not request/response. It owns a
 * connection to the SFU, the microphone and camera it publishes, and one
 * <audio> element per remote speaker. Video elements are handed to React
 * instead, because they have to be laid out.
 */

/** A track the UI needs to render, keyed by the participant it belongs to. */
export interface VideoFeed {
  userId: string;
  trackSid: string;
  source: 'camera' | 'screen';
  isLocal: boolean;
  /** Attach with `track.attach(element)` in an effect. */
  attach(element: HTMLVideoElement): void;
  detach(element: HTMLVideoElement): void;
}

/**
 * Somebody's screen share, whether or not it is being watched.
 *
 * Screen shares are the one track type nobody receives by default. A camera is
 * a face in a grid; a screen is a megabit or two of someone's IDE that everyone
 * in the room would otherwise be paying for whether they were looking at it or
 * not. So the room is told what is on offer, and each person chooses.
 */
export interface ScreenShare {
  userId: string;
  trackSid: string;
  /** Whether this viewer has chosen to receive it. */
  watching: boolean;
}

export interface VoiceCallbacks {
  onSpeakingChanged(speakingUserIds: string[]): void;
  onLevelsChanged(levels: Map<string, number>): void;
  onConnectionStateChanged(state: VoiceConnectionState): void;
  onVideoFeedsChanged(feeds: VideoFeed[]): void;
  onScreenSharesChanged(shares: ScreenShare[]): void;
  onParticipantsChanged(userIds: string[]): void;
  onError(message: string): void;
}

export type VoiceConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface AudioSettings {
  inputDeviceId: string | undefined;
  outputDeviceId: string | undefined;
  videoDeviceId: string | undefined;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const defaultAudioSettings: AudioSettings = {
  inputDeviceId: undefined,
  outputDeviceId: undefined,
  videoDeviceId: undefined,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * How often participant audio levels are sampled for the meters.
 *
 * 20Hz: fast enough that a meter tracks speech rhythm rather than lagging
 * behind it, slow enough that it is not a per-frame React render storm.
 */
const LEVEL_SAMPLE_MS = 50;

/**
 * Turns a device id into a constraint the browser must honour.
 *
 * A bare `deviceId: "abc"` is only a *preference* - Chromium is free to ignore
 * it and open the system default instead, silently. On a machine whose default
 * capture device is a loopback (Stereo Mix, VB-CABLE, Voicemeeter), that means
 * the app transmits everything playing on the computer and changing the setting
 * appears to do nothing.
 *
 * `exact` makes it a requirement: the right device, or an OverconstrainedError
 * we can report. Undefined is left undefined, so "System default" really is.
 */
function exactDevice(deviceId: string | undefined): { exact: string } | undefined {
  return deviceId ? { exact: deviceId } : undefined;
}

export class VoiceEngine {
  private room: Room | null = null;
  private micTrack: LocalAudioTrack | null = null;
  private cameraTrack: LocalVideoTrack | null = null;
  /**
   * Everything published for the current screen share - the picture and, when
   * system audio was included, the sound.
   *
   * Both, not just the video. Holding only the video track meant stopping a
   * share unpublished the picture and left the audio running: your machine went
   * on broadcasting whatever it was playing to everyone in the room, with
   * nothing on screen to say so, until you left the call.
   */
  private screenTracks: LocalTrack[] = [];
  /** One element per remote audio track, kept so they can be re-routed and cleaned up. */
  private audioElements = new Map<string, HTMLAudioElement>();
  private settings: AudioSettings = { ...defaultAudioSettings };
  private transmitting = false;
  private deafened = false;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  /** In-flight connect, shared by any caller that arrives while one is running. */
  private connecting: Promise<void> | null = null;
  /**
   * Screen shares this viewer has asked to watch, by track sid.
   *
   * Held here rather than read back off the publication because the two are not
   * the same question: `isSubscribed` says whether the track has arrived, which
   * lags the click by a moment and briefly flickers during a reconnect. This
   * says what the person asked for, which is what the button should reflect.
   */
  private watching = new Set<string>();

  constructor(private readonly callbacks: VoiceCallbacks) {}

  get connected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }

  get cameraOn(): boolean {
    return this.cameraTrack !== null;
  }

  get screenShareOn(): boolean {
    return this.screenTracks.length > 0;
  }

  async connect(url: string, token: string, settings: AudioSettings): Promise<void> {
    // Serialised: two overlapping connects use the same SFU identity, so the
    // second evicts the first and the first's negotiation dies half-finished.
    if (this.connecting) return this.connecting;

    this.connecting = this.doConnect(url, token, settings).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(url: string, token: string, settings: AudioSettings): Promise<void> {
    await this.disconnect();
    this.settings = settings;
    this.callbacks.onConnectionStateChanged('connecting');

    const room = new Room({
      // Adaptive stream pauses video tracks whose elements are not visible, and
      // dynacast stops the SFU forwarding layers nobody is watching. Both are
      // real savings once cameras are in play.
      adaptiveStream: true,
      dynacast: true,
      publishDefaults: {
        // Opus at 32kbps mono is transparent for speech and roughly a fifth of
        // what music-grade settings cost per participant.
        audioPreset: { maxBitrate: 32_000 },
        dtx: true, // Stop sending during silence.
        red: true, // Redundant encoding: survives isolated packet loss.
        // Simulcast sends several resolutions so the SFU can give each viewer
        // what their connection can actually take, rather than one stream that
        // is wrong for everybody.
        simulcast: true,
        videoCodec: 'vp8',
      },
    });
    this.room = room;

    room
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        this.callbacks.onSpeakingChanged(speakers.map((s) => s.identity));
      })
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        this.onTrackSubscribed(track, publication, participant);
        this.emitScreenShares();
      })
      .on(RoomEvent.TrackUnsubscribed, (_track, publication) => {
        this.detachRemoteAudio(publication.trackSid);
        this.emitVideoFeeds();
        this.emitScreenShares();
      })
      /**
       * Published, but not yet subscribed - the one moment a screen share can
       * be declined before any of it has been sent.
       *
       * autoSubscribe stays on for everything else: audio must arrive without
       * being asked for, and a camera is small. Only this one source is opt-in.
       */
      .on(RoomEvent.TrackPublished, (publication, participant) => {
        if (this.isUnwatchedScreenTrack(publication, participant)) {
          publication.setSubscribed(false);
        }
        this.emitScreenShares();
      })
      .on(RoomEvent.TrackUnpublished, (publication) => {
        this.watching.delete(publication.trackSid);
        this.emitScreenShares();
      })
      .on(RoomEvent.LocalTrackPublished, () => this.emitVideoFeeds())
      .on(RoomEvent.LocalTrackUnpublished, () => this.emitVideoFeeds())
      .on(RoomEvent.TrackMuted, () => this.emitVideoFeeds())
      .on(RoomEvent.TrackUnmuted, () => this.emitVideoFeeds())
      .on(RoomEvent.ParticipantConnected, () => {
        this.emitParticipants();
        this.emitScreenShares();
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        this.emitParticipants();
        this.emitVideoFeeds();
        this.emitScreenShares();
      })
      .on(RoomEvent.Reconnecting, () => this.callbacks.onConnectionStateChanged('reconnecting'))
      .on(RoomEvent.Reconnected, () => this.callbacks.onConnectionStateChanged('connected'))
      .on(RoomEvent.Disconnected, () => {
        this.callbacks.onConnectionStateChanged('disconnected');
        this.callbacks.onSpeakingChanged([]);
      })
      .on(RoomEvent.MediaDevicesError, (error) => {
        this.callbacks.onError(describeMediaError(error));
      });

    try {
      await room.connect(url, token);
    } catch (error) {
      this.room = null;
      this.callbacks.onConnectionStateChanged('disconnected');
      // Full detail to the console; a readable summary to the user.
      console.error('[voice] room.connect failed', {
        url,
        name: (error as Error)?.name,
        message: (error as Error)?.message,
        reason: (error as { reason?: unknown })?.reason,
        error,
      });
      throw new Error(describeConnectError(error, url));
    }

    await this.publishMicrophone();
    this.startLevelSampling();
    this.callbacks.onConnectionStateChanged('connected');
    this.emitParticipants();
    this.emitVideoFeeds();
  }

  async disconnect(): Promise<void> {
    this.stopLevelSampling();
    for (const sid of [...this.audioElements.keys()]) this.detachRemoteAudio(sid);

    await this.stopCamera().catch(() => {});
    await this.stopScreenShare().catch(() => {});

    if (this.micTrack) {
      this.micTrack.stop();
      this.micTrack = null;
    }
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }
    this.transmitting = false;
    // Leaving a room forgets what was being watched in it. Carrying the choice
    // into the next room would silently subscribe someone to a stranger's
    // screen on the strength of a click in a different channel.
    this.watching.clear();
    this.callbacks.onConnectionStateChanged('disconnected');
    this.callbacks.onSpeakingChanged([]);
    this.callbacks.onLevelsChanged(new Map());
    this.callbacks.onVideoFeedsChanged([]);
    this.callbacks.onScreenSharesChanged([]);
    this.callbacks.onParticipantsChanged([]);
  }

  /**
   * Open or close the microphone.
   *
   * Muting the published track rather than unpublishing it is what makes
   * push-to-talk feel instant: the track and its encoder stay warm, so
   * releasing the key resumes in milliseconds instead of re-negotiating and
   * re-acquiring the device, which takes hundreds.
   */
  async setTransmitting(on: boolean): Promise<void> {
    if (!this.micTrack || this.transmitting === on) return;
    this.transmitting = on;
    if (on) await this.micTrack.unmute();
    else await this.micTrack.mute();
  }

  /** Deafen: stop hearing everyone, and stop transmitting. */
  async setDeafened(deafened: boolean): Promise<void> {
    this.deafened = deafened;
    for (const element of this.audioElements.values()) element.muted = deafened;
    if (deafened) await this.setTransmitting(false);
  }

  // --- Camera --------------------------------------------------------------

  async startCamera(): Promise<void> {
    const room = this.room;
    if (!room || this.cameraTrack) return;

    try {
      this.cameraTrack = await createLocalVideoTrack({
        deviceId: exactDevice(this.settings.videoDeviceId),
        // 720p is the sweet spot for a call tile: sharp at the sizes these are
        // actually rendered, and a third of the bitrate of 1080p.
        resolution: { width: 1280, height: 720, frameRate: 30 },
      });
    } catch (error) {
      this.callbacks.onError(describeMediaError(error));
      throw error;
    }

    await room.localParticipant.publishTrack(this.cameraTrack, { source: Track.Source.Camera });
    this.emitVideoFeeds();
  }

  async stopCamera(): Promise<void> {
    const track = this.cameraTrack;
    if (!track) return;
    this.cameraTrack = null;
    if (this.room) await this.room.localParticipant.unpublishTrack(track);
    // Stopping releases the device, which is what turns the camera's hardware
    // indicator light off. Leaving it published-but-muted would not.
    track.stop();
    this.emitVideoFeeds();
  }

  // --- Screen share --------------------------------------------------------

  async startScreenShare(withAudio = false): Promise<void> {
    const room = this.room;
    if (!room || this.screenTracks.length > 0) return;

    try {
      // Audio only when asked for: loopback capture takes everything the
      // machine is playing, which is rarely what someone sharing a window
      // intends to broadcast.
      const tracks = await room.localParticipant.createScreenTracks({ audio: withAudio });
      for (const track of tracks) {
        await room.localParticipant.publishTrack(track);
        this.screenTracks.push(track);
      }
    } catch (error) {
      // The user dismissing the picker is a cancel, not a failure worth
      // reporting as an error banner.
      if ((error as { name?: string })?.name === 'NotAllowedError') return;
      this.callbacks.onError(describeMediaError(error));
      throw error;
    }

    // Ending the share from the browser's own "stop sharing" bar has to be
    // noticed, or our button stays lit for a share that no longer exists.
    for (const track of this.screenTracks) {
      if (track instanceof LocalVideoTrack) {
        track.mediaStreamTrack.addEventListener('ended', () => void this.stopScreenShare());
      }
    }
    this.emitVideoFeeds();
  }

  async stopScreenShare(): Promise<void> {
    const room = this.room;
    const tracks = this.screenTracks;
    if (tracks.length === 0) return;
    this.screenTracks = [];

    for (const track of tracks) {
      if (room) await room.localParticipant.unpublishTrack(track);
      track.stop();
    }
    this.emitVideoFeeds();
  }

  // --- Settings ------------------------------------------------------------

  /**
   * How loud each person is, for this listener only. 0..1.
   *
   * Held here rather than left to LiveKit because a participant object is
   * recreated whenever someone leaves and rejoins a room, taking its volume
   * with it. Keeping the map on the engine means a level you set once survives
   * them reconnecting, you rejoining, and the app restarting.
   *
   * The ceiling is 1 and not higher on purpose: below the surface this sets
   * `HTMLMediaElement.volume`, which *throws* above 1.0 rather than clamping.
   * Amplifying past 100% needs a Web Audio gain stage, which would also take
   * over output-device selection and deafening - a bigger change than it looks.
   */
  private volumes = new Map<string, number>();

  setParticipantVolume(userId: string, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.volumes.set(userId, clamped);
    this.applyVolume(userId);
  }

  /** Seeds saved levels before anyone's audio arrives. */
  setParticipantVolumes(volumes: Map<string, number>): void {
    this.volumes = new Map(volumes);
    for (const userId of this.volumes.keys()) this.applyVolume(userId);
  }

  private applyVolume(userId: string): void {
    const participant = this.room?.getParticipantByIdentity(userId);
    if (participant instanceof RemoteParticipant) {
      participant.setVolume(this.volumes.get(userId) ?? 1);
    }
  }

  async applySettings(settings: AudioSettings): Promise<void> {
    const inputChanged = settings.inputDeviceId !== this.settings.inputDeviceId;
    const processingChanged =
      settings.echoCancellation !== this.settings.echoCancellation ||
      settings.noiseSuppression !== this.settings.noiseSuppression ||
      settings.autoGainControl !== this.settings.autoGainControl;
    const cameraChanged = settings.videoDeviceId !== this.settings.videoDeviceId;

    this.settings = settings;

    if (settings.outputDeviceId) await this.applyOutputDevice(settings.outputDeviceId);

    // Constraints are baked in when a track is created, so anything that
    // changes them means republishing.
    if ((inputChanged || processingChanged) && this.room?.state === ConnectionState.Connected) {
      await this.publishMicrophone();
    }
    if (cameraChanged && this.cameraTrack) {
      await this.stopCamera();
      await this.startCamera();
    }
  }

  get connectionQuality(): ConnectionQuality {
    return this.room?.localParticipant.connectionQuality ?? ConnectionQuality.Unknown;
  }

  // --- Internals -----------------------------------------------------------

  private async publishMicrophone(): Promise<void> {
    const room = this.room;
    if (!room) return;

    if (this.micTrack) {
      await room.localParticipant.unpublishTrack(this.micTrack);
      this.micTrack.stop();
      this.micTrack = null;
    }

    try {
      this.micTrack = await createLocalAudioTrack({
        deviceId: exactDevice(this.settings.inputDeviceId),
        echoCancellation: this.settings.echoCancellation,
        noiseSuppression: this.settings.noiseSuppression,
        autoGainControl: this.settings.autoGainControl,
      });
    } catch (error) {
      this.callbacks.onError(describeMediaError(error));
      return;
    }

    // Published muted. Joining a channel should never open your microphone
    // before you have said you want it open.
    await this.micTrack.mute();
    this.transmitting = false;
    await room.localParticipant.publishTrack(this.micTrack, { source: Track.Source.Microphone });
  }

  /**
   * Samples every participant's audio level on a timer.
   *
   * LiveKit exposes a continuous 0..1 level per participant, which is what
   * drives the meters. `ActiveSpeakersChanged` alone is a boolean and would
   * only ever produce an on/off dot.
   */
  private startLevelSampling(): void {
    this.stopLevelSampling();
    this.levelTimer = setInterval(() => {
      const room = this.room;
      if (!room) return;

      const levels = new Map<string, number>();
      const participants: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
      for (const participant of participants) {
        // A muted local mic still reports its last level for a moment; force it
        // to zero so the meter matches what everyone else can actually hear.
        const muted = participant === room.localParticipant && !this.transmitting;
        levels.set(participant.identity, muted ? 0 : participant.audioLevel);
      }
      this.callbacks.onLevelsChanged(levels);
    }, LEVEL_SAMPLE_MS);
  }

  private stopLevelSampling(): void {
    clearInterval(this.levelTimer);
    this.levelTimer = undefined;
  }

  private onTrackSubscribed(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    if (track instanceof RemoteAudioTrack) {
      const element = track.attach();
      element.autoplay = true;
      element.muted = this.deafened;
      // Their saved level, applied to the track that just arrived. Without this
      // the setting only takes effect on people already talking when it was
      // changed, and silently resets for everyone who joins later.
      track.setVolume(this.volumes.get(participant.identity) ?? 1);
      // Kept out of the layout: it exists to play audio, not to be seen.
      element.style.display = 'none';
      document.body.appendChild(element);
      this.audioElements.set(publication.trackSid, element);

      if (this.settings.outputDeviceId) {
        void setSinkId(element, this.settings.outputDeviceId);
      }
      this.emitParticipants();
      return;
    }

    if (track instanceof RemoteVideoTrack) {
      // Video elements are rendered by React, so the engine only announces that
      // a feed exists and lets the component own the element's lifecycle.
      this.emitVideoFeeds();
    }
  }

  private detachRemoteAudio(trackSid: string): void {
    const element = this.audioElements.get(trackSid);
    if (!element) return;
    element.pause();
    element.srcObject = null;
    element.remove();
    this.audioElements.delete(trackSid);
    this.emitParticipants();
  }

  private async applyOutputDevice(deviceId: string): Promise<void> {
    await Promise.all([...this.audioElements.values()].map((el) => setSinkId(el, deviceId)));
  }

  private emitVideoFeeds(): void {
    const room = this.room;
    if (!room) {
      this.callbacks.onVideoFeedsChanged([]);
      return;
    }

    const feeds: VideoFeed[] = [];
    const participants: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];

    for (const participant of participants) {
      const isLocal = participant === room.localParticipant;
      for (const publication of participant.trackPublications.values()) {
        const track = publication.track;
        if (!track || publication.kind !== Track.Kind.Video) continue;
        if (publication.isMuted) continue;

        const source =
          publication.source === Track.Source.ScreenShare ? ('screen' as const) : ('camera' as const);

        // Somebody else's screen appears only if it was asked for. Reading the
        // intent rather than whether the track happens to still be attached:
        // dropping a subscription does not clear `publication.track` straight
        // away, so a viewer who stopped watching kept a frozen frame on screen
        // next to the offer to start watching it again.
        if (source === 'screen' && !isLocal && !this.watching.has(publication.trackSid)) continue;

        feeds.push({
          userId: participant.identity,
          trackSid: publication.trackSid,
          source,
          isLocal,
          attach: (element) => track.attach(element),
          detach: (element) => track.detach(element),
        });
      }
    }

    // Screen shares first: someone presenting is the thing people came to look
    // at, and it should not move as cameras come and go around it.
    feeds.sort((a, b) => (a.source === b.source ? 0 : a.source === 'screen' ? -1 : 1));
    this.callbacks.onVideoFeedsChanged(feeds);
  }

  /**
   * Start receiving somebody's screen.
   *
   * Idempotent, and safe to call for a share that has since ended - the sid
   * simply matches nothing. The intent is recorded either way, so a share that
   * is republished after a reconnect comes back to a viewer who had asked for
   * it rather than making them click again.
   */
  watchScreenShare(trackSid: string): void {
    this.watching.add(trackSid);
    this.findScreenPublication(trackSid)?.setSubscribed(true);
    this.setScreenAudioForOwnerOf(trackSid, true);
    this.emitScreenShares();
  }

  stopWatchingScreenShare(trackSid: string): void {
    this.watching.delete(trackSid);
    this.findScreenPublication(trackSid)?.setSubscribed(false);
    this.setScreenAudioForOwnerOf(trackSid, false);
    this.emitScreenShares();
    // The feed is gone the moment the subscription is dropped, and waiting for
    // TrackUnsubscribed to say so leaves a dead tile on screen in between.
    this.emitVideoFeeds();
  }

  /**
   * A part of somebody's screen share that this viewer has not asked to watch.
   *
   * Both halves, which is the point: a share publishes a video track and, when
   * system audio was included, a second audio track. Testing only the video
   * meant declining a stream still delivered its sound - you could not see what
   * somebody was presenting but you could hear it, which is worse than either
   * watching or not.
   *
   * Matched by the sharer rather than by track id, because the audio has its
   * own sid that appears nowhere in the offer the viewer accepted.
   */
  private isUnwatchedScreenTrack(
    publication: RemoteTrackPublication | { source: Track.Source; trackSid: string },
    participant: Participant,
  ): boolean {
    const isScreen =
      publication.source === Track.Source.ScreenShare ||
      publication.source === Track.Source.ScreenShareAudio;
    if (!isScreen) return false;
    return !this.watchedUserIds().has(participant.identity);
  }

  /** Whose screens this viewer is currently taking. */
  private watchedUserIds(): Set<string> {
    const owners = new Set<string>();
    for (const participant of this.room?.remoteParticipants.values() ?? []) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.source !== Track.Source.ScreenShare) continue;
        if (this.watching.has(publication.trackSid)) owners.add(participant.identity);
      }
    }
    return owners;
  }

  private findScreenPublication(trackSid: string): RemoteTrackPublication | null {
    for (const participant of this.room?.remoteParticipants.values() ?? []) {
      const publication = participant.trackPublications.get(trackSid);
      if (publication) return publication as RemoteTrackPublication;
    }
    return null;
  }

  /**
   * Follow the picture with the sound.
   *
   * The share's audio is a separate publication with its own sid, so it has to
   * be found through the person sharing rather than through the track that was
   * clicked.
   */
  private setScreenAudioForOwnerOf(trackSid: string, subscribed: boolean): void {
    for (const participant of this.room?.remoteParticipants.values() ?? []) {
      if (!participant.trackPublications.has(trackSid)) continue;
      for (const publication of participant.trackPublications.values()) {
        if (publication.source === Track.Source.ScreenShareAudio) {
          (publication as RemoteTrackPublication).setSubscribed(subscribed);
        }
      }
    }
  }

  /** Every screen on offer in the room, and whether this viewer takes it. */
  private emitScreenShares(): void {
    const room = this.room;
    if (!room) {
      this.callbacks.onScreenSharesChanged([]);
      return;
    }

    const shares: ScreenShare[] = [];
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.source !== Track.Source.ScreenShare) continue;
        // A muted publication is a share that has been paused rather than
        // stopped; there is nothing to watch and offering it would be a button
        // that does nothing.
        if (publication.isMuted) continue;
        shares.push({
          userId: participant.identity,
          trackSid: publication.trackSid,
          watching: this.watching.has(publication.trackSid),
        });
      }
    }
    this.callbacks.onScreenSharesChanged(shares);
  }

  private emitParticipants(): void {
    const room = this.room;
    if (!room) {
      this.callbacks.onParticipantsChanged([]);
      return;
    }
    const identities = [
      room.localParticipant.identity,
      ...[...room.remoteParticipants.values()].map((p) => p.identity),
    ];
    this.callbacks.onParticipantsChanged(identities);
  }
}

/** `setSinkId` is not in every TypeScript DOM lib yet and is absent on some browsers. */
async function setSinkId(element: HTMLAudioElement, deviceId: string): Promise<void> {
  const withSink = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof withSink.setSinkId !== 'function') return;
  try {
    await withSink.setSinkId(deviceId);
  } catch {
    // Device disappeared or is not permitted; the default output still works.
  }
}

/**
 * Turns an SFU connection failure into something a person can act on.
 *
 * The two failures look nothing alike from the user's side and have completely
 * different fixes, so they are worth separating: signalling failing means the
 * SFU is not running or not reachable, while the peer connection failing after
 * signalling succeeded means media cannot get through - the SFU is advertising
 * an address this machine cannot route to, or UDP is being blocked.
 */
function describeConnectError(error: unknown, url: string): string {
  const message = (error as Error)?.message ?? String(error);

  if (/pc connection|ICE|peer ?connection/i.test(message)) {
    return (
      'Connected to the voice server, but no audio path could be opened. ' +
      'This is usually the SFU advertising an address this machine cannot reach — ' +
      'check `node_ip` in infra/livekit.yaml, and that UDP 7882 is not blocked.'
    );
  }

  if (/websocket|network|refused|timeout|failed to fetch/i.test(message)) {
    return `Could not reach the voice server at ${url}. Is it running? Try \`npm run infra:up\`.`;
  }

  return `Could not join voice: ${message}`;
}

function describeMediaError(error: unknown): string {
  const name = (error as { name?: string })?.name;
  switch (name) {
    case 'NotAllowedError':
      return 'Access was denied. Allow the microphone and camera in your system privacy settings, then rejoin.';
    case 'NotFoundError':
      return 'No device was found. Plug one in and try again.';
    case 'NotReadableError':
      return 'That device is in use by another application.';
    case 'OverconstrainedError':
      return 'The selected device is no longer available.';
    default:
      return `Media error: ${(error as Error)?.message ?? 'unknown'}`;
  }
}

export async function listMediaDevices(): Promise<{
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
}> {
  // Device labels are empty until the page has been granted access at least
  // once, so ask first and enumerate second. Audio only: prompting for the
  // camera just to read a device list would turn on someone's webcam light
  // while they are only looking at settings.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  } catch {
    // Enumerate anyway - the user gets unlabelled entries rather than none.
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((d) => d.kind === 'audioinput'),
    outputs: devices.filter((d) => d.kind === 'audiooutput'),
    cameras: devices.filter((d) => d.kind === 'videoinput'),
  };
}
