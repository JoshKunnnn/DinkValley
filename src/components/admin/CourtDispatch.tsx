import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import type { Tournament, Category } from "@/data/tournaments";
import {
  useMatchStore,
  type LiveMatch,
  scorePoint,
  sideOut,
  endGame,
  resetMatch,
  purgeMatchesForCategory,
  purgeMatchesNotInTeams,
  generateBalancedRoundRobinPairs,
  createPairMatchId,
  createCategoryScopedMatchId,
  findMatchForPair,
  migrateMatchesToDeterministicIds,
  isMatchMatchingStation,
} from "@/lib/match-store";
import {
  FACILITY_COURTS,
  type FacilityCourt,
  type CourtStation,
  type QueueItem,
  type DeskAnnouncement,
  getCourtStations,
  saveCourtStations,
  getDispatchQueue,
  saveDispatchQueue,
  getLatestAnnouncement,
  setLatestAnnouncement,
  playDeskChime,
  dispatchMatchToCourt,
  autoDispatchNext,
  vacateCourt,
  setCourtMaintenance,
  setCourtOnDeck,
  reorderQueue,
  removeQueueItem,
  addMatchesToQueue,
  checkRestPeriodConflict,
  checkSimultaneousPlayConflict,
  purgeQueueForCategory,
  purgeQueueNotInTeams,
  getCategorySequence,
  saveCategorySequence,
  getActiveWaveId,
  setActiveWaveId,
  reorderCategorySequence,
  removePlayingConflictsFromQueue,
  completeQueueMatch,
  isQueueItemFinished,
  reconcileDispatchQueue,
  isMatchInSameBracket,
  reconcileCourtStations,
  setCourtActiveBracket,
  getCourtActiveBracket,
  isStageMatchingBracket,
  hydrateCourtStationsFromCloud,
  healAndSyncDispatchStations,
  findMatchForCourtStation,
  isMatchInCategory,
  isQueueItemInCategory,
  releaseCourtStation,
} from "@/lib/court-dispatch";
import { getDrawnGroups } from "@/components/admin/BracketDraw";
import { getMainDrawMatches, syncMainDrawWithLiveMatches } from "@/components/admin/DrawsManager";
import { dbUpdateCourtStation, dbSubscribeToLive, isSameCategory, dbSaveMatch } from "@/lib/supabase-service";
import { DispatchDebugStation, type DebugTab } from "@/components/admin/DispatchDebugStation";
import { MatchHistory } from "@/components/admin/MatchHistory";
import { Search, X, Filter, Clock, Award, CheckCircle2, RotateCcw, History } from "lucide-react";

/** Returns prev when next is structurally identical, so React skips re-renders and memo recomputation. */
function keepIfEqual<T>(prev: T, next: T): T {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

/** Extracts a clean Bracket label (e.g. "Bracket A", "Bracket B", "Playoffs") from a match. */
function getMatchBracketLabel(m: LiveMatch): string {
  if (m.bracketLetter) {
    const letter = m.bracketLetter.replace(/^bracket\s*/i, "").trim().toUpperCase();
    return `Bracket ${letter}`;
  }
  const match = (m.stage || "").match(/(?:bracket|pool)\s+([a-z0-9]+)/i);
  if (match) {
    return `Bracket ${match[1]!.toUpperCase()}`;
  }
  if (m.stage && /quarter|semi|final|playoff|bronze|gold|knockout/i.test(m.stage)) {
    return "Playoffs";
  }
  return m.stage || "Completed Matches";
}

/**
 * Computes all unassigned matches for a category from drawn groups, direct roster buckets, or main draw playoffs.
 */
function computeCategoryUnassignedMatches(
  tournamentSlug: string,
  cat: Category | undefined,
  queue: QueueItem[],
  stations: Record<FacilityCourt, CourtStation>,
  matches: LiveMatch[],
): {
  id: string;
  stage: string;
  teamAName: string;
  teamAPlayers: string[];
  teamBName: string;
  teamBPlayers: string[];
}[] {
  if (!cat?.teams || cat.teams.length < 2) {
    return [];
  }

  const poolGroups = getDrawnGroups(tournamentSlug, cat.id);
  const playoffMatches =
    syncMainDrawWithLiveMatches(tournamentSlug, cat.id, matches, false) ||
    getMainDrawMatches(tournamentSlug, cat.id);
  const validTeamIds = new Set(cat.teams.map((t) => t.id));
  const validTeamNames = new Set(cat.teams.map((t) => t.name.trim().toLowerCase()));

  const queuedIds = new Set(
    queue
      .filter(
        (q) =>
          (!q.categoryId || q.categoryId === cat.id) &&
          (!q.tournamentSlug || q.tournamentSlug === tournamentSlug),
      )
      .map((q) => q.matchId),
  );
  const activeCourtMatchIds = new Set(
    Object.values(stations)
      .map((s) => s.currentMatchId)
      .filter(Boolean),
  );

  const list: {
    id: string;
    stage: string;
    teamAName: string;
    teamAPlayers: string[];
    teamBName: string;
    teamBPlayers: string[];
  }[] = [];

  // 1. From Drawn Pool Groups (only if groups are drawn and slots contain currently registered teams)
  const hasDrawnSlots =
    poolGroups &&
    poolGroups.some((g) =>
      g.isDrawn &&
      g.slots.some(
        (s) =>
          s.team !== null &&
          (validTeamIds.has(s.team.id) || validTeamNames.has(s.team.name.trim().toLowerCase())),
      ),
    );

  if (hasDrawnSlots && poolGroups) {
    for (const group of poolGroups) {
      if (!group.isDrawn) continue;
      const teams = group.slots
        .map((s) => s.team)
        .filter(
          (t): t is { id: string; name: string; players: string[] } =>
            t !== null &&
            (validTeamIds.has(t.id) || validTeamNames.has(t.name.trim().toLowerCase())),
        );

      const nameCounts = new Map<string, number>();
      for (const t of teams) {
        const k = t.name.trim().toLowerCase();
        nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
      }

      const pairs = generateBalancedRoundRobinPairs(teams);
      pairs.forEach(([teamA, teamB], pIdx) => {
        const isSameTeam =
          (teamA.id && teamB.id && teamA.id === teamB.id) ||
          (teamA.name.trim().toLowerCase() === teamB.name.trim().toLowerCase() &&
            teamA.players &&
            teamB.players &&
            teamA.players.length > 0 &&
            teamB.players.length > 0 &&
            teamA.players.slice().sort().join(",").toLowerCase() ===
              teamB.players.slice().sort().join(",").toLowerCase());
        if (isSameTeam) return;

        const isDupA = (nameCounts.get(teamA.name.trim().toLowerCase()) || 0) > 1;
        const isDupB = (nameCounts.get(teamB.name.trim().toLowerCase()) || 0) > 1;

        const scopedMatchId = (teamA.id && teamB.id)
          ? createCategoryScopedMatchId(cat.id, group.letter, teamA.id, teamB.id)
          : null;
        const canonicalId = scopedMatchId || createPairMatchId(
          tournamentSlug,
          cat.id,
          `Bracket ${group.letter}`,
          teamA.name,
          teamB.name,
          teamA.players,
          teamB.players,
          isDupA,
          isDupB,
        );
        const existingLive =
          (scopedMatchId ? matches.find((m) => m.id === scopedMatchId) : null) ||
          findMatchForPair(
            matches,
            teamA.name,
            teamB.name,
            tournamentSlug,
            cat.id,
            group.letter,
            teamA.players,
            teamB.players,
          );
        const effectiveMatchId = existingLive ? existingLive.id : (scopedMatchId || canonicalId);

        if (existingLive?.status === "final" || existingLive?.winnerTeam || existingLive?.endedAt) return;
        const isQueued = queuedIds.has(effectiveMatchId) || queuedIds.has(canonicalId);
        const isOnCourt = activeCourtMatchIds.has(effectiveMatchId) || activeCourtMatchIds.has(canonicalId);
        if (isQueued || isOnCourt) return;

        list.push({
          id: effectiveMatchId,
          stage: `Bracket ${group.letter} (Pool Play)`,
          teamAName: teamA.name,
          teamAPlayers: teamA.players,
          teamBName: teamB.name,
          teamBPlayers: teamB.players,
        });
      });
    }
  }

  // 3. From Playoff Knockout Matches (only if both teams are registered in this category)
  if (playoffMatches) {
    for (const km of playoffMatches) {
      if (!km.teamA || !km.teamB) continue;
      if (
        !validTeamNames.has(km.teamA.name.trim().toLowerCase()) ||
        !validTeamNames.has(km.teamB.name.trim().toLowerCase())
      ) {
        continue;
      }
      const stage = `${km.round} - ${km.label}`;
      const legacyId = `live-ko-${tournamentSlug}-${cat.id}-${km.id}`;
      const canonicalId = createPairMatchId(tournamentSlug, cat.id, stage, km.teamA.name, km.teamB.name);
      const existingLive =
        matches.find((m) => m.id === canonicalId || m.id === legacyId || m.id === km.id) ||
        findMatchForPair(matches, km.teamA.name, km.teamB.name, tournamentSlug, cat.id, stage, km.teamA.players, km.teamB.players) ||
        matches.find((m) => {
          const ma = m.teamAName?.trim().toLowerCase();
          const mb = m.teamBName?.trim().toLowerCase();
          const ta = km.teamA!.name.trim().toLowerCase();
          const tb = km.teamB!.name.trim().toLowerCase();
          if (!((ma === ta && mb === tb) || (ma === tb && mb === ta))) return false;
          const mStage = (m.stage || "").toLowerCase();
          return mStage.includes("quarter") || mStage.includes("semi") || mStage.includes("final") || mStage.includes("playoff") || mStage.includes("bronze");
        });
      const effectiveId = existingLive?.id || canonicalId;

      if (existingLive?.status === "final" || existingLive?.winnerTeam || existingLive?.endedAt || km.winner) continue;
      if (
        queuedIds.has(effectiveId) ||
        queuedIds.has(legacyId) ||
        queuedIds.has(canonicalId) ||
        activeCourtMatchIds.has(effectiveId) ||
        activeCourtMatchIds.has(legacyId) ||
        activeCourtMatchIds.has(canonicalId)
      ) {
        continue;
      }

      list.push({
        id: effectiveId,
        stage,
        teamAName: km.teamA.name,
        teamAPlayers: km.teamA.players ?? [],
        teamBName: km.teamB.name,
        teamBPlayers: km.teamB.players ?? [],
      });
    }
  }

  return list;
}

interface CourtDispatchProps {
  tournament: Tournament;
  category: Category;
  tournaments: Tournament[];
  tournamentSlug: string;
  setTournamentSlug: (slug: string) => void;
  categoryId: string;
  setCategoryId: (id: string) => void;
}

export function CourtDispatch({
  tournament,
  category,
  tournaments,
  tournamentSlug,
  setTournamentSlug,
  categoryId,
  setCategoryId,
}: CourtDispatchProps) {
  const { matches, refresh: refreshMatches, refreshFromCloud, update: updateMatchStore } = useMatchStore(
    tournamentSlug || undefined,
  );
  const [stations, setStations] = useState<Record<FacilityCourt, CourtStation>>(() => getCourtStations());
  const [queue, setQueue] = useState<QueueItem[]>(() => getDispatchQueue());
  const [announcement, setAnnouncement] = useState<DeskAnnouncement | null>(() => getLatestAnnouncement());
  const [mainDispatchTab, setMainDispatchTab] = useState<"history" | "facility">("facility");
  const [activeQueueTab, setActiveQueueTab] = useState<"queue" | "unassigned" | "history" | "custom">("queue");
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"card" | "compact">(() => {
    if (typeof localStorage !== "undefined") {
      return (localStorage.getItem("dv_dispatch_view_mode") as "card" | "compact") ?? "card";
    }
    return "card";
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [resetConfirmMatch, setResetConfirmMatch] = useState<{ court: FacilityCourt; match: LiveMatch } | null>(null);
  const [concludedAlert, setConcludedAlert] = useState<{
    court: FacilityCourt;
    teamAName: string;
    teamBName: string;
    matchId: string;
  } | null>(null);

  // Direct Court Bracket Selection Modal State
  const [selectedCourtForDispatch, setSelectedCourtForDispatch] = useState<FacilityCourt | null>(null);
  const [bracketModalCategory, setBracketModalCategory] = useState<string>(categoryId);
  const [bracketModalSelectedLetter, setBracketModalSelectedLetter] = useState<string>("A");
  const [bracketModalSearchQuery, setBracketModalSearchQuery] = useState<string>("");
  const [bracketModalStatusFilter, setBracketModalStatusFilter] = useState<"all" | "unplayed" | "ready" | "queued" | "completed">("unplayed");
  const [bracketModalTeamFilter, setBracketModalTeamFilter] = useState<string>("all");
  const [bracketModalShowCompleted, setBracketModalShowCompleted] = useState(false);

  // Main Page Active Queue & Unassigned Filtering State
  const [queueBracketFilter, setQueueBracketFilter] = useState<string>("all");
  const [unassignedBracketFilter, setUnassignedBracketFilter] = useState<string>("all");
  const [unassignedTeamFilter, setUnassignedTeamFilter] = useState<string>("all");

  // Match History Filtering State
  const [historyCategoryFilter, setHistoryCategoryFilter] = useState<string>("all");
  const [historyBracketFilter, setHistoryBracketFilter] = useState<string>("all");
  const [historySearchQuery, setHistorySearchQuery] = useState<string>("");
  const [courtReplaceConfirm, setCourtReplaceConfirm] = useState<{
    court: FacilityCourt;
    pendingMatch: {
      id: string;
      stage: string;
      teamAName: string;
      teamAPlayers: string[];
      teamBName: string;
      teamBPlayers: string[];
    };
  } | null>(null);

  // Contingency re-sync loading state
  const [isHealingStations, setIsHealingStations] = useState(false);
  const [isDebugStationOpen, setIsDebugStationOpen] = useState(false);
  const [debugStationTab, setDebugStationTab] = useState<DebugTab>("score_sync");

  // Sync modal category when categoryId changes
  useEffect(() => {
    setBracketModalCategory(categoryId);
  }, [categoryId]);

  // Category sequence & wave arrangement state
  const [categoryOrder, setCategoryOrder] = useState<string[]>(() =>
    getCategorySequence(tournamentSlug, tournament.categories),
  );
  const [activeWaveId, setActiveWaveIdState] = useState<string>(() =>
    getActiveWaveId(tournamentSlug, categoryId),
  );
  const [isDeckCollapsed, setIsDeckCollapsed] = useState(false);

  // Sync sequence order and active wave when tournament or category props change
  useEffect(() => {
    setCategoryOrder(getCategorySequence(tournamentSlug, tournament.categories));
    setActiveWaveIdState(getActiveWaveId(tournamentSlug, categoryId));
  }, [tournamentSlug, tournament.categories, categoryId]);

  // Custom Match form state
  const [customTeamA, setCustomTeamA] = useState("");
  const [customTeamB, setCustomTeamB] = useState("");
  const [customStage, setCustomStage] = useState("Exhibition Match");
  const [customTarget, setCustomTarget] = useState<"queue" | FacilityCourt>("queue");

  // Timer refresh ticker (updates every second for stopwatch display)
  const [, setTicker] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setTicker((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Revision counter to invalidate memoized bracket matches on draw events
  const [drawVersion, setDrawVersion] = useState(0);

  // Available bracket options for the active division/category
  const availableBracketOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [
      { value: "all", label: "All Brackets (Any)" },
    ];
    const poolGroups = getDrawnGroups(tournamentSlug, categoryId);
    if (poolGroups && poolGroups.length > 0) {
      for (const g of poolGroups) {
        if (g.letter) {
          options.push({
            value: `Bracket ${g.letter}`,
            label: `Bracket ${g.letter} (Pool Play)`,
          });
        }
      }
    } else {
      ["A", "B", "C", "D"].forEach((letter) => {
        options.push({
          value: `Bracket ${letter}`,
          label: `Bracket ${letter} (Pool Play)`,
        });
      });
    }
    options.push({
      value: "Playoffs",
      label: "Playoffs (Knockout)",
    });
    return options;
  }, [tournamentSlug, categoryId, drawVersion]);

  const handleSetCourtActiveBracket = (court: FacilityCourt, bracket: string) => {
    setCourtActiveBracket(court, bracket);
    setStations((prev) => ({
      ...prev,
      [court]: {
        ...prev[court],
        activeBracket: bracket,
      },
    }));
    setCopyNotice(`${court} assigned to ${bracket === "all" ? "All Brackets" : bracket}.`);
    setTimeout(() => setCopyNotice(null), 3000);
  };

  // Sync stations, queue, and announcement with storage and auto-clean conflicts
  const isReloadingRef = useRef(false);
  const reloadData = useCallback(() => {
    // Storage writes below dispatch the same events we listen to; guard against synchronous re-entry
    if (isReloadingRef.current) return;
    isReloadingRef.current = true;
    try {
      reconcileCourtStations();
      reconcileDispatchQueue(matches);
      removePlayingConflictsFromQueue(tournamentSlug);
      const nextStations = getCourtStations();
      const nextQueue = getDispatchQueue();
      const nextAnnouncement = getLatestAnnouncement();
      const nextOrder = getCategorySequence(tournamentSlug, tournament.categories);
      setStations((prev) => keepIfEqual(prev, nextStations));
      setQueue((prev) => keepIfEqual(prev, nextQueue));
      setAnnouncement((prev) => keepIfEqual(prev, nextAnnouncement));
      setCategoryOrder((prev) => keepIfEqual(prev, nextOrder));
      setActiveWaveIdState(getActiveWaveId(tournamentSlug, categoryId));
      refreshMatches();
    } finally {
      isReloadingRef.current = false;
    }
  }, [refreshMatches, tournamentSlug, tournament.categories, categoryId, matches]);

  // Synchronize and cleanse finished matches from dispatch queue whenever matches change
  useEffect(() => {
    if (matches && matches.length > 0) {
      reconcileDispatchQueue(matches);
      setQueue((prev) => keepIfEqual(prev, getDispatchQueue()));
    }
  }, [matches]);

  // Cross-device Realtime Sync: Hydrates court stations from Supabase and listens for cloud updates
  useEffect(() => {
    let mounted = true;

    // 1. Initial Cloud Hydration on mount
    hydrateCourtStationsFromCloud().then((cloudStations) => {
      if (mounted) {
        setStations((prev) => keepIfEqual(prev, cloudStations));
        reconcileCourtStations(cloudStations);
      }
    });

    // 2. Realtime listener for cross-device sync (e.g. desktop admin dispatches court, mobile reflects in real-time)
    const unsubRealtime = dbSubscribeToLive(
      () => {
        // Matches or tournament state changed in cloud database
        if (refreshFromCloud) refreshFromCloud();
        else refreshMatches();
        hydrateCourtStationsFromCloud().then((cloudStations) => {
          if (mounted) {
            setStations((prev) => keepIfEqual(prev, cloudStations));
            reloadData();
          }
        });
      },
      () => {
        // Court stations changed in cloud database
        hydrateCourtStationsFromCloud().then((cloudStations) => {
          if (mounted) {
            setStations((prev) => keepIfEqual(prev, cloudStations));
            if (refreshFromCloud) refreshFromCloud();
            else refreshMatches();
            reloadData();
          }
        });
      }
    );

    // 3. Periodic 3s poll fallback to guarantee sync on mobile browsers where WebSockets may sleep
    const pollInterval = setInterval(() => {
      hydrateCourtStationsFromCloud().then((cloudStations) => {
        if (mounted) {
          setStations((prev) => keepIfEqual(prev, cloudStations));
        }
      });
      if (refreshFromCloud) refreshFromCloud();
      else refreshMatches();
    }, 3000);

    return () => {
      mounted = false;
      unsubRealtime();
      clearInterval(pollInterval);
    };
  }, [refreshMatches, refreshFromCloud]);

  // Detect newly concluded matches (e.g. from Umpire) to notify organizer that next matchups can be added
  const prevMatchesRef = useRef<LiveMatch[]>(matches);
  useEffect(() => {
    const prev = prevMatchesRef.current;
    for (const m of matches) {
      if (m.status === "final") {
        const prevM = prev.find((x: LiveMatch) => x.id === m.id);
        if (prevM && prevM.status !== "final") {
          setConcludedAlert({
            court: (m.court as FacilityCourt) || "Court 1",
            teamAName: m.teamAName,
            teamBName: m.teamBName,
            matchId: m.id,
          });
        }
      }
    }
    for (const c of tournament.categories) {
      syncMainDrawWithLiveMatches(tournamentSlug, c.id, matches, true);
    }
    prevMatchesRef.current = matches;
  }, [matches, tournament.categories, tournamentSlug]);

  useEffect(() => {
    // Coalesce bursts of storage/custom events into a single deferred reload.
    // Calling reloadData synchronously from these listeners re-entered itself (its own writes
    // fire these events), which locked up the Dispatch screen.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let drawChanged = false;
    const scheduleReload = (bumpDraws: boolean) => {
      if (bumpDraws) drawChanged = true;
      if (timer !== null || isReloadingRef.current) return;
      timer = setTimeout(() => {
        timer = null;
        if (drawChanged) {
          drawChanged = false;
          setDrawVersion((v) => v + 1);
        }
        reloadData();
      }, 50);
    };
    const handleDataChange = () => scheduleReload(false);
    const handleDrawChange = () => scheduleReload(true);
    // Periodic tick: draws hydrated into the cloud cache do not always emit an event,
    // so detect changes by storage signatures and only then invalidate bracket memos.
    let lastDrawFingerprint = "";
    const handleTick = () => {
      if (typeof localStorage === "undefined") return;
      let fp = "";
      for (const c of tournament.categories) {
        const g = localStorage.getItem(`dv_drawn_groups_${tournamentSlug}_${c.id}`);
        const m = localStorage.getItem(`dv_main_draw_${tournamentSlug}_${c.id}`);
        fp += `${c.id}:${g?.length || 0}:${m?.length || 0};`;
      }
      if (fp !== lastDrawFingerprint) {
        lastDrawFingerprint = fp;
        scheduleReload(true);
      }
    };

    window.addEventListener("storage", handleDrawChange);
    window.addEventListener("dv_drawn_groups_updated", handleDrawChange);
    window.addEventListener("dv_dispatch_queue_updated", handleDataChange);
    window.addEventListener("dv_live_matches_updated", handleDataChange);
    window.addEventListener("dv_category_sequence_updated", handleDataChange);
    window.addEventListener("dv_court_stations_updated", handleDataChange);
    const interval = setInterval(handleTick, 2000);
    return () => {
      window.removeEventListener("storage", handleDrawChange);
      window.removeEventListener("dv_drawn_groups_updated", handleDrawChange);
      window.removeEventListener("dv_dispatch_queue_updated", handleDataChange);
      window.removeEventListener("dv_live_matches_updated", handleDataChange);
      window.removeEventListener("dv_category_sequence_updated", handleDataChange);
      window.removeEventListener("dv_court_stations_updated", handleDataChange);
      clearInterval(interval);
      if (timer !== null) clearTimeout(timer);
    };
  }, [reloadData, tournament.categories, tournamentSlug]);

  // Auto-sync & auto-cleanup: If players/teams were deleted from the database/roster,
  // automatically purge orphaned matches from the dispatch queue, court stations, and bracket cache.
  useEffect(() => {
    if (!category) return;
    const currentQueue = getDispatchQueue();
    const isCatMatch = (q: QueueItem) =>
      isSameCategory(q.categoryId, categoryId) ||
      (!q.categoryId && q.matchId && q.matchId.includes(categoryId));

    // Case 1: All players in category were deleted
    if (!category.teams || category.teams.length === 0) {
      try {
        localStorage.removeItem(`dv_drawn_groups_${tournamentSlug}_${categoryId}`);
        localStorage.removeItem(`dv_main_draw_${tournamentSlug}_${categoryId}`);
      } catch {
        // ignore
      }

      const hasStale = currentQueue.some(
        (q) => isCatMatch(q) && !q.id.startsWith("custom-"),
      );
      if (hasStale) {
        purgeQueueForCategory(tournamentSlug, categoryId);
        purgeMatchesForCategory(tournamentSlug, categoryId);
        reloadData();
      }
    } else {
      // Case 2: Specific teams or players were deleted from database
      const validNames = category.teams.map((t) => t.name.trim().toLowerCase());
      const validSet = new Set(validNames);
      const hasOrphanMatches = currentQueue.some((q) => {
        if (!isCatMatch(q) || q.id.startsWith("custom-")) return false;
        return !validSet.has(q.teamAName.trim().toLowerCase()) || !validSet.has(q.teamBName.trim().toLowerCase());
      });

      if (hasOrphanMatches) {
        purgeQueueNotInTeams(tournamentSlug, categoryId, validNames);
        purgeMatchesNotInTeams(tournamentSlug, categoryId, validNames);
        reloadData();
      }
    }
  }, [category, categoryId, tournamentSlug, reloadData]);

  // Migrate legacy index-based match IDs to deterministic team-pair IDs
  useEffect(() => {
    migrateMatchesToDeterministicIds();
  }, []);

  // Division filter for active queue & history ("current" = selected category only, "all" = all categories)
  const [queueDivisionFilter, setQueueDivisionFilter] = useState<"current" | "all">("current");

  // Derive active matches for each court
  const courtMatches = useMemo(() => {
    const map: Record<FacilityCourt, LiveMatch | null> = {
      "Court 1": null,
      "Court 2": null,
      "Court 3": null,
      "Court 4": null,
    };

    for (const court of FACILITY_COURTS) {
      map[court] = findMatchForCourtStation(court, stations[court], matches);
    }

    return map;
  }, [stations, matches]);

  // Extract all unassigned matches from Pool Draws, Category Teams Roster, or Main Draw Playoffs
  const unassignedMatches = useMemo(() => {
    return computeCategoryUnassignedMatches(tournamentSlug, category, queue, stations, matches);
  }, [tournamentSlug, category, queue, stations, matches, drawVersion]);

  // Statistics and progress for each category across the tournament
  const categoryStatsMap = useMemo(() => {
    const map = new Map<
      string,
      {
        totalMatches: number;
        completedCount: number;
        onCourtCount: number;
        queuedCount: number;
        unassignedCount: number;
        progressPercent: number;
        isCompleted: boolean;
      }
    >();

    for (const cat of tournament.categories) {
      const poolGroups = getDrawnGroups(tournamentSlug, cat.id);
      const playoffMatches =
        syncMainDrawWithLiveMatches(tournamentSlug, cat.id, matches, false) ||
        getMainDrawMatches(tournamentSlug, cat.id);

      // 1. Calculate true scheduled match capacity based on drawn groups and playoff draw
      let scheduledPoolMatches = 0;
      if (poolGroups && poolGroups.length > 0) {
        for (const g of poolGroups) {
          const validSlots = g.slots.filter((s) => s.team !== null);
          if (validSlots.length >= 2) {
            scheduledPoolMatches += (validSlots.length * (validSlots.length - 1)) / 2;
          }
        }
      }
      const scheduledPlayoffs = playoffMatches && playoffMatches.length > 0 ? playoffMatches.length : 0;
      const scheduledTotal = scheduledPoolMatches + scheduledPlayoffs;

      const unassigned = computeCategoryUnassignedMatches(tournamentSlug, cat, queue, stations, matches);

      // 2. Deduplicate completed matches by canonical matchup pair and stage so duplicate DB rows count once
      const seenCompletedKeys = new Set<string>();
      matches.forEach((m) => {
        if (m.status !== "final") return;
        if (!isMatchInCategory(m, cat, tournamentSlug)) return;
        const a = m.teamAName?.trim().toLowerCase();
        const b = m.teamBName?.trim().toLowerCase();
        if (!a || !b || a === b) return;
        const pairKey = [a, b].sort().join("::");
        const stageKey = (m.stage || "match").trim().toLowerCase();
        seenCompletedKeys.add(`${pairKey}::${stageKey}`);
      });
      const completedCount = seenCompletedKeys.size;

      const onCourtCount = matches.filter((m) => {
        if (!isMatchInCategory(m, cat, tournamentSlug)) return false;
        if (m.status === "live") return true;
        return Object.values(stations).some(
          (s) => s?.currentMatchId === m.id && (s.status === "live" || s.status === "warmup"),
        );
      }).length;

      const queuedCount = queue.filter(
        (q) =>
          (q.status === "queued" || q.status === "on_deck") &&
          isQueueItemInCategory(q, cat, tournamentSlug),
      ).length;

      const unassignedCount = unassigned.length;
      
      // True scheduled total from tournament draws takes precedence
      const totalMatches =
        scheduledTotal > 0
          ? scheduledTotal
          : completedCount + onCourtCount + queuedCount + unassignedCount;
      const progressPercent = totalMatches > 0 ? Math.min(100, Math.round((completedCount / totalMatches) * 100)) : 0;
      const isCompleted = totalMatches > 0 && completedCount >= totalMatches;

      map.set(cat.id, {
        totalMatches,
        completedCount,
        onCourtCount,
        queuedCount,
        unassignedCount,
        progressPercent,
        isCompleted,
      });
    }

    return map;
  }, [tournament.categories, tournamentSlug, queue, stations, matches, drawVersion]);

  const activeIndex = categoryOrder.indexOf(activeWaveId);
  const currentWaveNumber = activeIndex >= 0 ? activeIndex + 1 : 1;
  const nextCategory =
    activeIndex >= 0 && activeIndex < categoryOrder.length - 1
      ? tournament.categories.find((c) => c.id === categoryOrder[activeIndex + 1])
      : null;
  const nextWaveNumber = nextCategory ? activeIndex + 2 : null;
  const activeStats = categoryStatsMap.get(activeWaveId);
  const isActiveWaveComplete = Boolean(
    activeStats &&
    activeStats.totalMatches > 0 &&
    activeStats.completedCount === activeStats.totalMatches,
  );

  // Metrics
  const metrics = useMemo(() => {
    let liveCount = 0;
    let warmupCount = 0;
    let availableCount = 0;
    let maintCount = 0;

    for (const c of FACILITY_COURTS) {
      const st = stations[c].status;
      if (st === "live") liveCount++;
      else if (st === "warmup") warmupCount++;
      else if (st === "maintenance") maintCount++;
      else availableCount++;
    }

    const pendingQueueCount = queue.filter((q) => q.status === "queued" || q.status === "on_deck").length;
    const completedMatches = matches.filter((m) => m.status === "final");

    // Average duration
    let avgDurationMin = 0;
    const durations = completedMatches
      .filter((m) => m.startedAt && m.endedAt && m.endedAt > m.startedAt)
      .map((m) => Math.round(((m.endedAt ?? 0) - (m.startedAt ?? 0)) / (60 * 1000)));

    if (durations.length > 0) {
      const sum = durations.reduce((a, b) => a + b, 0);
      avgDurationMin = Math.round(sum / durations.length);
    }

    return {
      liveCount,
      warmupCount,
      availableCount,
      maintCount,
      pendingQueueCount,
      completedCount: completedMatches.length,
      avgDurationMin: avgDurationMin || 18,
    };
  }, [stations, queue, matches]);

  // Memoized data for Court Bracket Selection Modal
  const bracketModalData = useMemo(() => {
    if (!selectedCourtForDispatch) {
      return {
        groups: [] as Array<{
          letter: string;
          label: string;
          unplayedCount: number;
          completedCount: number;
          totalCount: number;
          matches: Array<{
            id: string;
            stage: string;
            bracketLetter: string;
            teamAName: string;
            teamAPlayers: string[];
            teamBName: string;
            teamBPlayers: string[];
            status: "unassigned" | "queued" | "live" | "final";
            assignedCourt?: string | undefined;
            queueIndex?: number | undefined;
            liveScore?: { teamAScore: number; teamBScore: number } | undefined;
            winnerTeam?: string | undefined;
          }>;
        }>,
        activeCategory: category,
      };
    }

    const activeCat = tournament.categories.find((c) => c.id === bracketModalCategory) || category;
    const poolGroups = getDrawnGroups(tournamentSlug, activeCat.id);
    const playoffMatches =
      syncMainDrawWithLiveMatches(tournamentSlug, activeCat.id, matches, false) ||
      getMainDrawMatches(tournamentSlug, activeCat.id);

    const groupsList: Array<{
      letter: string;
      label: string;
      unplayedCount: number;
      completedCount: number;
      totalCount: number;
      matches: Array<{
        id: string;
        stage: string;
        bracketLetter: string;
        teamAName: string;
        teamAPlayers: string[];
        teamBName: string;
        teamBPlayers: string[];
        status: "unassigned" | "queued" | "live" | "final";
        assignedCourt?: string | undefined;
        queueIndex?: number | undefined;
        liveScore?: { teamAScore: number; teamBScore: number } | undefined;
        winnerTeam?: string | undefined;
      }>;
    }> = [];

    if (poolGroups && poolGroups.length > 0) {
      for (const group of poolGroups) {
        if (!group.isDrawn && !group.slots.some((s) => s.team !== null)) continue;
        const teams = group.slots
          .map((s) => s.team)
          .filter((t): t is { id: string; name: string; players: string[] } => t !== null);

        const nameCounts = new Map<string, number>();
        for (const t of teams) {
          const k = t.name.trim().toLowerCase();
          nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
        }

        const groupMatches: typeof groupsList[number]["matches"] = [];

        for (let i = 0; i < teams.length; i++) {
          for (let j = i + 1; j < teams.length; j++) {
            const teamA = teams[i]!;
            const teamB = teams[j]!;
            const isSameTeam =
              (teamA.id && teamB.id && teamA.id === teamB.id) ||
              (teamA.name.trim().toLowerCase() === teamB.name.trim().toLowerCase() &&
                teamA.players &&
                teamB.players &&
                teamA.players.length > 0 &&
                teamB.players.length > 0 &&
                teamA.players.slice().sort().join(",").toLowerCase() ===
                  teamB.players.slice().sort().join(",").toLowerCase());
            if (isSameTeam) continue;

            const isDupA = (nameCounts.get(teamA.name.trim().toLowerCase()) || 0) > 1;
            const isDupB = (nameCounts.get(teamB.name.trim().toLowerCase()) || 0) > 1;

            const stage = `Bracket ${group.letter} (Pool Play)`;
            const scopedMatchId = (teamA.id && teamB.id)
              ? createCategoryScopedMatchId(activeCat.id, group.letter, teamA.id, teamB.id)
              : null;
            const matchId = scopedMatchId || createPairMatchId(
              tournamentSlug,
              activeCat.id,
              `Bracket ${group.letter}`,
              teamA.name,
              teamB.name,
              teamA.players,
              teamB.players,
              isDupA,
              isDupB,
            );
            const existing =
              (scopedMatchId ? matches.find((m) => m.id === scopedMatchId) : null) ||
              findMatchForPair(
                matches,
                teamA.name,
                teamB.name,
                tournamentSlug,
                activeCat.id,
                group.letter,
                teamA.players,
                teamB.players,
              );
            const effectiveMatchId = existing?.id || matchId;

            let matchStatus: "unassigned" | "queued" | "live" | "final" = "unassigned";
            let assignedCourt: string | undefined = undefined;
            let queueIndex: number | undefined = undefined;

            if (existing?.status === "final" || existing?.winnerTeam || existing?.endedAt) {
              matchStatus = "final";
            } else {
              const courtEntry = Object.entries(stations).find(
                ([c, st]) =>
                  (st.currentMatchId === effectiveMatchId || st.currentMatchId === matchId || (existing && st.currentMatchId === existing.id)) &&
                  (st.status === "live" || st.status === "warmup"),
              );
              if (courtEntry) {
                matchStatus = "live";
                assignedCourt = courtEntry[0];
              } else if (
                existing?.status === "live" &&
                existing.court &&
                existing.court !== "Queue" &&
                stations[existing.court as FacilityCourt]?.currentMatchId === existing.id
              ) {
                matchStatus = "live";
                assignedCourt = existing.court;
              } else {
                const qIdx = queue.findIndex(
                  (q) =>
                    (q.matchId === effectiveMatchId || q.matchId === matchId || (existing && q.matchId === existing.id)) &&
                    (q.status === "queued" || q.status === "on_deck"),
                );
                if (qIdx !== -1) {
                  matchStatus = "queued";
                  queueIndex = qIdx + 1;
                }
              }
            }

            groupMatches.push({
              id: effectiveMatchId,
              stage,
              bracketLetter: group.letter,
              teamAName: teamA.name,
              teamAPlayers: teamA.players,
              teamBName: teamB.name,
              teamBPlayers: teamB.players,
              status: matchStatus,
              assignedCourt,
              queueIndex,
              liveScore: existing?.score ? { teamAScore: existing.score.teamAScore, teamBScore: existing.score.teamBScore } : undefined,
              winnerTeam: existing?.winnerTeam,
            });
          }
        }

        const unplayed = groupMatches.filter((m) => m.status !== "final").length;
        const completed = groupMatches.filter((m) => m.status === "final").length;

        groupsList.push({
          letter: group.letter,
          label: `Bracket ${group.letter}`,
          unplayedCount: unplayed,
          completedCount: completed,
          totalCount: groupMatches.length,
          matches: groupMatches,
        });
      }
    }

    if (playoffMatches && playoffMatches.length > 0) {
      const koMatches: typeof groupsList[number]["matches"] = [];
      for (const km of playoffMatches) {
        if (!km.teamA || !km.teamB) continue;
        const stage = `${km.round} - ${km.label}`;
        const legacyId = `live-ko-${tournamentSlug}-${activeCat.id}-${km.id}`;
        const canonicalId = createPairMatchId(tournamentSlug, activeCat.id, stage, km.teamA.name, km.teamB.name);
        const existing =
          matches.find((m) => m.id === canonicalId || m.id === legacyId || m.id === km.id) ||
          findMatchForPair(matches, km.teamA.name, km.teamB.name, tournamentSlug, activeCat.id, stage, km.teamA.players, km.teamB.players) ||
          matches.find((m) => {
            const ma = m.teamAName?.trim().toLowerCase();
            const mb = m.teamBName?.trim().toLowerCase();
            const ta = km.teamA!.name.trim().toLowerCase();
            const tb = km.teamB!.name.trim().toLowerCase();
            if (!((ma === ta && mb === tb) || (ma === tb && mb === ta))) return false;
            const mStage = (m.stage || "").toLowerCase();
            return mStage.includes("quarter") || mStage.includes("semi") || mStage.includes("final") || mStage.includes("playoff") || mStage.includes("bronze");
          });
        const effectiveId = existing?.id || canonicalId;

        let matchStatus: "unassigned" | "queued" | "live" | "final" = "unassigned";
        let assignedCourt: string | undefined = undefined;
        let queueIndex: number | undefined = undefined;

        if (existing?.status === "final" || existing?.winnerTeam || existing?.endedAt || km.winner) {
          matchStatus = "final";
        } else {
          const courtEntry = Object.entries(stations).find(
            ([c, st]) =>
              (st.currentMatchId === effectiveId ||
                st.currentMatchId === legacyId ||
                st.currentMatchId === canonicalId ||
                (existing && isMatchMatchingStation(existing, st.currentMatchId, c))) &&
              (st.status === "live" || st.status === "warmup"),
          );
          if (courtEntry) {
            matchStatus = "live";
            assignedCourt = courtEntry[0];
          } else if (
            existing?.status === "live" &&
            existing.court &&
            existing.court !== "Queue" &&
            stations[existing.court as FacilityCourt]?.currentMatchId === existing.id
          ) {
            matchStatus = "live";
            assignedCourt = existing.court;
          } else {
            const qIdx = queue.findIndex(
              (q) =>
                (q.matchId === effectiveId ||
                  q.matchId === canonicalId ||
                  q.matchId === legacyId ||
                  q.matchId === existing?.id) &&
                (q.status === "queued" || q.status === "on_deck"),
            );
            if (qIdx !== -1) {
              matchStatus = "queued";
              queueIndex = qIdx + 1;
            }
          }
        }

        koMatches.push({
          id: effectiveId,
          stage,
          bracketLetter: "Playoffs",
          teamAName: km.teamA.name,
          teamAPlayers: km.teamA.players ?? [],
          teamBName: km.teamB.name,
          teamBPlayers: km.teamB.players ?? [],
          status: matchStatus,
          assignedCourt,
          queueIndex,
          liveScore: existing?.score ? { teamAScore: existing.score.teamAScore, teamBScore: existing.score.teamBScore } : undefined,
          winnerTeam: existing?.winnerTeam,
        });
      }

      if (koMatches.length > 0) {
        groupsList.push({
          letter: "Playoffs",
          label: "Playoffs",
          unplayedCount: koMatches.filter((m) => m.status !== "final").length,
          completedCount: koMatches.filter((m) => m.status === "final").length,
          totalCount: koMatches.length,
          matches: koMatches,
        });
      }
    }

    return {
      groups: groupsList,
      activeCategory: activeCat,
    };
  }, [
    selectedCourtForDispatch,
    bracketModalCategory,
    tournamentSlug,
    tournament.categories,
    category,
    matches,
    queue,
    stations,
    drawVersion,
  ]);

  // Keep selected bracket letter aligned with available groups in modal
  const prevCourtModalRef = useRef<FacilityCourt | null>(null);

  useEffect(() => {
    if (selectedCourtForDispatch && bracketModalData.groups.length > 0) {
      const isInitialOpen = prevCourtModalRef.current !== selectedCourtForDispatch;
      prevCourtModalRef.current = selectedCourtForDispatch;

      if (isInitialOpen) {
        const assignedBracket = stations[selectedCourtForDispatch]?.activeBracket;
        let targetLetter: string | null = null;
        if (assignedBracket && assignedBracket !== "all") {
          if (assignedBracket.toLowerCase() === "playoffs") {
            targetLetter = "Playoffs";
          } else {
            const letterMatch = assignedBracket.match(/(?:bracket|pool)?\s*([a-z])/i);
            if (letterMatch) {
              targetLetter = letterMatch[1]!.toUpperCase();
            }
          }
        }

        const targetGroup = targetLetter
          ? bracketModalData.groups.find((g) => g.letter === targetLetter)
          : null;

        if (targetGroup && targetGroup.unplayedCount > 0) {
          setBracketModalSelectedLetter(targetLetter!);
        } else {
          const firstWithUnplayed = bracketModalData.groups.find((g) => g.unplayedCount > 0);
          if (firstWithUnplayed) {
            setBracketModalSelectedLetter(firstWithUnplayed.letter);
          } else if (targetLetter) {
            setBracketModalSelectedLetter(targetLetter);
          } else {
            setBracketModalSelectedLetter(bracketModalData.groups[0]?.letter ?? "A");
          }
        }
      } else {
        const exists = bracketModalSelectedLetter === "ALL" || bracketModalData.groups.some((g) => g.letter === bracketModalSelectedLetter);
        if (!exists) {
          const firstWithUnplayed = bracketModalData.groups.find((g) => g.unplayedCount > 0);
          setBracketModalSelectedLetter(firstWithUnplayed ? firstWithUnplayed.letter : (bracketModalData.groups[0]?.letter ?? "A"));
        }
      }
    } else if (!selectedCourtForDispatch) {
      prevCourtModalRef.current = null;
    }
  }, [selectedCourtForDispatch, bracketModalData.groups, stations, bracketModalSelectedLetter]);

  const handleOpenBracketModal = (court: FacilityCourt) => {
    prevCourtModalRef.current = null;
    setSelectedCourtForDispatch(court);
    setBracketModalCategory(categoryId);
    setBracketModalSearchQuery("");
    setBracketModalStatusFilter("unplayed");
    setBracketModalTeamFilter("all");
    setBracketModalShowCompleted(false);
  };

  // Matches for current modal selection (either "ALL" merged or single bracket group)
  const modalSourceMatches = useMemo(() => {
    if (bracketModalSelectedLetter === "ALL") {
      return bracketModalData.groups.flatMap((g) => g.matches);
    }
    const currentGroup = bracketModalData.groups.find((g) => g.letter === bracketModalSelectedLetter);
    return currentGroup ? currentGroup.matches : [];
  }, [bracketModalData.groups, bracketModalSelectedLetter]);

  // Unique teams/clubs present in current modal bracket selection
  const availableModalTeams = useMemo(() => {
    const set = new Set<string>();
    modalSourceMatches.forEach((m) => {
      if (m.teamAName) set.add(m.teamAName.trim());
      if (m.teamBName) set.add(m.teamBName.trim());
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [modalSourceMatches]);

  // Quick statistics for current modal bracket selection
  const modalStats = useMemo(() => {
    const total = modalSourceMatches.length;
    const completed = modalSourceMatches.filter((m) => m.status === "final").length;
    const queued = modalSourceMatches.filter((m) => m.status === "queued").length;
    const live = modalSourceMatches.filter((m) => m.status === "live").length;
    const unplayed = modalSourceMatches.filter((m) => m.status !== "final").length;
    const ready = modalSourceMatches.filter((m) => {
      if (m.status !== "unassigned") return false;
      const liveA = checkSimultaneousPlayConflict(m.teamAName, m.teamAPlayers, tournamentSlug);
      const liveB = checkSimultaneousPlayConflict(m.teamBName, m.teamBPlayers, tournamentSlug);
      return !liveA && !liveB;
    }).length;
    return { total, completed, queued, live, unplayed, ready };
  }, [modalSourceMatches, tournamentSlug]);

  // Filtered matches for direct court modal (search query, team/club filter, status filter)
  const displayedModalMatches = useMemo(() => {
    const q = bracketModalSearchQuery.trim().toLowerCase();
    return modalSourceMatches.filter((m) => {
      // 1. Status filter
      if (bracketModalStatusFilter === "unplayed" && m.status === "final") return false;
      if (bracketModalStatusFilter === "completed" && m.status !== "final") return false;
      if (bracketModalStatusFilter === "queued" && m.status !== "queued") return false;
      if (bracketModalStatusFilter === "ready") {
        if (m.status !== "unassigned") return false;
        const liveA = checkSimultaneousPlayConflict(m.teamAName, m.teamAPlayers, tournamentSlug);
        const liveB = checkSimultaneousPlayConflict(m.teamBName, m.teamBPlayers, tournamentSlug);
        if (liveA || liveB) return false;
      }

      // 2. Team/Club filter
      if (bracketModalTeamFilter !== "all") {
        const tf = bracketModalTeamFilter.trim().toLowerCase();
        const matchA = m.teamAName.trim().toLowerCase() === tf;
        const matchB = m.teamBName.trim().toLowerCase() === tf;
        if (!matchA && !matchB) return false;
      }

      // 3. Search query
      if (q) {
        const inA = m.teamAName.toLowerCase().includes(q);
        const inB = m.teamBName.toLowerCase().includes(q);
        const inStage = m.stage.toLowerCase().includes(q);
        const inPlayersA = (m.teamAPlayers || []).some((p) => p.toLowerCase().includes(q));
        const inPlayersB = (m.teamBPlayers || []).some((p) => p.toLowerCase().includes(q));
        if (!inA && !inB && !inStage && !inPlayersA && !inPlayersB) return false;
      }

      return true;
    });
  }, [
    modalSourceMatches,
    bracketModalStatusFilter,
    bracketModalTeamFilter,
    bracketModalSearchQuery,
    tournamentSlug,
  ]);

  // Push single match from modal into active dispatch queue
  const handleQueueModalSingle = (match: {
    id: string;
    stage: string;
    teamAName: string;
    teamAPlayers: string[];
    teamBName: string;
    teamBPlayers: string[];
  }) => {
    if (
      !isMatchInSameBracket(
        tournamentSlug,
        bracketModalCategory,
        match.stage,
        match.teamAName,
        match.teamBName,
        undefined,
        undefined,
        match.teamAPlayers,
        match.teamBPlayers,
      )
    ) {
      setCopyNotice("Cannot queue: teams belong to different brackets");
      setTimeout(() => setCopyNotice(null), 3000);
      return;
    }

    addMatchesToQueue([
      {
        matchId: match.id,
        tournamentSlug,
        categoryId: bracketModalCategory,
        stage: match.stage,
        teamAName: match.teamAName,
        teamAPlayers: match.teamAPlayers,
        teamBName: match.teamBName,
        teamBPlayers: match.teamBPlayers,
      },
    ]);
    reloadData();
    setCopyNotice(`Queued ${match.teamAName} vs ${match.teamBName}`);
    setTimeout(() => setCopyNotice(null), 3000);
  };

  // Push all displayed unassigned matches from modal into active dispatch queue
  const handleQueueAllDisplayedModalMatches = () => {
    const unassignedInView = displayedModalMatches.filter((m) => m.status === "unassigned");
    const valid = unassignedInView.filter((m) =>
      isMatchInSameBracket(
        tournamentSlug,
        bracketModalCategory,
        m.stage,
        m.teamAName,
        m.teamBName,
        undefined,
        undefined,
        m.teamAPlayers,
        m.teamBPlayers,
      ),
    );

    if (valid.length === 0) {
      setCopyNotice("No unassigned matches to queue in current view");
      setTimeout(() => setCopyNotice(null), 2500);
      return;
    }

    const items = valid.map((m) => ({
      matchId: m.id,
      tournamentSlug,
      categoryId: bracketModalCategory,
      stage: m.stage,
      teamAName: m.teamAName,
      teamAPlayers: m.teamAPlayers,
      teamBName: m.teamBName,
      teamBPlayers: m.teamBPlayers,
    }));

    addMatchesToQueue(items);
    reloadData();
    setCopyNotice(`Queued ${items.length} match(es) to dispatch queue`);
    setTimeout(() => setCopyNotice(null), 3000);
  };

  const handleSelectBracketMatchForCourt = (
    court: FacilityCourt,
    match: {
      id: string;
      stage: string;
      teamAName: string;
      teamAPlayers: string[];
      teamBName: string;
      teamBPlayers: string[];
    },
  ) => {
    const liveA = checkSimultaneousPlayConflict(match.teamAName, match.teamAPlayers, tournamentSlug);
    const liveB = checkSimultaneousPlayConflict(match.teamBName, match.teamBPlayers, tournamentSlug);
    const conflict = liveA || liveB;
    if (conflict && conflict.court !== court) {
      setCopyNotice(`Cannot dispatch: ${conflict.isPlayerConflict ? `${conflict.playerName} (${conflict.teamName})` : conflict.teamName} is ${conflict.status === "on_deck" ? "on-deck" : "live"} on ${conflict.court}`);
      setTimeout(() => setCopyNotice(null), 4000);
      return;
    }

    const station = stations[court];
    const active = courtMatches[court];

    if (active && station.status === "live") {
      setCourtReplaceConfirm({ court, pendingMatch: match });
      return;
    }

    executeBracketDispatch(court, match);
  };

  const executeBracketDispatch = async (
    court: FacilityCourt,
    match: {
      id: string;
      stage: string;
      teamAName: string;
      teamAPlayers: string[];
      teamBName: string;
      teamBPlayers: string[];
    },
  ) => {
    await handleDispatch(court, {
      id: match.id,
      tournamentSlug,
      categoryId: bracketModalCategory,
      stage: match.stage,
      teamAName: match.teamAName,
      teamAPlayers: match.teamAPlayers,
      teamBName: match.teamBName,
      teamBPlayers: match.teamBPlayers,
    });
    setSelectedCourtForDispatch(null);
    setCourtReplaceConfirm(null);
    setCopyNotice(`Dispatched ${match.teamAName} vs ${match.teamBName} to ${court}`);
    setTimeout(() => setCopyNotice(null), 3000);
  };

  // Filtered active queue (search-aware, division-aware, priority-sorted)
  const filteredQueue = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const validTeamNames = category?.teams
      ? new Set(category.teams.map((t) => t.name.trim().toLowerCase()))
      : new Set<string>();

    return queue
      .filter((item) => item.status === "queued" || item.status === "on_deck")
      .filter((item) => !isQueueItemFinished(item, matches))
      .filter((item) => {
        // Strictly only display matches where both teams belong to the same bracket
        if (!isMatchInSameBracket(item.tournamentSlug || tournamentSlug, item.categoryId || categoryId, item.stage, item.teamAName, item.teamBName, undefined, undefined, item.teamAPlayers, item.teamBPlayers)) {
          return false;
        }

        if (queueDivisionFilter === "current") {
          const isThisCategory =
            isSameCategory(item.categoryId, categoryId) ||
            (!item.categoryId && item.matchId && item.matchId.includes(categoryId));
          if (!isThisCategory) return false;

          // If current category has 0 registered teams, never show any bracket matches for this category
          if ((!category?.teams || category.teams.length === 0) && !item.id.startsWith("custom-")) {
            return false;
          }

          // If category has teams, ensure queue item teams still exist in category roster
          if (category?.teams && category.teams.length > 0 && !item.id.startsWith("custom-")) {
            const hasA = validTeamNames.has(item.teamAName.trim().toLowerCase());
            const hasB = validTeamNames.has(item.teamBName.trim().toLowerCase());
            if (!hasA || !hasB) return false;
          }

          return true;
        } else {
          // If viewing all divisions, omit any orphan tournament matches whose teams no longer exist
          if (!item.id.startsWith("custom-") && isSameCategory(item.categoryId, categoryId) && (!category?.teams || category.teams.length === 0)) {
            return false;
          }
        }
        // Bracket filter for active queue
        if (queueBracketFilter !== "all" && !isStageMatchingBracket(item.stage, queueBracketFilter)) {
          return false;
        }
        return true;
      })
      .filter(
        (item) =>
          !q ||
          item.teamAName.toLowerCase().includes(q) ||
          item.teamBName.toLowerCase().includes(q) ||
          item.stage.toLowerCase().includes(q) ||
          (item.teamAPlayers ?? []).some((p) => p.toLowerCase().includes(q)) ||
          (item.teamBPlayers ?? []).some((p) => p.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.priority - b.priority);
  }, [queue, searchQuery, queueDivisionFilter, queueBracketFilter, categoryId, tournamentSlug, category, matches]);

  // Unique brackets represented in the active queue for current division
  const availableQueueBrackets = useMemo(() => {
    const set = new Set<string>();
    queue.forEach((q) => {
      if (q.status !== "queued" && q.status !== "on_deck") return;
      if (queueDivisionFilter === "current" && q.categoryId && !isSameCategory(q.categoryId, categoryId)) return;
      const letterMatch = q.stage.match(/(?:bracket|pool)\s+([a-z])/i);
      if (letterMatch) {
        set.add(`Bracket ${letterMatch[1]!.toUpperCase()}`);
      } else if (!/(?:bracket|pool)\s+[a-z]/i.test(q.stage)) {
        set.add("Playoffs");
      }
    });
    return Array.from(set).sort();
  }, [queue, queueDivisionFilter, categoryId]);

  // Counts of queued items by bracket
  const queueCountByBracket = useMemo(() => {
    const map: Record<string, number> = {};
    queue.forEach((q) => {
      if (q.status !== "queued" && q.status !== "on_deck") return;
      if (queueDivisionFilter === "current" && q.categoryId && !isSameCategory(q.categoryId, categoryId)) return;
      const letterMatch = q.stage.match(/(?:bracket|pool)\s+([a-z])/i);
      const key = letterMatch ? `Bracket ${letterMatch[1]!.toUpperCase()}` : "Playoffs";
      map[key] = (map[key] || 0) + 1;
    });
    return map;
  }, [queue, queueDivisionFilter, categoryId]);

  // All completed matches in the tournament (deduplicated by matchup pair so duplicate DB rows count once)
  const allCompletedMatches = useMemo(() => {
    const finals = matches.filter((m) => m.status === "final" || Boolean(m.winnerTeam) || Boolean(m.endedAt));
    const seenMatchups = new Map<string, LiveMatch>();

    for (const m of finals) {
      if (!m.teamAName || !m.teamBName) continue;
      const cleanA = m.teamAName.trim().toLowerCase();
      const cleanB = m.teamBName.trim().toLowerCase();
      if (cleanA === cleanB) continue; // Skip invalid self-matches
      const pairKey = [cleanA, cleanB].sort().join("::");
      const stageKey = (m.stage || "match").trim().toLowerCase();
      const key = `${m.tournamentSlug || tournamentSlug || "all"}::${pairKey}::${stageKey}`;

      if (!seenMatchups.has(key)) {
        seenMatchups.set(key, m);
      } else {
        const existing = seenMatchups.get(key)!;
        const existingScore = (existing.score?.teamAScore ?? 0) + (existing.score?.teamBScore ?? 0);
        const newScore = (m.score?.teamAScore ?? 0) + (m.score?.teamBScore ?? 0);
        if (newScore > existingScore || (m.endedAt && !existing.endedAt) || (m.officiatedBy && !existing.officiatedBy)) {
          seenMatchups.set(key, m);
        }
      }
    }

    return Array.from(seenMatchups.values()).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  }, [matches, tournamentSlug]);

  // Categories available for match history filtering with completed counts
  const availableHistoryCategories = useMemo(() => {
    return tournament.categories.map((cat) => {
      const count = allCompletedMatches.filter((m) => isMatchInCategory(m, cat)).length;
      return {
        id: cat.id,
        label: cat.label,
        count,
      };
    });
  }, [tournament.categories, allCompletedMatches]);

  // Brackets available within the currently selected category filter with completed counts
  const availableHistoryBrackets = useMemo(() => {
    const counts: Record<string, number> = {};
    const set = new Set<string>();

    allCompletedMatches.forEach((m) => {
      if (historyCategoryFilter !== "all") {
        const cat = tournament.categories.find((c) => c.id === historyCategoryFilter);
        if (cat && !isMatchInCategory(m, cat)) return;
      }
      const bracket = getMatchBracketLabel(m);
      set.add(bracket);
      counts[bracket] = (counts[bracket] || 0) + 1;
    });

    return Array.from(set).sort().map((bracket) => ({
      bracket,
      count: counts[bracket] || 0,
    }));
  }, [allCompletedMatches, historyCategoryFilter, tournament.categories]);

  // Filtered match history (category-aware, bracket-aware, search-aware)
  const filteredHistory = useMemo(() => {
    const q = historySearchQuery.trim().toLowerCase();
    return allCompletedMatches
      .filter((m) => {
        // Category filter
        if (historyCategoryFilter !== "all") {
          const cat = tournament.categories.find((c) => c.id === historyCategoryFilter);
          if (cat && !isMatchInCategory(m, cat)) return false;
        }
        // Bracket filter
        if (historyBracketFilter !== "all") {
          const bracket = getMatchBracketLabel(m);
          if (bracket !== historyBracketFilter) return false;
        }
        // Search query
        if (q) {
          const catLabel = tournament.categories.find((c) => isMatchInCategory(m, c))?.label || "";
          const searchHaystack = [
            m.teamAName,
            m.teamBName,
            ...(m.teamAPlayers ?? []),
            ...(m.teamBPlayers ?? []),
            m.court || "",
            m.officiatedBy || "",
            m.stage || "",
            m.bracketLetter ? `Bracket ${m.bracketLetter}` : "",
            catLabel,
          ]
            .join(" ")
            .toLowerCase();
          if (!searchHaystack.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  }, [allCompletedMatches, historyCategoryFilter, historyBracketFilter, historySearchQuery, tournament.categories]);

  // Match history grouped by bracket stage
  const groupedHistory = useMemo(() => {
    const map = new Map<string, LiveMatch[]>();
    for (const m of filteredHistory) {
      const key = getMatchBracketLabel(m);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }

    return Array.from(map.entries()).sort(([a], [b]) => {
      const aIsPool = /bracket|pool/i.test(a);
      const bIsPool = /bracket|pool/i.test(b);
      if (aIsPool && !bIsPool) return -1;
      if (!aIsPool && bIsPool) return 1;
      return a.localeCompare(b);
    });
  }, [filteredHistory]);

  // Unassigned matches grouped by bracket stage (search-aware, bracket-aware, team-aware, Pool Play first)
  const groupedUnassigned = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const filtered = unassignedMatches
      .filter((m) => {
        if (!q) return true;
        return (
          m.teamAName.toLowerCase().includes(q) ||
          m.teamBName.toLowerCase().includes(q) ||
          m.stage.toLowerCase().includes(q) ||
          m.teamAPlayers.some((p) => p.toLowerCase().includes(q)) ||
          m.teamBPlayers.some((p) => p.toLowerCase().includes(q))
        );
      })
      .filter((m) => {
        if (unassignedBracketFilter === "all") return true;
        return isStageMatchingBracket(m.stage, unassignedBracketFilter);
      })
      .filter((m) => {
        if (unassignedTeamFilter === "all") return true;
        const tf = unassignedTeamFilter.trim().toLowerCase();
        return (
          m.teamAName.trim().toLowerCase() === tf ||
          m.teamBName.trim().toLowerCase() === tf
        );
      });

    const map = new Map<string, typeof unassignedMatches>();
    filtered.forEach((m) => {
      if (!map.has(m.stage)) map.set(m.stage, []);
      map.get(m.stage)!.push(m);
    });

    return Array.from(map.entries()).sort(([a], [b]) => {
      const aPool = a.includes("Pool Play");
      const bPool = b.includes("Pool Play");
      if (aPool && !bPool) return -1;
      if (!aPool && bPool) return 1;
      return a.localeCompare(b);
    });
  }, [unassignedMatches, searchQuery, unassignedBracketFilter, unassignedTeamFilter]);

  // Unique brackets present in remaining unassigned matches
  const availableUnassignedBrackets = useMemo(() => {
    const set = new Set<string>();
    unassignedMatches.forEach((m) => {
      const letterMatch = m.stage.match(/(?:bracket|pool)\s+([a-z])/i);
      if (letterMatch) {
        set.add(`Bracket ${letterMatch[1]!.toUpperCase()}`);
      } else if (!/(?:bracket|pool)\s+[a-z]/i.test(m.stage)) {
        set.add("Playoffs");
      }
    });
    return Array.from(set).sort();
  }, [unassignedMatches]);

  // Unique teams present in remaining unassigned matches (optionally filtered by selected bracket)
  const availableUnassignedTeams = useMemo(() => {
    const set = new Set<string>();
    unassignedMatches.forEach((m) => {
      if (unassignedBracketFilter !== "all" && !isStageMatchingBracket(m.stage, unassignedBracketFilter)) {
        return;
      }
      if (m.teamAName) set.add(m.teamAName.trim());
      if (m.teamBName) set.add(m.teamBName.trim());
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [unassignedMatches, unassignedBracketFilter]);

  // Matches ready to be added to the queue (neither team is currently playing on court and neither team is already queued)
  const readyUnassignedMatches = useMemo(() => {
    const existingQueueIds = new Set(queue.map((q) => q.matchId));
    const queuedTeams = new Set<string>();
    queue.forEach((q) => {
      if (q.status === "queued" || q.status === "on_deck" || q.status === "live" || q.status === "dispatched") {
        queuedTeams.add(q.teamAName.trim().toLowerCase());
        queuedTeams.add(q.teamBName.trim().toLowerCase());
      }
    });

    const ready: typeof unassignedMatches = [];
    const chosenInBatch = new Set<string>();

    for (const m of unassignedMatches) {
      if (existingQueueIds.has(m.id)) continue;
      if (!isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName, undefined, undefined, m.teamAPlayers, m.teamBPlayers)) continue;
      const a = m.teamAName.trim().toLowerCase();
      const b = m.teamBName.trim().toLowerCase();

      // Skip if either team or player is currently playing or on-deck on court
      if (
        checkSimultaneousPlayConflict(m.teamAName, m.teamAPlayers, tournamentSlug) ||
        checkSimultaneousPlayConflict(m.teamBName, m.teamBPlayers, tournamentSlug)
      ) continue;
      // Skip if either team already has a match in the active queue
      if (queuedTeams.has(a) || queuedTeams.has(b)) continue;
      // In this batch, pick at most 1 matchup per team
      if (chosenInBatch.has(a) || chosenInBatch.has(b)) continue;

      chosenInBatch.add(a);
      chosenInBatch.add(b);
      ready.push(m);
    }
    return ready;
  }, [unassignedMatches, queue, stations, matches, tournamentSlug, categoryId]);

  const handleAddNextReadyMatchups = () => {
    if (readyUnassignedMatches.length === 0) return;
    addMatchesToQueue(
      readyUnassignedMatches.map((m) => ({
        matchId: m.id,
        tournamentSlug,
        categoryId: categoryId || m.id.split("-")[2] || "",
        stage: m.stage,
        teamAName: m.teamAName,
        teamAPlayers: m.teamAPlayers,
        teamBName: m.teamBName,
        teamBPlayers: m.teamBPlayers,
      }))
    );
    reloadData();
  };

  const handleAddMatchupsForTeams = (teamNames: string[]) => {
    const namesSet = new Set(teamNames.map((n) => n.trim().toLowerCase()));
    const existingQueueIds = new Set(queue.map((q) => q.matchId));

    const candidates = unassignedMatches.filter((m) => {
      if (existingQueueIds.has(m.id)) return false;
      if (!isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName, undefined, undefined, m.teamAPlayers, m.teamBPlayers)) return false;
      const a = m.teamAName.trim().toLowerCase();
      const b = m.teamBName.trim().toLowerCase();
      return namesSet.has(a) || namesSet.has(b);
    });

    const toAdd: typeof candidates = [];
    const scheduledInThisBatch = new Set<string>();

    for (const m of candidates) {
      const a = m.teamAName.trim().toLowerCase();
      const b = m.teamBName.trim().toLowerCase();

      if (
        checkSimultaneousPlayConflict(m.teamAName, m.teamAPlayers, tournamentSlug) ||
        checkSimultaneousPlayConflict(m.teamBName, m.teamBPlayers, tournamentSlug)
      ) continue;
      if (scheduledInThisBatch.has(a) || scheduledInThisBatch.has(b)) continue;

      scheduledInThisBatch.add(a);
      scheduledInThisBatch.add(b);
      toAdd.push(m);
    }

    if (toAdd.length > 0) {
      addMatchesToQueue(
        toAdd.map((m) => ({
          matchId: m.id,
          tournamentSlug,
          categoryId: categoryId || m.id.split("-")[2] || "",
          stage: m.stage,
          teamAName: m.teamAName,
          teamAPlayers: m.teamAPlayers,
          teamBName: m.teamBName,
          teamBPlayers: m.teamBPlayers,
        }))
      );
      reloadData();
    }
    setConcludedAlert(null);
  };

  // Actions
  const handleDispatch = async (
    court: FacilityCourt,
    match: {
      id: string;
      tournamentSlug?: string;
      categoryId?: string;
      stage?: string;
      teamAName: string;
      teamAPlayers?: string[];
      teamBName: string;
      teamBPlayers?: string[];
    },
    umpire?: string,
  ) => {
    if (match.stage && !isMatchInSameBracket(match.tournamentSlug || tournamentSlug, match.categoryId || categoryId, match.stage, match.teamAName, match.teamBName, undefined, undefined, match.teamAPlayers, match.teamBPlayers)) {
      setCopyNotice(`Cannot dispatch: ${match.teamAName} and ${match.teamBName} do not belong to ${match.stage}`);
      setTimeout(() => setCopyNotice(null), 4000);
      return;
    }
    const liveA = checkSimultaneousPlayConflict(match.teamAName, match.teamAPlayers, match.tournamentSlug || tournamentSlug);
    const liveB = checkSimultaneousPlayConflict(match.teamBName, match.teamBPlayers, match.tournamentSlug || tournamentSlug);
    const conflict = liveA || liveB;
    if (conflict && conflict.court !== court) {
      setCopyNotice(`Cannot dispatch: ${conflict.isPlayerConflict ? `${conflict.playerName} (${conflict.teamName})` : conflict.teamName} is ${conflict.status === "on_deck" ? "on-deck" : "live"} on ${conflict.court}`);
      setTimeout(() => setCopyNotice(null), 4000);
      return;
    }
    await dispatchMatchToCourt(court, match, umpire);
    reloadData();
  };

  const handleAutoDispatch = (court: FacilityCourt) => {
    const dispatched = autoDispatchNext(court, tournamentSlug);
    if (dispatched) {
      reloadData();
    }
  };

  const handleAutoDispatchAllAvailable = () => {
    for (const c of FACILITY_COURTS) {
      if (stations[c].status === "available") {
        autoDispatchNext(c, tournamentSlug);
      }
    }
    reloadData();
  };

  const handleVacateCourt = async (court: FacilityCourt) => {
    const active = courtMatches[court];
    await vacateCourt(court);
    if (active) {
      updateMatchStore(active.id, (m) => ({
        ...m,
        court: "Queue",
        status: "scheduled",
        startedAt: undefined,
      }));
    }
    // Also ensure any non-final match in React matches state assigned to this court is cleared
    matches.forEach((m) => {
      if (m.court === court && m.status !== "final" && (!active || m.id !== active.id)) {
        updateMatchStore(m.id, (x) => ({
          ...x,
          court: "Queue",
          status: "scheduled",
          startedAt: undefined,
        }));
      }
    });
    setCopyNotice(`${court} has been vacated and match returned to queue.`);
    setTimeout(() => setCopyNotice(null), 3000);
    reloadData();
  };

  const handleToggleMaintenance = (court: FacilityCourt) => {
    const isMaint = stations[court].status === "maintenance";
    setCourtMaintenance(court, !isMaint, isMaint ? undefined : "Desk maintenance hold");
    reloadData();
  };

  const handleSetMatchLive = (court: FacilityCourt, matchId: string) => {
    updateMatchStore(matchId, (m) => ({
      ...m,
      court,
      status: "live",
      startedAt: m.startedAt ?? Date.now(),
    }));
    const nextStations = { ...stations };
    nextStations[court] = {
      ...nextStations[court],
      status: "live",
      currentMatchId: matchId,
    };
    saveCourtStations(nextStations, court);

    const currentQueue = getDispatchQueue();
    const updatedQueue = currentQueue.map((q) =>
      q.matchId === matchId
        ? { ...q, status: "live" as const, assignedCourt: court }
        : q
    );
    saveDispatchQueue(updatedQueue);

    reloadData();
  };

  const handleConcludeMatch = (court: FacilityCourt, matchId: string) => {
    const targetMatch = matches.find((m) => m.id === matchId);
    updateMatchStore(matchId, (m) => endGame(m));
    completeQueueMatch(matchId, targetMatch?.teamAName, targetMatch?.teamBName, targetMatch?.stage);
    reconcileDispatchQueue();
    syncMainDrawWithLiveMatches(tournamentSlug, categoryId, matches);
    const nextStations = { ...stations };
    nextStations[court] = {
      ...nextStations[court],
      status: "available",
      currentMatchId: null,
      dispatchedAt: null,
    };
    saveCourtStations(nextStations, court);
    if (targetMatch) {
      setConcludedAlert({
        court,
        teamAName: targetMatch.teamAName,
        teamBName: targetMatch.teamBName,
        matchId,
      });
    }
    reloadData();
  };

  const handleQuickScore = (matchId: string, team: "A" | "B") => {
    updateMatchStore(matchId, (m) => {
      const updated = scorePoint(m);
      return updated;
    });
  };

  const handleQuickSideOut = (matchId: string) => {
    updateMatchStore(matchId, (m) => sideOut(m));
  };

  const handleRequestResetMatch = (court: FacilityCourt, m: LiveMatch) => {
    const hasPoints =
      m.score.teamAScore > 0 ||
      m.score.teamBScore > 0 ||
      (m.score.rallies && m.score.rallies.length > 0) ||
      m.status === "final";

    if (hasPoints) {
      setResetConfirmMatch({ court, match: m });
    } else {
      executeResetMatch(court, m);
    }
  };

  const executeResetMatch = (court: FacilityCourt, m: LiveMatch) => {
    updateMatchStore(m.id, resetMatch);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(`dv_toss_done_${m.id}`);
      } catch {
        // ignore
      }
    }
    const nextStations = { ...stations };
    nextStations[court] = {
      ...nextStations[court],
      status: "warmup",
      currentMatchId: m.id,
    };
    saveCourtStations(nextStations, court);
    dbUpdateCourtStation(court, {
      status: "warmup",
      currentMatchId: m.id,
    }).catch(() => { });
    reloadData();
    setResetConfirmMatch(null);
  };

  const handleRemoveUmpireFromCourt = async (court: FacilityCourt, m: LiveMatch) => {
    updateMatchStore(m.id, (prev) => {
      const updated = { ...prev, officiatedBy: undefined };
      return updated;
    });
    try {
      const updatedMatch = { ...m, officiatedBy: undefined };
      await dbSaveMatch(updatedMatch);
    } catch {
      // network fallback
    }
    releaseCourtStation(court);
    try {
      await dbUpdateCourtStation(court, { assignedUmpire: null });
    } catch {
      // network fallback
    }
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(`dv_court_station_claim_${court}`);
      } catch {}
    }
    const freshStations = getCourtStations();
    setStations(freshStations);
    reloadData();
    setCopyNotice(`Official removed from ${court}. Station unlocked.`);
    setTimeout(() => setCopyNotice(null), 3500);
  };

  const handleQueueUnassignedAll = useCallback(() => {
    // Queue all matches currently visible in groupedUnassigned
    const visibleMatches = groupedUnassigned.flatMap(([, stageMatches]) => stageMatches);
    const valid = visibleMatches.filter((m) =>
      isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName, undefined, undefined, m.teamAPlayers, m.teamBPlayers)
    );
    const items = valid.map((m) => ({
      matchId: m.id,
      tournamentSlug,
      categoryId,
      stage: m.stage,
      teamAName: m.teamAName,
      teamAPlayers: m.teamAPlayers,
      teamBName: m.teamBName,
      teamBPlayers: m.teamBPlayers,
    }));
    if (items.length > 0) {
      addMatchesToQueue(items);
      reloadData();
      setCopyNotice(`Added ${items.length} match(es) to dispatch queue`);
      setTimeout(() => setCopyNotice(null), 3000);
    }
  }, [groupedUnassigned, tournamentSlug, categoryId, reloadData]);

  const handleQueueSingle = (m: typeof unassignedMatches[number]) => {
    if (!isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName, undefined, undefined, m.teamAPlayers, m.teamBPlayers)) {
      return;
    }
    addMatchesToQueue([
      {
        matchId: m.id,
        tournamentSlug,
        categoryId,
        stage: m.stage,
        teamAName: m.teamAName,
        teamAPlayers: m.teamAPlayers,
        teamBName: m.teamBName,
        teamBPlayers: m.teamBPlayers,
      },
    ]);
    reloadData();
  };

  const handleMoveCategory = (catId: string, direction: "prev" | "next") => {
    const updated = reorderCategorySequence(tournamentSlug, tournament.categories, catId, direction);
    setCategoryOrder(updated);
  };

  const handleSelectWave = (catId: string) => {
    setActiveWaveId(tournamentSlug, catId);
    setActiveWaveIdState(catId);
    setCategoryId(catId);

    // Auto-enqueue unassigned matches for this category if its queue is currently empty
    const targetCategory = tournament.categories.find((c) => c.id === catId);
    if (targetCategory && targetCategory.teams && targetCategory.teams.length >= 2) {
      const existingQueueCount = queue.filter(
        (q) =>
          isQueueItemInCategory(q, targetCategory) &&
          (!q.tournamentSlug || q.tournamentSlug === tournamentSlug || (q.matchId && q.matchId.includes(tournamentSlug))),
      ).length;

      if (existingQueueCount === 0) {
        const catUnassigned = computeCategoryUnassignedMatches(tournamentSlug, targetCategory, queue, stations, matches);
        if (catUnassigned.length > 0) {
          addMatchesToQueue(
            catUnassigned.map((m) => ({
              matchId: m.id,
              tournamentSlug,
              categoryId: catId,
              stage: m.stage,
              teamAName: m.teamAName,
              teamAPlayers: m.teamAPlayers,
              teamBName: m.teamBName,
              teamBPlayers: m.teamBPlayers,
            })),
          );
        }
      }
    }
    reloadData();
  };

  const handleAdvanceWave = () => {
    if (!nextCategory) return;
    handleSelectWave(nextCategory.id);
  };

  const getCategoryLabel = useCallback(
    (itemCategoryId?: string, matchId?: string) => {
      if (itemCategoryId) {
        const found = tournament.categories.find((c) => c.id === itemCategoryId);
        if (found) return found.label;
      }
      if (matchId) {
        for (const c of tournament.categories) {
          if (matchId.includes(c.id)) return c.label;
        }
      }
      return category?.label ?? "Division";
    },
    [tournament.categories, category?.label],
  );

  const handleCreateCustomMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customTeamA.trim() || !customTeamB.trim()) return;

    const matchId = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const teamA = customTeamA.trim();
    const teamB = customTeamB.trim();

    if (customTarget === "queue") {
      addMatchesToQueue([
        {
          matchId,
          tournamentSlug,
          categoryId,
          stage: customStage.trim() || "Exhibition Match",
          teamAName: teamA,
          teamBName: teamB,
        },
      ]);
    } else {
      await dispatchMatchToCourt(customTarget, {
        id: matchId,
        teamAName: teamA,
        teamBName: teamB,
      });
    }

    setCustomTeamA("");
    setCustomTeamB("");
    reloadData();
    setActiveQueueTab("queue");
  };

  const handleCopyAnnouncement = () => {
    if (!announcement) return;
    navigator.clipboard.writeText(announcement.message);
    setCopyNotice("Announcement copied to clipboard!");
    setTimeout(() => setCopyNotice(null), 3000);
  };

  const handleSetViewMode = (mode: "card" | "compact") => {
    setViewMode(mode);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("dv_dispatch_view_mode", mode);
    }
  };

  const toggleGroupCollapse = (stage: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  };

  const handleQueueStageGroup = (
    stageMatches: Array<{
      id: string;
      stage: string;
      teamAName: string;
      teamAPlayers: string[];
      teamBName: string;
      teamBPlayers: string[];
    }>,
  ) => {
    const valid = stageMatches.filter((m) =>
      isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName, undefined, undefined, m.teamAPlayers, m.teamBPlayers)
    );
    addMatchesToQueue(
      valid.map((m) => ({
        matchId: m.id,
        tournamentSlug,
        categoryId,
        stage: m.stage,
        teamAName: m.teamAName,
        teamAPlayers: m.teamAPlayers,
        teamBName: m.teamBName,
        teamBPlayers: m.teamBPlayers,
      })),
    );
    reloadData();
  };

  // Helper to format elapsed duration (e.g. "14:25")
  const formatDuration = (startTime: number | null | undefined) => {
    if (!startTime) return "00:00";
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const mins = Math.floor(elapsedSec / 60);
    const secs = elapsedSec % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-6">
      {/* ── Top Level Horizontal Navigation: Match History vs Facility Management ── */}
      <div className="flex items-center gap-2 border-b-2 border-border pb-3 overflow-x-auto no-scrollbar">
        <button
          type="button"
          onClick={() => setMainDispatchTab("history")}
          className={`px-4 py-2.5 text-xs font-display tracking-wider uppercase border-2 transition-all cursor-pointer flex items-center gap-2.5 shrink-0 ${
            mainDispatchTab === "history"
              ? "bg-pickle text-sand border-pickle shadow-sm font-bold"
              : "bg-card text-foreground border-border hover:border-pickle hover:text-pickle"
          }`}
        >
          <span>Match History</span>
          <span
            className={`px-2 py-0.5 text-[0.65rem] font-mono font-bold rounded-sm ${
              mainDispatchTab === "history"
                ? "bg-sand text-charcoal"
                : "bg-pickle/15 text-pickle"
            }`}
          >
            {metrics.completedCount} Final
          </span>
        </button>

        <button
          type="button"
          onClick={() => setMainDispatchTab("facility")}
          className={`px-4 py-2.5 text-xs font-display tracking-wider uppercase border-2 transition-all cursor-pointer flex items-center gap-2.5 shrink-0 ${
            mainDispatchTab === "facility"
              ? "bg-pickle text-sand border-pickle shadow-sm font-bold"
              : "bg-card text-foreground border-border hover:border-pickle hover:text-pickle"
          }`}
        >
          <span>Facility Management</span>
          <span
            className={`px-2 py-0.5 text-[0.65rem] font-mono font-bold rounded-sm ${
              mainDispatchTab === "facility"
                ? "bg-sand text-charcoal"
                : "bg-charcoal text-sand/80 border border-border"
            }`}
          >
            4 Courts Operating
          </span>
        </button>
      </div>

      {mainDispatchTab === "history" ? (
        <MatchHistory
          tournamentSlug={tournamentSlug}
          categories={tournament.categories}
          matches={matches}
          initialCategoryId={categoryId}
          onSelectCategory={(id) => {
            setCategoryId(id);
            setActiveWaveId(tournamentSlug, id);
            setActiveWaveIdState(id);
          }}
        />
      ) : (
        <>
          {/* ── Header & Category Filter ── */}
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between border-b border-border pb-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">
              Facility Management
            </span>
            <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-border">
              4 Courts Operating
            </span>
          </div>
          <h2 className="mt-1 font-display text-2xl sm:text-3xl lg:text-4xl text-foreground">
            Court Dispatch &amp; Queue Manager
          </h2>
          <p className="mt-1 text-xs sm:text-sm text-muted-foreground">
            Centralized desk console to dispatch matches to Courts 1–4, manage priority queues, and broadcast calls.
          </p>
        </div>

        {/* Tournament & Category Selector */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs uppercase tracking-wider text-muted-foreground">Event:</label>
            <select
              value={tournamentSlug}
              onChange={(e) => setTournamentSlug(e.target.value)}
              className="bg-charcoal text-sand border border-border rounded px-3 py-1.5 text-xs font-semibold focus:border-pickle focus:outline-none cursor-pointer"
            >
              {tournaments.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs uppercase tracking-wider text-muted-foreground">Division:</label>
            <select
              value={categoryId}
              onChange={(e) => {
                const nextId = e.target.value;
                setCategoryId(nextId);
                setActiveWaveId(tournamentSlug, nextId);
                setActiveWaveIdState(nextId);
              }}
              className="bg-charcoal text-sand border border-border rounded px-3 py-1.5 text-xs font-semibold focus:border-pickle focus:outline-none cursor-pointer"
            >
              {tournament.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={async () => {
              setIsHealingStations(true);
              try {
                const synced = await healAndSyncDispatchStations();
                setStations(synced);
                refreshMatches();
                reloadData();
                setCopyNotice("Court stations healed and re-synced with cloud.");
                setTimeout(() => setCopyNotice(null), 3500);
              } catch {
                setCopyNotice("Re-sync complete.");
                setTimeout(() => setCopyNotice(null), 2500);
              } finally {
                setIsHealingStations(false);
              }
            }}
            disabled={isHealingStations}
            title="Clean up ghost stations, orphaned match assignments, and re-sync with cloud"
            className="px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-sand/90 border border-border hover:border-pickle hover:text-sand transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <span className={`w-2 h-2 rounded-full ${isHealingStations ? "bg-pickle animate-ping" : "bg-pickle"}`} />
            <span>{isHealingStations ? "Re-syncing..." : "Re-sync Stations"}</span>
          </button>

          <button
            onClick={() => {
              setDebugStationTab("score_sync");
              setIsDebugStationOpen(true);
            }}
            title="Open real-time score sync telemetry, latency RTT ping, and cloud synchrony matrix"
            className="px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-sand/90 border border-pickle/40 hover:border-pickle hover:text-pickle transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <span className="w-2 h-2 rounded-full bg-pickle animate-pulse" />
            <span>Score Sync &amp; Debug</span>
          </button>

          <button
            onClick={handleAutoDispatchAllAvailable}
            disabled={metrics.availableCount === 0 || metrics.pendingQueueCount === 0}
            className="px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            Auto-Dispatch Open Courts
          </button>
        </div>
      </div>

      {/* ── Top Metrics Strip ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="surface-card p-3.5 sm:p-4 border border-border">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground block">
            4 Courts Status
          </span>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-display text-2xl sm:text-3xl text-foreground">
              {metrics.liveCount}
            </span>
            <span className="text-xs text-pickle font-bold uppercase tracking-wider">
              Live In Play
            </span>
          </div>
          <div className="mt-1 text-[0.65rem] text-muted-foreground flex gap-2">
            <span>{metrics.warmupCount} Warm-up</span>
            <span>&middot;</span>
            <span className={metrics.availableCount > 0 ? "text-emerald-400 font-bold" : ""}>
              {metrics.availableCount} Open
            </span>
            {metrics.maintCount > 0 && (
              <>
                <span>&middot;</span>
                <span className="text-brick font-bold">{metrics.maintCount} Hold</span>
              </>
            )}
          </div>
        </div>

        <div className="surface-card p-3.5 sm:p-4 border border-border">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground block">
            Waiting in Queue
          </span>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-display text-2xl sm:text-3xl text-sand">
              {metrics.pendingQueueCount}
            </span>
            <span className="text-xs text-muted-foreground uppercase tracking-wider">
              Matches
            </span>
          </div>
          <span className="mt-1 block text-[0.65rem] text-muted-foreground">
            {unassignedMatches.length} unassigned in tournament
          </span>
        </div>

        <div
          onClick={() => setMainDispatchTab("history")}
          className="surface-card p-3.5 sm:p-4 border border-border cursor-pointer hover:border-pickle transition-colors"
          title="Click to view full Match History"
        >
          <div className="flex items-center justify-between">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground block">
              Matches Completed
            </span>
            <span className="text-[0.6rem] uppercase tracking-wider text-pickle font-bold">
              View History &rarr;
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-display text-2xl sm:text-3xl text-foreground">
              {metrics.completedCount}
            </span>
            <span className="text-xs text-brick font-bold uppercase tracking-wider">
              Final
            </span>
          </div>
          <span className="mt-1 block text-[0.65rem] text-muted-foreground">
            Official scores logged
          </span>
        </div>

        <div className="surface-card p-3.5 sm:p-4 border border-border">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground block">
            Avg Match Duration
          </span>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-display text-2xl sm:text-3xl text-foreground">
              {metrics.avgDurationMin}
            </span>
            <span className="text-xs text-muted-foreground uppercase tracking-wider">
              Minutes
            </span>
          </div>
          <span className="mt-1 block text-[0.65rem] text-muted-foreground">
            Estimated turnaround
          </span>
        </div>
      </div>

      {/* ── Public Desk Announcement Bar ── */}
      {announcement && (
        <div className="bg-charcoal border-2 border-brick p-4 text-sand shadow-lg flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <span className="relative flex h-3 w-3 mt-1 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brick opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-brick"></span>
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[0.65rem] uppercase tracking-[0.2em] font-bold text-brick">
                  Desk Call Announcement
                </span>
                <span className="text-[0.6rem] text-sand/60">
                  {new Date(announcement.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              </div>
              <p className="mt-0.5 font-display text-base sm:text-lg text-sand tracking-wide">
                {announcement.message}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-end md:self-auto">
            <button
              onClick={() => playDeskChime()}
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-brick text-sand border border-brick hover:bg-brick/90 transition-colors cursor-pointer"
            >
              Sound Chime
            </button>
            <button
              onClick={handleCopyAnnouncement}
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-sand/10 text-sand border border-sand/30 hover:bg-sand/20 transition-colors cursor-pointer"
            >
              Copy Call Text
            </button>
            <button
              onClick={() => setLatestAnnouncement(null)}
              className="px-2.5 py-1.5 text-xs font-bold text-sand/60 hover:text-sand cursor-pointer"
              title="Dismiss announcement"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {copyNotice && (
        <div className="p-2.5 text-center text-xs font-bold bg-pickle/20 border border-pickle text-pickle uppercase tracking-wider">
          {copyNotice}
        </div>
      )}

      {/* ── 4 Dedicated Courts Station Matrix (Court 1, Court 2, Court 3, Court 4) ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-xl sm:text-2xl text-foreground uppercase tracking-wide">
            Facility Courts Matrix (4 Courts)
          </h3>
          <span className="text-xs text-muted-foreground">
            Courts 1 through 4 live terminal status
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-5">
          {FACILITY_COURTS.map((courtName) => {
            const station = stations[courtName];
            const activeMatch = courtMatches[courtName];
            const courtActiveBracket = station.activeBracket || "all";

            // Next eligible match for this specific court respecting its assigned bracket filter
            const eligibleMatchesForCourt = queue
              .map((q, idx) => ({ item: q, queueIndex: idx + 1 }))
              .filter(({ item: q }) => q.status === "queued" || q.status === "on_deck")
              .filter(({ item: q }) => !isQueueItemFinished(q, matches))
              .filter(({ item: q }) => !tournamentSlug || !q.tournamentSlug || q.tournamentSlug === tournamentSlug)
              .filter(({ item: q }) => isStageMatchingBracket(q.stage, courtActiveBracket))
              .filter(
                ({ item: q }) =>
                  !checkSimultaneousPlayConflict(q.teamAName, q.teamAPlayers, q.tournamentSlug || tournamentSlug) &&
                  !checkSimultaneousPlayConflict(q.teamBName, q.teamBPlayers, q.tournamentSlug || tournamentSlug),
              )
              .filter(({ item: q }) =>
                isMatchInSameBracket(
                  q.tournamentSlug || tournamentSlug || "",
                  q.categoryId || "",
                  q.stage,
                  q.teamAName,
                  q.teamBName,
                  undefined,
                  undefined,
                  q.teamAPlayers,
                  q.teamBPlayers,
                ),
              );

            const nextCourtMatch = eligibleMatchesForCourt[0] ?? null;
            const onDeckMatch = station.onDeckMatchId ? matches.find((m) => m.id === station.onDeckMatchId) : null;

            // Rest & Simultaneous Conflict Warnings for teams on this court (roster-aware)
            const restWarningA = activeMatch ? checkRestPeriodConflict(activeMatch.teamAName, activeMatch.teamAPlayers) : null;
            const restWarningB = activeMatch ? checkRestPeriodConflict(activeMatch.teamBName, activeMatch.teamBPlayers) : null;

            const hasActiveMatch = Boolean(activeMatch);
            const isCourtLive = (station.status === "live" || activeMatch?.status === "live") && hasActiveMatch;
            const isCourtWarmup = !isCourtLive && (station.status === "warmup" || (activeMatch && activeMatch.status === "scheduled")) && hasActiveMatch;
            const isCourtOrphan = (station.status === "live" || station.status === "warmup") && !hasActiveMatch;

            return (
              <div
                key={courtName}
                onClick={() => {
                  if (station.status === "available" && !activeMatch) {
                    handleOpenBracketModal(courtName);
                  }
                }}
                className={`surface-card p-0 overflow-hidden border flex flex-col justify-between transition-all ${station.status === "available" && !activeMatch
                    ? "cursor-pointer hover:border-pickle/80 hover:shadow-md"
                    : ""
                  } ${isCourtLive
                    ? "border-pickle/80 shadow-md shadow-pickle/5 bg-card"
                    : isCourtWarmup
                      ? "border-amber-500/80 bg-card"
                      : isCourtOrphan
                        ? "border-amber-500/50 bg-card/70"
                        : station.status === "maintenance"
                          ? "border-brick/70 bg-card"
                          : "border-border bg-card/60"
                  }`}
              >
                {/* Court Card Header */}
                <div className="bg-charcoal px-4 py-3 border-b border-border flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-display text-xl tracking-wider text-sand">
                      {courtName}
                    </span>
                    {isCourtLive && (
                      <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest bg-pickle/30 text-pickle border border-pickle/50 flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-ping" />
                        Live
                      </span>
                    )}
                    {isCourtWarmup && (
                      <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest bg-amber-500/20 text-amber-300 border border-amber-500/40">
                        Warm-up
                      </span>
                    )}
                    {isCourtOrphan && (
                      <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest bg-amber-500/20 text-amber-300 border border-amber-500/40">
                        Unsynced Station
                      </span>
                    )}
                    {!isCourtLive && !isCourtWarmup && !isCourtOrphan && station.status === "available" && (
                      <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                        Available
                      </span>
                    )}
                    {station.status === "maintenance" && (
                      <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest bg-brick/20 text-brick border border-brick/40">
                        Hold
                      </span>
                    )}

                    {/* Active Bracket Badge */}
                    {courtActiveBracket !== "all" ? (
                      <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest bg-pickle/25 text-pickle border border-pickle/50">
                        {courtActiveBracket}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wider text-sand/60 border border-sand/20">
                        All Brackets
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Active Bracket Selector Dropdown */}
                    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <label className="text-[0.65rem] uppercase tracking-wider text-sand/60 font-semibold hidden sm:inline">
                        Bracket:
                      </label>
                      <select
                        value={station.activeBracket || "all"}
                        onChange={(e) => handleSetCourtActiveBracket(courtName, e.target.value)}
                        className="bg-charcoal text-sand text-xs font-semibold uppercase tracking-wider border border-border px-2 py-1 rounded focus:border-pickle focus:outline-none cursor-pointer"
                        title={`Set active bracket for ${courtName}`}
                      >
                        {availableBracketOptions.map((opt) => (
                          <option key={opt.value} value={opt.value} className="bg-charcoal text-sand">
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenBracketModal(courtName);
                      }}
                      className="px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40 hover:bg-pickle hover:text-sand transition-colors cursor-pointer"
                      title={`Assign match from bracket to ${courtName}`}
                    >
                      Assign by Bracket
                    </button>

                    {/* Stopwatch / Duration */}
                    <div className="text-right font-mono text-xs">
                      {(isCourtLive || isCourtWarmup) && (
                        <div className="flex items-center gap-1.5 text-sand">
                          <span className="text-[0.65rem] uppercase tracking-wider text-sand/60">Time:</span>
                          <span className="font-bold text-sm text-pickle">
                            {formatDuration(station.dispatchedAt ?? activeMatch?.startedAt)}
                          </span>
                        </div>
                      )}
                      {!isCourtLive && !isCourtWarmup && station.status === "available" && (
                        <span className="text-[0.65rem] uppercase tracking-widest text-emerald-400 font-semibold">
                          Ready
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Court Body */}
                <div className="p-4 sm:p-5 flex-1 flex flex-col justify-between space-y-4">
                  {/* State 1: Active Match on Court (Live or Warm-up) */}
                  {(isCourtLive || isCourtWarmup) && activeMatch ? (
                    <div className="space-y-4">
                      {/* Match metadata */}
                      <div className="flex items-center justify-between text-xs text-muted-foreground border-b border-border/50 pb-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium uppercase tracking-wider text-foreground">
                            {activeMatch.court} Action
                          </span>
                          {activeMatch.categoryId && (
                            <span className="px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40">
                              {getCategoryLabel(activeMatch.categoryId, activeMatch.id)}
                            </span>
                          )}
                          {activeMatch.stage && (
                            <span className="px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-charcoal text-sand/80 border border-border">
                              {activeMatch.stage}
                            </span>
                          )}
                        </div>
                        {activeMatch.status === "live" && (
                          <span className="font-mono text-pickle font-bold">
                            Score Call: {activeMatch.score.servingTeam === "A" ? activeMatch.score.teamAScore : activeMatch.score.teamBScore}-
                            {activeMatch.score.servingTeam === "A" ? activeMatch.score.teamBScore : activeMatch.score.teamAScore}-
                            {activeMatch.score.serverNumber}
                          </span>
                        )}
                      </div>

                      {/* Operating Umpire / Station Official */}
                      {(activeMatch.officiatedBy || station.assignedUmpire) && (
                        <div className="flex items-center justify-between p-2 rounded bg-card border-2 border-border text-foreground text-xs">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[0.65rem] text-muted-foreground uppercase tracking-wider font-semibold">
                              Official:
                            </span>
                            <span className="font-semibold text-pickle truncate">
                              {activeMatch.officiatedBy || station.assignedUmpire}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleRemoveUmpireFromCourt(courtName, activeMatch)}
                            className="px-2.5 py-1 text-[0.62rem] font-bold uppercase tracking-wider bg-brick/20 border border-brick/40 text-brick hover:bg-brick hover:text-sand transition-colors cursor-pointer shrink-0"
                            title={`Remove ${activeMatch.officiatedBy || station.assignedUmpire} from ${courtName}`}
                          >
                            Remove Umpire
                          </button>
                        </div>
                      )}

                      {/* Teams & Scores */}
                      <div className="space-y-3">
                        {/* Team A */}
                        <div className="flex items-center justify-between p-2.5 rounded bg-card border-2 border-border">
                          <div className="min-w-0 mr-3">
                            <div className="flex items-center gap-1.5">
                              {activeMatch.score.servingTeam === "A" && activeMatch.status === "live" && (
                                <span className="h-2 w-2 rounded-full bg-pickle shrink-0" />
                              )}
                              <span className={`font-semibold text-sm truncate ${activeMatch.score.servingTeam === "A" ? "text-foreground font-bold" : "text-foreground"}`}>
                                {activeMatch.teamAName}
                              </span>
                            </div>
                            {activeMatch.teamAPlayers.length > 0 && (
                              <span className="block text-[0.65rem] text-muted-foreground truncate font-mono">
                                {activeMatch.teamAPlayers.join(" / ")}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleQuickScore(activeMatch.id, "A")}
                              className="px-2 py-1 text-xs font-bold bg-charcoal text-sand border border-border hover:border-pickle cursor-pointer"
                              title="Award point to Team A"
                            >
                              +1
                            </button>
                            <span className="font-display text-2xl w-8 text-right text-foreground">
                              {activeMatch.score.teamAScore}
                            </span>
                          </div>
                        </div>

                        {/* Team B */}
                        <div className="flex items-center justify-between p-2.5 rounded bg-card border-2 border-border">
                          <div className="min-w-0 mr-3">
                            <div className="flex items-center gap-1.5">
                              {activeMatch.score.servingTeam === "B" && activeMatch.status === "live" && (
                                <span className="h-2 w-2 rounded-full bg-pickle shrink-0" />
                              )}
                              <span className={`font-semibold text-sm truncate ${activeMatch.score.servingTeam === "B" ? "text-foreground" : "text-foreground/80"}`}>
                                {activeMatch.teamBName}
                              </span>
                            </div>
                            {activeMatch.teamBPlayers.length > 0 && (
                              <span className="block text-[0.65rem] text-muted-foreground truncate">
                                {activeMatch.teamBPlayers.join(" / ")}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleQuickScore(activeMatch.id, "B")}
                              className="px-2 py-1 text-xs font-bold bg-charcoal text-sand border border-border hover:border-pickle cursor-pointer"
                              title="Award point to Team B"
                            >
                              +1
                            </button>
                            <span className="font-display text-2xl w-8 text-right text-foreground">
                              {activeMatch.score.teamBScore}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Quick Desk Controls */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/50">
                        <div className="flex items-center gap-1.5">
                          {isCourtWarmup && (
                            <button
                              onClick={() => handleSetMatchLive(courtName, activeMatch.id)}
                              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer"
                            >
                              Start Play (Go Live)
                            </button>
                          )}
                          {isCourtLive && (
                            <button
                              onClick={() => handleQuickSideOut(activeMatch.id)}
                              className="px-2.5 py-1 text-xs font-semibold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-sand transition-colors cursor-pointer"
                            >
                              Side-Out
                            </button>
                          )}
                          <button
                            onClick={() => handleConcludeMatch(courtName, activeMatch.id)}
                            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-brick text-sand border border-brick hover:bg-brick/90 transition-colors cursor-pointer"
                          >
                            Finalize Match
                          </button>
                          <button
                            onClick={() => handleRequestResetMatch(courtName, activeMatch)}
                            title="Reset score to 0-0 and require coin toss"
                            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-sand border border-pickle/50 hover:bg-pickle hover:text-sand transition-colors cursor-pointer"
                          >
                            Coin Toss (Reset)
                          </button>
                          <button
                            onClick={() => handleOpenBracketModal(courtName)}
                            title={`Assign or reassign match from bracket for ${courtName}`}
                            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
                          >
                            Assign from Bracket
                          </button>
                          <button
                            onClick={() => {
                              setDebugStationTab("score_sync");
                              setIsDebugStationOpen(true);
                            }}
                            title={`Inspect score sync telemetry and latency for ${courtName}`}
                            className="px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-pickle border border-pickle/40 hover:bg-pickle/20 transition-colors cursor-pointer flex items-center gap-1"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-pickle animate-pulse" />
                            <span>Sync Debug</span>
                          </button>
                        </div>

                        <button
                          onClick={() => handleVacateCourt(courtName)}
                          className="text-[0.65rem] uppercase tracking-wider text-muted-foreground hover:text-brick cursor-pointer"
                        >
                          Vacate Court
                        </button>
                      </div>

                      {/* Warnings if rest is needed */}
                      {(restWarningA || restWarningB) && (
                        <div className="p-2 bg-amber-500/10 border border-amber-500/40 text-amber-300 text-[0.65rem] space-y-1">
                          {restWarningA && (
                            <div>Rest Alert: {restWarningA.teamName} finished {restWarningA.minutesAgo}m ago on {restWarningA.court}.</div>
                          )}
                          {restWarningB && (
                            <div>Rest Alert: {restWarningB.teamName} finished {restWarningB.minutesAgo}m ago on {restWarningB.court}.</div>
                          )}
                        </div>
                      )}
                    </div>
                  ) : isCourtOrphan ? (
                    /* Inconsistent / Orphan Station State */
                    <div className="py-6 text-center space-y-3">
                      <div className="text-xs uppercase tracking-widest text-amber-400 font-bold">
                        Station Inconsistent State
                      </div>
                      <p className="text-xs text-muted-foreground max-w-xs mx-auto">
                        Court station is marked {station.status} but no active match record is currently linked.
                      </p>
                      <button
                        onClick={() => handleVacateCourt(courtName)}
                        className="px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer"
                      >
                        Reset &amp; Make Available
                      </button>
                    </div>
                  ) : station.status === "maintenance" ? (
                    /* State 2: Court under Maintenance Hold */
                    <div className="py-8 text-center space-y-3">
                      <div className="text-xs uppercase tracking-widest text-brick font-bold">
                        Court Maintenance Active
                      </div>
                      <p className="text-sm text-foreground/80 max-w-xs mx-auto">
                        {station.maintenanceNote ?? "Court is temporarily held for cleaning or maintenance."}
                      </p>
                      <button
                        onClick={() => handleToggleMaintenance(courtName)}
                        className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 cursor-pointer"
                      >
                        Reopen {courtName}
                      </button>
                    </div>
                  ) : (
                    /* State 3: Court is Available */
                    <div className="py-6 text-center space-y-4">
                      <div className="space-y-1">
                        <span className="text-xs uppercase tracking-widest text-emerald-400 font-bold">
                          Court is Open &amp; Ready
                        </span>
                        <p className="text-xs text-muted-foreground">
                          Assign an unplayed game directly from any pool play bracket or dispatch from queue.
                        </p>
                      </div>

                      {/* Select Match from Bracket & Queue Dispatch */}
                      <div className="max-w-md mx-auto space-y-2.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenBracketModal(courtName);
                          }}
                          className="w-full py-2.5 px-4 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-all cursor-pointer shadow-sm flex items-center justify-center gap-2"
                        >
                          Select Match from Bracket &rarr;
                        </button>

                        {nextCourtMatch ? (
                          <div className="p-2.5 bg-card border-2 border-border rounded text-left space-y-1.5">
                            <div className="flex items-center justify-between text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold">
                              <span>
                                {courtActiveBracket !== "all"
                                  ? `Next for ${courtActiveBracket} (#${nextCourtMatch.queueIndex})`
                                  : `Next in Queue (#${nextCourtMatch.queueIndex})`}
                              </span>
                              <span className="text-pickle font-bold">{nextCourtMatch.item.stage}</span>
                            </div>
                            <div className="font-bold text-xs text-foreground truncate">
                              {nextCourtMatch.item.teamAName} vs {nextCourtMatch.item.teamBName}
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAutoDispatch(courtName);
                              }}
                              className="w-full mt-1 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
                            >
                              Dispatch Next Match to {courtName}
                            </button>
                          </div>
                        ) : (
                          <div className="p-2.5 bg-card/40 border border-border/60 rounded text-center text-xs text-muted-foreground space-y-1.5">
                            <div>
                              {courtActiveBracket !== "all"
                                ? `No pending matches in queue for ${courtActiveBracket}.`
                                : "No pending matches in queue."}
                            </div>
                            {courtActiveBracket !== "all" && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSetCourtActiveBracket(courtName, "all");
                                }}
                                className="text-[0.65rem] font-bold text-pickle hover:underline uppercase tracking-wider block mx-auto cursor-pointer"
                              >
                                Switch Court to All Brackets &rarr;
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="pt-2 flex items-center justify-center gap-3 text-xs">
                        <button
                          onClick={() => handleToggleMaintenance(courtName)}
                          className="text-[0.65rem] uppercase tracking-wider text-muted-foreground hover:text-brick transition-colors cursor-pointer"
                        >
                          Put on Maintenance Hold
                        </button>
                      </div>
                    </div>
                  )}

                  {/* On-Deck preview row */}
                  <div className="pt-3 border-t border-border flex items-center justify-between text-[0.7rem]">
                    <span className="text-muted-foreground uppercase tracking-wider text-[0.65rem]">
                      On-Deck for {courtName}:
                    </span>
                    {onDeckMatch ? (
                      <span className="font-semibold text-foreground truncate ml-2">
                        {onDeckMatch.teamAName} vs {onDeckMatch.teamBName}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60 italic">
                        Not designated
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Category Waves & Sequence Arrangement Deck ── */}
      <div className="surface-card p-4 sm:p-5 border border-border space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/60 pb-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">
                Wave Sequencing
              </span>
              <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-border">
                {categoryOrder.length} Divisions Arranged
              </span>
            </div>
            <h3 className="font-display text-xl sm:text-2xl text-foreground mt-0.5">
              Category Waves &amp; Sequence Arrangement
            </h3>
            <p className="text-xs text-muted-foreground">
              Prioritize division order in the match queue. The active wave feeds Courts 1–4 before rolling over to the next category.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {nextCategory && (
              <button
                onClick={handleAdvanceWave}
                className="px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer"
                title={`Advance to Wave ${nextWaveNumber}: ${nextCategory.label}`}
              >
                Advance to Wave {nextWaveNumber} &rarr;
              </button>
            )}
            <button
              onClick={() => setIsDeckCollapsed((prev) => !prev)}
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-sand transition-colors cursor-pointer"
            >
              {isDeckCollapsed ? "Show Arrangement Deck" : "Collapse"}
            </button>
          </div>
        </div>

        {/* Wave Completion Alert Banner (if active wave matches are all complete) */}
        {isActiveWaveComplete && nextCategory && (
          <div className="p-3.5 bg-pickle/15 border border-pickle/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-pickle block">
                Wave Completed
              </span>
              <p className="text-xs sm:text-sm font-semibold text-foreground">
                All matches for {category.label} have finished! Ready to release {nextCategory.label} into the match queue.
              </p>
            </div>
            <button
              onClick={handleAdvanceWave}
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-pickle text-sand hover:bg-pickle/90 transition-colors cursor-pointer shrink-0"
            >
              Unlock Wave {nextWaveNumber}: {nextCategory.label} &rarr;
            </button>
          </div>
        )}

        {/* Cards Grid */}
        {!isDeckCollapsed && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
            {categoryOrder.map((catId, idx) => {
              const cat = tournament.categories.find((c) => c.id === catId);
              if (!cat) return null;
              const stats = categoryStatsMap.get(catId);
              const isActive = catId === activeWaveId;
              const isCompleted = stats?.isCompleted;

              return (
                <div
                  key={catId}
                  className={`surface-card p-4 border transition-all flex flex-col justify-between gap-3.5 ${isActive
                      ? "border-pickle bg-pickle/10 shadow-sm ring-1 ring-pickle/40"
                      : isCompleted
                        ? "border-border/50 bg-charcoal/25 opacity-85"
                        : "border-border bg-card hover:border-border/80"
                    }`}
                >
                  {/* Card Header: Wave Number, Level, Reorder Buttons */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className={`px-2 py-0.5 text-[0.65rem] font-display uppercase tracking-wider border ${isActive
                            ? "bg-pickle text-sand border-pickle font-bold"
                            : "bg-charcoal text-sand/80 border-border"
                          }`}
                      >
                        Wave {idx + 1}
                      </span>
                      <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                        {cat.division} &middot; {cat.level}
                      </span>
                    </div>

                    {/* Move Earlier / Later */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleMoveCategory(catId, "prev")}
                        disabled={idx === 0}
                        title="Move earlier in queue sequence"
                        className="px-2 py-0.5 text-[0.65rem] font-bold bg-charcoal text-sand border border-border hover:border-sand disabled:opacity-25 cursor-pointer"
                      >
                        &larr;
                      </button>
                      <button
                        onClick={() => handleMoveCategory(catId, "next")}
                        disabled={idx === categoryOrder.length - 1}
                        title="Move later in queue sequence"
                        className="px-2 py-0.5 text-[0.65rem] font-bold bg-charcoal text-sand border border-border hover:border-sand disabled:opacity-25 cursor-pointer"
                      >
                        &rarr;
                      </button>
                    </div>
                  </div>

                  {/* Category Details & Progress */}
                  <div>
                    <h4 className="font-display text-base sm:text-lg text-foreground leading-tight truncate">
                      {cat.label}
                    </h4>
                    <div className="mt-1 flex items-center justify-between text-[0.7rem] text-muted-foreground">
                      <span>{cat.teams?.length || 0} Registered Teams</span>
                      <span
                        className={`font-bold uppercase tracking-wider ${isActive
                            ? "text-pickle"
                            : isCompleted
                              ? "text-sand/70"
                              : "text-muted-foreground"
                          }`}
                      >
                        {isActive ? "Active Wave" : isCompleted ? "Completed" : "Waiting"}
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="mt-2.5 space-y-1">
                      <div className="flex items-center justify-between text-[0.65rem] text-muted-foreground">
                        <span>
                          {stats?.completedCount ?? 0} / {stats?.totalMatches ?? 0} Matches Final
                        </span>
                        <span>{stats?.progressPercent ?? 0}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-charcoal overflow-hidden border border-border/50">
                        <div
                          className={`h-full transition-all duration-300 ${isActive
                              ? "bg-pickle"
                              : isCompleted
                                ? "bg-sand/40"
                                : "bg-pickle/50"
                            }`}
                          style={{ width: `${stats?.progressPercent ?? 0}%` }}
                        />
                      </div>
                    </div>

                    {/* Micro-metrics strip */}
                    <div className="mt-2.5 grid grid-cols-3 gap-1 text-center text-[0.65rem] pt-2 border-t border-border/40">
                      <div className="bg-card p-1 border-2 border-border rounded">
                        <span className="text-muted-foreground block text-[0.55rem] uppercase font-bold">
                          On Court
                        </span>
                        <span className="font-bold text-foreground">
                          {stats?.onCourtCount ?? 0}
                        </span>
                      </div>
                      <div className="bg-card p-1 border-2 border-border rounded">
                        <span className="text-muted-foreground block text-[0.55rem] uppercase font-bold">
                          Queued
                        </span>
                        <span className="font-bold text-foreground">
                          {stats?.queuedCount ?? 0}
                        </span>
                      </div>
                      <div className="bg-card p-1 border-2 border-border rounded">
                        <span className="text-muted-foreground block text-[0.55rem] uppercase font-bold">
                          Unassigned
                        </span>
                        <span className="font-bold text-foreground">
                          {stats?.unassignedCount ?? 0}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Card Action Footer */}
                  <div className="pt-2 border-t border-border/40 flex items-center justify-between gap-2">
                    {isActive ? (
                      <div className="w-full flex items-center justify-between gap-2">
                        <span className="text-[0.65rem] font-bold text-pickle uppercase tracking-wider">
                          Prioritized on Courts 1–4
                        </span>
                        {stats && stats.unassignedCount > 0 && (
                          <button
                            onClick={handleQueueUnassignedAll}
                            className="px-2 py-1 text-[0.6rem] font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer shrink-0"
                            title="Add remaining matches for this wave to queue"
                          >
                            + Queue {stats.unassignedCount}
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        onClick={() => handleSelectWave(catId)}
                        className="w-full py-1.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal hover:bg-pickle hover:text-sand text-sand/80 border border-border hover:border-pickle transition-colors cursor-pointer"
                      >
                        Set as Active Wave
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Match Queue & Dispatch Controls ── */}
      <div className="surface-card p-4 sm:p-6 border border-border space-y-5">
        <div className="space-y-3 border-b border-border pb-4">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-display text-xl sm:text-2xl text-foreground">
                  Match Queue &amp; Roster Dispatcher
                </h3>
                <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40">
                  Wave {currentWaveNumber}: {category.label}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Prioritize upcoming matches and assign directly to Courts 1–4.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Queue Tab buttons */}
              <div className="flex flex-wrap gap-1.5">
                {[
                  {
                    key: "queue",
                    label: `Active Queue (${queueDivisionFilter === "current"
                      ? queue.filter(
                        (q) =>
                          (q.status === "queued" || q.status === "on_deck") &&
                          (!q.categoryId || isSameCategory(q.categoryId, categoryId)) &&
                          (!q.tournamentSlug || q.tournamentSlug === tournamentSlug),
                      ).length
                      : queue.filter((q) => q.status === "queued" || q.status === "on_deck").length
                      })`,
                  },
                  { key: "unassigned", label: `Unassigned (${unassignedMatches.length})` },
                  { key: "history", label: `Match History (${allCompletedMatches.length})` },
                  { key: "custom", label: "+ Custom" },
                ].map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setActiveQueueTab(t.key as typeof activeQueueTab)}
                    className={`px-2.5 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer ${activeQueueTab === t.key
                      ? "border-pickle bg-pickle text-sand"
                      : "border-border bg-card text-foreground hover:border-pickle"
                      }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Division Scope Toggle (Active Queue only) */}
              {activeQueueTab === "queue" && (
                <div className="flex items-center border border-border overflow-hidden">
                  <button
                    onClick={() => setQueueDivisionFilter("current")}
                    title={`Show matches for ${category.label}`}
                    className={`px-2 py-1.5 text-[0.6rem] font-bold uppercase tracking-wider transition-colors cursor-pointer ${queueDivisionFilter === "current"
                      ? "bg-pickle text-sand"
                      : "bg-charcoal text-sand/60 hover:text-sand"
                      }`}
                  >
                    {category.label}
                  </button>
                  <button
                    onClick={() => setQueueDivisionFilter("all")}
                    title="Show matches across all divisions"
                    className={`px-2 py-1.5 text-[0.6rem] font-bold uppercase tracking-wider transition-colors cursor-pointer ${queueDivisionFilter === "all"
                      ? "bg-pickle text-sand"
                      : "bg-charcoal text-sand/60 hover:text-sand"
                      }`}
                  >
                    All Divisions
                  </button>
                </div>
              )}

              {/* Card / Compact view toggle — Active Queue only */}
              {activeQueueTab === "queue" && (
                <div className="flex items-center border border-border overflow-hidden">
                  <button
                    onClick={() => handleSetViewMode("card")}
                    title="Card view"
                    className={`px-2.5 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest transition-colors cursor-pointer ${viewMode === "card" ? "bg-pickle text-sand" : "bg-charcoal text-sand/60 hover:text-sand"
                      }`}
                  >
                    Card
                  </button>
                  <button
                    onClick={() => handleSetViewMode("compact")}
                    title="Compact list view"
                    className={`px-2.5 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest transition-colors cursor-pointer ${viewMode === "compact" ? "bg-pickle text-sand" : "bg-charcoal text-sand/60 hover:text-sand"
                      }`}
                  >
                    Compact
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Search bar */}
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by team name, player, or bracket stage..."
              className="w-full bg-charcoal border border-border text-sand text-sm px-4 py-2.5 pl-9 focus:border-pickle focus:outline-none placeholder:text-sand/40"
            />
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sand/40 pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[0.65rem] font-bold uppercase tracking-wider text-sand/50 hover:text-sand cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>

          {/* ── Category Navigation Bar & Add Ready Matchups Action ── */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 pb-0.5">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground shrink-0 mr-1">
                Category:
              </span>
              <button
                onClick={() => setQueueDivisionFilter("all")}
                className={`px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer shrink-0 ${queueDivisionFilter === "all"
                    ? "bg-pickle text-sand border-pickle font-bold"
                    : "bg-charcoal text-sand/70 border-border hover:border-sand"
                  }`}
              >
                All Categories ({queue.filter((q) => q.status === "queued" || q.status === "on_deck").length})
              </button>
              {tournament.categories.map((c) => {
                const catQueueCount = queue.filter(
                  (q) =>
                    (q.status === "queued" || q.status === "on_deck") &&
                    (isSameCategory(q.categoryId, c.id) || q.matchId?.includes(c.id)),
                ).length;
                const isSelected =
                  queueDivisionFilter === "current" && categoryId === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => {
                      setCategoryId(c.id);
                      setActiveWaveId(tournamentSlug, c.id);
                      setActiveWaveIdState(c.id);
                      setQueueDivisionFilter("current");
                    }}
                    className={`px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer shrink-0 ${isSelected
                        ? "bg-pickle text-sand border-pickle font-bold"
                        : "bg-charcoal text-sand/70 border-border hover:border-sand"
                      }`}
                  >
                    {c.label} ({catQueueCount})
                  </button>
                );
              })}
            </div>

            {readyUnassignedMatches.length > 0 && (
              <button
                onClick={handleAddNextReadyMatchups}
                className="px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer shrink-0 self-start sm:self-auto shadow-sm"
                title="Add next round matches for teams that are done playing and ready"
              >
                + Add Ready Matchups ({readyUnassignedMatches.length})
              </button>
            )}
          </div>
        </div>

        {/* Game Concluded Notification Banner */}
        {concludedAlert && (
          <div className="surface-card p-3 border border-pickle/60 bg-pickle/10 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded shadow-sm">
            <div className="text-xs">
              <span className="font-bold text-pickle uppercase tracking-wider block sm:inline mr-2">
                Game Done on {concludedAlert.court}:
              </span>
              <span className="font-semibold text-foreground">
                {concludedAlert.teamAName} vs {concludedAlert.teamBName}
              </span>
              <span className="text-muted-foreground ml-1.5">
                finished. Add their next matchups to queue:
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => handleAddMatchupsForTeams([concludedAlert.teamAName, concludedAlert.teamBName])}
                className="px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer"
              >
                + Add Matchups
              </button>
              <button
                onClick={() => setConcludedAlert(null)}
                className="px-2 py-1 text-[0.65rem] text-muted-foreground hover:text-foreground border border-border cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* ── TAB 1: ACTIVE QUEUE ── */}
        {activeQueueTab === "queue" && (
          <div className="space-y-3">
            {/* Active Queue Bracket Filter Strip */}
            {availableQueueBrackets.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 py-1.5 px-2 bg-card border border-border">
                <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground mr-1 font-bold shrink-0">
                  Filter Bracket:
                </span>
                <button
                  onClick={() => setQueueBracketFilter("all")}
                  className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer shrink-0 ${
                    queueBracketFilter === "all"
                      ? "bg-pickle text-sand border-pickle"
                      : "bg-charcoal text-sand/70 border-border hover:border-sand"
                  }`}
                >
                  All Brackets ({queue.filter((q) => (q.status === "queued" || q.status === "on_deck") && (queueDivisionFilter === "all" || !q.categoryId || isSameCategory(q.categoryId, categoryId))).length})
                </button>
                {availableQueueBrackets.map((b) => {
                  const count = queueCountByBracket[b] || 0;
                  const isActive = queueBracketFilter === b;
                  return (
                    <button
                      key={b}
                      onClick={() => setQueueBracketFilter(b)}
                      className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer shrink-0 ${
                        isActive
                          ? "bg-pickle text-sand border-pickle font-bold"
                          : "bg-charcoal text-sand/70 border-border hover:border-sand"
                      }`}
                    >
                      {b} ({count})
                    </button>
                  );
                })}
              </div>
            )}
            {filteredQueue.length === 0 ? (
              <div className="py-12 text-center space-y-3">
                {searchQuery ? (
                  <p className="text-sm text-muted-foreground">
                    No matches found for <span className="font-semibold text-foreground">"{searchQuery}"</span>.
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">The active dispatch queue is currently empty.</p>
                    {unassignedMatches.length > 0 && (
                      <button
                        onClick={handleQueueUnassignedAll}
                        className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer"
                      >
                        Queue All {unassignedMatches.length} Remaining Tournament Matches
                      </button>
                    )}
                  </>
                )}
              </div>
            ) : viewMode === "compact" ? (
              /* Compact single-row list */
              <div className="border border-border divide-y divide-border/50 overflow-hidden">
                {filteredQueue.map((item, idx) => {
                  const restA = checkRestPeriodConflict(item.teamAName, item.teamAPlayers);
                  const restB = checkRestPeriodConflict(item.teamBName, item.teamBPlayers);
                  const liveA = checkSimultaneousPlayConflict(item.teamAName, item.teamAPlayers, item.tournamentSlug || tournamentSlug);
                  const liveB = checkSimultaneousPlayConflict(item.teamBName, item.teamBPlayers, item.tournamentSlug || tournamentSlug);
                  const liveConflict = liveA || liveB;
                  const hasWarning = !!(restA || restB || liveConflict);
                  const catLabel = getCategoryLabel(item.categoryId, item.matchId);
                  return (
                    <div
                      key={item.id}
                      className="flex items-center gap-2 py-2 px-3 hover:bg-pickle/5 transition-colors border-l-2 border-l-pickle"
                    >
                      <span className="h-6 w-6 flex items-center justify-center font-display text-xs shrink-0 text-sand/60 border border-border bg-charcoal">
                        {idx + 1}
                      </span>
                      <span
                        title={`Category: ${catLabel}`}
                        className="px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40 shrink-0 truncate max-w-[7.5rem]"
                      >
                        {catLabel}
                      </span>
                      <span className="text-[0.6rem] font-bold uppercase tracking-wider text-sand/70 w-24 shrink-0 truncate">
                        {item.stage}
                      </span>
                      <span className="flex-1 font-semibold text-foreground text-sm truncate min-w-0">
                        {item.teamAName} <span className="text-foreground/40 font-normal">vs</span> {item.teamBName}
                      </span>
                      {hasWarning && (
                        <span
                          title={`${restA || restB ? "Rest warning. " : ""}${liveConflict ? `Conflict: ${liveConflict.isPlayerConflict ? `${liveConflict.playerName} (${liveConflict.teamName})` : liveConflict.teamName} is ${liveConflict.status === "on_deck" ? "on-deck" : "live"} on ${liveConflict.court}.` : ""}`}
                          className="text-amber-400 font-bold text-xs shrink-0 cursor-help"
                        >
                          !
                        </span>
                      )}
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={() => { reorderQueue(item.matchId, "up", filteredQueue.map((q) => q.matchId)); reloadData(); }}
                          disabled={idx === 0}
                          className="px-1.5 py-0.5 text-[0.6rem] font-bold bg-charcoal text-sand/70 border border-border hover:text-sand disabled:opacity-30 cursor-pointer"
                          title="Move Up"
                        >
                          Up
                        </button>
                        <button
                          onClick={() => { reorderQueue(item.matchId, "down", filteredQueue.map((q) => q.matchId)); reloadData(); }}
                          disabled={idx === filteredQueue.length - 1}
                          className="px-1.5 py-0.5 text-[0.6rem] font-bold bg-charcoal text-sand/70 border border-border hover:text-sand disabled:opacity-30 cursor-pointer"
                          title="Move Down"
                        >
                          Dn
                        </button>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {FACILITY_COURTS.map((c) => {
                          const isOccupied =
                            (stations[c].status === "live" && !!courtMatches[c]) ||
                            (stations[c].status === "warmup" && !!courtMatches[c]) ||
                            stations[c].status === "maintenance";
                          const isDisabled = isOccupied || !!liveConflict;
                          return (
                            <button
                              key={c}
                              onClick={() =>
                                handleDispatch(c, {
                                  id: item.matchId,
                                  tournamentSlug: item.tournamentSlug || tournamentSlug,
                                  categoryId: item.categoryId || categoryId,
                                  stage: item.stage,
                                  teamAName: item.teamAName,
                                  teamAPlayers: item.teamAPlayers,
                                  teamBName: item.teamBName,
                                  teamBPlayers: item.teamBPlayers,
                                })
                              }
                              disabled={isDisabled}
                              title={
                                liveConflict
                                  ? `Cannot dispatch: ${liveConflict.isPlayerConflict ? `${liveConflict.playerName} (${liveConflict.teamName})` : liveConflict.teamName} is ${liveConflict.status === "on_deck" ? "on-deck" : "live"} on ${liveConflict.court}`
                                  : isOccupied
                                    ? `${c} is occupied`
                                    : `Dispatch to ${c}`
                              }
                              className={`px-2 py-0.5 text-[0.6rem] font-bold border transition-colors ${isDisabled
                                ? "border-border/40 text-muted-foreground/40 cursor-not-allowed"
                                : "border-pickle/60 text-pickle hover:bg-pickle hover:text-sand cursor-pointer"
                                }`}
                            >
                              {c.replace("Court ", "C")}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        onClick={() => { removeQueueItem(item.matchId); reloadData(); }}
                        className="text-[0.6rem] text-muted-foreground hover:text-brick px-1 cursor-pointer shrink-0"
                        title="Remove from queue"
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Card view */
              <div className="space-y-2.5">
                {filteredQueue.map((item, idx) => {
                  const restA = checkRestPeriodConflict(item.teamAName, item.teamAPlayers);
                  const restB = checkRestPeriodConflict(item.teamBName, item.teamBPlayers);
                  const liveA = checkSimultaneousPlayConflict(item.teamAName, item.teamAPlayers, item.tournamentSlug || tournamentSlug);
                  const liveB = checkSimultaneousPlayConflict(item.teamBName, item.teamBPlayers, item.tournamentSlug || tournamentSlug);
                  const liveConflict = liveA || liveB;
                  const catLabel = getCategoryLabel(item.categoryId, item.matchId);

                  return (
                    <div
                      key={item.id}
                      className="surface-card p-3.5 border border-border border-l-4 border-l-pickle flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-card hover:border-border/80 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-8 w-8 rounded bg-charcoal text-sand flex items-center justify-center font-display text-sm shrink-0 border border-border">
                          #{idx + 1}
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              title={`Category: ${catLabel}`}
                              className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40 shrink-0"
                            >
                              {catLabel}
                            </span>
                            <span className="font-semibold text-foreground text-sm truncate">
                              {item.teamAName} vs {item.teamBName}
                            </span>
                            <span className="px-1.5 py-0.5 text-[0.6rem] uppercase tracking-wider bg-charcoal text-sand/80 border border-border shrink-0">
                              {item.stage}
                            </span>
                            {item.assignedCourt && (
                              <span className="px-1.5 py-0.5 text-[0.6rem] uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40 shrink-0">
                                Designated {item.assignedCourt}
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap gap-2 mt-1">
                            {(restA || restB) && (
                              <span className="text-[0.65rem] text-amber-400 font-medium">
                                Rest Warning: {(restA ?? restB)?.teamName} finished {(restA ?? restB)?.minutesAgo}m ago
                              </span>
                            )}
                            {liveConflict && (
                              <span className="text-[0.65rem] text-brick font-bold">
                                Conflict: {liveConflict.isPlayerConflict ? `${liveConflict.playerName} (${liveConflict.teamName})` : liveConflict.teamName} is {liveConflict.status === "on_deck" ? "on-deck" : "live"} on {liveConflict.court}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 shrink-0 self-end md:self-auto">
                        <div className="flex items-center gap-1 mr-2 border-r border-border/50 pr-2">
                          <button
                            onClick={() => { reorderQueue(item.matchId, "up", filteredQueue.map((q) => q.matchId)); reloadData(); }}
                            disabled={idx === 0}
                            className="px-2 py-1 text-[0.65rem] font-bold bg-charcoal text-sand border border-border hover:border-sand disabled:opacity-30 cursor-pointer"
                            title="Move Up"
                          >
                            Up
                          </button>
                          <button
                            onClick={() => { reorderQueue(item.matchId, "down", filteredQueue.map((q) => q.matchId)); reloadData(); }}
                            disabled={idx === filteredQueue.length - 1}
                            className="px-2 py-1 text-[0.65rem] font-bold bg-charcoal text-sand border border-border hover:border-sand disabled:opacity-30 cursor-pointer"
                            title="Move Down"
                          >
                            Down
                          </button>
                        </div>

                        {FACILITY_COURTS.map((c) => {
                          const isCourtOccupied =
                            (stations[c].status === "live" && !!courtMatches[c]) ||
                            (stations[c].status === "warmup" && !!courtMatches[c]) ||
                            stations[c].status === "maintenance";
                          const isBtnDisabled = isCourtOccupied || !!liveConflict;
                          return (
                            <button
                              key={c}
                              onClick={() =>
                                handleDispatch(c, {
                                  id: item.matchId,
                                  tournamentSlug: item.tournamentSlug || tournamentSlug,
                                  categoryId: item.categoryId || categoryId,
                                  stage: item.stage,
                                  teamAName: item.teamAName,
                                  teamAPlayers: item.teamAPlayers,
                                  teamBName: item.teamBName,
                                  teamBPlayers: item.teamBPlayers,
                                })
                              }
                              disabled={isBtnDisabled}
                              title={
                                liveConflict
                                  ? `Cannot dispatch: ${liveConflict.isPlayerConflict ? `${liveConflict.playerName} (${liveConflict.teamName})` : liveConflict.teamName} is ${liveConflict.status === "on_deck" ? "on-deck" : "live"} on ${liveConflict.court}`
                                  : isCourtOccupied
                                    ? `${c} is currently occupied`
                                    : `Dispatch immediately to ${c}`
                              }
                              className={`px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors ${isBtnDisabled
                                ? "border-border/40 text-muted-foreground/40 cursor-not-allowed"
                                : "border-pickle/60 text-pickle hover:bg-pickle hover:text-sand cursor-pointer"
                                }`}
                            >
                              &rarr; {c}
                            </button>
                          );
                        })}

                        <select
                          value={item.assignedCourt ?? ""}
                          onChange={(e) => {
                            const val = e.target.value as FacilityCourt | "";
                            if (val) {
                              setCourtOnDeck(val, item.matchId);
                            } else {
                              setCourtOnDeck(item.assignedCourt ?? "Court 1", null);
                            }
                            reloadData();
                          }}
                          className="bg-charcoal text-sand border border-border px-2 py-1 text-[0.65rem] focus:outline-none cursor-pointer"
                        >
                          <option value="">On-Deck...</option>
                          {FACILITY_COURTS.map((c) => (
                            <option key={c} value={c}>
                              On-Deck {c}
                            </option>
                          ))}
                        </select>

                        <button
                          onClick={() => { removeQueueItem(item.matchId); reloadData(); }}
                          className="text-xs text-muted-foreground hover:text-brick p-1 cursor-pointer ml-1"
                          title="Remove from queue"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── TAB 2: BRACKET CARDS ── */}
        {activeQueueTab === "unassigned" && (
          <div className="space-y-4">
            {/* Sub-header & Filter Controls */}
            <div className="flex flex-col gap-2.5 border-b border-border/50 pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {searchQuery || unassignedBracketFilter !== "all" || unassignedTeamFilter !== "all"
                    ? `${groupedUnassigned.reduce((acc, [, m]) => acc + m.length, 0)} match(es) in ${groupedUnassigned.length} bracket(s) matching filters`
                    : `${groupedUnassigned.length} bracket(s) — ${unassignedMatches.length} matches remaining`}
                </span>
                {groupedUnassigned.length > 0 && (
                  <button
                    onClick={handleQueueUnassignedAll}
                    className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer self-start sm:self-auto shadow-sm"
                  >
                    {unassignedBracketFilter !== "all"
                      ? `Queue ${unassignedBracketFilter} (${groupedUnassigned.reduce((acc, [, m]) => acc + m.length, 0)})`
                      : unassignedTeamFilter !== "all" || searchQuery
                        ? `Queue Filtered (${groupedUnassigned.reduce((acc, [, m]) => acc + m.length, 0)})`
                        : `Queue All (${unassignedMatches.length})`}
                  </button>
                )}
              </div>

              {/* Bracket & Team Filter Controls */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {/* Bracket Filter Pills */}
                {availableUnassignedBrackets.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold shrink-0">
                      Bracket:
                    </span>
                    <button
                      onClick={() => setUnassignedBracketFilter("all")}
                      className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer shrink-0 ${
                        unassignedBracketFilter === "all"
                          ? "bg-pickle text-sand border-pickle"
                          : "bg-charcoal text-sand/70 border-border hover:border-sand"
                      }`}
                    >
                      All ({unassignedMatches.length})
                    </button>
                    {availableUnassignedBrackets.map((b) => {
                      const count = unassignedMatches.filter((m) => isStageMatchingBracket(m.stage, b)).length;
                      return (
                        <button
                          key={b}
                          onClick={() => setUnassignedBracketFilter(b)}
                          className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer shrink-0 ${
                            unassignedBracketFilter === b
                              ? "bg-pickle text-sand border-pickle font-bold"
                              : "bg-charcoal text-sand/70 border-border hover:border-sand"
                          }`}
                        >
                          {b} ({count})
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Team Filter Dropdown */}
                {availableUnassignedTeams.length > 1 && (
                  <div className="flex items-center gap-1.5 ml-auto">
                    <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold shrink-0">
                      Team:
                    </span>
                    <select
                      value={unassignedTeamFilter}
                      onChange={(e) => setUnassignedTeamFilter(e.target.value)}
                      className="px-2 py-1 text-xs bg-card text-foreground border border-border rounded focus:outline-hidden focus:border-pickle cursor-pointer"
                    >
                      <option value="all">All Teams ({availableUnassignedTeams.length})</option>
                      {availableUnassignedTeams.map((teamName) => (
                        <option key={teamName} value={teamName}>
                          {teamName}
                        </option>
                      ))}
                    </select>
                    {unassignedTeamFilter !== "all" && (
                      <button
                        onClick={() => setUnassignedTeamFilter("all")}
                        className="text-xs text-muted-foreground hover:text-foreground cursor-pointer px-1"
                        title="Reset team filter"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {groupedUnassigned.length === 0 ? (
              <div className="py-16 text-center text-xs text-muted-foreground space-y-3">
                <p>
                  {searchQuery
                    ? `No brackets or matches found for "${searchQuery}".`
                    : (!category?.teams || category.teams.length < 2)
                      ? `No registered teams in ${category?.label ?? "this division"} yet. Add or auto-populate teams in Setup to dispatch matches.`
                      : `All bracket matches for ${category?.label ?? "this division"} are active in the dispatch queue or underway on court.`}
                </p>
                {!searchQuery && category?.teams && category.teams.length >= 2 && (
                  <button
                    onClick={() => setActiveQueueTab("queue")}
                    className="inline-block px-4 py-2 bg-pickle text-sand text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-opacity cursor-pointer"
                  >
                    View Active Queue &rarr;
                  </button>
                )}
              </div>
            ) : (
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
                {groupedUnassigned.map(([stage, stageMatches]) => {
                  // Derive a short bracket type label
                  const typeLabel = stage.includes("Pool Play")
                    ? "Pool Play"
                    : stage.toLowerCase().includes("final")
                      ? "Finals"
                      : stage.toLowerCase().includes("semi")
                        ? "Semifinals"
                        : stage.toLowerCase().includes("quarter")
                          ? "Quarterfinals"
                          : "Playoff";

                  // Short display name — strip the type suffix for the heading
                  const shortName = stage
                    .replace(" (Pool Play)", "")
                    .replace(" (Playoff)", "");

                  return (
                    <div
                      key={stage}
                      className="surface-card border border-border overflow-hidden flex flex-col"
                    >
                      {/* Card Header */}
                      <div className="bg-charcoal px-4 py-3 border-b border-border flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="text-[0.6rem] font-bold uppercase tracking-widest text-pickle block">
                            {typeLabel}
                          </span>
                          <span className="font-display text-lg text-sand leading-tight block truncate">
                            {shortName}
                          </span>
                        </div>
                        <span className="font-display text-3xl text-sand/30 shrink-0 leading-none mt-1">
                          {stageMatches.length}
                        </span>
                      </div>

                      {/* Match list */}
                      <div className="flex-1 overflow-y-auto divide-y divide-border/50" style={{ maxHeight: "11rem" }}>
                        {stageMatches.map((m) => {
                          const liveA = checkSimultaneousPlayConflict(m.teamAName, m.teamAPlayers, tournamentSlug);
                          const liveB = checkSimultaneousPlayConflict(m.teamBName, m.teamBPlayers, tournamentSlug);
                          const conflict = liveA ?? liveB;
                          const isPlaying = !!conflict;
                          const playingCourt = conflict?.court;
                          const conflictState = conflict?.status === "on_deck" ? "On-Deck on" : "Live on";

                          return (
                            <div
                              key={m.id}
                              className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-pickle/5 transition-colors"
                            >
                              <div className="min-w-0">
                                <span className="text-sm text-foreground font-semibold truncate block">
                                  {m.teamAName} <span className="text-foreground/40 font-normal">vs</span> {m.teamBName}
                                </span>
                                {(m.teamAPlayers.length > 0 || m.teamBPlayers.length > 0) && (
                                  <span className="text-[0.6rem] text-muted-foreground truncate block font-mono">
                                    {[...m.teamAPlayers, ...m.teamBPlayers].join(" / ")}
                                  </span>
                                )}
                              </div>
                              {isPlaying ? (
                                <span
                                  title={`Cannot queue yet: ${conflict?.teamName} is ${conflict?.status === "on_deck" ? "on-deck on" : "playing on"} ${playingCourt}`}
                                  className="text-[0.55rem] font-bold uppercase tracking-wider text-amber-500 border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 shrink-0"
                                >
                                  {conflictState} {playingCourt}
                                </span>
                              ) : (
                                <button
                                  onClick={() => handleQueueSingle(m)}
                                  className="text-[0.6rem] font-bold uppercase tracking-wider text-pickle hover:text-sand border border-pickle/40 hover:border-sand px-2 py-0.5 shrink-0 transition-colors cursor-pointer"
                                >
                                  + Queue
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Card footer — Queue all CTA */}
                      <div className="px-4 py-3 bg-card border-t-2 border-border">
                        <button
                          onClick={() => handleQueueStageGroup(stageMatches)}
                          className="w-full py-2 text-[0.65rem] font-bold uppercase tracking-widest bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer"
                        >
                          Queue All {stageMatches.length} Matches
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── TAB 3: COURT MATCH HISTORY / COMPLETED ── */}
        {activeQueueTab === "history" && (
          <div className="space-y-5 pt-1">
            {/* History Header & Summary Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-charcoal/50 p-3.5 border border-border">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs uppercase tracking-[0.2em] font-bold text-pickle">
                    Official Record
                  </span>
                  <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-card text-sand border border-border">
                    {filteredHistory.length} of {allCompletedMatches.length} Matches Shown
                  </span>
                </div>
                <h4 className="font-display text-lg sm:text-xl text-foreground mt-0.5">
                  Tournament Match History
                </h4>
              </div>

              {(historyCategoryFilter !== "all" || historyBracketFilter !== "all" || historySearchQuery) && (
                <button
                  onClick={() => {
                    setHistoryCategoryFilter("all");
                    setHistoryBracketFilter("all");
                    setHistorySearchQuery("");
                  }}
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-card text-sand hover:text-pickle border border-border hover:border-pickle transition-colors cursor-pointer flex items-center gap-1.5 self-start sm:self-auto"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset Filters</span>
                </button>
              )}
            </div>

            {/* Filter Controls Row: Category Pills & Bracket Pills */}
            <div className="space-y-3.5 surface-card p-4 border border-border">
              {/* Category Filter Pills */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="uppercase tracking-wider font-bold text-[0.65rem] text-sand/80">
                    Filter by Category
                  </span>
                  {historyCategoryFilter !== "all" && (
                    <button
                      onClick={() => {
                        setHistoryCategoryFilter("all");
                        setHistoryBracketFilter("all");
                      }}
                      className="text-[0.65rem] text-pickle hover:underline uppercase tracking-wider font-semibold cursor-pointer"
                    >
                      Show All Categories
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => {
                      setHistoryCategoryFilter("all");
                      setHistoryBracketFilter("all");
                    }}
                    className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider border transition-colors cursor-pointer flex items-center gap-1.5 ${
                      historyCategoryFilter === "all"
                        ? "bg-pickle text-sand border-pickle shadow-sm"
                        : "bg-charcoal text-sand/80 border-border hover:border-sand/60"
                    }`}
                  >
                    <span>All Categories</span>
                    <span className="text-[0.65rem] opacity-75">({allCompletedMatches.length})</span>
                  </button>

                  {availableHistoryCategories.map((cat) => (
                    <button
                      key={cat.id}
                      onClick={() => {
                        setHistoryCategoryFilter(cat.id);
                        setHistoryBracketFilter("all");
                      }}
                      className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider border transition-colors cursor-pointer flex items-center gap-1.5 ${
                        historyCategoryFilter === cat.id
                          ? "bg-pickle text-sand border-pickle shadow-sm"
                          : "bg-charcoal text-sand/80 border-border hover:border-sand/60"
                      }`}
                    >
                      <span>{cat.label}</span>
                      <span className="text-[0.65rem] opacity-75">({cat.count})</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Bracket Filter Pills */}
              <div className="space-y-1.5 pt-2 border-t border-border/50">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="uppercase tracking-wider font-bold text-[0.65rem] text-sand/80">
                    Filter by Bracket / Stage
                  </span>
                  {historyBracketFilter !== "all" && (
                    <button
                      onClick={() => setHistoryBracketFilter("all")}
                      className="text-[0.65rem] text-pickle hover:underline uppercase tracking-wider font-semibold cursor-pointer"
                    >
                      Show All Brackets
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => setHistoryBracketFilter("all")}
                    className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider border transition-colors cursor-pointer flex items-center gap-1.5 ${
                      historyBracketFilter === "all"
                        ? "bg-pickle text-sand border-pickle shadow-sm"
                        : "bg-charcoal text-sand/80 border-border hover:border-sand/60"
                    }`}
                  >
                    <span>All Brackets</span>
                    <span className="text-[0.65rem] opacity-75">
                      (
                      {
                        allCompletedMatches.filter((m) => {
                          if (historyCategoryFilter === "all") return true;
                          const cat = tournament.categories.find((c) => c.id === historyCategoryFilter);
                          return cat ? isMatchInCategory(m, cat) : true;
                        }).length
                      }
                      )
                    </span>
                  </button>

                  {availableHistoryBrackets.map(({ bracket, count }) => (
                    <button
                      key={bracket}
                      onClick={() => setHistoryBracketFilter(bracket)}
                      className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider border transition-colors cursor-pointer flex items-center gap-1.5 ${
                        historyBracketFilter === bracket
                          ? "bg-pickle text-sand border-pickle shadow-sm"
                          : "bg-charcoal text-sand/80 border-border hover:border-sand/60"
                      }`}
                    >
                      <span>{bracket}</span>
                      <span className="text-[0.65rem] opacity-75">({count})</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Search Bar Input */}
              <div className="pt-2 border-t border-border/50">
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={historySearchQuery}
                    onChange={(e) => setHistorySearchQuery(e.target.value)}
                    placeholder="Search by team name, player names, court (e.g. Court 1), or official..."
                    className="w-full bg-charcoal text-sand text-xs placeholder:text-muted-foreground border border-border pl-9 pr-9 py-2 focus:border-pickle focus:outline-none"
                  />
                  {historySearchQuery && (
                    <button
                      onClick={() => setHistorySearchQuery("")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-sand cursor-pointer"
                      title="Clear search"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Match Cards or Empty State */}
            {filteredHistory.length === 0 ? (
              <div className="py-14 px-4 text-center surface-card border border-border space-y-3">
                <History className="w-8 h-8 mx-auto text-muted-foreground/60" />
                <h4 className="font-display text-lg text-foreground">
                  No Completed Matches Found
                </h4>
                <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                  {historySearchQuery || historyCategoryFilter !== "all" || historyBracketFilter !== "all"
                    ? "No completed matches match the selected category, bracket, or search criteria."
                    : "No matches have finished with official scores logged in this tournament yet."}
                </p>
                {(historySearchQuery || historyCategoryFilter !== "all" || historyBracketFilter !== "all") && (
                  <button
                    onClick={() => {
                      setHistoryCategoryFilter("all");
                      setHistoryBracketFilter("all");
                      setHistorySearchQuery("");
                    }}
                    className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-pickle text-sand hover:bg-pickle/90 transition-colors cursor-pointer"
                  >
                    Reset Filters &amp; Show All
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-6">
                {groupedHistory.map(([bracketStage, stageMatches]) => (
                  <div key={bracketStage} className="space-y-3">
                    {/* Bracket Stage Header */}
                    <div className="flex items-center justify-between border-b border-border/80 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-display text-base sm:text-lg text-sand tracking-wide">
                          {bracketStage}
                        </span>
                        <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-border">
                          {stageMatches.length} {stageMatches.length === 1 ? "Match" : "Matches"}
                        </span>
                      </div>
                    </div>

                    {/* Stage Matches Grid */}
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3.5">
                      {stageMatches.map((m) => {
                        const cat = tournament.categories.find((c) => isMatchInCategory(m, c));
                        const isTeamAWinner =
                          m.winnerTeam === m.teamAName || m.score.teamAScore > m.score.teamBScore;
                        const isTeamBWinner =
                          m.winnerTeam === m.teamBName || m.score.teamBScore > m.score.teamAScore;
                        const durationMin =
                          m.startedAt && m.endedAt && m.endedAt > m.startedAt
                            ? Math.max(1, Math.round((m.endedAt - m.startedAt) / 60000))
                            : null;

                        return (
                          <div
                            key={m.id}
                            className="surface-card p-3.5 sm:p-4 border border-border bg-card hover:border-border/80 transition-all space-y-3"
                          >
                            {/* Card Top Meta Strip */}
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2.5">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-border">
                                  {m.court || "Court"}
                                </span>
                                {cat && (
                                  <span className="px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider bg-card text-sand/90 border border-border">
                                    {cat.label}
                                  </span>
                                )}
                                <span className="px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wider bg-pickle/15 text-pickle border border-pickle/30">
                                  {m.stage || "Official Match"}
                                </span>
                              </div>

                              <div className="flex items-center gap-2 text-[0.65rem] text-muted-foreground">
                                <Clock className="w-3 h-3 text-muted-foreground" />
                                <span>
                                  {m.endedAt
                                    ? new Date(m.endedAt).toLocaleTimeString([], {
                                        hour: "numeric",
                                        minute: "2-digit",
                                      })
                                    : "Final"}
                                </span>
                                {durationMin !== null && (
                                  <span className="font-mono text-sand/60">({durationMin}m)</span>
                                )}
                              </div>
                            </div>

                            {/* Scoreboard Body */}
                            <div className="space-y-2">
                              {/* Team A Row */}
                              <div
                                className={`flex items-center justify-between p-2.5 rounded border transition-colors ${
                                  isTeamAWinner
                                    ? "bg-pickle/10 border-pickle/40"
                                    : "bg-charcoal/40 border-border/40"
                                }`}
                              >
                                <div className="min-w-0 mr-3">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {isTeamAWinner && (
                                      <span className="px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-widest bg-pickle text-sand shrink-0">
                                        Winner
                                      </span>
                                    )}
                                    <span
                                      className={`font-semibold text-sm truncate ${
                                        isTeamAWinner ? "text-sand font-bold" : "text-foreground"
                                      }`}
                                    >
                                      {m.teamAName}
                                    </span>
                                  </div>
                                  {m.teamAPlayers && m.teamAPlayers.length > 0 && (
                                    <span className="block text-[0.65rem] text-muted-foreground truncate mt-0.5">
                                      {m.teamAPlayers.join(" / ")}
                                    </span>
                                  )}
                                </div>
                                <span
                                  className={`font-display text-2xl sm:text-3xl tabular-nums ${
                                    isTeamAWinner ? "text-pickle font-bold" : "text-sand/80"
                                  }`}
                                >
                                  {m.score.teamAScore}
                                </span>
                              </div>

                              {/* Team B Row */}
                              <div
                                className={`flex items-center justify-between p-2.5 rounded border transition-colors ${
                                  isTeamBWinner
                                    ? "bg-pickle/10 border-pickle/40"
                                    : "bg-charcoal/40 border-border/40"
                                }`}
                              >
                                <div className="min-w-0 mr-3">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {isTeamBWinner && (
                                      <span className="px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-widest bg-pickle text-sand shrink-0">
                                        Winner
                                      </span>
                                    )}
                                    <span
                                      className={`font-semibold text-sm truncate ${
                                        isTeamBWinner ? "text-sand font-bold" : "text-foreground"
                                      }`}
                                    >
                                      {m.teamBName}
                                    </span>
                                  </div>
                                  {m.teamBPlayers && m.teamBPlayers.length > 0 && (
                                    <span className="block text-[0.65rem] text-muted-foreground truncate mt-0.5">
                                      {m.teamBPlayers.join(" / ")}
                                    </span>
                                  )}
                                </div>
                                <span
                                  className={`font-display text-2xl sm:text-3xl tabular-nums ${
                                    isTeamBWinner ? "text-pickle font-bold" : "text-sand/80"
                                  }`}
                                >
                                  {m.score.teamBScore}
                                </span>
                              </div>
                            </div>

                            {/* Card Footer */}
                            <div className="flex items-center justify-between text-[0.65rem] text-muted-foreground pt-2 border-t border-border/40">
                              <div className="flex items-center gap-1.5">
                                <span className="uppercase tracking-wider">
                                  Official:
                                </span>
                                <span className="font-semibold text-sand">
                                  {m.officiatedBy || "Desk Recorded"}
                                </span>
                              </div>

                              <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                                ID: {m.id}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── TAB 4: ADD AD-HOC / CUSTOM MATCH ── */}
        {activeQueueTab === "custom" && (
          <form onSubmit={handleCreateCustomMatch} className="max-w-xl space-y-4 pt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs uppercase tracking-wider text-muted-foreground block mb-1">
                  Team A Name
                </label>
                <input
                  type="text"
                  value={customTeamA}
                  onChange={(e) => setCustomTeamA(e.target.value)}
                  placeholder="e.g. The Dink Masters"
                  required
                  className="w-full bg-charcoal text-sand border border-border px-3 py-2 text-sm rounded focus:border-pickle focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs uppercase tracking-wider text-muted-foreground block mb-1">
                  Team B Name
                </label>
                <input
                  type="text"
                  value={customTeamB}
                  onChange={(e) => setCustomTeamB(e.target.value)}
                  placeholder="e.g. Net Rulers"
                  required
                  className="w-full bg-charcoal text-sand border border-border px-3 py-2 text-sm rounded focus:border-pickle focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs uppercase tracking-wider text-muted-foreground block mb-1">
                  Stage / Match Label
                </label>
                <input
                  type="text"
                  value={customStage}
                  onChange={(e) => setCustomStage(e.target.value)}
                  placeholder="e.g. Exhibition / Consolation"
                  className="w-full bg-charcoal text-sand border border-border px-3 py-2 text-sm rounded focus:border-pickle focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs uppercase tracking-wider text-muted-foreground block mb-1">
                  Target Destination
                </label>
                <select
                  value={customTarget}
                  onChange={(e) => setCustomTarget(e.target.value as typeof customTarget)}
                  className="w-full bg-charcoal text-sand border border-border px-3 py-2 text-sm rounded focus:border-pickle focus:outline-none cursor-pointer"
                >
                  <option value="queue">Add to End of Queue</option>
                  {FACILITY_COURTS.map((c) => (
                    <option key={c} value={c}>
                      Dispatch Directly to {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              type="submit"
              className="px-5 py-2.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer"
            >
              Add Match
            </button>
          </form>
        )}
      </div>
        </>
      )}

      {/* Admin Reset Confirmation Modal */}
      {resetConfirmMatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/90 backdrop-blur-sm p-4">
          <div className="surface-card border-2 border-pickle/60 max-w-sm w-full p-6 space-y-4">
            <div>
              <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-pickle block">
                Pre-Match Reset
              </span>
              <h3 className="font-display text-2xl text-foreground mt-1">
                Reset Match & Require Toss?
              </h3>
            </div>
            <p className="text-sm text-foreground/80">
              This will reset the score to 0-0 for <strong>{resetConfirmMatch.match.teamAName}</strong> vs <strong>{resetConfirmMatch.match.teamBName}</strong> on {resetConfirmMatch.court}, clear all rallies, and set the station to warm-up with coin toss required.
            </p>
            <div className="flex gap-3 justify-end pt-2">
              <button
                type="button"
                onClick={() => setResetConfirmMatch(null)}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest border border-border text-foreground hover:border-foreground/50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => executeResetMatch(resetConfirmMatch.court, resetConfirmMatch.match)}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer"
              >
                Reset & Require Toss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Direct Court Bracket Selection Modal ── */}
      {selectedCourtForDispatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-charcoal/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="surface-card border border-pickle/50 w-full max-w-3xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden bg-card">
            {/* Modal Header */}
            <div className="bg-charcoal px-4 sm:px-5 py-3.5 border-b border-border flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40">
                    Direct Court Dispatch
                  </span>
                  <span className="font-display text-base sm:text-lg tracking-wider text-sand">
                    {selectedCourtForDispatch}
                  </span>
                </div>
                <p className="text-xs text-sand/70 mt-1">
                  Select a bracket tab below to browse remaining unplayed games and dispatch directly to {selectedCourtForDispatch}.
                </p>
              </div>

              <button
                onClick={() => setSelectedCourtForDispatch(null)}
                className="h-8 w-8 flex items-center justify-center text-sand/70 hover:text-sand border border-border/80 hover:border-sand text-lg font-bold transition-colors cursor-pointer shrink-0"
                title="Close"
              >
                &times;
              </button>
            </div>

            {/* Division Switcher (if multiple categories) */}
            {tournament.categories.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 bg-card border-b-2 border-border">
                <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground mr-1 shrink-0 font-bold">
                  Division:
                </span>
                {tournament.categories.map((c) => {
                  const isCurrent = c.id === bracketModalCategory;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setBracketModalCategory(c.id)}
                      className={`px-2.5 py-1 text-xs font-semibold tracking-wide border-2 transition-colors shrink-0 cursor-pointer ${isCurrent
                          ? "bg-brick text-sand border-brick font-bold"
                          : "bg-card text-foreground border-border hover:border-pickle hover:text-pickle"
                        }`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Bracket Tabs Strip — responsive grid on mobile, flex-wrap on desktop */}
            <div className="grid grid-cols-3 sm:flex sm:flex-wrap items-center gap-1.5 p-3 bg-card border-b-2 border-border">
              {bracketModalData.groups.length === 0 ? (
                <span className="text-xs text-muted-foreground italic px-2 col-span-3">
                  No brackets found for this division.
                </span>
              ) : (
                <>
                  {/* All Brackets Tab */}
                  <button
                    onClick={() => setBracketModalSelectedLetter("ALL")}
                    className={`p-1.5 sm:px-3 sm:py-1.5 text-[0.65rem] sm:text-xs font-display tracking-wider uppercase border transition-all flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 cursor-pointer ${bracketModalSelectedLetter === "ALL"
                        ? "bg-pickle text-sand border-pickle shadow-sm font-bold"
                        : "bg-charcoal text-sand/80 border-border hover:border-sand/60"
                      }`}
                  >
                    <span>All Brackets</span>
                    {(() => {
                      const totalAll = bracketModalData.groups.reduce((acc, g) => acc + g.totalCount, 0);
                      const unplayedAll = bracketModalData.groups.reduce((acc, g) => acc + g.unplayedCount, 0);
                      const isEmpty = totalAll === 0;
                      const hasUnplayed = unplayedAll > 0;
                      return (
                        <span
                          className={`px-1.5 py-0.2 text-[0.6rem] font-mono font-bold rounded-sm ${bracketModalSelectedLetter === "ALL"
                              ? "bg-sand text-charcoal"
                              : isEmpty
                                ? "bg-muted text-muted-foreground"
                                : hasUnplayed
                                  ? "bg-pickle/20 text-pickle"
                                  : "bg-emerald-500/20 text-emerald-400"
                            }`}
                        >
                          {isEmpty ? "Empty" : hasUnplayed ? `${unplayedAll} left` : "Done"}
                        </span>
                      );
                    })()}
                  </button>

                  {/* Individual Bracket Tabs */}
                  {bracketModalData.groups.map((group) => {
                    const isActive = group.letter === bracketModalSelectedLetter;
                    const isEmpty = group.totalCount === 0;
                    const hasUnplayed = group.unplayedCount > 0;
                    return (
                      <button
                        key={group.letter}
                        onClick={() => setBracketModalSelectedLetter(group.letter)}
                        className={`p-1.5 sm:px-3 sm:py-1.5 text-[0.65rem] sm:text-xs font-display tracking-wider uppercase border transition-all flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 cursor-pointer ${isActive
                            ? "bg-pickle text-sand border-pickle shadow-sm font-bold"
                            : "bg-charcoal text-sand/80 border-border hover:border-sand/60"
                          }`}
                      >
                        <span>{group.label}</span>
                        <span
                          className={`px-1.5 py-0.2 text-[0.6rem] font-mono font-bold rounded-sm ${isActive
                              ? "bg-sand text-charcoal"
                              : isEmpty
                                ? "bg-muted text-muted-foreground"
                                : hasUnplayed
                                  ? "bg-pickle/20 text-pickle"
                                  : "bg-emerald-500/20 text-emerald-400"
                            }`}
                        >
                          {isEmpty ? "Empty" : hasUnplayed ? `${group.unplayedCount} left` : "Done"}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>

            {/* Filter, Search & Batch Push Toolbar */}
            {bracketModalData.groups.length > 0 && (
              <div className="p-3 bg-card border-b border-border/80 space-y-2.5">
                {/* Search Bar + Team Filter + Batch Push Action */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {/* Live Search */}
                    <div className="relative flex-1 min-w-0">
                      <input
                        type="text"
                        value={bracketModalSearchQuery}
                        onChange={(e) => setBracketModalSearchQuery(e.target.value)}
                        placeholder="Search team, player, or bracket..."
                        className="w-full px-3 py-1.5 text-xs bg-charcoal text-sand border border-border rounded-sm focus:outline-hidden focus:border-pickle pr-7"
                      />
                      {bracketModalSearchQuery && (
                        <button
                          onClick={() => setBracketModalSearchQuery("")}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs cursor-pointer"
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    {/* Team Filter Dropdown */}
                    {availableModalTeams.length > 1 && (
                      <select
                        value={bracketModalTeamFilter}
                        onChange={(e) => setBracketModalTeamFilter(e.target.value)}
                        className="px-2 py-1.5 text-xs bg-charcoal text-sand border border-border rounded-sm focus:outline-hidden focus:border-pickle cursor-pointer max-w-[140px] sm:max-w-[180px] truncate shrink-0"
                        title="Filter matchups by team or club"
                      >
                        <option value="all">All Teams ({availableModalTeams.length})</option>
                        {availableModalTeams.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Batch Push Button */}
                  {displayedModalMatches.some((m) => m.status === "unassigned") && (
                    <button
                      onClick={handleQueueAllDisplayedModalMatches}
                      className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer shrink-0 shadow-sm"
                    >
                      + Queue Displayed ({displayedModalMatches.filter((m) => m.status === "unassigned").length})
                    </button>
                  )}
                </div>

                {/* Status Filter Pills */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold mr-1 shrink-0">
                    Status:
                  </span>
                  <button
                    onClick={() => setBracketModalStatusFilter("all")}
                    className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer ${bracketModalStatusFilter === "all"
                        ? "bg-pickle text-sand border-pickle"
                        : "bg-charcoal text-sand/70 border-border hover:border-sand"
                      }`}
                  >
                    All ({modalStats.total})
                  </button>
                  <button
                    onClick={() => setBracketModalStatusFilter("unplayed")}
                    className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer ${bracketModalStatusFilter === "unplayed"
                        ? "bg-pickle text-sand border-pickle"
                        : "bg-charcoal text-sand/70 border-border hover:border-sand"
                      }`}
                  >
                    Unplayed ({modalStats.unplayed})
                  </button>
                  <button
                    onClick={() => setBracketModalStatusFilter("ready")}
                    className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer ${bracketModalStatusFilter === "ready"
                        ? "bg-emerald-600 text-sand border-emerald-500 font-bold"
                        : "bg-charcoal text-sand/70 border-border hover:border-sand"
                      }`}
                  >
                    Ready Now ({modalStats.ready})
                  </button>
                  <button
                    onClick={() => setBracketModalStatusFilter("queued")}
                    className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer ${bracketModalStatusFilter === "queued"
                        ? "bg-amber-600 text-sand border-amber-500 font-bold"
                        : "bg-charcoal text-sand/70 border-border hover:border-sand"
                      }`}
                  >
                    In Queue ({modalStats.queued})
                  </button>
                  <button
                    onClick={() => setBracketModalStatusFilter("completed")}
                    className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer ${bracketModalStatusFilter === "completed"
                        ? "bg-pickle text-sand border-pickle"
                        : "bg-charcoal text-sand/70 border-border hover:border-sand"
                      }`}
                  >
                    Completed ({modalStats.completed})
                  </button>
                </div>
              </div>
            )}

            {/* Match Cards Body */}
            <div className="p-4 sm:p-5 overflow-y-auto space-y-3.5 flex-1 min-h-[220px]">
              {(() => {
                if (bracketModalData.groups.length === 0) {
                  return (
                    <div className="py-12 text-center space-y-3">
                      <div className="text-xs uppercase tracking-widest text-muted-foreground font-bold">
                        No Pool Play Brackets
                      </div>
                      <p className="text-sm text-foreground/80 max-w-sm mx-auto">
                        This division does not have drawn brackets yet. Generate brackets in the Bracket Draw section first.
                      </p>
                    </div>
                  );
                }

                return (
                  <div className="space-y-4">
                    {/* Header info */}
                    <div className="flex items-center justify-between border-b border-border/60 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-display text-lg sm:text-xl text-foreground">
                          {bracketModalSelectedLetter === "ALL"
                            ? "All Division Matches"
                            : `${bracketModalData.groups.find((g) => g.letter === bracketModalSelectedLetter)?.label ?? `Bracket ${bracketModalSelectedLetter}`} Matches`}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          ({displayedModalMatches.length} shown of {modalStats.total})
                        </span>
                      </div>
                      <span className="text-[0.65rem] uppercase tracking-wider text-pickle font-bold">
                        Target: {selectedCourtForDispatch}
                      </span>
                    </div>

                    {/* Filtered Matches List */}
                    {displayedModalMatches.length === 0 ? (
                      <div className="p-8 text-center border-2 border-border bg-card rounded-xl shadow-xs space-y-3">
                        <span className="text-xs uppercase tracking-widest text-muted-foreground font-bold block">
                          No Matches Found
                        </span>
                        <p className="text-xs sm:text-sm text-foreground/80 max-w-md mx-auto">
                          {bracketModalSearchQuery || bracketModalTeamFilter !== "all" || bracketModalStatusFilter !== "all"
                            ? "No matches match the selected filters."
                            : "All matches in this bracket have concluded."}
                        </p>
                        <div className="pt-2 flex flex-wrap items-center justify-center gap-2">
                          {(bracketModalSearchQuery || bracketModalTeamFilter !== "all" || bracketModalStatusFilter !== "all") && (
                            <button
                              type="button"
                              onClick={() => {
                                setBracketModalSearchQuery("");
                                setBracketModalTeamFilter("all");
                                setBracketModalStatusFilter("all");
                              }}
                              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand hover:bg-pickle/90 transition-colors cursor-pointer shadow-sm"
                            >
                              Reset Filters
                            </button>
                          )}
                          {bracketModalData.groups.some((g) => g.unplayedCount > 0 && g.letter !== bracketModalSelectedLetter) && (
                            <button
                              type="button"
                              onClick={() => {
                                const nextWithUnplayed = bracketModalData.groups.find((g) => g.unplayedCount > 0 && g.letter !== bracketModalSelectedLetter);
                                if (nextWithUnplayed) setBracketModalSelectedLetter(nextWithUnplayed.letter);
                              }}
                              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider border border-border text-sand hover:border-sand transition-colors cursor-pointer"
                            >
                              View Other Brackets
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {displayedModalMatches.map((match, idx) => {
                          const restA = checkRestPeriodConflict(match.teamAName, match.teamAPlayers);
                          const restB = checkRestPeriodConflict(match.teamBName, match.teamBPlayers);
                          const liveA = checkSimultaneousPlayConflict(match.teamAName, match.teamAPlayers, tournamentSlug);
                          const liveB = checkSimultaneousPlayConflict(match.teamBName, match.teamBPlayers, tournamentSlug);
                          const activeConflict = liveA || liveB;

                          const isTeamPlayingElsewhere = Boolean(activeConflict);
                          const isMatchAlreadyOnThisCourt = Boolean(
                            match.status === "live" && match.assignedCourt === selectedCourtForDispatch,
                          );
                          const isMatchAlreadyOnOtherCourt = Boolean(
                            match.status === "live" && match.assignedCourt && match.assignedCourt !== selectedCourtForDispatch,
                          );
                          const isMatchFinal = match.status === "final" || Boolean(match.winnerTeam);
                          const isActionDisabled =
                            isMatchFinal ||
                            isMatchAlreadyOnThisCourt ||
                            isMatchAlreadyOnOtherCourt ||
                            isTeamPlayingElsewhere;

                          return (
                            <div
                              key={match.id}
                              className={`p-3.5 border transition-all flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${isMatchAlreadyOnThisCourt
                                  ? "border-pickle/60 bg-pickle/5"
                                  : isActionDisabled && !isMatchFinal
                                    ? "border-border/40 bg-card/40 opacity-75"
                                    : isMatchFinal
                                      ? "border-border/40 bg-card/30 opacity-70"
                                      : "border-border bg-card hover:border-pickle/60"
                                }`}
                            >
                              <div className="min-w-0 space-y-1.5 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono text-xs text-muted-foreground font-bold">
                                    #{idx + 1}
                                  </span>
                                  {isMatchFinal ? (
                                    <span className="px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-card text-muted-foreground border border-border">
                                      Final
                                    </span>
                                  ) : match.status === "live" ? (
                                    <span className="px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40">
                                      Active on {match.assignedCourt}
                                    </span>
                                  ) : activeConflict ? (
                                    <span className="px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40">
                                      {activeConflict.status === "on_deck" ? "On-Deck" : "In Play"} on {activeConflict.court}
                                    </span>
                                  ) : match.status === "queued" ? (
                                    <span className="px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-charcoal text-sand/80 border border-border">
                                      In Queue #{match.queueIndex}
                                    </span>
                                  ) : (
                                    <span className="px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                                      Ready to Play
                                    </span>
                                  )}
                                  <span className="text-[0.65rem] text-muted-foreground uppercase tracking-wider">
                                    {match.stage}
                                  </span>
                                </div>

                                {/* Teams & Rosters */}
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                                  <div className="min-w-0 p-2.5 bg-card border-2 border-border rounded-md shadow-xs">
                                    <span className="font-bold text-sm text-foreground block truncate">
                                      {match.teamAName}
                                    </span>
                                    {match.teamAPlayers.length > 0 && (
                                      <span className="text-[0.65rem] text-foreground/80 font-bold block truncate">
                                        {match.teamAPlayers.join(" / ")}
                                      </span>
                                    )}
                                  </div>

                                  <div className="min-w-0 p-2.5 bg-card border-2 border-border rounded-md shadow-xs">
                                    <span className="font-bold text-sm text-foreground block truncate">
                                      {match.teamBName}
                                    </span>
                                    {match.teamBPlayers.length > 0 && (
                                      <span className="text-[0.65rem] text-foreground/80 font-bold block truncate">
                                        {match.teamBPlayers.join(" / ")}
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {/* Conflict & Rest Warnings */}
                                {activeConflict && (
                                  <div className="text-[0.65rem] text-brick font-bold pt-0.5">
                                    Cannot dispatch: {activeConflict.isPlayerConflict ? `${activeConflict.playerName} (${activeConflict.teamName})` : activeConflict.teamName} is currently {activeConflict.status === "on_deck" ? "on-deck" : "live"} on {activeConflict.court}
                                  </div>
                                )}
                                {(restA || restB) && (
                                  <div className="text-[0.65rem] text-amber-400 font-medium pt-0.5">
                                    Rest Warning: {(restA ?? restB)?.teamName} finished {(restA ?? restB)?.minutesAgo}m ago
                                  </div>
                                )}
                              </div>

                              {/* Card Action Buttons: Queue & Dispatch */}
                              <div className="shrink-0 flex items-center gap-2 sm:self-center">
                                {!isMatchFinal && match.status === "unassigned" && (
                                  <button
                                    onClick={() => handleQueueModalSingle(match)}
                                    title="Add matchup to dispatch queue"
                                    className="px-3 py-2.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-sand transition-colors cursor-pointer"
                                  >
                                    + Queue
                                  </button>
                                )}

                                {!isMatchFinal ? (
                                  <button
                                    onClick={() => handleSelectBracketMatchForCourt(selectedCourtForDispatch, match)}
                                    disabled={isActionDisabled}
                                    title={
                                      isMatchAlreadyOnThisCourt
                                        ? "Currently live on this court"
                                        : isMatchAlreadyOnOtherCourt
                                          ? `Currently live on ${match.assignedCourt}`
                                          : activeConflict
                                            ? `Cannot dispatch: ${activeConflict.teamName} is ${activeConflict.status === "on_deck" ? "on-deck" : "live"} on ${activeConflict.court}`
                                            : `Dispatch match to ${selectedCourtForDispatch}`
                                    }
                                    className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wider border transition-all ${isActionDisabled
                                        ? "border-2 border-border text-muted-foreground bg-card cursor-not-allowed opacity-60"
                                        : "bg-pickle text-sand border-pickle hover:bg-pickle/90 cursor-pointer shadow-sm"
                                      }`}
                                  >
                                    {isMatchAlreadyOnThisCourt
                                      ? "Active On Court"
                                      : isMatchAlreadyOnOtherCourt
                                        ? `Live on ${match.assignedCourt}`
                                        : activeConflict
                                          ? activeConflict.status === "on_deck"
                                            ? `On-Deck on ${activeConflict.court}`
                                            : `In Play on ${activeConflict.court}`
                                          : `Dispatch to ${selectedCourtForDispatch} ->`}
                                  </button>
                                ) : (
                                  <div className="px-3 py-2 text-xs font-mono font-bold text-muted-foreground border border-border/50 bg-card/60">
                                    {match.liveScore ? `${match.liveScore.teamAScore} - ${match.liveScore.teamBScore}` : "Final"}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Modal Footer */}
            <div className="bg-charcoal px-4 sm:px-5 py-3 border-t border-border flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Dink Valley Court Manager
              </span>
              <button
                onClick={() => setSelectedCourtForDispatch(null)}
                className="px-4 py-1.5 text-xs font-bold uppercase tracking-wider border border-border text-sand hover:border-sand transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Court Replacement Confirmation Modal */}
      {courtReplaceConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/90 backdrop-blur-sm p-4">
          <div className="surface-card border-2 border-pickle/60 max-w-sm w-full p-6 space-y-4">
            <div>
              <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-pickle block">
                Court In Use
              </span>
              <h3 className="font-display text-2xl text-foreground mt-1">
                Replace Match on {courtReplaceConfirm.court}?
              </h3>
            </div>
            <p className="text-sm text-foreground/80">
              {courtReplaceConfirm.court} currently has an active match. Dispatching will return the current match back to the Queue and start warm-up for <strong>{courtReplaceConfirm.pendingMatch.teamAName}</strong> vs <strong>{courtReplaceConfirm.pendingMatch.teamBName}</strong>.
            </p>
            <div className="flex gap-3 justify-end pt-2">
              <button
                type="button"
                onClick={() => setCourtReplaceConfirm(null)}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest border border-border text-foreground hover:border-foreground/50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => executeBracketDispatch(courtReplaceConfirm.court, courtReplaceConfirm.pendingMatch)}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer"
              >
                Confirm &amp; Dispatch
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dispatch Debug Station Inspector */}
      <DispatchDebugStation
        isOpen={isDebugStationOpen}
        onClose={() => setIsDebugStationOpen(false)}
        tournamentSlug={tournamentSlug}
        initialTab={debugStationTab}
        onStateRepaired={() => {
          reloadData();
          refreshMatches();
        }}
      />
    </div>
  );
}
