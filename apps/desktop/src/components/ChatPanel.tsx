import { useEffect, useRef, useState } from 'react';
import { Permission } from '@chitchak/protocol';
import { usePermissions } from '../hooks/usePermissions.js';
import { usePersonPopover } from '../hooks/usePersonPopover.js';
import { useApp } from '../store/app.js';
import { Avatar, MemberName } from './primitives.js';

/**
 * The main pane: the live call strip on top, then the selected text channel.
 *
 * Both are visible at once on purpose - being in a call and reading a channel
 * are not modes to switch between.
 */
const GROUPING_WINDOW_MS = 5 * 60 * 1000;

export function ChatPanel({ onEditProfile }: { onEditProfile(): void }) {
  const channels = useApp((s) => s.channels);
  const selectedTextChannelId = useApp((s) => s.selectedTextChannelId);
  const selectedGuildId = useApp((s) => s.selectedGuildId);
  const messages = useApp((s) => s.messages);
  const members = useApp((s) => s.members);
  const sendMessage = useApp((s) => s.sendMessage);
  const editMessage = useApp((s) => s.editMessage);
  const deleteMessage = useApp((s) => s.deleteMessage);
  const voiceError = useApp((s) => s.voiceError);
  const dismissVoiceError = useApp((s) => s.dismissVoiceError);
  const guilds = useApp((s) => s.guilds);
  const selfId = useApp((s) => s.user?.id);
  const { canInChannel, resolve } = usePermissions();

  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const person = usePersonPopover(selectedGuildId, { onEditProfile });

  const channel = selectedTextChannelId ? channels.get(selectedTextChannelId) : undefined;
  const history = selectedTextChannelId ? (messages.get(selectedTextChannelId) ?? []) : [];

  const mayManageMessages = selectedTextChannelId
    ? canInChannel(selectedTextChannelId, Permission.MANAGE_MESSAGES)
    : false;
  const maySend = selectedTextChannelId
    ? canInChannel(selectedTextChannelId, Permission.SEND_MESSAGES)
    : false;

  // Follow the conversation, but only when the reader is already at the bottom.
  // Yanking someone away from history they are reading is worse than a missed
  // scroll.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom < 160) element.scrollTop = element.scrollHeight;
  }, [history.length]);

  function submit() {
    if (!draft.trim() || !selectedTextChannelId) return;
    sendMessage(selectedTextChannelId, draft);
    setDraft('');
  }

  return (
    <main className="pane">
      {channel ? (
        <header className="pane__header">
          <span className="chan__glyph" aria-hidden="true">
            #
          </span>
          <span className="pane__title">{channel.name}</span>
          {channel.topic && <span className="pane__topic">{channel.topic}</span>}
        </header>
      ) : (
        <header className="pane__header">
          <span className="pane__title">ChitChak</span>
        </header>
      )}

      {voiceError && (
        <div className="notice">
          <span>{voiceError}</span>
          <button onClick={dismissVoiceError} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {!channel ? (
        <div className="empty">
          <div className="empty__inner">
            <h2 className="empty__title">
              {guilds.length === 0 ? 'No servers yet' : 'No channel selected'}
            </h2>
            <p className="empty__body">
              {guilds.length === 0
                ? 'Create a server from the switcher at the top, or join one with an invite code.'
                : 'Pick a text channel on the left, or drop straight into voice.'}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="messages" ref={scrollRef}>
            {history.length === 0 && (
              <div className="empty">
                <div className="empty__inner">
                  <h2 className="empty__title">#{channel.name}</h2>
                  <p className="empty__body">
                    {channel.topic ?? 'This is the beginning of the channel. Say something.'}
                  </p>
                </div>
              </div>
            )}

            {history.map((message, index) => {
              const previous = history[index - 1];
              const author = members.get(`${selectedGuildId}:${message.authorId}`);
              const name = author?.nickname ?? author?.user.displayName ?? 'Unknown';
              const grouped =
                previous !== undefined &&
                previous.authorId === message.authorId &&
                Date.parse(message.createdAt) - Date.parse(previous.createdAt) < GROUPING_WINDOW_MS;
              const time = new Date(message.createdAt);
              const isAuthor = message.authorId === selfId;

              return (
                <div key={message.id} className={`msg ${grouped ? 'msg--grouped' : ''}`}>
                  <div className="msg__gutter">
                    {grouped ? (
                      <span className="msg__stamp">
                        {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    ) : (
                      <span
                        className="clickable-name"
                        {...person.bind(message.authorId)}
                        title={`${name} — click for profile, right-click to moderate`}
                      >
                        <Avatar
                          user={
                            author?.user ?? {
                              id: message.authorId,
                              displayName: name,
                              avatarUrl: null,
                              accentColor: null,
                            }
                          }
                          size={34}
                        />
                      </span>
                    )}
                  </div>
                  <div className="msg__body">
                    {!grouped && (
                      <div className="msg__meta">
                        <MemberName
                          className="msg__author clickable-name"
                          name={name}
                          color={resolve(message.authorId).color}
                          {...person.bind(message.authorId)}
                          title={`${name} — click for profile, right-click to moderate`}
                        />
                        <time className="msg__time" dateTime={message.createdAt}>
                          {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </time>
                      </div>
                    )}

                    {editingId === message.id ? (
                      <MessageEditor
                        initial={message.content}
                        onCancel={() => setEditingId(null)}
                        onSave={async (content) => {
                          await editMessage(message.id, content);
                          setEditingId(null);
                        }}
                      />
                    ) : (
                      <div className="msg__text">
                        {message.content}
                        {message.editedAt && (
                          <span className="msg__edited" title={new Date(message.editedAt).toLocaleString()}>
                            edited
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {editingId !== message.id && (isAuthor || mayManageMessages) && (
                    <div className="msg__actions">
                      {isAuthor && (
                        <button
                          className="icon-btn"
                          style={{ width: 24, height: 24 }}
                          onClick={() => setEditingId(message.id)}
                          title="Edit"
                        >
                          ✎
                        </button>
                      )}
                      <button
                        className="icon-btn icon-btn--danger"
                        style={{ width: 24, height: 24 }}
                        onClick={() => void deleteMessage(message.id)}
                        title="Delete"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="composer">
            <input
              value={draft}
              disabled={!maySend}
              placeholder={
                maySend
                  ? `Message #${channel.name}`
                  : 'Your rank cannot send messages in this channel'
              }
              maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="composer__hint">
              {draft.length > 3600 ? `${4000 - draft.length} characters left` : ''}
            </div>
          </div>
        </>
      )}

      {person.popovers}
    </main>
  );
}

/** Inline editor. Enter saves, Escape cancels - the shortcuts people expect. */
function MessageEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave(content: string): Promise<void>;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(value);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="msg__editor">
      <input
        value={value}
        autoFocus
        maxLength={4000}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <span className="msg__editor-hint">Enter to save · Escape to cancel</span>
    </div>
  );
}
