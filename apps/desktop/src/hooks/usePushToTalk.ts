import { useEffect } from 'react';
import { useApp } from '../store/app.js';

/**
 * Push-to-talk input.
 *
 * Two paths, because they are genuinely different problems:
 *
 * - Focused: real keydown/keyup from the renderer gives true hold-to-talk.
 * - Unfocused: Electron's globalShortcut fires on press only - there is no
 *   release event - so the global key toggles transmission instead. Proper
 *   global hold-to-talk needs a native OS-level hook (uiohook-napi); this is
 *   the honest behaviour until that is added.
 */
export function usePushToTalk(key: string): void {
  const transmitMode = useApp((s) => s.transmitMode);
  const voiceChannelId = useApp((s) => s.voiceChannelId);
  const setPushToTalkActive = useApp((s) => s.setPushToTalkActive);

  useEffect(() => {
    if (transmitMode !== 'push-to-talk' || !voiceChannelId) return;

    const matches = (event: KeyboardEvent) => event.code === key || event.key === key;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!matches(event)) return;
      // Auto-repeat fires continuously while a key is held; only the first
      // press is a state change.
      if (event.repeat) return;
      // Never swallow the key while the user is writing a message.
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setPushToTalkActive(true);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!matches(event)) return;
      event.preventDefault();
      setPushToTalkActive(false);
    };

    // Losing focus mid-hold would otherwise leave the microphone open, because
    // the keyup lands in whichever window took focus.
    const onBlur = () => setPushToTalkActive(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    const offGlobal = window.chitchak?.onPushToTalkToggle(() => {
      setPushToTalkActive(!useApp.getState().pushToTalkActive);
    });

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      offGlobal?.();
      setPushToTalkActive(false);
    };
  }, [key, transmitMode, voiceChannelId, setPushToTalkActive]);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}
