import { Fragment, useEffect, useRef, useState } from 'react';
import { Permission } from '@chitchak/protocol';
import { usePermissions } from '../hooks/usePermissions.js';
import { usePersonPopover } from '../hooks/usePersonPopover.js';
import { rememberEmoji } from '../lib/emoji.js';
import { EmojiPicker } from './EmojiPicker.js';
import { SearchPanel } from './SearchPanel.js';
import { useApp } from '../store/app.js';
import { Avatar, MemberName } from './primitives.js';

/**
 * The main pane: the live call strip on top, then the selected text channel.
 *
 * Both are visible at once on purpose - being in a call and reading a channel
 * are not modes to switch between.
 */
const GROUPING_WINDOW_MS = 5 * 60 * 1000;

/** The calendar day something happened on, in local time. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * How a day is named in the separator.
 *
 * "Today" and "Yesterday" because that is what people call them, and a weekday
 * for the rest of the week because "Tuesday" locates a conversation better than
 * a number does. Older than that and the date is the only thing that helps.
 */
function dayLabel(date: Date): string {
  const now = new Date();
  const today = dayKey(now);
  if (dayKey(date) === today) return 'Today';

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';

  const sameYear = date.getFullYear() === now.getFullYear();
  const withinWeek = now.getTime() - date.getTime() < 6 * 86_400_000;

  return date.toLocaleDateString([], {
    weekday: withinWeek ? 'long' : undefined,
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
  });
}

/** The full thing, for the tooltip on a timestamp. */
function fullStamp(date: Date): string {
  return date.toLocaleString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChatPanel({ onEditProfile }: { onEditProfile(): void }) {
  const channels = useApp((s) => s.channels);
  const selectedGuildChannelId = useApp((s) => s.selectedTextChannelId);
  const selectedDmChannelId = useApp((s) => s.selectedDmChannelId);
  const scope = useApp((s) => s.scope);
  const dmChannels = useApp((s) => s.dmChannels);
  const people = useApp((s) => s.people);

  /**
   * The channel being read, from whichever surface is open.
   *
   * A DM and a guild channel are the same kind of thing to everything below
   * this line - the difference is only which selection points at it.
   */
  const selectedTextChannelId =
    scope === 'friends' ? selectedDmChannelId : selectedGuildChannelId;
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
  const self = useApp((s) => s.user);
  const { canInChannel, resolve } = usePermissions();

  const [draft, setDraft] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const composerRef = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const person = usePersonPopover(selectedGuildId, { onEditProfile });

  const channel = selectedTextChannelId ? channels.get(selectedTextChannelId) : undefined;
  const history = selectedTextChannelId ? (messages.get(selectedTextChannelId) ?? []) : [];

  const isDm = Boolean(selectedTextChannelId && dmChannels.has(selectedTextChannelId));

  /**
   * What to call the open channel.
   *
   * A DM's stored name is a placeholder - the conversation is named by the
   * other person, whose display name is theirs to change.
   */
  const dmPartner = selectedTextChannelId
    ? people.get(dmChannels.get(selectedTextChannelId) ?? '')
    : undefined;
  const title = isDm ? (dmPartner?.displayName ?? 'Conversation') : (channel?.name ?? '');

  const [searching, setSearching] = useState(false);

  // Ctrl+F is what people press. Closing again is Escape, handled in the panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A search is about the channel it was opened in; carrying it to the next one
  // would show results from a conversation you are no longer looking at.
  useEffect(() => {
    setSearching(false);
  }, [channel?.id]);

  // Ranks and overwrites do not exist in a DM. You may always write in one -
  // the server checks the friendship - and you may only delete your own, which
  // is what MANAGE_MESSAGES being false already means here.
  const mayManageMessages = isDm
    ? false
    : selectedTextChannelId
    ? canInChannel(selectedTextChannelId, Permission.MANAGE_MESSAGES)
    : false;
  const maySend = isDm
    ? true
    : selectedTextChannelId
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
            {isDm ? '◈' : '#'}
          </span>
          <span className="pane__title">{title}</span>
          {!isDm && channel.topic && <span className="pane__topic">{channel.topic}</span>}
          {isDm && dmPartner && <span className="pane__topic mono">{dmPartner.username}</span>}

          <button
            className="pane__search"
            onClick={() => setSearching((open) => !open)}
            aria-pressed={searching}
            title="Search this channel (Ctrl+F)"
          >
            Search
          </button>
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

      {channel && searching && (
        <SearchPanel
          channelId={channel.id}
          channelName={title}
          onClose={() => setSearching(false)}
        />
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
                  <h2 className="empty__title">{isDm ? title : `#${channel.name}`}</h2>
                  <p className="empty__body">
                    {isDm
                      ? `This is the start of your conversation with ${title}. Only the two of you can see it.`
                      : (channel.topic ?? 'This is the beginning of the channel. Say something.')}
                  </p>
                </div>
              </div>
            )}

            {history.map((message, index) => {
              const previous = history[index - 1];
              const author = members.get(`${selectedGuildId}:${message.authorId}`);
              // A DM has no guild membership to look an author up in, so the
              // profile comes from the people the friends list already knows -
              // or from `user`, since one of the two is always you.
              const authorProfile =
                author?.user ??
                (message.authorId === selfId ? self : undefined) ??
                people.get(message.authorId);
              const name = author?.nickname ?? authorProfile?.displayName ?? 'Unknown';
              const time = new Date(message.createdAt);
              // A new day always starts a fresh block. The grouping window is
              // five minutes, which straddles midnight perfectly happily -
              // without this, the first message of a day can hide under the
              // previous day's name with nothing to say the date changed.
              const newDay =
                previous === undefined || dayKey(new Date(previous.createdAt)) !== dayKey(time);
              const grouped =
                !newDay &&
                previous !== undefined &&
                previous.authorId === message.authorId &&
                Date.parse(message.createdAt) - Date.parse(previous.createdAt) < GROUPING_WINDOW_MS;
              const isAuthor = message.authorId === selfId;

              return (
                <Fragment key={message.id}>
                {newDay && (
                  <div className="daybreak" role="separator">
                    <span className="daybreak__label mono">{dayLabel(time)}</span>
                  </div>
                )}
                <div className={`msg ${grouped ? 'msg--grouped' : ''}`}>
                  <div className="msg__gutter">
                    {grouped ? (
                      <span className="msg__stamp" title={fullStamp(time)}>
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
                            authorProfile ?? {
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
                        <time
                          className="msg__time"
                          dateTime={message.createdAt}
                          title={fullStamp(time)}
                        >
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
                </Fragment>
              );
            })}
          </div>

          <div className="composer">
            {emojiOpen && (
              <EmojiPicker
                onClose={() => setEmojiOpen(false)}
                onPick={(emoji) => {
                  rememberEmoji(emoji.char);
                  /*
                    Inserted where the caret is, not appended. Someone who
                    clicked back into the middle of a sentence to add a reaction
                    to a word meant it to go there, and a picker that always
                    appends quietly makes that impossible.

                    The caret is read from the input rather than tracked in
                    state: focus moved to the picker's search box, but an input
                    keeps its selection while blurred, so this is still the
                    position the person left.
                  */
                  const field = composerRef.current;
                  const at = field?.selectionStart ?? draft.length;
                  const to = field?.selectionEnd ?? at;
                  const next = draft.slice(0, at) + emoji.char + draft.slice(to);
                  if (next.length > 4000) return;

                  setDraft(next);
                  setEmojiOpen(false);
                  // After the state has landed, so the caret is set on text
                  // that exists - and left after the emoji, ready to keep
                  // typing.
                  requestAnimationFrame(() => {
                    const caret = at + emoji.char.length;
                    field?.focus();
                    field?.setSelectionRange(caret, caret);
                  });
                }}
              />
            )}

            <div className="composer__field">
            <input
              ref={composerRef}
              value={draft}
              disabled={!maySend}
              placeholder={
                maySend
                  ? isDm
                    ? `Message ${title}`
                    : `Message #${channel.name}`
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
            <button
              type="button"
              className="composer__emoji"
              disabled={!maySend}
              aria-expanded={emojiOpen}
              title="Emoji"
              aria-label="Emoji"
              onClick={() => setEmojiOpen((open) => !open)}
            >
              🙂
            </button>
            </div>

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
