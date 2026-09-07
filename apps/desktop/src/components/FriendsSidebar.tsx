import type { PresenceStatus, PublicUser } from '@chitchak/protocol';
import { useApp } from '../store/app.js';
import { Avatar } from './primitives.js';

/**
 * The friends list, in the place a server's channels normally sit.
 *
 * Ordered by presence rather than alphabetically: the useful question when you
 * open this is "who could I talk to right now", and a name is easier to find in
 * a short online list than in a long complete one.
 */
export function FriendsSidebar() {
  const friends = useApp((s) => s.friends);
  const people = useApp((s) => s.people);
  const members = useApp((s) => s.members);
  const presences = useApp((s) => s.presences);
  const dmChannels = useApp((s) => s.dmChannels);
  const selectedDmChannelId = useApp((s) => s.selectedDmChannelId);
  const incoming = useApp((s) => s.incomingRequests);
  const openDm = useApp((s) => s.openDm);
  const openFriends = useApp((s) => s.openFriends);

  /**
   * A friend may or may not share a server with us. `people` carries the ones
   * who do not; `members` already has the ones who do, and using it keeps their
   * profile in step with guild updates.
   */
  function personFor(userId: string): PublicUser | undefined {
    const known = people.get(userId);
    if (known) return known;
    for (const member of members.values()) {
      if (member.userId === userId) return member.user;
    }
    return undefined;
  }

  const list = [...friends]
    .map((id) => ({ id, person: personFor(id), status: presences.get(id) ?? 'offline' }))
    .filter((entry): entry is { id: string; person: PublicUser; status: PresenceStatus } =>
      Boolean(entry.person),
    )
    .sort((a, b) => {
      const online = (status: PresenceStatus) => (status === 'offline' ? 1 : 0);
      if (online(a.status) !== online(b.status)) return online(a.status) - online(b.status);
      return a.person.displayName.localeCompare(b.person.displayName);
    });

  const onlineCount = list.filter((entry) => entry.status !== 'offline').length;
  const channelFor = (userId: string) => {
    for (const [channelId, otherId] of dmChannels) if (otherId === userId) return channelId;
    return null;
  };

  return (
    <aside className="sidebar friends__sidebar">
      <button
        className={`friends__home ${selectedDmChannelId === null ? 'friends__home--active' : ''}`}
        onClick={openFriends}
      >
        <span>Friends</span>
        {incoming.size > 0 && <span className="friends__badge mono">{incoming.size}</span>}
      </button>

      <div className="section">
        <h3 className="section__title">
          {list.length === 0
            ? 'No friends yet'
            : `${onlineCount} of ${list.length} online`}
        </h3>

        {list.length === 0 ? (
          <p className="empty__body" style={{ padding: '0 4px' }}>
            Add someone by their username and they will appear here.
          </p>
        ) : (
          <div className="friends__list">
            {list.map(({ id, person, status }) => {
              const channelId = channelFor(id);
              return (
                <button
                  key={id}
                  className={`friends__row ${
                    channelId && channelId === selectedDmChannelId ? 'friends__row--active' : ''
                  }`}
                  onClick={() => void openDm(id)}
                  title={`Message ${person.displayName}`}
                >
                  <Avatar user={person} size={26} status={status} />
                  <span className="friends__name">{person.displayName}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
