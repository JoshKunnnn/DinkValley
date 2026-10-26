import { getCachedDrawnGroups } from "./supabase-service";

// Memoized JSON.parse results keyed by localStorage key; reused while the raw string is unchanged.
const _parsedGroupsCache = new Map<string, { raw: string; parsed: any }>();

function readGroupsFromStorage(key: string): any | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(key);
  if (!raw) {
    _parsedGroupsCache.delete(key);
    return null;
  }
  const hit = _parsedGroupsCache.get(key);
  if (hit && hit.raw === raw) return hit.parsed;
  const parsed = JSON.parse(raw);
  _parsedGroupsCache.set(key, { raw, parsed });
  return parsed;
}

/**
 * Validates that a pool play match only pairs teams that are actually in the exact same bracket.
 * If drawn groups exist for the tournament and category, both teamAName and teamBName
 * must belong to the same bracket group (e.g. Bracket A, Bracket B, etc.).
 * Knockout playoff matches (Quarterfinals, Semifinals, etc.) or exhibition matches are allowed cross-bracket.
 */
export function isMatchInSameBracket(
  tournamentSlug: string,
  categoryId?: string,
  stage?: string,
  teamAName?: string,
  teamBName?: string,
  teamAId?: string,
  teamBId?: string,
  teamAPlayers?: string[],
  teamBPlayers?: string[],
): boolean {
  if (!teamAName || !teamBName) return false;
  const cleanA = teamAName.trim().toLowerCase();
  const cleanB = teamBName.trim().toLowerCase();

  // Same team playing itself
  if (teamAId && teamBId && teamAId === teamBId) return false;
  if (!teamAId && !teamBId && cleanA === cleanB) {
    if (teamAPlayers && teamBPlayers && teamAPlayers.length > 0 && teamBPlayers.length > 0) {
      const pA = [...teamAPlayers].sort().join(",").toLowerCase();
      const pB = [...teamBPlayers].sort().join(",").toLowerCase();
      if (pA === pB) return false;
    } else {
      return false;
    }
  }

  if (!stage) return true;

  // Non-bracket stages (e.g. Finals, Semifinals, Exhibition) are not pool play brackets
  const match = stage.match(/(?:bracket|pool)\s*([a-h])\b/i);
  if (!match) {
    return true; // Knockout or exhibition match
  }

  const bracketLetter = match[1]!.toUpperCase();

  const isSlotMatch = (slot: any, cleanName: string, teamId?: string, players?: string[]): boolean => {
    if (teamId && slot?.team?.id && slot.team.id === teamId) return true;
    const sName = (slot?.team?.name || slot?.name || "").trim().toLowerCase();
    if (!sName || !cleanName) return false;

    if (sName === cleanName) {
      if (players && players.length > 0 && slot?.team?.players && slot.team.players.length > 0) {
        const p1 = [...players].sort().join(",").toLowerCase();
        const p2 = [...slot.team.players].sort().join(",").toLowerCase();
        return p1 === p2;
      }
      return true;
    }
    // Disallow substring collision on short team names (e.g. 'nv', 'dv', 'ro', 'dmd')
    if (sName.length >= 4 && cleanName.length >= 4) {
      if (sName.includes(cleanName) || cleanName.includes(sName)) return true;
    }
    return false;
  };

  // Collect candidate group lists
  const allCandidateGroups: Array<any[]> = [];

  // Priority 1: Category-specific groups (Never mix other categories if categoryId is provided)
  if (tournamentSlug && categoryId) {
    const cached = getCachedDrawnGroups(tournamentSlug, categoryId);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      allCandidateGroups.push(cached);
    }
    const direct = readGroupsFromStorage(`dv_drawn_groups_${tournamentSlug}_${categoryId}`);
    if (direct && Array.isArray(direct) && direct.length > 0) {
      allCandidateGroups.push(direct);
    }
  }

  // Priority 2: Only fallback to scanning other keys if no category-specific groups were found
  if (allCandidateGroups.length === 0 && typeof localStorage !== "undefined") {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("dv_drawn_groups_")) {
          if (tournamentSlug && !key.includes(tournamentSlug)) continue;
          const parsed = readGroupsFromStorage(key);
          if (parsed && Array.isArray(parsed) && parsed.length > 0) {
            allCandidateGroups.push(parsed);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (allCandidateGroups.length === 0) {
    return true; // No draw found, allow match
  }

  for (const groups of allCandidateGroups) {
    // 0. If this category has drawn groups, verify that the bracket letter exists in this draw
    const hasGroupWithLetter = groups.some(
      (g: any) => (g.letter || g.bracketLetter)?.toUpperCase() === bracketLetter,
    );
    if (!hasGroupWithLetter) {
      return false;
    }

    // 1. Check target group directly
    const targetGroup = groups.find(
      (g: any) => (g.letter || g.bracketLetter)?.toUpperCase() === bracketLetter,
    );
    if (targetGroup && Array.isArray(targetGroup.slots)) {
      const hasA = targetGroup.slots.some((s: any) => isSlotMatch(s, cleanA, teamAId, teamAPlayers));
      const hasB = targetGroup.slots.some((s: any) => isSlotMatch(s, cleanB, teamBId, teamBPlayers));

      // Both belong to the target bracket
      if (hasA && hasB) {
        return true;
      }

      // If either team is not in this bracket of the active draw, this is not a valid match for this bracket
      return false;
    }

    // 2. Check if both teams belong together in a different bracket of this draw
    for (const grp of groups) {
      const letter = grp.letter?.toUpperCase();
      if (!letter || letter === bracketLetter || !Array.isArray(grp.slots)) continue;
      const inThisA = grp.slots.some((s: any) => isSlotMatch(s, cleanA, teamAId, teamAPlayers));
      const inThisB = grp.slots.some((s: any) => isSlotMatch(s, cleanB, teamBId, teamBPlayers));
      if (inThisA && inThisB) {
        return false; // Both belong to this OTHER bracket, not the target bracket!
      }
    }
  }

  return true;
}
