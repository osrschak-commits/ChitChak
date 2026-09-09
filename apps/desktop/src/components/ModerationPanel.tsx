import { useEffect, useState } from 'react';
import { api, type QueuedReport, type SuspendedAccount } from '../lib/api.js';

/**
 * The report queue, and the accounts currently locked out.
 *
 * Sits above the black card section in the staff tab because it is the thing
 * you open the panel to look at. A card is something you give when you feel
 * like it; a report is somebody waiting.
 *
 * Every refusal here is enforced again on the server. Hiding the panel from
 * people who are not staff is a courtesy, not the control.
 */
export function ModerationPanel() {
  const [reports, setReports] = useState<QueuedReport[]>([]);
  const [open, setOpen] = useState(0);
  const [locked, setLocked] = useState<SuspendedAccount[]>([]);
  const [showHandled, setShowHandled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function refresh() {
    void api
      .listReports()
      .then((result) => {
        setReports(result.reports);
        setOpen(result.open);
      })
      .catch(() => setReports([]));
    void api
      .listSuspended()
      .then((result) => setLocked(result.accounts))
      .catch(() => setLocked([]));
  }

  useEffect(refresh, []);

  async function act(key: string, work: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      setNote(await work());
      refresh();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work');
    } finally {
      setBusy(null);
    }
  }

  const shown = showHandled ? reports : reports.filter((entry) => entry.status === 'open');

  return (
    <>
      <div className="section">
        <h3 className="section__title">
          Reports{open > 0 && <span className="staff__count mono">{open} open</span>}
        </h3>
        <p className="row__hint" style={{ marginBottom: 12, maxWidth: 440 }}>
          Raised by people who could not get help inside the server it happened in. The quoted
          message is a copy taken when it was reported, so it survives being deleted.
        </p>

        {error && <div className="notice" style={{ marginBottom: 12 }}>{error}</div>}
        {note && <p className="row__hint" style={{ marginBottom: 12 }}>{note}</p>}

        {shown.length === 0 ? (
          <p className="empty__body">{showHandled ? 'Nothing here yet.' : 'Nothing waiting.'}</p>
        ) : (
          <div className="reports">
            {shown.map((entry) => (
              <ReportRow key={entry.id} report={entry} busy={busy} onAct={act} />
            ))}
          </div>
        )}

        {reports.some((entry) => entry.status !== 'open') && (
          <button
            className="linkish"
            style={{ marginTop: 10 }}
            onClick={() => setShowHandled((was) => !was)}
          >
            {showHandled ? 'Only what is waiting' : 'Show handled ones too'}
          </button>
        )}
      </div>

      <SuspendForm busy={busy} onAct={act} />

      <div className="section">
        <h3 className="section__title">Suspended ({locked.length})</h3>
        {locked.length === 0 ? (
          <p className="empty__body">Nobody.</p>
        ) : (
          <div className="shop">
            {locked.map((account) => (
              <div key={account.userId} className="shopitem">
                <div className="shopitem__text">
                  <span className="shopitem__name">{account.username}</span>
                  <span className="shopitem__blurb">
                    {account.until
                      ? `until ${new Date(account.until).toLocaleDateString()}`
                      : 'indefinitely'}{' '}
                    · {account.reason}
                  </span>
                </div>
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={busy === account.username}
                  onClick={() =>
                    void act(account.username, async () => {
                      await api.liftSuspension(account.username);
                      return `${account.username} is back in, with everything they had.`;
                    })
                  }
                >
                  {busy === account.username ? '…' : 'Lift'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ReportRow({
  report,
  busy,
  onAct,
}: {
  report: QueuedReport;
  busy: string | null;
  onAct(key: string, work: () => Promise<string>): Promise<void>;
}) {
  const [outcome, setOutcome] = useState('');
  const working = busy === report.id;

  return (
    <div className={`report ${report.status === 'open' ? '' : 'report--done'}`}>
      <div className="report__head">
        <span className="report__who">
          <strong>{report.subject}</strong>
          {/* Two things the single report cannot say: whether this is the first
              time, and whether anything has already been done about it. */}
          {report.subjectReports > 1 && (
            <span className="report__tally mono">{report.subjectReports} reports</span>
          )}
          {report.subjectSuspended && <span className="report__tally mono">suspended</span>}
        </span>
        <span className="report__meta mono">
          by {report.reporter} · {new Date(report.at).toLocaleString()}
        </span>
      </div>

      <p className="report__reason">{report.reason}</p>
      {/* Labelled so the evidence is not mistaken for the empty field below it,
          and so it is obvious which words are the reporter's and which are the
          reported person's. */}
      {report.quoted && (
        <div className="report__quoted">
          <span className="report__quote-label mono">What they said</span>
          <blockquote className="report__quote">{report.quoted}</blockquote>
        </div>
      )}

      {report.status === 'open' ? (
        <div className="report__actions">
          <input
            className="staff__input"
            value={outcome}
            placeholder="what you did about it (optional)"
            disabled={working}
            onChange={(event) => setOutcome(event.target.value)}
            aria-label="What was done about this report"
          />
          <button
            className="btn btn--sm"
            disabled={working}
            onClick={() =>
              void onAct(report.id, async () => {
                await api.resolveReport(report.id, 'actioned', outcome.trim() || undefined);
                return 'Marked as dealt with.';
              })
            }
          >
            {working ? '…' : 'Actioned'}
          </button>
          <button
            className="btn btn--ghost btn--sm"
            disabled={working}
            onClick={() =>
              void onAct(report.id, async () => {
                await api.resolveReport(report.id, 'dismissed', outcome.trim() || undefined);
                return 'Dismissed.';
              })
            }
          >
            Dismiss
          </button>
        </div>
      ) : (
        <p className="report__meta mono">
          {report.status} by {report.handledBy}
          {report.outcome ? ` · ${report.outcome}` : ''}
        </p>
      )}
    </div>
  );
}

/**
 * Locking an account out.
 *
 * A reason is required rather than optional, because the person is shown it.
 * An account that stops working without saying why is indistinguishable from a
 * broken one, and somebody who cannot find out what they did cannot stop.
 */
function SuspendForm({
  busy,
  onAct,
}: {
  busy: string | null;
  onAct(key: string, work: () => Promise<string>): Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('7');

  const ready = username.trim().length > 0 && reason.trim().length >= 3;
  const working = busy === 'suspend';

  return (
    <div className="section">
      <h3 className="section__title">Suspend an account</h3>
      <p className="row__hint" style={{ marginBottom: 12, maxWidth: 440 }}>
        Locks them out everywhere and closes the session they are sitting in. Nothing is deleted —
        servers, friends and history are exactly as they were, and lifting it gives all of it back.
      </p>

      <div className="staff__give">
        <input
          className="staff__input"
          value={username}
          placeholder="username"
          disabled={working}
          onChange={(event) => setUsername(event.target.value)}
          aria-label="Username to suspend"
        />
        <select
          className="staff__input"
          value={days}
          disabled={working}
          onChange={(event) => setDays(event.target.value)}
          aria-label="How long for"
        >
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="">Indefinitely</option>
        </select>
      </div>

      <input
        className="staff__input"
        style={{ marginTop: 8, width: '100%' }}
        value={reason}
        placeholder="Why — they are shown this"
        disabled={working}
        maxLength={500}
        onChange={(event) => setReason(event.target.value)}
        aria-label="Reason, which the suspended person is shown"
      />

      <button
        className="btn btn--danger btn--sm"
        style={{ marginTop: 10 }}
        disabled={working || !ready}
        onClick={() =>
          void onAct('suspend', async () => {
            const result = await api.suspendAccount({
              username: username.trim(),
              reason: reason.trim(),
              days: days === '' ? null : Number(days),
            });
            setUsername('');
            setReason('');
            return result.until
              ? `${result.username} is locked out until ${new Date(result.until).toLocaleDateString()}.`
              : `${result.username} is locked out indefinitely.`;
          })
        }
      >
        {working ? 'Suspending…' : 'Suspend'}
      </button>
    </div>
  );
}
