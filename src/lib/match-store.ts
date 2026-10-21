import { useState, useEffect, useCallback, useMemo } from "react";
import {
  dbGetMatches,
  dbSaveMatch,
  dbSaveMatchesBatch,
  dbDeleteMatch,
  dbDeleteMatchesForCategory,
  dbClearAllMatches,
  dbSubscribeToLive,
} from "./supabase-service";
import { isMatchInSameBracket } from "./bracket-utils";

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
  teamAClub?: string | undefined;
  teamBName: string;
  teamBPlayers: string[];
  teamBClub?: string | undefined;
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
  teamABase1Player?: string | undefined;
  teamBBase1Player?: string | undefined;
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
 * Tests whether a match matches a court station's currentMatchId or represents the same team matchup.
 * Robust across all historical and current ID formats:
 * - With '--': "match-...--team1-vs-team2"
 * - Without '--': "match-...-bracket-a-team1-vs-team2"
 * - Legacy format: "live-ko-..." or "live-...-1v2"
 * - By team pair name matching
 */
export function isMatchMatchingStation(
  m: LiveMatch,
  stationMatchId: string | null | undefined,
  courtName?: string,
): boolean {
  if (!stationMatchId) {
    return Boolean(courtName && m.court === courtName && (m.status === "live" || m.status === "scheduled"));
  }
  // 1. Exact ID match
  if (m.id === stationMatchId) {
    return true;
  }
  // 2. Both teams matched in ID string
  const normStationId = stationMatchId.toLowerCase().replace(/[^a-z0-9]/g, "");
  const ma = (m.teamAName || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const mb = (m.teamBName || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

  if (ma.length > 0 && mb.length > 0) {
    if (normStationId.includes(ma) && normStationId.includes(mb)) {
      return true;
    }
  }

  // 3. Fallback: If station ID has -vs-, compare parsed team names
  if (stationMatchId.includes("-vs-")) {
    const parts = stationMatchId.split("-vs-");
    if (parts.length === 2) {
      const p0 = parts[0]!;
      const p1 = parts[1]!;
      const t0 = (p0.includes("--") ? p0.split("--").pop()! : p0).replace(/[^a-z0-9]/gi, "").toLowerCase();
      const t1 = p1.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (t0.length > 0 && t1.length > 0) {
        if ((ma.includes(t0) || t0.includes(ma)) && (mb.includes(t1) || t1.includes(mb))) return true;
        if ((ma.includes(t1) || t1.includes(ma)) && (mb.includes(t0) || t0.includes(mb))) return true;
      }
    }
  }

  // 4. Assigned to this court
  if (courtName && m.court === courtName && (m.status === "live" || m.status === "scheduled")) {
    return true;
  }

  return false;
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
  const stationExactIds = new Set<string>();
  const stationCourts = new Map<string, FacilityCourtName>();

  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem("dv_court_stations");
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const c of FACILITY_COURT_NAMES) {
          const st = parsed[c];
          if (st?.currentMatchId && (st.status === "live" || st.status === "warmup")) {
            stationMatchIds.add(st.currentMatchId);
            stationExactIds.add(st.currentMatchId);
            stationCourts.set(st.currentMatchId, c);

            // Search matches for any match that matches this station ID or matchup
            for (const m of matches) {
              if (m.status === "final") continue;
              if (isMatchMatchingStation(m, st.currentMatchId, c)) {
                stationMatchIds.add(m.id);
                if (!stationCourts.has(m.id)) stationCourts.set(m.id, c);
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Prioritize the station's exact match id, then fuzzy station matches, then live matches, then facility courts, then scheduled.
  // The exact id MUST win so this stays consistent with reconcileCourtStations (otherwise the two
  // functions keep reassigning the court back and forth and re-fire update events endlessly).
  const sorted = [...matches].sort((a, b) => {
    const aStation = stationExactIds.has(a.id) ? 2 : stationMatchIds.has(a.id) ? 1 : 0;
    const bStation = stationExactIds.has(b.id) ? 2 : stationMatchIds.has(b.id) ? 1 : 0;
    if (aStation !== bStation) return bStation - aStation;

    if (a.status === "live" && b.status !== "live") return -1;
    if (b.status === "live" && a.status !== "live") return 1;

    const aOnCourt = a.court && a.court !== "Queue" ? 1 : 0;
    const bOnCourt = b.court && b.court !== "Queue" ? 1 : 0;
    if (aOnCourt !== bOnCourt) return bOnCourt - aOnCourt;

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

    // If an active station is explicitly designated for this match, court assignment is enforced
    if (stationCourts.has(match.id)) {
      const targetCourt = stationCourts.get(match.id)!;
      if (occupiedCourts.has(targetCourt)) {
        // Another active record for this court was already processed!
        // Route duplicate records to Queue so exactly one match occupies the court
        cleanCourt = "Queue";
        modified = true;
      } else {
        cleanCourt = targetCourt;
        occupiedCourts.add(cleanCourt);
      }
    } else {
      // Validate same-bracket for pool play matches: cross-bracket matches cannot be assigned to facility courts
      const isPoolMatch = match.stage && match.stage.includes("Bracket ");
      if (isPoolMatch && !isMatchInSameBracket(match.tournamentSlug || "", match.categoryId || "", match.stage, match.teamAName, match.teamBName)) {
        if (cleanCourt !== "Queue") {
          cleanCourt = "Queue";
          modified = true;
        }
      }

      // For active/dispatched matches: ensure only 1 match per facility court (Courts 1–4)
      if (cleanCourt !== "Queue") {
        if (occupiedCourts.has(cleanCourt)) {
          cleanCourt = "Queue";
          modified = true;
        } else {
          occupiedCourts.add(cleanCourt);
        }
      }
    }

    let updatedStatus = match.status;
    let updatedStartedAt = match.startedAt;
    if (cleanCourt === "Queue" && rawCourt !== "Queue" && match.status === "live") {
      updatedStatus = "scheduled";
      updatedStartedAt = undefined;
    }

    if (cleanCourt !== rawCourt || updatedStatus !== match.status) {
      modified = true;
    }

    resultMap.set(match.id, {
      ...match,
      court: cleanCourt,
      status: updatedStatus,
      startedAt: updatedStartedAt,
    });
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
      saveMatches(sanitized, false);
    }
    return sanitized;
  } catch {
    return [];
  }
}

let _isSavingMatches = false;

export function saveMatches(matches: LiveMatch[], syncToCloud = false, matchToSync?: LiveMatch | LiveMatch[]): void {
  if (_isSavingMatches) return;
  _isSavingMatches = true;
  try {
    const { sanitized } = enforceFourCourtCapacity(matches);
    if (typeof window !== "undefined") {
      try {
        const serialized = JSON.stringify(sanitized);
        const prevRaw = localStorage.getItem(STORAGE_KEY);
        if (prevRaw !== serialized) {
          localStorage.setItem(STORAGE_KEY, serialized);
          window.dispatchEvent(new Event("dv_matches_updated"));
          window.dispatchEvent(new Event("dv_live_matches_updated"));
        }
      } catch {
        // localStorage may be unavailable in SSR
      }
    }
    if (matchToSync) {
      const toSync = Array.isArray(matchToSync) ? matchToSync : [matchToSync];
      dbSaveMatchesBatch(toSync).catch((err) =>
        console.warn("[Supabase] Match targeted sync failed:", err)
      );
    } else if (syncToCloud) {
      const important = sanitized.filter(
        (m) => m.status === "live" || (m.court && m.court !== "Queue") || m.status === "final"
      );
      if (important.length > 0) {
        dbSaveMatchesBatch(important).catch((err) =>
          console.warn("[Supabase] Match background sync failed:", err)
        );
      }
    }
  } finally {
    _isSavingMatches = false;
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
  const localMapById = new Map<string, LiveMatch>();
  const localMapByPair = new Map<string, LiveMatch>();

  for (const lm of localMatches) {
    localMapById.set(lm.id, lm);
    if (lm.teamAName && lm.teamBName) {
      const pairKey = [lm.teamAName.trim().toLowerCase(), lm.teamBName.trim().toLowerCase()].sort().join("::");
      localMapByPair.set(pairKey, lm);
    }
  }

  const matchedLocalIds = new Set<string>();

  const mergedCloud = cloudMatches.map((cm) => {
    let lm = localMapById.get(cm.id);
    if (!lm && cm.teamAName && cm.teamBName) {
      const pairKey = [cm.teamAName.trim().toLowerCase(), cm.teamBName.trim().toLowerCase()].sort().join("::");
      lm = localMapByPair.get(pairKey);
    }

    if (!lm) return cm;

    matchedLocalIds.add(lm.id);

    // 0. If local match was recently reset, do not overwrite with stale cloud score
    if (lm.resetAt && (!cm.resetAt || lm.resetAt > cm.resetAt)) {
      return {
        ...cm,
        id: lm.id,
        score: lm.score,
        status: lm.status,
        court: lm.court,
        tossDone: lm.tossDone,
        tossWinner: lm.tossWinner,
        teamABase1Player: lm.teamABase1Player,
        teamBBase1Player: lm.teamBBase1Player,
        resetAt: lm.resetAt,
        winnerTeam: lm.winnerTeam,
        startedAt: lm.startedAt,
        endedAt: lm.endedAt,
      };
    }

    // 1. If local match is active on a facility court (live or warm-up/scheduled), protect local court assignment and teams
    const isLocalOnCourt = lm.court && lm.court !== "Queue";
    if (isLocalOnCourt || lm.status === "live") {
      return {
        ...cm,
        id: lm.id,
        court: lm.court,
        status: lm.status,
        teamAName: lm.teamAName || cm.teamAName,
        teamBName: lm.teamBName || cm.teamBName,
        teamAPlayers: lm.teamAPlayers?.length ? lm.teamAPlayers : cm.teamAPlayers,
        teamBPlayers: lm.teamBPlayers?.length ? lm.teamBPlayers : cm.teamBPlayers,
        teamAClub: lm.teamAClub ?? cm.teamAClub,
        teamBClub: lm.teamBClub ?? cm.teamBClub,
        score: lm.score,
        tossDone: lm.tossDone ?? cm.tossDone,
        tossWinner: lm.tossWinner ?? cm.tossWinner,
        teamABase1Player: lm.teamABase1Player ?? cm.teamABase1Player,
        teamBBase1Player: lm.teamBBase1Player ?? cm.teamBBase1Player,
        startedAt: lm.startedAt ?? cm.startedAt,
      };
    }

    // 2. If local match has higher score/rallies than cloud, preserve local score
    const localScoreTotal = (lm.score?.teamAScore ?? 0) + (lm.score?.teamBScore ?? 0);
    const cloudScoreTotal = (cm.score?.teamAScore ?? 0) + (cm.score?.teamBScore ?? 0);
    if (localScoreTotal > cloudScoreTotal) {
      return {
        ...cm,
        id: lm.id,
        score: lm.score,
        status: lm.status,
        court: lm.court,
        tossDone: lm.tossDone ?? cm.tossDone,
        tossWinner: lm.tossWinner ?? cm.tossWinner,
        teamABase1Player: lm.teamABase1Player ?? cm.teamABase1Player,
        teamBBase1Player: lm.teamBBase1Player ?? cm.teamBBase1Player,
      };
    }

    return {
      ...cm,
      id: lm.id,
    };
  });

  // 3. Preserve locally dispatched, active, or in-flight matches not yet acknowledged by cloud
  for (const lm of localMatches) {
    if (!matchedLocalIds.has(lm.id)) {
      if ((lm.court && lm.court !== "Queue") || lm.status === "live" || lm.status === "scheduled") {
        mergedCloud.push(lm);
      }
    }
  }

  return mergedCloud;
}

/* ─────────────────────────────────────────────
   React hook -- Cloud synced + Realtime live updates
───────────────────────────────────────────── */

export function useMatchStore(tournamentSlug?: string) {
  const [allMatches, setAllMatches] = useState<LiveMatch[]>(() => getMatches());
  const [isCloudSynced, setIsCloudSynced] = useState(false);

  const refresh = useCallback(() => {
    const next = getMatches();
    // Keep the previous reference when nothing changed so polling does not force downstream recomputation
    setAllMatches((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
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
        if (mounted) {
          const local = getMatches();
          const merged = mergeMatchesSafely(cloudMatches, local);
          saveMatches(merged, false);
          setAllMatches((prev) => (JSON.stringify(prev) === JSON.stringify(merged) ? prev : merged));
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
              if (mounted) {
                const local = getMatches();
                const merged = mergeMatchesSafely(cloudMatches, local);
                saveMatches(merged, false);
                setAllMatches((prev) => (JSON.stringify(prev) === JSON.stringify(merged) ? prev : merged));
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
                setAllMatches((prev) => (JSON.stringify(prev) === JSON.stringify(merged) ? prev : merged));
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

export function createInitialScore(): LiveScore {
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
    teamABase1Player: undefined,
    teamBBase1Player: undefined,
    resetAt: Date.now(),
  };
}

/* ─────────────────────────────────────────────
   Cross-referencing & synchronization helpers
───────────────────────────────────────────── */

/**
 * Creates a unique, deterministic, team-based match ID for a matchup between two teams.
 * Independent of slot indices, order of teams, or array positions.
 */
export function createPairMatchId(
  tournamentSlug: string,
  categoryId: string,
  stageOrBracket: string,
  teamAName: string,
  teamBName: string,
): string {
  const normSlug = (tournamentSlug || "tournament").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const normCat = (categoryId || "cat").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const normStage = (stageOrBracket || "match").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");

  const normA = (teamAName || "teama").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const normB = (teamBName || "teamb").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  // Sort team names alphabetically so Team A vs Team B produces the EXACT same match ID as Team B vs Team A
  const sortedPairs = [normA, normB].sort().join("-vs-");

  return `match-${normSlug}-${normCat}-${normStage}-${sortedPairs}`;
}

/**
 * Searches for a match involving two teams (in either order).
 * Matches strictly by team names to guarantee no cross-match collisions.
 */
export function findLiveMatchForTeams(
  matches: LiveMatch[],
  teamAName?: string,
  teamBName?: string,
  tournamentSlug?: string,
  categoryId?: string,
): LiveMatch | undefined {
  if (!teamAName || !teamBName) return undefined;
  const cleanA = teamAName.trim().toLowerCase();
  const cleanB = teamBName.trim().toLowerCase();

  return matches.find((m) => {
    if (tournamentSlug && m.tournamentSlug && m.tournamentSlug !== tournamentSlug) return false;
    if (categoryId && m.categoryId && m.categoryId !== categoryId) return false;
    const ma = m.teamAName?.trim().toLowerCase();
    const mb = m.teamBName?.trim().toLowerCase();
    return (ma === cleanA && mb === cleanB) || (ma === cleanB && mb === cleanA);
  });
}

/**
 * Accurately finds an existing match between two specific teams within an optional bracket stage.
 * NEVER matches different teams.
 */
export function findMatchForPair(
  matches: LiveMatch[],
  teamAName?: string,
  teamBName?: string,
  tournamentSlug?: string,
  categoryId?: string,
  stageOrBracket?: string,
): LiveMatch | undefined {
  if (!teamAName || !teamBName) return undefined;
  const normA = teamAName.trim().toLowerCase();
  const normB = teamBName.trim().toLowerCase();

  return matches.find((m) => {
    if (tournamentSlug && m.tournamentSlug && m.tournamentSlug !== tournamentSlug) return false;
    if (categoryId && m.categoryId && m.categoryId !== categoryId) return false;

    const ma = m.teamAName?.trim().toLowerCase();
    const mb = m.teamBName?.trim().toLowerCase();
    const teamsMatch = (ma === normA && mb === normB) || (ma === normB && mb === normA);
    if (!teamsMatch) return false;

    if (stageOrBracket && m.stage) {
      const cleanTarget = stageOrBracket.trim().toLowerCase();
      const cleanMatchStage = m.stage.trim().toLowerCase();
      const targetBracket = cleanTarget.match(/(?:bracket|pool)\s*([a-z])/i)?.[1]?.toLowerCase();
      const matchBracket = cleanMatchStage.match(/(?:bracket|pool)\s*([a-z])/i)?.[1]?.toLowerCase();
      if (targetBracket && matchBracket && targetBracket !== matchBracket) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Migrates existing matches to canonical deterministic pair IDs, preserving
 * all recorded scores, rallies, winners, startedAt, endedAt, and officiating info.
 */
export function migrateMatchesToDeterministicIds(matchesList?: LiveMatch[]): LiveMatch[] {
  const current = matchesList ?? getMatches();
  let modified = false;
  const idMap = new Map<string, string>();

  const migrated = current.map((m) => {
    if (!m.teamAName || !m.teamBName) return m;
    if (m.id.startsWith("live-ko-") || m.id.startsWith("ko-")) return m;

    const canonicalId = createPairMatchId(
      m.tournamentSlug || "event",
      m.categoryId || "division",
      m.bracketLetter ? `Bracket ${m.bracketLetter}` : (m.stage || "match"),
      m.teamAName,
      m.teamBName,
    );

    if (m.id !== canonicalId) {
      modified = true;
      idMap.set(m.id, canonicalId);
      return {
        ...m,
        id: canonicalId,
      };
    }
    return m;
  });

  if (modified) {
    saveMatches(migrated, false);

    // Synchronize migrated canonical match IDs across court stations & dispatch queue
    if (typeof localStorage !== "undefined") {
      try {
        const rawStations = localStorage.getItem("dv_court_stations");
        if (rawStations) {
          const stations = JSON.parse(rawStations) as Record<string, { currentMatchId?: string | null; onDeckMatchId?: string | null }>;
          let stationsUpdated = false;
          for (const c of Object.keys(stations)) {
            const st = stations[c];
            if (st?.currentMatchId && idMap.has(st.currentMatchId)) {
              st.currentMatchId = idMap.get(st.currentMatchId) ?? null;
              stationsUpdated = true;
            }
            if (st?.onDeckMatchId && idMap.has(st.onDeckMatchId)) {
              st.onDeckMatchId = idMap.get(st.onDeckMatchId) ?? null;
              stationsUpdated = true;
            }
          }
          if (stationsUpdated) {
            localStorage.setItem("dv_court_stations", JSON.stringify(stations));
            window.dispatchEvent(new Event("dv_court_stations_updated"));
          }
        }

        const rawQueue = localStorage.getItem("dv_dispatch_queue");
        if (rawQueue) {
          const qItems = JSON.parse(rawQueue) as { matchId?: string }[];
          let qUpdated = false;
          if (Array.isArray(qItems)) {
            for (const item of qItems) {
              if (item.matchId && idMap.has(item.matchId)) {
                item.matchId = idMap.get(item.matchId)!;
                qUpdated = true;
              }
            }
            if (qUpdated) {
              localStorage.setItem("dv_dispatch_queue", JSON.stringify(qItems));
              window.dispatchEvent(new Event("dv_dispatch_queue_updated"));
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("dv_matches_updated"));
      window.dispatchEvent(new Event("dv_live_matches_updated"));
    }
  }

  return migrated;
}

/**
 * Generates round-robin match pairings using the balanced Berger circle rotation algorithm.
 * Groups matches by round so that every team plays once per round (or has a bye if odd).
 * This interleaves matches and maximizes rest intervals between games to minimize player fatigue.
 */
export function generateBalancedRoundRobinPairs<T>(items: T[]): [T, T][] {
  if (items.length < 2) return [];

  const list: (T | null)[] = [...items];
  if (list.length % 2 !== 0) {
    list.push(null); // bye dummy
  }

  const n = list.length;
  const numRounds = n - 1;
  const matchesPerRound = Math.floor(n / 2);
  const pairs: [T, T][] = [];

  const indices: number[] = list.map((_, i) => i);

  for (let r = 0; r < numRounds; r++) {
    for (let i = 0; i < matchesPerRound; i++) {
      const idx1 = indices[i];
      const idx2 = indices[n - 1 - i];
      if (idx1 !== undefined && idx2 !== undefined) {
        const t1 = list[idx1];
        const t2 = list[idx2];
        if (t1 !== null && t1 !== undefined && t2 !== null && t2 !== undefined) {
          pairs.push([t1, t2]);
        }
      }
    }

    // Rotate indices keeping index 0 fixed
    const last = indices.pop();
    if (last !== undefined) {
      indices.splice(1, 0, last);
    }
  }

  return pairs;
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
    slots: { team: { id: string; name: string; players: string[]; club?: string | undefined } | null }[];
  }[],
): LiveMatch[] {
  const currentMatches = getMatches();
  const newMatches: LiveMatch[] = [];
  let courtNum = 1;

  for (const group of drawnGroups) {
    const teams = group.slots
      .map((s) => s.team)
      .filter((t): t is { id: string; name: string; players: string[]; club?: string | undefined } => t !== null);

    const pairs = generateBalancedRoundRobinPairs(teams);
    pairs.forEach(([teamA, teamB]) => {
      const matchId = createPairMatchId(
        tournamentSlug,
        categoryId,
        `Bracket ${group.letter}`,
        teamA.name,
        teamB.name,
      );
      const courtName = "Queue";

      // Check if a match for these two teams already exists in the store
      const existing = findMatchForPair(currentMatches, teamA.name, teamB.name, tournamentSlug, categoryId, group.letter);
      if (existing) {
        newMatches.push({
          ...existing,
          tournamentSlug: tournamentSlug || existing.tournamentSlug,
          categoryId: categoryId || existing.categoryId,
          stage: existing.stage || `Bracket ${group.letter} (Pool Play)`,
          bracketLetter: existing.bracketLetter || group.letter,
          teamAClub: existing.teamAClub || teamA.club,
          teamBClub: existing.teamBClub || teamB.club,
        });
      } else {
        newMatches.push({
          id: matchId,
          court: courtName,
          teamAName: teamA.name,
          teamAPlayers: teamA.players,
          teamAClub: teamA.club,
          teamBName: teamB.name,
          teamBPlayers: teamB.players,
          teamBClub: teamB.club,
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
    });
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
      if (m.id.startsWith("live-ko-")) {
        return true;
      }
      if (m.status === "final") {
        return true;
      }
      // If it's a pool play match, only retain if both teams are actually in the same bracket in drawnGroups
      if (!isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName)) {
        return false;
      }
      if (m.status === "live") {
        return true;
      }
      return false;
    }

    // Also for other matches, ensure pool play matches don't cross brackets
    if (m.stage && m.stage.includes("Bracket ") && !isMatchInSameBracket(m.tournamentSlug || "", m.categoryId || "", m.stage, m.teamAName, m.teamBName)) {
      return false;
    }

    return true;
  });

  const merged = [...newMatches, ...retained];
  const { sanitized } = enforceFourCourtCapacity(merged);
  saveMatches(sanitized, false);
  return sanitized;
}

/**
 * Removes matches belonging to a category.
 * When purgeFinalMatches is true (e.g. on full draw reset), all matches including completed ones are wiped.
 */
export function purgeMatchesForCategory(
  tournamentSlug: string,
  categoryId: string,
  purgeFinalMatches = false
): void {
  const current = getMatches();
  const deletedMatchIds: string[] = [];

  const cleanCat = categoryId.trim().toLowerCase();
  const cleanTourn = tournamentSlug.trim().toLowerCase();

  const retained = current.filter((m) => {
    const isThisTourney =
      !m.tournamentSlug ||
      m.tournamentSlug.toLowerCase() === cleanTourn ||
      m.id.toLowerCase().includes(cleanTourn);

    const mCat = (m.categoryId || "").trim().toLowerCase();
    const isThisCat = mCat === cleanCat || m.id.toLowerCase().includes(cleanCat);

    const isThisTourneyAndCat = isThisTourney && isThisCat;

    if (isThisTourneyAndCat) {
      if (!purgeFinalMatches && m.status === "final") {
        return true;
      }
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
 * Removes all matches belonging to a deleted tournament.
 */
export function purgeMatchesForTournament(tournamentSlug: string): void {
  const current = getMatches();
  const deletedMatchIds: string[] = [];

  const retained = current.filter((m) => {
    const isThisTourney =
      m.tournamentSlug === tournamentSlug ||
      (!m.tournamentSlug && m.id.includes(tournamentSlug));
    if (isThisTourney) {
      deletedMatchIds.push(m.id);
      return false;
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

