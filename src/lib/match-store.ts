import { useState, useEffect, useCallback, useMemo } from "react";
import {
  dbGetMatches,
  dbSaveMatch,
  dbSaveMatchesBatch,
  dbDeleteMatch,
  dbDeleteMatchesBatch,
  dbDeleteMatchesForCategory,
  dbPurgeCompletedMatches,
  dbSaveMainDraw,
  dbClearAllMatches,
  dbSubscribeToLive,
  flushOfflineScoreJournal,
  getCachedDrawnGroups,
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
  activeServerBase?: 1 | 2 | undefined;
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
  teamASide?: "left" | "right" | undefined;
  courtPositionUpdatedAt?: number | undefined;
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
  if (!ma || !mb) {
    return false;
  }

  // 1. Exact ID match (must run BEFORE same-name checks so valid n/a vs n/a or shared-club matches always resolve)
  if (m.id === stationMatchId) {
    return true;
  }

  // Reject only true self-matchups (identical pair playing itself), never distinct pairs sharing "n/a" or a club name
  if (isSelfMatchup(m)) {
    return false;
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

  // Enforce strict stage alignment before any non-disambiguated or delimiter fallback matching
  const lowerStation = stationMatchId.toLowerCase();
  let normStage = "";
  if (m.stage) {
    let cleanStage = m.stage.trim().toLowerCase();
    const poolLetterMatch = cleanStage.match(/(?:bracket|pool)\s*([a-z])\b/i);
    if (poolLetterMatch) {
      cleanStage = `bracket-${poolLetterMatch[1]!.toLowerCase()}`;
    }
    normStage = cleanStage.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  if (lowerStation.startsWith("match-") && normStage) {
    if (!lowerStation.includes(`-${normStage}-`)) {
      return false;
    }
  } else if (lowerStation.startsWith("live-ko-") && m.stage) {
    const stationKoNum = lowerStation.match(/-(?:r16|qf|sf)-(\d+)$/i)?.[1] ?? null;
    const matchKoNum = getKnockoutMatchNumber(m.stage);
    if (stationKoNum && matchKoNum && stationKoNum !== matchKoNum) {
      return false;
    }
  }

  const isAmbiguousName =
    ma === mb || isGenericTeamName(m.teamAName) || isGenericTeamName(m.teamBName);
  const isSpecificKnockoutStage =
    Boolean(m.stage && isKnockoutStageString(m.stage)) &&
    Boolean(normStage && (getKnockoutMatchNumber(m.stage!) !== null || /final|bronze|championship|gold/.test(normStage)));

  // 4. Non-disambiguated canonical pair matches (without player names in ID)
  // Only allowed when team names are non-generic/distinct OR the knockout stage uniquely identifies the single bracket slot
  if (!isAmbiguousName || isSpecificKnockoutStage) {
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

  // 5. Fallback: Support both "-vs-" and "_vs_" delimiters in station ID with strict side & player verification
  const vsDelimiter = lowerStation.includes("-vs-") ? "-vs-" : lowerStation.includes("_vs_") ? "_vs_" : null;
  if (vsDelimiter) {
    const parts = lowerStation.split(vsDelimiter);
    if (parts.length === 2) {
      let side0Raw = parts[0]!;
      const side1Raw = parts[1]!;

      if (normStage) {
        const stageMarker = `-${normStage}-`;
        const markerIdx = side0Raw.indexOf(stageMarker);
        if (markerIdx !== -1) {
          side0Raw = side0Raw.slice(markerIdx + stageMarker.length);
        } else if (lowerStation.startsWith("match-")) {
          return false;
        }
      }

      const normSide0 = side0Raw.replace(/[^a-z0-9]/g, "");
      const normSide1 = side1Raw.replace(/[^a-z0-9]/g, "");

      const extractPlayerTokens = (players: string[] | undefined, teamSlug: string): string[] =>
        (players || [])
          .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
          .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
          .filter((p) => Boolean(p) && !isGenericTeamName(p))
          .map((p) => p.replace(/[^a-z0-9]/g, ""))
          .filter((p) => p.length > 2 && p !== teamSlug);

      const paTokens = extractPlayerTokens(m.teamAPlayers, ma);
      const pbTokens = extractPlayerTokens(m.teamBPlayers, mb);

      const doesSideMatch = (
        teamSlug: string,
        rawName: string,
        pTokens: string[],
        targetSide: string,
      ): boolean => {
        if (!targetSide) return false;
        // If station side was not stripped to just the team segment (legacy IDs without normStage), verify teamSlug boundary
        const hasStageStripped = Boolean(normStage && lowerStation.includes(`-${normStage}-`));
        const sideSegment = hasStageStripped
          ? targetSide
          : targetSide.endsWith(teamSlug)
            ? teamSlug
            : targetSide;

        if (!sideSegment.startsWith(teamSlug) && !targetSide.includes(teamSlug)) {
          return false;
        }

        const extraChars = hasStageStripped ? sideSegment.slice(teamSlug.length) : "";
        if (extraChars.length > 0) {
          // Station side encodes player disambiguation: require ALL known player tokens for this team to appear
          if (pTokens.length === 0) {
            return !isGenericTeamName(rawName) && ma !== mb;
          }
          return pTokens.every((pt) => extraChars.includes(pt));
        }

        // Station side has NO player disambiguation
        if (isGenericTeamName(rawName) || ma === mb) {
          return isSpecificKnockoutStage;
        }
        return hasStageStripped ? sideSegment === teamSlug : true;
      };

      const matchesNormal =
        doesSideMatch(ma, m.teamAName, paTokens, normSide0) &&
        doesSideMatch(mb, m.teamBName, pbTokens, normSide1);
      const matchesReverse =
        doesSideMatch(mb, m.teamBName, pbTokens, normSide0) &&
        doesSideMatch(ma, m.teamAName, paTokens, normSide1);

      if (matchesNormal || matchesReverse) {
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
      if (
        isPoolMatch &&
        !isMatchInSameBracket(
          match.tournamentSlug || "",
          match.categoryId || "",
          match.stage,
          match.teamAName,
          match.teamBName,
          undefined,
          undefined,
          match.teamAPlayers,
          match.teamBPlayers,
        )
      ) {
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
export const _recentlyDeletedMatchIds = new Map<string, number>();

export function markLocalMatchMutation(matchId: string): void {
  _lastLocalMutationAt.set(matchId, Date.now());
}

export function getLocalMatchMutationAt(matchId: string): number {
  return _lastLocalMutationAt.get(matchId) ?? 0;
}

export function markLocalMatchDeleted(matchId: string): void {
  if (!matchId) return;
  _recentlyDeletedMatchIds.set(matchId, Date.now());
}

export function isRecentlyDeletedMatch(matchId: string, ttlMs = 10000): boolean {
  const deletedAt = _recentlyDeletedMatchIds.get(matchId);
  if (!deletedAt) return false;
  if (Date.now() - deletedAt > ttlMs) {
    _recentlyDeletedMatchIds.delete(matchId);
    return false;
  }
  return true;
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
  markLocalMatchDeleted(matchId);
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
  matchOrId: string | LiveMatch | { id: string; teamAName?: string; teamBName?: string; court?: string; status?: string },
  matchStatus?: string,
): string {
  if (!court || court === "Queue") return "Queue";
  const effectiveStatus =
    matchStatus || (typeof matchOrId === "object" ? matchOrId.status : undefined);
  // Completed / final matches keep the historical court where they were played
  if (effectiveStatus === "final") {
    return sanitizeCourtName(court);
  }
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

function buildNormalizedSideToken(teamName?: string | null, players?: string[] | null): string {
  const cleanTeam = (teamName || "").replace(/\s+/g, " ").trim().toLowerCase();
  const cleanedPlayers = (players || [])
    .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
    .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((p) => Boolean(p) && !isGenericTeamName(p));
  const distinctPlayers =
    cleanedPlayers.length === 1 && cleanedPlayers[0] === cleanTeam ? [] : cleanedPlayers;
  const pToken = distinctPlayers
    .map((p) => p.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean)
    .sort()
    .join(",");
  if (pToken) {
    return `[${pToken}]`;
  }
  return cleanTeam;
}

function areMatchSidesAligned(a: LiveMatch, b: LiveMatch): boolean {
  const aSide1 = buildNormalizedSideToken(a.teamAName, a.teamAPlayers);
  const aSide2 = buildNormalizedSideToken(a.teamBName, a.teamBPlayers);
  const bSide1 = buildNormalizedSideToken(b.teamAName, b.teamAPlayers);
  const bSide2 = buildNormalizedSideToken(b.teamBName, b.teamBPlayers);
  if (aSide1 && aSide2 && bSide1 && bSide2 && aSide1 !== aSide2) {
    if (aSide1 === bSide2 || aSide2 === bSide1) return false;
  }
  return true;
}

/**
 * Safely merges cloud matches with local matches.
 * Protects local live match status and in-progress scoring from being overwritten by stale cloud state.
 */
function mergeMatchesSafely(cloudMatches: LiveMatch[], localMatches: LiveMatch[]): LiveMatch[] {
  const activeCloudMatches = cloudMatches.filter((cm) => !isRecentlyDeletedMatch(cm.id));
  const localMapById = new Map<string, LiveMatch>();
  const localMapByPair = new Map<string, LiveMatch>();

  const computeMergePairKey = (m: LiveMatch): string | null => {
    const sideA = buildNormalizedSideToken(m.teamAName, m.teamAPlayers);
    const sideB = buildNormalizedSideToken(m.teamBName, m.teamBPlayers);
    if (!sideA || !sideB) return null;
    if (sideA === sideB) {
      return m.id || null;
    }
    const pair = [sideA, sideB].sort().join("::");
    const bracket =
      m.stage && isKnockoutStageString(m.stage)
        ? `ko-${getKnockoutRoundType(m.stage)}-${m.stage.trim().toLowerCase()}`
        : (m.stage || "").match(/(?:bracket|pool)\s*([a-z])\b/i)?.[1]?.toLowerCase() || (m.bracketLetter ? m.bracketLetter.toLowerCase() : "pool");
    const hasBothPlayers = Boolean(m.teamAPlayers?.length && m.teamBPlayers?.length);
    if (m.id.startsWith("match_") && !hasBothPlayers) {
      return m.id;
    }
    return `${m.tournamentSlug || "event"}::${m.categoryId || "division"}::${bracket}::${pair}`;
  };

  for (const lm of localMatches) {
    localMapById.set(lm.id, lm);
    const pairKey = computeMergePairKey(lm);
    if (pairKey) {
      localMapByPair.set(pairKey, lm);
    }
  }

  const matchedLocalIds = new Set<string>();

  const mergedCloud: LiveMatch[] = activeCloudMatches.map((cm): LiveMatch => {
    let lm = localMapById.get(cm.id);
    if (!lm) {
      const pairKey = computeMergePairKey(cm);
      if (pairKey) {
        lm = localMapByPair.get(pairKey);
      }
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
        teamASide: lm.teamASide,
        courtPositionUpdatedAt: lm.courtPositionUpdatedAt,
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
      const aligned = areMatchSidesAligned(cm, lm);
      const fallbackAName = aligned ? lm.teamAName : lm.teamBName;
      const fallbackBName = aligned ? lm.teamBName : lm.teamAName;
      const fallbackAPlayers = aligned ? lm.teamAPlayers : lm.teamBPlayers;
      const fallbackBPlayers = aligned ? lm.teamBPlayers : lm.teamAPlayers;
      const preferredCourt = (cm.court && cm.court !== "Queue" ? cm.court : lm.court) || "Queue";
      return {
        ...cm,
        id: cm.id || lm.id,
        status: "final",
        court: sanitizeCourtAssignment(preferredCourt, cm, "final"),
        tournamentSlug: cm.tournamentSlug || lm.tournamentSlug,
        categoryId: cm.categoryId || lm.categoryId,
        teamAName: cm.teamAName || fallbackAName,
        teamBName: cm.teamBName || fallbackBName,
        teamAPlayers: cm.teamAPlayers?.length ? cm.teamAPlayers : fallbackAPlayers,
        teamBPlayers: cm.teamBPlayers?.length ? cm.teamBPlayers : fallbackBPlayers,
      };
    }
    if (isLocalFinal) {
      // Only preserve local final status if it is an offline score pending sync to cloud.
      // If the cloud already reports this match as scheduled (e.g. after history was cleared or reset by Admin),
      // the cloud ground truth prevails and resets the local match to scheduled.
      let isPendingOfflineSync = false;
      if (typeof localStorage !== "undefined") {
        try {
          const rawJournal = localStorage.getItem("dv_offline_score_journal");
          if (rawJournal) {
            const parsedJournal = JSON.parse(rawJournal);
            isPendingOfflineSync = Boolean(parsedJournal[lm.id] || parsedJournal[cm.id]);
          }
        } catch {}
      }

      if (isPendingOfflineSync) {
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
      // Otherwise, match history was cleared/reset in cloud: adopt cloud's clean scheduled status
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

    // Position & Side Conflict Resolution (Base 1/2 & Left/Right ends):
    const localPosAt = lm.courtPositionUpdatedAt ?? 0;
    const cloudPosAt = cm.courtPositionUpdatedAt ?? 0;
    const preferCloudPosition =
      cloudPosAt > localPosAt ||
      (cloudPosAt === localPosAt &&
        !isRecentLocalMutation &&
        Boolean(cm.teamABase1Player || cm.teamBBase1Player || cm.teamASide));

    const resolvedBase1A = preferCloudPosition
      ? (cm.teamABase1Player ?? lm.teamABase1Player)
      : (lm.teamABase1Player ?? cm.teamABase1Player);
    const resolvedBase1B = preferCloudPosition
      ? (cm.teamBBase1Player ?? lm.teamBBase1Player)
      : (lm.teamBBase1Player ?? cm.teamBBase1Player);
    const resolvedSide = preferCloudPosition
      ? (cm.teamASide ?? lm.teamASide)
      : (lm.teamASide ?? cm.teamASide);
    const resolvedTossDone = preferCloudPosition
      ? (cm.tossDone ?? lm.tossDone)
      : (lm.tossDone ?? cm.tossDone);
    const resolvedTossWinner = preferCloudPosition
      ? (cm.tossWinner ?? lm.tossWinner)
      : (lm.tossWinner ?? cm.tossWinner);
    const resolvedPosAt = Math.max(localPosAt, cloudPosAt) || undefined;

    if (preferCloudPosition && typeof localStorage !== "undefined") {
      try {
        if (resolvedBase1A) localStorage.setItem(`dv_base1_A_${lm.id}`, resolvedBase1A);
        if (resolvedBase1B) localStorage.setItem(`dv_base1_B_${lm.id}`, resolvedBase1B);
        if (resolvedSide) localStorage.setItem(`dv_court_side_${lm.id}`, resolvedSide);
      } catch {}
    }

    const aligned = areMatchSidesAligned(cm, lm);
    const useLocalScore = chosenScore === lm.score && !aligned;
    const primaryA = useLocalScore ? lm : cm;
    const secondaryA = useLocalScore ? cm : (aligned ? lm : {
      ...lm,
      teamAName: lm.teamBName,
      teamBName: lm.teamAName,
      teamAPlayers: lm.teamBPlayers,
      teamBPlayers: lm.teamAPlayers,
      teamAClub: lm.teamBClub,
      teamBClub: lm.teamAClub,
    });

    return {
      ...cm,
      id: lm.id,
      court: chosenCourt,
      status: chosenStatus,
      score: chosenScore,
      tournamentSlug: cm.tournamentSlug || lm.tournamentSlug,
      categoryId: cm.categoryId || lm.categoryId,
      teamAName: primaryA.teamAName || secondaryA.teamAName,
      teamBName: primaryA.teamBName || secondaryA.teamBName,
      teamAPlayers: primaryA.teamAPlayers?.length ? primaryA.teamAPlayers : secondaryA.teamAPlayers,
      teamBPlayers: primaryA.teamBPlayers?.length ? primaryA.teamBPlayers : secondaryA.teamBPlayers,
      teamAClub: primaryA.teamAClub ?? secondaryA.teamAClub,
      teamBClub: primaryA.teamBClub ?? secondaryA.teamBClub,
      tossDone: resolvedTossDone,
      tossWinner: resolvedTossWinner,
      teamABase1Player: resolvedBase1A,
      teamBBase1Player: resolvedBase1B,
      teamASide: resolvedSide,
      courtPositionUpdatedAt: resolvedPosAt,
      officiatedBy: cm.officiatedBy || lm.officiatedBy,
      startedAt: cm.startedAt || lm.startedAt,
    };
  });

  // 3. Preserve locally dispatched, active, or in-flight matches not yet acknowledged by cloud
  for (const lm of localMatches) {
    if (!matchedLocalIds.has(lm.id)) {
      // Completed / final matches must NEVER be resurrected if they don't exist in cloud (unless pending offline score sync)
      if (lm.status === "final") {
        let isPendingOffline = false;
        if (typeof localStorage !== "undefined") {
          try {
            const rawJournal = localStorage.getItem("dv_offline_score_journal");
            if (rawJournal) {
              const journal = JSON.parse(rawJournal);
              isPendingOffline = Boolean(journal[lm.id]);
            }
          } catch {}
        }
        if (isPendingOffline) {
          mergedCloud.push(lm);
        }
        continue;
      }

      const isActivelyOnCourt =
        Boolean(lm.court &&
        lm.court !== "Queue" &&
        sanitizeCourtAssignment(lm.court, lm, lm.status) !== "Queue");
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
    const pairKey = computeMergePairKey(m) || m.id;

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
    const knownTourneyCategoryIds = new Set<string>();
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
        const rawTourneys = localStorage.getItem("dv_tournaments_offline_cache") || localStorage.getItem("dv_tournaments");
        if (rawTourneys) {
          const parsedTourneys = JSON.parse(rawTourneys);
          if (Array.isArray(parsedTourneys)) {
            const targetT = parsedTourneys.find((t: any) => t?.slug === effectiveSlug);
            if (targetT?.categories && Array.isArray(targetT.categories)) {
              for (const c of targetT.categories) {
                if (c?.id) knownTourneyCategoryIds.add(String(c.id).toLowerCase());
                if (c?.category_slug) knownTourneyCategoryIds.add(String(c.category_slug).toLowerCase());
                if (c?.uuid) knownTourneyCategoryIds.add(String(c.uuid).toLowerCase());
              }
            }
          }
        }
      } catch {}
    }

    return allMatches.filter((m) => {
      // Retain any ACTIVE (non-final) match actively occupying or assigned to a facility court station
      if (m.status !== "final") {
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
      }
      if (m.tournamentSlug) {
        return m.tournamentSlug === effectiveSlug;
      }
      if (m.id.includes(effectiveSlug)) {
        return true;
      }
      if (m.categoryId && knownTourneyCategoryIds.size > 0) {
        const cleanCat = m.categoryId.trim().toLowerCase();
        if (knownTourneyCategoryIds.has(cleanCat)) return true;
        for (const knownCat of knownTourneyCategoryIds) {
          if (isSameCategory(cleanCat, knownCat)) return true;
        }
      }
      return false;
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
    activeServerBase: 1,
    rallies: [],
  };
}

export function generateMockMatches(): LiveMatch[] {
  return [];
}

/* ─────────────────────────────────────────────
   Pickleball doubles active server base derivation
   (B1 vs B2 court & server rotation rules)
───────────────────────────────────────────── */

/**
 * Deterministically derives the active server base (1 or 2) in pickleball doubles.
 * - Score is EVEN -> B1 is on Right court, B2 is on Left court.
 * - Score is ODD -> B2 is on Right court, B1 is on Left court.
 * - At match start (0-0-2): activeServerBase = 1 (B1 on Right).
 * - After a Side-Out: whoever is on the Right court becomes Server #1.
 * - On 1st fault (serverNumber 1 -> 2): activeServerBase flips to partner.
 * - Points scored: activeServerBase continues serving.
 */
export function deriveActiveServerBase(score: LiveScore): 1 | 2 {
  const rallies = score.rallies || [];
  const hasSideOut = rallies.some((r) => r.type === "side_out" || (r as any).type === "sideout" || r.type === "fault");

  // 1. Hard guard for opening serve of the game (0-0-2 before any side-out):
  // The Right-court player (Base 1) ALWAYS serves first at 0-0-2, regardless of whether Team A or Team B won the toss!
  if (score.teamAScore === 0 && score.teamBScore === 0 && score.serverNumber === 2 && !hasSideOut) {
    return 1;
  }

  // 2. If explicit activeServerBase is set on score in memory, use it:
  if (score.activeServerBase === 1 || score.activeServerBase === 2) {
    return score.activeServerBase;
  }

  // 3. If no rallies yet at 0-0, Right court (Base 1) always serves:
  if (rallies.length === 0) {
    return 1;
  }

  // 4. Deterministically replay rallies from game start (0-0-2, activeBase = 1):
  // Infer who served first from the first rally event:
  const firstRally = rallies[0]!;
  let curServingTeam: ServingTeam =
    firstRally.type === "point"
      ? firstRally.servingTeam
      : firstRally.scoreSnapshot?.[2] === 1
      ? (firstRally.servingTeam === "A" ? "B" : "A") // Side-out on opening 0-0-2 switched to the other team at server #1
      : firstRally.servingTeam;

  let curServerNumber: 1 | 2 = 2;
  let curActiveBase: 1 | 2 = 1;
  let teamAScore = 0;
  let teamBScore = 0;

  for (const rally of rallies) {
    if (rally.type === "point") {
      curServingTeam = rally.servingTeam;
      if (curServingTeam === "A") teamAScore++;
      else teamBScore++;
      // Server swaps sides and keeps serving -> curActiveBase does NOT change!
    } else if (rally.type === "side_out" || (rally as any).type === "sideout" || rally.type === "fault") {
      const nextServerNum = (rally.scoreSnapshot?.[2] as 1 | 2 | undefined) ?? (curServerNumber === 2 ? 1 : 2);
      if (rally.servingTeam === curServingTeam && nextServerNum === 2) {
        // 1st server -> 2nd server on the same team: flip to partner on opposite court!
        curServerNumber = 2;
        curActiveBase = curActiveBase === 1 ? 2 : 1;
      } else {
        // Side-out to the opposing team (Server #1):
        curServingTeam = rally.servingTeam;
        curServerNumber = 1;
        const newTeamScore = curServingTeam === "A" ? teamAScore : teamBScore;
        // Whoever is currently standing on the Right court for the new serving team is Server #1:
        curActiveBase = newTeamScore % 2 === 0 ? 1 : 2;
      }
    }
  }

  return curActiveBase;
}

/* ─────────────────────────────────────────────
   Canonical 2D Court Player & Base Positioning
───────────────────────────────────────────── */

export interface CourtPlayerInfo {
  name: string;
  base: 1 | 2;
  isServing: boolean;
  isReceiver: boolean;
}

export interface TeamCourtPositions {
  right: CourtPlayerInfo;
  left: CourtPlayerInfo;
  isSingles: boolean;
}

/**
 * Resolves a team's player array cleanly even when players were entered as a single
 * slash/ampersand-separated string (e.g. ["Gary / Janis"]) or omitted with a paired teamName.
 */
export function resolveMatchTeamPlayers(
  players: string[] | undefined,
  teamName: string | undefined,
  fallbackLabel: string,
): string[] {
  const normWhitespace = (s: string) => s.replace(/\s+/g, " ").trim();
  const cleaned = (players || []).map((p) => normWhitespace(String(p))).filter(Boolean);
  if (cleaned.length >= 2) {
    return cleaned;
  }
  if (cleaned.length === 1 && /\s*[\/&]\s*/.test(cleaned[0]!)) {
    const split = cleaned[0]!.split(/\s*[\/&]\s*/).map((s) => normWhitespace(s)).filter(Boolean);
    if (split.length >= 2) return split;
  }
  const cleanTeam = normWhitespace(teamName || "");
  if (cleaned.length <= 1 && cleanTeam && /\s*[\/&]\s*/.test(cleanTeam)) {
    const splitTeam = cleanTeam.split(/\s*[\/&]\s*/).map((s) => normWhitespace(s)).filter(Boolean);
    if (splitTeam.length >= 2) {
      if (cleaned.length === 0 || cleaned[0]!.toLowerCase() === cleanTeam.toLowerCase()) {
        return splitTeam;
      }
    }
  }

  // Fallback: Check registered tournament categories in localStorage cache if player names are missing
  if (cleanTeam && !isGenericTeamName(cleanTeam) && typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem("dv_tournaments_offline_cache") || localStorage.getItem("dv_tournaments");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const normTeam = cleanTeam.toLowerCase();
          for (const t of parsed) {
            for (const cat of (t.categories || [])) {
              for (const tm of (cat.teams || [])) {
                const tmName = normWhitespace(tm.name || "").toLowerCase();
                const tmId = normWhitespace(tm.id || "").toLowerCase();
                const tmClub = normWhitespace(tm.club || "").toLowerCase();
                const isMatch =
                  tmName === normTeam ||
                  tmId === normTeam ||
                  (cleaned.length === 1 && (tmName === cleaned[0]!.toLowerCase() || tmId === cleaned[0]!.toLowerCase())) ||
                  (tmClub && tmClub === normTeam);
                if (isMatch && Array.isArray(tm.players) && tm.players.length > 0) {
                  const tmClean = tm.players
                    .flatMap((p: any) => String(p).split(/\s*[\/&]\s*/))
                    .map((p: string) => normWhitespace(p))
                    .filter(Boolean);
                  if (tmClean.length >= 2) return tmClean;
                  if (tmClean.length === 1 && tmClean[0]!.toLowerCase() !== normTeam) {
                    return tmClean;
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // ignore parsing or storage exceptions
    }
  }

  if (cleaned.length > 0) {
    if (fallbackLabel === "" && cleaned.length === 1 && cleaned[0]!.toLowerCase() === cleanTeam.toLowerCase()) {
      return [];
    }
    return cleaned;
  }
  return fallbackLabel ? [cleanTeam || fallbackLabel] : [];
}

export interface MatchTeamDisplayInfo {
  primary: string;
  secondary?: string;
  combined: string;
  players: string[];
  hasDistinctPlayers: boolean;
}

export function isGenericTeamName(teamName?: string | null): boolean {
  if (!teamName) return true;
  const t = teamName.replace(/\s+/g, " ").trim().toLowerCase();
  return ["n/a", "na", "tbd", "tba", "null", "undefined", "none", "-", "team a", "team b"].includes(t);
}

export function getMatchTeamDisplay(
  teamName: string | undefined | null,
  players: string[] | undefined | null,
  fallbackLabel: string = "Team"
): MatchTeamDisplayInfo {
  const cleanTeam = (teamName || "").replace(/\s+/g, " ").trim();
  const generic = isGenericTeamName(cleanTeam);

  const resolvedPlayers = resolveMatchTeamPlayers(players ?? undefined, cleanTeam, "");
  const playersString = resolvedPlayers.join(" / ");
  const hasDistinctPlayers =
    resolvedPlayers.length > 0 &&
    resolvedPlayers.some((p) => p.toLowerCase() !== cleanTeam.toLowerCase());

  const isTeamNameSameAsPlayers =
    cleanTeam.toLowerCase() === playersString.toLowerCase() ||
    cleanTeam.replace(/\s*[\/&]\s*/g, " / ").toLowerCase() === playersString.toLowerCase();

  if (generic) {
    if (resolvedPlayers.length > 0) {
      return {
        primary: playersString,
        combined: playersString,
        players: resolvedPlayers,
        hasDistinctPlayers: true,
      };
    }
    return {
      primary: fallbackLabel,
      combined: fallbackLabel,
      players: [],
      hasDistinctPlayers: false,
    };
  }

  if (hasDistinctPlayers && !isTeamNameSameAsPlayers) {
    return {
      primary: cleanTeam,
      secondary: playersString,
      combined: `${cleanTeam} (${playersString})`,
      players: resolvedPlayers,
      hasDistinctPlayers: true,
    };
  }

  return {
    primary: cleanTeam || fallbackLabel,
    combined: cleanTeam || fallbackLabel,
    players: resolvedPlayers,
    hasDistinctPlayers: false,
  };
}

/**
 * Returns true ONLY when a match represents the exact same pair playing against itself.
 * Distinct pairs that both registered with generic names ("n/a") or shared club names ("powerhouse")
 * are NEVER treated as self-matchups when their player rosters differ.
 */
export function isSelfMatchup(
  m: Pick<LiveMatch, "teamAName" | "teamBName" | "teamAPlayers" | "teamBPlayers">,
): boolean {
  const cleanA = (m.teamAName || "").replace(/\s+/g, " ").trim().toLowerCase();
  const cleanB = (m.teamBName || "").replace(/\s+/g, " ").trim().toLowerCase();
  const normP = (arr?: string[]) =>
    (arr || [])
      .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
      .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter((p) => Boolean(p) && !isGenericTeamName(p))
      .sort()
      .join(",");
  const pA = normP(m.teamAPlayers);
  const pB = normP(m.teamBPlayers);
  if (pA && pB) {
    return pA === pB;
  }
  if (!cleanA || !cleanB) return false;
  if (!pA && !pB && !isGenericTeamName(cleanA)) {
    return cleanA === cleanB;
  }
  return false;
}

/**
 * Resolves the winning side ("A" | "B" | null) using final numerical score first,
 * falling back to unique winnerTeam string matching only when scores are tied/0-0.
 * Prevents double-winner badges when both sides have generic ("n/a") or shared club names.
 */
export function resolveMatchWinnerSide(
  m: Pick<LiveMatch, "score" | "winnerTeam" | "teamAName" | "teamBName" | "teamAPlayers" | "teamBPlayers">,
): "A" | "B" | null {
  const scoreA = m.score?.teamAScore ?? 0;
  const scoreB = m.score?.teamBScore ?? 0;
  if (scoreA > scoreB) return "A";
  if (scoreB > scoreA) return "B";

  const w = (m.winnerTeam || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!w) return null;

  const dispA = getMatchTeamDisplay(m.teamAName, m.teamAPlayers, "Team A");
  const dispB = getMatchTeamDisplay(m.teamBName, m.teamBPlayers, "Team B");
  const rawA = (m.teamAName || "").replace(/\s+/g, " ").trim().toLowerCase();
  const rawB = (m.teamBName || "").replace(/\s+/g, " ").trim().toLowerCase();

  const matchA =
    w === rawA ||
    w === dispA.primary.replace(/\s+/g, " ").trim().toLowerCase() ||
    w === dispA.combined.replace(/\s+/g, " ").trim().toLowerCase();
  const matchB =
    w === rawB ||
    w === dispB.primary.replace(/\s+/g, " ").trim().toLowerCase() ||
    w === dispB.combined.replace(/\s+/g, " ").trim().toLowerCase();

  if (matchA && !matchB) return "A";
  if (matchB && !matchA) return "B";
  return null;
}

export function getCanonicalCompletedMatchKey(
  m: LiveMatch,
  categories?: Array<{ id: string; category_slug?: string | undefined; uuid?: string | undefined }>,
): string {
  let catKey = m.categoryId || "cat";
  if (categories && categories.length > 0) {
    const matchedCat = categories.find((c) => {
      if (m.categoryId) {
        return (
          isSameCategory(m.categoryId, c.id) ||
          Boolean(c.category_slug && isSameCategory(m.categoryId, c.category_slug)) ||
          Boolean(c.uuid && isSameCategory(m.categoryId, c.uuid))
        );
      }
      if (m.id?.startsWith("match_")) {
        const seg = m.id.match(/^match_(.+?)_(?:[A-Z]|PLAYOFF|KO)_/i)?.[1];
        if (seg) {
          return (
            isSameCategory(seg, c.id) ||
            Boolean(c.category_slug && isSameCategory(seg, c.category_slug)) ||
            Boolean(c.uuid && isSameCategory(seg, c.uuid))
          );
        }
      }
      return false;
    });
    if (matchedCat) {
      catKey = matchedCat.id;
    }
  }

  const rawStage = (m.stage || "").trim();
  const rawId = (m.id || "").toLowerCase();
  const isKO =
    isKnockoutStageString(rawStage) ||
    /(?:quarterfinal|semifinal|playoff|-qf-|-sf-|_qf_|_sf_)/i.test(rawId);

  let stageKey: string;
  if (isKO) {
    stageKey = `ko-${getKnockoutRoundType(rawStage || rawId)}-${rawStage.toLowerCase()}`;
  } else {
    const letter =
      m.bracketLetter?.trim().toLowerCase() ||
      rawStage.match(/(?:bracket|pool)\s*([a-z])\b/i)?.[1]?.toLowerCase() ||
      rawId.match(/[-_](?:bracket|b)[-_]?([a-z])\b/i)?.[1]?.toLowerCase();
    stageKey = letter ? `bracket-${letter}` : (rawStage.toLowerCase() || "pool");
  }

  const sideA = buildNormalizedSideToken(m.teamAName, m.teamAPlayers);
  const sideB = buildNormalizedSideToken(m.teamBName, m.teamBPlayers);
  if (!sideA || !sideB || sideA === sideB) {
    return m.id;
  }
  const pair = [sideA, sideB].sort().join("::");
  return `${catKey}::${stageKey}::${pair}`;
}

/**
 * Single authoritative deduplicator for completed tournament matches shared across
 * MatchHistory, CourtDispatch badges/tabs, and category completion metrics.
 */
export function deduplicateCompletedMatches(
  matches: LiveMatch[],
  options?: {
    tournamentSlug?: string | undefined;
    categories?: Array<{ id: string; category_slug?: string | undefined; uuid?: string | undefined }> | undefined;
  },
): LiveMatch[] {
  const targetSlug = options?.tournamentSlug;
  const categories = options?.categories;

  const isMatchingSlug = (slugA?: string, slugB?: string) => {
    if (!slugA || !slugB) return true;
    if (slugA === slugB) return true;
    const a = slugA.trim().toLowerCase();
    const b = slugB.trim().toLowerCase();
    if (a === b) return true;
    const isDvA = a === "dink-valley" || a === "dink-valley-tournament" || a === "dv";
    const isDvB = b === "dink-valley" || b === "dink-valley-tournament" || b === "dv";
    return isDvA && isDvB;
  };

  const filtered = matches.filter((m) => {
    const isCompleted = m.status === "final" || Boolean(m.winnerTeam) || Boolean(m.endedAt);
    if (!isCompleted) return false;
    if (isSelfMatchup(m)) return false;

    if (targetSlug) {
      if (m.tournamentSlug) {
        if (!isMatchingSlug(m.tournamentSlug, targetSlug)) return false;
      } else if (categories && categories.length > 0 && m.categoryId) {
        const belongsToKnownCategory = categories.some(
          (c) =>
            isSameCategory(m.categoryId!, c.id) ||
            Boolean(c.category_slug && isSameCategory(m.categoryId!, c.category_slug)) ||
            Boolean(c.uuid && isSameCategory(m.categoryId!, c.uuid)),
        );
        if (!belongsToKnownCategory) return false;
      }
    }
    return true;
  });

  const byKey = new Map<string, LiveMatch>();
  for (const m of filtered) {
    const key = getCanonicalCompletedMatchKey(m, categories);
    if (!byKey.has(key)) {
      byKey.set(key, m);
    } else {
      const existing = byKey.get(key)!;
      const existingScore = (existing.score?.teamAScore ?? 0) + (existing.score?.teamBScore ?? 0);
      const mScore = (m.score?.teamAScore ?? 0) + (m.score?.teamBScore ?? 0);
      const existingRallies = existing.score?.rallies?.length ?? 0;
      const mRallies = m.score?.rallies?.length ?? 0;

      const stageLower = (m.stage || "").toLowerCase();
      const isMStageId = (m.id || "").toLowerCase().includes("quarter") === stageLower.includes("quarter");
      const isExistingStageId = (existing.id || "").toLowerCase().includes("quarter") === stageLower.includes("quarter");

      const mWins =
        (!isExistingStageId && isMStageId) ||
        mScore > existingScore ||
        (mScore === existingScore && mRallies > existingRallies) ||
        (mScore === existingScore && mRallies === existingRallies && (m.endedAt ?? 0) > (existing.endedAt ?? 0));

      if (mWins) {
        byKey.set(key, m);
      }
    }
  }

  return Array.from(byKey.values());
}

/**
 * Canonical 2D court position calculator shared identically across Umpire Console,
 * Public Big-Screen Arena Monitor (/monitor), and Public Live Courts Board.
 */
export function computeCourtPositions(
  match: LiveMatch,
): { teamA: TeamCourtPositions; teamB: TeamCourtPositions } {
  const s = match.score;
  const isFinal = match.status === "final";
  const norm = (str: string) => str.trim().toLowerCase();

  // Team A
  const rawAPlayers = resolveMatchTeamPlayers(match.teamAPlayers, match.teamAName, "Player A1");
  const isSinglesA = rawAPlayers.length === 1;
  const localBase1A =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(`dv_base1_A_${match.id}`)
      : null;

  let candidateA1 = match.teamABase1Player?.trim() || "";
  if (!candidateA1 && localBase1A) {
    const matchedLocal = rawAPlayers.find((p) => norm(p) === norm(localBase1A));
    if (matchedLocal) candidateA1 = matchedLocal;
  }
  const aBase1 =
    (candidateA1 && (rawAPlayers.find((p) => norm(p) === norm(candidateA1)) || candidateA1)) ||
    rawAPlayers[0] ||
    "Player A1";
  const aBase2 =
    rawAPlayers.find((p) => norm(p) !== norm(aBase1)) || rawAPlayers[1] || aBase1;
  const teamAScoreEven = s.teamAScore % 2 === 0;

  // Team B
  const rawBPlayers = resolveMatchTeamPlayers(match.teamBPlayers, match.teamBName, "Player B1");
  const isSinglesB = rawBPlayers.length === 1;
  const localBase1B =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(`dv_base1_B_${match.id}`)
      : null;

  let candidateB1 = match.teamBBase1Player?.trim() || "";
  if (!candidateB1 && localBase1B) {
    const matchedLocal = rawBPlayers.find((p) => norm(p) === norm(localBase1B));
    if (matchedLocal) candidateB1 = matchedLocal;
  }
  const bBase1 =
    (candidateB1 && (rawBPlayers.find((p) => norm(p) === norm(candidateB1)) || candidateB1)) ||
    rawBPlayers[0] ||
    "Player B1";
  const bBase2 =
    rawBPlayers.find((p) => norm(p) !== norm(bBase1)) || rawBPlayers[1] || bBase1;
  const teamBScoreEven = s.teamBScore % 2 === 0;

  if (isSinglesA && isSinglesB) {
    const aOnRight = teamAScoreEven;
    const bOnRight = teamBScoreEven;
    const singlesServingCourt: "right" | "left" =
      s.servingTeam === "A"
        ? (teamAScoreEven ? "right" : "left")
        : (teamBScoreEven ? "right" : "left");
    return {
      teamA: {
        isSingles: true,
        right: {
          name: aOnRight ? aBase1 : "-",
          base: 1,
          isServing: !isFinal && s.servingTeam === "A" && aOnRight,
          isReceiver: !isFinal && s.servingTeam === "B" && singlesServingCourt === "right",
        },
        left: {
          name: !aOnRight ? aBase1 : "-",
          base: 1,
          isServing: !isFinal && s.servingTeam === "A" && !aOnRight,
          isReceiver: !isFinal && s.servingTeam === "B" && singlesServingCourt === "left",
        },
      },
      teamB: {
        isSingles: true,
        right: {
          name: bOnRight ? bBase1 : "-",
          base: 1,
          isServing: !isFinal && s.servingTeam === "B" && bOnRight,
          isReceiver: !isFinal && s.servingTeam === "A" && singlesServingCourt === "right",
        },
        left: {
          name: !bOnRight ? bBase1 : "-",
          base: 1,
          isServing: !isFinal && s.servingTeam === "B" && !bOnRight,
          isReceiver: !isFinal && s.servingTeam === "A" && singlesServingCourt === "left",
        },
      },
    };
  }

  // Doubles positioning:
  // Score EVEN -> Base 1 on Right court, Base 2 on Left court.
  // Score ODD  -> Base 2 on Right court, Base 1 on Left court.
  const aRightPlayerName = teamAScoreEven ? aBase1 : aBase2;
  const aRightBase: 1 | 2 = teamAScoreEven ? 1 : 2;
  const aLeftPlayerName = teamAScoreEven ? aBase2 : aBase1;
  const aLeftBase: 1 | 2 = teamAScoreEven ? 2 : 1;

  const bRightPlayerName = teamBScoreEven ? bBase1 : bBase2;
  const bRightBase: 1 | 2 = teamBScoreEven ? 1 : 2;
  const bLeftPlayerName = teamBScoreEven ? bBase2 : bBase1;
  const bLeftBase: 1 | 2 = teamBScoreEven ? 2 : 1;

  const activeServerBase: 1 | 2 = deriveActiveServerBase(s);

  const servingCourt: "right" | "left" =
    s.servingTeam === "A"
      ? (aRightBase === activeServerBase ? "right" : "left")
      : (bRightBase === activeServerBase ? "right" : "left");

  return {
    teamA: {
      isSingles: false,
      right: {
        name: aRightPlayerName,
        base: aRightBase,
        isServing: !isFinal && s.servingTeam === "A" && aRightBase === activeServerBase,
        isReceiver: !isFinal && s.servingTeam === "B" && servingCourt === "right",
      },
      left: {
        name: aLeftPlayerName,
        base: aLeftBase,
        isServing: !isFinal && s.servingTeam === "A" && aLeftBase === activeServerBase,
        isReceiver: !isFinal && s.servingTeam === "B" && servingCourt === "left",
      },
    },
    teamB: {
      isSingles: false,
      right: {
        name: bRightPlayerName,
        base: bRightBase,
        isServing: !isFinal && s.servingTeam === "B" && bRightBase === activeServerBase,
        isReceiver: !isFinal && s.servingTeam === "A" && servingCourt === "right",
      },
      left: {
        name: bLeftPlayerName,
        base: bLeftBase,
        isServing: !isFinal && s.servingTeam === "B" && bLeftBase === activeServerBase,
        isReceiver: !isFinal && s.servingTeam === "A" && servingCourt === "left",
      },
    },
  };
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

  // Active server continues serving (swaps courts with partner on point scored)
  s.activeServerBase = s.activeServerBase ?? deriveActiveServerBase(match.score);

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

  const currentActiveBase: 1 | 2 = s.activeServerBase ?? deriveActiveServerBase(s);

  const isGameStart =
    s.teamAScore === 0 && s.teamBScore === 0 && s.serverNumber === 1;

  let description: string;

  if (isGameStart || s.serverNumber === 2) {
    // Side out -- serve goes to other team
    s.servingTeam = s.servingTeam === "A" ? "B" : "A";
    s.serverNumber = 1;
    const newServingScore = s.servingTeam === "A" ? s.teamAScore : s.teamBScore;
    // Whoever is on the Right court for the new serving team serves first as Server #1:
    s.activeServerBase = newServingScore % 2 === 0 ? 1 : 2;
    description = `Side out. Serve to ${s.servingTeam === "A" ? match.teamAName : match.teamBName}`;
  } else {
    // Server 1 -> Server 2 on same team
    s.serverNumber = 2;
    // Serve flips to partner on opposite court:
    s.activeServerBase = currentActiveBase === 1 ? 2 : 1;
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

  const prevRallies = s.rallies.slice(0, -1);
  const firstRally = s.rallies[0]!;
  const initialServingTeam: ServingTeam =
    firstRally.type === "point"
      ? firstRally.servingTeam
      : firstRally.scoreSnapshot?.[2] === 1
      ? (firstRally.servingTeam === "A" ? "B" : "A")
      : firstRally.servingTeam;

  // Start fresh match and replay
  let replayMatch: LiveMatch = {
    ...match,
    score: {
      ...createInitialScore(),
      servingTeam: initialServingTeam,
      serverNumber: 2,
      activeServerBase: 1,
    },
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
      localStorage.removeItem(`dv_court_side_${match.id}`);
      localStorage.removeItem(`dv_base1_A_${match.id}`);
      localStorage.removeItem(`dv_base1_B_${match.id}`);
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
      activeServerBase: 1,
      rallies: [],
    },
    winnerTeam: undefined,
    startedAt: undefined,
    endedAt: undefined,
    tossDone: false,
    tossWinner: undefined,
    teamABase1Player: undefined,
    teamBBase1Player: undefined,
    teamASide: undefined,
    courtPositionUpdatedAt: Date.now(),
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
  const poolLetterMatch = cleanStage.match(/(?:bracket|pool)\s*([a-z])\b/i);
  if (poolLetterMatch) {
    cleanStage = `bracket-${poolLetterMatch[1]!.toLowerCase()}`;
  }
  const normStage = cleanStage.replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");

  let normA = (teamAName || "teama").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let normB = (teamBName || "teamb").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  const isKnockout = isKnockoutStageString(stageOrBracket || "");
  let dupA = isTeamADuplicate || isGenericTeamName(teamAName) || isKnockout;
  let dupB = isTeamBDuplicate || isGenericTeamName(teamBName) || isKnockout;

  // Auto-detect duplicate team names from drawn groups in memory cache or localStorage if not already disambiguated
  if (!dupA || !dupB) {
    try {
      let parsedGroups: any[] | null = null;
      if (tournamentSlug && categoryId) {
        const cached = getCachedDrawnGroups(tournamentSlug, categoryId);
        if (cached && Array.isArray(cached) && cached.length > 0) {
          parsedGroups = cached;
        }
      }

      if (!parsedGroups && typeof localStorage !== "undefined") {
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
          if (Array.isArray(parsed)) parsedGroups = parsed;
        }
      }

      if (parsedGroups) {
        let candidateSlots: any[] = [];
        if (poolLetterMatch) {
          const letter = poolLetterMatch[1]!.toUpperCase();
          const grp = parsedGroups.find((g: any) => (g.letter || g.bracketLetter)?.toUpperCase() === letter);
          if (grp?.slots) candidateSlots = grp.slots;
        }
        if (candidateSlots.length === 0) {
          candidateSlots = parsedGroups.flatMap((g: any) => g.slots || []);
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
    } catch {
      // ignore
    }
  }

  const extractPlayersSlug = (players: string[] | undefined, rawName: string): string => {
    const cleanName = (rawName || "").replace(/\s+/g, " ").trim().toLowerCase();
    return (players || [])
      .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
      .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
      .filter((p) => Boolean(p) && !isGenericTeamName(p) && p !== cleanName)
      .map((p) => p.replace(/[^a-z0-9]+/g, ""))
      .filter(Boolean)
      .sort()
      .join("-");
  };

  // Disambiguate using player names whenever teams share a name, use generic names ("n/a"), are in Playoffs, or have duplicates
  const shouldDisambiguateA = (normA === normB || dupA) && Boolean(teamAPlayers && teamAPlayers.length > 0);
  const shouldDisambiguateB = (normA === normB || dupB) && Boolean(teamBPlayers && teamBPlayers.length > 0);

  if (shouldDisambiguateA) {
    const pA = extractPlayersSlug(teamAPlayers, teamAName);
    if (pA) normA = `${normA}-${pA}`;
  }
  if (shouldDisambiguateB) {
    const pB = extractPlayersSlug(teamBPlayers, teamBName);
    if (pB) normB = `${normB}-${pB}`;
  }

  // Sort team names alphabetically so Team A vs Team B produces the EXACT same match ID as Team B vs Team A
  const sortedPairs = [normA, normB].sort().join("-vs-");

  return `match-${normSlug}-${normCat}-${normStage}-${sortedPairs}`;
}

function isPoolStageString(stage: string): boolean {
  const s = stage.trim().toLowerCase();
  return s.includes("pool play") || /(?:bracket|pool)\s+[a-z]\b/i.test(s);
}

function isKnockoutStageString(stage: string): boolean {
  if (isPoolStageString(stage)) return false;
  return /quarter|semi|final|playoff|bronze|gold|championship|knockout|elimination|round of|play-in/i.test(stage);
}

function getKnockoutRoundType(stage: string): "r16" | "qf" | "sf" | "bronze" | "final" | "other" {
  const s = stage.trim().toLowerCase();
  if (s.includes("round of") || s.includes("play-in") || /\br16\b|\br12\b/.test(s)) return "r16";
  if (s.includes("quarter") || /\bqf\b|\bqf\d/.test(s)) return "qf";
  if (s.includes("semi") || /\bsf\b|\bsf\d/.test(s)) return "sf";
  if (s.includes("bronze") || s.includes("3rd") || s.includes("third")) return "bronze";
  if (s.includes("final") || s.includes("gold") || s.includes("championship")) return "final";
  return "other";
}

function getKnockoutMatchNumber(stage: string): string | null {
  const cleaned = stage
    .toLowerCase()
    .replace(/\bround\s+of\s+\d+\b/g, "")
    .replace(/\b(?:1st|2nd|3rd|4th)\b/g, "");
  const m = cleaned.match(/(?:match|quarterfinal|semifinal|qf|sf|play-in)\s*#?-?\s*(\d+)\b/i);
  return m?.[1] ?? null;
}

function doesMatchBelongToCategory(m: LiveMatch, categoryId: string): boolean {
  if (m.categoryId) {
    return isSameCategory(m.categoryId, categoryId);
  }
  if (!m.id) return false;
  if (m.id.startsWith("match_")) {
    const segMatch = m.id.match(/^match_(.+?)_(?:[A-Z]|PLAYOFF|KO)_/i);
    if (segMatch?.[1]) {
      return isSameCategory(segMatch[1], categoryId);
    }
  }
  const normCat = categoryId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (normCat && m.id.toLowerCase().includes(normCat)) {
    return true;
  }
  return false;
}

/**
 * Searches for a match involving two teams (in either order).
 * Matches strictly by team names and optional category/stage to guarantee no cross-match collisions.
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
    if (categoryId && !doesMatchBelongToCategory(m, categoryId)) return false;
    if (stageOrBracket) {
      const isTargetKO = isKnockoutStageString(stageOrBracket);
      if (isTargetKO) {
        if (!m.stage || m.stage.includes("Pool Play") || m.stage.includes("Bracket ") || !isKnockoutStageString(m.stage)) {
          return false;
        }
        const targetRound = getKnockoutRoundType(stageOrBracket);
        const matchRound = getKnockoutRoundType(m.stage);
        if (targetRound !== "other" && matchRound !== "other" && targetRound !== matchRound) {
          return false;
        }
        const targetKoNum = getKnockoutMatchNumber(stageOrBracket);
        const matchKoNum = getKnockoutMatchNumber(m.stage);
        if (targetKoNum && matchKoNum && targetKoNum !== matchKoNum) {
          return false;
        }
      } else if (m.stage) {
        if (isKnockoutStageString(m.stage)) return false;
      }
    }
    const ma = m.teamAName?.trim().toLowerCase();
    const mb = m.teamBName?.trim().toLowerCase();
    return (ma === cleanA && mb === cleanB) || (ma === cleanB && mb === cleanA);
  });
}

/**
 * Accurately finds an existing match between two specific teams within an optional bracket stage.
 * NEVER matches different teams, different categories, or pool-play vs playoff stages.
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
  scopedMatchId?: string | null,
): LiveMatch | undefined {
  if (!teamAName || !teamBName) return undefined;
  const normA = teamAName.replace(/\s+/g, " ").trim().toLowerCase();
  const normB = teamBName.replace(/\s+/g, " ").trim().toLowerCase();
  const normP = (arr?: string[]) =>
    (arr || [])
      .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
      .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
      .filter((p) => Boolean(p) && !isGenericTeamName(p))
      .sort()
      .join("|");

  const targetPA = normP(teamAPlayers);
  const targetPB = normP(teamBPlayers);

  const sideMatches = (tName: string, tPlayers: string, mName: string, mPlayers: string): boolean => {
    if (tPlayers && mPlayers) {
      return tPlayers === mPlayers;
    }
    if (tName !== mName) return false;
    if (isGenericTeamName(tName) && Boolean(tPlayers) !== Boolean(mPlayers)) {
      return false;
    }
    return true;
  };

  const candidates = matches.filter((m) => {
    if (tournamentSlug && m.tournamentSlug && m.tournamentSlug !== tournamentSlug) return false;

    if (scopedMatchId && m.id === scopedMatchId) {
      if (categoryId && m.categoryId && !doesMatchBelongToCategory(m, categoryId)) return false;
      return true;
    }

    if (categoryId && !doesMatchBelongToCategory(m, categoryId)) return false;

    const ma = (m.teamAName || "").replace(/\s+/g, " ").trim().toLowerCase();
    const mb = (m.teamBName || "").replace(/\s+/g, " ").trim().toLowerCase();
    const matchPA = normP(m.teamAPlayers);
    const matchPB = normP(m.teamBPlayers);

    const matchesNormal =
      sideMatches(normA, targetPA, ma, matchPA) &&
      sideMatches(normB, targetPB, mb, matchPB);
    const matchesReverse =
      sideMatches(normA, targetPA, mb, matchPB) &&
      sideMatches(normB, targetPB, ma, matchPA);

    if (!matchesNormal && !matchesReverse) return false;

    if (stageOrBracket) {
      const cleanTarget = stageOrBracket.trim().toLowerCase();
      const isTargetKnockout = isKnockoutStageString(stageOrBracket);

      if (isTargetKnockout) {
        if (
          !m.stage ||
          m.stage.includes("Pool Play") ||
          m.stage.includes("Bracket ") ||
          isPoolStageString(m.stage) ||
          !isKnockoutStageString(m.stage)
        ) {
          return false;
        }
        const targetRound = getKnockoutRoundType(stageOrBracket);
        const matchRound = getKnockoutRoundType(m.stage);
        if (targetRound !== "other" && matchRound !== "other" && targetRound !== matchRound) {
          return false;
        }
        const targetKoNum = getKnockoutMatchNumber(stageOrBracket);
        const matchKoNum = getKnockoutMatchNumber(m.stage);
        if (targetKoNum && matchKoNum && targetKoNum !== matchKoNum) {
          return false;
        }
      } else if (m.stage) {
        const cleanMatchStage = m.stage.trim().toLowerCase();
        if (isKnockoutStageString(m.stage)) {
          return false;
        }

        const targetBracket =
          cleanTarget.match(/(?:bracket|pool)?\s*([a-z])\b/i)?.[1]?.toLowerCase() ||
          (cleanTarget.length === 1 && /[a-z]/i.test(cleanTarget) ? cleanTarget.toLowerCase() : undefined);
        const matchBracket = cleanMatchStage.match(/(?:bracket|pool)\s*([a-z])\b/i)?.[1]?.toLowerCase();

        if (targetBracket && matchBracket && targetBracket !== matchBracket) {
          return false;
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
  const usedIds = new Set<string>();

  for (const m of current) {
    if (
      !m.teamAName ||
      !m.teamBName ||
      m.id.startsWith("live-ko-") ||
      m.id.startsWith("ko-") ||
      m.id.startsWith("match_") ||
      m.status === "final" ||
      m.status === "live" ||
      Boolean(m.court && m.court !== "Queue")
    ) {
      usedIds.add(m.id);
    }
  }

  const migrated = current.map((m) => {
    if (!m.teamAName || !m.teamBName) return m;
    if (m.id.startsWith("live-ko-") || m.id.startsWith("ko-")) return m;
    // Category-scoped match IDs and active/concluded matches keep their authoritative IDs untouched
    if (
      m.id.startsWith("match_") ||
      m.status === "final" ||
      m.status === "live" ||
      Boolean(m.court && m.court !== "Queue")
    ) {
      return m;
    }

    const canonicalId = createPairMatchId(
      m.tournamentSlug || "event",
      m.categoryId || "division",
      m.bracketLetter ? `Bracket ${m.bracketLetter}` : (m.stage || "match"),
      m.teamAName,
      m.teamBName,
      m.teamAPlayers,
      m.teamBPlayers,
    );

    if (usedIds.has(canonicalId) && m.id !== canonicalId) {
      usedIds.add(m.id);
      return m;
    }

    usedIds.add(canonicalId);

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

      // Check if a match for these two teams already exists in the store (prioritizing final/live scores)
      const existing = findMatchForPair(
        currentMatches,
        teamA.name,
        teamB.name,
        tournamentSlug,
        categoryId,
        group.letter,
        teamA.players,
        teamB.players,
        matchId,
      );
      if (existing) {
        const normPlayers = (arr?: string[]) =>
          (arr || [])
            .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
            .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
            .filter(Boolean)
            .sort()
            .join("|");
        const exPlayersA = normPlayers(existing.teamAPlayers);
        const exPlayersB = normPlayers(existing.teamBPlayers);
        const newPlayersA = normPlayers(teamA.players);
        const newPlayersB = normPlayers(teamB.players);
        const exNameA = (existing.teamAName || "").trim().toLowerCase();
        const exNameB = (existing.teamBName || "").trim().toLowerCase();
        const newNameA = teamA.name.trim().toLowerCase();
        const newNameB = teamB.name.trim().toLowerCase();

        let isFlipped = false;
        if (exPlayersA && exPlayersB && (newPlayersA || newPlayersB)) {
          if (
            (newPlayersA === exPlayersB || newPlayersB === exPlayersA) &&
            newPlayersA !== exPlayersA &&
            newPlayersB !== exPlayersB
          ) {
            isFlipped = true;
          }
        } else if (newNameA !== newNameB && exNameA === newNameB && exNameB === newNameA) {
          isFlipped = true;
        }

        const sideATeam = isFlipped ? teamB : teamA;
        const sideBTeam = isFlipped ? teamA : teamB;
        const isFinal = existing.status === "final";

        const nextMatch: LiveMatch = {
          ...existing,
          tournamentSlug: tournamentSlug || existing.tournamentSlug,
          categoryId: categoryId || existing.categoryId,
          stage: existing.stage || `Bracket ${group.letter} (Pool Play)`,
          bracketLetter: existing.bracketLetter || group.letter,
          teamAName: isFinal ? existing.teamAName : sideATeam.name,
          teamAPlayers: isFinal ? existing.teamAPlayers : sideATeam.players,
          teamAClub: sideATeam.club || existing.teamAClub,
          teamBName: isFinal ? existing.teamBName : sideBTeam.name,
          teamBPlayers: isFinal ? existing.teamBPlayers : sideBTeam.players,
          teamBClub: sideBTeam.club || existing.teamBClub,
        };

        if (
          !isFinal &&
          (nextMatch.teamAName !== existing.teamAName ||
            nextMatch.teamBName !== existing.teamBName ||
            JSON.stringify(nextMatch.teamAPlayers) !== JSON.stringify(existing.teamAPlayers) ||
            JSON.stringify(nextMatch.teamBPlayers) !== JSON.stringify(existing.teamBPlayers))
        ) {
          markLocalMatchMutation(nextMatch.id);
          if (nextMatch.status === "live" || (nextMatch.court && nextMatch.court !== "Queue")) {
            dbSaveMatch(nextMatch).catch(() => {});
          }
        }

        newMatches.push(nextMatch);
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
  const removedMatchIds: string[] = [];
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
        removedMatchIds.push(m.id);
        markLocalMatchDeleted(m.id);
        return false;
      }
      if (m.status === "live") {
        return true;
      }
      removedMatchIds.push(m.id);
      markLocalMatchDeleted(m.id);
      return false;
    }

    // Also for other matches, ensure pool play matches don't cross brackets
    if (m.stage && m.stage.includes("Bracket ") && !isMatchInSameBracket(m.tournamentSlug || "", m.categoryId || "", m.stage, m.teamAName, m.teamBName, undefined, undefined, m.teamAPlayers, m.teamBPlayers)) {
      removedMatchIds.push(m.id);
      markLocalMatchDeleted(m.id);
      return false;
    }

    return true;
  });

  if (removedMatchIds.length > 0) {
    dbDeleteMatchesBatch(removedMatchIds).catch(() => {});
  }

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
      markLocalMatchDeleted(m.id);
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
      markLocalMatchDeleted(m.id);
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
  purgeAllCompletedInScope = false,
}: {
  tournamentSlug: string;
  matchIds: string[];
  categoryId?: string | undefined;
  targetMatch?: LiveMatch | null | undefined;
  targetMatches?: LiveMatch[] | undefined;
  purgeAllCompletedInScope?: boolean | undefined;
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

  const normalizePlayers = (players?: string[]) =>
    (players || [])
      .map((p) => p.trim().toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter(Boolean)
      .sort()
      .join(",");

  // Helper to test if a match represents the exact same completed matchup as any target
  const isMatchingSameMatchup = (m: LiveMatch): boolean => {
    if (matchIds.includes(m.id)) return true;

    // Only match completed/final records when looking for duplicate ghosts of history entries
    const isFinalRecord = m.status === "final" || Boolean(m.winnerTeam) || Boolean(m.endedAt);
    if (!isFinalRecord) return false;

    const ma = m.teamAName?.trim().toLowerCase();
    const mb = m.teamBName?.trim().toLowerCase();
    if (!ma || !mb) return false;

    const mPA = normalizePlayers(m.teamAPlayers);
    const mPB = normalizePlayers(m.teamBPlayers);

    return explicitTargets.some((t) => {
      if (t.id === m.id) return true;

      // Enforce strict category scoping so deleting a match never touches another division
      const effectiveTargetCat = t.categoryId || categoryId;
      if (effectiveTargetCat && m.categoryId) {
        if (!isSameCategory(m.categoryId, effectiveTargetCat)) return false;
      } else if (effectiveTargetCat && !m.categoryId) {
        if (!doesMatchBelongToCategory(m, effectiveTargetCat)) return false;
      }

      const ta = t.teamAName?.trim().toLowerCase();
      const tb = t.teamBName?.trim().toLowerCase();
      if (!ta || !tb) return false;

      const tPA = normalizePlayers(t.teamAPlayers);
      const tPB = normalizePlayers(t.teamBPlayers);

      const sameForward =
        ma === ta &&
        mb === tb &&
        (!mPA || !tPA || mPA === tPA) &&
        (!mPB || !tPB || mPB === tPB);
      const sameReverse =
        ma === tb &&
        mb === ta &&
        (!mPA || !tPB || mPA === tPB) &&
        (!mPB || !tPA || mPB === tPA);

      if (!sameForward && !sameReverse) return false;

      const mStage = (m.stage || "").trim().toLowerCase();
      const tStage = (t.stage || "").trim().toLowerCase();
      const mIsKo = isKnockoutStageString(mStage);
      const tIsKo = isKnockoutStageString(tStage);

      if (mIsKo !== tIsKo) return false;

      if (mIsKo && tIsKo) {
        if (getKnockoutRoundType(mStage) !== getKnockoutRoundType(tStage)) return false;
        const qNumM = mStage.match(/\b(\d+)\b/)?.[1];
        const qNumT = tStage.match(/\b(\d+)\b/)?.[1];
        if (qNumM && qNumT && qNumM !== qNumT) return false;
        return true;
      }

      return mStage === tStage;
    });
  };

  // Find all matches in current that match any target (including exact completed duplicates)
  const allMatchesToDelete = current.filter(isMatchingSameMatchup);
  const idSet = new Set<string>([
    ...matchIds,
    ...allMatchesToDelete.map((m) => m.id),
  ]);

  for (const id of idSet) {
    markLocalMatchDeleted(id);
  }

  // 1. Immediately remove from local matches
  const retained = current.filter((m) => !idSet.has(m.id));
  saveMatches(retained, false);

  // 2. Delete matching match records from Supabase database
  try {
    if (!purgeAllCompletedInScope) {
      // Single-match delete: check cloud for any exact duplicate completed ghost IDs of this specific matchup,
      // then delete ONLY those verified IDs. Never run category-wide or unscoped pair deletes.
      const cloudSnapshot = await dbGetMatches(tournamentSlug).catch(() => []);
      for (const cm of cloudSnapshot) {
        if (isMatchingSameMatchup(cm)) {
          idSet.add(cm.id);
          markLocalMatchDeleted(cm.id);
        }
      }
      await dbDeleteMatchesBatch(Array.from(idSet));
    } else {
      // Bulk Clear History: delete targeted completed match IDs and purge status='final' rows in the selected scope ONLY.
      // Never call dbDeleteMatchesForCategory(..., true), which would wipe scheduled and live matches.
      await dbDeleteMatchesBatch(Array.from(idSet));
      await dbPurgeCompletedMatches(tournamentSlug, categoryId);
    }
  } catch (err) {
    console.warn("[MatchStore] Error deleting matches from cloud:", err);
  }

  const allIdsToDelete = Array.from(idSet);

  // 2b. Clean offline score journal to prevent resurrecting deleted scores
  if (typeof localStorage !== "undefined") {
    try {
      const journalRaw = localStorage.getItem("dv_offline_score_journal");
      if (journalRaw) {
        const journal = JSON.parse(journalRaw);
        let journalChanged = false;
        for (const k of Object.keys(journal)) {
          const entry = journal[k];
          const isTarget =
            idSet.has(k) ||
            (entry?.match && isMatchingSameMatchup(entry.match)) ||
            (purgeAllCompletedInScope &&
              entry?.match?.status === "final" &&
              (!categoryId || isSameCategory(entry?.match?.categoryId, categoryId)));
          if (isTarget) {
            delete journal[k];
            journalChanged = true;
          }
        }
        if (journalChanged) {
          localStorage.setItem("dv_offline_score_journal", JSON.stringify(journal));
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Clear/Reset corresponding entries in Main Draw Knockout storage (ONLY for deleted Knockout/Playoff matches)
  if (typeof localStorage !== "undefined") {
    try {
      const knockoutTargets = explicitTargets.filter((t) => isKnockoutStageString(t.stage || ""));
      if (knockoutTargets.length > 0) {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(`dv_main_draw_${tournamentSlug}_`)) {
            const catSuffix = k.replace(`dv_main_draw_${tournamentSlug}_`, "");
            const raw = localStorage.getItem(k);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                let modified = false;
                const updated = parsed.map((km: any) => {
                  const na = km.teamA?.name?.trim().toLowerCase();
                  const nb = km.teamB?.name?.trim().toLowerCase();
                  if (!na || !nb) return km;
                  const kPA = normalizePlayers(km.teamA?.players);
                  const kPB = normalizePlayers(km.teamB?.players);

                  const isTarget = knockoutTargets.some((t) => {
                    const effectiveTargetCat = t.categoryId || categoryId;
                    if (effectiveTargetCat && catSuffix && !isSameCategory(catSuffix, effectiveTargetCat)) {
                      return false;
                    }
                    if (km.round && t.stage && getKnockoutRoundType(km.round) !== getKnockoutRoundType(t.stage)) {
                      return false;
                    }
                    const ta = t.teamAName?.trim().toLowerCase();
                    const tb = t.teamBName?.trim().toLowerCase();
                    const tPA = normalizePlayers(t.teamAPlayers);
                    const tPB = normalizePlayers(t.teamBPlayers);

                    const sameForward =
                      na === ta &&
                      nb === tb &&
                      (!kPA || !tPA || kPA === tPA) &&
                      (!kPB || !tPB || kPB === tPB);
                    const sameReverse =
                      na === tb &&
                      nb === ta &&
                      (!kPA || !tPB || kPA === tPB) &&
                      (!kPB || !tPA || kPB === tPA);
                    return sameForward || sameReverse;
                  });
                  if (isTarget) {
                    modified = true;
                    return { ...km, scoreA: undefined, scoreB: undefined, winner: undefined };
                  }
                  return km;
                });
                if (modified) {
                  localStorage.setItem(k, JSON.stringify(updated));
                  dbSaveMainDraw(tournamentSlug, catSuffix, updated).catch(() => {});
                }
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

