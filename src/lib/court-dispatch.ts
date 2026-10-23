import {
  getMatches,
  saveMatches,
  type LiveMatch,
  createPairMatchId,
  findMatchForPair,
  createInitialScore,
  migrateMatchesToDeterministicIds,
  isMatchMatchingStation,
} from "./match-store";
import {
  dbUpdateCourtStation,
  dbGetCourtStations,
  dbSaveDispatchQueue,
  dbDeleteDispatchQueue,
  getCachedDispatchQueue,
  dbSaveMatch,
  dbDeleteMatch,
  dbGetMatches,
  getStationLocalWriteAt,
  markStationLocalWrite,
  getOfflineScoreJournal,
  broadcastDispatchAlert,
} from "./supabase-service";
import { isMatchInSameBracket } from "./bracket-utils";

export { isMatchInSameBracket };

/* ─────────────────────────────────────────────
   Facility 4 Courts Definition
───────────────────────────────────────────── */

export const FACILITY_COURTS = [
  "Court 1",
  "Court 2",
  "Court 3",
  "Court 4",
] as const;

export type FacilityCourt = (typeof FACILITY_COURTS)[number];

export type CourtStatus = "available" | "warmup" | "live" | "completed" | "maintenance";

export type CourtStation = {
  court: FacilityCourt;
  status: CourtStatus;
  currentMatchId: string | null;
  onDeckMatchId: string | null;
  assignedUmpire: string | null;
  dispatchedAt: number | null;
  maintenanceNote: string | null;
  activeBracket?: string | null;
};

export type QueueItem = {
  id: string;
  matchId: string;
  tournamentSlug: string;
  categoryId: string;
  stage: string; // e.g. "Pool A - Round 1", "Quarterfinal 2"
  teamAName: string;
  teamAPlayers: string[];
  teamAClub?: string | undefined;
  teamBName: string;
  teamBPlayers: string[];
  teamBClub?: string | undefined;
  priority: number; // 1, 2, 3...
  status: "queued" | "on_deck" | "dispatched" | "live" | "completed";
  assignedCourt: FacilityCourt | null;
  addedAt: number;
  notes?: string | undefined;
};

export type DeskAnnouncement = {
  id: string;
  court: FacilityCourt;
  teamAName: string;
  teamBName: string;
  message: string;
  timestamp: number;
};

/* ─────────────────────────────────────────────
   Storage Keys
───────────────────────────────────────────── */

const STATIONS_KEY = "dv_court_stations";
const QUEUE_KEY = "dv_dispatch_queue";
const ANNOUNCEMENT_KEY = "dv_latest_announcement";

/* ─────────────────────────────────────────────
   Court Stations Operations
───────────────────────────────────────────── */

export function getInitialCourtStations(): Record<FacilityCourt, CourtStation> {
  return {
    "Court 1": {
      court: "Court 1",
      status: "available",
      currentMatchId: null,
      onDeckMatchId: null,
      assignedUmpire: null,
      dispatchedAt: null,
      maintenanceNote: null,
      activeBracket: "all",
    },
    "Court 2": {
      court: "Court 2",
      status: "available",
      currentMatchId: null,
      onDeckMatchId: null,
      assignedUmpire: null,
      dispatchedAt: null,
      maintenanceNote: null,
      activeBracket: "all",
    },
    "Court 3": {
      court: "Court 3",
      status: "available",
      currentMatchId: null,
      onDeckMatchId: null,
      assignedUmpire: null,
      dispatchedAt: null,
      maintenanceNote: null,
      activeBracket: "all",
    },
    "Court 4": {
      court: "Court 4",
      status: "available",
      currentMatchId: null,
      onDeckMatchId: null,
      assignedUmpire: null,
      dispatchedAt: null,
      maintenanceNote: null,
      activeBracket: "all",
    },
  };
}

export function getCourtStations(): Record<FacilityCourt, CourtStation> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STATIONS_KEY) : null;
    if (!raw) return getInitialCourtStations();
    const parsed = JSON.parse(raw) as Record<FacilityCourt, CourtStation>;

    // Ensure all 4 courts exist
    const base = getInitialCourtStations();
    for (const c of FACILITY_COURTS) {
      if (parsed[c]) {
        base[c] = {
          ...base[c],
          ...parsed[c],
          activeBracket: parsed[c].activeBracket || base[c].activeBracket || "all",
        };
      }
    }
    return base;
  } catch {
    return getInitialCourtStations();
  }
}

export function saveCourtStations(
  stations: Record<FacilityCourt, CourtStation>,
  syncToCloud: boolean | FacilityCourt = false,
): void {
  try {
    const serialized = JSON.stringify(stations);
    // Only write and broadcast when something actually changed; unconditional events
    // here used to cascade into reload -> reconcile -> save loops on every 3s poll.
    if (localStorage.getItem(STATIONS_KEY) !== serialized) {
      localStorage.setItem(STATIONS_KEY, serialized);
      window.dispatchEvent(new Event("dv_court_stations_updated"));
    }
  } catch {
    // ignore
  }
  if (syncToCloud === true) {
    for (const court of FACILITY_COURTS) {
      const st = stations[court];
      if (st) {
        dbUpdateCourtStation(court, {
          status: st.status,
          currentMatchId: st.currentMatchId,
          onDeckMatchId: st.onDeckMatchId,
          assignedUmpire: st.assignedUmpire,
          dispatchedAt: st.dispatchedAt,
          maintenanceNote: st.maintenanceNote,
        }).catch(() => { });
      }
    }
  } else if (typeof syncToCloud === "string" && FACILITY_COURTS.includes(syncToCloud as FacilityCourt)) {
    const court = syncToCloud as FacilityCourt;
    const st = stations[court];
    if (st) {
      dbUpdateCourtStation(court, {
        status: st.status,
        currentMatchId: st.currentMatchId,
        onDeckMatchId: st.onDeckMatchId,
        assignedUmpire: st.assignedUmpire,
        dispatchedAt: st.dispatchedAt,
        maintenanceNote: st.maintenanceNote,
      }).catch(() => { });
    }
  }
}

/**
 * Reconciles Court Stations with the Matches store:
 * 1. If a station is marked 'live' or 'warmup', verifies that currentMatchId exists and is an active, non-final match.
 *    If missing from memory, self-heals and preserves the court match.
 * 2. If a non-final match has court = 'Court X', verifies that Court X station is actually assigned to it.
 *    If Court X station is occupied by a different matchup, moves the match's court back to 'Queue'.
 */
let _isReconcilingCourtStations = false;

export function reconcileCourtStations(
  stationsInput?: Record<FacilityCourt, CourtStation>,
  matchesInput?: LiveMatch[],
): {
  stations: Record<FacilityCourt, CourtStation>;
  matches: LiveMatch[];
  modified: boolean;
} {
  const stations = { ...(stationsInput ?? getCourtStations()) };
  const matches = [...(matchesInput ?? getMatches())];
  let modified = false;

  if (_isReconcilingCourtStations) {
    return { stations, matches, modified: false };
  }
  _isReconcilingCourtStations = true;
  try {

  for (const c of FACILITY_COURTS) {
    const st = stations[c];
    if (!st) continue;

    if (st.status === "live" || st.status === "warmup") {
      let activeMatch = st.currentMatchId ? matches.find((m) => m.id === st.currentMatchId) : null;
      if (!activeMatch) {
        activeMatch = matches.find((m) => m.status !== "final" && isMatchMatchingStation(m, st.currentMatchId, c)) || null;
      }

      // If the assigned match is not in the local store yet (cloud match row still in flight),
      // KEEP the station. Wiping it here is what made dispatched matches vanish on the umpire side.

      if (activeMatch && activeMatch.status !== "final") {
        if (st.currentMatchId !== activeMatch.id || (activeMatch.status === "live" && st.status !== "live")) {
          stations[c] = {
            ...st,
            currentMatchId: activeMatch.id,
            status: activeMatch.status === "live" ? "live" : st.status,
            dispatchedAt: activeMatch.startedAt ?? st.dispatchedAt ?? Date.now(),
          };
          modified = true;
        }
        if (activeMatch.court !== c) {
          const idx = matches.findIndex((m) => m.id === activeMatch!.id);
          if (idx !== -1) {
            matches[idx] = { ...activeMatch, court: c };
            modified = true;
          }
        }
      } else if (activeMatch && activeMatch.status === "final") {
        // Concluded match still holding the court: free it locally AND in the cloud so
        // hydration does not flip it back on the next poll.
        stations[c] = {
          ...st,
          status: "available",
          currentMatchId: null,
          dispatchedAt: null,
        };
        modified = true;
        dbUpdateCourtStation(c, {
          status: "available",
          currentMatchId: null,
          dispatchedAt: null,
        }).catch(() => {});
      }
      // Note: If no active match could be found or restored, do NOT wipe an active station!
      // This protects courts against timer-based state loss and hallucination.
    } else if (st.status === "available") {
      // Never promote a match onto an idle court just because its `court` field says so.
      // Stale match rows were the main source of hallucinated court assignments.
      if (st.currentMatchId) {
        stations[c] = {
          ...st,
          currentMatchId: null,
          dispatchedAt: null,
        };
        modified = true;
      }
    }
  }

  // Note: matches are intentionally NOT re-routed here. Display layers resolve the court's
  // match strictly through station.currentMatchId, and enforceFourCourtCapacity already
  // de-duplicates court claims. Rewriting match courts locally fought with the cloud merge
  // and caused a court flip-flop (and a localStorage write + event) on every poll.

  if (modified && typeof window !== "undefined") {
    try {
      const stationsStr = JSON.stringify(stations);
      const matchesStr = JSON.stringify(matches);
      const prevStations = localStorage.getItem(STATIONS_KEY);
      const prevMatches = localStorage.getItem("dv_live_matches");

      let stationsChanged = false;
      let matchesChanged = false;

      if (prevStations !== stationsStr) {
        localStorage.setItem(STATIONS_KEY, stationsStr);
        stationsChanged = true;
      }
      if (prevMatches !== matchesStr) {
        localStorage.setItem("dv_live_matches", matchesStr);
        matchesChanged = true;
      }

      if (stationsChanged) {
        window.dispatchEvent(new Event("dv_court_stations_updated"));
      }
      if (matchesChanged) {
        window.dispatchEvent(new Event("dv_matches_updated"));
        window.dispatchEvent(new Event("dv_live_matches_updated"));
      }
    } catch {
      // ignore
    }
  }

  return { stations, matches, modified };
  } finally {
    _isReconcilingCourtStations = false;
  }
}

/* ─────────────────────────────────────────────
   Dispatch Queue Operations
───────────────────────────────────────────── */

export function getDispatchQueue(): QueueItem[] {
  let items: QueueItem[] = [];
  const cached = getCachedDispatchQueue();
  if (cached && Array.isArray(cached) && cached.length > 0) {
    items = cached as QueueItem[];
  } else {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(QUEUE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as QueueItem[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          items = parsed;
        }
      }
    } catch {
      // ignore
    }
  }

  // Filter out any matches that pair players across different brackets in pool play
  const valid = items.filter((q) =>
    isMatchInSameBracket(q.tournamentSlug, q.categoryId, q.stage, q.teamAName, q.teamBName, undefined, undefined, q.teamAPlayers, q.teamBPlayers)
  );

  if (valid.length !== items.length) {
    saveDispatchQueue(valid);
  }

  return valid;
}

export function saveDispatchQueue(queue: QueueItem[]): void {
  // Ensure only matches with teams in the same bracket are persisted
  const sanitized = queue.filter((q) =>
    isMatchInSameBracket(q.tournamentSlug, q.categoryId, q.stage, q.teamAName, q.teamBName, undefined, undefined, q.teamAPlayers, q.teamBPlayers)
  );

  dbSaveDispatchQueue(sanitized).catch((err) => {
    console.warn("[Supabase] Failed to persist dispatch queue to cloud:", err);
  });
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(sanitized));
    window.dispatchEvent(new Event("storage"));
    window.dispatchEvent(new Event("dv_dispatch_queue_updated"));
  } catch {
    // ignore
  }
}

/* ─────────────────────────────────────────────
   Announcements Operations
───────────────────────────────────────────── */

export function getLatestAnnouncement(): DeskAnnouncement | null {
  try {
    const raw = localStorage.getItem(ANNOUNCEMENT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DeskAnnouncement;
  } catch {
    return null;
  }
}

export function setLatestAnnouncement(announcement: DeskAnnouncement | null): void {
  try {
    if (announcement) {
      localStorage.setItem(ANNOUNCEMENT_KEY, JSON.stringify(announcement));
    } else {
      localStorage.removeItem(ANNOUNCEMENT_KEY);
    }
    window.dispatchEvent(new Event("storage"));
  } catch {
    // ignore
  }
}

/* ─────────────────────────────────────────────
   Audio Chime Generator (Web Audio API)
   Generates a professional 2-tone tournament desk chime
───────────────────────────────────────────── */

export function playDeskChime(): void {
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    const ctx = new AudioContextClass();
    const now = ctx.currentTime;

    // First tone (G4, 392Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(392.0, now);
    gain1.gain.setValueAtTime(0.2, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.5);

    // Second tone (C5, 523.25Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(523.25, now + 0.3);
    gain2.gain.setValueAtTime(0.25, now + 0.3);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 1.1);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.3);
    osc2.stop(now + 1.1);
  } catch {
    // audio may be blocked before interaction
  }
}

/* ─────────────────────────────────────────────
   Dispatch Actions
───────────────────────────────────────────── */

/**
 * Dispatches a match to a specified court (Court 1, 2, 3, or 4).
 * Synchronizes with dv_live_matches, updates court station, and emits announcement.
 */
export function dispatchMatchToCourt(
  court: FacilityCourt,
  match: {
    id: string;
    tournamentSlug?: string | undefined;
    categoryId?: string | undefined;
    stage?: string | undefined;
    teamAName: string;
    teamAPlayers?: string[] | undefined;
    teamAClub?: string | undefined;
    teamBName: string;
    teamBPlayers?: string[] | undefined;
    teamBClub?: string | undefined;
  },
  umpire?: string | undefined,
  startImmediately = false,
): void {
  // Validate that pool play matches only pair teams within the exact same bracket
  if (match.stage && !isMatchInSameBracket(match.tournamentSlug || "", match.categoryId || "", match.stage, match.teamAName, match.teamBName, undefined, undefined, match.teamAPlayers, match.teamBPlayers)) {
    console.warn(`[Dispatch Rejected] ${match.teamAName} vs ${match.teamBName} are not in the same bracket for stage: ${match.stage}`);
    return;
  }

  // Validate that neither team nor player is already live or on-deck on another court
  const conflictA = checkSimultaneousPlayConflict(match.teamAName, match.teamAPlayers, match.tournamentSlug, match.teamAClub);
  const conflictB = checkSimultaneousPlayConflict(match.teamBName, match.teamBPlayers, match.tournamentSlug, match.teamBClub);
  const conflict = conflictA || conflictB;
  if (conflict && conflict.court !== court) {
    console.warn(`[Dispatch Rejected] ${conflict.teamName} is already ${conflict.status} on ${conflict.court}`);
    return;
  }

  // Always compute canonical deterministic pair ID
  const canonicalId = createPairMatchId(
    match.tournamentSlug || "",
    match.categoryId || "",
    match.stage || "",
    match.teamAName,
    match.teamBName,
    match.teamAPlayers,
    match.teamBPlayers,
  );
  const effectiveId = match.id.startsWith("match-") ? match.id : canonicalId;

  // Make sure matches are migrated to deterministic IDs
  const rawMatches = getMatches();
  const matches = migrateMatchesToDeterministicIds(rawMatches);
  const now = Date.now();

  const isTargetMatch = (m: LiveMatch): boolean => {
    // 1. Strict pair match
    const ma = m.teamAName?.trim().toLowerCase();
    const mb = m.teamBName?.trim().toLowerCase();
    const ta = match.teamAName.trim().toLowerCase();
    const tb = match.teamBName.trim().toLowerCase();
    if ((ma === ta && mb === tb) || (ma === tb && mb === ta)) {
      if (ta === tb && match.teamAPlayers && match.teamBPlayers && m.teamAPlayers && m.teamBPlayers) {
        const matchP = [m.teamAPlayers.slice().sort().join(",").toLowerCase(), m.teamBPlayers.slice().sort().join(",").toLowerCase()].sort().join(" vs ");
        const targetP = [match.teamAPlayers.slice().sort().join(",").toLowerCase(), match.teamBPlayers.slice().sort().join(",").toLowerCase()].sort().join(" vs ");
        return matchP === targetP;
      }
      return true;
    }
    // 2. ID match only if match doesn't have opposing teams
    if (m.id === effectiveId || m.id === match.id) {
      if (!m.teamAName || !m.teamBName) return true;
      if ((ma === ta && mb === tb) || (ma === tb && mb === ta)) return true;
      // If teams are completely different, it's a legacy index collision!
      return false;
    }
    return false;
  };

  // 1. Update Court Station FIRST in memory, localStorage, and Supabase so enforceFourCourtCapacity immediately sees it
  const stations = getCourtStations();
  const courtsToSync: FacilityCourt[] = [court];

  // If this match or matchup was already assigned to another court station, vacate that other station
  for (const otherCourt of FACILITY_COURTS) {
    if (otherCourt !== court) {
      const otherSt = stations[otherCourt];
      if (otherSt && otherSt.currentMatchId) {
        const isAssignedHere =
          otherSt.currentMatchId === canonicalId ||
          otherSt.currentMatchId === match.id ||
          otherSt.currentMatchId === effectiveId ||
          isMatchMatchingStation(
            {
              id: canonicalId,
              teamAName: match.teamAName,
              teamAPlayers: match.teamAPlayers ?? [],
              teamBName: match.teamBName,
              teamBPlayers: match.teamBPlayers ?? [],
              court: otherCourt,
              status: "live",
              score: createInitialScore(),
              winnerTeam: undefined,
              startedAt: undefined,
              endedAt: undefined,
              officiatedBy: undefined,
            },
            otherSt.currentMatchId,
            otherCourt,
          );
        if (isAssignedHere) {
          stations[otherCourt] = {
            ...otherSt,
            status: "available",
            currentMatchId: null,
            dispatchedAt: null,
          };
          courtsToSync.push(otherCourt);
        }
      }
    }
  }

  stations[court] = {
    ...stations[court],
    status: startImmediately ? "live" : "warmup",
    currentMatchId: canonicalId,
    assignedUmpire: umpire ?? stations[court].assignedUmpire,
    dispatchedAt: now,
    maintenanceNote: null,
  };
  saveCourtStations(stations, false);
  // The cloud push waits for the match row (below); protect the local assignment meanwhile
  for (const c of courtsToSync) markStationLocalWrite(c);

  const pushStationsToCloud = () => {
    for (const c of courtsToSync) {
      const st = stations[c];
      if (st) {
        dbUpdateCourtStation(c, {
          status: st.status,
          currentMatchId: st.currentMatchId,
          onDeckMatchId: st.onDeckMatchId,
          assignedUmpire: st.assignedUmpire,
          dispatchedAt: st.dispatchedAt,
          maintenanceNote: st.maintenanceNote,
        }).catch(() => {});
      }
    }
  };

  let matchFound = false;
  const vacatedMatches: LiveMatch[] = [];
  const updatedMatches = matches.map((m) => {
    if (isTargetMatch(m)) {
      matchFound = true;
      return {
        ...m,
        id: canonicalId,
        tournamentSlug: match.tournamentSlug ?? m.tournamentSlug,
        categoryId: match.categoryId ?? m.categoryId,
        stage: match.stage ?? m.stage,
        court,
        teamAName: match.teamAName,
        teamAPlayers: match.teamAPlayers?.length ? match.teamAPlayers : m.teamAPlayers,
        teamAClub: match.teamAClub ?? m.teamAClub,
        teamBName: match.teamBName,
        teamBPlayers: match.teamBPlayers?.length ? match.teamBPlayers : m.teamBPlayers,
        teamBClub: match.teamBClub ?? m.teamBClub,
        status: startImmediately ? ("live" as const) : ("scheduled" as const),
        startedAt: startImmediately ? (m.startedAt ?? now) : m.startedAt,
        officiatedBy: umpire ?? m.officiatedBy,
      };
    }

    // If an old legacy match has colliding ID (e.g. 1v2) with different teams, re-key it to avoid overwriting or collision
    if ((m.id === match.id || m.id === canonicalId) && !isTargetMatch(m)) {
      const staleCanonical = createPairMatchId(
        m.tournamentSlug || "",
        m.categoryId || "",
        m.stage || "",
        m.teamAName,
        m.teamBName,
      );
      const staleVacated = {
        ...m,
        id: staleCanonical,
        court: m.court === court ? "Queue" : m.court,
        status: m.court === court ? ("scheduled" as const) : m.status,
      };
      if (m.court === court) {
        vacatedMatches.push(staleVacated);
      }
      return staleVacated;
    }

    // Replace the active court match immediately: return all previous unfinished games to the queue
    if (m.court === court && m.status !== "final" && !isTargetMatch(m)) {
      const vacated = {
        ...m,
        court: "Queue",
        status: "scheduled" as const,
        startedAt: undefined,
      };
      vacatedMatches.push(vacated);
      return vacated;
    }
    return m;
  });

  if (!matchFound) {
    updatedMatches.push({
      id: canonicalId,
      tournamentSlug: match.tournamentSlug,
      categoryId: match.categoryId,
      stage: match.stage || "Pool Play",
      court,
      teamAName: match.teamAName,
      teamAPlayers: match.teamAPlayers ?? [],
      teamAClub: match.teamAClub,
      teamBName: match.teamBName,
      teamBPlayers: match.teamBPlayers ?? [],
      teamBClub: match.teamBClub,
      status: startImmediately ? "live" : "scheduled",
      score: createInitialScore(),
      winnerTeam: undefined,
      startedAt: startImmediately ? now : undefined,
      endedAt: undefined,
      officiatedBy: umpire,
    });
  }

  // 2. Save matches locally without mass cloud sync
  saveMatches(updatedMatches, false);

  // 3. Save the dispatched match row to Supabase FIRST, then broadcast the station.
  // Umpire devices react to the station event; if the station arrives before the match row,
  // they have nothing to render (or fall back to a stale match). Ordering removes that race.
  const dispatchedRecord = updatedMatches.find((m) => m.id === canonicalId);
  const matchWrites: Promise<unknown>[] = [];
  if (dispatchedRecord) {
    matchWrites.push(
      dbSaveMatch(dispatchedRecord, match.tournamentSlug).catch((err: unknown) =>
        console.warn("[Supabase] Direct match dispatch save failed:", err)
      )
    );
  }
  for (const vm of vacatedMatches) {
    matchWrites.push(
      dbSaveMatch(vm, match.tournamentSlug).catch((err: unknown) =>
        console.warn("[Supabase] Vacated match save failed:", err)
      )
    );
  }
  // Synchronize stations to cloud immediately alongside match record save
  pushStationsToCloud();
  if (matchWrites.length > 0) {
    Promise.all(matchWrites)
      .then(() => {
        pushStationsToCloud();
        broadcastDispatchAlert({
          court,
          matchId: canonicalId,
          teamAName: match.teamAName,
          teamBName: match.teamBName,
          stage: match.stage,
          umpire: umpire ?? stations[court].assignedUmpire ?? undefined,
          match: dispatchedRecord,
        });
      })
      .catch(() => {});
  }

  // Update status of this match in dispatch queue
  const queue = getDispatchQueue();
  const updatedQueue = queue.map((q) => {
    // Revert any previous match on this court back to queued
    if (q.assignedCourt === court && q.matchId !== canonicalId && q.matchId !== match.id && q.status !== "completed") {
      return {
        ...q,
        status: "queued" as const,
        assignedCourt: null,
      };
    }

    const ma = q.teamAName?.trim().toLowerCase();
    const mb = q.teamBName?.trim().toLowerCase();
    const ta = match.teamAName.trim().toLowerCase();
    const tb = match.teamBName.trim().toLowerCase();
    const isTargetQueue =
      q.matchId === canonicalId ||
      q.matchId === match.id ||
      ((ma === ta && mb === tb) || (ma === tb && mb === ta));

    if (isTargetQueue) {
      return {
        ...q,
        matchId: canonicalId,
        status: startImmediately ? ("live" as const) : ("dispatched" as const),
        assignedCourt: court,
      };
    }
    return q;
  });

  saveDispatchQueue(updatedQueue);

  // Emit Desk Announcement & Broadcast Realtime Alert to All Connected Devices
  const announcement: DeskAnnouncement = {
    id: `ann-${now}`,
    court,
    teamAName: match.teamAName,
    teamBName: match.teamBName,
    message: `Now calling to ${court}: ${match.teamAName} vs ${match.teamBName}. Please report to ${court} for warm-up.`,
    timestamp: now,
  };
  setLatestAnnouncement(announcement);
  playDeskChime();

  broadcastDispatchAlert({
    court,
    matchId: canonicalId,
    teamAName: match.teamAName,
    teamBName: match.teamBName,
    stage: match.stage,
    umpire: umpire ?? stations[court].assignedUmpire ?? undefined,
    match: dispatchedRecord,
  });
}

/**
 * Determines whether a given match stage matches the court's active bracket assignment.
 * - 'all' or empty allows any stage.
 * - 'Playoffs' matches knockout stages (Quarterfinal, Semifinal, Final, Bronze, Round of 16, etc.) and excludes Pool Play.
 * - 'Bracket A' (or 'Pool A') matches stages belonging to that pool letter (e.g. 'Bracket A (Pool Play)', 'Pool A - Round 1').
 */
export function isStageMatchingBracket(
  stage?: string,
  activeBracket?: string | null,
): boolean {
  if (!activeBracket || activeBracket === "all" || activeBracket === "ALL") {
    return true;
  }
  if (!stage) {
    return false;
  }

  const cleanBracket = activeBracket.trim().toLowerCase();
  const cleanStage = stage.trim().toLowerCase();

  // Playoffs assignment: matches any playoff/knockout stage, excludes pool play
  if (cleanBracket === "playoffs" || cleanBracket === "playoff") {
    const isPool = /(?:bracket|pool)\s+[a-z]/i.test(cleanStage);
    return !isPool;
  }

  // Pool bracket assignment: extract the target letter, e.g. "Bracket A" -> "A", "Pool B" -> "B"
  const targetLetterMatch = cleanBracket.match(/(?:bracket|pool)?\s*([a-z])/i);
  if (!targetLetterMatch) {
    return cleanStage.includes(cleanBracket);
  }

  const targetLetter = targetLetterMatch[1]!.toUpperCase();

  // Extract letter from match stage
  const stageLetterMatch = cleanStage.match(/(?:bracket|pool)\s+([a-z])/i);
  if (!stageLetterMatch) {
    return false;
  }

  const stageLetter = stageLetterMatch[1]!.toUpperCase();
  return stageLetter === targetLetter;
}

export function setCourtActiveBracket(court: FacilityCourt, bracket: string | null): void {
  const stations = getCourtStations();
  if (stations[court]) {
    stations[court] = {
      ...stations[court],
      activeBracket: bracket || "all",
    };
    saveCourtStations(stations);
  }
}

export function getCourtActiveBracket(court: FacilityCourt): string {
  const stations = getCourtStations();
  return stations[court]?.activeBracket || "all";
}

/**
 * Auto-dispatches the #1 priority match from the queue to the given court.
 * Respects the court's assigned activeBracket filter (e.g. 'Bracket A', 'Bracket B', or 'all').
 * Skips any match where a team or player is currently playing on an active facility court.
 */
export function autoDispatchNext(court: FacilityCourt, tournamentSlug?: string, umpire?: string): QueueItem | null {
  const stations = getCourtStations();
  const station = stations[court];
  const activeBracket = station?.activeBracket || "all";

  const queue = getDispatchQueue();
  let pending = queue
    .filter((q) => q.status === "queued" || q.status === "on_deck")
    .filter((q) => !tournamentSlug || !q.tournamentSlug || q.tournamentSlug === tournamentSlug)
    .filter((q) => isStageMatchingBracket(q.stage, activeBracket))
    .filter((q) => !checkSimultaneousPlayConflict(q.teamAName, q.teamAPlayers, q.tournamentSlug || tournamentSlug, q.teamAClub) && !checkSimultaneousPlayConflict(q.teamBName, q.teamBPlayers, q.tournamentSlug || tournamentSlug, q.teamBClub))
    .filter((q) => isMatchInSameBracket(q.tournamentSlug || tournamentSlug || "", q.categoryId || "", q.stage, q.teamAName, q.teamBName, undefined, undefined, q.teamAPlayers, q.teamBPlayers))
    .sort((a, b) => a.priority - b.priority);

  // If court has a dedicated bracket filter, but all matches for that bracket are finished/exhausted,
  // allow auto-dispatch to fall back to remaining unplayed matches across any bracket
  if (pending.length === 0 && activeBracket !== "all") {
    const hasRemainingInDedicatedBracket = queue.some(
      (q) =>
        (q.status === "queued" || q.status === "on_deck") &&
        (!tournamentSlug || !q.tournamentSlug || q.tournamentSlug === tournamentSlug) &&
        isStageMatchingBracket(q.stage, activeBracket),
    );
    if (!hasRemainingInDedicatedBracket) {
      pending = queue
        .filter((q) => q.status === "queued" || q.status === "on_deck")
        .filter((q) => !tournamentSlug || !q.tournamentSlug || q.tournamentSlug === tournamentSlug)
        .filter((q) => !checkSimultaneousPlayConflict(q.teamAName, q.teamAPlayers, q.tournamentSlug || tournamentSlug, q.teamAClub) && !checkSimultaneousPlayConflict(q.teamBName, q.teamBPlayers, q.tournamentSlug || tournamentSlug, q.teamBClub))
        .filter((q) => isMatchInSameBracket(q.tournamentSlug || tournamentSlug || "", q.categoryId || "", q.stage, q.teamAName, q.teamBName, undefined, undefined, q.teamAPlayers, q.teamBPlayers))
        .sort((a, b) => a.priority - b.priority);
    }
  }

  if (pending.length === 0) return null;

  const nextMatch = pending[0]!;
  dispatchMatchToCourt(court, {
    id: nextMatch.matchId,
    tournamentSlug: nextMatch.tournamentSlug,
    categoryId: nextMatch.categoryId,
    stage: nextMatch.stage,
    teamAName: nextMatch.teamAName,
    teamAPlayers: nextMatch.teamAPlayers,
    teamAClub: nextMatch.teamAClub,
    teamBName: nextMatch.teamBName,
    teamBPlayers: nextMatch.teamBPlayers,
    teamBClub: nextMatch.teamBClub,
  }, umpire);

  return nextMatch;
}

/**
 * Sets a court station to live status.
 */
export function setCourtLive(court: FacilityCourt, matchId?: string): void {
  const stations = getCourtStations();
  stations[court] = {
    ...stations[court],
    status: "live",
    currentMatchId: matchId ?? stations[court].currentMatchId,
  };
  saveCourtStations(stations, court);
}

/**
 * Vacates a court, resetting it to available.
 * Any non-final match currently assigned to this court is unassigned back to "Queue",
 * and its dispatch queue status is returned to "queued".
 */
export function vacateCourt(court: FacilityCourt): void {
  const stations = getCourtStations();
  const currentMatchId = stations[court]?.currentMatchId;
  stations[court] = {
    ...stations[court],
    status: "available",
    currentMatchId: null,
    dispatchedAt: null,
    maintenanceNote: null,
  };
  saveCourtStations(stations, false);
  dbUpdateCourtStation(court, {
    status: "available",
    currentMatchId: null,
    dispatchedAt: null,
    maintenanceNote: null,
  }).catch(() => {});

  // Unassign any active or scheduled match on this court in matches store
  const allMatches = getMatches();
  let matchesModified = false;
  const vacatedMatches: LiveMatch[] = [];
  const updatedMatches = allMatches.map((m) => {
    if ((m.court === court || (currentMatchId && m.id === currentMatchId)) && m.status !== "final") {
      matchesModified = true;
      const v = {
        ...m,
        court: "Queue",
        status: "scheduled" as const,
        startedAt: undefined,
      };
      vacatedMatches.push(v);
      return v;
    }
    return m;
  });
  if (matchesModified) {
    saveMatches(updatedMatches, false);
    for (const vm of vacatedMatches) {
      dbSaveMatch(vm).catch(() => {});
    }
  }

  // Clear coin toss flag if present
  if (typeof localStorage !== "undefined" && currentMatchId) {
    try {
      localStorage.removeItem(`dv_toss_done_${currentMatchId}`);
    } catch {
      // ignore
    }
  }

  // Update dispatch queue: return dispatched/live match on this court back to queued
  const queue = getDispatchQueue();
  let queueModified = false;
  const updatedQueue = queue.map((q) => {
    if (
      (q.assignedCourt === court || (currentMatchId && q.matchId === currentMatchId)) &&
      (q.status === "dispatched" || q.status === "live")
    ) {
      queueModified = true;
      return {
        ...q,
        assignedCourt: null,
        status: "queued" as const,
      };
    }
    return q;
  });
  if (queueModified) {
    saveDispatchQueue(updatedQueue);
  }
}

/**
 * Marks court as maintenance or resumes normal operations.
 */
export function setCourtMaintenance(court: FacilityCourt, inMaintenance: boolean, note?: string): void {
  const stations = getCourtStations();
  stations[court] = {
    ...stations[court],
    status: inMaintenance ? "maintenance" : "available",
    maintenanceNote: inMaintenance ? (note ?? "Court maintenance in progress") : null,
    currentMatchId: inMaintenance ? null : stations[court].currentMatchId,
  };
  saveCourtStations(stations, court);
}

/**
 * Designates a match as "On-Deck" specifically for a court.
 */
export function setCourtOnDeck(court: FacilityCourt, matchId: string | null): void {
  const stations = getCourtStations();
  stations[court] = {
    ...stations[court],
    onDeckMatchId: matchId,
  };
  saveCourtStations(stations, court);

  const queue = getDispatchQueue();
  let modified = false;
  const updated = queue.map((q) => {
    if (matchId && q.matchId === matchId) {
      modified = true;
      return { ...q, status: "on_deck" as const, assignedCourt: court };
    }
    // Any other match previously on_deck for this court reverts back to queued
    if (q.assignedCourt === court && q.status === "on_deck") {
      modified = true;
      return { ...q, status: "queued" as const, assignedCourt: null };
    }
    return q;
  });
  if (modified) {
    saveDispatchQueue(updated);
  }
}

/**
 * Assigns or claims an umpire for a specific court station.
 */
export function claimCourtStation(court: FacilityCourt, umpire: string): void {
  const stations = getCourtStations();
  stations[court] = {
    ...stations[court],
    assignedUmpire: umpire,
  };
  saveCourtStations(stations, court);
}

/**
 * Releases umpire assignment from a court station.
 */
export function releaseCourtStation(court: FacilityCourt): void {
  const stations = getCourtStations();
  stations[court] = {
    ...stations[court],
    assignedUmpire: null,
  };
  saveCourtStations(stations, court);
}

/**
 * Hydrates court stations from Supabase cloud database into local storage.
 */
export async function hydrateCourtStationsFromCloud(): Promise<Record<FacilityCourt, CourtStation>> {
  try {
    const cloudStations = await dbGetCourtStations();
    if (cloudStations && Object.keys(cloudStations).length > 0) {
      const local = getCourtStations();
      const now = Date.now();
      for (const court of FACILITY_COURTS) {
        const cloud = cloudStations[court];
        if (!cloud) continue;
        const loc = local[court];

        // The cloud row is the single source of truth for station assignment.
        // The only exception: THIS device wrote the station in the last few seconds and
        // the write has not echoed back yet. In that window keep local so the court does
        // not blink. We never re-push local state from here: doing so let any device with
        // a stale copy resurrect vacated courts (the old 4-second rule).
        const sinceLocalWrite = now - getStationLocalWriteAt(court);
        const cloudMatchesLocal =
          (cloud.currentMatchId ?? null) === (loc?.currentMatchId ?? null) &&
          cloud.status === loc?.status;
        if (sinceLocalWrite < 6000 && !cloudMatchesLocal) {
          continue;
        }

        local[court] = {
          ...local[court],
          ...cloud,
          // activeBracket is a desk-only preference that is not stored in the cloud row
          activeBracket: loc?.activeBracket || cloud.activeBracket || "all",
        };
      }
      saveCourtStations(local, false);
      return local;
    }
  } catch (err) {
    console.warn("[CourtDispatch] Could not hydrate stations from cloud:", err);
  }
  return getCourtStations();
}

/**
 * Reorders an item in the queue.
 * If scopedMatchIds is provided (e.g. from a filtered view), moves the match
 * relative to its adjacent neighbors within that visible list.
 */
export function reorderQueue(
  matchId: string,
  direction: "up" | "down" | "top",
  scopedMatchIds?: string[],
): void {
  const queue = getDispatchQueue();
  const currentItemIndex = queue.findIndex((q) => q.matchId === matchId);
  if (currentItemIndex === -1) return;

  const newQueue = [...queue];

  if (scopedMatchIds && scopedMatchIds.length > 0) {
    const idxInScope = scopedMatchIds.indexOf(matchId);
    if (idxInScope === -1) return;

    if (direction === "top") {
      const targetMatchId = scopedMatchIds[0]!;
      const targetIdxInQueue = newQueue.findIndex((q) => q.matchId === targetMatchId);
      if (targetIdxInQueue !== -1 && targetIdxInQueue !== currentItemIndex) {
        const [removed] = newQueue.splice(currentItemIndex, 1);
        newQueue.splice(targetIdxInQueue, 0, removed!);
      }
    } else if (direction === "up" && idxInScope > 0) {
      const targetMatchId = scopedMatchIds[idxInScope - 1]!;
      const targetIdxInQueue = newQueue.findIndex((q) => q.matchId === targetMatchId);
      if (targetIdxInQueue !== -1) {
        const temp = newQueue[currentItemIndex]!;
        newQueue[currentItemIndex] = newQueue[targetIdxInQueue]!;
        newQueue[targetIdxInQueue] = temp;
      }
    } else if (direction === "down" && idxInScope < scopedMatchIds.length - 1) {
      const targetMatchId = scopedMatchIds[idxInScope + 1]!;
      const targetIdxInQueue = newQueue.findIndex((q) => q.matchId === targetMatchId);
      if (targetIdxInQueue !== -1) {
        const temp = newQueue[currentItemIndex]!;
        newQueue[currentItemIndex] = newQueue[targetIdxInQueue]!;
        newQueue[targetIdxInQueue] = temp;
      }
    }
  } else {
    const item = newQueue[currentItemIndex]!;
    if (direction === "top") {
      newQueue.splice(currentItemIndex, 1);
      newQueue.unshift(item);
    } else if (direction === "up" && currentItemIndex > 0) {
      const prev = newQueue[currentItemIndex - 1]!;
      newQueue[currentItemIndex - 1] = item;
      newQueue[currentItemIndex] = prev;
    } else if (direction === "down" && currentItemIndex < newQueue.length - 1) {
      const next = newQueue[currentItemIndex + 1]!;
      newQueue[currentItemIndex + 1] = item;
      newQueue[currentItemIndex] = next;
    }
  }

  // Renumber priority
  const renumbered = newQueue.map((q, i) => ({ ...q, priority: i + 1 }));
  saveDispatchQueue(renumbered);
}

/**
 * Marks a match in the dispatch queue as completed when finished.
 */
export function completeQueueMatch(matchId: string): void {
  const queue = getDispatchQueue();
  let modified = false;
  const updated = queue.map((q) => {
    if (q.matchId === matchId) {
      modified = true;
      return {
        ...q,
        status: "completed" as const,
        assignedCourt: null,
      };
    }
    return q;
  });
  if (modified) {
    saveDispatchQueue(updated);
  }
}

/**
 * Removes an item from the queue.
 */
export function removeQueueItem(matchId: string): void {
  const queue = getDispatchQueue();
  const filtered = queue
    .filter((q) => q.matchId !== matchId)
    .map((q, i) => ({ ...q, priority: i + 1 }));
  saveDispatchQueue(filtered);
}

/**
 * Removes all matches from the dispatch queue belonging to a specific category.
 * Also clears any court stations that were assigned to matches from this category.
 */
export function purgeQueueForCategory(tournamentSlug: string, categoryId: string): void {
  dbDeleteDispatchQueue(tournamentSlug, categoryId).catch(() => {});
  const queue = getDispatchQueue();
  const filtered = queue
    .filter((q) => {
      const matchInCat =
        (q.categoryId && q.categoryId === categoryId) ||
        (q.matchId && q.matchId.includes(categoryId));
      const matchInTourney =
        !q.tournamentSlug ||
        q.tournamentSlug === tournamentSlug ||
        (q.matchId && q.matchId.includes(tournamentSlug));
      // Remove item if it belongs to this category and tournament
      return !(matchInCat && matchInTourney);
    })
    .map((q, i) => ({ ...q, priority: i + 1 }));
  saveDispatchQueue(filtered);

  // Release any active court stations holding matches from this category
  const stations = getCourtStations();
  let stationModified = false;
  for (const c of FACILITY_COURTS) {
    const st = stations[c];
    if (st.currentMatchId && st.currentMatchId.includes(categoryId)) {
      st.currentMatchId = null;
      st.status = "available";
      st.dispatchedAt = null;
      stationModified = true;
    }
    if (st.onDeckMatchId && st.onDeckMatchId.includes(categoryId)) {
      st.onDeckMatchId = null;
      stationModified = true;
    }
  }
  if (stationModified) {
    saveCourtStations(stations);
  }
}

/**
 * Removes all matches from the dispatch queue and clears assigned courts for a deleted tournament.
 */
export function purgeQueueForTournament(tournamentSlug: string): void {
  const queue = getDispatchQueue();
  const filtered = queue
    .filter((q) => {
      const matchInTourney =
        q.tournamentSlug === tournamentSlug ||
        (!q.tournamentSlug && q.matchId && q.matchId.includes(tournamentSlug));
      return !matchInTourney;
    })
    .map((q, i) => ({ ...q, priority: i + 1 }));
  saveDispatchQueue(filtered);

  // Release any active court stations holding matches from this tournament
  const stations = getCourtStations();
  let stationModified = false;
  for (const c of FACILITY_COURTS) {
    const st = stations[c];
    if (st.currentMatchId && st.currentMatchId.includes(tournamentSlug)) {
      st.currentMatchId = null;
      st.status = "available";
      st.dispatchedAt = null;
      stationModified = true;
    }
    if (st.onDeckMatchId && st.onDeckMatchId.includes(tournamentSlug)) {
      st.onDeckMatchId = null;
      stationModified = true;
    }
  }
  if (stationModified) {
    saveCourtStations(stations);
  }
}

/**
 * Removes all matches from the dispatch queue involving a specific team that was deleted.
 */
export function purgeQueueForTeam(tournamentSlug: string, categoryId: string, teamName: string): void {
  const cleanTeam = teamName.trim().toLowerCase();
  const queue = getDispatchQueue();
  const filtered = queue
    .filter((q) => {
      const isMatchCategory =
        (!q.categoryId || q.categoryId === categoryId || (q.matchId && q.matchId.includes(categoryId))) &&
        (!q.tournamentSlug || q.tournamentSlug === tournamentSlug || (q.matchId && q.matchId.includes(tournamentSlug)));
      if (!isMatchCategory) return true;
      const isTeamA = q.teamAName.trim().toLowerCase() === cleanTeam;
      const isTeamB = q.teamBName.trim().toLowerCase() === cleanTeam;
      return !isTeamA && !isTeamB;
    })
    .map((q, i) => ({ ...q, priority: i + 1 }));
  saveDispatchQueue(filtered);
}

/**
 * Removes all matches from the dispatch queue where either team is not in the valid teams list.
 */
export function purgeQueueNotInTeams(
  tournamentSlug: string,
  categoryId: string,
  validTeamNames: string[]
): void {
  const validSet = new Set(validTeamNames.map((t) => t.trim().toLowerCase()));
  const queue = getDispatchQueue();
  let modified = false;

  const filtered = queue
    .filter((q) => {
      const isMatchCategory =
        (!q.categoryId || q.categoryId === categoryId || (q.matchId && q.matchId.includes(categoryId))) &&
        (!q.tournamentSlug || q.tournamentSlug === tournamentSlug || (q.matchId && q.matchId.includes(tournamentSlug)));
      if (!isMatchCategory) return true;
      if (q.id.startsWith("custom-")) return true;

      const teamAValid = validSet.has(q.teamAName.trim().toLowerCase());
      const teamBValid = validSet.has(q.teamBName.trim().toLowerCase());

      if (!teamAValid || !teamBValid) {
        modified = true;
        return false;
      }
      return true;
    })
    .map((q, i) => ({ ...q, priority: i + 1 }));

  if (modified) {
    saveDispatchQueue(filtered);
  }
}

/**
 * Adds multiple matches to the queue.
 */
export function addMatchesToQueue(
  items: {
    matchId: string;
    tournamentSlug: string;
    categoryId: string;
    stage: string;
    teamAName: string;
    teamAPlayers?: string[];
    teamBName: string;
    teamBPlayers?: string[];
  }[],
): void {
  const queue = getDispatchQueue();
  const existingIds = new Set(queue.map((q) => q.matchId));
  let nextPriority = queue.length > 0 ? Math.max(...queue.map((q) => q.priority)) + 1 : 1;

  const newItems: QueueItem[] = [];
  for (const it of items) {
    if (existingIds.has(it.matchId)) continue;
    // Strictly ensure only matches within the same bracket are added to the queue
    if (!isMatchInSameBracket(it.tournamentSlug, it.categoryId, it.stage, it.teamAName, it.teamBName, undefined, undefined, it.teamAPlayers, it.teamBPlayers)) {
      continue;
    }
    newItems.push({
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      matchId: it.matchId,
      tournamentSlug: it.tournamentSlug,
      categoryId: it.categoryId,
      stage: it.stage,
      teamAName: it.teamAName,
      teamAPlayers: it.teamAPlayers ?? [],
      teamBName: it.teamBName,
      teamBPlayers: it.teamBPlayers ?? [],
      priority: nextPriority++,
      status: "queued",
      assignedCourt: null,
      addedAt: Date.now(),
    });
  }

  saveDispatchQueue([...queue, ...newItems]);
}

/* ─────────────────────────────────────────────
   Conflict Detection Helpers
───────────────────────────────────────────── */

export type RestWarning = {
  teamName: string;
  minutesAgo: number;
  court: string;
};

/**
 * Determines whether two player entries refer to the exact same individual.
 * Rule: Treat as the same person ONLY if BOTH their partner AND club match.
 * If either their partner or club differs, they are considered different individuals.
 */
export function isSamePerson(
  player1: string,
  partner1: string | undefined,
  club1: string | undefined,
  player2: string,
  partner2: string | undefined,
  club2: string | undefined,
): boolean {
  const p1 = player1.trim().toLowerCase();
  const p2 = player2.trim().toLowerCase();
  if (!p1 || !p2 || p1 !== p2) return false;

  const part1 = (partner1 ?? "").trim().toLowerCase();
  const part2 = (partner2 ?? "").trim().toLowerCase();
  const c1 = (club1 ?? "").trim().toLowerCase();
  const c2 = (club2 ?? "").trim().toLowerCase();

  // If partner is not the same, they are different players
  if (part1 !== part2) return false;

  // If club is not the same, they are different players
  if (c1 !== c2) return false;

  return true;
}

/* ─────────────────────────────────────────────
   Short-lived read caches for hot-path conflict checks.
   checkRestPeriodConflict / checkSimultaneousPlayConflict are invoked
   several times per queue item on every render; without caching each call
   re-parses every match, station, queue item and drawn group from storage,
   which locks up the main thread on the Dispatch screen.
───────────────────────────────────────────── */

const READ_CACHE_TTL_MS = 1000;
let _matchesSnapshot: { at: number; data: LiveMatch[] } | null = null;
const _participantsCache = new Map<string, { at: number; data: ActivePlayEngagement[] }>();

function invalidateReadCaches(): void {
  _matchesSnapshot = null;
  _participantsCache.clear();
}

if (typeof window !== "undefined") {
  for (const evt of [
    "storage",
    "dv_matches_updated",
    "dv_live_matches_updated",
    "dv_court_stations_updated",
    "dv_dispatch_queue_updated",
    "dv_drawn_groups_updated",
  ]) {
    window.addEventListener(evt, invalidateReadCaches);
  }
}

function getMatchesSnapshot(): LiveMatch[] {
  const now = Date.now();
  if (_matchesSnapshot && now - _matchesSnapshot.at < READ_CACHE_TTL_MS) {
    return _matchesSnapshot.data;
  }
  const data = getMatches();
  _matchesSnapshot = { at: Date.now(), data };
  return data;
}

export function checkRestPeriodConflict(
  teamName: string,
  players?: string[],
  thresholdMinutes = 20,
  club?: string,
): RestWarning | null {
  const matches = getMatchesSnapshot();
  const now = Date.now();
  const cleanTeam = teamName.trim().toLowerCase();
  const cleanPlayers = (players ?? []).map((p) => p.trim()).filter(Boolean);

  const finishedMatches = matches.filter((m) => {
    if (m.status !== "final" || !m.endedAt) return false;

    if (cleanPlayers.length > 0) {
      const teamAPlayers = (m.teamAPlayers ?? []).map((p) => p.trim()).filter(Boolean);
      const teamBPlayers = (m.teamBPlayers ?? []).map((p) => p.trim()).filter(Boolean);

      for (let i = 0; i < cleanPlayers.length; i++) {
        const player = cleanPlayers[i]!;
        const candidatePartner = cleanPlayers.find((_, idx) => idx !== i) || "";

        for (let j = 0; j < teamAPlayers.length; j++) {
          const actPlayer = teamAPlayers[j]!;
          const actPartner = teamAPlayers.find((_, idx) => idx !== j) || "";
          if (isSamePerson(player, candidatePartner, club, actPlayer, actPartner, m.teamAClub)) {
            return true;
          }
        }

        for (let j = 0; j < teamBPlayers.length; j++) {
          const actPlayer = teamBPlayers[j]!;
          const actPartner = teamBPlayers.find((_, idx) => idx !== j) || "";
          if (isSamePerson(player, candidatePartner, club, actPlayer, actPartner, m.teamBClub)) {
            return true;
          }
        }
      }
      return false;
    }

    const a = m.teamAName.trim().toLowerCase();
    const b = m.teamBName.trim().toLowerCase();
    return cleanTeam && (a === cleanTeam || b === cleanTeam);
  });

  if (finishedMatches.length === 0) return null;

  // Find most recent
  finishedMatches.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const latest = finishedMatches[0]!;
  const diffMinutes = Math.floor((now - (latest.endedAt ?? 0)) / (60 * 1000));

  if (diffMinutes < thresholdMinutes) {
    return {
      teamName,
      minutesAgo: diffMinutes,
      court: latest.court,
    };
  }

  return null;
}

export type LiveConflict = {
  teamName: string;
  court: string;
  matchId: string;
  isPlayerConflict?: boolean;
  playerName?: string;
  status: "live" | "warmup" | "on_deck";
};

export type ActivePlayEngagement = {
  court: string;
  state: "live" | "warmup" | "on_deck";
  matchId: string;
  teamAName: string;
  teamAPlayers: string[];
  teamAClub?: string | undefined;
  teamBName: string;
  teamBPlayers: string[];
  teamBClub?: string | undefined;
};

export function getAllActiveParticipants(tournamentSlug?: string): ActivePlayEngagement[] {
  const key = tournamentSlug ?? "";
  const cached = _participantsCache.get(key);
  if (cached && Date.now() - cached.at < READ_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = computeAllActiveParticipants();
  _participantsCache.set(key, { at: Date.now(), data });
  return data;
}

function computeAllActiveParticipants(): ActivePlayEngagement[] {
  const stations = getCourtStations();
  const matches = getMatchesSnapshot();
  const queue = getDispatchQueue();
  const results: ActivePlayEngagement[] = [];
  const processedCourtMatchIds = new Set<string>();

  // Helper to extract teams and players from any known source given a matchId
  const resolveMatchDetails = (
    matchId: string,
    courtFallback?: string,
  ): {
    teamAName: string;
    teamAPlayers: string[];
    teamAClub?: string | undefined;
    teamBName: string;
    teamBPlayers: string[];
    teamBClub?: string | undefined;
  } | null => {
    // 1. Check in matches store
    const inMatches = matches.find((m) => m.id === matchId && m.status !== "final");
    if (inMatches && inMatches.teamAName && inMatches.teamBName) {
      return {
        teamAName: inMatches.teamAName,
        teamAPlayers: inMatches.teamAPlayers ?? [],
        teamAClub: inMatches.teamAClub,
        teamBName: inMatches.teamBName,
        teamBPlayers: inMatches.teamBPlayers ?? [],
        teamBClub: inMatches.teamBClub,
      };
    }

    // 2. Check in dispatch queue
    const inQueue = queue.find((q) => q.matchId === matchId);
    if (inQueue && inQueue.teamAName && inQueue.teamBName) {
      return {
        teamAName: inQueue.teamAName,
        teamAPlayers: inQueue.teamAPlayers ?? [],
        teamAClub: inQueue.teamAClub,
        teamBName: inQueue.teamBName,
        teamBPlayers: inQueue.teamBPlayers ?? [],
        teamBClub: inQueue.teamBClub,
      };
    }

    // 3. Fallback: match by court in matches store
    if (courtFallback) {
      const byCourt = matches.find((m) => m.court === courtFallback && m.status !== "final");
      if (byCourt && byCourt.teamAName && byCourt.teamBName) {
        return {
          teamAName: byCourt.teamAName,
          teamAPlayers: byCourt.teamAPlayers ?? [],
          teamAClub: byCourt.teamAClub,
          teamBName: byCourt.teamBName,
          teamBPlayers: byCourt.teamBPlayers ?? [],
          teamBClub: byCourt.teamBClub,
        };
      }
    }

    // 4. Check drawn groups in localStorage
    if (typeof localStorage !== "undefined") {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith("dv_drawn_groups_")) {
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            const groups = JSON.parse(raw);
            if (!Array.isArray(groups)) continue;
            for (const g of groups) {
              const teams = (g.slots || []).map((s: any) => s.team).filter(Boolean);
              for (let t1 = 0; t1 < teams.length; t1++) {
                for (let t2 = t1 + 1; t2 < teams.length; t2++) {
                  const subId = `${g.letter}-${t1 + 1}v${t2 + 1}`;
                  const normA = (teams[t1].name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
                  const normB = (teams[t2].name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
                  const pair1 = `${normA}-vs-${normB}`;
                  const pair2 = `${normB}-vs-${normA}`;
                  if (matchId.includes(subId) || matchId.includes(pair1) || matchId.includes(pair2)) {
                    return {
                      teamAName: teams[t1].name,
                      teamAPlayers: teams[t1].players ?? [],
                      teamAClub: teams[t1].club,
                      teamBName: teams[t2].name,
                      teamBPlayers: teams[t2].players ?? [],
                      teamBClub: teams[t2].club,
                    };
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

    return null;
  };

  // 1. Facility Court Stations (Live & Warmup)
  for (const c of FACILITY_COURTS) {
    const st = stations[c];
    if (!st) continue;

    if ((st.status === "live" || st.status === "warmup") && st.currentMatchId) {
      const details = resolveMatchDetails(st.currentMatchId, c);
      if (details) {
        results.push({
          court: c,
          state: st.status === "warmup" ? "warmup" : "live",
          matchId: st.currentMatchId,
          ...details,
        });
        processedCourtMatchIds.add(st.currentMatchId);
      }
    }

    // On-Deck on Court Station
    if (st.onDeckMatchId) {
      const details = resolveMatchDetails(st.onDeckMatchId);
      if (details) {
        results.push({
          court: c,
          state: "on_deck",
          matchId: st.onDeckMatchId,
          ...details,
        });
        processedCourtMatchIds.add(st.onDeckMatchId);
      }
    }
  }

  // 2. Queue Items marked as on_deck
  for (const q of queue) {
    if (q.status === "on_deck" && !processedCourtMatchIds.has(q.matchId)) {
      results.push({
        court: q.assignedCourt || "On-Deck",
        state: "on_deck",
        matchId: q.matchId,
        teamAName: q.teamAName,
        teamAPlayers: q.teamAPlayers ?? [],
        teamAClub: q.teamAClub,
        teamBName: q.teamBName,
        teamBPlayers: q.teamBPlayers ?? [],
        teamBClub: q.teamBClub,
      });
      processedCourtMatchIds.add(q.matchId);
    }
  }

  // 3. Any active matches in matches store with facility courts not yet captured
  for (const m of matches) {
    if (
      m.status === "live" &&
      m.court &&
      FACILITY_COURTS.includes(m.court as FacilityCourt) &&
      !processedCourtMatchIds.has(m.id)
    ) {
      const courtStation = stations[m.court as FacilityCourt];
      if (courtStation && courtStation.status !== "available" && courtStation.currentMatchId === m.id) {
        results.push({
          court: m.court,
          state: "live",
          matchId: m.id,
          teamAName: m.teamAName,
          teamAPlayers: m.teamAPlayers ?? [],
          teamAClub: m.teamAClub,
          teamBName: m.teamBName,
          teamBPlayers: m.teamBPlayers ?? [],
          teamBClub: m.teamBClub,
        });
        processedCourtMatchIds.add(m.id);
      }
    }
  }

  return results;
}

export function checkSimultaneousPlayConflict(
  teamName: string,
  players?: string[],
  tournamentSlug?: string,
  club?: string,
): LiveConflict | null {
  const participants = getAllActiveParticipants(tournamentSlug);
  const cleanTeam = teamName.trim().toLowerCase();
  const cleanPlayers = (players ?? []).map((p) => p.trim()).filter(Boolean);

  for (const part of participants) {
    const partA = part.teamAName.trim().toLowerCase();
    const partB = part.teamBName.trim().toLowerCase();

    const partAPlayers = (part.teamAPlayers ?? []).map((p) => p.trim()).filter(Boolean);
    const partBPlayers = (part.teamBPlayers ?? []).map((p) => p.trim()).filter(Boolean);

    // If candidate team has players specified, evaluate conflict strictly on individual player identity
    // If players have the same name, but partner or club is NOT the same, they are DIFFERENT players!
    if (cleanPlayers.length > 0) {
      for (let i = 0; i < cleanPlayers.length; i++) {
        const player = cleanPlayers[i]!;
        const candidatePartner = cleanPlayers.find((_, idx) => idx !== i) || "";

        // Check against active Team A players
        for (let j = 0; j < partAPlayers.length; j++) {
          const actPlayer = partAPlayers[j]!;
          const actPartner = partAPlayers.find((_, idx) => idx !== j) || "";
          if (isSamePerson(player, candidatePartner, club, actPlayer, actPartner, part.teamAClub)) {
            return {
              teamName,
              playerName: player,
              isPlayerConflict: true,
              court: part.court,
              matchId: part.matchId,
              status: part.state,
            };
          }
        }

        // Check against active Team B players
        for (let j = 0; j < partBPlayers.length; j++) {
          const actPlayer = partBPlayers[j]!;
          const actPartner = partBPlayers.find((_, idx) => idx !== j) || "";
          if (isSamePerson(player, candidatePartner, club, actPlayer, actPartner, part.teamBClub)) {
            return {
              teamName,
              playerName: player,
              isPlayerConflict: true,
              court: part.court,
              matchId: part.matchId,
              status: part.state,
            };
          }
        }
      }

      // If active teams on this court both have known player rosters and no player was the same person,
      // there is NO player conflict (e.g. same name but different partner or club).
      const partTeamMatchesWithoutPlayers =
        (cleanTeam === partA && partAPlayers.length === 0) ||
        (cleanTeam === partB && partBPlayers.length === 0);

      if (cleanTeam && partTeamMatchesWithoutPlayers) {
        return {
          teamName,
          court: part.court,
          matchId: part.matchId,
          status: part.state,
        };
      }
    } else {
      // Priority 2: Candidate team has NO player roster on file.
      // Fall back to matching team name.
      if (cleanTeam && (cleanTeam === partA || cleanTeam === partB)) {
        return {
          teamName,
          court: part.court,
          matchId: part.matchId,
          status: part.state,
        };
      }
    }
  }

  return null;
}

/**
 * Removes any queued matches from the dispatch queue where either team
 * is currently playing on an active facility court (Court 1, 2, 3, or 4).
 * These matches are deferred back to unassigned status and can be queued
 * as soon as the team concludes their match on court.
 */
export function removePlayingConflictsFromQueue(tournamentSlug?: string): QueueItem[] {
  // Retain queued matches even if players are currently active on court.
  // The UI displays live conflict badges, and autoDispatchNext skips matches until players finish.
  return getDispatchQueue();
}

/* ─────────────────────────────────────────────
   Category Sequence & Wave Arrangement
───────────────────────────────────────────── */

export function getCategorySequence(
  tournamentSlug: string,
  categories: { id: string }[],
): string[] {
  const allIds = categories.map((c) => c.id);
  const allIdSet = new Set(allIds);

  try {
    const raw = localStorage.getItem(`dv_category_sequence_${tournamentSlug}`);
    if (!raw) return allIds;
    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) return allIds;

    // Filter out categories that no longer exist
    const valid = parsed.filter((id) => allIdSet.has(id));

    // Append any newly added categories that were not yet in the saved sequence
    const validSet = new Set(valid);
    for (const id of allIds) {
      if (!validSet.has(id)) {
        valid.push(id);
      }
    }

    return valid;
  } catch {
    return allIds;
  }
}

export function saveCategorySequence(
  tournamentSlug: string,
  sequence: string[],
): void {
  try {
    localStorage.setItem(
      `dv_category_sequence_${tournamentSlug}`,
      JSON.stringify(sequence),
    );
    window.dispatchEvent(new Event("storage"));
    window.dispatchEvent(new Event("dv_category_sequence_updated"));
  } catch {
    // ignore
  }
}

export function getActiveWaveId(
  tournamentSlug: string,
  fallbackId: string,
): string {
  try {
    const stored = localStorage.getItem(`dv_active_wave_${tournamentSlug}`);
    return stored && stored.trim().length > 0 ? stored : fallbackId;
  } catch {
    return fallbackId;
  }
}

export function setActiveWaveId(
  tournamentSlug: string,
  categoryId: string,
): void {
  try {
    localStorage.setItem(`dv_active_wave_${tournamentSlug}`, categoryId);
    window.dispatchEvent(new Event("storage"));
    window.dispatchEvent(new Event("dv_category_sequence_updated"));
  } catch {
    // ignore
  }
}

export function reorderCategorySequence(
  tournamentSlug: string,
  categories: { id: string }[],
  categoryId: string,
  direction: "prev" | "next",
): string[] {
  const current = getCategorySequence(tournamentSlug, categories);
  const index = current.indexOf(categoryId);
  if (index === -1) return current;

  const nextOrder = [...current];
  if (direction === "prev" && index > 0) {
    const temp = nextOrder[index - 1]!;
    nextOrder[index - 1] = categoryId;
    nextOrder[index] = temp;
  } else if (direction === "next" && index < nextOrder.length - 1) {
    const temp = nextOrder[index + 1]!;
    nextOrder[index + 1] = categoryId;
    nextOrder[index] = temp;
  }

  saveCategorySequence(tournamentSlug, nextOrder);
  return nextOrder;
}

/**
 * Checks whether a match has been officially confirmed or dispatched by an admin in Court Dispatch:
 * 1. Final/completed matches that were previously scored and concluded
 * 2. Matches actively occupying a facility court station (Courts 1–4, in warmup or live)
 * 3. Matches designated as on-deck on a facility court station
 * 4. Matches marked live on a facility court
 */
/**
 * Resolves the match actively occupying a facility court station.
 * - Prevents hallucinating stale scheduled matches when a court is available or in maintenance.
 * - Resolves assigned matches by direct ID, canonical ID, or team name matching.
 * - Falls back to live match explicitly on the court if station is marked live/warmup.
 */
export function findMatchForCourtStation(
  court: FacilityCourt,
  station: CourtStation | undefined,
  matches: LiveMatch[],
): LiveMatch | null {
  if (!station) return null;

  // 1. If station has an assigned match ID, find by exact ID or fuzzy matching
  if (station.currentMatchId) {
    const direct = matches.find((m) => m.id === station.currentMatchId && m.status !== "final");
    if (direct) return direct;

    const matching = matches.find(
      (m) => m.status !== "final" && isMatchMatchingStation(m, station.currentMatchId, court),
    );
    if (matching) return matching;
  }

  // 2. If station is explicitly active (live or warmup), check for an active match assigned to this court
  if (station.status === "live" || station.status === "warmup") {
    const active = matches.find((m) => m.court === court && (m.status === "live" || m.status === "scheduled"));
    if (active) return active;
  }

  // 3. If station is available, maintenance, or idle, it has NO active match.
  // Never pull a random scheduled match just because its court property matches.
  return null;
}

export function isConfirmedDispatchedMatch(
  m: LiveMatch,
  stations?: Record<FacilityCourt, CourtStation> | null,
): boolean {
  if (m.status === "final") return true;

  const currentStations = stations ?? getCourtStations();
  for (const c of FACILITY_COURTS) {
    const st = currentStations[c];
    if (st?.currentMatchId === m.id || (st?.currentMatchId && isMatchMatchingStation(m, st.currentMatchId, c))) return true;
    if (st?.onDeckMatchId === m.id) return true;
  }

  if (
    m.court &&
    m.court !== "Queue" &&
    (FACILITY_COURTS as readonly string[]).includes(m.court as FacilityCourt)
  ) {
    const st = currentStations[m.court as FacilityCourt];
    // Reject only if station is explicitly occupied by a different active matchup
    if (st?.currentMatchId && st.currentMatchId !== m.id && !isMatchMatchingStation(m, st.currentMatchId, m.court)) {
      return false;
    }
    if (m.status === "live" || m.status === "scheduled") {
      return true;
    }
  }

  return false;
}

/**
 * Contingency self-healing and re-sync function for Admin Court Dispatch.
 * Clears orphaned station match IDs, purges phantom matches, and pulls fresh state from Supabase.
 */
export async function healAndSyncDispatchStations(): Promise<Record<FacilityCourt, CourtStation>> {
  // Pull fresh stations and matches from the cloud first, so a court is only cleared when
  // its match is genuinely missing or finished everywhere (not just absent from this browser).
  await hydrateCourtStationsFromCloud();
  let cloudMatches: LiveMatch[] = [];
  try {
    cloudMatches = await dbGetMatches();
  } catch {
    cloudMatches = [];
  }
  const currentMatches = [...getMatches(), ...cloudMatches];
  const finalIds = new Set(currentMatches.filter((m) => m.status === "final").map((m) => m.id));
  const validLiveIds = new Set(
    currentMatches
      .filter((m) => (m.status === "live" || m.status === "scheduled") && !finalIds.has(m.id))
      .map((m) => m.id)
  );

  const stations = getCourtStations();
  let modified = false;

  for (const c of FACILITY_COURTS) {
    const st = stations[c];
    if (st && st.currentMatchId && !validLiveIds.has(st.currentMatchId)) {
      stations[c] = {
        ...st,
        status: "available",
        currentMatchId: null,
        dispatchedAt: null,
        assignedUmpire: null,
      };
      modified = true;
      dbUpdateCourtStation(c, {
        status: "available",
        currentMatchId: null,
        dispatchedAt: null,
        assignedUmpire: null,
      }).catch(() => {});
    }
  }

  if (modified) {
    saveCourtStations(stations, false);
  }

  const synced = await hydrateCourtStationsFromCloud();
  return synced;
}

export type DispatchAnomalyType =
  | "orphan_station"
  | "ghost_court_claim"
  | "status_mismatch"
  | "multiple_court_claims"
  | "simultaneous_conflict"
  | "umpire_mismatch"
  | "cloud_station_divergence";

export interface DispatchAuditAnomaly {
  id: string;
  court?: FacilityCourt | string | undefined;
  type: DispatchAnomalyType;
  severity: "error" | "warning" | "info";
  title: string;
  description: string;
  fixable: boolean;
  matchId?: string | undefined;
  details?: Record<string, any> | undefined;
}

export interface DispatchAuditResult {
  timestamp: number;
  healthy: boolean;
  score: number;
  anomalies: DispatchAuditAnomaly[];
  summary: {
    totalCourts: number;
    activeCourts: number;
    availableCourts: number;
    maintenanceCourts: number;
    totalMatchesInMemory: number;
    liveMatchesCount: number;
    queueCount: number;
  };
}

/**
 * Performs a comprehensive multi-point diagnostic audit across all 4 court stations,
 * in-memory matches, cloud status, and the dispatch queue to pinpoint bugs and hallucinations.
 */
export function auditDispatchSystem(
  stations: Record<FacilityCourt, CourtStation>,
  matches: LiveMatch[],
  queue: QueueItem[],
  cloudStations?: Record<FacilityCourt, CourtStation> | null,
): DispatchAuditResult {
  const anomalies: DispatchAuditAnomaly[] = [];
  const now = Date.now();

  let activeCourts = 0;
  let availableCourts = 0;
  let maintenanceCourts = 0;

  for (const court of FACILITY_COURTS) {
    const st = stations[court];
    if (!st) continue;

    if (st.status === "live" || st.status === "warmup") activeCourts++;
    else if (st.status === "available") availableCourts++;
    else if (st.status === "maintenance") maintenanceCourts++;

    // 1. Station has currentMatchId, verify match exists and is not final
    if (st.currentMatchId) {
      const match = matches.find((m) => m.id === st.currentMatchId);
      const fuzzyMatch = !match ? matches.find((m) => isMatchMatchingStation(m, st.currentMatchId, court)) : null;
      const effectiveMatch = match || fuzzyMatch;

      if (!effectiveMatch) {
        anomalies.push({
          id: `orphan-${court}-${st.currentMatchId}`,
          court,
          type: "orphan_station",
          severity: "error",
          title: `Orphaned Match on ${court}`,
          description: `Station ${court} is assigned to match ID "${st.currentMatchId}", but no such match exists in memory.`,
          fixable: true,
          matchId: st.currentMatchId,
        });
      } else if (effectiveMatch.status === "final") {
        anomalies.push({
          id: `concluded-holding-${court}-${effectiveMatch.id}`,
          court,
          type: "orphan_station",
          severity: "warning",
          title: `Finished Match Occupying ${court}`,
          description: `${court} is holding match "${effectiveMatch.teamAName} vs ${effectiveMatch.teamBName}" which concluded as final.`,
          fixable: true,
          matchId: effectiveMatch.id,
        });
      } else {
        // Check status mismatch
        if (st.status === "live" && effectiveMatch.status !== "live") {
          anomalies.push({
            id: `status-mismatch-${court}-${effectiveMatch.id}`,
            court,
            type: "status_mismatch",
            severity: "info",
            title: `Station/Match Status Mismatch on ${court}`,
            description: `Station is marked "live", but match status is "${effectiveMatch.status}".`,
            fixable: true,
            matchId: effectiveMatch.id,
          });
        }

        // Check umpire mismatch
        if (st.assignedUmpire && effectiveMatch.officiatedBy && st.assignedUmpire !== effectiveMatch.officiatedBy) {
          anomalies.push({
            id: `umpire-mismatch-${court}`,
            court,
            type: "umpire_mismatch",
            severity: "info",
            title: `Official Mismatch on ${court}`,
            description: `Station claimed by "${st.assignedUmpire}", but match row indicates "${effectiveMatch.officiatedBy}".`,
            fixable: true,
            matchId: effectiveMatch.id,
          });
        }
      }
    }

    // 2. Check for multiple matches claiming this court
    const matchesClaimingCourt = matches.filter(
      (m) => m.court === court && (m.status === "live" || m.status === "scheduled"),
    );
    if (matchesClaimingCourt.length > 1) {
      anomalies.push({
        id: `multi-claim-${court}`,
        court,
        type: "multiple_court_claims",
        severity: "error",
        title: `Multiple Matches Claiming ${court}`,
        description: `${matchesClaimingCourt.length} matches in store have court="${court}" simultaneously (${matchesClaimingCourt.map((m) => m.id).join(", ")}).`,
        fixable: true,
      });
    }

    // 3. Ghost court claim: A match has court === court, but station is available or occupied by different match
    for (const m of matchesClaimingCourt) {
      if (
        st.status === "available" ||
        st.status === "maintenance" ||
        (st.currentMatchId && st.currentMatchId !== m.id && !isMatchMatchingStation(m, st.currentMatchId, court))
      ) {
        anomalies.push({
          id: `ghost-claim-${m.id}-${court}`,
          court,
          type: "ghost_court_claim",
          severity: "warning",
          title: `Ghost Match Claim on ${court}`,
          description: `Match "${m.teamAName} vs ${m.teamBName}" (${m.id}) still claims ${court}, but station is ${st.status}.`,
          fixable: true,
          matchId: m.id,
        });
      }
    }

    // 4. Cloud station divergence (if cloudStations was supplied)
    if (cloudStations && cloudStations[court]) {
      const cst = cloudStations[court];
      const statusDiff = cst.status !== st.status;
      const matchDiff = (cst.currentMatchId ?? null) !== (st.currentMatchId ?? null);
      if (statusDiff || matchDiff) {
        anomalies.push({
          id: `divergence-${court}`,
          court,
          type: "cloud_station_divergence",
          severity: "warning",
          title: `Cloud/Local Divergence on ${court}`,
          description: `Local (${st.status}, match: ${st.currentMatchId || "none"}) diverges from Cloud (${cst.status}, match: ${cst.currentMatchId || "none"}).`,
          fixable: true,
          details: { local: st, cloud: cst },
        });
      }
    }
  }

  // 5. Simultaneous play conflicts in Queue
  for (const q of queue) {
    if (q.status === "queued" || q.status === "on_deck") {
      const liveA = checkSimultaneousPlayConflict(q.teamAName, q.teamAPlayers, q.tournamentSlug, q.teamAClub);
      const liveB = checkSimultaneousPlayConflict(q.teamBName, q.teamBPlayers, q.tournamentSlug, q.teamBClub);
      if (liveA || liveB) {
        const conflict = liveA || liveB;
        anomalies.push({
          id: `conflict-${q.matchId}`,
          court: conflict?.court,
          type: "simultaneous_conflict",
          severity: "warning",
          title: `Simultaneous Play Conflict in Queue`,
          description: `Queued match "${q.teamAName} vs ${q.teamBName}" cannot start because ${conflict?.teamName} is actively playing on ${conflict?.court}.`,
          fixable: false,
          matchId: q.matchId,
        });
      }
    }
  }

  const errorCount = anomalies.filter((a) => a.severity === "error").length;
  const warningCount = anomalies.filter((a) => a.severity === "warning").length;
  const score = Math.max(0, 100 - errorCount * 25 - warningCount * 10);

  return {
    timestamp: now,
    healthy: errorCount === 0 && warningCount === 0,
    score,
    anomalies,
    summary: {
      totalCourts: FACILITY_COURTS.length,
      activeCourts,
      availableCourts,
      maintenanceCourts,
      totalMatchesInMemory: matches.length,
      liveMatchesCount: matches.filter((m) => m.status === "live").length,
      queueCount: queue.length,
    },
  };
}

/**
 * Automatically repairs and resolves detected hallucinations and orphaned assignments:
 * - Releases finished or non-existent matches holding court stations.
 * - Reverts phantom matches with stale court claims back to "Queue".
 * - Synchronizes with Supabase cloud.
 */
export function autoHealDispatchAnomalies(
  stations: Record<FacilityCourt, CourtStation>,
  matches: LiveMatch[],
): {
  repairedStations: Record<FacilityCourt, CourtStation>;
  repairedMatches: LiveMatch[];
  repairedCount: number;
} {
  const nextStations = { ...stations };
  let nextMatches = [...matches];
  let repairedCount = 0;

  for (const c of FACILITY_COURTS) {
    const st = nextStations[c];
    if (!st) continue;

    // 1. If station has currentMatchId pointing to a final match or non-existent match
    if (st.currentMatchId) {
      const m = nextMatches.find((x) => x.id === st.currentMatchId || isMatchMatchingStation(x, st.currentMatchId, c));
      if (!m || m.status === "final") {
        nextStations[c] = {
          ...st,
          status: "available",
          currentMatchId: null,
          dispatchedAt: null,
          maintenanceNote: null,
        };
        dbUpdateCourtStation(c, {
          status: "available",
          currentMatchId: null,
          dispatchedAt: null,
          maintenanceNote: null,
        }).catch(() => {});
        repairedCount++;
      }
    }

    // 2. Clear ghost match claims where a match has court === c, but station is available or has different match
    const activeMatchOnCourt = nextStations[c]?.currentMatchId;
    nextMatches = nextMatches.map((m) => {
      if (m.court === c && m.status !== "final") {
        const isLegit =
          activeMatchOnCourt &&
          (m.id === activeMatchOnCourt || isMatchMatchingStation(m, activeMatchOnCourt, c));
        if (!isLegit) {
          repairedCount++;
          return {
            ...m,
            court: "Queue",
            status: m.status === "live" ? ("scheduled" as const) : m.status,
            startedAt: undefined,
          };
        }
      }
      return m;
    });
  }

  // 3. Deduplicate multiple match records for the same team pair:
  // If multiple records exist for the same matchup (e.g. historical un-migrated zombie rows),
  // retain the authoritative record (final, live, or higher scores) and drop the zombie duplicate.
  const pairMap = new Map<string, LiveMatch>();
  const deduplicatedMatches: LiveMatch[] = [];

  for (const m of nextMatches) {
    if (!m.teamAName || !m.teamBName) {
      deduplicatedMatches.push(m);
      continue;
    }
    const pair = [m.teamAName.trim().toLowerCase(), m.teamBName.trim().toLowerCase()].sort().join("::");
    const bracket = (m.stage || "").match(/(?:bracket|pool)\s*([a-z])/i)?.[1]?.toLowerCase() || "pool";
    const key = `${m.tournamentSlug || "event"}::${m.categoryId || "division"}::${bracket}::${pair}`;

    if (!pairMap.has(key)) {
      pairMap.set(key, m);
      deduplicatedMatches.push(m);
    } else {
      const existing = pairMap.get(key)!;
      const existingScore = (existing.score?.teamAScore ?? 0) + (existing.score?.teamBScore ?? 0);
      const newScore = (m.score?.teamAScore ?? 0) + (m.score?.teamBScore ?? 0);

      const mWins =
        (m.status === "final" && existing.status !== "final") ||
        (m.status === "live" && existing.status === "scheduled") ||
        (newScore > existingScore) ||
        (m.court && m.court !== "Queue" && (!existing.court || existing.court === "Queue"));

      if (mWins) {
        const idx = deduplicatedMatches.indexOf(existing);
        if (idx !== -1) {
          deduplicatedMatches[idx] = m;
        }
        pairMap.set(key, m);
        if (existing.status === "scheduled") {
          dbDeleteMatch(existing.id).catch(() => {});
        }
      } else {
        if (m.status === "scheduled") {
          dbDeleteMatch(m.id).catch(() => {});
        }
      }
      repairedCount++;
    }
  }

  nextMatches = deduplicatedMatches;

  if (repairedCount > 0) {
    saveCourtStations(nextStations, false);
    saveMatches(nextMatches, false);
  }

  return {
    repairedStations: nextStations,
    repairedMatches: nextMatches,
    repairedCount,
  };
}

/**
 * Hard Contingency Reset: Clears all local browser drift and restores
 * authoritative state directly from the Supabase cloud master database.
 */
export async function forceCloudMasterReset(tournamentSlug?: string): Promise<{
  success: boolean;
  courtStations: Record<FacilityCourt, CourtStation>;
  matchesCount: number;
}> {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("dv_offline_score_journal");
      localStorage.removeItem(STATIONS_KEY);
      localStorage.removeItem("dv_live_matches");
      localStorage.removeItem(QUEUE_KEY);
    }

    const [cloudStations, cloudMatches] = await Promise.all([
      dbGetCourtStations(),
      dbGetMatches(tournamentSlug),
    ]);

    if (cloudStations && Object.keys(cloudStations).length > 0) {
      saveCourtStations(cloudStations as Record<FacilityCourt, CourtStation>, false);
    }
    if (cloudMatches && Array.isArray(cloudMatches)) {
      saveMatches(cloudMatches, false);
    }

    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("storage"));
      window.dispatchEvent(new Event("dv_court_stations_updated"));
      window.dispatchEvent(new Event("dv_matches_updated"));
      window.dispatchEvent(new Event("dv_live_matches_updated"));
      window.dispatchEvent(new Event("dv_dispatch_queue_updated"));
    }

    return {
      success: true,
      courtStations: getCourtStations(),
      matchesCount: (cloudMatches || []).length,
    };
  } catch (err) {
    console.error("[Contingency] Force Cloud Master Reset failed:", err);
    return {
      success: false,
      courtStations: getCourtStations(),
      matchesCount: 0,
    };
  }
}

/**
 * Downloads a complete, human-readable JSON snapshot of all live courts,
 * dispatch queue, active matches, and offline journals for disaster recovery.
 */
export function exportLiveSnapshot(tournamentSlug?: string): void {
  if (typeof document === "undefined") return;

  const snapshot = {
    exportedAt: new Date().toISOString(),
    tournamentSlug: tournamentSlug || "all",
    courtStations: getCourtStations(),
    dispatchQueue: getDispatchQueue(),
    matches: getMatches(),
    offlineJournal: getOfflineScoreJournal(),
  };

  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dinkvalley-snapshot-${tournamentSlug || "event"}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


