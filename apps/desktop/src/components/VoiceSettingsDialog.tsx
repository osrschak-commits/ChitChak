import { useEffect, useState } from 'react';
import { listMediaDevices } from '../lib/voice.js';
import { useApp } from '../store/app.js';
import { Switch } from './primitives.js';

export function VoiceSettingsDialog({ onClose }: { onClose(): void }) {
  const audioSettings = useApp((s) => s.audioSettings);
  const setAudioSettings = useApp((s) => s.setAudioSettings);
  const transmitMode = useApp((s) => s.transmitMode);
  const setTransmitMode = useApp((s) => s.setTransmitMode);

  const [devices, setDevices] = useState<{
    inputs: MediaDeviceInfo[];
    outputs: MediaDeviceInfo[];
    cameras: MediaDeviceInfo[];
  }>({ inputs: [], outputs: [], cameras: [] });
  const [pttKey, setPttKey] = useState('F8');
  const [capturing, setCapturing] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    void listMediaDevices().then(setDevices);
    void window.chitchak?.getPushToTalkKey().then(setPttKey);

    // Headsets get plugged in mid-session; the list should not be a snapshot
    // from whenever this dialog happened to open.
    const onChange = () => void listMediaDevices().then(setDevices);
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
  }, []);

  useEffect(() => {
    if (!capturing) return;

    const onKeyDown = async (event: KeyboardEvent) => {
      event.preventDefault();
      const accelerator = toAccelerator(event);
      if (!accelerator) {
        setKeyError('That key cannot be used. Try a function key, or hold a modifier.');
        return;
      }
      setCapturing(false);
      setKeyError(null);

      const result = await window.chitchak?.setPushToTalkKey(accelerator);
      if (result && !result.ok) {
        setKeyError(`${accelerator} is already taken by another application.`);
        setPttKey(result.accelerator);
      } else {
        setPttKey(accelerator);
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [capturing]);

  // Which device is actually in use, so "System default" can be inspected too.
  const activeInput = audioSettings.inputDeviceId
    ? devices.inputs.find((d) => d.deviceId === audioSettings.inputDeviceId)
    : (devices.inputs.find((d) => d.deviceId === 'default') ?? devices.inputs[0]);
  const loopbackWarning = describeLoopback(activeInput?.label ?? '');

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Voice and video</h2>
          <p className="modal__sub">Applies the next time you speak.</p>
        </div>

        <div className="modal__body">
          <div className="section">
            <h3 className="section__title">Devices</h3>

            <div className="field">
              <label className="field__label" htmlFor="device-input">
                Microphone
              </label>
              <select
                id="device-input"
                value={audioSettings.inputDeviceId ?? ''}
                onChange={(e) => void setAudioSettings({ inputDeviceId: e.target.value || undefined })}
              >
                <option value="">System default</option>
                {devices.inputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || 'Microphone'}
                  </option>
                ))}
              </select>
              {loopbackWarning && <div className="field__error">{loopbackWarning}</div>}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="device-output">
                Output
              </label>
              <select
                id="device-output"
                value={audioSettings.outputDeviceId ?? ''}
                onChange={(e) => void setAudioSettings({ outputDeviceId: e.target.value || undefined })}
              >
                <option value="">System default</option>
                {devices.outputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || 'Speakers'}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="device-camera">
                Camera
              </label>
              <select
                id="device-camera"
                value={audioSettings.videoDeviceId ?? ''}
                onChange={(e) => void setAudioSettings({ videoDeviceId: e.target.value || undefined })}
              >
                <option value="">System default</option>
                {devices.cameras.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || 'Camera'}
                  </option>
                ))}
              </select>
              {devices.cameras.length === 0 && (
                <div className="field__hint">
                  No cameras listed yet. Turn your camera on once in a call and they will appear.
                </div>
              )}
            </div>
          </div>

          <div className="section">
            <h3 className="section__title">Input</h3>

            <div className="row">
              <div>
                <div className="row__label">How you transmit</div>
                <div className="row__hint">
                  Voice activity opens the mic when you speak. Push-to-talk only transmits while the
                  key is held.
                </div>
              </div>
              <div className="segmented row__control">
                <button
                  aria-pressed={transmitMode === 'voice-activity'}
                  onClick={() => setTransmitMode('voice-activity')}
                >
                  Voice
                </button>
                <button
                  aria-pressed={transmitMode === 'push-to-talk'}
                  onClick={() => setTransmitMode('push-to-talk')}
                >
                  Push to talk
                </button>
              </div>
            </div>

            {transmitMode === 'push-to-talk' && (
              <div className="row">
                <div>
                  <div className="row__label">Push-to-talk key</div>
                  <div className="row__hint">
                    Held to talk while ChitChak is focused. When another app has focus the same key
                    toggles transmission instead, because Electron cannot see key release globally.
                  </div>
                  {keyError && <div className="field__error">{keyError}</div>}
                </div>
                <button className="btn btn--ghost btn--sm row__control mono" onClick={() => setCapturing(true)}>
                  {capturing ? 'Press a key…' : pttKey}
                </button>
              </div>
            )}
          </div>

          <div className="section">
            <h3 className="section__title">Processing</h3>

            <div className="row">
              <div>
                <div className="row__label">Echo cancellation</div>
                <div className="row__hint">Stops your speakers feeding back into your mic.</div>
              </div>
              <Switch
                label="Echo cancellation"
                checked={audioSettings.echoCancellation}
                onChange={(v) => void setAudioSettings({ echoCancellation: v })}
              />
            </div>

            <div className="row">
              <div>
                <div className="row__label">Noise suppression</div>
                <div className="row__hint">Filters fans, keyboards and background hum.</div>
              </div>
              <Switch
                label="Noise suppression"
                checked={audioSettings.noiseSuppression}
                onChange={(v) => void setAudioSettings({ noiseSuppression: v })}
              />
            </div>

            <div className="row">
              <div>
                <div className="row__label">Automatic gain</div>
                <div className="row__hint">Evens out how loud you come through.</div>
              </div>
              <Switch
                label="Automatic gain control"
                checked={audioSettings.autoGainControl}
                onChange={(v) => void setAudioSettings({ autoGainControl: v })}
              />
            </div>
          </div>
        </div>

        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Warns when the chosen input is a loopback device.
 *
 * Stereo Mix, VB-CABLE, Voicemeeter and similar capture whatever the computer
 * is playing rather than a microphone, so picking one - or having it as the
 * system default - broadcasts your games, music and other calls to everyone in
 * the room. It is a genuinely confusing thing to debug from the listening end,
 * because your voice comes through fine alongside everything else.
 */
function describeLoopback(label: string): string | null {
  const loopback = [
    'stereo mix',
    'what u hear',
    'what you hear',
    'wave out',
    'cable output',
    'voicemeeter out',
    'loopback',
    'virtual audio',
    'vb-audio',
  ];
  const lower = label.toLowerCase();
  if (!loopback.some((name) => lower.includes(name))) return null;
  return `"${label}" captures everything playing on your PC, not your voice. Everyone will hear your games, music and notifications. Pick your actual microphone instead.`;
}

/**
 * Translates a browser KeyboardEvent into an Electron accelerator string.
 *
 * Only the subset Electron accepts globally: function keys, letters, digits and
 * space, optionally with modifiers. Anything else returns null so the user gets
 * an explanation rather than a silently dead binding.
 */
function toAccelerator(event: KeyboardEvent): string | null {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');

  const code = event.code;
  let base: string | null = null;

  if (/^F\d{1,2}$/.test(code)) base = code;
  else if (/^Key[A-Z]$/.test(code)) base = code.slice(3);
  else if (/^Digit\d$/.test(code)) base = code.slice(5);
  else if (code === 'Space') base = 'Space';

  if (!base) return null;
  // A bare letter or digit would swallow that key system-wide, which is
  // unusable; require a modifier unless it is a function key.
  if (modifiers.length === 0 && !/^F\d{1,2}$/.test(base)) return null;

  return [...modifiers, base].join('+');
}
