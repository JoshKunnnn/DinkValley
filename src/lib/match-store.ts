import { useState, useEffect, useCallback } from "react";
import {
  dbGetMatches,
  dbSaveMatch,
  dbDeleteMatch,
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

  // Prioritize live matches, then scheduled
  const sorted = [...matches].sort((a, b) => {
    if (a.status === "live" && b.status !== "live") return -1;
    if (b.status === "live" && a.status !== "live") return 1;
    return 0;
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

/* ─────────────────────────────────────────────
   React hook -- Cloud synced + Realtime live updates
───────────────────────────────────────────── */

export function useMatchStore(tournamentSlug?: string) {
  const [matches, setMatches] = useState<LiveMatch[]>(() => getMatches());
  const [isCloudSynced, setIsCloudSynced] = useState(false);

  const refresh = useCallback(() => {
    setMatches(getMatches());
  }, []);

  useEffect(() => {
    let mounted = true;
    refresh();

    // 1. Initial Cloud Hydration from Supabase
    dbGetMatches(tournamentSlug)
      .then((cloudMatches) => {
        if (mounted && cloudMatches.length > 0) {
          saveMatches(cloudMatches, false);
          setMatches(cloudMatches);
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
          dbGetMatches(tournamentSlug)
            .then((cloudMatches) => {
              if (mounted && cloudMatches.length > 0) {
                saveMatches(cloudMatches, false);
                setMatches(cloudMatches);
                setIsCloudSynced(true);
              }
            })
            .catch(() => {});
        },
        () => {
          // Court changes trigger match refresh
          dbGetMatches(tournamentSlug)
            .then((cloudMatches) => {
              if (mounted && cloudMatches.length > 0) {
                saveMatches(cloudMatches, false);
                setMatches(cloudMatches);
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
  }, [refresh, tournamentSlug]);

  const update = useCallback((matchId: string, updater: (m: LiveMatch) => LiveMatch) => {
    const updated = updateMatch(matchId, updater);
    setMatches(updated);
  }, []);

  const removeMatch = useCallback((matchId: string) => {
    const remaining = deleteMatch(matchId);
    setMatches(remaining);
  }, []);

  const resetAll = useCallback(() => {
    saveMatches([], false);
    setMatches([]);
    dbClearAllMatches().catch((err) =>
      console.warn("[Supabase] Clear all matches failed:", err)
    );
  }, []);

  return { matches, refresh, update, deleteMatch: removeMatch, resetAll, isCloudSynced };
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
          newMatches.push(existing);
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
          });
        }
      }
    }
  }

  // Retain any existing matches that belong to other tournaments
  const updatedIds = new Set(newMatches.map((m) => m.id));
  const retained = currentMatches.filter((m) => !updatedIds.has(m.id));
  const merged = [...newMatches, ...retained];
  const { sanitized } = enforceFourCourtCapacity(merged);
  saveMatches(sanitized);
  return sanitized;
}

