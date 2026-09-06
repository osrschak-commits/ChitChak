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
  const [mode, setMode] = useState<'login' | 'register'>('login');
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

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={submit}>
        <div className="auth__mark">CHITCHAK</div>
        <h1 className="auth__title">{isRegister ? 'Set up your profile' : 'Welcome back'}</h1>
        <p className="auth__sub">
          {isRegister
            ? 'Pick a name people will recognise. You can change all of this later.'
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
          ) : (
            isRegister && <div className="field__hint">At least 10 characters.</div>
          )}
        </div>

        <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
        </button>

        <div className="auth__switch">
          {isRegister ? 'Already have an account? ' : 'New here? '}
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setMode(isRegister ? 'login' : 'register');
              setFormError(null);
              setFieldErrors({});
            }}
          >
            {isRegister ? 'Sign in' : 'Create one'}
          </button>
        </div>
      </form>
    </div>
  );
}
