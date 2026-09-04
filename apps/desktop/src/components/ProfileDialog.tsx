import { useRef, useState } from 'react';
import { ApiRequestError, api } from '../lib/api.js';
import { prepareSquareImage } from '../lib/image.js';
import { useApp } from '../store/app.js';
import { Avatar } from './primitives.js';

/**
 * Your profile: the picture, name and handle other people see.
 *
 * Changes save on submit rather than per keystroke, so a half-typed username is
 * never broadcast to everyone in your servers.
 */

const ACCENTS = [
  '#c9954a',
  '#4fd6c4',
  '#8a7fd4',
  '#d97b6c',
  '#6ca9d9',
  '#b0c05f',
  '#d48fb8',
  '#9aa3ad',
];

export function ProfileDialog({ onClose }: { onClose(): void }) {
  const user = useApp((s) => s.user);
  const applySelfUser = useApp((s) => s.applySelfUser);
  const signOut = useApp((s) => s.signOut);

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [accentColor, setAccentColor] = useState(user?.accentColor ?? ACCENTS[0]!);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!user) return null;

  const dirty =
    displayName !== user.displayName ||
    username !== user.username ||
    bio !== (user.bio ?? '') ||
    accentColor !== (user.accentColor ?? ACCENTS[0]);

  async function save() {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const updated = await api.updateProfile({ displayName, username, bio, accentColor });
      applySelfUser(updated);
      setSavedAt(Date.now());
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        setFieldErrors(caught.details ?? {});
        if (!caught.details) setError(caught.message);
      } else {
        setError('Could not save your profile');
      }
    } finally {
      setBusy(false);
    }
  }

  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const dataUrl = await prepareSquareImage(file);
      applySelfUser(await api.uploadAvatar(dataUrl));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not upload that image');
    } finally {
      setBusy(false);
      // Clearing the input means picking the same file again still fires a
      // change event, which it otherwise would not.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function clearAvatar() {
    setBusy(true);
    try {
      applySelfUser(await api.removeAvatar());
    } catch {
      setError('Could not remove your picture');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Your profile</h2>
          <p className="modal__sub">This is what people see in your servers.</p>
        </div>

        <div className="modal__body">
          {error && <div className="notice">{error}</div>}

          <div className="section">
            <h3 className="section__title">Picture</h3>
            <div className="picker">
              <Avatar user={{ ...user, accentColor }} size={72} />
              <div className="picker__actions">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden-input"
                  onChange={(e) => void pickAvatar(e.target.files?.[0])}
                />
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  Upload a picture
                </button>
                {user.avatarUrl && (
                  <button className="linkish" disabled={busy} onClick={() => void clearAvatar()}>
                    Remove picture
                  </button>
                )}
                <div className="field__hint">Square works best. Cropped to 256×256.</div>
              </div>
            </div>
          </div>

          <div className="section">
            <h3 className="section__title">Identity</h3>

            <div className="field">
              <label className="field__label" htmlFor="profile-display">
                Display name
              </label>
              <input
                id="profile-display"
                value={displayName}
                maxLength={48}
                onChange={(e) => setDisplayName(e.target.value)}
              />
              {fieldErrors.displayName && <div className="field__error">{fieldErrors.displayName}</div>}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="profile-username">
                Username
              </label>
              <input
                id="profile-username"
                value={username}
                maxLength={32}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s+/g, ''))}
              />
              {fieldErrors.username ? (
                <div className="field__error">{fieldErrors.username}</div>
              ) : (
                <div className="field__hint">
                  Lowercase letters, digits, dot, underscore and hyphen. People find you by this.
                </div>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="profile-bio">
                About you
              </label>
              <textarea
                id="profile-bio"
                value={bio}
                maxLength={280}
                placeholder="A line or two about yourself."
                onChange={(e) => setBio(e.target.value)}
              />
              <div className="field__hint mono">{280 - bio.length} characters left</div>
            </div>
          </div>

          <div className="section">
            <h3 className="section__title">Accent</h3>
            <div className="row">
              <div>
                <div className="row__label">Your colour</div>
                <div className="row__hint">Used for your monogram when you have no picture.</div>
              </div>
              <div className="swatches row__control">
                {ACCENTS.map((color) => (
                  <button
                    key={color}
                    className="swatch"
                    style={{ background: color }}
                    aria-pressed={color === accentColor}
                    aria-label={`Accent ${color}`}
                    onClick={() => setAccentColor(color)}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="section">
            <h3 className="section__title">Account</h3>
            <div className="row">
              <div>
                <div className="row__label">{user.email}</div>
                <div className="row__hint">
                  Signing out clears this session on this computer.
                </div>
              </div>
              <button className="btn btn--danger btn--sm row__control" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </div>
        </div>

        <div className="modal__foot">
          {savedAt && !dirty && (
            <span className="legend" style={{ marginRight: 'auto' }}>
              Saved
            </span>
          )}
          <button className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn btn--primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
