import { useState, type FormEvent } from 'react';
import { ApiRequestError, api, serverHost } from '../lib/api.js';

/**
 * Where an emailed reset link lands.
 *
 * Shown instead of everything else when a token is present, signed in or not -
 * someone resetting a password may well be doing it because they think someone
 * else is in the account, and the reset revokes every session including this
 * one. Finishing here therefore always ends at the sign-in screen.
 */
export function ResetPasswordScreen({
  token,
  onDone,
}: {
  token: string;
  onDone(): void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();

    // Checked here rather than server-side: the server has no idea what was
    // typed twice, and a round trip to say "these do not match" is a round trip
    // wasted.
    if (password !== confirm) {
      setFieldErrors({ confirm: 'Those two do not match' });
      return;
    }

    setBusy(true);
    setFormError(null);
    setFieldErrors({});

    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setFieldErrors(error.details ?? {});
        if (!error.details) setFormError(error.message);
      } else {
        setFormError(`Could not reach ${serverHost()}. Check your connection and try again.`);
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="auth">
        <div className="auth__card">
          <div className="auth__mark">CHITCHAK</div>
          <h1 className="auth__title">Password changed</h1>
          <p className="auth__sub">
            Everywhere you were signed in has been signed out, including the desktop app. Sign in
            again with your new password.
          </p>
          <button className="btn btn--primary btn--block" type="button" onClick={onDone}>
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={submit}>
        <div className="auth__mark">CHITCHAK</div>
        <h1 className="auth__title">Choose a new password</h1>
        <p className="auth__sub">
          This link works once. Setting a password here signs out every device you are signed in
          on.
        </p>

        {formError && (
          <div className="notice" style={{ margin: '0 0 16px' }}>
            {formError}
            <div style={{ marginTop: 10 }}>
              <button type="button" className="linkish" onClick={onDone}>
                Back to sign in
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <label className="field__label" htmlFor="reset-password">
            New password
          </label>
          <input
            id="reset-password"
            type="password"
            value={password}
            autoComplete="new-password"
            autoFocus
            required
            onChange={(e) => setPassword(e.target.value)}
          />
          {fieldErrors.password ? (
            <div className="field__error">{fieldErrors.password}</div>
          ) : (
            <div className="field__hint">At least 10 characters.</div>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="reset-confirm">
            Confirm new password
          </label>
          <input
            id="reset-confirm"
            type="password"
            value={confirm}
            autoComplete="new-password"
            required
            onChange={(e) => setConfirm(e.target.value)}
          />
          {fieldErrors.confirm && <div className="field__error">{fieldErrors.confirm}</div>}
        </div>

        <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : 'Set new password'}
        </button>

        <div className="auth__switch">
          <button type="button" className="linkish" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * What was in the URL when the page loaded, resolved at most once.
 *
 * `undefined` means "not looked yet"; null means "looked, nothing there".
 */
let cachedToken: string | null | undefined;

/**
 * Pulls a reset token out of the URL and removes it from the address bar.
 *
 * The token arrives in the fragment (`#reset=…`) rather than the query string,
 * so it is never sent to a server or leaked in a Referer header. Clearing it
 * immediately keeps it out of the address bar and out of browser history; the
 * caller holds it in memory for as long as the form is open.
 *
 * The answer is cached because reading it is destructive, and something that
 * cannot survive being called twice does not belong in a React state
 * initialiser - StrictMode invokes those twice on purpose, and the second call
 * would find the hash it had just deleted and report no token at all.
 */
export function takeResetTokenFromUrl(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = readResetTokenFromUrl();
  return cachedToken;
}

function readResetTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null;

  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;

  const token = new URLSearchParams(hash).get('reset');
  if (!token) return null;

  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return token;
}
