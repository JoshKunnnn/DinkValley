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
): boolean {
  if (!teamAName || !teamBName) return false;
  const cleanA = teamAName.trim().toLowerCase();
  const cleanB = teamBName.trim().toLowerCase();
  if (cleanA === cleanB) return false; // A team cannot play itself

  if (!stage) return true;

  // Non-bracket stages (e.g. Finals, Semifinals, Exhibition) are not pool play brackets
  const match = stage.match(/Bracket ([A-H])/i);
  if (!match) {
    return true; // Knockout or exhibition match
  }

  const bracketLetter = match[1]!.toUpperCase();

  // Collect all available candidate group lists for this tournament
  const allCandidateGroups: Array<any[]> = [];

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

  if (typeof localStorage !== "undefined") {
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

  const getSlotTeamName = (slot: any): string => {
    return (slot?.team?.name || slot?.name || "").trim().toLowerCase();
  };

  // Check each candidate draw to see if it contains either cleanA or cleanB
  for (const groups of allCandidateGroups) {
    let bracketA: string | null = null;
    let bracketB: string | null = null;

    for (const grp of groups) {
      const letter = grp.letter?.toUpperCase();
      if (!letter || !Array.isArray(grp.slots)) continue;

      for (const slot of grp.slots) {
        const sName = getSlotTeamName(slot);
        if (!sName) continue;
        if (sName === cleanA || cleanA.includes(sName) || sName.includes(cleanA)) {
          bracketA = letter;
        }
        if (sName === cleanB || cleanB.includes(sName) || sName.includes(cleanB)) {
          bracketB = letter;
        }
      }
    }

    // If both teams belong to this draw
    if (bracketA && bracketB) {
      // If they belong to different brackets within this draw, reject the cross-bracket matchup
      if (bracketA !== bracketB) {
        return false;
      }
      // Both belong to the same bracket
      return bracketA === bracketLetter;
    }

    // If only one team was matched in this draw, verify that its bracket matches the stage
    if (bracketA && !bracketB) {
      if (bracketA === bracketLetter) {
        return true;
      }
    }
    if (bracketB && !bracketA) {
      if (bracketB === bracketLetter) {
        return true;
      }
    }
  }

  // If neither team was explicitly mapped to conflicting brackets, fail-open to avoid blocking tournament play
  return true;
}

