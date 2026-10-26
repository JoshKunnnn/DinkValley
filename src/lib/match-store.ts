import { useState, useEffect, useCallback, useMemo } from "react";
import {
  dbGetMatches,
  dbSaveMatch,
  dbSaveMatchesBatch,
  dbDeleteMatch,
  dbDeleteMatchesBatch,
  dbDeleteMatchesForCategory,
  dbDeleteMatchesForPair,
  dbSaveMainDraw,
  dbClearAllMatches,
  dbSubscribeToLive,
  flushOfflineScoreJournal,
  isSameCategory,
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
    return false;
  }
  // Completed matches cannot match an active court station
  if (m.status === "final" || Boolean(m.winnerTeam) || Boolean(m.endedAt)) {
    return false;
  }
  // Reject zombie matches with empty team names
  const ma = (m.teamAName || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const mb = (m.teamBName || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!ma || !mb || ma === mb) {
    return false;
  }

  // 1. Exact ID match
  if (m.id === stationMatchId) {
    return true;
  }
  // 2. Canonical pair match (forward: Team A vs Team B)
  const canonicalId = createPairMatchId(
    m.tournamentSlug || "",
    m.categoryId || "",
    m.stage || "",
    m.teamAName,
    m.teamBName,
    m.teamAPlayers,
    m.teamBPlayers,
  );
  if (canonicalId === stationMatchId) {
    return true;
  }

  // 3. Reverse canonical pair match (reverse: Team B vs Team A)
  const reverseCanonicalId = createPairMatchId(
    m.tournamentSlug || "",
    m.categoryId || "",
    m.stage || "",
    m.teamBName,
    m.teamAName,
    m.teamBPlayers,
    m.teamAPlayers,
  );
  if (reverseCanonicalId === stationMatchId) {
    return true;
  }

  // 4. Non-disambiguated canonical pair matches (without player names in ID)
  // Only evaluate simple IDs if the station match ID does not already contain player disambiguation tokens
  const normStation = stationMatchId.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hasPlayerDisambiguationInStation =
    Boolean(m.teamAPlayers?.some((p) => p.trim().length > 2 && normStation.includes(p.trim().toLowerCase().replace(/[^a-z0-9]/g, "")))) ||
    Boolean(m.teamBPlayers?.some((p) => p.trim().length > 2 && normStation.includes(p.trim().toLowerCase().replace(/[^a-z0-9]/g, ""))));

  if (!hasPlayerDisambiguationInStation) {
    const simpleId = createPairMatchId(
      m.tournamentSlug || "",
      m.categoryId || "",
      m.stage || "",
      m.teamAName,
      m.teamBName,
    );
    const simpleReverseId = createPairMatchId(
      m.tournamentSlug || "",
      m.categoryId || "",
      m.stage || "",
      m.teamBName,
      m.teamAName,
    );
    if (simpleId === stationMatchId || simpleReverseId === stationMatchId) {
      return true;
    }
  }

  // 5. Fallback: Support both "-vs-" and "_vs_" delimiters in station ID
  const vsDelimiter = stationMatchId.includes("-vs-") ? "-vs-" : stationMatchId.includes("_vs_") ? "_vs_" : null;
  if (vsDelimiter) {
    const parts = stationMatchId.split(vsDelimiter);
    if (parts.length === 2) {
      const p0 = parts[0]!.toLowerCase();
      const p1 = parts[1]!.toLowerCase();
      const normP0 = p0.replace(/[^a-z0-9]/g, "");
      const normP1 = p1.replace(/[^a-z0-9]/g, "");

      const p0HasA = normP0.includes(ma);
      const p1HasB = normP1.includes(mb);
      const p0HasB = normP0.includes(mb);
      const p1HasA = normP1.includes(ma);

      const isNormalOrder = p0HasA && p1HasB;
      const isReverseOrder = p0HasB && p1HasA;

      if (isNormalOrder || isReverseOrder) {
        // Disambiguate when player rosters are available
        if (m.teamAPlayers && m.teamAPlayers.length > 0 && m.teamBPlayers && m.teamBPlayers.length > 0) {
          const pa = m.teamAPlayers.map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, ""));
          const pb = m.teamBPlayers.map((p) => p.toLowerCase().replace(/[^a-z0-9]/g, ""));

          const rawTargetA = isNormalOrder
            ? normP0.slice(normP0.lastIndexOf(ma))
            : normP1.slice(normP1.lastIndexOf(ma));
          const rawTargetB = isNormalOrder
            ? normP1.slice(normP1.lastIndexOf(mb))
            : normP0.slice(normP0.lastIndexOf(mb));

          const paInTargetA = pa.some((p) => p.length > 2 && rawTargetA.includes(p));
          const pbInTargetB = pb.some((p) => p.length > 2 && rawTargetB.includes(p));

          if (rawTargetA.length > ma.length + 3 && !paInTargetA) {
            return false;
          }
          if (rawTargetB.length > mb.length + 3 && !pbInTargetB) {
            return false;
          }
          return true;
        }
        return true;
      }
    }
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

export const _lastLocalMutationAt = new Map<string, number>();

export function markLocalMatchMutation(matchId: string): void {
  _lastLocalMutationAt.set(matchId, Date.now());
}

export function getLocalMatchMutationAt(matchId: string): number {
  return _lastLocalMutationAt.get(matchId) ?? 0;
}

export function updateMatch(matchId: string, updater: (m: LiveMatch) => LiveMatch): LiveMatch[] {
  markLocalMatchMutation(matchId);
  const all = getMatches();
  let targetMatch: LiveMatch | undefined;
  const updated = all.map((m) => {
    if (m.id === matchId) {
      targetMatch = updater(m);
      return targetMatch;
    }
    return m;
  });

  // If match was not found by exact ID, fallback to isMatchMatchingStation or pair matching
  if (!targetMatch && matchId) {
    for (let i = 0; i < updated.length; i++) {
      const m = updated[i]!;
      if (isMatchMatchingStation(m, matchId)) {
        targetMatch = updater(m);
        updated[i] = targetMatch;
        break;
      }
    }
  }

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
 * Sanitizes court assignments against current local court station records.
 * If a station is marked available, in maintenance, or assigned to a different match,
 * the match is gracefully reverted to 'Queue' to prevent phantom court squatting.
 */
function sanitizeCourtAssignment(
  court: string | undefined,
  matchOrId: string | LiveMatch | { id: string; teamAName?: string; teamBName?: string; court?: string },
  matchStatus?: string,
): string {
  if (!court || court === "Queue") return "Queue";
  if (typeof localStorage === "undefined") return court;
  try {
    const rawStations = localStorage.getItem("dv_court_stations");
    if (!rawStations) return court;
    const stations = JSON.parse(rawStations);
    const st = stations[court];
    if (!st) return court;
    if (st.status === "maintenance") {
      return "Queue";
    }
    const matchObj = typeof matchOrId === "string" ? { id: matchOrId, court } : matchOrId;
    if (st.currentMatchId && st.status !== "available" && st.status !== "idle") {
      if (
        st.currentMatchId === matchObj.id ||
        isMatchMatchingStation(matchObj as LiveMatch, st.currentMatchId, court) ||
        ((st.status === "warmup" || st.status === "live") && matchObj.court === court)
      ) {
        return court;
      }
      return "Queue";
    }
    // If station is currently marked 'available' or 'idle' in local storage, do not prematurely
    // strip an incoming active/scheduled match that is in-flight from cloud dispatch.
    return court;
  } catch {
    return court;
  }
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
      const pA = (lm.teamAPlayers || []).map((p) => p.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean).sort().join(",");
      const pB = (lm.teamBPlayers || []).map((p) => p.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean).sort().join(",");
      const nameA = pA ? `${lm.teamAName.trim().toLowerCase()}[${pA}]` : lm.teamAName.trim().toLowerCase();
      const nameB = pB ? `${lm.teamBName.trim().toLowerCase()}[${pB}]` : lm.teamBName.trim().toLowerCase();
      const pairKey = [nameA, nameB].sort().join("::");
      localMapByPair.set(pairKey, lm);
    }
  }

  const matchedLocalIds = new Set<string>();

  const mergedCloud: LiveMatch[] = cloudMatches.map((cm): LiveMatch => {
    let lm = localMapById.get(cm.id);
    if (!lm && cm.teamAName && cm.teamBName) {
      const pA = (cm.teamAPlayers || []).map((p) => p.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean).sort().join(",");
      const pB = (cm.teamBPlayers || []).map((p) => p.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean).sort().join(",");
      const nameA = pA ? `${cm.teamAName.trim().toLowerCase()}[${pA}]` : cm.teamAName.trim().toLowerCase();
      const nameB = pB ? `${cm.teamBName.trim().toLowerCase()}[${pB}]` : cm.teamBName.trim().toLowerCase();
      const pairKey = [nameA, nameB].sort().join("::");
      lm = localMapByPair.get(pairKey);
    }

    if (!lm) {
      const sanitizedCourt = sanitizeCourtAssignment(cm.court, cm, cm.status);
      return sanitizedCourt === cm.court ? cm : { ...cm, court: sanitizedCourt };
    }

    matchedLocalIds.add(lm.id);

    // 0. If local match was recently reset, do not overwrite with stale cloud score
    const localReset = lm.resetAt ?? 0;
    const cloudReset = cm.resetAt ?? 0;
    if (localReset > cloudReset) {
      return {
        ...cm,
        id: lm.id,
        score: lm.score,
        status: lm.status,
        court: sanitizeCourtAssignment(lm.court, lm, lm.status),
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
    if (cloudReset > localReset) {
      return {
        ...cm,
        id: lm.id,
        court: sanitizeCourtAssignment(cm.court, cm, cm.status),
      };
    }

    // 0b. Protect in-flight local mutations (e.g. Umpire scoring / sideout on this device in the last 5 seconds)
    const localMutationAt = getLocalMatchMutationAt(lm.id);
    const isRecentLocalMutation = Date.now() - localMutationAt < 5000;
    if (isRecentLocalMutation && (lm.score?.rallies?.length ?? 0) >= (cm.score?.rallies?.length ?? 0)) {
      return {
        ...cm,
        ...lm,
        id: lm.id,
        court: sanitizeCourtAssignment(lm.court, lm, lm.status),
      };
    }

    const isCloudFinal = cm.status === "final" || Boolean(cm.winnerTeam) || Boolean(cm.endedAt);
    const isLocalFinal = lm.status === "final" || Boolean(lm.winnerTeam) || Boolean(lm.endedAt);

    // 1. Concluded / Final matches: Final state from cloud always wins
    if (isCloudFinal) {
      const preferredCourt = lm.court && lm.court !== "Queue" ? lm.court : cm.court;
      return {
        ...cm,
        id: lm.id,
        status: "final",
        court: sanitizeCourtAssignment(preferredCourt, lm, "final"),
        teamAName: lm.teamAName || cm.teamAName,
        teamBName: lm.teamBName || cm.teamBName,
        teamAPlayers: lm.teamAPlayers?.length ? lm.teamAPlayers : cm.teamAPlayers,
        teamBPlayers: lm.teamBPlayers?.length ? lm.teamBPlayers : cm.teamBPlayers,
      };
    }
    if (isLocalFinal) {
      return {
        ...cm,
        id: lm.id,
        status: "final",
        score: lm.score,
        winnerTeam: lm.winnerTeam,
        endedAt: lm.endedAt,
        court: sanitizeCourtAssignment(lm.court, lm, "final"),
      };
    }

    // 2. Score & Rally Conflict Resolution:
    // Determine which score is ahead/fresher
    const localScoreTotal = (lm.score?.teamAScore ?? 0) + (lm.score?.teamBScore ?? 0);
    const cloudScoreTotal = (cm.score?.teamAScore ?? 0) + (cm.score?.teamBScore ?? 0);
    const localRallies = lm.score?.rallies?.length ?? 0;
    const cloudRallies = cm.score?.rallies?.length ?? 0;

    let chosenScore = cm.score;
    let chosenStatus: MatchStatus = cm.status;

    if (localScoreTotal > cloudScoreTotal) {
      // Local has higher score (e.g. Umpire scoring on this device in-flight before cloud echo)
      chosenScore = lm.score;
      if (lm.status === "live") chosenStatus = "live";
    } else if (cloudScoreTotal > localScoreTotal) {
      // Cloud has higher score (e.g. Umpire scored on another device, now received by Admin)
      chosenScore = cm.score;
      if (cm.status === "live" || (cloudScoreTotal > 0 && chosenStatus === "scheduled")) {
        chosenStatus = "live";
      }
    } else {
      // Scores are equal. Compare rally counts or details
      if (localRallies > cloudRallies) {
        chosenScore = lm.score;
      } else {
        chosenScore = cm.score;
      }
      if (cm.status === "live" || lm.status === "live") {
        chosenStatus = "live";
      }
    }

    // Court assignment: keep active facility court assignment, validated against current station status
    const rawCourt = (lm.court && lm.court !== "Queue" ? lm.court : cm.court) || "Queue";
    const chosenCourt = sanitizeCourtAssignment(rawCourt, lm, chosenStatus);

    return {
      ...cm,
      id: lm.id,
      court: chosenCourt,
      status: chosenStatus,
      score: chosenScore,
      teamAName: lm.teamAName || cm.teamAName,
      teamBName: lm.teamBName || cm.teamBName,
      teamAPlayers: lm.teamAPlayers?.length ? lm.teamAPlayers : cm.teamAPlayers,
      teamBPlayers: lm.teamBPlayers?.length ? lm.teamBPlayers : cm.teamBPlayers,
      teamAClub: lm.teamAClub ?? cm.teamAClub,
      teamBClub: lm.teamBClub ?? cm.teamBClub,
      tossDone: lm.tossDone ?? cm.tossDone,
      tossWinner: lm.tossWinner ?? cm.tossWinner,
      teamABase1Player: lm.teamABase1Player ?? cm.teamABase1Player,
      teamBBase1Player: lm.teamBBase1Player ?? cm.teamBBase1Player,
      officiatedBy: cm.officiatedBy || lm.officiatedBy,
      startedAt: cm.startedAt || lm.startedAt,
    };
  });

  // 3. Preserve locally dispatched, active, or in-flight matches not yet acknowledged by cloud
  for (const lm of localMatches) {
    if (!matchedLocalIds.has(lm.id)) {
      const isActivelyOnCourt = (lm.court && lm.court !== "Queue" && sanitizeCourtAssignment(lm.court, lm, lm.status) !== "Queue");
      const isRecentlyMutated = Date.now() - getLocalMatchMutationAt(lm.id) < 15000;

      // Only preserve unacknowledged local matches if they are actively occupying a court or were mutated in the last 15s
      // Purge stale/orphaned scheduled ghost matches so local storage reflects cloud ground truth
      if (isActivelyOnCourt || isRecentlyMutated) {
        const sanitizedCourt = sanitizeCourtAssignment(lm.court, lm, lm.status);
        mergedCloud.push({
          ...lm,
          court: sanitizedCourt,
        });
      }
    }
  }

  // 4. Strict Deduplication by Matchup Pair:
  // Ensure that no tournament division has duplicate records for the exact same team matchup in the same bracket stage.
  // If duplicates exist, authoritative records (final, live, or higher scores) win and replace ghost scheduled entries.
  const deduplicated = new Map<string, LiveMatch>();
  for (const m of mergedCloud) {
    if (!m.teamAName || !m.teamBName) {
      deduplicated.set(m.id, m);
      continue;
    }
    const pair = [m.teamAName.trim().toLowerCase(), m.teamBName.trim().toLowerCase()].sort().join("::");
    const bracket = (m.stage || "").match(/(?:bracket|pool)\s*([a-z])/i)?.[1]?.toLowerCase() || "pool";
    const pairKey = `${m.tournamentSlug || "event"}::${m.categoryId || "division"}::${bracket}::${pair}`;

    if (!deduplicated.has(pairKey)) {
      deduplicated.set(pairKey, m);
    } else {
      const existing = deduplicated.get(pairKey)!;
      const existingScore = (existing.score?.teamAScore ?? 0) + (existing.score?.teamBScore ?? 0);
      const newScore = (m.score?.teamAScore ?? 0) + (m.score?.teamBScore ?? 0);

      const mWins =
        (m.status === "final" && existing.status !== "final") ||
        (m.status === "live" && existing.status === "scheduled") ||
        (newScore > existingScore) ||
        (m.court && m.court !== "Queue" && (!existing.court || existing.court === "Queue"));

      if (mWins) {
        deduplicated.set(pairKey, m);
      }
    }
  }

  return Array.from(deduplicated.values());
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

  const refreshFromCloud = useCallback(async () => {
    try {
      const cloudMatches = await dbGetMatches(effectiveSlug);
      const local = getMatches();
      const merged = mergeMatchesSafely(cloudMatches, local);
      saveMatches(merged, false);
      setAllMatches((prev) => (JSON.stringify(prev) === JSON.stringify(merged) ? prev : merged));
      setIsCloudSynced(true);
      return merged;
    } catch {
      return getMatches();
    }
  }, [effectiveSlug]);

  const matches = useMemo(() => {
    if (!effectiveSlug) return allMatches;
    const activeStationMatchIds = new Set<string>();
    const stationEntries: Array<{ court: string; matchId: string }> = [];
    if (typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem("dv_court_stations");
        if (raw) {
          const parsed = JSON.parse(raw);
          for (const c of FACILITY_COURT_NAMES) {
            const st = parsed[c];
            if (st?.currentMatchId) {
              activeStationMatchIds.add(st.currentMatchId);
              stationEntries.push({ court: c, matchId: st.currentMatchId });
            }
            if (st?.onDeckMatchId) {
              activeStationMatchIds.add(st.onDeckMatchId);
              stationEntries.push({ court: c, matchId: st.onDeckMatchId });
            }
          }
        }
      } catch {}
    }

    return allMatches.filter((m) => {
      // Retain any match actively occupying or assigned to a facility court station
      if (
        activeStationMatchIds.has(m.id) ||
        (m.court && m.court !== "Queue" && (FACILITY_COURT_NAMES as readonly string[]).includes(m.court as any))
      ) {
        return true;
      }
      for (const entry of stationEntries) {
        if (isMatchMatchingStation(m, entry.matchId, entry.court)) {
          return true;
        }
      }
      return (
        m.tournamentSlug === effectiveSlug ||
        (!m.tournamentSlug && m.id.includes(effectiveSlug))
      );
    });
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
            .catch(() => { });
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
            .catch(() => { });
        }
      );
    } catch (err) {
      console.warn("[MatchStore] Realtime subscription error:", err);
    }

    // 3. Fallback periodic 3s cloud poll to ensure mobile browsers and waking tabs stay synced
    const pollInterval = setInterval(() => {
      if (mounted) {
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
          .catch(() => { });
      }
    }, 3000);

    // 4. Cross-tab storage listeners
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        refresh();
      }
    };
    const handleCustom = () => {
      refresh();
    };

    // 5. Visibility & Reconnection Recovery:
    // When a mobile device wakes or a backgrounded browser tab resumes, immediately poll cloud and flush queued offline scores
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshFromCloud();
        flushOfflineScoreJournal().catch(() => { });
      }
    };
    const handleOnline = () => {
      refreshFromCloud();
      flushOfflineScoreJournal().catch(() => { });
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("dv_matches_updated", handleCustom);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("online", handleOnline);

    return () => {
      mounted = false;
      if (unsubRealtime) {
        try {
          unsubRealtime();
        } catch { }
      }
      clearInterval(pollInterval);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("dv_matches_updated", handleCustom);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("online", handleOnline);
    };
  }, [refresh, refreshFromCloud, effectiveSlug]);

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

  return { matches, allMatches, refresh, refreshFromCloud, update, deleteMatch: removeMatch, resetAll, isCloudSynced };
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
  markLocalMatchMutation(match.id);
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
  markLocalMatchMutation(match.id);
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
  markLocalMatchMutation(match.id);
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
  markLocalMatchMutation(match.id);
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
 * Generates a unique, deterministic, category-scoped match ID based on category ID, bracket letter, and team IDs.
 * Symmetrical: [teamAId, teamBId].sort() ensures the exact same ID regardless of pair order.
 */
export function createCategoryScopedMatchId(
  categoryId: string,
  bracketLetter: string,
  teamAId: string,
  teamBId: string,
): string {
  const cleanCat = (categoryId || "cat").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const cleanLetter = (bracketLetter || "a").trim().toUpperCase();
  const [firstId, secondId] = [teamAId.trim(), teamBId.trim()].sort();
  return `match_${cleanCat}_${cleanLetter}_${firstId}_vs_${secondId}`;
}

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
  teamAPlayers?: string[],
  teamBPlayers?: string[],
  isTeamADuplicate = false,
  isTeamBDuplicate = false,
): string {
  const normSlug = (tournamentSlug || "tournament").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const normCat = (categoryId || "cat").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Standardize stage: if it references a pool/bracket letter (e.g. "Bracket A", "Bracket A (Pool Play)", "Pool A - Round 1"),
  // normalize to "bracket-[letter]" so IDs never diverge between draws, unassigned lists, queues, and dispatch stations.
  let cleanStage = (stageOrBracket || "match").trim().toLowerCase();
  const poolLetterMatch = cleanStage.match(/(?:bracket|pool)\s*([a-z])/i);
  if (poolLetterMatch) {
    cleanStage = `bracket-${poolLetterMatch[1]!.toLowerCase()}`;
  }
  const normStage = cleanStage.replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");

  let normA = (teamAName || "teama").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let normB = (teamBName || "teamb").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  let dupA = isTeamADuplicate;
  let dupB = isTeamBDuplicate;

  // Auto-detect duplicate team names from drawn groups in localStorage if not explicitly passed
  if ((!dupA || !dupB) && typeof localStorage !== "undefined") {
    try {
      const keysToTry = [
        `dv_drawn_groups_${normSlug}_${normCat}`,
        `dv_drawn_groups_${tournamentSlug}_${categoryId}`,
        `dv_drawn_groups_${normSlug}_${categoryId}`,
        `dv_drawn_groups_${tournamentSlug}_${normCat}`,
      ];
      let rawGroups: string | null = null;
      for (const k of keysToTry) {
        rawGroups = localStorage.getItem(k);
        if (rawGroups) break;
      }
      if (!rawGroups) {
        for (let i = 0; i < localStorage.length; i++) {
          const lk = localStorage.key(i);
          if (lk && lk.startsWith("dv_drawn_groups_") && (!normSlug || lk.includes(normSlug))) {
            rawGroups = localStorage.getItem(lk);
            if (rawGroups) break;
          }
        }
      }

      if (rawGroups) {
        const parsed = JSON.parse(rawGroups);
        if (Array.isArray(parsed)) {
          let candidateSlots: any[] = [];
          if (poolLetterMatch) {
            const letter = poolLetterMatch[1]!.toUpperCase();
            const grp = parsed.find((g: any) => (g.letter || g.bracketLetter)?.toUpperCase() === letter);
            if (grp?.slots) candidateSlots = grp.slots;
          }
          if (candidateSlots.length === 0) {
            candidateSlots = parsed.flatMap((g: any) => g.slots || []);
          }

          const rawA = (teamAName || "").trim().toLowerCase();
          const rawB = (teamBName || "").trim().toLowerCase();

          const countA = candidateSlots.filter((s: any) => {
            const sn = (s?.team?.name || s?.name || "").trim().toLowerCase();
            return sn === rawA;
          }).length;
          const countB = candidateSlots.filter((s: any) => {
            const sn = (s?.team?.name || s?.name || "").trim().toLowerCase();
            return sn === rawB;
          }).length;

          if (countA > 1) dupA = true;
          if (countB > 1) dupB = true;
        }
      }
    } catch {
      // ignore
    }
  }

  // If two teams share the same club/team name, or either is a duplicate in its bracket, disambiguate using player names
  const shouldDisambiguateA = (normA === normB || dupA) && teamAPlayers && teamAPlayers.length > 0;
  const shouldDisambiguateB = (normA === normB || dupB) && teamBPlayers && teamBPlayers.length > 0;

  if (shouldDisambiguateA) {
    const pA = teamAPlayers!.map((p) => p.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")).filter(Boolean).sort().join("-");
    if (pA) normA = `${normA}-${pA}`;
  }
  if (shouldDisambiguateB) {
    const pB = teamBPlayers!.map((p) => p.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")).filter(Boolean).sort().join("-");
    if (pB) normB = `${normB}-${pB}`;
  }

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
  stageOrBracket?: string,
): LiveMatch | undefined {
  if (!teamAName || !teamBName) return undefined;
  const cleanA = teamAName.trim().toLowerCase();
  const cleanB = teamBName.trim().toLowerCase();

  return matches.find((m) => {
    if (tournamentSlug && m.tournamentSlug && m.tournamentSlug !== tournamentSlug) return false;
    if (categoryId && m.categoryId && !isSameCategory(m.categoryId, categoryId)) return false;
    if (stageOrBracket && m.stage) {
      const isTargetKO = /quarter|semi|final|playoff|bronze/i.test(stageOrBracket);
      const isMatchKO = /quarter|semi|final|playoff|bronze/i.test(m.stage);
      if (isTargetKO !== isMatchKO) return false;
    }
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
  teamAPlayers?: string[],
  teamBPlayers?: string[],
): LiveMatch | undefined {
  if (!teamAName || !teamBName) return undefined;
  const normA = teamAName.trim().toLowerCase();
  const normB = teamBName.trim().toLowerCase();

  const candidates = matches.filter((m) => {
    if (tournamentSlug && m.tournamentSlug && m.tournamentSlug !== tournamentSlug) return false;
    if (categoryId && m.categoryId && !isSameCategory(m.categoryId, categoryId)) return false;

    const ma = m.teamAName?.trim().toLowerCase();
    const mb = m.teamBName?.trim().toLowerCase();
    const isNormalOrder = ma === normA && mb === normB;
    const isReverseOrder = ma === normB && mb === normA;
    if (!isNormalOrder && !isReverseOrder) return false;

    // Disambiguate team rosters when player lists are provided (crucial when a division has multiple teams with the same name, e.g. two teams named "nv")
    if (isNormalOrder) {
      if (teamAPlayers && teamAPlayers.length > 0 && m.teamAPlayers && m.teamAPlayers.length > 0) {
        const targetA = [...teamAPlayers].map((p) => p.trim().toLowerCase()).sort().join(",");
        const matchA = [...m.teamAPlayers].map((p) => p.trim().toLowerCase()).sort().join(",");
        if (targetA !== matchA) return false;
      }
      if (teamBPlayers && teamBPlayers.length > 0 && m.teamBPlayers && m.teamBPlayers.length > 0) {
        const targetB = [...teamBPlayers].map((p) => p.trim().toLowerCase()).sort().join(",");
        const matchB = [...m.teamBPlayers].map((p) => p.trim().toLowerCase()).sort().join(",");
        if (targetB !== matchB) return false;
      }
    } else if (isReverseOrder) {
      if (teamAPlayers && teamAPlayers.length > 0 && m.teamBPlayers && m.teamBPlayers.length > 0) {
        const targetA = [...teamAPlayers].map((p) => p.trim().toLowerCase()).sort().join(",");
        const matchB = [...m.teamBPlayers].map((p) => p.trim().toLowerCase()).sort().join(",");
        if (targetA !== matchB) return false;
      }
      if (teamBPlayers && teamBPlayers.length > 0 && m.teamAPlayers && m.teamAPlayers.length > 0) {
        const targetB = [...teamBPlayers].map((p) => p.trim().toLowerCase()).sort().join(",");
        const matchA = [...m.teamAPlayers].map((p) => p.trim().toLowerCase()).sort().join(",");
        if (targetB !== matchA) return false;
      }
    }

    if (stageOrBracket && m.stage) {
      const cleanTarget = stageOrBracket.trim().toLowerCase();
      const cleanMatchStage = m.stage.trim().toLowerCase();

      const isTargetKnockout =
        cleanTarget.includes("quarter") ||
        cleanTarget.includes("semi") ||
        cleanTarget.includes("final") ||
        cleanTarget.includes("playoff") ||
        cleanTarget.includes("bronze");
      const isMatchKnockout =
        cleanMatchStage.includes("quarter") ||
        cleanMatchStage.includes("semi") ||
        cleanMatchStage.includes("final") ||
        cleanMatchStage.includes("playoff") ||
        cleanMatchStage.includes("bronze");

      // Knockout playoff matches should never match a pool play match request, and vice-versa
      if (isTargetKnockout !== isMatchKnockout) {
        return false;
      }

      // If both are pool play stages, compare bracket letters
      if (!isTargetKnockout && !isMatchKnockout) {
        const targetBracket =
          cleanTarget.match(/(?:bracket|pool)?\s*([a-z])\b/i)?.[1]?.toLowerCase() ||
          (cleanTarget.length === 1 && /[a-z]/i.test(cleanTarget) ? cleanTarget.toLowerCase() : undefined);
        const matchBracket = cleanMatchStage.match(/(?:bracket|pool)\s*([a-z])\b/i)?.[1]?.toLowerCase();

        if (targetBracket && matchBracket && targetBracket !== matchBracket) {
          // If this match is not concluded and has no winner, reject mismatched bracket
          if (m.status !== "final" && !m.winnerTeam) {
            return false;
          }
          // If this match is final, check if another candidate exists that explicitly matches targetBracket and is also final
          const hasExactFinal = matches.some(
            (other) =>
              other.id !== m.id &&
              (other.status === "final" || other.winnerTeam) &&
              ((other.teamAName?.trim().toLowerCase() === normA && other.teamBName?.trim().toLowerCase() === normB) ||
                (other.teamAName?.trim().toLowerCase() === normB && other.teamBName?.trim().toLowerCase() === normA)) &&
              other.stage &&
              other.stage.toLowerCase().includes(`bracket ${targetBracket}`),
          );
          if (hasExactFinal) {
            return false;
          }
        }
      }
    }

    return true;
  });

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // If multiple candidates exist for this team pair, prioritize:
  // 1. Concluded matches with final score or winner
  // 2. Live matches currently underway or on court
  // 3. Matches with higher score/rallies recorded
  // 4. Most recent startedAt/endedAt
  return candidates.sort((a, b) => {
    // 1. Final status wins over non-final
    if (a.status === "final" && b.status !== "final") return -1;
    if (b.status === "final" && a.status !== "final") return 1;

    // 2. Live status wins over scheduled
    if (a.status === "live" && b.status === "scheduled") return -1;
    if (b.status === "live" && a.status === "scheduled") return 1;

    // 3. Court assigned wins over unassigned/Queue
    const aOnCourt = a.court && a.court !== "Queue";
    const bOnCourt = b.court && b.court !== "Queue";
    if (aOnCourt && !bOnCourt) return -1;
    if (bOnCourt && !aOnCourt) return 1;

    // 4. Point total
    const aPts = (a.score?.teamAScore ?? 0) + (a.score?.teamBScore ?? 0);
    const bPts = (b.score?.teamAScore ?? 0) + (b.score?.teamBScore ?? 0);
    if (aPts !== bPts) return bPts - aPts;

    // 5. Most recent endedAt or startedAt
    const aTime = a.endedAt || a.startedAt || 0;
    const bTime = b.endedAt || b.startedAt || 0;
    return bTime - aTime;
  })[0];
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
    // Category-scoped match IDs are canonical and unique; never overwrite or convert them
    if (m.id.startsWith("match_")) return m;

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

    const nameCounts = new Map<string, number>();
    for (const t of teams) {
      const k = t.name.trim().toLowerCase();
      nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
    }

    const pairs = generateBalancedRoundRobinPairs(teams);
    pairs.forEach(([teamA, teamB]) => {
      const isDupA = (nameCounts.get(teamA.name.trim().toLowerCase()) || 0) > 1;
      const isDupB = (nameCounts.get(teamB.name.trim().toLowerCase()) || 0) > 1;

      const matchId = (teamA.id && teamB.id)
        ? createCategoryScopedMatchId(categoryId, group.letter, teamA.id, teamB.id)
        : createPairMatchId(
            tournamentSlug,
            categoryId,
            `Bracket ${group.letter}`,
            teamA.name,
            teamB.name,
            teamA.players,
            teamB.players,
            isDupA,
            isDupB,
          );
      const courtName = "Queue";

      // Check if a match for these two teams already exists in the store
      const existing = currentMatches.find((m) => m.id === matchId) || findMatchForPair(
        currentMatches,
        teamA.name,
        teamB.name,
        tournamentSlug,
        categoryId,
        group.letter,
        teamA.players,
        teamB.players,
      );
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
      (isSameCategory(m.categoryId, categoryId) || (!m.categoryId && m.id.includes(categoryId)));

    if (isThisTourneyAndCat) {
      if (m.id.startsWith("live-ko-")) {
        return true;
      }
      if (m.status === "final") {
        return true;
      }
      // If it's a pool play match, only retain if both teams are actually in the same bracket in drawnGroups
      if (!isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName, undefined, undefined, m.teamAPlayers, m.teamBPlayers)) {
        return false;
      }
      if (m.status === "live") {
        return true;
      }
      return false;
    }

    // Also for other matches, ensure pool play matches don't cross brackets
    if (m.stage && m.stage.includes("Bracket ") && !isMatchInSameBracket(m.tournamentSlug || "", m.categoryId || "", m.stage, m.teamAName, m.teamBName, undefined, undefined, m.teamAPlayers, m.teamBPlayers)) {
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
    const isThisCat =
      mCat === cleanCat ||
      m.id.toLowerCase().includes(cleanCat) ||
      isSameCategory(m.categoryId, categoryId);

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
  dbDeleteMatchesForCategory(tournamentSlug, categoryId, purgeFinalMatches).catch(() => { });
  if (deletedMatchIds.length > 0) {
    dbDeleteMatchesBatch(deletedMatchIds).catch(() => { });
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
      (isSameCategory(m.categoryId, categoryId) || (!m.categoryId && m.id.includes(categoryId)));

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
      dbDeleteMatch(id).catch(() => { });
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
      dbDeleteMatch(id).catch(() => { });
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
      (isSameCategory(m.categoryId, categoryId) || (!m.categoryId && m.id.includes(categoryId)));

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
      dbDeleteMatch(id).catch(() => { });
    }
  }
}

/**
 * Permanently clears completed matches from local store, memory, and Supabase cloud.
 * Matches against exact IDs, team pairs, and stage to guarantee that all ghost duplicates
 * (e.g. md-qf-*, live-ko-*, canonical pair IDs) are completely eliminated.
 */
export async function clearCompletedMatches({
  tournamentSlug,
  matchIds,
  categoryId,
  targetMatch,
  targetMatches,
}: {
  tournamentSlug: string;
  matchIds: string[];
  categoryId?: string | undefined;
  targetMatch?: LiveMatch | null | undefined;
  targetMatches?: LiveMatch[] | undefined;
}): Promise<{ deletedCount: number }> {
  if (!matchIds || matchIds.length === 0) {
    return { deletedCount: 0 };
  }

  const current = getMatches();

  // Collect all target match objects
  const explicitTargets: LiveMatch[] = [
    ...(targetMatches || []),
    ...(targetMatch ? [targetMatch] : []),
    ...current.filter((m) => matchIds.includes(m.id)),
  ];

  // Helper to test if a match represents the same matchup as any target
  const isMatchingSameMatchup = (m: LiveMatch): boolean => {
    if (matchIds.includes(m.id)) return true;
    const ma = m.teamAName?.trim().toLowerCase();
    const mb = m.teamBName?.trim().toLowerCase();
    if (!ma || !mb) return false;

    return explicitTargets.some((t) => {
      if (t.id === m.id) return true;
      const ta = t.teamAName?.trim().toLowerCase();
      const tb = t.teamBName?.trim().toLowerCase();
      if (!ta || !tb) return false;

      const teamsMatch = (ma === ta && mb === tb) || (ma === tb && mb === ta);
      if (!teamsMatch) return false;

      const mStage = (m.stage || "").toLowerCase();
      const tStage = (t.stage || "").toLowerCase();
      const isBothPlayoff =
        (mStage.includes("quarter") || mStage.includes("semi") || mStage.includes("final") || mStage.includes("playoff") || mStage.includes("bronze")) &&
        (tStage.includes("quarter") || tStage.includes("semi") || tStage.includes("final") || tStage.includes("playoff") || tStage.includes("bronze"));

      if (isBothPlayoff) {
        const qNumM = mStage.match(/(?:quarterfinal|semi(?:final)?|final)\s*(\d*)/i)?.[0];
        const qNumT = tStage.match(/(?:quarterfinal|semi(?:final)?|final)\s*(\d*)/i)?.[0];
        if (qNumM && qNumT && qNumM.toLowerCase() !== qNumT.toLowerCase()) {
          return false;
        }
        return true;
      }

      return mStage === tStage;
    });
  };

  // Find all matches in current that match any target (including duplicates)
  const allMatchesToDelete = current.filter(isMatchingSameMatchup);
  const allIdsToDelete = Array.from(new Set([
    ...matchIds,
    ...allMatchesToDelete.map((m) => m.id),
  ]));

  // 1. Immediately remove from local matches
  const retained = current.filter((m) => !isMatchingSameMatchup(m));
  saveMatches(retained, false);

  // 2. Delete all matching match records from Supabase database in batch
  try {
    await dbDeleteMatchesBatch(allIdsToDelete);
    if (categoryId) {
      await dbDeleteMatchesForCategory(tournamentSlug, categoryId, true);
    }
    // Also delete by team pairs to eliminate any orphaned cloud ghost records
    for (const t of explicitTargets) {
      if (t.teamAName && t.teamBName) {
        await dbDeleteMatchesForPair(tournamentSlug, t.teamAName, t.teamBName);
      }
    }
  } catch (err) {
    console.warn("[MatchStore] Error deleting matches from cloud:", err);
  }

  // 3. Clear/Reset corresponding entries in Main Draw Knockout storage
  if (typeof localStorage !== "undefined") {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`dv_main_draw_${tournamentSlug}_`)) {
          const raw = localStorage.getItem(k);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              let modified = false;
              const updated = parsed.map((km: any) => {
                const na = km.teamA?.name?.trim().toLowerCase();
                const nb = km.teamB?.name?.trim().toLowerCase();
                const isTarget = explicitTargets.some((t) => {
                  const ta = t.teamAName?.trim().toLowerCase();
                  const tb = t.teamBName?.trim().toLowerCase();
                  return (na === ta && nb === tb) || (na === tb && nb === ta);
                });
                if (isTarget) {
                  modified = true;
                  return { ...km, scoreA: undefined, scoreB: undefined, winner: undefined };
                }
                return km;
              });
              if (modified) {
                localStorage.setItem(k, JSON.stringify(updated));
                const catSuffix = k.replace(`dv_main_draw_${tournamentSlug}_`, "");
                dbSaveMainDraw(tournamentSlug, catSuffix, updated).catch(() => {});
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 4. Dispatch real-time update events across all tabs, spectator views, and umpire screens
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("dv_matches_updated"));
    window.dispatchEvent(new Event("dv_live_matches_updated"));
    window.dispatchEvent(new Event("dv_main_draw_updated"));
    window.dispatchEvent(new Event("storage"));
  }

  return { deletedCount: allIdsToDelete.length };
}

