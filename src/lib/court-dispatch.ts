import {
  getMatches,
  saveMatches,
  type LiveMatch,
} from "./match-store";
import {
  dbUpdateCourtStation,
  dbGetCourtStations,
  dbSaveDispatchQueue,
  dbDeleteDispatchQueue,
  getCachedDispatchQueue,
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
};

export type QueueItem = {
  id: string;
  matchId: string;
  tournamentSlug: string;
  categoryId: string;
  stage: string; // e.g. "Pool A - Round 1", "Quarterfinal 2"
  teamAName: string;
  teamAPlayers: string[];
  teamBName: string;
  teamBPlayers: string[];
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
    },
    "Court 2": {
      court: "Court 2",
      status: "available",
      currentMatchId: null,
      onDeckMatchId: null,
      assignedUmpire: null,
      dispatchedAt: null,
      maintenanceNote: null,
    },
    "Court 3": {
      court: "Court 3",
      status: "available",
      currentMatchId: null,
      onDeckMatchId: null,
      assignedUmpire: null,
      dispatchedAt: null,
      maintenanceNote: null,
    },
    "Court 4": {
      court: "Court 4",
      status: "available",
      currentMatchId: null,
      onDeckMatchId: null,
      assignedUmpire: null,
      dispatchedAt: null,
      maintenanceNote: null,
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
        base[c] = { ...base[c], ...parsed[c] };
      }
    }
    return base;
  } catch {
    return getInitialCourtStations();
  }
}

export function saveCourtStations(stations: Record<FacilityCourt, CourtStation>, syncToCloud = true): void {
  try {
    localStorage.setItem(STATIONS_KEY, JSON.stringify(stations));
    window.dispatchEvent(new Event("storage"));
    window.dispatchEvent(new Event("dv_court_stations_updated"));
  } catch {
    // ignore
  }
  if (syncToCloud) {
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
  }
}

/**
 * Reconciles Court Stations with the Matches store:
 * 1. If a station is marked 'live' or 'warmup', verifies that currentMatchId exists and is an active, non-final match.
 *    If missing or already final, clears the station back to 'available'.
 * 2. If a non-final match has court = 'Court X', verifies that Court X station is actually assigned to it.
 *    If Court X station is available or occupied by another match, moves the match's court back to 'Queue'.
 */
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

  for (const c of FACILITY_COURTS) {
    const st = stations[c];
    if (!st) continue;

    if (st.status === "live" || st.status === "warmup") {
      let activeMatch = st.currentMatchId ? matches.find((m) => m.id === st.currentMatchId) : null;
      if (!activeMatch || activeMatch.status === "final") {
        // Fallback: see if there is another match explicitly assigned to this court
        const fallback = matches.find((m) => m.court === c && (m.status === "live" || m.status === "scheduled"));
        if (fallback) {
          stations[c] = {
            ...st,
            currentMatchId: fallback.id,
            status: fallback.status === "live" ? "live" : "warmup",
            dispatchedAt: fallback.startedAt ?? st.dispatchedAt ?? Date.now(),
          };
          modified = true;
        } else {
          // No active match exists for this court station: reset to available
          stations[c] = {
            ...st,
            status: "available",
            currentMatchId: null,
            dispatchedAt: null,
          };
          modified = true;
        }
      }
    } else if (st.status === "available" && st.currentMatchId) {
      stations[c] = {
        ...st,
        currentMatchId: null,
        dispatchedAt: null,
      };
      modified = true;
    }
  }

  // Reconcile matches against court stations
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m || m.status === "final") continue;

    if (m.court && FACILITY_COURTS.includes(m.court as FacilityCourt)) {
      const st = stations[m.court as FacilityCourt];
      const isStationAssigned = st && st.currentMatchId === m.id && st.status !== "available";
      if (!isStationAssigned) {
        // Match claims to be on a facility court, but the court station is not playing it: move to Queue
        matches[i] = {
          ...m,
          court: "Queue",
          status: "scheduled",
          startedAt: undefined,
        };
        modified = true;
      }
    }
  }

  if (modified && typeof window !== "undefined") {
    try {
      localStorage.setItem(STATIONS_KEY, JSON.stringify(stations));
      localStorage.setItem("dv_matches", JSON.stringify(matches));
      window.dispatchEvent(new Event("dv_court_stations_updated"));
      window.dispatchEvent(new Event("dv_matches_updated"));
      window.dispatchEvent(new Event("dv_live_matches_updated"));
    } catch {
      // ignore
    }
  }

  return { stations, matches, modified };
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
    isMatchInSameBracket(q.tournamentSlug, q.categoryId, q.stage, q.teamAName, q.teamBName)
  );

  if (valid.length !== items.length) {
    saveDispatchQueue(valid);
  }

  return valid;
}

export function saveDispatchQueue(queue: QueueItem[]): void {
  // Ensure only matches with teams in the same bracket are persisted
  const sanitized = queue.filter((q) =>
    isMatchInSameBracket(q.tournamentSlug, q.categoryId, q.stage, q.teamAName, q.teamBName)
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
    teamBName: string;
    teamBPlayers?: string[] | undefined;
  },
  umpire?: string | undefined,
  startImmediately = false,
): void {
  // Validate that pool play matches only pair teams within the exact same bracket
  if (match.stage && !isMatchInSameBracket(match.tournamentSlug || "", match.categoryId || "", match.stage, match.teamAName, match.teamBName)) {
    console.warn(`[Dispatch Rejected] ${match.teamAName} vs ${match.teamBName} are not in the same bracket for stage: ${match.stage}`);
    return;
  }

  // Validate that neither team nor player is already live or on-deck on another court
  const conflictA = checkSimultaneousPlayConflict(match.teamAName, match.teamAPlayers, match.tournamentSlug);
  const conflictB = checkSimultaneousPlayConflict(match.teamBName, match.teamBPlayers, match.tournamentSlug);
  const conflict = conflictA || conflictB;
  if (conflict && conflict.court !== court) {
    console.warn(`[Dispatch Rejected] ${conflict.teamName} is already ${conflict.status} on ${conflict.court}`);
    return;
  }

  const matches = getMatches();
  const now = Date.now();

  // Find or create match in live store
  let matchFound = false;
  const updatedMatches = matches.map((m) => {
    if (m.id === match.id) {
      matchFound = true;
      return {
        ...m,
        tournamentSlug: match.tournamentSlug ?? m.tournamentSlug,
        court,
        status: startImmediately ? ("live" as const) : ("scheduled" as const),
        startedAt: startImmediately ? (m.startedAt ?? now) : m.startedAt,
        officiatedBy: umpire ?? m.officiatedBy,
      };
    }
    // Route any other non-final match previously assigned to this court back to Queue
    if (m.court === court && m.status !== "final") {
      return {
        ...m,
        court: "Queue",
      };
    }
    return m;
  });

  if (!matchFound) {
    updatedMatches.push({
      id: match.id,
      tournamentSlug: match.tournamentSlug,
      court,
      teamAName: match.teamAName,
      teamAPlayers: match.teamAPlayers ?? [],
      teamBName: match.teamBName,
      teamBPlayers: match.teamBPlayers ?? [],
      status: startImmediately ? "live" : "scheduled",
      score: {
        teamAScore: 0,
        teamBScore: 0,
        servingTeam: "A",
        serverNumber: 2,
        rallies: [],
      },
      winnerTeam: undefined,
      startedAt: startImmediately ? now : undefined,
      endedAt: undefined,
      officiatedBy: umpire,
    });
  }

  saveMatches(updatedMatches);

  // Update Court Station
  const stations = getCourtStations();
  stations[court] = {
    ...stations[court],
    status: startImmediately ? "live" : "warmup",
    currentMatchId: match.id,
    assignedUmpire: umpire ?? stations[court].assignedUmpire,
    dispatchedAt: now,
    maintenanceNote: null,
  };
  saveCourtStations(stations);

  // Update status of this match in dispatch queue
  const queue = getDispatchQueue();
  const updatedQueue = queue.map((q) => {
    if (q.matchId === match.id) {
      return {
        ...q,
        status: startImmediately ? ("live" as const) : ("dispatched" as const),
        assignedCourt: court,
      };
    }
    return q;
  });

  saveDispatchQueue(updatedQueue);

  // Emit Desk Announcement
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
}

/**
 * Auto-dispatches the #1 priority match from the queue to the given court.
 * Skips any match where a team is currently playing on an active facility court.
 */
export function autoDispatchNext(court: FacilityCourt, tournamentSlug?: string, umpire?: string): QueueItem | null {
  const queue = getDispatchQueue();
  const pending = queue
    .filter((q) => q.status === "queued" || q.status === "on_deck")
    .filter((q) => !tournamentSlug || !q.tournamentSlug || q.tournamentSlug === tournamentSlug)
    .filter((q) => !checkSimultaneousPlayConflict(q.teamAName, q.teamAPlayers, q.tournamentSlug || tournamentSlug) && !checkSimultaneousPlayConflict(q.teamBName, q.teamBPlayers, q.tournamentSlug || tournamentSlug))
    .filter((q) => isMatchInSameBracket(q.tournamentSlug || tournamentSlug || "", q.categoryId || "", q.stage, q.teamAName, q.teamBName))
    .sort((a, b) => a.priority - b.priority);

  if (pending.length === 0) return null;

  const nextMatch = pending[0]!;
  dispatchMatchToCourt(court, {
    id: nextMatch.matchId,
    tournamentSlug: nextMatch.tournamentSlug,
    categoryId: nextMatch.categoryId,
    stage: nextMatch.stage,
    teamAName: nextMatch.teamAName,
    teamAPlayers: nextMatch.teamAPlayers,
    teamBName: nextMatch.teamBName,
    teamBPlayers: nextMatch.teamBPlayers,
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
  saveCourtStations(stations);
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
  saveCourtStations(stations);

  // Unassign any active or scheduled match on this court in matches store
  const allMatches = getMatches();
  let matchesModified = false;
  const updatedMatches = allMatches.map((m) => {
    if ((m.court === court || (currentMatchId && m.id === currentMatchId)) && m.status !== "final") {
      matchesModified = true;
      return {
        ...m,
        court: "Queue",
        status: "scheduled" as const,
        startedAt: undefined,
      };
    }
    return m;
  });
  if (matchesModified) {
    saveMatches(updatedMatches);
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
  saveCourtStations(stations);
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
  saveCourtStations(stations);

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
  saveCourtStations(stations);
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
  saveCourtStations(stations);
}

/**
 * Hydrates court stations from Supabase cloud database into local storage.
 */
export async function hydrateCourtStationsFromCloud(): Promise<Record<FacilityCourt, CourtStation>> {
  try {
    const cloudStations = await dbGetCourtStations();
    if (cloudStations && Object.keys(cloudStations).length > 0) {
      const local = getCourtStations();
      for (const court of FACILITY_COURTS) {
        if (cloudStations[court]) {
          local[court] = {
            ...local[court],
            ...cloudStations[court],
          };
        }
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
    if (!isMatchInSameBracket(it.tournamentSlug, it.categoryId, it.stage, it.teamAName, it.teamBName)) {
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

export function checkRestPeriodConflict(
  teamName: string,
  thresholdMinutes = 20,
): RestWarning | null {
  const matches = getMatches();
  const now = Date.now();
  const clean = teamName.trim().toLowerCase();

  const finishedMatches = matches.filter((m) => {
    if (m.status !== "final" || !m.endedAt) return false;
    const a = m.teamAName.trim().toLowerCase();
    const b = m.teamBName.trim().toLowerCase();
    return a === clean || b === clean;
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
  teamBName: string;
  teamBPlayers: string[];
};

export function getAllActiveParticipants(tournamentSlug?: string): ActivePlayEngagement[] {
  const stations = getCourtStations();
  const matches = getMatches();
  const queue = getDispatchQueue();
  const results: ActivePlayEngagement[] = [];
  const processedCourtMatchIds = new Set<string>();

  // Helper to extract teams and players from any known source given a matchId
  const resolveMatchDetails = (
    matchId: string,
    courtFallback?: string,
  ): { teamAName: string; teamAPlayers: string[]; teamBName: string; teamBPlayers: string[] } | null => {
    // 1. Check in matches store
    const inMatches = matches.find((m) => m.id === matchId && m.status !== "final");
    if (inMatches && inMatches.teamAName && inMatches.teamBName) {
      return {
        teamAName: inMatches.teamAName,
        teamAPlayers: inMatches.teamAPlayers ?? [],
        teamBName: inMatches.teamBName,
        teamBPlayers: inMatches.teamBPlayers ?? [],
      };
    }

    // 2. Check in dispatch queue
    const inQueue = queue.find((q) => q.matchId === matchId);
    if (inQueue && inQueue.teamAName && inQueue.teamBName) {
      return {
        teamAName: inQueue.teamAName,
        teamAPlayers: inQueue.teamAPlayers ?? [],
        teamBName: inQueue.teamBName,
        teamBPlayers: inQueue.teamBPlayers ?? [],
      };
    }

    // 3. Fallback: match by court in matches store
    if (courtFallback) {
      const byCourt = matches.find((m) => m.court === courtFallback && m.status !== "final");
      if (byCourt && byCourt.teamAName && byCourt.teamBName) {
        return {
          teamAName: byCourt.teamAName,
          teamAPlayers: byCourt.teamAPlayers ?? [],
          teamBName: byCourt.teamBName,
          teamBPlayers: byCourt.teamBPlayers ?? [],
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
                  if (matchId.includes(subId)) {
                    return {
                      teamAName: teams[t1].name,
                      teamAPlayers: teams[t1].players ?? [],
                      teamBName: teams[t2].name,
                      teamBPlayers: teams[t2].players ?? [],
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
        teamBName: q.teamBName,
        teamBPlayers: q.teamBPlayers ?? [],
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
          teamBName: m.teamBName,
          teamBPlayers: m.teamBPlayers ?? [],
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
): LiveConflict | null {
  const participants = getAllActiveParticipants(tournamentSlug);
  const cleanTeam = teamName.trim().toLowerCase();
  const cleanPlayers = (players ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean);

  for (const part of participants) {
    const partA = part.teamAName.trim().toLowerCase();
    const partB = part.teamBName.trim().toLowerCase();

    // 1. Direct Team Name Match (either Pair A or Pair B in active match)
    if (cleanTeam && (cleanTeam === partA || cleanTeam === partB)) {
      return {
        teamName,
        court: part.court,
        matchId: part.matchId,
        status: part.state,
      };
    }

    // 2. Individual Player Match in either Pair A or Pair B
    const partPlayers = [
      ...part.teamAPlayers.map((p) => p.trim().toLowerCase()),
      ...part.teamBPlayers.map((p) => p.trim().toLowerCase()),
    ].filter(Boolean);

    for (const player of cleanPlayers) {
      if (partPlayers.includes(player)) {
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
export function isConfirmedDispatchedMatch(
  m: LiveMatch,
  stations?: Record<FacilityCourt, CourtStation> | null,
): boolean {
  if (m.status === "final") return true;

  const currentStations = stations ?? getCourtStations();
  for (const c of FACILITY_COURTS) {
    const st = currentStations[c];
    if (st?.currentMatchId === m.id) return true;
    if (st?.onDeckMatchId === m.id) return true;
  }

  if (
    m.status === "live" &&
    m.court &&
    m.court !== "Queue" &&
    (FACILITY_COURTS as readonly string[]).includes(m.court as FacilityCourt) &&
    currentStations[m.court as FacilityCourt]?.currentMatchId === m.id
  ) {
    return true;
  }

  return false;
}

