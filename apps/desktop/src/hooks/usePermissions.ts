import { useMemo } from 'react';
import { has } from '@chitchak/protocol';
import { resolveChannel, resolveMember, type ResolvedMember } from '../lib/permissions.js';
import { useApp } from '../store/app.js';

/**
 * Permissions for the signed-in user in the selected server.
 *
 * Used to decide what the interface offers. The server checks everything again;
 * nothing here is a security boundary.
 */
export function usePermissions(): {
  self: ResolvedMember;
  can(permission: number): boolean;
  canInChannel(channelId: string, permission: number): boolean;
  /** Resolves anyone in the current server, for hierarchy comparisons. */
  resolve(userId: string): ResolvedMember;
} {
  const guilds = useApp((s) => s.guilds);
  const selectedGuildId = useApp((s) => s.selectedGuildId);
  const members = useApp((s) => s.members);
  const rankMap = useApp((s) => s.ranks);
  const overwriteMap = useApp((s) => s.overwrites);
  const userId = useApp((s) => s.user?.id);

  return useMemo(() => {
    const guild = guilds.find((g) => g.id === selectedGuildId);
    const ranks = [...rankMap.values()].filter((r) => r.guildId === selectedGuildId);
    const overwrites = [...overwriteMap.values()];

    const memberFor = (id: string) =>
      selectedGuildId ? members.get(`${selectedGuildId}:${id}`) : undefined;

    const selfMember = userId ? memberFor(userId) : undefined;
    const self = resolveMember(guild, selfMember, ranks);

    return {
      self,
      can: (permission: number) => has(self.permissions, permission),
      canInChannel: (channelId: string, permission: number) =>
        has(resolveChannel(self, selfMember, channelId, ranks, overwrites), permission),
      resolve: (id: string) => resolveMember(guild, memberFor(id), ranks),
    };
  }, [guilds, selectedGuildId, members, rankMap, overwriteMap, userId]);
}

/** Ranks in the selected server, most senior first. */
export function useRanks() {
  const rankMap = useApp((s) => s.ranks);
  const selectedGuildId = useApp((s) => s.selectedGuildId);

  return useMemo(
    () =>
      [...rankMap.values()]
        .filter((r) => r.guildId === selectedGuildId)
        .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name)),
    [rankMap, selectedGuildId],
  );
}
