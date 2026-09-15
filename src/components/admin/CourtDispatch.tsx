import { useState, useEffect, useMemo, useCallback } from "react";
import type { Tournament, Category } from "@/data/tournaments";
import {
  useMatchStore,
  type LiveMatch,
  scorePoint,
  sideOut,
  endGame,
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
} from "@/lib/court-dispatch";
import { getDrawnGroups } from "@/components/admin/BracketDraw";
import { getMainDrawMatches } from "@/components/admin/DrawsManager";

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

  // Sync stations, queue, and announcement with storage
  const reloadData = useCallback(() => {
    setStations(getCourtStations());
    setQueue(getDispatchQueue());
    setAnnouncement(getLatestAnnouncement());
    refreshMatches();
  }, [refreshMatches]);

  useEffect(() => {
    const handleStorage = () => reloadData();
    window.addEventListener("storage", handleStorage);
    const interval = setInterval(reloadData, 3000);
    return () => {
      window.removeEventListener("storage", handleStorage);
      clearInterval(interval);
    };
  }, [reloadData]);

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
      if (station.currentMatchId) {
        const found = matches.find((m) => m.id === station.currentMatchId);
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

  // Extract all unassigned matches from Pool Draws and Main Draw Playoffs
  const unassignedMatches = useMemo(() => {
    const poolGroups = getDrawnGroups(tournamentSlug, categoryId);
    const playoffMatches = getMainDrawMatches(tournamentSlug, categoryId);
    const queuedIds = new Set(queue.map((q) => q.matchId));
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

    // 1. From Pool Groups
    if (poolGroups) {
      for (const group of poolGroups) {
        const teams = group.slots
          .map((s) => s.team)
          .filter((t): t is { id: string; name: string; players: string[] } => t !== null);

        for (let i = 0; i < teams.length; i++) {
          for (let j = i + 1; j < teams.length; j++) {
            const teamA = teams[i]!;
            const teamB = teams[j]!;
            const matchId = `live-${tournamentSlug}-${categoryId}-${group.letter}-${i + 1}v${j + 1}`;
            const existingLive = matches.find((m) => m.id === matchId);

            // Skip if match is already completed, currently on court, or in queue
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

    // 2. From Playoff Knockout Matches
    if (playoffMatches) {
      for (const km of playoffMatches) {
        if (!km.teamA || !km.teamB) continue;
        const matchId = `live-ko-${tournamentSlug}-${categoryId}-${km.id}`;
        const existingLive = matches.find((m) => m.id === matchId);

        if (existingLive?.status === "final" || km.winner) continue;
        if (queuedIds.has(matchId) || activeCourtMatchIds.has(matchId)) continue;

        list.push({
          id: matchId,
          stage: `${km.round} - ${km.label}`,
          teamAName: km.teamA.name,
          teamAPlayers: km.teamA.players,
          teamBName: km.teamB.name,
          teamBPlayers: km.teamB.players,
        });
      }
    }

    return list;
  }, [tournamentSlug, categoryId, queue, stations, matches]);

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

  // Actions
  const handleDispatch = (court: FacilityCourt, match: { id: string; teamAName: string; teamAPlayers?: string[]; teamBName: string; teamBPlayers?: string[] }, umpire?: string) => {
    dispatchMatchToCourt(court, match, umpire);
    reloadData();
  };

  const handleAutoDispatch = (court: FacilityCourt) => {
    const dispatched = autoDispatchNext(court);
    if (dispatched) {
      reloadData();
    }
  };

  const handleAutoDispatchAllAvailable = () => {
    for (const c of FACILITY_COURTS) {
      if (stations[c].status === "available") {
        autoDispatchNext(c);
      }
    }
    reloadData();
  };

  const handleVacateCourt = (court: FacilityCourt) => {
    vacateCourt(court);
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
      status: "live",
      startedAt: m.startedAt ?? Date.now(),
    }));
    const nextStations = { ...stations };
    nextStations[court] = {
      ...nextStations[court],
      status: "live",
    };
    saveCourtStations(nextStations);
    reloadData();
  };

  const handleConcludeMatch = (court: FacilityCourt, matchId: string) => {
    updateMatchStore(matchId, (m) => endGame(m));
    const nextStations = { ...stations };
    nextStations[court] = {
      ...nextStations[court],
      status: "available",
      currentMatchId: null,
      dispatchedAt: null,
    };
    saveCourtStations(nextStations);
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

  const handleQueueUnassignedAll = () => {
    const items = unassignedMatches.map((m) => ({
      matchId: m.id,
      tournamentSlug,
      categoryId,
      stage: m.stage,
      teamAName: m.teamAName,
      teamAPlayers: m.teamAPlayers,
      teamBName: m.teamBName,
      teamBPlayers: m.teamBPlayers,
    }));
    addMatchesToQueue(items);
    reloadData();
  };

  const handleQueueSingle = (m: typeof unassignedMatches[number]) => {
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
              onChange={(e) => setCategoryId(e.target.value)}
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

            return (
              <div
                key={courtName}
                className={`surface-card p-0 overflow-hidden border flex flex-col justify-between transition-all ${
                  station.status === "live"
                    ? "border-pickle/80 shadow-md shadow-pickle/5 bg-card"
                    : station.status === "warmup"
                    ? "border-amber-500/80 bg-card"
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
                    {station.status === "live" && (
                      <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest bg-pickle/30 text-pickle border border-pickle/50 flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-ping" />
                        Live
                      </span>
                    )}
                    {station.status === "warmup" && (
                      <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest bg-amber-500/20 text-amber-300 border border-amber-500/40">
                        Warm-up
                      </span>
                    )}
                    {station.status === "available" && (
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

                  {/* Stopwatch / Duration */}
                  <div className="text-right font-mono text-xs">
                    {(station.status === "live" || station.status === "warmup") && (
                      <div className="flex items-center gap-1.5 text-sand">
                        <span className="text-[0.65rem] uppercase tracking-wider text-sand/60">Time:</span>
                        <span className="font-bold text-sm text-pickle">
                          {formatDuration(station.dispatchedAt ?? activeMatch?.startedAt)}
                        </span>
                      </div>
                    )}
                    {station.status === "available" && (
                      <span className="text-[0.65rem] uppercase tracking-widest text-emerald-400 font-semibold">
                        Ready
                      </span>
                    )}
                  </div>
                </div>

                {/* Court Body */}
                <div className="p-4 sm:p-5 flex-1 flex flex-col justify-between space-y-4">
                  {/* State 1: Active Match on Court (Live or Warm-up) */}
                  {(station.status === "live" || station.status === "warmup") && activeMatch ? (
                    <div className="space-y-4">
                      {/* Match metadata */}
                      <div className="flex items-center justify-between text-xs text-muted-foreground border-b border-border/50 pb-2">
                        <span className="font-medium uppercase tracking-wider text-foreground">
                          {activeMatch.court} Action
                        </span>
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
                          {station.status === "warmup" && (
                            <button
                              onClick={() => handleSetMatchLive(courtName, activeMatch.id)}
                              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer"
                            >
                              Start Play (Go Live)
                            </button>
                          )}
                          {station.status === "live" && (
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
                          Assign the next match from the priority queue or pick an unassigned match.
                        </p>
                      </div>

                      {/* Auto Dispatch Button */}
                      {nextInQueue ? (
                        <div className="p-3 bg-charcoal/40 border border-border text-left space-y-2 max-w-md mx-auto">
                          <div className="flex items-center justify-between text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                            <span>Next in Queue (#1)</span>
                            <span className="text-pickle font-bold">{nextInQueue.stage}</span>
                          </div>
                          <div className="font-semibold text-sm text-sand">
                            {nextInQueue.teamAName} vs {nextInQueue.teamBName}
                          </div>
                          <button
                            onClick={() => handleAutoDispatch(courtName)}
                            className="w-full mt-2 py-2 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer"
                          >
                            Dispatch {nextInQueue.teamAName} to {courtName}
                          </button>
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground italic">
                          Queue is currently empty. Add matches from the tab below.
                        </div>
                      )}

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

      {/* ── Match Queue & Dispatch Controls ── */}
      <div className="surface-card p-4 sm:p-6 border border-border space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-4">
          <div>
            <h3 className="font-display text-xl sm:text-2xl text-foreground">
              Match Queue &amp; Roster Dispatcher
            </h3>
            <p className="text-xs text-muted-foreground">
              Prioritize upcoming matches and assign directly to Courts 1–4.
            </p>
          </div>

          {/* Queue Tab buttons */}
          <div className="flex flex-wrap gap-1.5">
            {[
              { key: "queue", label: `Active Queue (${queue.filter((q) => q.status === "queued" || q.status === "on_deck").length})` },
              { key: "unassigned", label: `Unassigned Tournament (${unassignedMatches.length})` },
              { key: "history", label: `Court Log (${metrics.completedCount})` },
              { key: "custom", label: "+ Add Custom Match" },
            ].map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveQueueTab(t.key as typeof activeQueueTab)}
                className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider border transition-colors cursor-pointer ${
                  activeQueueTab === t.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-foreground hover:border-primary"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── TAB 1: ACTIVE QUEUE ── */}
        {activeQueueTab === "queue" && (
          <div className="space-y-4">
            {queue.filter((q) => q.status === "queued" || q.status === "on_deck").length === 0 ? (
              <div className="py-12 text-center space-y-3">
                <p className="text-sm text-muted-foreground">
                  The active dispatch queue is currently empty.
                </p>
                {unassignedMatches.length > 0 && (
                  <button
                    onClick={handleQueueUnassignedAll}
                    className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer"
                  >
                    Queue All {unassignedMatches.length} Remaining Tournament Matches
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                {queue
                  .filter((q) => q.status === "queued" || q.status === "on_deck")
                  .sort((a, b) => a.priority - b.priority)
                  .map((item, idx) => {
                    const restA = checkRestPeriodConflict(item.teamAName);
                    const restB = checkRestPeriodConflict(item.teamBName);
                    const liveA = checkSimultaneousPlayConflict(item.teamAName);
                    const liveB = checkSimultaneousPlayConflict(item.teamBName);

                    return (
                      <div
                        key={item.id}
                        className="surface-card p-3.5 border border-border flex flex-col md:flex-row md:items-center md:justify-between gap-3 bg-card hover:border-border/80 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-8 w-8 rounded bg-charcoal text-sand flex items-center justify-center font-display text-sm shrink-0 border border-border">
                            #{idx + 1}
                          </div>

                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-foreground text-sm truncate">
                                {item.teamAName} vs {item.teamBName}
                              </span>
                              <span className="px-1.5 py-0.5 text-[0.6rem] uppercase tracking-wider bg-charcoal text-sand/80 border border-border">
                                {item.stage}
                              </span>
                              {item.assignedCourt && (
                                <span className="px-1.5 py-0.5 text-[0.6rem] uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40">
                                  Designated {item.assignedCourt}
                                </span>
                              )}
                            </div>

                            {/* Warnings */}
                            <div className="flex flex-wrap gap-2 mt-1">
                              {(restA || restB) && (
                                <span className="text-[0.65rem] text-amber-400 font-medium">
                                  Rest Warning: {(restA ?? restB)?.teamName} finished {(restA ?? restB)?.minutesAgo}m ago
                                </span>
                              )}
                              {(liveA || liveB) && (
                                <span className="text-[0.65rem] text-brick font-bold">
                                  Conflict: {(liveA ?? liveB)?.teamName} is live on {(liveA ?? liveB)?.court}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Controls: Move priority + Dispatch to Court 1-4 */}
                        <div className="flex flex-wrap items-center gap-1.5 shrink-0 self-end md:self-auto">
                          {/* Priority reordering */}
                          <div className="flex items-center gap-1 mr-2 border-r border-border/50 pr-2">
                            <button
                              onClick={() => {
                                reorderQueue(item.matchId, "up");
                                reloadData();
                              }}
                              disabled={idx === 0}
                              className="px-2 py-1 text-[0.65rem] font-bold bg-charcoal text-sand border border-border hover:border-sand disabled:opacity-30 cursor-pointer"
                              title="Move Up"
                            >
                              Up
                            </button>
                            <button
                              onClick={() => {
                                reorderQueue(item.matchId, "down");
                                reloadData();
                              }}
                              className="px-2 py-1 text-[0.65rem] font-bold bg-charcoal text-sand border border-border hover:border-sand cursor-pointer"
                              title="Move Down"
                            >
                              Down
                            </button>
                          </div>

                          {/* Quick dispatch buttons for 4 courts */}
                          {FACILITY_COURTS.map((c) => {
                            const isCourtOccupied = stations[c].status === "live" || stations[c].status === "warmup" || stations[c].status === "maintenance";
                            return (
                              <button
                                key={c}
                                onClick={() => handleDispatch(c, {
                                  id: item.matchId,
                                  teamAName: item.teamAName,
                                  teamAPlayers: item.teamAPlayers,
                                  teamBName: item.teamBName,
                                  teamBPlayers: item.teamBPlayers,
                                })}
                                disabled={isCourtOccupied}
                                className={`px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider border transition-colors cursor-pointer ${
                                  isCourtOccupied
                                    ? "border-border/40 text-muted-foreground/40 cursor-not-allowed"
                                    : "border-pickle/60 text-pickle hover:bg-pickle hover:text-sand"
                                }`}
                                title={isCourtOccupied ? `${c} is currently occupied` : `Dispatch immediately to ${c}`}
                              >
                                &rarr; {c}
                              </button>
                            );
                          })}

                          {/* Designate on-deck */}
                          <select
                            value={item.assignedCourt ?? ""}
                            onChange={(e) => {
                              const val = e.target.value as FacilityCourt | "";
                              setCourtOnDeck(val ? val : "Court 1", val ? item.matchId : null);
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

                          {/* Remove */}
                          <button
                            onClick={() => {
                              removeQueueItem(item.matchId);
                              reloadData();
                            }}
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

        {/* ── TAB 2: UNASSIGNED TOURNAMENT MATCHES ── */}
        {activeQueueTab === "unassigned" && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border/50 pb-3">
              <span className="text-xs text-muted-foreground">
                Matches from Round-Robin Brackets and Main Draw Playoffs ready to enter the queue.
              </span>
              {unassignedMatches.length > 0 && (
                <button
                  onClick={handleQueueUnassignedAll}
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-colors cursor-pointer"
                >
                  Queue All ({unassignedMatches.length})
                </button>
              )}
            </div>

            {unassignedMatches.length === 0 ? (
              <div className="py-12 text-center text-xs text-muted-foreground">
                All tournament matches are currently queued, on court, or completed!
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {unassignedMatches.map((m) => (
                  <div
                    key={m.id}
                    className="p-3 bg-card border border-border rounded flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <span className="text-[0.65rem] uppercase tracking-wider text-pickle font-semibold block truncate">
                        {m.stage}
                      </span>
                      <span className="font-semibold text-foreground text-sm block truncate">
                        {m.teamAName} vs {m.teamBName}
                      </span>
                    </div>

                    <button
                      onClick={() => handleQueueSingle(m)}
                      className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-pickle hover:text-pickle transition-colors shrink-0 cursor-pointer"
                    >
                      + Add to Queue
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── TAB 3: COURT MATCH HISTORY / COMPLETED ── */}
        {activeQueueTab === "history" && (
          <div className="space-y-3">
            {matches.filter((m) => m.status === "final").length === 0 ? (
              <div className="py-12 text-center text-xs text-muted-foreground">
                No completed matches yet.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {matches
                  .filter((m) => m.status === "final")
                  .map((m) => (
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
    </div>
  );
}
