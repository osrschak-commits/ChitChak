/**
 * Notification sounds, synthesised rather than sampled.
 *
 * No audio files. A handful of short tones is a few lines of Web Audio and no
 * bytes at all, where samples would be several binary blobs to ship, license
 * and keep in step across the desktop build and the web client. It also keeps
 * the app's rule about assets intact: nothing is fetched from anywhere.
 *
 * If designed sounds arrive later, `play` is the only thing that has to change
 * - everything upstream deals in names, not audio.
 *
 * The sounds are built as pairs rather than as five unrelated beeps: joining
 * rises and leaving is the same interval falling, so the second one is learnt
 * for free. DMs sit above ordinary messages for the same reason - the one that
 * matters more is the one higher up.
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
}

/** Equal temperament, so the pairs are actual intervals rather than guesses. */
const C5 = 523.25;
const E5 = 659.25;
const G5 = 784.0;
const A5 = 880.0;
const C6 = 1046.5;

const SOUNDS: Record<SoundName, Note[]> = {
  /** One soft note. The most frequent sound in the app, so the quietest. */
  message: [{ hz: E5, at: 0, len: 0.16, peak: 0.3 }],

  /** A fifth up, brighter and higher: addressed to you specifically. */
  dm: [
    { hz: G5, at: 0, len: 0.13, peak: 0.36 },
    { hz: C6, at: 0.085, len: 0.2, peak: 0.36 },
  ],

  /** Rising fifth - someone arrived. */
  join: [
    { hz: C5, at: 0, len: 0.12, peak: 0.32 },
    { hz: G5, at: 0.075, len: 0.19, peak: 0.32 },
  ],

  /** The same fifth falling - the inverse, so it needs no learning. */
  leave: [
    { hz: G5, at: 0, len: 0.12, peak: 0.3 },
    { hz: C5, at: 0.075, len: 0.21, peak: 0.3 },
  ],

  /** Three notes: rarer, and worth looking up for. */
  friend: [
    { hz: E5, at: 0, len: 0.11, peak: 0.32 },
    { hz: A5, at: 0.07, len: 0.11, peak: 0.32 },
    { hz: C6, at: 0.14, len: 0.24, peak: 0.34 },
  ],
};

/**
 * Long enough that the note starts from silence rather than from a step.
 *
 * A gain that jumps straight to its peak is a discontinuity, and a
 * discontinuity is a click - which is the difference between a sound that
 * belongs in an app and one that sounds broken.
 */
const ATTACK = 0.012;

/**
 * `exponentialRampToValueAtTime` cannot reach zero, so the tail lands here and
 * the oscillator stops immediately after. Ramping to an audible value and then
 * stopping would put the click back at the other end.
 */
const SILENCE = 0.0001;

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
  const ctx = audio();
  if (!ctx || volume <= 0) return;
  if (ctx.state === 'suspended') void ctx.resume();

  // A hair ahead, so every note in the sound is scheduled rather than the first
  // one racing the scheduler and arriving late.
  const start = ctx.currentTime + 0.02;

  for (const note of SOUNDS[name]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // Triangle rather than sine: a little more presence over people talking,
    // without the edge a square or sawtooth would bring.
    osc.type = 'triangle';
    osc.frequency.value = note.hz;

    const at = start + note.at;
    const peak = Math.max(SILENCE, note.peak * volume);
    gain.gain.setValueAtTime(SILENCE, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + ATTACK);
    gain.gain.exponentialRampToValueAtTime(SILENCE, at + note.len);

    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + note.len + 0.02);
  }
}
