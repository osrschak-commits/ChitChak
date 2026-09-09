import { useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Reporting a message, or a person.
 *
 * The only route into platform moderation that an ordinary account has. Before
 * it, the only remedies were inside a server and held by that server's own
 * owner, which is no help at all when the owner is the problem.
 *
 * Two deliberate omissions:
 *
 * There are no canned categories to pick from. A dropdown of reasons is faster
 * to file and much worse to read - "harassment" tells an operator nothing they
 * can act on, and the sentence somebody would have typed instead is the whole
 * value of the report.
 *
 * Nothing is promised about what happens next, and nothing is reported back
 * later. What happens is about somebody else's account, and telling the
 * reporter would be telling one user about another user's punishment.
 */
export function ReportDialog({
  subject,
  messageId,
  quoted,
  onClose,
}: {
  /** Username of the person being reported, for the heading. */
  subject: string;
  /** The message, when reporting one rather than a person. */
  messageId?: string;
  /** Shown back so it is obvious which message this is about. */
  quoted?: string;
  onClose(): void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.fileReport({
        ...(messageId ? { messageId } : { username: subject }),
        reason: reason.trim(),
      });
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not send');
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="scrim" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal__head">
            <h2 className="modal__title">Sent</h2>
            <p className="modal__sub">
              An operator will read it. You will not hear back about what happens - what
              happens is about someone else&rsquo;s account.
            </p>
          </div>
          <div className="modal__foot">
            <button className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Report {subject}</h2>
          <p className="modal__sub">
            This goes to whoever runs ChitChak, not to the server it happened in.
          </p>
        </div>

        <div className="modal__body">
          {/* The message is shown back rather than only referenced, so nobody
              reports the wrong one from a list of near-identical lines. It is
              labelled because a bordered box of text directly above a textarea
              otherwise reads as a filled-in field. */}
          {quoted && (
            <div className="report__quoted">
              <span className="report__quote-label mono">The message</span>
              <blockquote className="report__quote">{quoted}</blockquote>
            </div>
          )}

          <div className="field">
            <label className="field__label" htmlFor="report-reason">
              What is wrong with it?
            </label>
            <textarea
              id="report-reason"
              className="field__area"
              value={reason}
              autoFocus
              disabled={busy}
              rows={4}
              maxLength={1000}
              placeholder="What happened, and where. Anything an operator would need to know who has not seen it."
              onChange={(e) => setReason(e.target.value)}
            />
            {error && <div className="field__error">{error}</div>}
          </div>
        </div>

        <div className="modal__foot">
          <button className="btn btn--ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || reason.trim().length < 5}
            onClick={() => void submit()}
          >
            {busy ? 'Sending…' : 'Send report'}
          </button>
        </div>
      </div>
    </div>
  );
}
