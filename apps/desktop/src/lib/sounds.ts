/**
 * Notification sounds, synthesised rather than sampled.
 *
 * No audio files. A handful of short tones is a few lines of Web Audio and no
 * bytes at all, where samples would be several binary blobs to ship, license
 * and keep in step across the desktop build and the web client. It also keeps
 * the app's rule about assets intact: nothing is fetched from anywhere.
 *
 * Liquid pops: scooped pitches overshoot, rebound and settle with a little
 * wobble. Detuned bodies and a fleeting octave give each bubble some colour
 * without a sharp attack, noise samples or an effect tail that crowds speech.
 * The C-major / sixth palette ties the set together: one small message bwip,
 * a higher DM double-pop, mirrored join/leave triplets and a syncopated friend
 * greeting. Rhythm and pitch contour carry meaning as much as the notes do.
 */

export type SoundName = 'dm' | 'message' | 'join' | 'leave' | 'friend';

interface Note {
  /** Pitch in Hz. */
  hz: number;
  /** Seconds from the start of the sound. */
  at: number;
  /** Seconds. */
  len: number;
  /** Peak level before the user's volume, 0-1. */
  peak: number;
  /** Starting bend in semitones relative to hz; negative scoops upward. */
  scoop: number;
  /** Settling wobble in semitones, kept smaller on the frequent sounds. */
  wobble: number;
}

/** Equal temperament, so the pairs are actual intervals rather than guesses. */
const C4 = 261.63;
const E4 = 329.63;
const G4 = 392.0;
const C5 = 523.25;
const E5 = 659.25;
const A4 = 440.0;

const SOUNDS: Record<SoundName, Note[]> = {
  /** One small elastic bwip: the most frequent sound, so the quietest. */
  message: [{ hz: E4, at: 0, len: 0.22, peak: 0.21, scoop: -7, wobble: 0.18 }],

  /** A clipped pickup followed by a fuller, higher bubble: b'doop. */
  dm: [
    { hz: C5, at: 0, len: 0.1, peak: 0.18, scoop: -5, wobble: 0.12 },
    { hz: E5, at: 0.075, len: 0.28, peak: 0.25, scoop: -9, wobble: 0.32 },
  ],

  /** Three bubbles climbing a fifth, the last springing into place. */
  join: [
    { hz: C4, at: 0, len: 0.12, peak: 0.19, scoop: -5, wobble: 0.15 },
    { hz: E4, at: 0.065, len: 0.13, peak: 0.21, scoop: -6, wobble: 0.2 },
    { hz: G4, at: 0.145, len: 0.28, peak: 0.23, scoop: -7, wobble: 0.45 },
  ],

  /** The same rhythm tumbling down, bends reversed, into a low plup. */
  leave: [
    { hz: G4, at: 0, len: 0.12, peak: 0.19, scoop: 5, wobble: 0.15 },
    { hz: E4, at: 0.065, len: 0.13, peak: 0.18, scoop: 6, wobble: 0.2 },
    { hz: C4, at: 0.145, len: 0.25, peak: 0.2, scoop: 7, wobble: 0.3 },
  ],

  /** A quick double pickup, a tiny pause, then an exuberant sixth: ba-da-bwip. */
  friend: [
    { hz: C4, at: 0, len: 0.11, peak: 0.19, scoop: -7, wobble: 0.2 },
    { hz: E4, at: 0.06, len: 0.11, peak: 0.2, scoop: -5, wobble: 0.25 },
    { hz: A4, at: 0.205, len: 0.34, peak: 0.25, scoop: -10, wobble: 0.65 },
  ],
};

/**
 * Long enough that the note starts from silence rather than from a step.
 *
 * A gain that jumps straight to its peak is a discontinuity, and a
 * discontinuity is a click - which is the difference between a sound that
 * belongs in an app and one that sounds broken.
 */
const ATTACK = 0.008;

/**
 * `exponentialRampToValueAtTime` cannot reach zero, so the tail lands here and
 * a final short linear fade reaches actual zero before stopping. Each partial
 * uses a relative floor so even very low user volumes retain the same shape.
 */
const SILENCE = 0.0001;

/** A close pair for thickness and a brief octave for the wet, rounded pop. */
const PARTIALS = [
  { ratio: 1, cents: -7, level: 0.52, duration: 1 },
  { ratio: 1, cents: 7, level: 0.3, duration: 0.92 },
  { ratio: 2, cents: 0, level: 0.18, duration: 0.48 },
] as const;

/** A continuous pitch gesture, in semitones, rather than a stepped melody.
 * The scoop lands in 42ms; a small rebound and damped wobble make it elastic.
 * Fixed curves keep repeated notifications recognisable (no random detuning).
 */
function bubblePitch(note: Note, ratio: number, duration: number): Float32Array {
  const curve = new Float32Array(128);
  const bendTime = Math.min(0.042, note.len * 0.3);
  for (let i = 0; i < curve.length; i++) {
    const t = (i / (curve.length - 1)) * duration;
    const progress = Math.min(1, t / bendTime);
    const scoop = note.scoop * (1 - progress) ** 3;
    const rebound = -Math.sign(note.scoop) * 1.4 * Math.sin(Math.PI * progress);
    const settled = Math.max(0, t - bendTime);
    const wobble = note.wobble * Math.sin(2 * Math.PI * 17 * settled) * Math.exp(-settled * 14);
    curve[i] = note.hz * ratio * 2 ** ((scoop + rebound + wobble) / 12);
  }
  return curve;
}

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context ??= new Ctor();
  return context;
}

/**
 * Wakes the audio context on the first real interaction.
 *
 * A browser starts one suspended until the page has been interacted with, and
 * the web client is a browser. Without this the first notification after a cold
 * load is silent - and it is the first one that matters most, because it is the
 * one that tells somebody the feature works at all.
 */
export function unlockSounds(): void {
  const ctx = audio();
  if (ctx && ctx.state === 'suspended') void ctx.resume();
}

export function play(name: SoundName, volume: number): void {
  if (!Number.isFinite(volume) || volume <= 0) return;
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();

  // A hair ahead, so every note in the sound is scheduled rather than the first
  // one racing the scheduler and arriving late.
  const start = ctx.currentTime + 0.02;

  for (const note of SOUNDS[name]) {
    for (const partial of PARTIALS) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.detune.value = partial.cents;

      const at = start + note.at;
      const end = at + note.len * partial.duration;
      osc.frequency.setValueCurveAtTime(bubblePitch(note, partial.ratio, end - at), at, end - at);
      const peak = note.peak * Math.min(1, volume) * partial.level;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(peak, at + ATTACK);
      // Keep body through the bend, then tuck the tail away. No reverb is
      // needed: overlapping bubbles supply space without washing out speech.
      gain.gain.exponentialRampToValueAtTime(peak * 0.55, at + (end - at) * 0.42);
      gain.gain.exponentialRampToValueAtTime(peak * SILENCE, end - 0.015);
      gain.gain.linearRampToValueAtTime(0, end);

      osc.connect(gain).connect(ctx.destination);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
      osc.start(at);
      osc.stop(end);
    }
  }
}
