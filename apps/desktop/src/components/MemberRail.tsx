import { useMemo } from 'react';
import { usePermissions } from '../hooks/usePermissions.js';
import { usePersonPopover } from '../hooks/usePersonPopover.js';
import { useApp } from '../store/app.js';
import { Avatar, MemberName } from './primitives.js';

/**
 * Who is in this server.
 *
 * Grouped by what they are doing rather than by rank. Discord sorts its list by
 * role because roles are the organising idea there; here the organising idea is
 * the call, so the useful question is "who could I talk to right now" and the
 * answer sorts into three: in a call, around, and not here. Rank still colours
 * the name, which is where rank actually helps at a glance.
 */
export function MemberRail({ guildId }: { guildId: string }) {
  const selectedGuildId = guildId;
  const members = useApp((s) => s.members);
  const presences = useApp((s) => s.presences);
  const voiceStates = useApp((s) => s.voiceStates);
  const channels = useApp((s) => s.channels);
  const { resolve } = usePermissions();
  const person = usePersonPopover(guildId);

  const groups = useMemo(() => {
    const here = [...members.values()].filter((m) => m.guildId === selectedGuildId);

    const inCall: typeof here = [];
    const around: typeof here = [];
    const away: typeof here = [];

    for (const member of here) {
      const status = presences.get(member.userId) ?? 'offline';
      // A voice state with no channel is somebody who has left one, not
      // somebody in a call - the entry outlives the call it described.
      const inACall = voiceStates.get(member.userId)?.channelId != null;
      if (inACall) inCall.push(member);
      else if (status !== 'offline') around.push(member);
      else away.push(member);
    }

    const byName = (a: (typeof here)[number], b: (typeof here)[number]) =>
      (a.nickname ?? a.user.displayName).localeCompare(b.nickname ?? b.user.displayName);

    return [
      { key: 'call', label: 'In a call', people: inCall.sort(byName) },
      { key: 'around', label: 'Around', people: around.sort(byName) },
      { key: 'away', label: 'Not here', people: away.sort(byName) },
    ].filter((group) => group.people.length > 0);
  }, [members, presences, voiceStates, selectedGuildId]);

  return (
    <aside className="rail" aria-label="Members">
      {groups.map((group) => (
        <div key={group.key} className="rail__group">
          <div className="rail__heading mono">
            {group.label}
            <span className="rail__count">{group.people.length}</span>
          </div>

          {group.people.map((member) => {
            const name = member.nickname ?? member.user.displayName;
            const status = presences.get(member.userId) ?? 'offline';
            const voice = voiceStates.get(member.userId);
            const room = voice?.channelId ? channels.get(voice.channelId) : undefined;

            return (
              <div
                key={member.userId}
                className={`rail__person ${status === 'offline' ? 'rail__person--away' : ''}`}
                {...person.bind(member.userId)}
                title={`${name} — click for profile, right-click to moderate`}
              >
                <span className="rail__portrait">
                  <Avatar user={member.user} size={26} />
                  <span className={`rail__dot rail__dot--${status}`} aria-hidden="true" />
                </span>

                <span className="rail__text">
                  <MemberName
                    className="rail__name"
                    name={name}
                    color={resolve(member.userId).color}
                  />
                  {/* Only where it says something the row does not already. The
                      room someone is in is an invitation; "online" is not. */}
                  {room && <span className="rail__where">{room.name}</span>}
                </span>
              </div>
            );
          })}
        </div>
      ))}

      {person.popovers}
    </aside>
  );
}
