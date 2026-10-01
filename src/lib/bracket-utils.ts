import { getCachedDrawnGroups } from "./supabase-service";

/**
 * Validates that a pool play match only pairs teams that are actually in the exact same bracket.
 * If drawn groups exist for the tournament and category, both teamAName and teamBName
 * must belong to the same bracket group (e.g. Bracket A, Bracket B, etc.).
 * Knockout playoff matches (Quarterfinals, Semifinals, etc.) or exhibition matches are allowed cross-bracket.
 */
export function isMatchInSameBracket(
  tournamentSlug: string,
  categoryId: string,
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

  // 1. Try to find drawn groups from in-memory cache
  let groups: any[] | null = null;
  if (tournamentSlug && categoryId) {
    groups = getCachedDrawnGroups(tournamentSlug, categoryId);
  }

  // 2. Try to find drawn groups from localStorage
  if (!groups && typeof localStorage !== "undefined") {
    try {
      if (tournamentSlug && categoryId) {
        const raw = localStorage.getItem(`dv_drawn_groups_${tournamentSlug}_${categoryId}`);
        if (raw) groups = JSON.parse(raw);
      }
      if (!groups) {
        // Fallback: search localStorage keys for any drawn groups matching this tournament/category
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith("dv_drawn_groups_")) {
            if (categoryId && !key.includes(categoryId)) continue;
            if (tournamentSlug && !key.includes(tournamentSlug)) continue;
            const raw = localStorage.getItem(key);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed) && parsed.length > 0) {
                groups = parsed;
                break;
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // If no drawn groups exist at all for this category, we cannot verify bracket membership
  if (!groups || !Array.isArray(groups) || groups.length === 0) {
    return true;
  }

  const targetGroup = groups.find((g: any) => g.letter?.toUpperCase() === bracketLetter);
  if (!targetGroup || !Array.isArray(targetGroup.slots)) {
    return false; // The bracket doesn't exist in drawn groups
  }

  const groupTeamNames = new Set(
    targetGroup.slots
      .map((s: any) => s.team?.name?.trim().toLowerCase())
      .filter(Boolean),
  );

  return groupTeamNames.has(cleanA) && groupTeamNames.has(cleanB);
}
