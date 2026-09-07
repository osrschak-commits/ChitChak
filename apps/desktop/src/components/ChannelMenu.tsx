import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Permission } from '@chitchak/protocol';
import type { Channel } from '@chitchak/protocol';
import { api } from '../lib/api.js';
import { usePermissions } from '../hooks/usePermissions.js';

/**
 * Right-click menu on a channel: things you can do *to* it.
 *
 * The same split as the member menu. Left-click opens a channel, right-click
 * asks what can be done about it - and keeping the destructive half out of the
 * ordinary path is what stops a channel being deleted by somebody who meant to
 * read it.
 *
 * Every entry is gated on MANAGE_CHANNELS, so the menu offers only what will
 * work. The server checks it again regardless.
 */
export function ChannelMenu({
  channel,
  x,
  y,
  onClose,
  onEditAccess,
}: {
  channel: Channel;
  x: number;
  y: number;
  onClose(): void;
  onEditAccess?(): void;
}) {
  const { can } = usePermissions();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(channel.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Kept on screen: a menu opened near the bottom edge would otherwise run off
  // it, and the entry most likely to be cut off is the last one.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      x: Math.min(x, window.innerWidth - box.width - 8),
      y: Math.min(y, window.innerHeight - box.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const mayManage = can(Permission.MANAGE_CHANNELS);

  async function rename() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === channel.name) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await api.updateChannel(channel.id, { name: trimmed });
      onClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not rename it');
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteChannel(channel.id);
      onClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not delete it');
      setBusy(false);
    }
  }

  return (
    <div className="menu" ref={ref} style={{ left: position.x, top: position.y }} role="menu">
      <div className="menu__label legend">
        {channel.kind === 'voice' ? '◍' : '#'} {channel.name}
      </div>

      {error && <div className="menu__error">{error}</div>}

      {!mayManage && <div className="menu__note">You cannot change this channel.</div>}

      {mayManage && renaming && (
        <div className="menu__form">
          <input
            className="menu__input"
            value={name}
            autoFocus
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename();
              if (event.key === 'Escape') setRenaming(false);
            }}
            aria-label="Channel name"
          />
          <button className="btn btn--sm" disabled={busy} onClick={() => void rename()}>
            Save
          </button>
        </div>
      )}

      {mayManage && !renaming && (
        <button className="menu__item" onClick={() => setRenaming(true)}>
          Rename
        </button>
      )}

      {mayManage && onEditAccess && (
        <button
          className="menu__item"
          onClick={() => {
            onClose();
            onEditAccess();
          }}
        >
          Who can see it
        </button>
      )}

      {mayManage && (
        <>
          <div className="menu__divider" />
          {/* Two steps, and the second one names the channel. Deleting takes
              every message in it, and there is no undo anywhere in this app. */}
          {confirmingDelete ? (
            <button
              className="menu__item menu__item--danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Deleting…' : `Delete #${channel.name} for good`}
            </button>
          ) : (
            <button
              className="menu__item menu__item--danger"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete channel
            </button>
          )}
        </>
      )}
    </div>
  );
}
