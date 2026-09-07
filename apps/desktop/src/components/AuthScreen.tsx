import { useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, api, serverHost } from '../lib/api.js';

/**
 * Sign in / sign up.
 *
 * Server-side validation errors are mapped back onto the fields that caused
 * them, so "password too short" appears under the password box rather than as a
 * banner the user has to reconcile with the form themselves.
 */
export function AuthScreen({ onAuthenticated }: { onAuthenticated(): void }) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  /** Set once a reset email has been requested, replacing the form with advice. */
  const [resetRequested, setResetRequested] = useState(false);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [signupCode, setSignupCode] = useState('');
  /**
   * Assume a code is needed until the server says otherwise. Guessing the other
   * way would hide the field on a slow connection and produce a rejected
   * sign-up with no visible cause.
   */
  const [signupCodeRequired, setSignupCodeRequired] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';
  const isForgot = mode === 'forgot';

  /** Switching modes should not carry the previous one's errors with it. */
  function goTo(next: 'login' | 'register' | 'forgot') {
    setMode(next);
    setFormError(null);
    setFieldErrors({});
    setResetRequested(false);
  }

  useEffect(() => {
    api
      .serverConfig()
      .then((config) => setSignupCodeRequired(config.signupCodeRequired))
      // If the server cannot be reached, leave the field showing: a wrong guess
      // that shows it is recoverable, one that hides it is not.
      .catch(() => setSignupCodeRequired(true));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    setFieldErrors({});

    try {
      if (isForgot) {
        await api.requestPasswordReset(email);
        // Deliberately shown whether or not that address has an account: the
        // server will not say, and neither will this.
        setResetRequested(true);
        return;
      }

      if (isRegister) {
        await api.register({
          email,
          username,
          password,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          ...(signupCode.trim() ? { signupCode: signupCode.trim() } : {}),
        });
      } else {
        await api.login(email, password);
      }
      onAuthenticated();
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setFieldErrors(error.details ?? {});
        // A 422 with per-field details is fully explained inline; anything else
        // needs the summary line.
        if (!error.details) setFormError(error.message);
      } else {
        setFormError(`Could not reach ${serverHost()}. Check your connection and try again.`);
      }
    } finally {
      setBusy(false);
    }
  }

  // Shown instead of the form once a link has been asked for, because there is
  // nothing else useful to do on this screen until the email arrives.
  if (resetRequested) {
    return (
      <div className="auth">
        <div className="auth__card">
          <div className="auth__mark">CHITCHAK</div>
          <h1 className="auth__title">Check your email</h1>
          <p className="auth__sub">
            If <strong>{email}</strong> has an account, a link to choose a new password is on its
            way. It works once and expires within the hour.
          </p>
          <p className="auth__sub">
            The link opens in your browser. Once you have set a new password, come back here and
            sign in with it.
          </p>
          <button className="btn btn--primary btn--block" type="button" onClick={() => goTo('login')}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={submit}>
        <div className="auth__mark">CHITCHAK</div>
        <h1 className="auth__title">
          {isRegister ? 'Set up your profile' : isForgot ? 'Reset your password' : 'Welcome back'}
        </h1>
        <p className="auth__sub">
          {isRegister
            ? 'Pick a name people will recognise. You can change all of this later.'
            : isForgot
              ? 'Enter the address you signed up with and we will email you a link.'
              : 'Sign in to rejoin your servers.'}
        </p>

        {formError && <div className="notice" style={{ margin: '0 0 16px' }}>{formError}</div>}

        <div className="field">
          <label className="field__label" htmlFor="auth-email">
            Email
          </label>
          <input
            id="auth-email"
            type="email"
            value={email}
            autoComplete="email"
            autoFocus
            required
            onChange={(e) => setEmail(e.target.value)}
          />
          {fieldErrors.email && <div className="field__error">{fieldErrors.email}</div>}
        </div>

        {isRegister && (
          <>
            {/* Shown only when this server actually requires one, so nobody is
                left guessing whether to fill it in. */}
            {signupCodeRequired && (
              <div className="field">
                <label className="field__label" htmlFor="auth-signup-code">
                  Signup code
                </label>
                <input
                  id="auth-signup-code"
                  value={signupCode}
                  autoComplete="off"
                  required
                  autoFocus
                  placeholder="e.g. amber-otter-1234"
                  onChange={(e) => setSignupCode(e.target.value)}
                />
                {fieldErrors.signupCode ? (
                  <div className="field__error">{fieldErrors.signupCode}</div>
                ) : (
                  <div className="field__hint">
                    This server is invite-only. Ask whoever runs it for the code.
                  </div>
                )}
              </div>
            )}

            <div className="field">
              <label className="field__label" htmlFor="auth-display">
                Display name
              </label>
              <input
                id="auth-display"
                value={displayName}
                maxLength={48}
                placeholder="What people call you"
                onChange={(e) => setDisplayName(e.target.value)}
              />
              {fieldErrors.displayName && <div className="field__error">{fieldErrors.displayName}</div>}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="auth-username">
                Username
              </label>
              <input
                id="auth-username"
                value={username}
                autoComplete="username"
                required
                maxLength={32}
                placeholder="lowercase-handle"
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s+/g, ''))}
              />
              {fieldErrors.username ? (
                <div className="field__error">{fieldErrors.username}</div>
              ) : (
                <div className="field__hint">Lowercase letters, digits, dot, underscore, hyphen.</div>
              )}
            </div>
          </>
        )}

        {!isForgot && (
          <div className="field">
            <label className="field__label" htmlFor="auth-password">
              Password
            </label>
            <input
              id="auth-password"
              type="password"
              value={password}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              required
              onChange={(e) => setPassword(e.target.value)}
            />
            {fieldErrors.password ? (
              <div className="field__error">{fieldErrors.password}</div>
            ) : isRegister ? (
              <div className="field__hint">At least 10 characters.</div>
            ) : (
              <button type="button" className="linkish field__hint" onClick={() => goTo('forgot')}>
                Forgot your password?
              </button>
            )}
          </div>
        )}

        <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
          {busy
            ? 'Please wait…'
            : isRegister
              ? 'Create account'
              : isForgot
                ? 'Email me a link'
                : 'Sign in'}
        </button>

        <div className="auth__switch">
          {isForgot ? (
            <>
              {'Remembered it? '}
              <button type="button" className="linkish" onClick={() => goTo('login')}>
                Sign in
              </button>
            </>
          ) : (
            <>
              {isRegister ? 'Already have an account? ' : 'New here? '}
              <button
                type="button"
                className="linkish"
                onClick={() => goTo(isRegister ? 'login' : 'register')}
              >
                {isRegister ? 'Sign in' : 'Create one'}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
