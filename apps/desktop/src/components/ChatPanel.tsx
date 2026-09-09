import { Fragment, useEffect, useRef, useState } from 'react';
import { Permission } from '@chitchak/protocol';
import { usePermissions } from '../hooks/usePermissions.js';
import { usePersonPopover } from '../hooks/usePersonPopover.js';
import { uploadFile } from '../lib/api.js';
import { rememberEmoji } from '../lib/emoji.js';
import { MessageAttachments, PendingAttachments, type Pending } from './Attachments.js';
import { RichText } from './RichText.js';
import { EmojiPicker } from './EmojiPicker.js';
import { ReportDialog } from './ReportDialog.js';
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

/** Matches the server's cap, so the refusal happens before the upload. */
const MAX_ATTACHMENTS = 10;

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
  /** The message being reported, if any. Held here so the dialog outlives the hover. */
  const [reporting, setReporting] = useState<{
    subject: string;
    messageId: string;
    quoted: string;
  } | null>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);

  /**
   * Starts an upload per file and tracks it until it lands.
   *
   * Uploads run as soon as the file is chosen rather than on send, so the wait
   * happens while the message is still being typed. By the time Enter is
   * pressed the file is usually already there.
   */
  function stage(files: FileList | File[]): void {
    const chosen = [...files].slice(0, MAX_ATTACHMENTS - pending.length);
    for (const file of chosen) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;

      setPending((items) => [
        ...items,
        { key, name: file.name, bytes: file.size, progress: 0, preview },
      ]);

      void uploadFile(file, (fraction) => {
        setPending((items) =>
          items.map((item) => (item.key === key ? { ...item, progress: fraction } : item)),
        );
      })
        .then((attachment) => {
          setPending((items) =>
            items.map((item) => (item.key === key ? { ...item, attachment, progress: 1 } : item)),
          );
        })
        .catch((error: unknown) => {
          setPending((items) =>
            items.map((item) =>
              item.key === key
                ? { ...item, error: error instanceof Error ? error.message : 'Upload failed' }
                : item,
            ),
          );
        });
    }
  }

  /**
   * Puts text where the caret is, not at the end.
   *
   * The caret is read off the input rather than tracked in state: focus has by
   * now moved to the picker's search box, but an input keeps its selection
   * while blurred, so this is still where the person left it.
   */
  function insertAtCaret(text: string): void {
    const field = composerRef.current;
    const at = field?.selectionStart ?? draft.length;
    const to = field?.selectionEnd ?? at;
    const next = draft.slice(0, at) + text + draft.slice(to);
    if (next.length > 4000) return;

    setDraft(next);
    setEmojiOpen(false);
    // After the state has landed, so the caret is set on text that exists - and
    // left after what was inserted, ready to keep typing.
    requestAnimationFrame(() => {
      const caret = at + text.length;
      field?.focus();
      field?.setSelectionRange(caret, caret);
    });
  }

  function unstage(key: string): void {
    setPending((items) => {
      // Revoked here rather than on unmount: the blob is a real allocation, and
      // a long session of previewing and removing files would otherwise hold on
      // to every one of them.
      const going = items.find((item) => item.key === key);
      if (going?.preview) URL.revokeObjectURL(going.preview);
      return items.filter((item) => item.key !== key);
    });
  }
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
    if (!selectedTextChannelId) return;

    // Anything that failed is dropped rather than blocking the send; anything
    // still uploading holds the message, because sending now would silently
    // leave the file behind.
    const ready = pending.filter((item) => item.attachment);
    const busy = pending.some((item) => !item.attachment && !item.error);
    if (busy) return;
    if (!draft.trim() && ready.length === 0) return;

    sendMessage(
      selectedTextChannelId,
      draft,
      ready.map((item) => item.attachment!.id),
    );

    for (const item of pending) if (item.preview) URL.revokeObjectURL(item.preview);
    setPending([]);
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

      {reporting && (
        <ReportDialog
          subject={reporting.subject}
          messageId={reporting.messageId}
          quoted={reporting.quoted}
          onClose={() => setReporting(null)}
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
                      <>
                        {message.content && (
                          <div className="msg__text">
                            <RichText text={message.content} guildId={channel?.guildId ?? null} />
                            {message.editedAt && (
                              <span className="msg__edited" title={new Date(message.editedAt).toLocaleString()}>
                                edited
                              </span>
                            )}
                          </div>
                        )}
                        <MessageAttachments files={message.attachments ?? []} />
                      </>
                    )}
                  </div>

                  {editingId !== message.id && (
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
                      {/* Anyone can report anyone else. Reporting your own
                          message would do nothing, so it is not offered. */}
                      {!isAuthor && (
                        <button
                          className="icon-btn"
                          style={{ width: 24, height: 24 }}
                          onClick={() =>
                            setReporting({
                              subject: authorProfile?.username ?? name,
                              messageId: message.id,
                              quoted: message.content,
                            })
                          }
                          title="Report to ChitChak staff"
                        >
                          ⚑
                        </button>
                      )}
                      {(isAuthor || mayManageMessages) && (
                        <button
                          className="icon-btn icon-btn--danger"
                          style={{ width: 24, height: 24 }}
                          onClick={() => void deleteMessage(message.id)}
                          title="Delete"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  )}
                </div>
                </Fragment>
              );
            })}
          </div>

          <div
            className={`composer ${dragging ? 'composer--drop' : ''}`}
            /*
              The drop target is the composer rather than the whole pane. A drop
              anywhere in the window sounds friendlier until somebody drags an
              image onto the conversation to look at it and accidentally sends
              it to everyone.
            */
            onDragOver={(e) => {
              if (!maySend || !e.dataTransfer.types.includes('Files')) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              // Only when the pointer has actually left the composer, not when
              // it crosses onto a child, which fires dragleave just the same.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(e) => {
              if (!maySend) return;
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length > 0) stage(e.dataTransfer.files);
            }}
          >
            <PendingAttachments items={pending} onRemove={unstage} />

            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) stage(e.target.files);
                // Cleared so choosing the same file twice in a row still fires
                // a change event.
                e.target.value = '';
              }}
            />

            {emojiOpen && (
              <EmojiPicker
                onClose={() => setEmojiOpen(false)}
                guildId={channel?.guildId ?? null}
                // A custom emoji is inserted as `:name:`, the same thing
                // somebody would have typed - so the message keeps working if
                // the emoji is later removed.
                onPickCustom={(custom) => insertAtCaret(`:${custom.name}:`)}
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
                  insertAtCaret(emoji.char);
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
              onPaste={(e) => {
                // A screenshot on the clipboard arrives as a file with no name.
                const files = [...e.clipboardData.files];
                if (files.length > 0) {
                  e.preventDefault();
                  stage(files);
                }
              }}
            />

            <button
              type="button"
              className="composer__attach"
              disabled={!maySend || pending.length >= MAX_ATTACHMENTS}
              title={
                pending.length >= MAX_ATTACHMENTS
                  ? `A message can carry ${MAX_ATTACHMENTS} files`
                  : 'Attach a file'
              }
              aria-label="Attach a file"
              onClick={() => fileRef.current?.click()}
            >
              <PaperclipIcon />
            </button>
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

/**
 * A paperclip, drawn rather than the 📎 emoji.
 *
 * The emoji was the obvious thing and the wrong one: every platform draws it
 * differently, several draw it at an angle that reads as a stray mark at 16px,
 * and it renders in colour beside a row of monochrome controls. Drawn, it says
 * "attach" at any size and takes its colour from the button like every other
 * icon in the app.
 */
function PaperclipIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.5 7.2 7.7 12a2.9 2.9 0 0 1-4.1-4.1l5.2-5.2a1.9 1.9 0 0 1 2.7 2.7l-5.2 5.2a.9.9 0 0 1-1.3-1.3l4.6-4.6" />
    </svg>
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
