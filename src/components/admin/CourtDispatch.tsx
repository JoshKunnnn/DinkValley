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
  isMatchInSameBracket,
  reconcileCourtStations,
} from "@/lib/court-dispatch";
import { getDrawnGroups } from "@/components/admin/BracketDraw";
import { getMainDrawMatches } from "@/components/admin/DrawsManager";
import { dbUpdateCourtStation } from "@/lib/supabase-service";

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
  const playoffMatches = getMainDrawMatches(tournamentSlug, cat.id);
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

      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const teamA = teams[i]!;
          const teamB = teams[j]!;
          if (teamA.name.trim().toLowerCase() === teamB.name.trim().toLowerCase()) continue;
          const matchId = `live-${tournamentSlug}-${cat.id}-${group.letter}-${i + 1}v${j + 1}`;
          const existingLive = matches.find((m) => m.id === matchId);

          if (existingLive?.status === "final") continue;
          if (queuedIds.has(matchId) || activeCourtMatchIds.has(matchId)) continue;

          list.push({
            id: matchId,
            stage: `Bracket ${group.letter} (Pool Play)`,
            teamAName: teamA.name,
            teamAPlayers: teamA.players,
            teamBName: teamB.name,
            teamBPlayers: teamB.players,
          });
        }
      }
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
      const matchId = `live-ko-${tournamentSlug}-${cat.id}-${km.id}`;
      const existingLive = matches.find((m) => m.id === matchId);

      if (existingLive?.status === "final" || km.winner) continue;
      if (queuedIds.has(matchId) || activeCourtMatchIds.has(matchId)) continue;

      list.push({
        id: matchId,
        stage: `${km.round} - ${km.label}`,
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
  const { matches, refresh: refreshMatches, update: updateMatchStore } = useMatchStore();
  const [stations, setStations] = useState<Record<FacilityCourt, CourtStation>>(() => getCourtStations());
  const [queue, setQueue] = useState<QueueItem[]>(() => getDispatchQueue());
  const [announcement, setAnnouncement] = useState<DeskAnnouncement | null>(() => getLatestAnnouncement());
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
  const [bracketModalShowCompleted, setBracketModalShowCompleted] = useState(false);
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

  // Sync stations, queue, and announcement with storage and auto-clean conflicts
  const reloadData = useCallback(() => {
    reconcileCourtStations();
    removePlayingConflictsFromQueue(tournamentSlug);
    setStations(getCourtStations());
    setQueue(getDispatchQueue());
    setAnnouncement(getLatestAnnouncement());
    setCategoryOrder(getCategorySequence(tournamentSlug, tournament.categories));
    setActiveWaveIdState(getActiveWaveId(tournamentSlug, categoryId));
    refreshMatches();
  }, [refreshMatches, tournamentSlug, tournament.categories, categoryId]);

  // Initial reconciliation on mount to resolve any stale court station data
  useEffect(() => {
    reconcileCourtStations();
  }, []);

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
    prevMatchesRef.current = matches;
  }, [matches]);

  useEffect(() => {
    const handleStorage = () => {
      setDrawVersion((v) => v + 1);
      reloadData();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener("dv_drawn_groups_updated", handleStorage);
    window.addEventListener("dv_dispatch_queue_updated", handleStorage);
    window.addEventListener("dv_live_matches_updated", handleStorage);
    window.addEventListener("dv_category_sequence_updated", handleStorage);
    window.addEventListener("dv_court_stations_updated", handleStorage);
    const interval = setInterval(handleStorage, 2000);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("dv_drawn_groups_updated", handleStorage);
      window.removeEventListener("dv_dispatch_queue_updated", handleStorage);
      window.removeEventListener("dv_live_matches_updated", handleStorage);
      window.removeEventListener("dv_category_sequence_updated", handleStorage);
      window.removeEventListener("dv_court_stations_updated", handleStorage);
      clearInterval(interval);
    };
  }, [reloadData]);

  // Auto-sync & auto-cleanup: If players/teams were deleted from the database/roster,
  // automatically purge orphaned matches from the dispatch queue, court stations, and bracket cache.
  useEffect(() => {
    if (!category) return;
    const currentQueue = getDispatchQueue();
    const isCatMatch = (q: QueueItem) =>
      q.categoryId === categoryId ||
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
      const station = stations[court];
      if (station.status === "available" && !station.currentMatchId) {
        map[court] = null;
        continue;
      }
      if (station.currentMatchId) {
        const found = matches.find((m) => m.id === station.currentMatchId && m.status !== "final");
        if (found) {
          map[court] = found;
          continue;
        }
      }
      // Fallback: look for match assigned to this court with live or scheduled status
      const active = matches.find((m) => m.court === court && (m.status === "live" || m.status === "scheduled"));
      if (active) {
        map[court] = active;
      }
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
      const unassigned = computeCategoryUnassignedMatches(tournamentSlug, cat, queue, stations, matches);
      const completedCount = matches.filter(
        (m) => (m.categoryId === cat.id || m.id.includes(cat.id)) && m.status === "final",
      ).length;
      const onCourtCount = matches.filter(
        (m) =>
          (m.categoryId === cat.id || m.id.includes(cat.id)) &&
          (m.status === "live" || m.status === "scheduled"),
      ).length;
      const queuedCount = queue.filter(
        (q) =>
          (q.status === "queued" || q.status === "on_deck") &&
          (q.categoryId === cat.id || q.matchId.includes(cat.id)),
      ).length;
      const unassignedCount = unassigned.length;
      const totalMatches = completedCount + onCourtCount + queuedCount + unassignedCount;
      const progressPercent = totalMatches > 0 ? Math.round((completedCount / totalMatches) * 100) : 0;
      const isCompleted = totalMatches > 0 && completedCount === totalMatches;

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
    const playoffMatches = getMainDrawMatches(tournamentSlug, activeCat.id);

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

        const groupMatches: typeof groupsList[number]["matches"] = [];

        for (let i = 0; i < teams.length; i++) {
          for (let j = i + 1; j < teams.length; j++) {
            const teamA = teams[i]!;
            const teamB = teams[j]!;
            if (teamA.name.trim().toLowerCase() === teamB.name.trim().toLowerCase()) continue;

            const stage = `Bracket ${group.letter} (Pool Play)`;
            if (!isMatchInSameBracket(tournamentSlug, activeCat.id, stage, teamA.name, teamB.name)) {
              continue;
            }

            const matchId = `live-${tournamentSlug}-${activeCat.id}-${group.letter}-${i + 1}v${j + 1}`;
            const existing = matches.find(
              (m) =>
                m.id === matchId ||
                (m.stage?.includes(`Bracket ${group.letter}`) &&
                  ((m.teamAName.trim().toLowerCase() === teamA.name.trim().toLowerCase() &&
                    m.teamBName.trim().toLowerCase() === teamB.name.trim().toLowerCase()) ||
                    (m.teamAName.trim().toLowerCase() === teamB.name.trim().toLowerCase() &&
                      m.teamBName.trim().toLowerCase() === teamA.name.trim().toLowerCase()))),
            );

            let matchStatus: "unassigned" | "queued" | "live" | "final" = "unassigned";
            let assignedCourt: string | undefined = undefined;
            let queueIndex: number | undefined = undefined;

            if (existing?.status === "final") {
              matchStatus = "final";
            } else {
              const courtEntry = Object.entries(stations).find(
                ([c, st]) =>
                  st.currentMatchId === (existing?.id || matchId) &&
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
                    (q.matchId === matchId || q.matchId === existing?.id) &&
                    (q.status === "queued" || q.status === "on_deck"),
                );
                if (qIdx !== -1) {
                  matchStatus = "queued";
                  queueIndex = qIdx + 1;
                }
              }
            }

            groupMatches.push({
              id: existing?.id || matchId,
              stage: existing?.stage || stage,
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
        const matchId = `live-ko-${tournamentSlug}-${activeCat.id}-${km.id}`;
        const existing = matches.find((m) => m.id === matchId);

        let matchStatus: "unassigned" | "queued" | "live" | "final" = "unassigned";
        let assignedCourt: string | undefined = undefined;
        let queueIndex: number | undefined = undefined;

        if (existing?.status === "final" || km.winner) {
          matchStatus = "final";
        } else {
          const courtEntry = Object.entries(stations).find(
            ([c, st]) =>
              st.currentMatchId === (existing?.id || matchId) &&
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
                (q.matchId === matchId || q.matchId === existing?.id) &&
                (q.status === "queued" || q.status === "on_deck"),
            );
            if (qIdx !== -1) {
              matchStatus = "queued";
              queueIndex = qIdx + 1;
            }
          }
        }

        koMatches.push({
          id: existing?.id || matchId,
          stage: `${km.round} - ${km.label}`,
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
  useEffect(() => {
    if (selectedCourtForDispatch && bracketModalData.groups.length > 0) {
      const exists = bracketModalData.groups.some((g) => g.letter === bracketModalSelectedLetter);
      if (!exists) {
        const firstWithUnplayed = bracketModalData.groups.find((g) => g.unplayedCount > 0);
        setBracketModalSelectedLetter(firstWithUnplayed ? firstWithUnplayed.letter : (bracketModalData.groups[0]?.letter ?? "A"));
      }
    }
  }, [selectedCourtForDispatch, bracketModalData.groups, bracketModalSelectedLetter]);

  const handleOpenBracketModal = (court: FacilityCourt) => {
    setSelectedCourtForDispatch(court);
    setBracketModalCategory(categoryId);
    setBracketModalShowCompleted(false);
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
    if (conflict) {
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

  const executeBracketDispatch = (
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
    handleDispatch(court, {
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
      .filter((item) => {
        // Strictly only display matches where both teams belong to the same bracket
        if (!isMatchInSameBracket(item.tournamentSlug || tournamentSlug, item.categoryId || categoryId, item.stage, item.teamAName, item.teamBName)) {
          return false;
        }

        if (queueDivisionFilter === "current") {
          const isThisCategory =
            item.categoryId === categoryId ||
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
          if (!item.id.startsWith("custom-") && item.categoryId === categoryId && (!category?.teams || category.teams.length === 0)) {
            return false;
          }
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
  }, [queue, searchQuery, queueDivisionFilter, categoryId, tournamentSlug, category]);

  // Filtered history (search-aware, division-aware)
  const filteredHistory = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return matches.filter(
      (m) =>
        m.status === "final" &&
        (queueDivisionFilter === "all" || !m.categoryId || m.categoryId === categoryId) &&
        (!q ||
          m.teamAName.toLowerCase().includes(q) ||
          m.teamBName.toLowerCase().includes(q) ||
          (m.stage ?? "").toLowerCase().includes(q)),
    );
  }, [matches, searchQuery, queueDivisionFilter, categoryId]);

  // Unassigned matches grouped by bracket stage (search-aware, Pool Play first)
  const groupedUnassigned = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const filtered = !q
      ? unassignedMatches
      : unassignedMatches.filter(
        (m) =>
          m.teamAName.toLowerCase().includes(q) ||
          m.teamBName.toLowerCase().includes(q) ||
          m.stage.toLowerCase().includes(q) ||
          m.teamAPlayers.some((p) => p.toLowerCase().includes(q)) ||
          m.teamBPlayers.some((p) => p.toLowerCase().includes(q)),
      );

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
  }, [unassignedMatches, searchQuery]);

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
      if (!isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName)) continue;
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
      if (!isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName)) return false;
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
  const handleDispatch = (
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
    if (match.stage && !isMatchInSameBracket(match.tournamentSlug || tournamentSlug, match.categoryId || categoryId, match.stage, match.teamAName, match.teamBName)) {
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
    dispatchMatchToCourt(court, match, umpire);
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

  const handleVacateCourt = (court: FacilityCourt) => {
    const active = courtMatches[court];
    vacateCourt(court);
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
    saveCourtStations(nextStations);

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
    completeQueueMatch(matchId);
    const nextStations = { ...stations };
    nextStations[court] = {
      ...nextStations[court],
      status: "available",
      currentMatchId: null,
      dispatchedAt: null,
    };
    saveCourtStations(nextStations);
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
    saveCourtStations(nextStations);
    dbUpdateCourtStation(court, {
      status: "warmup",
      currentMatchId: m.id,
    }).catch(() => {});
    reloadData();
    setResetConfirmMatch(null);
  };

  const handleQueueUnassignedAll = useCallback(() => {
    const valid = unassignedMatches.filter((m) =>
      isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName)
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
    }
  }, [unassignedMatches, tournamentSlug, categoryId, reloadData]);

  const handleQueueSingle = (m: typeof unassignedMatches[number]) => {
    if (!isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName)) {
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
          (q.categoryId === catId || (!q.categoryId && q.matchId && q.matchId.includes(catId))) &&
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

  const handleCreateCustomMatch = (e: React.FormEvent) => {
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
      dispatchMatchToCourt(customTarget, {
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
      isMatchInSameBracket(tournamentSlug, categoryId, m.stage, m.teamAName, m.teamBName)
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

        <div className="surface-card p-3.5 sm:p-4 border border-border">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground block">
            Matches Completed
          </span>
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
            const nextInQueue = queue.find((q) => q.status === "queued" || q.status === "on_deck");
            const onDeckMatch = station.onDeckMatchId ? matches.find((m) => m.id === station.onDeckMatchId) : null;

            // Rest & Simultaneous Conflict Warnings for teams on this court
            const restWarningA = activeMatch ? checkRestPeriodConflict(activeMatch.teamAName) : null;
            const restWarningB = activeMatch ? checkRestPeriodConflict(activeMatch.teamBName) : null;

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
                className={`surface-card p-0 overflow-hidden border flex flex-col justify-between transition-all ${
                  station.status === "available" && !activeMatch
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
                <div className="bg-charcoal px-4 py-3 border-b border-border flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
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
                  </div>

                  <div className="flex items-center gap-2">
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

                      {/* Teams & Scores */}
                      <div className="space-y-3">
                        {/* Team A */}
                        <div className="flex items-center justify-between p-2.5 rounded bg-charcoal/30 border border-border">
                          <div className="min-w-0 mr-3">
                            <div className="flex items-center gap-1.5">
                              {activeMatch.score.servingTeam === "A" && activeMatch.status === "live" && (
                                <span className="h-2 w-2 rounded-full bg-pickle shrink-0" />
                              )}
                              <span className={`font-semibold text-sm truncate ${activeMatch.score.servingTeam === "A" ? "text-foreground" : "text-foreground/80"}`}>
                                {activeMatch.teamAName}
                              </span>
                            </div>
                            {activeMatch.teamAPlayers.length > 0 && (
                              <span className="block text-[0.65rem] text-muted-foreground truncate">
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
                        <div className="flex items-center justify-between p-2.5 rounded bg-charcoal/30 border border-border">
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

                        {nextInQueue ? (
                          <div className="p-2.5 bg-charcoal/40 border border-border text-left space-y-1.5">
                            <div className="flex items-center justify-between text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                              <span>Next in Queue (#1)</span>
                              <span className="text-pickle font-bold">{nextInQueue.stage}</span>
                            </div>
                            <div className="font-semibold text-xs text-sand truncate">
                              {nextInQueue.teamAName} vs {nextInQueue.teamBName}
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAutoDispatch(courtName);
                              }}
                              className="w-full mt-1 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
                            >
                              Or Dispatch Next from Queue
                            </button>
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground italic pt-1">
                            Queue is empty. Select from bracket above.
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
                  className={`surface-card p-4 border transition-all flex flex-col justify-between gap-3.5 ${
                    isActive
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
                        className={`px-2 py-0.5 text-[0.65rem] font-display uppercase tracking-wider border ${
                          isActive
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
                        className={`font-bold uppercase tracking-wider ${
                          isActive
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
                          className={`h-full transition-all duration-300 ${
                            isActive
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
                      <div className="bg-charcoal/40 p-1 border border-border/30">
                        <span className="text-muted-foreground block text-[0.55rem] uppercase">
                          On Court
                        </span>
                        <span className="font-bold text-foreground">
                          {stats?.onCourtCount ?? 0}
                        </span>
                      </div>
                      <div className="bg-charcoal/40 p-1 border border-border/30">
                        <span className="text-muted-foreground block text-[0.55rem] uppercase">
                          Queued
                        </span>
                        <span className="font-bold text-foreground">
                          {stats?.queuedCount ?? 0}
                        </span>
                      </div>
                      <div className="bg-charcoal/40 p-1 border border-border/30">
                        <span className="text-muted-foreground block text-[0.55rem] uppercase">
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
                            (!q.categoryId || q.categoryId === categoryId) &&
                            (!q.tournamentSlug || q.tournamentSlug === tournamentSlug),
                        ).length
                        : queue.filter((q) => q.status === "queued" || q.status === "on_deck").length
                      })`,
                  },
                  { key: "unassigned", label: `Unassigned (${unassignedMatches.length})` },
                  { key: "history", label: `Log (${filteredHistory.length})` },
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

              {/* Division Scope Toggle (Active Queue & Log) */}
              {(activeQueueTab === "queue" || activeQueueTab === "history") && (
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
            <div className="flex items-center gap-1.5 overflow-x-auto text-xs no-scrollbar">
              <span className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground shrink-0 mr-1">
                Category:
              </span>
              <button
                onClick={() => setQueueDivisionFilter("all")}
                className={`px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer shrink-0 ${
                  queueDivisionFilter === "all"
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
                    (q.categoryId === c.id || q.matchId?.includes(c.id)),
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
                    className={`px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer shrink-0 ${
                      isSelected
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
                  const restA = checkRestPeriodConflict(item.teamAName);
                  const restB = checkRestPeriodConflict(item.teamBName);
                  const liveA = checkSimultaneousPlayConflict(item.teamAName, item.teamAPlayers, item.tournamentSlug || tournamentSlug);
                  const liveB = checkSimultaneousPlayConflict(item.teamBName, item.teamBPlayers, item.tournamentSlug || tournamentSlug);
                  const liveConflict = liveA || liveB;
                  const hasWarning = !!(restA || restB || liveConflict);
                  const catLabel = getCategoryLabel(item.categoryId, item.matchId);
                  return (
                    <div
                      key={item.id}
                      className="flex items-center gap-2 py-2 px-3 hover:bg-charcoal/30 transition-colors border-l-2 border-l-pickle"
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
                  const restA = checkRestPeriodConflict(item.teamAName);
                  const restB = checkRestPeriodConflict(item.teamBName);
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
            {/* Sub-header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border/50 pb-3">
              <span className="text-xs text-muted-foreground">
                {searchQuery
                  ? `${groupedUnassigned.reduce((acc, [, m]) => acc + m.length, 0)} match(es) in ${groupedUnassigned.length
                  } bracket(s) matching "${searchQuery}"`
                  : `${groupedUnassigned.length} bracket(s) — ${unassignedMatches.length} matches remaining`}
              </span>
              {unassignedMatches.length > 0 && !searchQuery && (
                <button
                  onClick={handleQueueUnassignedAll}
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer"
                >
                  Queue All ({unassignedMatches.length})
                </button>
              )}
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
                              className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-charcoal/20 transition-colors"
                            >
                              <div className="min-w-0">
                                <span className="text-sm text-foreground font-semibold truncate block">
                                  {m.teamAName} <span className="text-foreground/40 font-normal">vs</span> {m.teamBName}
                                </span>
                                {(m.teamAPlayers.length > 0 || m.teamBPlayers.length > 0) && (
                                  <span className="text-[0.6rem] text-muted-foreground truncate block">
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
                      <div className="px-4 py-3 bg-charcoal/40 border-t border-border">
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
          <div className="space-y-3">
            {filteredHistory.length === 0 ? (
              <div className="py-12 text-center text-xs text-muted-foreground">
                {searchQuery
                  ? `No completed matches found for "${searchQuery}".`
                  : "No completed matches yet."}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filteredHistory.map((m) => (
                  <div
                    key={m.id}
                    className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
                  >
                    <div className="flex items-center gap-3">
                      <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-border">
                        {m.court}
                      </span>
                      <div>
                        <span className="font-semibold text-sm text-foreground">
                          {m.teamAName} vs {m.teamBName}
                        </span>
                        {m.winnerTeam && (
                          <span className="block text-[0.65rem] text-pickle font-medium">
                            Winner: {m.winnerTeam}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-right">
                      <div className="font-display text-xl text-sand">
                        {m.score.teamAScore} - {m.score.teamBScore}
                      </div>
                      {m.officiatedBy && (
                        <span className="text-[0.65rem] text-muted-foreground uppercase tracking-wider">
                          Official: {m.officiatedBy}
                        </span>
                      )}
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
              <div className="flex items-center gap-1.5 px-4 py-2 bg-charcoal/40 border-b border-border overflow-x-auto scrollbar-thin">
                <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground mr-1 shrink-0">
                  Division:
                </span>
                {tournament.categories.map((c) => {
                  const isCurrent = c.id === bracketModalCategory;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setBracketModalCategory(c.id)}
                      className={`px-2.5 py-1 text-xs font-semibold tracking-wide border transition-colors shrink-0 cursor-pointer ${
                        isCurrent
                          ? "bg-pickle text-sand border-pickle"
                          : "bg-charcoal text-sand/70 border-border hover:border-sand/50"
                      }`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Bracket Tabs Strip */}
            <div className="flex items-center gap-2 p-3 bg-charcoal/20 border-b border-border overflow-x-auto scrollbar-thin">
              {bracketModalData.groups.length === 0 ? (
                <span className="text-xs text-muted-foreground italic px-2">
                  No brackets found for this division.
                </span>
              ) : (
                bracketModalData.groups.map((group) => {
                  const isActive = group.letter === bracketModalSelectedLetter;
                  const hasUnplayed = group.unplayedCount > 0;
                  return (
                    <button
                      key={group.letter}
                      onClick={() => setBracketModalSelectedLetter(group.letter)}
                      className={`px-3 py-1.5 text-xs font-display tracking-wider uppercase border transition-all flex items-center gap-2 shrink-0 cursor-pointer ${
                        isActive
                          ? "bg-pickle text-sand border-pickle shadow-sm"
                          : "bg-charcoal text-sand/80 border-border hover:border-sand/60"
                      }`}
                    >
                      <span>{group.label}</span>
                      <span
                        className={`px-1.5 py-0.2 text-[0.6rem] font-mono font-bold rounded-sm ${
                          isActive
                            ? "bg-sand text-charcoal"
                            : hasUnplayed
                            ? "bg-pickle/20 text-pickle"
                            : "bg-emerald-500/20 text-emerald-400"
                        }`}
                      >
                        {hasUnplayed ? `${group.unplayedCount} left` : "Done"}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

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

                const currentGroup =
                  bracketModalData.groups.find((g) => g.letter === bracketModalSelectedLetter) ||
                  bracketModalData.groups[0];

                if (!currentGroup) return null;

                const unplayed = currentGroup.matches.filter((m) => m.status !== "final");
                const completed = currentGroup.matches.filter((m) => m.status === "final");

                return (
                  <div className="space-y-4">
                    {/* Header info for selected bracket */}
                    <div className="flex items-center justify-between border-b border-border/60 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-display text-lg sm:text-xl text-foreground">
                          {currentGroup.label} Matches
                        </span>
                        <span className="text-xs text-muted-foreground">
                          ({unplayed.length} unplayed, {completed.length} completed)
                        </span>
                      </div>
                      <span className="text-[0.65rem] uppercase tracking-wider text-pickle font-bold">
                        Target: {selectedCourtForDispatch}
                      </span>
                    </div>

                    {/* Unplayed Games List */}
                    {unplayed.length === 0 ? (
                      <div className="p-6 text-center border border-border bg-charcoal/30 space-y-2">
                        <span className="text-xs uppercase tracking-widest text-emerald-400 font-bold block">
                          Bracket Completed
                        </span>
                        <p className="text-xs sm:text-sm text-foreground/80">
                          All pool play matches for {currentGroup.label} have concluded.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {unplayed.map((match, idx) => {
                          const restA = checkRestPeriodConflict(match.teamAName);
                          const restB = checkRestPeriodConflict(match.teamBName);
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
                          const isActionDisabled =
                            isMatchAlreadyOnThisCourt ||
                            isMatchAlreadyOnOtherCourt ||
                            isTeamPlayingElsewhere;

                          return (
                            <div
                              key={match.id}
                              className={`p-3.5 border transition-all flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${
                                isMatchAlreadyOnThisCourt
                                  ? "border-pickle/60 bg-pickle/5"
                                  : isActionDisabled
                                  ? "border-border/40 bg-card/40 opacity-75"
                                  : "border-border bg-card hover:border-pickle/60"
                              }`}
                            >
                              <div className="min-w-0 space-y-1.5 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono text-xs text-muted-foreground font-bold">
                                    #{idx + 1}
                                  </span>
                                  {match.status === "live" ? (
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
                                  <div className="min-w-0 p-2 bg-charcoal/30 border border-border/60 rounded-sm">
                                    <span className="font-bold text-sm text-foreground block truncate">
                                      {match.teamAName}
                                    </span>
                                    {match.teamAPlayers.length > 0 && (
                                      <span className="text-[0.65rem] text-muted-foreground block truncate">
                                        {match.teamAPlayers.join(" / ")}
                                      </span>
                                    )}
                                  </div>

                                  <div className="min-w-0 p-2 bg-charcoal/30 border border-border/60 rounded-sm">
                                    <span className="font-bold text-sm text-foreground block truncate">
                                      {match.teamBName}
                                    </span>
                                    {match.teamBPlayers.length > 0 && (
                                      <span className="text-[0.65rem] text-muted-foreground block truncate">
                                        {match.teamBPlayers.join(" / ")}
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {/* Conflict warnings */}
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

                              {/* Dispatch Action Button */}
                              <div className="shrink-0 sm:self-center">
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
                                  className={`w-full sm:w-auto px-4 py-2.5 text-xs font-bold uppercase tracking-wider border transition-all ${
                                    isActionDisabled
                                      ? "border-border/40 text-muted-foreground/40 bg-charcoal/20 cursor-not-allowed"
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
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Toggle Completed Games */}
                    {completed.length > 0 && (
                      <div className="pt-2 border-t border-border/60">
                        <button
                          onClick={() => setBracketModalShowCompleted((prev) => !prev)}
                          className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground font-bold cursor-pointer transition-colors"
                        >
                          {bracketModalShowCompleted ? "Hide Completed Games" : `Show Completed Games (${completed.length})`}
                        </button>

                        {bracketModalShowCompleted && (
                          <div className="mt-2.5 space-y-2">
                            {completed.map((cm) => (
                              <div
                                key={cm.id}
                                className="p-2.5 border border-border/60 bg-charcoal/20 flex items-center justify-between text-xs"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-foreground/80">
                                    {cm.teamAName} vs {cm.teamBName}
                                  </span>
                                  <span className="text-[0.65rem] text-muted-foreground">
                                    {cm.stage}
                                  </span>
                                </div>
                                <div className="font-mono text-sand font-bold">
                                  {cm.liveScore ? `${cm.liveScore.teamAScore} - ${cm.liveScore.teamBScore}` : "Final"}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
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
    </div>
  );
}
