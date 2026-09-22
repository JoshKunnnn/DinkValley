import { useState, useEffect, useCallback, useMemo } from "react";
import {
  dbGetMatches,
  dbSaveMatch,
  dbDeleteMatch,
  dbDeleteMatchesForCategory,
  dbClearAllMatches,
  dbSubscribeToLive,
} from "./supabase-service";

/* ─────────────────────────────────────────────
   Types
───────────────────────────────────────────── */

export type ServingTeam = "A" | "B";

export type RallyEvent = {
  id: string;
  type: "point" | "side_out" | "fault" | "end_game" | "undo";
  description: string;
  scoreSnapshot: [number, number, number]; // [serverScore, receiverScore, serverNumber]
  servingTeam: ServingTeam;
  timestamp: number;
};

export type LiveScore = {
  teamAScore: number;
  teamBScore: number;
  servingTeam: ServingTeam;
  serverNumber: 1 | 2;
  rallies: RallyEvent[];
};

export type MatchStatus = "scheduled" | "live" | "final";

export type LiveMatch = {
  id: string;
  court: string;
  teamAName: string;
  teamAPlayers: string[];
  teamBName: string;
  teamBPlayers: string[];
  status: MatchStatus;
  score: LiveScore;
  winnerTeam: string | undefined;
  startedAt: number | undefined;
  endedAt: number | undefined;
  officiatedBy: string | undefined;
  tournamentSlug?: string | undefined;
  categoryId?: string | undefined;
  stage?: string | undefined;
  bracketLetter?: string | undefined;
  tossDone?: boolean | undefined;
  tossWinner?: string | undefined;
  resetAt?: number | undefined;
};

/* ─────────────────────────────────────────────
   LocalStorage helpers & 4-Court Constraint
───────────────────────────────────────────── */

export const FACILITY_COURT_NAMES = ["Court 1", "Court 2", "Court 3", "Court 4"] as const;
export type FacilityCourtName = (typeof FACILITY_COURT_NAMES)[number];

export function sanitizeCourtName(court: string | undefined | null): string {
  if (!court) return "Queue";
  const trimmed = court.trim();
  if (FACILITY_COURT_NAMES.includes(trimmed as FacilityCourtName)) {
    return trimmed;
  }
  return "Queue";
}

/**
 * Enforces strict 4-court facility capacity:
 * 1. Sanitizes legacy/non-existent courts ("Center Court", "Court 5-10", etc.) to "Queue".
 * 2. Ensures that among live/scheduled matches, each facility court (Courts 1–4)
 *    is assigned to AT MOST ONE active match at a time. All additional matches are routed to "Queue".
 */
export function enforceFourCourtCapacity(matches: LiveMatch[]): { sanitized: LiveMatch[]; modified: boolean } {
  let modified = false;
  const occupiedCourts = new Set<string>();

  // Determine which matches are officially assigned to active court stations
  const stationMatchIds = new Set<string>();
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem("dv_court_stations");
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const c of FACILITY_COURT_NAMES) {
          if (parsed[c]?.currentMatchId) {
            stationMatchIds.add(parsed[c].currentMatchId);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Prioritize active station-assigned matches, then live matches, then scheduled
  const sorted = [...matches].sort((a, b) => {
    const aStation = stationMatchIds.has(a.id) ? 1 : 0;
    const bStation = stationMatchIds.has(b.id) ? 1 : 0;
    if (aStation !== bStation) return bStation - aStation;

    if (a.status === "live" && b.status !== "live") return -1;
    if (b.status === "live" && a.status !== "live") return 1;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });

  const resultMap = new Map<string, LiveMatch>();

  for (const match of sorted) {
    const rawCourt = match.court;
    let cleanCourt = sanitizeCourtName(rawCourt);

    // Completed matches can keep historical court
    if (match.status === "final") {
      if (cleanCourt !== rawCourt) modified = true;
      resultMap.set(match.id, { ...match, court: cleanCourt });
      continue;
    }

    // For active/scheduled matches: ensure only 1 match per court
    if (cleanCourt !== "Queue") {
      if (occupiedCourts.has(cleanCourt)) {
        cleanCourt = "Queue";
        modified = true;
      } else {
        occupiedCourts.add(cleanCourt);
      }
    }

    if (cleanCourt !== rawCourt) {
      modified = true;
    }

    resultMap.set(match.id, { ...match, court: cleanCourt });
  }

  const sanitized = matches.map((m) => resultMap.get(m.id) ?? m);
  return { sanitized, modified };
}

const STORAGE_KEY = "dv_live_matches";

export function getMatches(): LiveMatch[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LiveMatch[];
    if (!Array.isArray(parsed)) return [];

    const { sanitized, modified } = enforceFourCourtCapacity(parsed);
    if (modified) {
      saveMatches(sanitized);
    }
    return sanitized;
  } catch {
    return [];
  }
}

export function saveMatches(matches: LiveMatch[], syncToCloud = true): void {
  const { sanitized } = enforceFourCourtCapacity(matches);
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
      window.dispatchEvent(new Event("dv_matches_updated"));
      window.dispatchEvent(new Event("dv_live_matches_updated"));
    } catch {
      // localStorage may be unavailable in SSR
    }
  }
  if (syncToCloud) {
    for (const m of sanitized) {
      dbSaveMatch(m).catch((err) =>
        console.warn("[Supabase] Match background sync failed:", err)
      );
    }
  }
}

export function updateMatch(matchId: string, updater: (m: LiveMatch) => LiveMatch): LiveMatch[] {
  const all = getMatches();
  let targetMatch: LiveMatch | undefined;
  const updated = all.map((m) => {
    if (m.id === matchId) {
      targetMatch = updater(m);
      return targetMatch;
    }
    return m;
  });
  saveMatches(updated, false);
  if (targetMatch) {
    dbSaveMatch(targetMatch).catch((err) =>
      console.warn("[Supabase] Match update failed:", err)
    );
  }
  return updated;
}

export function deleteMatch(matchId: string): LiveMatch[] {
  const all = getMatches();
  const filtered = all.filter((m) => m.id !== matchId);
  saveMatches(filtered, false);
  dbDeleteMatch(matchId).catch((err) =>
    console.warn("[Supabase] Match delete failed:", err)
  );
  return filtered;
}

/**
 * Safely merges cloud matches with local matches.
 * Protects local live match status and in-progress scoring from being overwritten by stale cloud state.
 */
function mergeMatchesSafely(cloudMatches: LiveMatch[], localMatches: LiveMatch[]): LiveMatch[] {
  const localMap = new Map(localMatches.map((l) => [l.id, l]));

  const mergedCloud = cloudMatches.map((cm) => {
    const lm = localMap.get(cm.id);
    if (!lm) return cm;

    // 0. If local match was recently reset, do not overwrite with stale cloud score
    if (lm.resetAt && (!cm.resetAt || lm.resetAt > cm.resetAt)) {
      return {
        ...cm,
        score: lm.score,
        status: lm.status,
        court: lm.court,
        tossDone: lm.tossDone,
        tossWinner: lm.tossWinner,
        resetAt: lm.resetAt,
        winnerTeam: lm.winnerTeam,
        startedAt: lm.startedAt,
        endedAt: lm.endedAt,
      };
    }

    // 1. If local match transitioned to "live", preserve local live status and court
    if (lm.status === "live" && cm.status === "scheduled") {
      return {
        ...cm,
        status: "live" as const,
        court: lm.court,
        score: lm.score,
        startedAt: lm.startedAt ?? cm.startedAt,
      };
    }

    // 2. If local match has higher score/rallies than cloud, preserve local score
    const localScoreTotal = (lm.score?.teamAScore ?? 0) + (lm.score?.teamBScore ?? 0);
    const cloudScoreTotal = (cm.score?.teamAScore ?? 0) + (cm.score?.teamBScore ?? 0);
    if (localScoreTotal > cloudScoreTotal) {
      return {
        ...cm,
        score: lm.score,
        status: lm.status,
        court: lm.court,
      };
    }

    return cm;
  });

  const cloudIds = new Set(cloudMatches.map((c) => c.id));
  return [...mergedCloud, ...localMatches.filter((l) => !cloudIds.has(l.id))];
}

/* ─────────────────────────────────────────────
   React hook -- Cloud synced + Realtime live updates
───────────────────────────────────────────── */

export function useMatchStore(tournamentSlug?: string) {
  const [allMatches, setAllMatches] = useState<LiveMatch[]>(() => getMatches());
  const [isCloudSynced, setIsCloudSynced] = useState(false);

  const refresh = useCallback(() => {
    setAllMatches(getMatches());
  }, []);

  const effectiveSlug = tournamentSlug === "all" ? undefined : tournamentSlug;

  const matches = useMemo(() => {
    if (!effectiveSlug) return allMatches;
    return allMatches.filter(
      (m) =>
        m.tournamentSlug === effectiveSlug ||
        (!m.tournamentSlug && m.id.includes(effectiveSlug))
    );
  }, [allMatches, effectiveSlug]);

  useEffect(() => {
    let mounted = true;
    refresh();

    // 1. Initial Cloud Hydration from Supabase
    dbGetMatches(effectiveSlug)
      .then((cloudMatches) => {
        if (mounted && cloudMatches.length > 0) {
          const local = getMatches();
          const merged = mergeMatchesSafely(cloudMatches, local);
          saveMatches(merged, false);
          setAllMatches(merged);
          setIsCloudSynced(true);
        }
      })
      .catch((err) => {
        console.warn("[MatchStore] Initial cloud fetch failed, falling back to local:", err);
      });

    // 2. Realtime listener for cross-device updates (umpires, admin, spectators)
    let unsubRealtime: (() => void) | null = null;
    try {
      unsubRealtime = dbSubscribeToLive(
        () => {
          // On any match change in database
          dbGetMatches(effectiveSlug)
            .then((cloudMatches) => {
              if (mounted && cloudMatches.length > 0) {
                const local = getMatches();
                const merged = mergeMatchesSafely(cloudMatches, local);
                saveMatches(merged, false);
                setAllMatches(merged);
                setIsCloudSynced(true);
              }
            })
            .catch(() => {});
        },
        () => {
          // Court changes trigger match refresh
          dbGetMatches(effectiveSlug)
            .then((cloudMatches) => {
              if (mounted && cloudMatches.length > 0) {
                const local = getMatches();
                const merged = mergeMatchesSafely(cloudMatches, local);
                saveMatches(merged, false);
                setAllMatches(merged);
              }
            })
            .catch(() => {});
        }
      );
    } catch (err) {
      console.warn("[MatchStore] Realtime subscription error:", err);
    }

    // 3. Cross-tab storage listeners
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        refresh();
      }
    };
    const handleCustom = () => {
      refresh();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("dv_matches_updated", handleCustom);

    return () => {
      mounted = false;
      if (unsubRealtime) {
        try {
          unsubRealtime();
        } catch {}
      }
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("dv_matches_updated", handleCustom);
    };
  }, [refresh, effectiveSlug]);

  const update = useCallback((matchId: string, updater: (m: LiveMatch) => LiveMatch) => {
    const updated = updateMatch(matchId, updater);
    setAllMatches(updated);
  }, []);

  const removeMatch = useCallback((matchId: string) => {
    const remaining = deleteMatch(matchId);
    setAllMatches(remaining);
  }, []);

  const resetAll = useCallback(() => {
    saveMatches([], false);
    setAllMatches([]);
    dbClearAllMatches().catch((err) =>
      console.warn("[Supabase] Clear all matches failed:", err)
    );
  }, []);

  return { matches, allMatches, refresh, update, deleteMatch: removeMatch, resetAll, isCloudSynced };
}

/* ─────────────────────────────────────────────
   Mock data generator (Clean empty default)
───────────────────────────────────────────── */

function createInitialScore(): LiveScore {
  return {
    teamAScore: 0,
    teamBScore: 0,
    servingTeam: "A",
    serverNumber: 2,
    rallies: [],
  };
}

export function generateMockMatches(): LiveMatch[] {
  return [];
}

/* ─────────────────────────────────────────────
   Scoring engine -- side-out pickleball rules
───────────────────────────────────────────── */

/**
 * Awards a point to the serving team.
 * In side-out scoring, only the serving team can score.
 * After scoring, the same server continues (no server number change).
 */
export function scorePoint(match: LiveMatch): LiveMatch {
  const s = { ...match.score };
  const rallyId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  if (s.servingTeam === "A") {
    s.teamAScore += 1;
  } else {
    s.teamBScore += 1;
  }

  const event: RallyEvent = {
    id: rallyId,
    type: "point",
    description: `Point scored by ${s.servingTeam === "A" ? match.teamAName : match.teamBName}`,
    scoreSnapshot: [
      s.servingTeam === "A" ? s.teamAScore : s.teamBScore,
      s.servingTeam === "A" ? s.teamBScore : s.teamAScore,
      s.serverNumber,
    ],
    servingTeam: s.servingTeam,
    timestamp: Date.now(),
  };

  s.rallies = [...s.rallies, event];

  return { ...match, score: s, status: "live" };
}

/**
 * Side out: serve switches to the other team.
 * Server 1 -> Server 2 on same team (no side out yet).
 * Server 2 -> Side out to other team, server resets to 1.
 *
 * Exception: At game start (0-0), the first serving team only gets 1 server
 * (starts at server 2), so a fault immediately causes a side out.
 */
export function sideOut(match: LiveMatch): LiveMatch {
  const s = { ...match.score };
  const rallyId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const isGameStart =
    s.teamAScore === 0 && s.teamBScore === 0 && s.servingTeam === "A" && s.serverNumber === 1;

  let description: string;

  if (isGameStart || s.serverNumber === 2) {
    // Side out -- serve goes to other team
    const prevTeam = s.servingTeam;
    s.servingTeam = s.servingTeam === "A" ? "B" : "A";
    s.serverNumber = 1;
    description = `Side out. Serve to ${s.servingTeam === "A" ? match.teamAName : match.teamBName}`;
  } else {
    // Server 1 -> Server 2 on same team
    s.serverNumber = 2;
    description = `Second server for ${s.servingTeam === "A" ? match.teamAName : match.teamBName}`;
  }

  const event: RallyEvent = {
    id: rallyId,
    type: "side_out",
    description,
    scoreSnapshot: [
      s.servingTeam === "A" ? s.teamAScore : s.teamBScore,
      s.servingTeam === "A" ? s.teamBScore : s.teamAScore,
      s.serverNumber,
    ],
    servingTeam: s.servingTeam,
    timestamp: Date.now(),
  };

  s.rallies = [...s.rallies, event];

  return { ...match, score: s, status: "live" };
}

/**
 * End the game. Determines winner by higher score.
 */
export function endGame(match: LiveMatch): LiveMatch {
  const s = { ...match.score };
  const winner =
    s.teamAScore > s.teamBScore
      ? match.teamAName
      : s.teamBScore > s.teamAScore
        ? match.teamBName
        : undefined;

  const event: RallyEvent = {
    id: `r-${Date.now()}`,
    type: "end_game",
    description: winner ? `Game over. ${winner} wins!` : "Game over. Tie.",
    scoreSnapshot: [s.teamAScore, s.teamBScore, s.serverNumber],
    servingTeam: s.servingTeam,
    timestamp: Date.now(),
  };

  s.rallies = [...s.rallies, event];

  return {
    ...match,
    score: s,
    status: "final",
    winnerTeam: winner,
    endedAt: Date.now(),
  };
}

/**
 * Undo the last rally event, restoring the previous state.
 */
export function undoLastRally(match: LiveMatch): LiveMatch {
  const s = { ...match.score };
  if (s.rallies.length === 0) return match;

  const lastRally = s.rallies[s.rallies.length - 1]!;
  const prevRallies = s.rallies.slice(0, -1);

  // Rebuild state from scratch by replaying all rallies except the last
  let rebuilt = createInitialScore();
  rebuilt.rallies = [];

  // Start fresh match and replay
  let replayMatch: LiveMatch = {
    ...match,
    score: createInitialScore(),
    status: prevRallies.length > 0 ? "live" : "scheduled",
    winnerTeam: undefined,
    endedAt: undefined,
  };

  for (const rally of prevRallies) {
    if (rally.type === "point") {
      replayMatch = scorePoint(replayMatch);
    } else if (rally.type === "side_out" || rally.type === "fault") {
      replayMatch = sideOut(replayMatch);
    }
  }

  // Preserve the original rally history (with proper IDs)
  replayMatch.score.rallies = prevRallies;

  return replayMatch;
}

/**
 * Resets a match back to 0-0, Server 2, empty rallies, and clears coin toss status
 * so a fresh pre-match coin toss and scoring can be conducted.
 */
export function resetMatch(match: LiveMatch): LiveMatch {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(`dv_toss_done_${match.id}`);
    } catch {
      // ignore
    }
  }

  return {
    ...match,
    status: match.court && match.court !== "Queue" ? "live" : "scheduled",
    score: {
      teamAScore: 0,
      teamBScore: 0,
      servingTeam: "A",
      serverNumber: 2,
      rallies: [],
    },
    winnerTeam: undefined,
    startedAt: undefined,
    endedAt: undefined,
    tossDone: false,
    tossWinner: undefined,
    resetAt: Date.now(),
  };
}

/* ─────────────────────────────────────────────
   Cross-referencing & synchronization helpers
───────────────────────────────────────────── */

/**
 * Searches for a match involving two teams (in either order).
 * Matches by exact team name or case-insensitive match.
 */
export function findLiveMatchForTeams(
  matches: LiveMatch[],
  teamAName?: string,
  teamBName?: string,
): LiveMatch | undefined {
  if (!teamAName || !teamBName) return undefined;
  const cleanA = teamAName.trim().toLowerCase();
  const cleanB = teamBName.trim().toLowerCase();

  return matches.find((m) => {
    const ma = m.teamAName.trim().toLowerCase();
    const mb = m.teamBName.trim().toLowerCase();
    return (ma === cleanA && mb === cleanB) || (ma === cleanB && mb === cleanA);
  });
}

/**
 * Takes drawn brackets/groups and synchronizes them into dv_live_matches,
 * preserving any already existing in-progress or final scores.
 */
export function syncDrawnBracketsToLiveMatches(
  tournamentSlug: string,
  categoryId: string,
  drawnGroups: {
    letter: string;
    slots: { team: { id: string; name: string; players: string[] } | null }[];
  }[],
): LiveMatch[] {
  const currentMatches = getMatches();
  const newMatches: LiveMatch[] = [];
  let courtNum = 1;

  for (const group of drawnGroups) {
    const teams = group.slots
      .map((s) => s.team)
      .filter((t): t is { id: string; name: string; players: string[] } => t !== null);

    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const teamA = teams[i]!;
        const teamB = teams[j]!;
        const matchId = `live-${tournamentSlug}-${categoryId}-${group.letter}-${i + 1}v${j + 1}`;
        const courtName = courtNum <= 4 ? `Court ${courtNum}` : "Queue";
        courtNum++;

        // Check if a match for these two teams already exists in the store
        const existing = findLiveMatchForTeams(currentMatches, teamA.name, teamB.name);
        if (existing) {
          newMatches.push({
            ...existing,
            tournamentSlug: tournamentSlug || existing.tournamentSlug,
            categoryId: categoryId || existing.categoryId,
            stage: existing.stage || `Bracket ${group.letter} (Pool Play)`,
            bracketLetter: existing.bracketLetter || group.letter,
          });
        } else {
          newMatches.push({
            id: matchId,
            court: courtName,
            teamAName: teamA.name,
            teamAPlayers: teamA.players,
            teamBName: teamB.name,
            teamBPlayers: teamB.players,
            status: "scheduled",
            score: createInitialScore(),
            winnerTeam: undefined,
            startedAt: undefined,
            endedAt: undefined,
            officiatedBy: undefined,
            tournamentSlug,
            categoryId,
            stage: `Bracket ${group.letter} (Pool Play)`,
            bracketLetter: group.letter,
          });
        }
      }
    }
  }

  // Intelligently merge with existing matches:
  // 1. Keep matches from other tournaments or categories.
  // 2. In this tournament/category, preserve matches that are already in progress (live) or completed (final).
  // 3. Keep any knockout matches (live-ko-).
  // 4. Overwrite/replace old unplayed scheduled pool matches with the new bracket draw.
  const newIds = new Set(newMatches.map((m) => m.id));
  const retained = currentMatches.filter((m) => {
    if (newIds.has(m.id)) return false;

    const isThisTourneyAndCat =
      (m.tournamentSlug === tournamentSlug || (!m.tournamentSlug && m.id.includes(tournamentSlug))) &&
      (m.categoryId === categoryId || (!m.categoryId && m.id.includes(categoryId)));

    if (isThisTourneyAndCat) {
      if (m.status === "live" || m.status === "final" || m.id.startsWith("live-ko-")) {
        return true;
      }
      return false;
    }

    return true;
  });

  const merged = [...newMatches, ...retained];
  const { sanitized } = enforceFourCourtCapacity(merged);
  saveMatches(sanitized);
  return sanitized;
}

/**
 * Removes all non-final matches belonging to a category.
 * Used when all players/teams in a category are deleted.
 */
export function purgeMatchesForCategory(tournamentSlug: string, categoryId: string): void {
  const current = getMatches();
  const deletedMatchIds: string[] = [];

  const retained = current.filter((m) => {
    const isThisTourneyAndCat =
      (m.tournamentSlug === tournamentSlug || (!m.tournamentSlug && m.id.includes(tournamentSlug))) &&
      (m.categoryId === categoryId || (!m.categoryId && m.id.includes(categoryId)));

    if (isThisTourneyAndCat && m.status !== "final") {
      deletedMatchIds.push(m.id);
      return false;
    }
    return true;
  });

  saveMatches(retained, false);

  // Clean up from database
  dbDeleteMatchesForCategory(tournamentSlug, categoryId).catch(() => {});
  for (const id of deletedMatchIds) {
    dbDeleteMatch(id).catch(() => {});
  }
}

/**
 * Removes non-final matches involving a specific deleted team.
 */
export function purgeMatchesForTeam(tournamentSlug: string, categoryId: string, teamName: string): void {
  const cleanTeam = teamName.trim().toLowerCase();
  const current = getMatches();
  const deletedMatchIds: string[] = [];

  const retained = current.filter((m) => {
    const isThisTourneyAndCat =
      (m.tournamentSlug === tournamentSlug || (!m.tournamentSlug && m.id.includes(tournamentSlug))) &&
      (m.categoryId === categoryId || (!m.categoryId && m.id.includes(categoryId)));

    if (isThisTourneyAndCat && m.status !== "final") {
      const isTeamA = m.teamAName.trim().toLowerCase() === cleanTeam;
      const isTeamB = m.teamBName.trim().toLowerCase() === cleanTeam;
      if (isTeamA || isTeamB) {
        deletedMatchIds.push(m.id);
        return false;
      }
    }
    return true;
  });

  if (deletedMatchIds.length > 0) {
    saveMatches(retained, false);
    for (const id of deletedMatchIds) {
      dbDeleteMatch(id).catch(() => {});
    }
  }
}

/**
 * Removes non-final matches in a category where either team is no longer in validTeamNames.
 */
export function purgeMatchesNotInTeams(
  tournamentSlug: string,
  categoryId: string,
  validTeamNames: string[]
): void {
  const validSet = new Set(validTeamNames.map((t) => t.trim().toLowerCase()));
  const current = getMatches();
  const deletedMatchIds: string[] = [];

  const retained = current.filter((m) => {
    const isThisTourneyAndCat =
      (m.tournamentSlug === tournamentSlug || (!m.tournamentSlug && m.id.includes(tournamentSlug))) &&
      (m.categoryId === categoryId || (!m.categoryId && m.id.includes(categoryId)));

    if (isThisTourneyAndCat && m.status !== "final") {
      const teamAValid = validSet.has(m.teamAName.trim().toLowerCase());
      const teamBValid = validSet.has(m.teamBName.trim().toLowerCase());
      if (!teamAValid || !teamBValid) {
        deletedMatchIds.push(m.id);
        return false;
      }
    }
    return true;
  });

  if (deletedMatchIds.length > 0) {
    saveMatches(retained, false);
    for (const id of deletedMatchIds) {
      dbDeleteMatch(id).catch(() => {});
    }
  }
}

