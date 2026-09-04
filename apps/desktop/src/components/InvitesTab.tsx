import { useEffect, useState } from 'react';
import type { Invite } from '@chitchak/protocol';
import { Permission } from '@chitchak/protocol';
import { api } from '../lib/api.js';
import { usePermissions } from '../hooks/usePermissions.js';

const EXPIRY_OPTIONS = [
  { label: 'Never', value: 0 },
  { label: '30 minutes', value: 30 * 60 },
  { label: '6 hours', value: 6 * 60 * 60 },
  { label: '1 day', value: 24 * 60 * 60 },
  { label: '7 days', value: 7 * 24 * 60 * 60 },
];

const USE_OPTIONS = [
  { label: 'Unlimited', value: 0 },
  { label: '1 use', value: 1 },
  { label: '5 uses', value: 5 },
  { label: '25 uses', value: 25 },
];

export function InvitesTab({ guildId }: { guildId: string }) {
  const { can } = usePermissions();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [expiresIn, setExpiresIn] = useState(0);
  const [maxUses, setMaxUses] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canManage = can(Permission.MANAGE_INVITES);

  useEffect(() => {
    if (!canManage) {
      setInvites([]);
      return;
    }
    api
      .listInvites(guildId)
      .then(setInvites)
      .catch(() => setError('Could not load existing invites'));
  }, [guildId, canManage]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const invite = await api.createInvite(guildId, { expiresIn, maxUses });
      setInvites((current) => [...(current ?? []), invite]);
      await navigator.clipboard.writeText(invite.code).catch(() => {});
      setCopied(invite.code);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create an invite');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(code: string) {
    setError(null);
    try {
      await api.revokeInvite(code);
      setInvites((current) => current?.filter((i) => i.code !== code) ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not revoke that invite');
    }
  }

  return (
    <>
      {error && <div className="notice" style={{ margin: '0 0 16px' }}>{error}</div>}

      <div className="section">
        <h3 className="section__title">Create an invite</h3>

        <div className="row">
          <div>
            <div className="row__label">Expires after</div>
            <div className="row__hint">The code stops working once it lapses.</div>
          </div>
          <select
            className="row__control"
            style={{ width: 150 }}
            value={expiresIn}
            onChange={(e) => setExpiresIn(Number(e.target.value))}
          >
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="row">
          <div>
            <div className="row__label">Number of uses</div>
            <div className="row__hint">How many people can join with it.</div>
          </div>
          <select
            className="row__control"
            style={{ width: 150 }}
            value={maxUses}
            onChange={(e) => setMaxUses(Number(e.target.value))}
          >
            {USE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <button
          className="btn btn--primary"
          style={{ marginTop: 14 }}
          disabled={busy}
          onClick={() => void create()}
        >
          {busy ? 'Creating…' : 'Create invite'}
        </button>
      </div>

      {canManage && (
        <div className="section">
          <h3 className="section__title">Active invites</h3>
          {invites === null && <p className="empty__body">Loading…</p>}
          {invites?.length === 0 && <p className="empty__body">No invites yet.</p>}

          <div className="list">
            {invites?.map((invite) => (
              <div key={invite.code} className="list__row">
                <div className="list__main">
                  <div className="list__name mono" style={{ letterSpacing: '0.12em' }}>
                    {invite.code}
                    {copied === invite.code && (
                      <span className="legend" style={{ marginLeft: 10 }}>
                        copied
                      </span>
                    )}
                  </div>
                  <div className="list__meta">
                    {invite.maxUses > 0
                      ? `${invite.uses}/${invite.maxUses} uses`
                      : `${invite.uses} uses`}
                    {invite.expiresAt
                      ? ` · expires ${new Date(invite.expiresAt).toLocaleString()}`
                      : ' · never expires'}
                  </div>
                </div>
                <div className="list__actions">
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(invite.code).catch(() => {});
                      setCopied(invite.code);
                    }}
                  >
                    Copy
                  </button>
                  <button className="btn btn--danger btn--sm" onClick={() => void revoke(invite.code)}>
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
