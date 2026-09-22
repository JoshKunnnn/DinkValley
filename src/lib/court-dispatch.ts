import {
  getMatches,
  saveMatches,
  type LiveMatch,
} from "./match-store";
import {
  dbUpdateCourtStation,
  dbGetCourtStations,
} from "./supabase-service";

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
    const raw = localStorage.getItem(STATIONS_KEY);
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

/* ─────────────────────────────────────────────
   Dispatch Queue Operations
───────────────────────────────────────────── */

export function getDispatchQueue(): QueueItem[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueueItem[];
  } catch {
    return [];
  }
}

export function saveDispatchQueue(queue: QueueItem[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
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
    teamAName: string;
    teamAPlayers?: string[] | undefined;
    teamBName: string;
    teamBPlayers?: string[] | undefined;
  },
  umpire?: string | undefined,
  startImmediately = false,
): void {
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

  // Remove or update from dispatch queue
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
 */
export function autoDispatchNext(court: FacilityCourt, umpire?: string): QueueItem | null {
  const queue = getDispatchQueue();
  const pending = queue
    .filter((q) => q.status === "queued" || q.status === "on_deck")
    .sort((a, b) => a.priority - b.priority);

  if (pending.length === 0) return null;

  const nextMatch = pending[0]!;
  dispatchMatchToCourt(court, {
    id: nextMatch.matchId,
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
 */
export function vacateCourt(court: FacilityCourt): void {
  const stations = getCourtStations();
  stations[court] = {
    ...stations[court],
    status: "available",
    currentMatchId: null,
    dispatchedAt: null,
    maintenanceNote: null,
  };
  saveCourtStations(stations);
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

  if (matchId) {
    const queue = getDispatchQueue();
    const updated = queue.map((q) => (q.matchId === matchId ? { ...q, status: "on_deck" as const, assignedCourt: court } : q));
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
 */
export function reorderQueue(matchId: string, direction: "up" | "down" | "top"): void {
  const queue = getDispatchQueue();
  const idx = queue.findIndex((q) => q.matchId === matchId);
  if (idx === -1) return;

  const item = queue[idx]!;
  const newQueue = [...queue];

  if (direction === "top") {
    newQueue.splice(idx, 1);
    newQueue.unshift(item);
  } else if (direction === "up" && idx > 0) {
    const prev = newQueue[idx - 1]!;
    newQueue[idx - 1] = item;
    newQueue[idx] = prev;
  } else if (direction === "down" && idx < newQueue.length - 1) {
    const next = newQueue[idx + 1]!;
    newQueue[idx + 1] = item;
    newQueue[idx] = next;
  }

  // Renumber priority
  const renumbered = newQueue.map((q, i) => ({ ...q, priority: i + 1 }));
  saveDispatchQueue(renumbered);
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
};

export function checkSimultaneousPlayConflict(teamName: string): LiveConflict | null {
  const matches = getMatches();
  const clean = teamName.trim().toLowerCase();

  const live = matches.find((m) => {
    if (m.status !== "live" && m.status !== "scheduled") return false;
    // Only actual operating facility courts constitute a physical simultaneous play conflict (not "Queue")
    if (!m.court || !FACILITY_COURTS.includes(m.court as FacilityCourt)) return false;
    const a = m.teamAName.trim().toLowerCase();
    const b = m.teamBName.trim().toLowerCase();
    return a === clean || b === clean;
  });

  if (live) {
    return {
      teamName,
      court: live.court,
      matchId: live.id,
    };
  }

  return null;
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
    (FACILITY_COURTS as readonly string[]).includes(m.court as FacilityCourt)
  ) {
    return true;
  }

  return false;
}

