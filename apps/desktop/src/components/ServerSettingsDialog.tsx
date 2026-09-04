import { useEffect, useMemo, useRef, useState } from 'react';
import type { Channel } from '@chitchak/protocol';
import { Permission } from '@chitchak/protocol';
import { api } from '../lib/api.js';
import { prepareSquareImage } from '../lib/image.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useApp } from '../store/app.js';
import { ChannelAccessDialog } from './ChannelAccessDialog.js';
import { CreateChannelDialog } from './CreateChannelDialog.js';
import { InvitesTab } from './InvitesTab.js';
import { BansTab, MembersTab } from './MembersTab.js';
import { RanksTab } from './RanksTab.js';
import { GuildBadge } from './TopBar.js';

/**
 * Server settings.
 *
 * Owner-only, and the server enforces that independently - this dialog is only
 * reachable for an owner, but every endpoint it calls checks again.
 */
type Tab = 'overview' | 'ranks' | 'channels' | 'members' | 'bans' | 'invites';

export function ServerSettingsDialog({
  guildId,
  initialTab = 'overview',
  onClose,
}: {
  guildId: string;
  initialTab?: Tab;
  onClose(): void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const guilds = useApp((s) => s.guilds);
  const guild = guilds.find((g) => g.id === guildId);
  const { can } = usePermissions();

  // The server can be deleted from inside this dialog, or by another client.
  useEffect(() => {
    if (!guild) onClose();
  }, [guild, onClose]);

  // Only offer the sections this person can actually use. Every endpoint behind
  // them is checked again server-side.
  const tabs = ([
    ['overview', 'Overview'],
    can(Permission.MANAGE_RANKS) && ['ranks', 'Ranks'],
    can(Permission.MANAGE_CHANNELS) && ['channels', 'Channels'],
    ['members', 'Members'],
    can(Permission.BAN_MEMBERS) && ['bans', 'Bans'],
    can(Permission.CREATE_INVITE) && ['invites', 'Invites'],
  ].filter(Boolean) as Array<[Tab, string]>);

  // A tab can vanish underneath you if your ranks change while it is open.
  useEffect(() => {
    if (!tabs.some(([key]) => key === tab)) setTab('overview');
  }, [tabs, tab]);

  if (!guild) return null;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()} style={{ height: 560 }}>
        <div className="modal__head">
          <h2 className="modal__title">{guild.name}</h2>
          <p className="modal__sub">Server settings</p>
        </div>

        <div className="settings">
          <nav className="settings__rail">
            {tabs.map(([key, label]) => (
              <button
                key={key}
                className={`settings__tab ${tab === key ? 'settings__tab--active' : ''}`}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="settings__panel">
            {tab === 'overview' && <OverviewTab guildId={guildId} onClose={onClose} />}
            {tab === 'ranks' && <RanksTab guildId={guildId} />}
            {tab === 'channels' && <ChannelsTab guildId={guildId} />}
            {tab === 'members' && <MembersTab guildId={guildId} />}
            {tab === 'bans' && <BansTab guildId={guildId} />}
            {tab === 'invites' && <InvitesTab guildId={guildId} />}
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

function OverviewTab({ guildId, onClose }: { guildId: string; onClose(): void }) {
  const guild = useApp((s) => s.guilds.find((g) => g.id === guildId));
  const [name, setName] = useState(guild?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  if (!guild) return null;

  async function saveName() {
    setBusy(true);
    setError(null);
    try {
      await api.updateGuild(guildId, { name: name.trim() });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not rename the server');
    } finally {
      setBusy(false);
    }
  }

  async function pickIcon(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api.uploadGuildIcon(guildId, await prepareSquareImage(file));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not upload that image');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function deleteServer() {
    setBusy(true);
    try {
      await api.deleteGuild(guildId);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete the server');
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="notice" style={{ margin: '0 0 16px' }}>{error}</div>}

      <div className="section">
        <h3 className="section__title">Icon</h3>
        <div className="picker">
          <GuildBadge guild={guild} size={64} />
          <div className="picker__actions">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden-input"
              onChange={(e) => void pickIcon(e.target.files?.[0])}
            />
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              Upload an icon
            </button>
            <div className="field__hint">Square works best. Cropped to 256×256.</div>
          </div>
        </div>
      </div>

      <div className="section">
        <h3 className="section__title">Name</h3>
        <div className="inline-form">
          <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          <button
            className="btn btn--primary"
            disabled={busy || name.trim() === guild.name || name.trim().length < 2}
            onClick={() => void saveName()}
          >
            Rename
          </button>
        </div>
      </div>

      <div className="section">
        <h3 className="section__title">Delete this server</h3>
        <p className="row__hint" style={{ maxWidth: 'none', marginBottom: 12 }}>
          Every channel, message and invite goes with it, for everyone. This cannot be undone. Type{' '}
          <strong style={{ color: 'var(--text-primary)' }}>{guild.name}</strong> to confirm.
        </p>
        <div className="inline-form">
          <input
            value={confirmText}
            placeholder={guild.name}
            onChange={(e) => setConfirmText(e.target.value)}
          />
          <button
            className="btn btn--danger"
            disabled={busy || confirmText !== guild.name}
            onClick={() => void deleteServer()}
          >
            Delete server
          </button>
        </div>
      </div>
    </>
  );
}

function ChannelsTab({ guildId }: { guildId: string }) {
  const channels = useApp((s) => s.channels);
  const [creating, setCreating] = useState<'text' | 'voice' | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [accessFor, setAccessFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useMemo(
    () =>
      [...channels.values()]
        .filter((c) => c.guildId === guildId)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [channels, guildId],
  );

  const text = list.filter((c) => c.kind === 'text');
  const voice = list.filter((c) => c.kind === 'voice');

  async function move(channel: Channel, direction: -1 | 1) {
    const siblings = list.filter((c) => c.kind === channel.kind);
    const index = siblings.findIndex((c) => c.id === channel.id);
    const target = siblings[index + direction];
    if (!target) return;

    // Reorder within the kind, then send the whole guild's order so positions
    // stay globally consistent rather than two groups fighting over the same
    // integers.
    const reordered = [...siblings];
    reordered.splice(index, 1);
    reordered.splice(index + direction, 0, channel);
    const other = list.filter((c) => c.kind !== channel.kind);
    const order =
      channel.kind === 'text'
        ? [...reordered, ...other].map((c) => c.id)
        : [...other, ...reordered].map((c) => c.id);

    try {
      await api.reorderChannels(guildId, order);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reorder channels');
    }
  }

  async function remove(channel: Channel) {
    setError(null);
    try {
      await api.deleteChannel(channel.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete that channel');
    }
  }

  function renderGroup(kind: 'text' | 'voice', items: Channel[]) {
    return (
      <div className="section">
        <h3 className="section__title" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>{kind} channels</span>
          <button className="linkish" style={{ fontSize: 11 }} onClick={() => setCreating(kind)}>
            + Add
          </button>
        </h3>

        <div className="list">
          {items.map((channel, index) => (
            <div key={channel.id} className="list__row">
              <span className="chan__glyph">{kind === 'text' ? '#' : '♪'}</span>
              <div className="list__main">
                <div className="list__name">{channel.name}</div>
                <div className="list__meta">
                  {channel.topic ? channel.topic : kind === 'voice' ? (channel.userLimit > 0 ? `limit ${channel.userLimit}` : 'no limit') : 'no topic'}
                </div>
              </div>
              <div className="list__actions">
                <button
                  className="icon-btn"
                  disabled={index === 0}
                  onClick={() => void move(channel, -1)}
                  title="Move up"
                  style={{ opacity: index === 0 ? 0.3 : 1 }}
                >
                  ↑
                </button>
                <button
                  className="icon-btn"
                  disabled={index === items.length - 1}
                  onClick={() => void move(channel, 1)}
                  title="Move down"
                  style={{ opacity: index === items.length - 1 ? 0.3 : 1 }}
                >
                  ↓
                </button>
                <button className="icon-btn" onClick={() => setEditing(channel.id)} title="Edit">
                  ✎
                </button>
                <button
                  className="icon-btn"
                  onClick={() => setAccessFor(channel.id)}
                  title="Who can use this channel"
                >
                  ⚿
                </button>
                <button
                  className="icon-btn icon-btn--danger"
                  onClick={() => void remove(channel)}
                  title={items.length <= 1 ? 'A server needs at least one' : 'Delete'}
                  disabled={items.length <= 1}
                  style={{ opacity: items.length <= 1 ? 0.3 : 1 }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const editingChannel = editing ? channels.get(editing) : undefined;
  const accessChannel = accessFor ? channels.get(accessFor) : undefined;

  return (
    <>
      {error && <div className="notice" style={{ margin: '0 0 16px' }}>{error}</div>}
      {renderGroup('text', text)}
      {renderGroup('voice', voice)}

      {creating && (
        <CreateChannelDialog guildId={guildId} kind={creating} onClose={() => setCreating(null)} />
      )}
      {editingChannel && (
        <EditChannelDialog channel={editingChannel} onClose={() => setEditing(null)} />
      )}
      {accessChannel && (
        <ChannelAccessDialog channel={accessChannel} onClose={() => setAccessFor(null)} />
      )}
    </>
  );
}

function EditChannelDialog({ channel, onClose }: { channel: Channel; onClose(): void }) {
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [userLimit, setUserLimit] = useState(channel.userLimit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateChannel(channel.id, {
        name: name.trim(),
        topic: topic.trim() || null,
        ...(channel.kind === 'voice' ? { userLimit } : {}),
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the channel');
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Edit {channel.name}</h2>
        </div>
        <div className="modal__body">
          <div className="field">
            <label className="field__label" htmlFor="edit-channel-name">
              Name
            </label>
            <input id="edit-channel-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            {error && <div className="field__error">{error}</div>}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="edit-channel-topic">
              Topic
            </label>
            <input
              id="edit-channel-topic"
              value={topic}
              placeholder="What is this channel for?"
              onChange={(e) => setTopic(e.target.value)}
            />
          </div>
          {channel.kind === 'voice' && (
            <div className="field">
              <label className="field__label" htmlFor="edit-channel-limit">
                User limit
              </label>
              <input
                id="edit-channel-limit"
                type="number"
                min={0}
                max={99}
                value={userLimit}
                onChange={(e) => setUserLimit(Number(e.target.value))}
              />
              <div className="field__hint">0 means anyone can join, however many.</div>
            </div>
          )}
        </div>
        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
