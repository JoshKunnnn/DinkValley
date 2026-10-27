import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { X, Trophy, AlertTriangle, Lock, LayoutList, Columns, LayoutGrid } from "lucide-react";
import { UmpireMobileNav } from "@/components/admin/UmpireMobileNav";

import {
  useMatchStore,
  getMatches,
  saveMatches,
  scorePoint,
  sideOut,
  endGame,
  undoLastRally,
  resetMatch,
  isMatchMatchingStation,
  getLocalMatchMutationAt,
  type LiveMatch,
} from "@/lib/match-store";
import {
  FACILITY_COURTS,
  type FacilityCourt,
  type CourtStation,
  getCourtStations,
  claimCourtStation,
  releaseCourtStation,
  vacateCourt,
  completeQueueMatch,
  dispatchMatchToCourt,
  hydrateCourtStationsFromCloud,
  playDeskChime,
  isConfirmedDispatchedMatch,
  findMatchForCourtStation,
} from "@/lib/court-dispatch";
import { useTournamentStore, getTournaments } from "@/lib/tournament-store";
import { dbUpdateCourtStation, dbSubscribeToLive } from "@/lib/supabase-service";
import { DispatchDebugStation } from "@/components/admin/DispatchDebugStation";
import { syncMainDrawWithLiveMatches } from "@/components/admin/DrawsManager";

export const Route = createFileRoute("/umpire")({
  beforeLoad: () => {
    if (typeof localStorage !== "undefined") {
      const isAuthenticated =
        localStorage.getItem("mock_umpire_auth") === "true" ||
        localStorage.getItem("mock_auth") === "true";
      if (!isAuthenticated) {
        throw redirect({ to: "/login" });
      }
    }
  },
  head: () => ({
    meta: [
      { title: "Umpire Console | Dink Valley" },
      {
        name: "description",
        content: "Live match scoring and officiating console for Dink Valley umpires.",
      },
    ],
  }),
  component: Umpire,
});

type UmpireTab = "console" | "results" | "scoreboard" | "desk";

function Umpire() {
  const navigate = useNavigate();
  const { tournaments } = useTournamentStore();

  // Active tournaments (strictly exclude completed tournaments)
  const activeTournaments = useMemo(() => {
    return tournaments.filter((t) => t.status !== "Completed");
  }, [tournaments]);

  // Primary active tournament: Live status takes priority, then Registration open
  const defaultTournament = useMemo(() => {
    return (
      tournaments.find((t) => t.status === "Live") ||
      tournaments.find((t) => t.status === "Registration open") ||
      activeTournaments[0] ||
      tournaments[0] ||
      null
    );
  }, [tournaments, activeTournaments]);

  const [tournamentFilter, setTournamentFilter] = useState<string>(() => defaultTournament?.slug ?? "");

  useEffect(() => {
    if (!tournamentFilter && defaultTournament?.slug) {
      setTournamentFilter(defaultTournament.slug);
    }
  }, [defaultTournament, tournamentFilter]);

  const activeTournamentSlug = tournamentFilter || defaultTournament?.slug || "";
  const activeTournament = tournaments.find((t) => t.slug === activeTournamentSlug) || defaultTournament;

  const { matches, update, refresh, refreshFromCloud, isCloudSynced } = useMatchStore(
    activeTournamentSlug || undefined
  );

  const [activeTab, setActiveTab] = useState<UmpireTab>("console");
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const selectedMatchIdRef = useRef<string | null>(selectedMatchId);
  useEffect(() => {
    selectedMatchIdRef.current = selectedMatchId;
  }, [selectedMatchId]);
  const [umpireName, setUmpireName] = useState("Official");
  const [stations, setStations] = useState<Record<FacilityCourt, CourtStation>>(() => getCourtStations());
  const [isDebugOpen, setIsDebugOpen] = useState(false);
  const [dispatchNotice, setDispatchNotice] = useState<{
    court: string;
    matchId: string;
    teamAName: string;
    teamBName: string;
    stage?: string | undefined;
  } | null>(null);

  // Filter matches strictly to the active event, but NEVER drop matches actively occupying a facility court
  const activeEventMatches = useMemo(() => {
    const activeCourtMatchIds = new Set<string>();
    for (const c of FACILITY_COURTS) {
      const st = stations[c];
      if (st?.currentMatchId) activeCourtMatchIds.add(st.currentMatchId);
      if (st?.onDeckMatchId) activeCourtMatchIds.add(st.onDeckMatchId);
    }

    return matches.filter((m) => {
      // 1. Retain any match whose ID directly matches an active or on-deck station
      if (activeCourtMatchIds.has(m.id)) return true;

      // 2. Retain any match that matches an active court station by team names / pair ID
      for (const c of FACILITY_COURTS) {
        const st = stations[c];
        if (st?.currentMatchId && isMatchMatchingStation(m, st.currentMatchId, c)) {
          return true;
        }
      }

      // 3. Retain any match assigned to a facility court (Courts 1–4)
      if (
        m.court &&
        m.court !== "Queue" &&
        (FACILITY_COURTS as readonly string[]).includes(m.court as FacilityCourt) &&
        (m.status === "live" || m.status === "scheduled")
      ) {
        return true;
      }

      // 4. Default to tournament slug match
      if (!activeTournamentSlug) return true;
      if (m.tournamentSlug) {
        return m.tournamentSlug === activeTournamentSlug;
      }
      return true;
    });
  }, [matches, activeTournamentSlug, stations]);

  // Load umpire identity
  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      setUmpireName(localStorage.getItem("mock_umpire_name") ?? "Official");
    }
  }, []);

  // Hydrate court stations from Supabase on mount and keep updated
  useEffect(() => {
    let mounted = true;

    // Initial hydration
    hydrateCourtStationsFromCloud().then((hydrated) => {
      if (mounted) setStations(hydrated);
    });
    refreshFromCloud();

    const safeRefreshFromCloud = () => {
      const activeId = selectedMatchIdRef.current;
      if (activeId && Date.now() - getLocalMatchMutationAt(activeId) < 5000) {
        return;
      }
      refreshFromCloud();
    };

    const reloadStations = () => {
      setStations(getCourtStations());
      refresh();
      safeRefreshFromCloud();
    };

    const handleRemoteDispatch = (e: Event) => {
      const customEvent = e as CustomEvent<{
        court: string;
        matchId: string;
        teamAName: string;
        teamBName: string;
        stage?: string;
        umpire?: string;
        match?: LiveMatch;
      }>;
      const detail = customEvent.detail;
      if (!detail) return;

      // 1. Immediately inject the self-contained match payload into local storage for 0ms zero-latency rendering
      if (detail.match) {
        try {
          const localMatches = getMatches();
          const existingIdx = localMatches.findIndex(
            (m) => m.id === detail.matchId || isMatchMatchingStation(m, detail.matchId, detail.court)
          );
          if (existingIdx !== -1) {
            localMatches[existingIdx] = {
              ...localMatches[existingIdx],
              ...detail.match,
              court: detail.court,
              status: detail.match.status || "scheduled",
            };
          } else {
            localMatches.push({
              ...detail.match,
              court: detail.court,
              status: detail.match.status || "scheduled",
            });
          }
          saveMatches(localMatches, false);
          refresh();
        } catch {
          // ignore
        }
      }

      // 2. Immediately pull fresh stations from cloud
      hydrateCourtStationsFromCloud().then((cloud) => {
        if (mounted) setStations(cloud);
      });
      // 3. Confirm with fresh matches from cloud
      safeRefreshFromCloud();
      setTimeout(() => {
        if (mounted) {
          hydrateCourtStationsFromCloud().then((cloud) => {
            if (mounted) setStations(cloud);
          });
          safeRefreshFromCloud();
        }
      }, 1200);

      // Play audio chime and haptic feedback
      try {
        playDeskChime();
      } catch { }

      if (typeof navigator !== "undefined" && navigator.vibrate) {
        try {
          navigator.vibrate([150, 75, 150]);
        } catch { }
      }

      setDispatchNotice({
        court: detail.court,
        matchId: detail.matchId,
        teamAName: detail.teamAName,
        teamBName: detail.teamBName,
        stage: detail.stage,
      });

      // Auto-dismiss notification after 10 seconds
      setTimeout(() => {
        if (mounted) setDispatchNotice((curr) => (curr?.matchId === detail.matchId ? null : curr));
      }, 10000);
    };

    window.addEventListener("storage", reloadStations);
    window.addEventListener("dv_matches_updated", reloadStations);
    window.addEventListener("dv_court_stations_updated", reloadStations);
    window.addEventListener("dv_remote_match_dispatched", handleRemoteDispatch);

    const unsubRealtime = dbSubscribeToLive(
      () => {
        // Realtime notification when matches table changes in Supabase
        refresh();
        safeRefreshFromCloud();
      },
      () => {
        // Realtime notification when court_stations table changes in Supabase
        hydrateCourtStationsFromCloud().then((cloud) => {
          if (mounted) setStations(cloud);
        });
        safeRefreshFromCloud();
      }
    );

    const interval = setInterval(() => {
      hydrateCourtStationsFromCloud().then((cloud) => {
        if (mounted) setStations(cloud);
      });
    }, 4000);

    return () => {
      mounted = false;
      unsubRealtime();
      window.removeEventListener("storage", reloadStations);
      window.removeEventListener("dv_matches_updated", reloadStations);
      window.removeEventListener("dv_court_stations_updated", reloadStations);
      window.removeEventListener("dv_remote_match_dispatched", handleRemoteDispatch);
      clearInterval(interval);
    };
  }, [umpireName, refresh, refreshFromCloud]);

  const handleLogout = () => {
    localStorage.removeItem("mock_umpire_auth");
    localStorage.removeItem("mock_umpire_name");
    navigate({ to: "/login" });
  };

  const openConsole = (matchId: string) => {
    setSelectedMatchId(matchId);
    setActiveTab("console");
  };

  const selectedMatch = useMemo(() => {
    if (!selectedMatchId) return null;
    return (
      activeEventMatches.find((m) => m.id === selectedMatchId) ??
      matches.find((m) => m.id === selectedMatchId) ??
      activeEventMatches.find((m) => isMatchMatchingStation(m, selectedMatchId)) ??
      matches.find((m) => isMatchMatchingStation(m, selectedMatchId)) ??
      null
    );
  }, [selectedMatchId, activeEventMatches, matches]);

  // Auto-switch umpire console when current court receives a newly dispatched match
  useEffect(() => {
    if (!selectedMatch) return;
    const court = selectedMatch.court as FacilityCourt;
    if (!court || !(FACILITY_COURTS as readonly string[]).includes(court)) return;
    const st = stations[court];
    if (st && (st.status === "live" || st.status === "warmup") && st.currentMatchId) {
      if (st.currentMatchId !== selectedMatch.id && (selectedMatch.status === "final" || Boolean(selectedMatch.winnerTeam))) {
        setSelectedMatchId(st.currentMatchId);
      }
    }
  }, [stations, selectedMatch]);

  const tabs: { key: UmpireTab; label: string }[] = [
    { key: "console", label: "Court Supervision" },
    { key: "results", label: "Match Results" },
  ];

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background pb-20 sm:pb-0">
      {/* Top bar (Hidden on mobile when actively scoring a match to maximize court visibility) */}
      <div className={`${selectedMatch ? "hidden sm:block" : "block"} sm:sticky sm:top-16 z-30 border-b border-border bg-charcoal/95 backdrop-blur`}>
        <div className="mx-auto max-w-6xl px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Umpire Profile & Connection Indicator */}
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-9 w-9 rounded-full bg-pickle/20 border border-pickle/40 flex items-center justify-center flex-shrink-0">
                <span className="font-display text-sm text-pickle">
                  {umpireName.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="block text-[0.6rem] uppercase tracking-[0.28em] text-pickle font-bold">
                    Official Console
                  </span>
                  {/* Realtime Supabase Connection Badge */}
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-wider rounded border ${isCloudSynced
                      ? "bg-pickle/20 border-pickle/40 text-pickle"
                      : "bg-amber-500/20 border-amber-500/40 text-amber-300"
                      }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${isCloudSynced ? "bg-pickle animate-pulse" : "bg-amber-400"
                        }`}
                    />
                    {isCloudSynced ? "Cloud Connected" : "Local Sync"}
                  </span>
                </div>
                <span className="block text-sm font-semibold text-sand truncate">
                  {umpireName}
                </span>
              </div>
            </div>

            {/* Active Tournament Badge / Selector & Sign Out */}
            <div className="flex flex-wrap items-center gap-2">
              {activeTournaments.length > 1 ? (
                <select
                  value={tournamentFilter}
                  onChange={(e) => setTournamentFilter(e.target.value)}
                  className="bg-charcoal border border-border text-sand text-xs font-semibold px-2.5 py-1.5 rounded-none focus:outline-none focus:border-pickle cursor-pointer"
                >
                  {activeTournaments.map((t) => (
                    <option key={t.slug} value={t.slug}>
                      {t.name} {t.status === "Live" ? "(Live)" : ""}
                    </option>
                  ))}
                </select>
              ) : activeTournament ? (
                <div className="bg-charcoal border border-border text-sand text-xs font-semibold px-2.5 py-1.5 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
                  <span className="truncate max-w-[200px] sm:max-w-none">{activeTournament.name}</span>
                </div>
              ) : null}

              <button
                onClick={() => setIsDebugOpen(true)}
                title="Open score sync telemetry and dispatch debug station"
                className="px-2.5 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest bg-charcoal border border-pickle/40 text-pickle hover:bg-pickle/20 transition-colors cursor-pointer flex items-center gap-1"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
                <span>Score Sync Debug</span>
              </button>

              <button
                onClick={handleLogout}
                className="px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest bg-brick/20 border border-brick/40 text-brick hover:bg-brick/30 transition-colors cursor-pointer"
              >
                Sign Out
              </button>
            </div>
          </div>

          {/* Tab navigation */}
          <div className="mt-3 flex gap-1 overflow-x-auto -mb-px">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`whitespace-nowrap px-4 py-2.5 text-xs font-bold uppercase tracking-widest transition-all border-b-2 cursor-pointer ${activeTab === tab.key
                  ? "border-pickle text-pickle"
                  : "border-transparent text-sand/70 hover:text-sand"
                  }`}
              >
                {tab.label}
                {tab.key === "console" && selectedMatch && (
                  <span className="ml-1.5 font-mono text-[0.65rem] px-1.5 py-0.2 bg-pickle/20 text-pickle border border-pickle/40">
                    {selectedMatch.court}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Realtime Match Dispatch Notification Banner */}
      {dispatchNotice && (
        <div className="bg-pickle text-sand border-b-2 border-charcoal px-4 py-2.5 shadow-lg flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="font-mono text-xs px-2 py-0.5 bg-charcoal text-pickle font-bold uppercase tracking-wider shrink-0">
              {dispatchNotice.court}
            </span>
            <div className="min-w-0">
              <span className="text-xs font-bold text-sand block truncate">
                Match Dispatched: {dispatchNotice.teamAName} vs {dispatchNotice.teamBName}
              </span>
              {dispatchNotice.stage && (
                <span className="text-[0.65rem] text-sand/80 block uppercase tracking-wider font-semibold">
                  {dispatchNotice.stage}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
            <button
              type="button"
              onClick={() => {
                setSelectedMatchId(dispatchNotice.matchId);
                setActiveTab("console");
                setDispatchNotice(null);
              }}
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-charcoal text-pickle border border-charcoal hover:bg-charcoal/90 transition-colors cursor-pointer"
            >
              Open Match
            </button>
            <button
              type="button"
              onClick={() => setDispatchNotice(null)}
              className="p-1.5 text-sand hover:text-sand/70 transition-colors cursor-pointer"
              title="Dismiss notification"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="mx-auto max-w-6xl px-2 sm:px-4 py-2 sm:py-6">
        {activeTab === "console" && (
          <UmpireConsole
            match={selectedMatch}
            matches={activeEventMatches}
            stations={stations}
            currentUmpire={umpireName}
            activeTournament={activeTournament}
            onUpdate={update}
            onSelectMatch={(id) => setSelectedMatchId(id || null)}
            onBack={() => setSelectedMatchId(null)}
            onViewResults={() => setActiveTab("results")}
            onOpenDebug={() => setIsDebugOpen(true)}
          />
        )}
        {activeTab === "results" && (
          <UmpireMatchResults
            matches={activeEventMatches}
            activeTournament={activeTournament}
            onSelectMatch={openConsole}
          />
        )}
      </div>



      {/* ── Mobile bottom nav (sm and below only) ── */}
      <UmpireMobileNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        selectedMatchCourt={selectedMatch?.court ?? null}
        onLogout={handleLogout}
      />

      {/* Dispatch Telemetry & Debug Station */}
      <DispatchDebugStation
        isOpen={isDebugOpen}
        onClose={() => setIsDebugOpen(false)}
        tournamentSlug={activeTournamentSlug}
        initialTab="score_sync"
        onStateRepaired={() => {
          setStations(getCourtStations());
        }}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════
   TAB 1: TOURNAMENT DESK & COURT STATIONS
═══════════════════════════════════════════════ */

function TournamentDesk({
  matches,
  stations,
  currentUmpire,
  onSelectMatch,
  onClaimCourt,
  onReleaseCourt,
  onOpenQuickMatch,
  onUpdate,
}: {
  matches: LiveMatch[];
  stations: Record<FacilityCourt, CourtStation>;
  currentUmpire: string;
  onSelectMatch: (id: string) => void;
  onClaimCourt: (court: FacilityCourt) => void;
  onReleaseCourt: (court: FacilityCourt) => void;
  onOpenQuickMatch: (court?: FacilityCourt) => void;
  onUpdate: (matchId: string, updater: (m: LiveMatch) => LiveMatch) => void;
}) {
  const [courtFilter, setCourtFilter] = useState<string>("all");
  const [bracketFilter, setBracketFilter] = useState<string>("all");
  const [matchToReset, setMatchToReset] = useState<LiveMatch | null>(null);

  const handleDeskResetToss = (m: LiveMatch) => {
    const hasPoints =
      m.score.teamAScore > 0 ||
      m.score.teamBScore > 0 ||
      (m.score.rallies && m.score.rallies.length > 0) ||
      m.status === "final";

    if (hasPoints) {
      setMatchToReset(m);
    } else {
      executeDeskResetToss(m);
    }
  };

  const executeDeskResetToss = (m: LiveMatch) => {
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(`dv_toss_done_${m.id}`);
      } catch {
        // ignore
      }
    }
    onUpdate(m.id, resetMatch);
    onSelectMatch(m.id);
    setMatchToReset(null);
  };

  const confirmedMatches = useMemo(() => {
    return matches.filter((m) => isConfirmedDispatchedMatch(m, stations));
  }, [matches, stations]);

  const liveCount = confirmedMatches.filter((m) => m.status === "live").length;
  const finalCount = confirmedMatches.filter((m) => m.status === "final").length;
  const scheduledCount = confirmedMatches.filter((m) => m.status === "scheduled").length;

  const uniqueStages = useMemo(() => {
    const set = new Set<string>();
    confirmedMatches.forEach((m) => {
      if (m.stage) set.add(m.stage);
    });
    return Array.from(set);
  }, [confirmedMatches]);

  const displayedMatches = confirmedMatches.filter((m) => {
    if (courtFilter !== "all" && m.court !== courtFilter) return false;
    if (bracketFilter !== "all" && m.stage !== bracketFilter) return false;
    return true;
  });

  const handleQuickDispatchToCourt = (targetCourt: FacilityCourt, match: LiveMatch) => {
    dispatchMatchToCourt(targetCourt, match, currentUmpire, false);
    onSelectMatch(match.id);
  };

  return (
    <div className="space-y-8">
      {/* Overview & Quick Stats */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-5">
        <div>
          <span className="text-xs font-bold uppercase tracking-[0.28em] text-pickle">
            Tournament Desk
          </span>
          <h2 className="font-display text-3xl sm:text-4xl text-foreground mt-1">
            Facility Court Stations
          </h2>
          <p className="text-sm text-foreground/80 mt-1">
            Monitor real-time court statuses, claim your station, or launch a live match.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <StatBadge label="Live" value={liveCount} color="pickle" pulse={liveCount > 0} />
          <StatBadge label="Scheduled" value={scheduledCount} color="sand" />
          <StatBadge label="Final" value={finalCount} color="brick" />
        </div>
      </div>

      {/* 4 Facility Court Stations (Courts 1–4) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-widest text-foreground font-mono">
            Active Court Grid (1 - 4)
          </span>
          <button
            onClick={() => playDeskChime()}
            className="text-[0.65rem] font-bold uppercase tracking-wider text-sand/80 hover:text-sand transition-colors border border-border px-2 py-1 bg-charcoal cursor-pointer"
          >
            Test Chime
          </button>
        </div>

        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {FACILITY_COURTS.map((court) => {
            const st = stations[court] ?? {
              court,
              status: "available",
              currentMatchId: null,
              assignedUmpire: null,
            };

            // Find match occupying this station
            const courtMatch = findMatchForCourtStation(court, st, matches);

            const operatingOfficial = courtMatch?.officiatedBy || (st.status === "live" || st.status === "warmup" ? st.assignedUmpire : null);
            const isAssignedToMe = Boolean(courtMatch?.officiatedBy === currentUmpire || (!courtMatch?.officiatedBy && st.assignedUmpire === currentUmpire));
            const isOperatedByOther = Boolean(
              courtMatch &&
              courtMatch.status !== "final" &&
              operatingOfficial &&
              operatingOfficial !== currentUmpire
            );

            return (
              <div
                key={court}
                className={`surface-card p-0 overflow-hidden border flex flex-col justify-between transition-all ${isOperatedByOther
                    ? "border-brick/50 bg-charcoal text-sand"
                    : courtMatch?.status === "live"
                      ? "border-pickle/70 shadow-md shadow-pickle/10"
                      : st.status === "maintenance"
                        ? "border-brick/50 bg-brick/5"
                        : "border-border hover:border-foreground/40"
                  }`}
              >
                {/* Court Card Header */}
                <div className="bg-charcoal px-3.5 py-2.5 flex items-center justify-between border-b border-border/60">
                  <span className="text-xs font-bold uppercase tracking-wider text-sand font-mono">
                    {court}
                  </span>
                  <CourtStatusBadge status={st.status} isLiveMatch={courtMatch?.status === "live"} />
                </div>

                {/* Court Content */}
                <div className="p-3.5 space-y-3 flex-1 flex flex-col justify-between">
                  {courtMatch ? (
                    <div className="space-y-2">
                      {courtMatch.stage && (
                        <span className="inline-block text-[0.6rem] font-bold uppercase tracking-wider text-pickle font-mono truncate max-w-full">
                          {courtMatch.stage}
                        </span>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-foreground truncate mr-2">
                          {courtMatch.teamAName}
                        </span>
                        <span className="font-display text-lg text-foreground">
                          {courtMatch.score.teamAScore}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-foreground truncate mr-2">
                          {courtMatch.teamBName}
                        </span>
                        <span className="font-display text-lg text-foreground">
                          {courtMatch.score.teamBScore}
                        </span>
                      </div>

                      {courtMatch.status === "live" && (
                        <div className="pt-1.5 border-t border-border/50 text-[0.65rem] uppercase tracking-wider text-pickle font-bold">
                          Serving: {courtMatch.score.servingTeam === "A" ? courtMatch.teamAName : courtMatch.teamBName} (#{courtMatch.score.serverNumber})
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="py-4 text-center">
                      <span className="text-xs text-foreground/50 font-medium block">
                        Court Open
                      </span>
                      <span className="text-[0.65rem] text-foreground/40 block mt-0.5">
                        No active match
                      </span>
                    </div>
                  )}

                  {/* Official & Actions */}
                  <div className="pt-3 border-t border-border/60 space-y-2">
                    <div className="flex items-center justify-between text-[0.65rem]">
                      <span className="text-foreground/70 font-semibold uppercase tracking-wider">
                        Official:
                      </span>
                      <span
                        className={`font-mono truncate max-w-[120px] ${isAssignedToMe
                          ? "text-pickle font-bold"
                          : st.assignedUmpire
                            ? "text-foreground font-semibold"
                            : "text-foreground/40 italic"
                          }`}
                      >
                        {isAssignedToMe
                          ? `${currentUmpire} (You)`
                          : st.assignedUmpire ?? "Unassigned"}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 pt-1">
                      {courtMatch ? (
                        isOperatedByOther ? (
                          <div className="flex items-center gap-1.5 w-full py-2 px-2.5 bg-brick/10 border border-brick/40 text-brick text-[0.65rem] font-bold uppercase tracking-wider justify-center">
                            <Lock size={12} />
                            <span>In Use: {operatingOfficial}</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 w-full flex-1">
                            <button
                              onClick={() => onSelectMatch(courtMatch.id)}
                              className="flex-1 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest bg-pickle text-sand hover:opacity-90 transition-opacity text-center cursor-pointer truncate"
                            >
                              {isMatchTossDone(courtMatch) ? "Score Match" : "Start Coin Toss"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeskResetToss(courtMatch)}
                              title="Reset match score to 0-0 and rerun coin toss"
                              className="px-2 py-1.5 text-[0.6rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-pickle/50 hover:bg-pickle hover:text-sand transition-colors cursor-pointer whitespace-nowrap"
                            >
                              Toss (Reset)
                            </button>
                          </div>
                        )
                      ) : (
                        <button
                          onClick={() => onOpenQuickMatch(court)}
                          className="flex-1 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest border border-border text-foreground hover:border-pickle hover:text-pickle transition-colors text-center cursor-pointer"
                        >
                          + Dispatch
                        </button>
                      )}

                      {!isOperatedByOther && (
                        isAssignedToMe ? (
                          <button
                            onClick={() => onReleaseCourt(court)}
                            title="Release court claim"
                            className="px-2 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand/70 border border-border hover:text-brick hover:border-brick transition-colors cursor-pointer"
                          >
                            Release
                          </button>
                        ) : (
                          <button
                            onClick={() => onClaimCourt(court)}
                            title="Claim this station"
                            className="px-2 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
                          >
                            Claim
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Match Cards Section */}
      <div className="space-y-4 pt-4 border-t border-border">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="font-display text-2xl text-foreground">
              All Assigned Matches
            </h3>
            <p className="text-xs text-foreground/70 mt-0.5">
              Select any match below to enter the live officiating and scoring console.
            </p>
          </div>

          {/* Court & Bracket Filters */}
          <div className="flex flex-wrap items-center gap-2">
            {uniqueStages.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 border border-border p-1 bg-charcoal">
                <button
                  type="button"
                  onClick={() => setBracketFilter("all")}
                  className={`px-2 py-1 text-[0.65rem] font-bold uppercase tracking-wider transition-colors cursor-pointer ${bracketFilter === "all" ? "bg-pickle text-sand" : "text-sand/70 hover:text-sand"
                    }`}
                >
                  All Brackets
                </button>
                {uniqueStages.map((stg) => (
                  <button
                    key={stg}
                    type="button"
                    onClick={() => setBracketFilter(stg)}
                    className={`px-2 py-1 text-[0.65rem] font-bold uppercase tracking-wider transition-colors cursor-pointer ${bracketFilter === stg ? "bg-pickle text-sand" : "text-sand/70 hover:text-sand"
                      }`}
                  >
                    {stg.replace(" (Pool Play)", "")}
                  </button>
                ))}
              </div>
            )}

            {/* Court Filter Tabs */}
            <div className="flex flex-wrap items-center gap-1 border border-border p-1 bg-charcoal">
              {["all", "Court 1", "Court 2", "Court 3", "Court 4"].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCourtFilter(c)}
                  className={`px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider transition-colors cursor-pointer ${courtFilter === c
                    ? "bg-pickle text-sand"
                    : "text-sand/70 hover:text-sand"
                    }`}
                >
                  {c === "all" ? "All Courts" : c}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Match Cards Grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {displayedMatches.map((match) => (
            <button
              key={match.id}
              onClick={() => onSelectMatch(match.id)}
              className={`surface-card p-0 overflow-hidden text-left transition-all hover:scale-[1.01] active:scale-[0.99] border cursor-pointer ${match.status === "live"
                ? "border-pickle/60 shadow-lg shadow-pickle/10"
                : match.status === "final"
                  ? "border-brick/40"
                  : "border-border hover:border-foreground/40"
                }`}
            >
              {/* Card Header */}
              <div className="bg-charcoal px-4 py-2.5 flex items-center justify-between border-b border-border/50">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-bold uppercase tracking-widest text-sand font-mono">
                    {match.court}
                  </span>
                  {match.stage && (
                    <span className="text-[0.6rem] font-bold uppercase tracking-wider text-pickle font-mono bg-pickle/15 px-1.5 py-0.5 border border-pickle/30 truncate">
                      {match.stage}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {!isMatchTossDone(match) && match.status !== "final" && (
                    <span className="text-[0.55rem] font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40 px-1.5 py-0.5">
                      Toss Required
                    </span>
                  )}
                  <MatchStatusBadge status={match.status} />
                </div>
              </div>

              {/* Teams & Score */}
              <div className="p-4 space-y-3">
                {/* Team A */}
                <div className="flex items-center justify-between">
                  <div className="min-w-0 mr-3">
                    <span
                      className={`block text-sm font-semibold truncate ${match.winnerTeam === match.teamAName
                        ? "text-pickle"
                        : "text-foreground"
                        }`}
                    >
                      {match.teamAName}
                    </span>
                    <span className="block text-[0.7rem] text-foreground/80 font-medium truncate">
                      {match.teamAPlayers.join(" / ")}
                    </span>
                  </div>
                  <span
                    className={`font-display text-2xl ${match.status !== "scheduled" ? "text-foreground" : "text-foreground/50"
                      }`}
                  >
                    {match.score.teamAScore}
                  </span>
                </div>

                <div className="h-px bg-border" />

                {/* Team B */}
                <div className="flex items-center justify-between">
                  <div className="min-w-0 mr-3">
                    <span
                      className={`block text-sm font-semibold truncate ${match.winnerTeam === match.teamBName
                        ? "text-pickle"
                        : "text-foreground"
                        }`}
                    >
                      {match.teamBName}
                    </span>
                    <span className="block text-[0.7rem] text-foreground/80 font-medium truncate">
                      {match.teamBPlayers.join(" / ")}
                    </span>
                  </div>
                  <span
                    className={`font-display text-2xl ${match.status !== "scheduled" ? "text-foreground" : "text-foreground/50"
                      }`}
                  >
                    {match.score.teamBScore}
                  </span>
                </div>

                {/* Serving indicator for live matches */}
                {match.status === "live" && (
                  <div className="pt-2 border-t border-border/60 text-[0.65rem] uppercase tracking-widest text-pickle font-bold">
                    Serving: {match.score.servingTeam === "A" ? match.teamAName : match.teamBName} (#{match.score.serverNumber})
                  </div>
                )}

                {/* Winner for final matches */}
                {match.status === "final" && match.winnerTeam && (
                  <div className="pt-2 border-t border-border/60 text-[0.65rem] uppercase tracking-widest text-pickle font-bold">
                    Winner: {match.winnerTeam}
                  </div>
                )}

                {/* Official assignment */}
                <div className="pt-2 border-t border-border/60 flex items-center justify-between text-[0.65rem] uppercase tracking-widest">
                  <span className="text-foreground/70 font-semibold">Official:</span>
                  <span
                    className={`font-mono ${match.officiatedBy ? "text-pickle font-bold" : "text-foreground/50"
                      }`}
                  >
                    {match.officiatedBy
                      ? match.officiatedBy === currentUmpire
                        ? `${match.officiatedBy} (You)`
                        : match.officiatedBy
                      : "Unassigned"}
                  </span>
                </div>

                {/* Reset & Toss Coin Action */}
                <div
                  className="pt-2 border-t border-border/60 flex items-center justify-between gap-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeskResetToss(match);
                    }}
                    title="Reset match score to 0-0 and rerun coin toss"
                    className="px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-pickle/40 hover:bg-pickle hover:text-sand transition-colors cursor-pointer inline-flex items-center gap-1.5"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-pickle" />
                    Coin Toss (Reset)
                  </button>
                  <span className="text-[0.6rem] font-mono text-foreground/60 uppercase">
                    {match.court}
                  </span>
                </div>

                {/* Quick Dispatch to Facility Courts for Queued Matches */}
                {match.court === "Queue" && match.status === "scheduled" && (
                  <div
                    className="pt-2.5 border-t border-border/60 flex items-center justify-between gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/70">
                      Send to:
                    </span>
                    <div className="flex items-center gap-1">
                      {FACILITY_COURTS.map((fc) => (
                        <button
                          key={fc}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleQuickDispatchToCourt(fc, match);
                          }}
                          className="px-2 py-0.5 text-[0.6rem] font-bold uppercase bg-charcoal text-sand/80 hover:bg-pickle hover:text-sand border border-border transition-colors cursor-pointer"
                        >
                          {fc.replace("Court ", "C")}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>

        {displayedMatches.length === 0 && (
          <div className="surface-card p-12 text-center border border-dashed border-border">
            <h3 className="font-display text-2xl text-foreground">
              {courtFilter === "all" ? "No Confirmed Dispatched Matches" : `No Matches on ${courtFilter}`}
            </h3>
            <p className="text-sm text-foreground/80 mt-2">
              Matches dispatched by admin in Court Dispatch or created via Quick Match will appear here.
            </p>
            <button
              onClick={() => onOpenQuickMatch(courtFilter !== "all" ? (courtFilter as FacilityCourt) : undefined)}
              className="mt-4 px-4 py-2 bg-pickle text-sand text-xs font-bold uppercase tracking-widest hover:opacity-90 transition-opacity cursor-pointer"
            >
              + Create Match Here
            </button>
          </div>
        )}
      </div>

      {/* Desk Reset Confirmation Modal */}
      {matchToReset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/90 backdrop-blur-sm p-4">
          <div className="surface-card border-2 border-pickle/60 max-w-sm w-full p-6 space-y-4">
            <div>
              <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-pickle block">
                Pre-Match Reset
              </span>
              <h3 className="font-display text-2xl text-foreground mt-1">
                Reset Match & Toss Coin?
              </h3>
            </div>
            <p className="text-sm text-foreground/80">
              This will reset the score to 0-0 for <strong>{matchToReset.teamAName}</strong> vs <strong>{matchToReset.teamBName}</strong>, clear all recorded rallies, and launch the pre-match coin toss.
            </p>
            <div className="flex gap-3 justify-end pt-2">
              <button
                type="button"
                onClick={() => setMatchToReset(null)}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest border border-border text-foreground hover:border-foreground/50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => executeDeskResetToss(matchToReset)}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer"
              >
                Reset & Toss Coin
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   TAB 2: UMPIRE CONSOLE (LIVE SCORING)
═══════════════════════════════════════════════ */

export function isMatchTossDone(match: LiveMatch | null | undefined): boolean {
  if (!match) return true;
  if (match.status === "final") return true;
  if (match.tossDone) return true;
  if (match.score.rallies && match.score.rallies.length > 0) return true;
  if (match.score.teamAScore > 0 || match.score.teamBScore > 0) return true;
  if (typeof localStorage !== "undefined") {
    try {
      if (localStorage.getItem(`dv_toss_done_${match.id}`) === "true") return true;
    } catch {
      // ignore
    }
  }
  return false;
}

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

export function computeCourtPositions(
  match: LiveMatch
): { teamA: TeamCourtPositions; teamB: TeamCourtPositions } {
  const s = match.score;
  const isFinal = match.status === "final";

  // Team A
  const rawAPlayers =
    match.teamAPlayers && match.teamAPlayers.length > 0
      ? match.teamAPlayers
      : [match.teamAName || "Player A1"];
  const isSinglesA = rawAPlayers.length === 1;
  const localBase1A =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(`dv_base1_A_${match.id}`)
      : null;
  const aBase1 =
    match.teamABase1Player ||
    (localBase1A && rawAPlayers.includes(localBase1A) ? localBase1A : rawAPlayers[0]) ||
    "Player A1";
  const aBase2 =
    rawAPlayers.find((p) => p !== aBase1) || rawAPlayers[1] || aBase1;
  const teamAScoreEven = s.teamAScore % 2 === 0;

  // Team B
  const rawBPlayers =
    match.teamBPlayers && match.teamBPlayers.length > 0
      ? match.teamBPlayers
      : [match.teamBName || "Player B1"];
  const isSinglesB = rawBPlayers.length === 1;
  const localBase1B =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(`dv_base1_B_${match.id}`)
      : null;
  const bBase1 =
    match.teamBBase1Player ||
    (localBase1B && rawBPlayers.includes(localBase1B) ? localBase1B : rawBPlayers[0]) ||
    "Player B1";
  const bBase2 =
    rawBPlayers.find((p) => p !== bBase1) || rawBPlayers[1] || bBase1;
  const teamBScoreEven = s.teamBScore % 2 === 0;

  // Serving court (Right if serving team score is even, Left if odd)
  const servingCourt: "right" | "left" =
    s.servingTeam === "A"
      ? teamAScoreEven
        ? "right"
        : "left"
      : teamBScoreEven
        ? "right"
        : "left";

  if (isSinglesA && isSinglesB) {
    const aOnRight = teamAScoreEven;
    const bOnRight = teamBScoreEven;
    return {
      teamA: {
        isSingles: true,
        right: {
          name: aOnRight ? aBase1 : "-",
          base: 1,
          isServing: !isFinal && s.servingTeam === "A" && aOnRight,
          isReceiver: !isFinal && s.servingTeam === "B" && servingCourt === "right",
        },
        left: {
          name: !aOnRight ? aBase1 : "-",
          base: 1,
          isServing: !isFinal && s.servingTeam === "A" && !aOnRight,
          isReceiver: !isFinal && s.servingTeam === "B" && servingCourt === "left",
        },
      },
      teamB: {
        isSingles: true,
        right: {
          name: bOnRight ? bBase1 : "-",
          base: 1,
          isServing: !isFinal && s.servingTeam === "B" && bOnRight,
          isReceiver: !isFinal && s.servingTeam === "A" && servingCourt === "right",
        },
        left: {
          name: !bOnRight ? bBase1 : "-",
          base: 1,
          isServing: !isFinal && s.servingTeam === "B" && !bOnRight,
          isReceiver: !isFinal && s.servingTeam === "A" && servingCourt === "left",
        },
      },
    };
  }

  // Doubles positioning:
  // When score is even: Base 1 is on Right (Even) court, Base 2 on Left (Odd) court.
  // When score is odd: Base 2 is on Right (Even) court, Base 1 on Left (Odd) court.
  const aRightPlayerName = teamAScoreEven ? aBase1 : aBase2;
  const aRightBase: 1 | 2 = teamAScoreEven ? 1 : 2;
  const aLeftPlayerName = teamAScoreEven ? aBase2 : aBase1;
  const aLeftBase: 1 | 2 = teamAScoreEven ? 2 : 1;

  const bRightPlayerName = teamBScoreEven ? bBase1 : bBase2;
  const bRightBase: 1 | 2 = teamBScoreEven ? 1 : 2;
  const bLeftPlayerName = teamBScoreEven ? bBase2 : bBase1;
  const bLeftBase: 1 | 2 = teamBScoreEven ? 2 : 1;

  return {
    teamA: {
      isSingles: false,
      right: {
        name: aRightPlayerName,
        base: aRightBase,
        isServing: !isFinal && s.servingTeam === "A" && servingCourt === "right",
        isReceiver: !isFinal && s.servingTeam === "B" && servingCourt === "right",
      },
      left: {
        name: aLeftPlayerName,
        base: aLeftBase,
        isServing: !isFinal && s.servingTeam === "A" && servingCourt === "left",
        isReceiver: !isFinal && s.servingTeam === "B" && servingCourt === "left",
      },
    },
    teamB: {
      isSingles: false,
      right: {
        name: bRightPlayerName,
        base: bRightBase,
        isServing: !isFinal && s.servingTeam === "B" && servingCourt === "right",
        isReceiver: !isFinal && s.servingTeam === "A" && servingCourt === "right",
      },
      left: {
        name: bLeftPlayerName,
        base: bLeftBase,
        isServing: !isFinal && s.servingTeam === "B" && servingCourt === "left",
        isReceiver: !isFinal && s.servingTeam === "A" && servingCourt === "left",
      },
    },
  };
}

type CourtTeamPosition = NonNullable<ReturnType<typeof computeCourtPositions>>["teamA"];

interface CourtDiagramViewProps {
  match: LiveMatch;
  teamAPos: CourtTeamPosition;
  teamBPos: CourtTeamPosition;
  teamASide?: "left" | "right";
  onToggleSide?: () => void;
  onChangeCourt?: () => void;
  onSwapBaseA?: () => void;
  onSwapBaseB?: () => void;
  disabled?: boolean;
}

function CourtDiagramView({
  match,
  teamAPos,
  teamBPos,
  teamASide = "left",
  onToggleSide,
  onChangeCourt,
  onSwapBaseA,
  onSwapBaseB,
  disabled = false,
}: CourtDiagramViewProps) {
  if (!teamAPos || !teamBPos) return null;

  const s = match.score;
  const isFinal = match.status === "final";

  // Identify server and receiver
  let serverInfo: {
    team: string;
    teamLetter: "A" | "B";
    name: string;
    court: "Right court" | "Left court";
    serverNum: number;
    base: 1 | 2;
  } | null = null;

  let receiverInfo: {
    team: string;
    teamLetter: "A" | "B";
    name: string;
    court: "Right court" | "Left court";
    base: 1 | 2;
  } | null = null;

  if (teamAPos.right.isServing) {
    serverInfo = {
      team: match.teamAName,
      teamLetter: "A",
      name: teamAPos.right.name,
      court: "Right court",
      serverNum: s.serverNumber,
      base: teamAPos.right.base,
    };
  } else if (teamAPos.left.isServing) {
    serverInfo = {
      team: match.teamAName,
      teamLetter: "A",
      name: teamAPos.left.name,
      court: "Left court",
      serverNum: s.serverNumber,
      base: teamAPos.left.base,
    };
  } else if (teamBPos.right.isServing) {
    serverInfo = {
      team: match.teamBName,
      teamLetter: "B",
      name: teamBPos.right.name,
      court: "Right court",
      serverNum: s.serverNumber,
      base: teamBPos.right.base,
    };
  } else if (teamBPos.left.isServing) {
    serverInfo = {
      team: match.teamBName,
      teamLetter: "B",
      name: teamBPos.left.name,
      court: "Left court",
      serverNum: s.serverNumber,
      base: teamBPos.left.base,
    };
  }

  if (teamAPos.right.isReceiver) {
    receiverInfo = {
      team: match.teamAName,
      teamLetter: "A",
      name: teamAPos.right.name,
      court: "Right court",
      base: teamAPos.right.base,
    };
  } else if (teamAPos.left.isReceiver) {
    receiverInfo = {
      team: match.teamAName,
      teamLetter: "A",
      name: teamAPos.left.name,
      court: "Left court",
      base: teamAPos.left.base,
    };
  } else if (teamBPos.right.isReceiver) {
    receiverInfo = {
      team: match.teamBName,
      teamLetter: "B",
      name: teamBPos.right.name,
      court: "Right court",
      base: teamBPos.right.base,
    };
  } else if (teamBPos.left.isReceiver) {
    receiverInfo = {
      team: match.teamBName,
      teamLetter: "B",
      name: teamBPos.left.name,
      court: "Left court",
      base: teamBPos.left.base,
    };
  }

  // Determine physical sides of the court
  const leftTeam = teamASide === "right" ? "B" : "A";
  const rightTeam = teamASide === "right" ? "A" : "B";
  const leftPos = leftTeam === "A" ? teamAPos : teamBPos;
  const rightPos = rightTeam === "A" ? teamAPos : teamBPos;
  const leftName = leftTeam === "A" ? match.teamAName : match.teamBName;
  const rightName = rightTeam === "A" ? match.teamAName : match.teamBName;
  const onSwapBaseLeft = leftTeam === "A" ? onSwapBaseA : onSwapBaseB;
  const onSwapBaseRight = rightTeam === "A" ? onSwapBaseA : onSwapBaseB;

  // Helper to render player chip
  const renderPlayerChip = (
    player: { name: string; base: 1 | 2; isServing: boolean; isReceiver: boolean },
    teamLetter: "A" | "B"
  ) => {
    if (!player.name || player.name === "-") {
      return (
        <span className="text-[0.65rem] sm:text-xs font-mono text-sand/40 italic select-none">
          (Empty)
        </span>
      );
    }

    const isServing = player.isServing;
    const isReceiver = player.isReceiver;

    return (
      <div
        key={`${player.name}-${player.base}-${player.isServing ? "srv" : "nosrv"}`}
        className={`relative inline-flex items-center gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-full font-bold text-xs sm:text-sm max-w-[95%] transition-all duration-300 animate-in fade-in zoom-in-95 ${isReceiver
            ? "border-2 border-dashed border-amber-300 ring-2 ring-amber-400/40 text-sand shadow-md"
            : isServing
              ? "ring-2 ring-sand/80 shadow-md text-sand"
              : "text-sand border border-sand/30"
          } ${teamLetter === "A" ? "bg-pickle" : "bg-brick"}`}
        title={`${player.name} (Base ${player.base})`}
      >
        {/* Ball marker on active server */}
        {isServing && (
          <span
            className="w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full bg-sand text-charcoal flex items-center justify-center flex-shrink-0 shadow-xs border border-charcoal/30"
            title="Active Server"
          >
            <span className="w-2 h-2 rounded-full bg-pickle inline-block" />
          </span>
        )}

        <span className="truncate max-w-[75px] sm:max-w-[120px]">
          {player.name}
        </span>

        {/* Base number tag */}
        <span
          className="text-[0.55rem] sm:text-[0.6rem] font-mono font-black px-1.5 py-0.2 rounded bg-charcoal/80 text-sand/90 border border-sand/20 flex-shrink-0"
          title={`Base ${player.base}`}
        >
          B{player.base}
        </span>
      </div>
    );
  };

  return (
    <div className="surface-card p-0 overflow-hidden border-2 border-pickle/50 rounded-lg shadow-sm">
      {/* Top Banner: Server, Receiver & Quick Court/Side Controls */}
      {!isFinal && (
        <div className="bg-card px-2.5 sm:px-4 py-1.5 sm:py-2 border-b-2 border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 text-xs">
          {/* Status Badges */}
          <div className="grid grid-cols-2 gap-1.5 flex-1">
            {/* Server Badge */}
            {serverInfo ? (
              <div className="flex items-center justify-between gap-1 bg-pickle/15 border border-pickle/40 px-2 py-1 rounded min-w-0">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="px-1 py-0.2 text-[0.55rem] sm:text-[0.6rem] font-mono font-bold uppercase tracking-wider bg-pickle text-sand rounded flex-shrink-0">
                    Srv
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full bg-pickle inline-block flex-shrink-0" />
                  <span className="font-bold text-foreground text-xs sm:text-sm truncate">
                    {serverInfo.name}
                  </span>
                </div>
                <span className="text-[0.6rem] sm:text-xs font-mono font-semibold text-muted-foreground whitespace-nowrap flex-shrink-0">
                  #{serverInfo.serverNum}
                </span>
              </div>
            ) : (
              <div />
            )}

            {/* Receiver Badge */}
            {receiverInfo ? (
              <div className="flex items-center justify-between gap-1 bg-muted/40 border border-border px-2 py-1 rounded min-w-0">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="px-1 py-0.2 text-[0.55rem] sm:text-[0.6rem] font-mono font-bold uppercase tracking-wider bg-charcoal text-sand rounded border border-border flex-shrink-0">
                    Rec
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full border border-dashed border-amber-400 inline-block flex-shrink-0" />
                  <span className="font-bold text-foreground text-xs sm:text-sm truncate">
                    {receiverInfo.name}
                  </span>
                </div>
                <span className="text-[0.6rem] sm:text-xs font-mono font-semibold text-muted-foreground whitespace-nowrap flex-shrink-0">
                  {receiverInfo.court.split(" ")[0]}
                </span>
              </div>
            ) : (
              <div />
            )}
          </div>

          {/* Quick Court & Side Buttons */}
          <div className="flex items-center justify-end gap-1.5 flex-shrink-0 pt-0.5 sm:pt-0">
            {onToggleSide && !isFinal && (
              <button
                type="button"
                onClick={onToggleSide}
                disabled={disabled}
                className="inline-flex items-center gap-1 px-2 py-1 text-[0.6rem] font-mono font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-pickle hover:text-pickle rounded cursor-pointer transition-colors shadow-xs"
                title="Change court sides for players (Switch Ends)"
              >
                <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24">
                  <path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z" />
                </svg>
                <span>Change Side</span>
              </button>
            )}
            {onChangeCourt && (
              <button
                type="button"
                onClick={onChangeCourt}
                className="inline-flex items-center gap-1 px-2 py-1 text-[0.6rem] font-mono font-bold uppercase tracking-wider bg-charcoal text-sand border border-border hover:border-pickle hover:text-pickle rounded cursor-pointer transition-colors shadow-xs"
                title="Relocate match to another facility court"
              >
                <span>Change Court</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 2D Pickleball Court Canvas */}
      <div className="p-2.5 sm:p-4 bg-charcoal">
        <div className="relative w-full h-44 sm:h-56 bg-[#12281c] border-2 border-sand/50 rounded overflow-hidden flex">
          {/* LEFT HALF (Current Left Team) */}
          <div className="w-1/2 h-full flex border-r-2 border-sand">
            {/* Service Boxes (Left court on top, Right court on bottom) */}
            <div className="w-[64%] h-full flex flex-col border-r border-sand/40">
              {/* Left Court (Top, Odd) */}
              <div className="relative h-1/2 w-full border-b border-sand/40 flex items-center justify-center p-1 bg-[#152e20]/90">
                <span className="absolute top-1 left-1.5 text-[0.65rem] font-mono font-black text-sand/40 select-none">
                  L
                </span>
                {renderPlayerChip(leftPos.left, leftTeam)}
              </div>

              {/* Right Court (Bottom, Even) */}
              <div className="relative h-1/2 w-full flex items-center justify-center p-1 bg-[#152e20]/90">
                <span className="absolute bottom-1 left-1.5 text-[0.65rem] font-mono font-black text-sand/40 select-none">
                  R
                </span>
                {renderPlayerChip(leftPos.right, leftTeam)}
              </div>
            </div>

            {/* Non-Volley Zone / Kitchen */}
            <div className="w-[36%] h-full bg-[#1b4332] relative flex flex-col items-center justify-center select-none">
              <span className="text-[0.55rem] sm:text-[0.6rem] font-mono font-bold uppercase tracking-widest text-sand/40 [writing-mode:vertical-lr] rotate-180">
                Kitchen (NVZ)
              </span>
            </div>
          </div>

          {/* RIGHT HALF (Current Right Team) */}
          <div className="w-1/2 h-full flex">
            {/* Non-Volley Zone / Kitchen */}
            <div className="w-[36%] h-full bg-[#1b4332] border-r border-sand/40 relative flex flex-col items-center justify-center select-none">
              <span className="text-[0.55rem] sm:text-[0.6rem] font-mono font-bold uppercase tracking-widest text-sand/40 [writing-mode:vertical-lr]">
                Kitchen (NVZ)
              </span>
            </div>

            {/* Service Boxes (Right court on top, Left court on bottom) */}
            <div className="w-[64%] h-full flex flex-col">
              {/* Right Court (Top, Even) */}
              <div className="relative h-1/2 w-full border-b border-sand/40 flex items-center justify-center p-1 bg-[#152e20]/90">
                <span className="absolute top-1 right-1.5 text-[0.65rem] font-mono font-black text-sand/40 select-none">
                  R
                </span>
                {renderPlayerChip(rightPos.right, rightTeam)}
              </div>

              {/* Left Court (Bottom, Odd) */}
              <div className="relative h-1/2 w-full flex items-center justify-center p-1 bg-[#152e20]/90">
                <span className="absolute bottom-1 right-1.5 text-[0.65rem] font-mono font-black text-sand/40 select-none">
                  L
                </span>
                {renderPlayerChip(rightPos.left, rightTeam)}
              </div>
            </div>
          </div>

          {/* NET DIVIDER (Center) */}
          <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-1.5 bg-sand flex flex-col justify-between items-center pointer-events-none z-10 shadow-xs">
            <span className="w-2.5 h-2.5 rounded-full bg-charcoal border border-sand -mt-1" />
            <span className="w-2.5 h-2.5 rounded-full bg-charcoal border border-sand -mb-1" />
          </div>
        </div>

        {/* BOTTOM BAR: Team Names, Umpire "YOU" Position Indicator & Change Sides */}
        <div className="mt-3 flex items-center justify-between text-xs gap-2">
          {/* Left Team Details & Swap Base */}
          <div className="flex-1 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 min-w-0">
            <span className="font-bold text-sand text-xs sm:text-sm truncate" title={leftName}>
              {leftName}
            </span>
            {!leftPos.isSingles && !isFinal && onSwapBaseLeft && (
              <button
                type="button"
                onClick={onSwapBaseLeft}
                disabled={disabled}
                className="text-[0.6rem] font-mono font-bold uppercase tracking-wider text-sand/80 hover:text-pickle border border-border/70 hover:border-pickle px-2 py-0.5 rounded cursor-pointer transition-colors w-fit bg-card/60"
                title={`Swap Base 1 & 2 for ${leftName}`}
              >
                Swap Base
              </button>
            )}
          </div>

          {/* Center: Umpire Perspective Marker "YOU" & Side Toggle */}
          <div className="flex flex-col items-center flex-shrink-0">
            <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-charcoal border-2 border-sand text-sand font-mono text-[0.65rem] sm:text-xs font-black tracking-widest uppercase shadow-md">
              <span className="w-1.5 h-1.5 rounded-full bg-pickle animate-ping" />
              YOU
            </span>
            <span className="text-[0.55rem] font-mono font-semibold text-sand/60 tracking-wider uppercase mt-0.5">
              Net Chair
            </span>
          </div>

          {/* Right Team Details & Swap Base */}
          <div className="flex-1 flex flex-col sm:flex-row sm:items-center justify-end gap-1 sm:gap-2 text-right min-w-0">
            {!rightPos.isSingles && !isFinal && onSwapBaseRight && (
              <button
                type="button"
                onClick={onSwapBaseRight}
                disabled={disabled}
                className="text-[0.6rem] font-mono font-bold uppercase tracking-wider text-sand/80 hover:text-pickle border border-border/70 hover:border-pickle px-2 py-0.5 rounded cursor-pointer transition-colors w-fit bg-card/60 self-end sm:self-auto"
                title={`Swap Base 1 & 2 for ${rightName}`}
              >
                Swap Base
              </button>
            )}
            <span className="font-bold text-sand text-xs sm:text-sm truncate" title={rightName}>
              {rightName}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function UmpireConsole({
  match,
  matches,
  stations,
  currentUmpire,
  activeTournament,
  onUpdate,
  onSelectMatch,
  onBack,
  onOpenQuickMatch,
  onViewResults,
  onOpenDebug,
}: {
  match: LiveMatch | null;
  matches: LiveMatch[];
  stations?: Record<FacilityCourt, CourtStation>;
  currentUmpire: string;
  activeTournament?: any;
  onUpdate: (matchId: string, updater: (m: LiveMatch) => LiveMatch) => void;
  onSelectMatch: (id: string) => void;
  onBack?: () => void;
  onOpenQuickMatch?: () => void;
  onViewResults?: () => void;
  onOpenDebug?: () => void;
}) {
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [showResetTossConfirm, setShowResetTossConfirm] = useState(false);
  const [showToss, setShowToss] = useState(() => (match ? !isMatchTossDone(match) : false));
  const [tossDone, setTossDone] = useState(() => (match ? isMatchTossDone(match) : false));
  const [tossServingTeam, setTossServingTeam] = useState<"A" | "B" | null>(() => match?.score?.servingTeam ?? null);

  // 60-second Timeout State
  const [timeoutActive, setTimeoutActive] = useState(false);
  const [timeoutTeam, setTimeoutTeam] = useState<"A" | "B" | null>(null);
  const [timeoutSeconds, setTimeoutSeconds] = useState(60);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Court player positions and Base tracking
  const positions = useMemo(() => (match ? computeCourtPositions(match) : null), [match]);
  const teamAPos = positions?.teamA;
  const teamBPos = positions?.teamB;

  // Physical court sides for players: "left" means Team A is on the left, "right" means Team A is on the right
  const [teamASide, setTeamASide] = useState<"left" | "right">(() => {
    if (typeof localStorage !== "undefined" && match) {
      const saved = localStorage.getItem(`dv_court_side_${match.id}`);
      if (saved === "right" || saved === "left") return saved;
    }
    return "left";
  });

  const [showChangeCourtModal, setShowChangeCourtModal] = useState(false);
  const [showCourtSideModal, setShowCourtSideModal] = useState(false);

  // View mode for court selection: "grid-2x2" (default: all 4 courts on 1 mobile screen), "horizontal-rows", or "horizontal-cards"
  const [courtViewLayout, setCourtViewLayout] = useState<"grid-2x2" | "horizontal-rows" | "horizontal-cards">(() => {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem("dv_umpire_court_layout");
      if (saved === "grid-2x2" || saved === "horizontal-rows" || saved === "horizontal-cards") return saved;
    }
    return "grid-2x2";
  });

  const handleSetCourtViewLayout = (mode: "grid-2x2" | "horizontal-rows" | "horizontal-cards") => {
    setCourtViewLayout(mode);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem("dv_umpire_court_layout", mode);
      } catch {
        // ignore
      }
    }
  };

  const handleToggleCourtSides = () => {
    setTeamASide((prev) => {
      const next = prev === "left" ? "right" : "left";
      if (typeof localStorage !== "undefined" && match) {
        try {
          localStorage.setItem(`dv_court_side_${match.id}`, next);
        } catch {
          // ignore
        }
      }
      return next;
    });
  };

  const handleRequestResetToss = () => {
    if (!match) return;
    const hasPoints =
      match.score.teamAScore > 0 ||
      match.score.teamBScore > 0 ||
      (match.score.rallies && match.score.rallies.length > 0) ||
      match.status === "final";

    if (hasPoints) {
      setShowResetTossConfirm(true);
    } else {
      executeResetToss();
    }
  };

  const executeResetToss = () => {
    if (!match) return;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(`dv_toss_done_${match.id}`);
      } catch {
        // ignore
      }
    }
    onUpdate(match.id, resetMatch);
    setTossDone(false);
    setTossServingTeam(null);
    setShowToss(true);
    setShowResetTossConfirm(false);
  };

  // Auto-initiate toss coin when match changes or opens if toss has not been completed
  useEffect(() => {
    if (match) {
      const alreadyDone = isMatchTossDone(match);
      setTossDone(alreadyDone);
      setShowToss(!alreadyDone);
      setTossServingTeam(match.score.servingTeam);
    } else {
      setShowToss(false);
      setTossDone(false);
      setTossServingTeam(null);
    }
    if (timerRef.current) clearInterval(timerRef.current);
    setTimeoutActive(false);
    setTimeoutSeconds(60);
    setTimeoutTeam(null);
  }, [match?.id]);

  // Timeout Countdown Effect
  useEffect(() => {
    if (!timeoutActive) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    timerRef.current = setInterval(() => {
      setTimeoutSeconds((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          setTimeoutActive(false);
          playDeskChime();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [timeoutActive]);

  const handleStartTimeout = (team: "A" | "B") => {
    setTimeoutTeam(team);
    setTimeoutSeconds(60);
    setTimeoutActive(true);
  };

  const handleCancelTimeout = () => {
    setTimeoutActive(false);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  // Filter for officially dispatched matches (active on court stations or live on facility courts)
  const currentStations = stations ?? getCourtStations();
  const dispatchedStationMatchIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of FACILITY_COURTS) {
      const st = currentStations[c];
      if (st?.currentMatchId) {
        ids.add(st.currentMatchId);
      }
      if (st?.onDeckMatchId) {
        ids.add(st.onDeckMatchId);
      }
    }
    return ids;
  }, [currentStations]);

  const isDispatchedMatch = useCallback(
    (m: LiveMatch) => {
      if (m.status === "final") return false;
      // 1. Actively assigned to a court station (exact ID or matchup)
      if (dispatchedStationMatchIds.has(m.id)) return true;
      for (const c of FACILITY_COURTS) {
        const st = currentStations[c];
        if (st?.currentMatchId && isMatchMatchingStation(m, st.currentMatchId, c)) {
          return true;
        }
      }
      // 2. Or is live or scheduled on an active facility court
      if (
        (m.status === "live" || m.status === "scheduled") &&
        m.court &&
        m.court !== "Queue" &&
        (FACILITY_COURTS as readonly string[]).includes(m.court as FacilityCourt)
      ) {
        return true;
      }
      return false;
    },
    [dispatchedStationMatchIds, currentStations],
  );

  const dispatchedMatches = useMemo(
    () => matches.filter(isDispatchedMatch),
    [matches, isDispatchedMatch],
  );

  const matchOperatingOfficial =
    match?.officiatedBy ||
    (match?.court && currentStations[match.court as FacilityCourt]?.assignedUmpire);
  const isOperatedByOther = Boolean(
    match &&
    match.status !== "final" &&
    matchOperatingOfficial &&
    matchOperatingOfficial !== currentUmpire
  );

  // Auto-assign umpire identity upon entering unassigned match
  useEffect(() => {
    if (match && !match.officiatedBy && match.status !== "final" && !isOperatedByOther) {
      onUpdate(match.id, (m) => ({
        ...m,
        officiatedBy: currentUmpire,
      }));
      if (match.court && (FACILITY_COURTS as readonly string[]).includes(match.court as FacilityCourt)) {
        dbUpdateCourtStation(match.court as FacilityCourt, {
          currentMatchId: match.id,
          assignedUmpire: currentUmpire,
        }).catch(() => { });
        claimCourtStation(match.court as FacilityCourt, currentUmpire);
      }
    }
  }, [match?.id, match?.officiatedBy, match?.status, isOperatedByOther, currentUmpire]);

  if (!match) {
    // Completed matches strictly for active event
    const completedMatches = matches
      .filter((m) => m.status === "final")
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

    return (
      <div className="space-y-4 sm:space-y-6 max-w-6xl mx-auto">
        {/* Header - Compact on mobile to maximize viewport for all 4 courts */}
        <div className="border-b border-border pb-3 sm:pb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[0.68rem] font-bold uppercase tracking-[0.28em] text-pickle">
                Official Console
              </span>
              {activeTournament && (
                <span className="inline-flex sm:hidden items-center gap-1.5 px-2 py-0.5 bg-charcoal border border-border text-[0.62rem] text-sand/80 font-mono">
                  <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
                  <strong className="text-sand truncate max-w-[140px]">{activeTournament.name}</strong>
                </span>
              )}
            </div>
            <h2 className="font-display text-2xl sm:text-4xl text-foreground mt-0.5 sm:mt-1">
              Select Your Court
            </h2>
            <p className="text-xs sm:text-sm text-foreground/80 mt-1 hidden sm:block">
              Choose the court you are supervising. Matches are dispatched exclusively by the Tournament Director.
            </p>
          </div>
          {activeTournament && (
            <div className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 bg-charcoal border border-border text-xs text-sand/80 font-mono w-fit">
              <span className="h-2 w-2 rounded-full bg-pickle animate-pulse" />
              <span>Active Event: <strong className="text-sand">{activeTournament.name}</strong></span>
            </div>
          )}
        </div>

        {/* Facility Courts Section with All-on-One-Screen Support */}
        <div className="space-y-2.5 sm:space-y-3">
          {/* Section Sub-header & View Mode Toggle */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <span className="text-xs font-bold uppercase tracking-widest text-foreground/80 block">
                Facility Courts (1 - 4)
              </span>
              <span className="text-[0.68rem] font-bold text-foreground/60 uppercase font-sans">
                Admin Dispatched Station Monitor
              </span>
            </div>

            {/* Layout Switcher (2x2 Screen, Rows, Swipe) */}
            <div className="flex items-center gap-1 self-start sm:self-auto bg-card border-2 border-border p-1">
              <span className="text-[0.62rem] font-bold uppercase tracking-wider text-foreground/60 px-1 font-mono hidden xs:inline">
                View:
              </span>
              <button
                type="button"
                onClick={() => handleSetCourtViewLayout("grid-2x2")}
                className={`flex items-center gap-1 px-2 py-1 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer font-sans ${
                  courtViewLayout === "grid-2x2"
                    ? "bg-pickle text-sand shadow-sm"
                    : "text-foreground/70 hover:text-foreground hover:bg-muted/40"
                }`}
                title="View all 4 courts on 1 mobile screen in a 2x2 grid"
              >
                <LayoutGrid size={13} />
                <span>2x2 Screen</span>
              </button>
              <button
                type="button"
                onClick={() => handleSetCourtViewLayout("horizontal-rows")}
                className={`flex items-center gap-1 px-2 py-1 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer font-sans ${
                  courtViewLayout === "horizontal-rows"
                    ? "bg-pickle text-sand shadow-sm"
                    : "text-foreground/70 hover:text-foreground hover:bg-muted/40"
                }`}
                title="View courts as wide horizontal compact rows"
              >
                <LayoutList size={13} />
                <span>Rows</span>
              </button>
              <button
                type="button"
                onClick={() => handleSetCourtViewLayout("horizontal-cards")}
                className={`flex items-center gap-1 px-2 py-1 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer font-sans ${
                  courtViewLayout === "horizontal-cards"
                    ? "bg-pickle text-sand shadow-sm"
                    : "text-foreground/70 hover:text-foreground hover:bg-muted/40"
                }`}
                title="View courts as side-by-side swipeable cards"
              >
                <Columns size={13} />
                <span>Swipe</span>
              </button>
            </div>
          </div>

          {/* Quick Court Jump Bar (Horizontal Pills) */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar -mx-1 px-1">
            <span className="text-[0.62rem] font-bold uppercase tracking-widest text-foreground/60 shrink-0 font-mono">
              Quick Jump:
            </span>
            {FACILITY_COURTS.map((court) => {
              const st = currentStations[court];
              const courtMatch = findMatchForCourtStation(court, st, matches);
              const isLive = courtMatch?.status === "live";
              const isScheduled = courtMatch?.status === "scheduled";
              const operatingOfficial = courtMatch?.officiatedBy || (st?.assignedUmpire && (st.status === "live" || st.status === "warmup") ? st.assignedUmpire : null);
              const isOperatedByOther = Boolean(
                courtMatch &&
                courtMatch.status !== "final" &&
                operatingOfficial &&
                operatingOfficial !== currentUmpire
              );

              return (
                <button
                  key={`pill-${court}`}
                  type="button"
                  onClick={() => {
                    const el = document.getElementById(`court-card-${court.replace(/\s+/g, "-").toLowerCase()}`);
                    if (el) {
                      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
                    }
                  }}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase tracking-wider border transition-all cursor-pointer shrink-0 font-sans ${
                    isLive
                      ? "border-pickle bg-pickle/15 text-pickle"
                      : isOperatedByOther
                      ? "border-brick/50 bg-brick/10 text-brick"
                      : courtMatch
                      ? "border-sand/40 bg-charcoal text-sand hover:border-pickle/50"
                      : "border-border bg-card text-foreground/70 hover:border-sand/40 hover:text-foreground"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      isLive
                        ? "bg-pickle animate-pulse"
                        : isOperatedByOther
                        ? "bg-brick"
                        : isScheduled
                        ? "bg-sand"
                        : "bg-foreground/40"
                    }`}
                  />
                  <span>{court}</span>
                  {isLive && courtMatch && (
                    <span className="font-mono text-[0.65rem] text-pickle font-bold">
                      {courtMatch.score.teamAScore}-{courtMatch.score.teamBScore}
                    </span>
                  )}
                  {!courtMatch && (
                    <span className="text-[0.6rem] text-foreground/60 uppercase">
                      Standby
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Render Courts based on chosen Layout */}
          {courtViewLayout === "grid-2x2" ? (
            /* Layout: 2x2 Court Grid Matrix (All 4 Courts visible on 1 phone screen!) */
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
              {FACILITY_COURTS.map((court) => {
                const st = currentStations[court];
                const courtMatch = findMatchForCourtStation(court, st, matches);
                const isLive = courtMatch?.status === "live";
                const isScheduled = courtMatch?.status === "scheduled";
                const operatingOfficial = courtMatch?.officiatedBy || (st?.assignedUmpire && (st.status === "live" || st.status === "warmup") ? st.assignedUmpire : null);
                const isAssignedToMe = Boolean(courtMatch?.officiatedBy === currentUmpire || (!courtMatch?.officiatedBy && st?.assignedUmpire === currentUmpire));
                const isOperatedByOther = Boolean(
                  courtMatch &&
                  courtMatch.status !== "final" &&
                  operatingOfficial &&
                  operatingOfficial !== currentUmpire
                );

                return (
                  <div
                    key={court}
                    id={`court-card-${court.replace(/\s+/g, "-").toLowerCase()}`}
                    onClick={() => {
                      if (courtMatch && !isOperatedByOther) {
                        if (!courtMatch.officiatedBy) {
                          onUpdate(courtMatch.id, (m) => ({
                            ...m,
                            officiatedBy: currentUmpire,
                          }));
                          dbUpdateCourtStation(court, {
                            currentMatchId: courtMatch.id,
                            assignedUmpire: currentUmpire,
                          }).catch(() => { });
                          claimCourtStation(court, currentUmpire);
                        }
                        onSelectMatch(courtMatch.id);
                      }
                    }}
                    className={`p-2.5 sm:p-3 border-2 transition-all font-sans flex flex-col justify-between ${
                      isOperatedByOther
                        ? "border-brick/50 bg-charcoal text-sand cursor-not-allowed"
                        : isLive
                        ? "border-pickle/80 shadow-md shadow-pickle/20 bg-charcoal text-sand active:scale-[0.98] cursor-pointer"
                        : courtMatch
                        ? "border-border hover:border-pickle/50 bg-charcoal text-sand active:scale-[0.98] cursor-pointer"
                        : "border-border border-dashed bg-card text-foreground cursor-default"
                    }`}
                  >
                    {/* Tile Header: Court name + Status */}
                    <div className="flex items-center justify-between gap-1 border-b border-border/50 pb-1.5">
                      <span className={`font-display text-lg sm:text-xl tracking-wide ${courtMatch ? "text-sand" : "text-foreground"}`}>
                        {court}
                      </span>
                      {isOperatedByOther && (
                        <span className="text-[0.58rem] font-bold uppercase tracking-wider text-brick bg-brick/20 border border-brick/40 px-1.5 py-0.2">
                          In Use
                        </span>
                      )}
                      {!isOperatedByOther && isLive && (
                        <span className="inline-flex items-center gap-1 text-[0.62rem] font-bold uppercase tracking-wider text-pickle bg-pickle/20 border border-pickle/40 px-1.5 py-0.2">
                          <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
                          {courtMatch.score.teamAScore}-{courtMatch.score.teamBScore}
                        </span>
                      )}
                      {!isOperatedByOther && isScheduled && (
                        <span className="text-[0.58rem] font-bold uppercase tracking-wider text-sand bg-sand/15 border border-border px-1.5 py-0.2">
                          Ready
                        </span>
                      )}
                      {!courtMatch && (
                        <span className="text-[0.58rem] font-bold uppercase tracking-wider text-foreground/60 bg-muted/40 border border-border px-1.5 py-0.2">
                          Standby
                        </span>
                      )}
                    </div>

                    {/* Tile Body: Matchup or Waiting */}
                    <div className="py-2 min-w-0">
                      {courtMatch ? (
                        <div className="space-y-0.5 min-w-0">
                          <div className="text-xs font-bold text-sand truncate">
                            {courtMatch.teamAName}
                          </div>
                          <div className="text-[0.6rem] font-bold uppercase tracking-widest text-sand/50">
                            vs
                          </div>
                          <div className="text-xs font-bold text-sand truncate">
                            {courtMatch.teamBName}
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-1">
                          <span className="text-[0.68rem] uppercase tracking-wider font-bold text-foreground/70 block">
                            Empty Station
                          </span>
                          <span className="text-[0.6rem] text-foreground/50 block">
                            Waiting for dispatch
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Tile Bottom Action */}
                    <div className="pt-1.5 border-t border-border/50">
                      {courtMatch ? (
                        isOperatedByOther ? (
                          <span className="text-[0.6rem] font-semibold text-brick truncate block text-center">
                            In Use: {operatingOfficial}
                          </span>
                        ) : (
                          <div className="w-full py-1 text-center bg-pickle text-sand font-bold text-[0.65rem] uppercase tracking-wider shadow-sm transition-opacity hover:opacity-90">
                            {isLive ? "Score Match" : "Supervise Court"}
                          </div>
                        )
                      ) : (
                        <div className="w-full py-1 text-center bg-muted/30 border border-border text-foreground/50 font-bold text-[0.6rem] uppercase tracking-wider">
                          Standby
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : courtViewLayout === "horizontal-rows" ? (
            /* Layout 1: Horizontal Rows (Compact, wide, mobile-optimized strips) */
            <div className="flex flex-col gap-3">
              {FACILITY_COURTS.map((court) => {
                const st = currentStations[court];
                const courtMatch = findMatchForCourtStation(court, st, matches);
                const isLive = courtMatch?.status === "live";
                const isScheduled = courtMatch?.status === "scheduled";
                const operatingOfficial = courtMatch?.officiatedBy || (st?.assignedUmpire && (st.status === "live" || st.status === "warmup") ? st.assignedUmpire : null);
                const isAssignedToMe = Boolean(courtMatch?.officiatedBy === currentUmpire || (!courtMatch?.officiatedBy && st?.assignedUmpire === currentUmpire));
                const isOperatedByOther = Boolean(
                  courtMatch &&
                  courtMatch.status !== "final" &&
                  operatingOfficial &&
                  operatingOfficial !== currentUmpire
                );

                return (
                  <div
                    key={court}
                    id={`court-card-${court.replace(/\s+/g, "-").toLowerCase()}`}
                    className={`p-3.5 sm:p-4 border-2 transition-all font-sans flex flex-col md:flex-row md:items-center justify-between gap-3 sm:gap-4 ${
                      isOperatedByOther
                        ? "border-brick/50 bg-charcoal text-sand"
                        : isLive
                        ? "border-pickle/80 shadow-md shadow-pickle/15 bg-charcoal text-sand"
                        : courtMatch
                        ? "border-border hover:border-pickle/50 bg-charcoal text-sand"
                        : "border-border border-dashed bg-card text-foreground"
                    }`}
                  >
                    {/* Left: Court identity & status tag */}
                    <div className="flex md:flex-col items-center md:items-start justify-between md:justify-center gap-1.5 md:w-36 shrink-0 border-b md:border-b-0 md:border-r border-border/60 pb-2 md:pb-0 md:pr-3">
                      <span className={`font-display text-2xl tracking-wide ${courtMatch ? "text-sand" : "text-foreground"}`}>
                        {court}
                      </span>
                      <div>
                        {isOperatedByOther && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase tracking-wider bg-brick/20 border border-brick/50 text-brick">
                            <Lock size={11} />
                            In Use
                          </span>
                        )}
                        {!isOperatedByOther && isLive && (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-bold uppercase tracking-wider bg-pickle/20 border border-pickle/50 text-pickle">
                            <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
                            Live: {courtMatch.score.teamAScore} - {courtMatch.score.teamBScore}
                          </span>
                        )}
                        {!isOperatedByOther && isScheduled && (
                          <span className="inline-flex items-center px-2 py-0.5 text-xs font-bold uppercase tracking-wider bg-sand/15 border border-border text-sand">
                            Ready
                          </span>
                        )}
                        {!courtMatch && (
                          <span className="text-xs font-bold uppercase tracking-wider text-foreground/70 bg-card border border-border px-2 py-0.5">
                            Standby
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Middle: Match details or standby notice */}
                    <div className="flex-1 min-w-0">
                      {courtMatch ? (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            {courtMatch.stage && (
                              <span className="inline-block text-[0.68rem] font-bold uppercase tracking-wider text-pickle bg-pickle/15 px-2 py-0.5 border border-pickle/30 truncate font-sans">
                                {courtMatch.stage}
                              </span>
                            )}
                            <span className="text-xs text-sand/70 font-semibold uppercase tracking-wider">
                              Official:{" "}
                              <span className={`font-bold font-sans ${isOperatedByOther ? "text-brick" : (courtMatch.officiatedBy || st?.assignedUmpire) ? "text-pickle" : "text-sand/60"}`}>
                                {operatingOfficial
                                  ? isAssignedToMe
                                    ? `${operatingOfficial} (You)`
                                    : operatingOfficial
                                  : "Unassigned"}
                              </span>
                            </span>
                          </div>

                          {/* Horizontal Team Matchup */}
                          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-2 bg-charcoal/80 p-2 sm:p-2.5 border border-white/10">
                            <div className="min-w-0">
                              <span className="block text-sm font-bold text-sand truncate">
                                {courtMatch.teamAName}
                              </span>
                              <span className="block text-xs text-sand/80 font-medium truncate">
                                {courtMatch.teamAPlayers.join(" / ")}
                              </span>
                              {courtMatch.teamAClub && (
                                <span className="inline-block mt-0.5 text-[0.6rem] px-1.5 py-0.2 bg-pickle/20 text-pickle border border-pickle/40 uppercase tracking-wider font-bold">
                                  {courtMatch.teamAClub}
                                </span>
                              )}
                            </div>

                            <div className="text-xs font-bold uppercase tracking-widest text-center text-sand/60 px-2 py-0.5 sm:border-x sm:border-white/10">
                              vs
                            </div>

                            <div className="min-w-0 sm:text-right">
                              <span className="block text-sm font-bold text-sand truncate">
                                {courtMatch.teamBName}
                              </span>
                              <span className="block text-xs text-sand/80 font-medium truncate">
                                {courtMatch.teamBPlayers.join(" / ")}
                              </span>
                              {courtMatch.teamBClub && (
                                <span className="inline-block mt-0.5 text-[0.6rem] px-1.5 py-0.2 bg-pickle/20 text-pickle border border-pickle/40 uppercase tracking-wider font-bold">
                                  {courtMatch.teamBClub}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="py-2 space-y-1">
                          <span className="text-sm uppercase tracking-wider font-bold text-foreground block">
                            Waiting for Admin Dispatch
                          </span>
                          <p className="text-xs text-foreground/70 font-medium leading-relaxed">
                            The Tournament Director will assign the next scheduled match here.
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Right: Actions */}
                    <div className="md:w-56 shrink-0 flex flex-col justify-center pt-1 md:pt-0">
                      {courtMatch ? (
                        isOperatedByOther ? (
                          <div className="space-y-1">
                            <div className="w-full py-2 px-3 border border-brick/40 bg-brick/10 text-brick font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 select-none text-center font-sans">
                              <Lock size={12} />
                              <span>In Use: {operatingOfficial}</span>
                            </div>
                            <p className="text-[0.62rem] text-center text-sand/60 font-medium">
                              Official actively scoring.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                if (!courtMatch.officiatedBy) {
                                  onUpdate(courtMatch.id, (m) => ({
                                    ...m,
                                    officiatedBy: currentUmpire,
                                  }));
                                  dbUpdateCourtStation(court, {
                                    currentMatchId: courtMatch.id,
                                    assignedUmpire: currentUmpire,
                                  }).catch(() => { });
                                  claimCourtStation(court, currentUmpire);
                                }
                                onSelectMatch(courtMatch.id);
                              }}
                              className="w-full py-2.5 px-3 bg-pickle text-sand font-bold text-xs uppercase tracking-widest hover:opacity-90 active:scale-[0.99] transition-all text-center cursor-pointer shadow-md font-sans"
                            >
                              {isLive ? `Continue Scoring ${court}` : `Supervise & Score ${court}`}
                            </button>
                            {!isMatchTossDone(courtMatch) && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (typeof localStorage !== "undefined") {
                                    try {
                                      localStorage.removeItem(`dv_toss_done_${courtMatch.id}`);
                                    } catch { }
                                  }
                                  if (!courtMatch.officiatedBy) {
                                    onUpdate(courtMatch.id, (m) => ({
                                      ...resetMatch(m),
                                      officiatedBy: currentUmpire,
                                    }));
                                    dbUpdateCourtStation(court, {
                                      currentMatchId: courtMatch.id,
                                      assignedUmpire: currentUmpire,
                                    }).catch(() => { });
                                    claimCourtStation(court, currentUmpire);
                                  } else {
                                    onUpdate(courtMatch.id, resetMatch);
                                  }
                                  onSelectMatch(courtMatch.id);
                                }}
                                className="w-full py-1.5 px-2 bg-charcoal border border-pickle/40 text-sand hover:bg-pickle hover:text-sand text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer text-center font-sans"
                              >
                                Coin Toss (Reset)
                              </button>
                            )}
                          </div>
                        )
                      ) : (
                        <div className="w-full py-2 px-3 border-2 border-border text-foreground/60 font-bold text-xs uppercase tracking-wider text-center select-none bg-muted/30">
                          Standby: No Match
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* Layout 2: Horizontal Cards (Side-by-side swipeable carousel track) */
            <div className="flex flex-row overflow-x-auto snap-x snap-mandatory gap-4 pb-3 no-scrollbar scroll-smooth -mx-4 px-4 sm:mx-0 sm:px-0">
              {FACILITY_COURTS.map((court) => {
                const st = currentStations[court];
                const courtMatch = findMatchForCourtStation(court, st, matches);
                const isLive = courtMatch?.status === "live";
                const isScheduled = courtMatch?.status === "scheduled";
                const operatingOfficial = courtMatch?.officiatedBy || (st?.assignedUmpire && (st.status === "live" || st.status === "warmup") ? st.assignedUmpire : null);
                const isAssignedToMe = Boolean(courtMatch?.officiatedBy === currentUmpire || (!courtMatch?.officiatedBy && st?.assignedUmpire === currentUmpire));
                const isOperatedByOther = Boolean(
                  courtMatch &&
                  courtMatch.status !== "final" &&
                  operatingOfficial &&
                  operatingOfficial !== currentUmpire
                );

                return (
                  <div
                    key={court}
                    id={`court-card-${court.replace(/\s+/g, "-").toLowerCase()}`}
                    className={`w-[85vw] max-w-[340px] sm:w-[320px] shrink-0 snap-center p-0 overflow-hidden flex flex-col justify-between border-2 transition-all font-sans ${
                      isOperatedByOther
                        ? "border-brick/50 bg-charcoal text-sand"
                        : isLive
                        ? "border-pickle/80 shadow-lg shadow-pickle/15 bg-charcoal text-sand"
                        : courtMatch
                        ? "border-border hover:border-pickle/50 bg-charcoal text-sand"
                        : "border-border border-dashed bg-card text-foreground"
                    }`}
                  >
                    {/* Card Header */}
                    <div
                      className={`px-4 py-3 flex items-center justify-between border-b-2 ${
                        courtMatch ? "bg-charcoal border-white/10" : "bg-muted/40 border-border"
                      }`}
                    >
                      <span
                        className={`font-display text-2xl tracking-wide ${
                          courtMatch ? "text-sand" : "text-foreground"
                        }`}
                      >
                        {court}
                      </span>
                      {isOperatedByOther && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase tracking-wider bg-brick/20 border border-brick/50 text-brick">
                          <Lock size={11} />
                          In Use
                        </span>
                      )}
                      {!isOperatedByOther && isLive && (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-bold uppercase tracking-wider bg-pickle/20 border border-pickle/50 text-pickle">
                          <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
                          Live: {courtMatch.score.teamAScore} - {courtMatch.score.teamBScore}
                        </span>
                      )}
                      {!isOperatedByOther && isScheduled && (
                        <span className="inline-flex items-center px-2 py-0.5 text-xs font-bold uppercase tracking-wider bg-sand/15 border border-border text-sand">
                          Ready
                        </span>
                      )}
                      {!courtMatch && (
                        <span className="text-xs font-bold uppercase tracking-wider text-foreground/70 bg-card border border-border px-2 py-0.5">
                          Standby
                        </span>
                      )}
                    </div>

                    {/* Card Body */}
                    <div className="p-4 flex-1 flex flex-col justify-between space-y-4">
                      {courtMatch ? (
                        <div className="space-y-3">
                          {courtMatch.stage && (
                            <span className="inline-block text-xs font-bold uppercase tracking-wider text-pickle bg-pickle/15 px-2 py-0.5 border border-pickle/30 truncate max-w-full font-sans">
                              {courtMatch.stage}
                            </span>
                          )}

                          {/* Matchup */}
                          <div className="space-y-2.5">
                            {/* Team A */}
                            <div className="bg-charcoal/80 p-2.5 border border-white/10">
                              <span className="block text-sm font-bold text-sand truncate">
                                {courtMatch.teamAName}
                              </span>
                              <span className="block text-xs text-sand/80 font-medium truncate mt-0.5">
                                {courtMatch.teamAPlayers.join(" / ")}
                              </span>
                              {courtMatch.teamAClub && (
                                <span className="inline-block mt-1 text-[0.6rem] px-1.5 py-0.2 bg-pickle/20 text-pickle border border-pickle/40 uppercase tracking-wider font-bold font-sans">
                                  {courtMatch.teamAClub}
                                </span>
                              )}
                            </div>

                            <div className="text-xs font-bold uppercase tracking-widest text-center text-sand/60">
                              vs
                            </div>

                            {/* Team B */}
                            <div className="bg-charcoal/80 p-2.5 border border-white/10">
                              <span className="block text-sm font-bold text-sand truncate">
                                {courtMatch.teamBName}
                              </span>
                              <span className="block text-xs text-sand/80 font-medium truncate mt-0.5">
                                {courtMatch.teamBPlayers.join(" / ")}
                              </span>
                              {courtMatch.teamBClub && (
                                <span className="inline-block mt-1 text-[0.6rem] px-1.5 py-0.2 bg-pickle/20 text-pickle border border-pickle/40 uppercase tracking-wider font-bold font-sans">
                                  {courtMatch.teamBClub}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Official Info */}
                          <div className="text-xs uppercase tracking-wider text-sand/80 flex items-center justify-between pt-1">
                            <span className="text-sand/70 font-semibold">Official:</span>
                            <span className={`font-bold truncate max-w-[140px] font-sans ${isOperatedByOther ? "text-brick" : (courtMatch.officiatedBy || st?.assignedUmpire) ? "text-pickle" : "text-sand/60"}`}>
                              {operatingOfficial
                                ? isAssignedToMe
                                  ? `${operatingOfficial} (You)`
                                  : operatingOfficial
                                : "Unassigned"}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="py-6 text-center space-y-2">
                          <span className="text-sm uppercase tracking-wider font-bold text-foreground block">
                            Waiting for Admin Dispatch
                          </span>
                          <p className="text-xs text-foreground/70 font-medium max-w-[220px] mx-auto leading-relaxed">
                            The Tournament Director will assign the next scheduled match here.
                          </p>
                        </div>
                      )}

                      {/* Action button */}
                      <div className="pt-2">
                        {courtMatch ? (
                          isOperatedByOther ? (
                            <div className="space-y-1.5">
                              <div className="w-full py-2.5 px-3 border border-brick/40 bg-brick/10 text-brick font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 select-none text-center font-sans">
                                <Lock size={13} />
                                <span>In Use: {operatingOfficial}</span>
                              </div>
                              <p className="text-[0.65rem] text-center text-sand/60 font-medium">
                                Official actively scoring. Access restricted.
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <button
                                type="button"
                                onClick={() => {
                                  if (!courtMatch.officiatedBy) {
                                    onUpdate(courtMatch.id, (m) => ({
                                      ...m,
                                      officiatedBy: currentUmpire,
                                    }));
                                    dbUpdateCourtStation(court, {
                                      currentMatchId: courtMatch.id,
                                      assignedUmpire: currentUmpire,
                                    }).catch(() => { });
                                    claimCourtStation(court, currentUmpire);
                                  }
                                  onSelectMatch(courtMatch.id);
                                }}
                                className="w-full py-2.5 px-3 bg-pickle text-sand font-bold text-xs uppercase tracking-widest hover:opacity-90 active:scale-[0.99] transition-all text-center cursor-pointer shadow-md font-sans"
                              >
                                {isLive ? `Continue Scoring ${court}` : `Supervise & Score ${court}`}
                              </button>
                              {!isMatchTossDone(courtMatch) && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (typeof localStorage !== "undefined") {
                                      try {
                                        localStorage.removeItem(`dv_toss_done_${courtMatch.id}`);
                                      } catch { }
                                    }
                                    if (!courtMatch.officiatedBy) {
                                      onUpdate(courtMatch.id, (m) => ({
                                        ...resetMatch(m),
                                        officiatedBy: currentUmpire,
                                      }));
                                      dbUpdateCourtStation(court, {
                                        currentMatchId: courtMatch.id,
                                        assignedUmpire: currentUmpire,
                                      }).catch(() => { });
                                      claimCourtStation(court, currentUmpire);
                                    } else {
                                      onUpdate(courtMatch.id, resetMatch);
                                    }
                                    onSelectMatch(courtMatch.id);
                                  }}
                                  className="w-full py-1.5 px-2 bg-charcoal border border-pickle/40 text-sand hover:bg-pickle hover:text-sand text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer text-center font-sans"
                                >
                                  Coin Toss (Reset)
                                </button>
                              )}
                            </div>
                          )
                        ) : (
                          <div className="w-full py-2.5 px-3 border-2 border-border text-foreground/60 font-bold text-xs uppercase tracking-wider text-center select-none bg-muted/30">
                            Standby: No Dispatched Match
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Match Results Banner linking to dedicated Match Results tab */}
        <div className="pt-4 border-t-2 border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-card p-4 border-2 border-border shadow-sm font-sans">
          <div>
            <span className="text-xs uppercase tracking-wider font-bold text-pickle block">
              Match Results
            </span>
            <span className="text-xs text-foreground/80 font-medium">
              {completedMatches.length > 0
                ? `${completedMatches.length} match${completedMatches.length === 1 ? "" : "es"} concluded for ${activeTournament?.name || "this event"}.`
                : `Official match results for ${activeTournament?.name || "this event"}.`}
            </span>
          </div>
          {onViewResults && (
            <button
              type="button"
              onClick={onViewResults}
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-pickle text-sand hover:opacity-90 active:scale-[0.99] transition-all cursor-pointer w-fit shadow-sm font-sans"
            >
              View Match Results &rarr;
            </button>
          )}
        </div>
      </div>
    );
  }


  if (isOperatedByOther) {
    return (
      <div className="max-w-xl mx-auto py-8 px-4 font-sans">
        <div className="border-2 border-brick/60 bg-charcoal p-6 sm:p-8 space-y-6 shadow-2xl">
          <div className="flex items-center gap-3 border-b border-border/80 pb-4">
            <div className="h-12 w-12 rounded-full bg-brick/20 border border-brick/40 flex items-center justify-center flex-shrink-0 text-brick">
              <Lock size={22} />
            </div>
            <div>
              <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-brick block">
                Access Restricted
              </span>
              <h2 className="font-display text-2xl text-sand">
                Game In Progress
              </h2>
            </div>
          </div>

          <div className="space-y-4">
            <p className="text-sm text-sand/90 leading-relaxed">
              This match is currently being operated by official{" "}
              <strong className="text-pickle font-bold font-sans">{matchOperatingOfficial}</strong>.
              Other umpires cannot access or score this game while it is actively in progress.
            </p>

            <div className="bg-card/70 border border-border p-4 space-y-2 text-xs">
              <div className="flex items-center justify-between text-sand/60 uppercase tracking-wider text-[0.65rem]">
                <span>{match.court || "Active Court"}</span>
                <span>{match.stage || "Tournament Match"}</span>
              </div>
              <div className="font-bold text-sand text-sm">
                {match.teamAName} <span className="text-sand/50 font-normal">vs</span> {match.teamBName}
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-border/50 text-[0.7rem]">
                <span className="text-sand/70">Current Score:</span>
                <span className="font-mono font-bold text-sand">
                  {match.score.teamAScore} - {match.score.teamBScore}
                </span>
              </div>
              <div className="flex items-center justify-between text-[0.7rem]">
                <span className="text-sand/70">Operating Official:</span>
                <span className="font-bold text-brick">
                  {matchOperatingOfficial}
                </span>
              </div>
            </div>
          </div>

          <div className="pt-2">
            <button
              type="button"
              onClick={() => onSelectMatch("")}
              className="w-full py-3 px-4 bg-pickle text-sand font-bold text-xs uppercase tracking-widest hover:opacity-90 active:scale-[0.99] transition-all cursor-pointer text-center font-sans"
            >
              &larr; Return to Court Selection
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isLiveOrScheduled = match.status !== "final";
  const needsToss = match.status !== "final" && !tossDone && !isMatchTossDone(match);
  const s = match.score;
  const servingTeamName = s.servingTeam === "A" ? match.teamAName : match.teamBName;
  const effectiveUmpire = match.officiatedBy ?? currentUmpire;

  const serverScore = s.servingTeam === "A" ? s.teamAScore : s.teamBScore;
  const receiverScore = s.servingTeam === "A" ? s.teamBScore : s.teamAScore;

  const leftTeam = teamASide === "right" ? "B" : "A";
  const rightTeam = teamASide === "right" ? "A" : "B";
  const leftTeamName = leftTeam === "A" ? match.teamAName : match.teamBName;
  const rightTeamName = rightTeam === "A" ? match.teamAName : match.teamBName;
  const leftScore = leftTeam === "A" ? s.teamAScore : s.teamBScore;
  const rightScore = rightTeam === "A" ? s.teamAScore : s.teamBScore;

  const handleChangeCourt = async (newCourt: FacilityCourt) => {
    if (!match || match.court === newCourt) {
      setShowChangeCourtModal(false);
      setShowCourtSideModal(false);
      return;
    }
    const oldCourt = match.court;
    if (oldCourt && (FACILITY_COURTS as readonly string[]).includes(oldCourt as string)) {
      await vacateCourt(oldCourt as FacilityCourt);
    }
    onUpdate(match.id, (m) => ({
      ...m,
      court: newCourt,
      officiatedBy: m.officiatedBy ?? currentUmpire,
    }));
    if (newCourt) {
      dbUpdateCourtStation(newCourt, {
        status: isLiveOrScheduled ? "live" : "standby",
        currentMatchId: match.id,
        assignedUmpire: effectiveUmpire,
      }).catch(() => { });
    }
    setShowChangeCourtModal(false);
    setShowCourtSideModal(false);
  };

  const handlePoint = () => {
    if (!isLiveOrScheduled || needsToss) return;
    onUpdate(match.id, (m) => {
      const updated = scorePoint(m);
      return {
        ...updated,
        officiatedBy: m.officiatedBy ?? currentUmpire,
        ...(m.status === "scheduled" ? { startedAt: Date.now() } : {}),
      };
    });
    // Ensure court station is marked as live in Supabase
    if (match.court && match.court !== "Queue") {
      dbUpdateCourtStation(match.court, {
        status: "live",
        currentMatchId: match.id,
        assignedUmpire: effectiveUmpire,
      }).catch(() => { });
    }
  };

  const handleSideOut = () => {
    if (!isLiveOrScheduled || needsToss) return;
    onUpdate(match.id, (m) => {
      const updated = sideOut(m);
      return {
        ...updated,
        officiatedBy: m.officiatedBy ?? currentUmpire,
        ...(m.status === "scheduled" ? { startedAt: Date.now() } : {}),
      };
    });
    if (match.court && match.court !== "Queue") {
      dbUpdateCourtStation(match.court, {
        status: "live",
        currentMatchId: match.id,
        assignedUmpire: effectiveUmpire,
      }).catch(() => { });
    }
  };

  const handleSwapServerNumber = () => {
    onUpdate(match.id, (m) => ({
      ...m,
      score: {
        ...m.score,
        serverNumber: m.score.serverNumber === 1 ? 2 : 1,
      },
    }));
  };

  const handleSwapServingTeam = () => {
    onUpdate(match.id, (m) => ({
      ...m,
      score: {
        ...m.score,
        servingTeam: m.score.servingTeam === "A" ? "B" : "A",
      },
    }));
  };

  const handleSwapTeamABase = () => {
    if (!match) return;
    const raw =
      match.teamAPlayers && match.teamAPlayers.length > 0
        ? match.teamAPlayers
        : [match.teamAName || "Player A1"];
    if (raw.length < 2) return;
    const currentBase1 = match.teamABase1Player || raw[0] || "Player A1";
    const newBase1 = raw.find((p) => p !== currentBase1) || raw[1] || raw[0] || "Player A1";
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(`dv_base1_A_${match.id}`, newBase1);
      } catch {
        // ignore
      }
    }
    onUpdate(match.id, (m) => ({
      ...m,
      teamABase1Player: newBase1,
    }));
  };

  const handleSwapTeamBBase = () => {
    if (!match) return;
    const raw =
      match.teamBPlayers && match.teamBPlayers.length > 0
        ? match.teamBPlayers
        : [match.teamBName || "Player B1"];
    if (raw.length < 2) return;
    const currentBase1 = match.teamBBase1Player || raw[0] || "Player B1";
    const newBase1 = raw.find((p) => p !== currentBase1) || raw[1] || raw[0] || "Player B1";
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(`dv_base1_B_${match.id}`, newBase1);
      } catch {
        // ignore
      }
    }
    onUpdate(match.id, (m) => ({
      ...m,
      teamBBase1Player: newBase1,
    }));
  };

  const handleEndGame = async () => {
    onUpdate(match.id, (m) => {
      const updated = endGame(m);
      return {
        ...updated,
        status: "final" as const,
        court: "Queue",
        officiatedBy: m.officiatedBy ?? currentUmpire,
      };
    });
    // Complete match in dispatch queue
    completeQueueMatch(match.id, match.teamAName, match.teamBName, match.stage);
    // Vacate court station in database and release umpire assignment
    if (match.court && match.court !== "Queue") {
      await vacateCourt(match.court as FacilityCourt);
      releaseCourtStation(match.court as FacilityCourt);
    }
    // Automatically advance playoff bracket if knockout match
    try {
      const tSlug = match.tournamentSlug || "dink-valley";
      let catId = match.categoryId;
      if (!catId && match.id) {
        const matchCat = match.id.match(/match-[^-]+-([a-z0-9-]+?)-(?:quarterfinal|semifinal|final|bronze|bracket|pool)/i)?.[1];
        if (matchCat) catId = matchCat;
      }
      if (tSlug && catId) {
        syncMainDrawWithLiveMatches(tSlug, catId, undefined, true);
      } else if (tSlug) {
        const tourneys = getTournaments();
        const tourney = tourneys.find((t) => t.slug === tSlug) || tourneys[0];
        if (tourney) {
          for (const c of tourney.categories) {
            syncMainDrawWithLiveMatches(tSlug, c.id, undefined, true);
          }
        }
      }
    } catch (err) {
      console.warn("[Umpire] Playoff auto-advance sync error:", err);
    }
    setShowEndConfirm(false);
  };

  const handleUndo = () => {
    if (s.rallies.length === 0) return;
    onUpdate(match.id, undoLastRally);
  };

  const handleTossDone = (
    serving: "A" | "B",
    winner?: "A" | "B",
    bases?: { teamABase1?: string; teamBBase1?: string }
  ) => {
    setTossDone(true);
    setTossServingTeam(serving);
    setShowToss(false);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(`dv_toss_done_${match.id}`, "true");
        if (bases?.teamABase1) {
          localStorage.setItem(`dv_base1_A_${match.id}`, bases.teamABase1);
        }
        if (bases?.teamBBase1) {
          localStorage.setItem(`dv_base1_B_${match.id}`, bases.teamBBase1);
        }
      } catch {
        // ignore
      }
    }
    const winnerName = winner === "A" ? match.teamAName : winner === "B" ? match.teamBName : undefined;
    onUpdate(match.id, (m) => ({
      ...m,
      tossDone: true,
      tossWinner: winnerName ?? m.tossWinner,
      teamABase1Player: bases?.teamABase1 ?? m.teamABase1Player ?? m.teamAPlayers?.[0],
      teamBBase1Player: bases?.teamBBase1 ?? m.teamBBase1Player ?? m.teamBPlayers?.[0],
      officiatedBy: m.officiatedBy ?? currentUmpire,
      score: { ...m.score, servingTeam: serving, serverNumber: 2, teamAScore: 0, teamBScore: 0 },
    }));
  };

  return (
    <div className="space-y-2.5 sm:space-y-5 max-w-2xl mx-auto">
      {/* Coin Toss Overlay */}
      {showToss && (
        <CoinTossOverlay
          teamAName={match.teamAName}
          teamBName={match.teamBName}
          teamAPlayers={match.teamAPlayers}
          teamBPlayers={match.teamBPlayers}
          initialTeamABase1={match.teamABase1Player}
          initialTeamBBase1={match.teamBBase1Player}
          onDone={handleTossDone}
          onClose={() => setShowToss(false)}
        />
      )}

      {/* Timeout Countdown Overlay */}
      {timeoutActive && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/95 backdrop-blur-sm p-4">
          <div className="surface-card border-2 border-pickle max-w-sm w-full p-6 sm:p-8 text-center space-y-5">
            <div>
              <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-pickle block">
                Official Timeout (60s)
              </span>
              <h3 className="font-display text-2xl text-foreground mt-1">
                {timeoutTeam === "A" ? match.teamAName : match.teamBName}
              </h3>
            </div>

            {/* Countdown Display */}
            <div className="py-2">
              <div className="font-display text-7xl text-sand font-mono tracking-wider">
                {timeoutSeconds}
              </div>
              <span className="text-xs uppercase tracking-widest text-foreground/60 font-semibold mt-1 block">
                Seconds Remaining
              </span>
            </div>

            {/* Progress Bar */}
            <div className="h-2 w-full bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-pickle transition-all duration-1000"
                style={{ width: `${(timeoutSeconds / 60) * 100}%` }}
              />
            </div>

            <button
              onClick={handleCancelTimeout}
              className="w-full py-3 bg-brick text-sand font-display text-lg tracking-widest hover:bg-brick-deep transition-colors cursor-pointer"
            >
              Resume Match Now
            </button>
          </div>
        </div>
      )}

      {/* Navigation & Match Info Header */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onSelectMatch("")}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold uppercase tracking-widest bg-charcoal border border-border text-sand hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
        >
          <span className="text-base leading-none">&larr;</span> Back
        </button>

        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {/* Court Station Badge & Setup Button */}
          <button
            type="button"
            onClick={() => setShowCourtSideModal(true)}
            title="Click to change court or player sides"
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold uppercase tracking-widest font-mono bg-charcoal border border-border hover:border-pickle text-sand cursor-pointer transition-colors"
          >
            <span className="text-pickle font-bold">{match.court}</span>
            <span className="text-[0.6rem] text-sand/60">SETUP</span>
          </button>

          {match.stage && (
            <span className="text-xs font-bold uppercase tracking-widest font-mono bg-pickle/20 text-pickle px-2 py-1 border border-pickle/40">
              {match.stage}
            </span>
          )}

          <MatchStatusBadge status={match.status} />

          {onOpenDebug && (
            <button
              type="button"
              onClick={onOpenDebug}
              title="Inspect score sync with tournament desk"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs uppercase tracking-wider font-mono border border-pickle/40 bg-charcoal text-pickle hover:bg-pickle/20 transition-colors cursor-pointer"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
              <span>Desk Sync</span>
            </button>
          )}

          {/* Official Badge */}
          <div className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 text-xs uppercase tracking-widest border border-border bg-charcoal text-sand">
            <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
            <span className="text-xs font-bold text-sand">Official:</span>
            <span className="font-bold text-pickle font-sans">
              {effectiveUmpire}
            </span>
            {effectiveUmpire === currentUmpire && (
              <span className="text-xs text-sand/90 font-bold">(You)</span>
            )}
          </div>
        </div>
      </div>


      {/* Pre-match Toss Banner */}
      {needsToss && !showToss && (
        <div className="border border-pickle/40 bg-pickle/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <span className="block text-[0.6rem] uppercase tracking-[0.28em] font-bold text-pickle">
              Pre-Match Required
            </span>
            <span className="block text-sm font-semibold text-foreground mt-0.5">
              Conduct coin toss before scoring begins
            </span>
          </div>
          <button
            onClick={() => setShowToss(true)}
            className="px-4 py-2 bg-pickle text-sand text-xs font-bold uppercase tracking-widest hover:opacity-90 transition-opacity cursor-pointer w-fit"
          >
            Start Coin Toss
          </button>
        </div>
      )}

      {/* Concluded Match Reset / Replay Banner */}
      {match.status === "final" && (
        <div className="surface-card p-4 border border-pickle/40 bg-charcoal/80 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <span className="text-[0.65rem] uppercase tracking-widest font-bold text-pickle block">
              Match Concluded
            </span>
            <span className="text-xs text-sand/90 font-medium">
              Need to replay or reopen this match? Resetting will clear scores and launch pre-match coin toss.
            </span>
          </div>
          <button
            onClick={handleRequestResetToss}
            className="px-4 py-2 text-xs font-bold uppercase tracking-widest bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer whitespace-nowrap w-fit"
          >
            Coin Toss (Reset Match)
          </button>
        </div>
      )}

      {/* Compact Score Call Bar (Directly Above 2D Court Diagram) */}
      <div className="surface-card p-0 overflow-hidden border-2 border-pickle/40 bg-charcoal">
        <div className="bg-pickle/15 px-3 py-1 flex items-center justify-between border-b border-pickle/20 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-pickle animate-pulse" />
            <span className="text-[0.62rem] font-mono uppercase tracking-widest text-pickle font-bold">
              {match.status === "final" ? "Final Score" : `Serving: ${servingTeamName}`}
            </span>
          </div>
          <span className="text-[0.6rem] font-mono text-sand/80 uppercase tracking-wider">
            {match.court} &middot; {match.stage || "Regulation"}
          </span>
        </div>

        {/* Score & 3-Number Call Line */}
        <div className="px-3 py-2 sm:py-3 flex items-center justify-between gap-2">
          {/* Left Team (Matches Left Court End) */}
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span
              className={`font-display text-3xl sm:text-5xl font-bold leading-none ${s.servingTeam === leftTeam ? "text-pickle" : "text-foreground"
                }`}
            >
              {leftScore}
            </span>
            <div className="min-w-0">
              <span className="block text-xs sm:text-sm font-bold text-sand truncate" title={leftTeamName}>
                {leftTeamName}
              </span>
              {s.servingTeam === leftTeam && (
                <span className="text-[0.58rem] font-mono font-bold text-pickle uppercase tracking-wider">
                  Server #{s.serverNumber}
                </span>
              )}
            </div>
          </div>

          {/* Center 3-Number Pickleball Score Call */}
          {match.status !== "final" && (
            <div className="flex-shrink-0 text-center px-3 py-1 bg-black/50 border border-pickle/40 rounded shadow-inner">
              <div className="font-display text-3xl sm:text-5xl text-sand tracking-wider leading-none font-bold">
                {serverScore}
                <span className="text-pickle mx-1">-</span>
                {receiverScore}
                <span className="text-pickle mx-1">-</span>
                {s.serverNumber}
              </div>
              <div className="text-[0.55rem] uppercase tracking-widest text-sand/80 font-mono mt-0.5 font-semibold">
                Score Call
              </div>
            </div>
          )}

          {/* Right Team (Matches Right Court End) */}
          <div className="flex-1 min-w-0 flex items-center justify-end gap-2 text-right">
            <div className="min-w-0 text-right">
              <span className="block text-xs sm:text-sm font-bold text-sand truncate" title={rightTeamName}>
                {rightTeamName}
              </span>
              {s.servingTeam === rightTeam && (
                <span className="text-[0.58rem] font-mono font-bold text-pickle uppercase tracking-wider">
                  Server #{s.serverNumber}
                </span>
              )}
            </div>
            <span
              className={`font-display text-3xl sm:text-5xl font-bold leading-none ${s.servingTeam === rightTeam ? "text-pickle" : "text-foreground"
                }`}
            >
              {rightScore}
            </span>
          </div>
        </div>

        {/* Winner banner if final */}
        {match.status === "final" && match.winnerTeam && (
          <div className="bg-pickle/20 px-3 py-2 text-center border-t border-pickle/40">
            <span className="text-[0.62rem] uppercase tracking-widest font-bold text-pickle">
              Winner: {match.winnerTeam}
            </span>
          </div>
        )}
      </div>

      {/* 2D Visual Court Diagram (Viewed by umpire before clicking Point Scored/Side Out) */}
      {teamAPos && teamBPos && (
        <CourtDiagramView
          match={match}
          teamAPos={teamAPos}
          teamBPos={teamBPos}
          teamASide={teamASide}
          onToggleSide={handleToggleCourtSides}
          onChangeCourt={() => setShowCourtSideModal(true)}
          onSwapBaseA={handleSwapTeamABase}
          onSwapBaseB={handleSwapTeamBBase}
          disabled={needsToss}
        />
      )}

      {/* Primary Scoring Action Buttons (Directly below 2D court diagram) */}
      {isLiveOrScheduled && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={handlePoint}
              disabled={needsToss}
              className={`font-display text-2xl sm:text-3xl tracking-widest py-4 sm:py-6 transition-all ${needsToss
                ? "bg-pickle/30 text-sand/40 cursor-not-allowed"
                : "bg-pickle text-sand active:scale-[0.97] hover:opacity-90 cursor-pointer shadow-lg shadow-pickle/20"
                }`}
            >
              Point Scored
            </button>

            <button
              onClick={handleSideOut}
              disabled={needsToss}
              className={`font-display text-2xl sm:text-3xl tracking-widest py-4 sm:py-6 transition-all ${needsToss
                ? "bg-brick/30 text-sand/40 cursor-not-allowed"
                : "bg-brick text-sand active:scale-[0.97] hover:bg-brick-deep cursor-pointer shadow-lg shadow-brick/20"
                }`}
            >
              Side Out
            </button>
          </div>

          {/* Tactical and Management Controls */}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-xs">
            <button
              onClick={handleUndo}
              disabled={s.rallies.length === 0}
              className={`py-2.5 border font-bold uppercase tracking-wider transition-all ${s.rallies.length > 0
                ? "border-sand/40 bg-charcoal text-sand hover:border-sand hover:bg-black/40 cursor-pointer shadow-sm"
                : "border-border/40 bg-charcoal/40 text-sand/30 cursor-not-allowed"
                }`}
            >
              Undo Point {s.rallies.length > 0 ? `(${s.rallies.length})` : ""}
            </button>

            <button
              onClick={handleToggleCourtSides}
              disabled={needsToss}
              title="Change court sides for players (Switch ends)"
              className="py-2.5 border border-border bg-charcoal text-sand font-semibold uppercase tracking-wider hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
            >
              Change Sides
            </button>

            <button
              onClick={() => setShowCourtSideModal(true)}
              title="Relocate this match to another facility court or flip player sides"
              className="py-2.5 border border-border bg-charcoal text-sand font-semibold uppercase tracking-wider hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
            >
              Change Court
            </button>

            <button
              onClick={handleSwapServerNumber}
              disabled={needsToss}
              title="Toggle between Server 1 and Server 2"
              className="py-2.5 border border-border bg-charcoal text-sand font-semibold uppercase tracking-wider hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
            >
              Swap Server #
            </button>

            <button
              onClick={handleRequestResetToss}
              title="Reset match score to 0-0 and launch coin toss"
              className="py-2.5 border border-pickle/50 bg-pickle/10 text-pickle font-bold uppercase tracking-wider hover:bg-pickle hover:text-sand transition-colors cursor-pointer"
            >
              Coin Toss (Reset)
            </button>

            <button
              onClick={() => setShowEndConfirm(true)}
              className="py-2.5 border border-brick/50 bg-brick/10 text-brick font-semibold uppercase tracking-wider hover:bg-brick/20 transition-colors cursor-pointer col-span-2 sm:col-span-1"
            >
              End Match
            </button>
          </div>

          {/* Official Timeouts */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => handleStartTimeout(leftTeam)}
              disabled={needsToss || timeoutActive}
              className="flex-1 py-2 text-[0.65rem] font-bold uppercase tracking-wider border-2 border-border bg-card text-foreground hover:border-pickle hover:text-pickle transition-colors cursor-pointer rounded"
            >
              Timeout {leftTeamName} (60s)
            </button>
            <button
              onClick={() => handleStartTimeout(rightTeam)}
              disabled={needsToss || timeoutActive}
              className="flex-1 py-2 text-[0.65rem] font-bold uppercase tracking-wider border-2 border-border bg-card text-foreground hover:border-pickle hover:text-pickle transition-colors cursor-pointer rounded"
            >
              Timeout {rightTeamName} (60s)
            </button>
          </div>
        </div>
      )}

      {/* Court & Player Sides Settings Modal (Triggered by Side Button or Change Controls) */}
      {showCourtSideModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/95 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="surface-card border-2 border-pickle max-w-md w-full p-5 sm:p-6 space-y-5 bg-card">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-pickle block">
                  Umpire Match Setup
                </span>
                <h3 className="font-display text-2xl text-foreground mt-0.5">
                  Court &amp; Player Sides
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCourtSideModal(false)}
                className="text-foreground/70 hover:text-foreground text-sm font-mono font-bold px-2.5 py-1.5 border border-border hover:border-pickle rounded cursor-pointer transition-colors"
                aria-label="Close"
              >
                Close
              </button>
            </div>

            {/* Option 1: Change Player Sides (Switch Ends) */}
            <div className="p-3.5 bg-charcoal rounded-lg border border-border/80 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-sand">
                  1. Player Court Sides
                </span>
                <span className="text-[0.62rem] font-mono px-2 py-0.5 rounded bg-pickle/20 text-pickle border border-pickle/40">
                  {teamASide === "left" ? "Team A Left / Team B Right" : "Team B Left / Team A Right"}
                </span>
              </div>
              <p className="text-xs text-sand/80">
                Adjust the 2D court diagram and scoreboard to mirror your physical vantage point from the umpire chair.
              </p>
              <div className="flex items-center justify-between gap-2 p-2 bg-black/40 border border-sand/20 rounded text-xs font-mono">
                <div className="flex-1 text-center">
                  <span className="text-[0.6rem] uppercase tracking-wider text-sand/60 block">Left Side</span>
                  <span className="font-bold text-pickle truncate block">{leftTeamName}</span>
                </div>
                <span className="text-sand/40 font-bold">&harr;</span>
                <div className="flex-1 text-center">
                  <span className="text-[0.6rem] uppercase tracking-wider text-sand/60 block">Right Side</span>
                  <span className="font-bold text-brick truncate block">{rightTeamName}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  handleToggleCourtSides();
                }}
                disabled={needsToss}
                className="w-full py-2.5 bg-charcoal border-2 border-pickle text-sand font-mono font-bold text-xs uppercase tracking-wider hover:bg-pickle hover:text-sand transition-all cursor-pointer shadow-sm flex items-center justify-center gap-2"
              >
                <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                  <path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z" />
                </svg>
                Switch Ends ({teamASide === "left" ? "Flip to B | A" : "Flip to A | B"})
              </button>
            </div>

            {/* Option 2: Change Court Facility */}
            <div className="p-3.5 bg-charcoal rounded-lg border border-border/80 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-sand">
                  2. Court Facility
                </span>
                <span className="text-[0.62rem] font-mono px-2 py-0.5 rounded bg-sand/20 text-sand border border-sand/30 font-bold">
                  Current: {match.court}
                </span>
              </div>
              <p className="text-xs text-sand/80">
                Relocate this live match to another facility court station:
              </p>
              <div className="grid grid-cols-2 gap-2">
                {FACILITY_COURTS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      handleChangeCourt(c);
                    }}
                    className={`py-2 px-3 rounded font-mono font-bold text-xs uppercase tracking-wider border-2 transition-all cursor-pointer text-center ${match.court === c
                        ? "border-pickle bg-pickle text-sand shadow-sm"
                        : "border-border bg-card text-foreground hover:border-pickle hover:text-pickle"
                      }`}
                  >
                    {c} {match.court === c ? "(Current)" : ""}
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-1 flex justify-end">
              <button
                type="button"
                onClick={() => setShowCourtSideModal(false)}
                className="w-full sm:w-auto px-5 py-2 text-xs font-bold uppercase tracking-widest bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer text-center"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* End Game Confirmation Modal Pop-up Card */}
      {showEndConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/90 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="surface-card bg-card border-2 border-brick max-w-md w-full p-6 sm:p-7 rounded-xl shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 relative text-left">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-brick block">
                  Match Finalization
                </span>
                <h3 className="font-display text-2xl sm:text-3xl text-foreground mt-0.5">
                  Finalize this match?
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowEndConfirm(false)}
                className="text-muted-foreground hover:text-foreground p-1 cursor-pointer transition-colors"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            {/* Scorecard Summary Box */}
            <div className="p-4 rounded-lg border-2 border-border bg-background space-y-3">
              <div className="flex items-center justify-between text-xs font-mono text-muted-foreground uppercase">
                <span className="font-bold text-foreground">{match.court || "Court"}</span>
                <span>{match.stage || "Match Play"}</span>
              </div>

              <div className="flex items-center justify-between gap-3 text-center py-1">
                {/* Team A */}
                <div className={`flex-1 p-2 rounded-lg ${s.teamAScore > s.teamBScore ? "bg-pickle/15 ring-2 ring-pickle/40" : "bg-card border border-border"}`}>
                  <span className="font-bold text-xs sm:text-sm text-foreground block truncate" title={match.teamAName}>
                    {match.teamAName}
                  </span>
                  <span className={`font-display text-3xl sm:text-4xl block mt-1 ${s.teamAScore > s.teamBScore ? "text-pickle font-bold" : "text-foreground"}`}>
                    {s.teamAScore}
                  </span>
                </div>

                <span className="font-display text-xl text-muted-foreground">VS</span>

                {/* Team B */}
                <div className={`flex-1 p-2 rounded-lg ${s.teamBScore > s.teamAScore ? "bg-pickle/15 ring-2 ring-pickle/40" : "bg-card border border-border"}`}>
                  <span className="font-bold text-xs sm:text-sm text-foreground block truncate" title={match.teamBName}>
                    {match.teamBName}
                  </span>
                  <span className={`font-display text-3xl sm:text-4xl block mt-1 ${s.teamBScore > s.teamAScore ? "text-pickle font-bold" : "text-foreground"}`}>
                    {s.teamBScore}
                  </span>
                </div>
              </div>

              {/* Declared Winner Banner */}
              <div className="text-center pt-2 border-t border-border/60">
                {s.teamAScore !== s.teamBScore ? (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-pickle/15 text-pickle text-xs font-bold uppercase tracking-wider">
                    <Trophy size={14} />
                    <span>
                      Declared Winner: {s.teamAScore > s.teamBScore ? match.teamAName : match.teamBName}
                    </span>
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted text-muted-foreground text-xs font-bold uppercase tracking-wider">
                    <AlertTriangle size={14} />
                    <span>Match is Tied ({s.teamAScore} - {s.teamBScore})</span>
                  </div>
                )}
              </div>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              Confirming will declare the winner, record final scores in Supabase, and vacate {match.court}.
            </p>

            {/* Buttons */}
            <div className="flex flex-col sm:flex-row gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowEndConfirm(false)}
                className="w-full sm:flex-1 py-3 px-4 border border-border text-foreground font-display text-lg tracking-wider hover:border-foreground/50 transition-colors cursor-pointer rounded-lg text-center order-2 sm:order-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleEndGame}
                className="w-full sm:flex-1 bg-brick text-sand font-display text-lg tracking-wider py-3 px-4 hover:bg-brick-deep transition-colors cursor-pointer rounded-lg shadow-md text-center order-1 sm:order-2"
              >
                Confirm End Match
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Toss Confirmation Dialog */}
      {showResetTossConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/90 backdrop-blur-sm p-4">
          <div className="surface-card border-2 border-pickle/60 max-w-sm w-full p-6 space-y-4">
            <div>
              <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-pickle block">
                Pre-Match Reset
              </span>
              <h3 className="font-display text-2xl text-foreground mt-1">
                Reset Match & Toss Coin?
              </h3>
            </div>
            <p className="text-sm text-foreground/80">
              This will reset the score to 0-0 for <strong>{match.teamAName}</strong> vs <strong>{match.teamBName}</strong>, clear all rally history, and launch the pre-match coin toss.
            </p>
            <div className="flex gap-3 justify-end pt-2">
              <button
                type="button"
                onClick={() => setShowResetTossConfirm(false)}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest border border-border text-foreground hover:border-foreground/50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeResetToss}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer"
              >
                Reset & Toss Coin
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rally Log */}
      <div className="surface-card p-0 overflow-hidden border border-border">
        <div className="bg-charcoal px-4 py-3 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-widest text-sand">
            Rally Log
          </span>
          <span className="text-[0.65rem] font-mono text-sand/90 font-bold">
            {s.rallies.length} events
          </span>
        </div>

        <div className="max-h-56 overflow-y-auto divide-y divide-border/60">
          {s.rallies.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-foreground/80">
              No rallies recorded yet. Score a point or side out to begin event logging.
            </div>
          ) : (
            [...s.rallies].reverse().map((rally, idx) => (
              <div
                key={rally.id}
                className={`px-4 py-2.5 flex items-center justify-between gap-3 text-xs ${idx === 0 ? "bg-pickle/5" : ""
                  }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${rally.type === "point"
                      ? "bg-pickle"
                      : rally.type === "end_game"
                        ? "bg-brick"
                        : "bg-foreground/50"
                      }`}
                  />
                  <span className="text-foreground truncate">{rally.description}</span>
                </div>
                <span className="font-mono text-foreground font-medium whitespace-nowrap flex-shrink-0">
                  {rally.scoreSnapshot[0]}-{rally.scoreSnapshot[1]}-{rally.scoreSnapshot[2]}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Switch Match selector at bottom: only other dispatched matches */}
      {dispatchedMatches.length > 1 && (
        <div className="border-t border-border pt-4">
          <span className="block text-[0.65rem] uppercase tracking-[0.2em] font-bold text-foreground mb-3">
            Quick Switch Match
          </span>
          <div className="flex flex-wrap gap-2">
            {dispatchedMatches.map((m) => (
              <button
                key={m.id}
                onClick={() => onSelectMatch(m.id)}
                className={`px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest border transition-colors cursor-pointer font-mono inline-flex items-center gap-1.5 ${m.id === match.id
                  ? "border-pickle bg-pickle/20 text-pickle shadow-sm"
                  : "border-border bg-charcoal text-sand hover:border-foreground/60"
                  }`}
              >
                <span>{m.court}</span>
                <span className="opacity-70 truncate max-w-[120px]">
                  {m.teamAName} vs {m.teamBName}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   TAB 2: MATCH RESULTS (ACTIVE EVENT ARCHIVE)
═══════════════════════════════════════════════ */

function UmpireMatchResults({
  matches,
  activeTournament,
  onSelectMatch,
}: {
  matches: LiveMatch[];
  activeTournament?: any;
  onSelectMatch: (id: string) => void;
}) {
  const [courtFilter, setCourtFilter] = useState<string>("all");
  const [bracketFilter, setBracketFilter] = useState<string>("all");

  const completedMatches = useMemo(() => {
    return matches
      .filter((m) => m.status === "final")
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  }, [matches]);

  const uniqueStages = useMemo(() => {
    const set = new Set<string>();
    for (const m of completedMatches) {
      if (m.stage) set.add(m.stage);
    }
    return Array.from(set);
  }, [completedMatches]);

  const filteredMatches = useMemo(() => {
    return completedMatches.filter((m) => {
      if (courtFilter !== "all" && m.court !== courtFilter) return false;
      if (bracketFilter !== "all" && m.stage !== bracketFilter) return false;
      return true;
    });
  }, [completedMatches, courtFilter, bracketFilter]);

  return (
    <div className="space-y-6 font-sans">
      {/* Header */}
      <div className="border-b-2 border-border pb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <span className="text-xs font-bold uppercase tracking-wider text-pickle font-sans block">
            Event Match Archive
          </span>
          <h2 className="font-display text-3xl sm:text-4xl text-foreground tracking-wide mt-1">
            Match Results
          </h2>
          <p className="text-sm text-foreground/80 font-medium mt-1">
            Official scores and match history for {activeTournament?.name || "the active event"}. Past event matches are excluded.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-sans font-bold text-foreground px-3.5 py-1.5 bg-card border-2 border-border shadow-sm">
            <span className="text-pickle font-black mr-1.5">{completedMatches.length}</span>
            Matches Concluded
          </span>
        </div>
      </div>

      {/* Filters Bar */}
      {completedMatches.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 bg-charcoal p-3.5 border-2 border-border/80 shadow-sm">
          {/* Court Filter */}
          <div className="flex items-center gap-2 overflow-x-auto">
            <span className="text-xs font-bold uppercase tracking-wider text-sand mr-1 shrink-0 font-sans">
              Court:
            </span>
            {["all", "Court 1", "Court 2", "Court 3", "Court 4"].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCourtFilter(c)}
                className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer font-sans ${courtFilter === c
                    ? "bg-pickle text-sand shadow-sm"
                    : "bg-charcoal text-sand/80 hover:text-white border border-white/20 hover:border-white/40"
                  }`}
              >
                {c === "all" ? "All Courts" : c}
              </button>
            ))}
          </div>

          {/* Bracket Filter */}
          {uniqueStages.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto">
              <span className="text-xs font-bold uppercase tracking-wider text-sand mr-1 shrink-0 font-sans">
                Bracket:
              </span>
              <button
                type="button"
                onClick={() => setBracketFilter("all")}
                className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer font-sans ${bracketFilter === "all"
                    ? "bg-pickle text-sand shadow-sm"
                    : "bg-charcoal text-sand/80 hover:text-white border border-white/20 hover:border-white/40"
                  }`}
              >
                All
              </button>
              {uniqueStages.map((stg) => (
                <button
                  key={stg}
                  type="button"
                  onClick={() => setBracketFilter(stg)}
                  className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-all cursor-pointer font-sans ${bracketFilter === stg
                      ? "bg-pickle text-sand shadow-sm"
                      : "bg-charcoal text-sand/80 hover:text-white border border-white/20 hover:border-white/40"
                    }`}
                >
                  {stg.replace(" (Pool Play)", "")}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Results Grid */}
      {filteredMatches.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredMatches.map((m) => (
            <div
              key={m.id}
              className="bg-card p-4 border-2 border-border flex flex-col justify-between space-y-4 shadow-sm hover:border-pickle/60 transition-colors"
            >
              {/* Card Header */}
              <div className="flex items-center justify-between border-b-2 border-border/60 pb-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-bold uppercase tracking-wider text-foreground font-sans">
                    {m.court}
                  </span>
                  {m.stage && (
                    <span className="text-xs font-bold text-pickle bg-pickle/15 px-2 py-0.5 border border-pickle/30 truncate font-sans">
                      {m.stage}
                    </span>
                  )}
                </div>
                <span className="text-[0.65rem] font-bold uppercase tracking-wider bg-brick/15 border border-brick/40 text-brick px-2 py-0.5 font-sans">
                  Final
                </span>
              </div>

              {/* Matchup & Scores */}
              <div className="space-y-2.5">
                {/* Team A */}
                <div
                  className={`p-3 border-2 transition-colors flex items-center justify-between ${m.winnerTeam === m.teamAName
                      ? "bg-pickle/10 border-pickle/50"
                      : "bg-muted/40 border-border/60"
                    }`}
                >
                  <div className="min-w-0 mr-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className={`block text-sm font-bold truncate font-sans ${m.winnerTeam === m.teamAName ? "text-pickle" : "text-foreground"
                          }`}
                      >
                        {m.teamAName}
                      </span>
                      {m.winnerTeam === m.teamAName && (
                        <span className="text-[0.6rem] font-bold uppercase tracking-wider bg-pickle text-sand px-1.5 py-0.2 shrink-0 font-sans">
                          Winner
                        </span>
                      )}
                    </div>
                    <span className="block text-xs text-foreground/80 font-medium truncate mt-0.5 font-sans">
                      {m.teamAPlayers.join(" / ")}
                    </span>
                    {m.teamAClub && (
                      <span className="inline-block mt-1 text-[0.6rem] font-bold px-2 py-0.5 bg-card text-foreground border border-border uppercase tracking-wider font-sans">
                        {m.teamAClub}
                      </span>
                    )}
                  </div>
                  <span
                    className={`font-display text-3xl font-bold ${m.winnerTeam === m.teamAName ? "text-pickle" : "text-foreground"
                      }`}
                  >
                    {m.score.teamAScore}
                  </span>
                </div>

                {/* Team B */}
                <div
                  className={`p-3 border-2 transition-colors flex items-center justify-between ${m.winnerTeam === m.teamBName
                      ? "bg-pickle/10 border-pickle/50"
                      : "bg-muted/40 border-border/60"
                    }`}
                >
                  <div className="min-w-0 mr-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className={`block text-sm font-bold truncate font-sans ${m.winnerTeam === m.teamBName ? "text-pickle" : "text-foreground"
                          }`}
                      >
                        {m.teamBName}
                      </span>
                      {m.winnerTeam === m.teamBName && (
                        <span className="text-[0.6rem] font-bold uppercase tracking-wider bg-pickle text-sand px-1.5 py-0.2 shrink-0 font-sans">
                          Winner
                        </span>
                      )}
                    </div>
                    <span className="block text-xs text-foreground/80 font-medium truncate mt-0.5 font-sans">
                      {m.teamBPlayers.join(" / ")}
                    </span>
                    {m.teamBClub && (
                      <span className="inline-block mt-1 text-[0.6rem] font-bold px-2 py-0.5 bg-card text-foreground border border-border uppercase tracking-wider font-sans">
                        {m.teamBClub}
                      </span>
                    )}
                  </div>
                  <span
                    className={`font-display text-3xl font-bold ${m.winnerTeam === m.teamBName ? "text-pickle" : "text-foreground"
                      }`}
                  >
                    {m.score.teamBScore}
                  </span>
                </div>
              </div>

              {/* Card Footer: Official + Actions */}
              <div className="pt-2 border-t-2 border-border/50 flex items-center justify-between text-xs font-sans">
                <div className="text-xs text-foreground/80 font-medium">
                  <span>Official: </span>
                  <span className="font-bold text-foreground">{m.officiatedBy || "Unassigned"}</span>
                </div>
                <button
                  type="button"
                  onClick={() => onSelectMatch(m.id)}
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer shadow-sm font-sans"
                >
                  View Details &rarr;
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-card p-12 text-center border-2 border-dashed border-border shadow-sm font-sans">
          <span className="text-sm font-bold uppercase tracking-wider text-foreground block">
            {courtFilter !== "all" || bracketFilter !== "all"
              ? "No Matches Found For Selected Filters"
              : "No Completed Matches Yet"}
          </span>
          <p className="text-xs text-foreground/80 font-medium mt-1.5 max-w-sm mx-auto leading-relaxed">
            {courtFilter !== "all" || bracketFilter !== "all"
              ? "Try resetting your court or bracket filter above to see all results."
              : "Official match results for this active event will be archived here once matches conclude."}
          </p>
          {(courtFilter !== "all" || bracketFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setCourtFilter("all");
                setBracketFilter("all");
              }}
              className="mt-4 px-4 py-1.5 text-xs font-bold uppercase tracking-wider bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer font-sans"
            >
              Reset Filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   MODAL: QUICK MATCH DISPATCH
═══════════════════════════════════════════════ */

function QuickMatchModal({
  defaultCourt,
  currentUmpire,
  tournaments,
  matches,
  initialTournamentSlug,
  onClose,
  onCreated,
}: {
  defaultCourt: FacilityCourt;
  currentUmpire: string;
  tournaments: any[];
  matches: LiveMatch[];
  initialTournamentSlug?: string;
  onClose: () => void;
  onCreated: (matchId: string) => void;
}) {
  const [court, setCourt] = useState<FacilityCourt>(defaultCourt);
  const [selectedTournament, setSelectedTournament] = useState<string>(initialTournamentSlug || "");
  const [selectedMatchId, setSelectedMatchId] = useState<string>("");
  const [teamAName, setTeamAName] = useState("");
  const [teamAPlayer1, setTeamAPlayer1] = useState("");
  const [teamAPlayer2, setTeamAPlayer2] = useState("");
  const [teamBName, setTeamBName] = useState("");
  const [teamBPlayer1, setTeamBPlayer1] = useState("");
  const [teamBPlayer2, setTeamBPlayer2] = useState("");
  const [matchStage, setMatchStage] = useState<string>("");
  const [startImmediately, setStartImmediately] = useState(true);
  const [isManualCustom, setIsManualCustom] = useState(false);

  // Available drawn matches for this tournament or all tournaments
  const availableMatches = useMemo(() => {
    return matches.filter((m) => {
      if (m.status === "final") return false;
      if (selectedTournament && m.tournamentSlug && m.tournamentSlug !== selectedTournament) return false;
      if (m.officiatedBy && m.officiatedBy !== currentUmpire) return false;
      return Boolean(m.teamAName && m.teamBName);
    });
  }, [matches, selectedTournament, currentUmpire]);

  // Handler when a drawn bracket match is selected from the dropdown
  const handleSelectBracketMatch = (matchId: string) => {
    setSelectedMatchId(matchId);
    if (!matchId) {
      setMatchStage("");
      return;
    }
    const target = availableMatches.find((m) => m.id === matchId);
    if (target) {
      setTeamAName(target.teamAName);
      setTeamAPlayer1(target.teamAPlayers[0] || "");
      setTeamAPlayer2(target.teamAPlayers[1] || "");
      setTeamBName(target.teamBName);
      setTeamBPlayer1(target.teamBPlayers[0] || "");
      setTeamBPlayer2(target.teamBPlayers[1] || "");
      setMatchStage(target.stage || "");
      if (target.tournamentSlug) {
        setSelectedTournament(target.tournamentSlug);
      }
    }
  };

  // Auto-pick next queued match
  const handleAutoPickNext = () => {
    const nextQueued = availableMatches.find((m) => m.court === "Queue" || m.status === "scheduled");
    if (nextQueued) {
      handleSelectBracketMatch(nextQueued.id);
      setIsManualCustom(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamAName.trim() || !teamBName.trim()) return;

    const matchId = (!isManualCustom && selectedMatchId)
      ? selectedMatchId
      : `match-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const teamAPlayers = [teamAPlayer1.trim(), teamAPlayer2.trim()].filter(Boolean);
    const teamBPlayers = [teamBPlayer1.trim(), teamBPlayer2.trim()].filter(Boolean);

    dispatchMatchToCourt(
      court,
      {
        id: matchId,
        tournamentSlug: selectedTournament || undefined,
        teamAName: teamAName.trim(),
        teamAPlayers: teamAPlayers.length > 0 ? teamAPlayers : [teamAName.trim()],
        teamBName: teamBName.trim(),
        teamBPlayers: teamBPlayers.length > 0 ? teamBPlayers : [teamBName.trim()],
      },
      currentUmpire,
      startImmediately
    );

    onCreated(matchId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/95 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="surface-card border-2 border-pickle max-w-lg w-full p-6 sm:p-8 space-y-5 my-8">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-pickle block">
                Courtside Dispatch
              </span>
              <span className="text-[0.55rem] uppercase tracking-wider font-semibold px-1.5 py-0.5 bg-pickle/20 text-pickle border border-pickle/40 rounded">
                Admin Bracket Sync
              </span>
            </div>
            <h3 className="font-display text-2xl text-foreground mt-0.5">
              Launch &amp; Officiate Match
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-sand/60 hover:text-sand text-lg font-bold font-mono px-2 py-1 cursor-pointer"
          >
            [X]
          </button>
        </div>

        {/* Drawn Bracket Selection vs Manual Toggle */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-widest text-foreground font-mono">
              Auto-Fill from Drawn Brackets
            </span>
            <button
              type="button"
              onClick={() => {
                setIsManualCustom(!isManualCustom);
                if (!isManualCustom) {
                  setSelectedMatchId("");
                  setMatchStage("");
                }
              }}
              className="text-[0.65rem] font-bold uppercase tracking-wider text-pickle hover:underline cursor-pointer"
            >
              {isManualCustom ? "Use Drawn Brackets" : "Enter Custom Match"}
            </button>
          </div>

          {!isManualCustom && (
            <div className="surface-card p-3 border border-pickle/40 bg-pickle/5 space-y-2.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <label className="text-[0.65rem] uppercase tracking-wider font-bold text-pickle">
                  Select Drawn Match
                </label>
                {availableMatches.length > 0 && (
                  <button
                    type="button"
                    onClick={handleAutoPickNext}
                    className="text-[0.65rem] font-bold uppercase tracking-wider px-2 py-1 bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer w-fit"
                  >
                    Auto-Pick Next in Queue
                  </button>
                )}
              </div>

              {availableMatches.length > 0 ? (
                <select
                  value={selectedMatchId}
                  onChange={(e) => handleSelectBracketMatch(e.target.value)}
                  className="w-full bg-charcoal border border-pickle/50 text-sand px-3 py-2 text-xs font-semibold focus:border-pickle focus:outline-none"
                >
                  <option value="">-- Choose a match from drawn brackets --</option>
                  {availableMatches.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.stage ? `[${m.stage}] ` : ""}{m.teamAName} vs {m.teamBName} ({m.court})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-xs text-foreground/70 py-1">
                  No scheduled matches found for this tournament yet. Draw brackets in Admin or switch to custom entry below.
                </div>
              )}

              {matchStage && (
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-[0.65rem] uppercase tracking-wider text-foreground/70 font-semibold">
                    Category / Stage:
                  </span>
                  <span className="text-[0.65rem] font-bold uppercase tracking-wider px-2 py-0.5 bg-pickle/20 text-pickle border border-pickle/40">
                    {matchStage}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Court & Tournament Selection */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[0.65rem] uppercase tracking-wider text-foreground/70 font-bold mb-1">
                Assigned Court
              </label>
              <select
                value={court}
                onChange={(e) => setCourt(e.target.value as FacilityCourt)}
                className="w-full bg-charcoal border border-border text-sand px-3 py-2 focus:border-pickle focus:outline-none font-semibold"
              >
                {FACILITY_COURTS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[0.65rem] uppercase tracking-wider text-foreground/70 font-bold mb-1">
                Tournament
              </label>
              <select
                value={selectedTournament}
                onChange={(e) => setSelectedTournament(e.target.value)}
                className="w-full bg-charcoal border border-border text-sand px-3 py-2 focus:border-pickle focus:outline-none"
              >
                <option value="">Exhibition / Facility Match</option>
                {tournaments.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Team A */}
          <div className="space-y-2 p-3 bg-card border-2 border-border rounded">
            <div className="flex items-center justify-between">
              <label className="block text-[0.65rem] uppercase tracking-wider text-pickle font-bold">
                Team A
              </label>
              {selectedMatchId && !isManualCustom && (
                <span className="text-[0.6rem] uppercase tracking-wider text-pickle font-mono font-semibold">
                  Auto-Filled
                </span>
              )}
            </div>
            <input
              type="text"
              required
              placeholder="Team A Name"
              value={teamAName}
              onChange={(e) => setTeamAName(e.target.value)}
              className="w-full bg-charcoal border border-border text-sand px-3 py-1.5 focus:border-pickle focus:outline-none font-medium"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="Player 1"
                value={teamAPlayer1}
                onChange={(e) => setTeamAPlayer1(e.target.value)}
                className="w-full bg-charcoal border border-border text-sand px-2.5 py-1 focus:border-pickle focus:outline-none"
              />
              <input
                type="text"
                placeholder="Player 2"
                value={teamAPlayer2}
                onChange={(e) => setTeamAPlayer2(e.target.value)}
                className="w-full bg-charcoal border border-border text-sand px-2.5 py-1 focus:border-pickle focus:outline-none"
              />
            </div>
          </div>

          {/* Team B */}
          <div className="space-y-2 p-3 bg-card border-2 border-border rounded">
            <div className="flex items-center justify-between">
              <label className="block text-[0.65rem] uppercase tracking-wider text-brick font-bold">
                Team B
              </label>
              {selectedMatchId && !isManualCustom && (
                <span className="text-[0.6rem] uppercase tracking-wider text-pickle font-mono font-semibold">
                  Auto-Filled
                </span>
              )}
            </div>
            <input
              type="text"
              required
              placeholder="Team B Name"
              value={teamBName}
              onChange={(e) => setTeamBName(e.target.value)}
              className="w-full bg-charcoal border border-border text-sand px-3 py-1.5 focus:border-pickle focus:outline-none font-medium"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="Player 1"
                value={teamBPlayer1}
                onChange={(e) => setTeamBPlayer1(e.target.value)}
                className="w-full bg-charcoal border border-border text-sand px-2.5 py-1 focus:border-pickle focus:outline-none"
              />
              <input
                type="text"
                placeholder="Player 2"
                value={teamBPlayer2}
                onChange={(e) => setTeamBPlayer2(e.target.value)}
                className="w-full bg-charcoal border border-border text-sand px-2.5 py-1 focus:border-pickle focus:outline-none"
              />
            </div>
          </div>

          {/* Mode toggle */}
          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="startImmediately"
              checked={startImmediately}
              onChange={(e) => setStartImmediately(e.target.checked)}
              className="accent-pickle h-4 w-4 cursor-pointer"
            />
            <label htmlFor="startImmediately" className="text-foreground/80 font-medium cursor-pointer">
              Launch directly into Live scoring (otherwise set to Scheduled warm-up)
            </label>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-3">
            <button
              type="submit"
              className="flex-1 py-3 bg-pickle text-sand font-display text-lg tracking-widest hover:opacity-90 transition-opacity cursor-pointer text-center"
            >
              Dispatch to {court}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-3 border border-border text-foreground font-display text-lg tracking-widest hover:border-foreground/50 transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SUB-COMPONENT: COIN TOSS OVERLAY
═══════════════════════════════════════════════ */

type TossPhase = "idle" | "flipping" | "result" | "choosing" | "positioning" | "done";

function CoinTossOverlay({
  teamAName,
  teamBName,
  teamAPlayers = [],
  teamBPlayers = [],
  initialTeamABase1,
  initialTeamBBase1,
  onDone,
  onClose,
}: {
  teamAName: string;
  teamBName: string;
  teamAPlayers?: string[] | undefined;
  teamBPlayers?: string[] | undefined;
  initialTeamABase1?: string | undefined;
  initialTeamBBase1?: string | undefined;
  onDone: (
    servingTeam: "A" | "B",
    winnerTeam?: "A" | "B" | undefined,
    bases?: { teamABase1?: string; teamBBase1?: string } | undefined
  ) => void;
  onClose?: (() => void) | undefined;
}) {
  const [phase, setPhase] = useState<TossPhase>("idle");
  const [face, setFace] = useState<"heads" | "tails">("heads");
  const [callingTeam, setCallingTeam] = useState<"A" | "B">("A");
  const [callingChoice, setCallingChoice] = useState<"heads" | "tails">("heads");
  const [winnerTeam, setWinnerTeam] = useState<"A" | "B" | null>(null);
  const [choosingTeam, setChoosingTeam] = useState<"A" | "B" | null>(null);
  const [chosenServingTeam, setChosenServingTeam] = useState<"A" | "B">("A");

  const rawA = teamAPlayers && teamAPlayers.length > 0 ? teamAPlayers : [teamAName || "Player A1"];
  const rawB = teamBPlayers && teamBPlayers.length > 0 ? teamBPlayers : [teamBName || "Player B1"];

  const [teamABase1, setTeamABase1] = useState<string>(() => {
    if (initialTeamABase1 && rawA.includes(initialTeamABase1)) return initialTeamABase1;
    return rawA[0] || "Player A1";
  });
  const [teamBBase1, setTeamBBase1] = useState<string>(() => {
    if (initialTeamBBase1 && rawB.includes(initialTeamBBase1)) return initialTeamBBase1;
    return rawB[0] || "Player B1";
  });

  const teamABase2 = rawA.find((p) => p !== teamABase1) || rawA[1] || rawA[0] || "Player A2";
  const teamBBase2 = rawB.find((p) => p !== teamBBase1) || rawB[1] || rawB[0] || "Player B2";

  const flipRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const callingTeamName = callingTeam === "A" ? teamAName : teamBName;
  const otherTeamName = callingTeam === "A" ? teamBName : teamAName;
  const otherChoice = callingChoice === "heads" ? "tails" : "heads";

  const startToss = () => {
    setPhase("flipping");
    setFace("heads");
    let count = 0;
    const totalFlips = 18 + Math.floor(Math.random() * 10);
    flipRef.current = setInterval(() => {
      count++;
      setFace((f) => (f === "heads" ? "tails" : "heads"));
      if (count >= totalFlips) {
        if (flipRef.current) clearInterval(flipRef.current);
        const landedFace: "heads" | "tails" = count % 2 === 0 ? "heads" : "tails";
        setFace(landedFace);
        const winner: "A" | "B" =
          landedFace === callingChoice
            ? callingTeam
            : callingTeam === "A"
              ? "B"
              : "A";
        setWinnerTeam(winner);
        setChoosingTeam(winner);
        setPhase("result");
      }
    }, 90);
  };

  const handleChoice = (choice: "serve" | "receive") => {
    const serving: "A" | "B" =
      choice === "serve" ? (choosingTeam ?? "A") : choosingTeam === "A" ? "B" : "A";
    setChosenServingTeam(serving);
    setPhase("positioning");
  };

  const handleConfirmPositions = () => {
    setPhase("done");
    setTimeout(() => {
      onDone(chosenServingTeam, winnerTeam ?? undefined, {
        teamABase1,
        teamBBase1,
      });
    }, 400);
  };

  const winnerName = winnerTeam === "A" ? teamAName : teamBName;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/96 backdrop-blur-sm p-4">
      <div
        className={`surface-card border-2 border-pickle/50 w-full p-5 sm:p-6 space-y-4 text-center relative max-h-[92vh] overflow-y-auto transition-all ${phase === "positioning" ? "max-w-lg" : "max-w-sm"
          }`}
      >
        <div className="flex items-center justify-between border-b border-border/40 pb-2">
          <span className="block text-[0.6rem] uppercase tracking-[0.3em] font-bold text-pickle">
            Pre-Match Officiating
          </span>
          {onClose && (
            <button
              onClick={onClose}
              className="text-xs font-bold uppercase tracking-wider text-foreground/80 hover:text-foreground transition-colors px-2.5 py-0.5 border border-border hover:border-foreground cursor-pointer font-sans"
            >
              Skip
            </button>
          )}
        </div>
        <div>
          <h2 className="font-display text-2xl sm:text-3xl text-foreground">
            {phase === "positioning" ? "Player Positions" : "Coin Toss"}
          </h2>
          <p className="text-xs text-foreground/70 mt-0.5 font-medium truncate">
            {teamAName} vs {teamBName}
          </p>
        </div>

        {/* Coin representation (hidden during positioning phase to preserve focus and space) */}
        {phase !== "positioning" && (
          <div className="flex flex-col items-center gap-1.5">
            <div
              className={`relative h-24 w-24 sm:h-28 sm:w-28 rounded-full overflow-hidden select-none ${phase === "flipping"
                  ? "coin-flip"
                  : phase === "result" || phase === "choosing"
                    ? "coin-land"
                    : phase === "done"
                      ? "opacity-0 scale-90 transition-all duration-500"
                      : ""
                }`}
              style={{ willChange: "transform" }}
            >
              <img
                src="/coin_heads.png"
                alt="Heads"
                className={`absolute inset-0 h-full w-full object-cover rounded-full transition-opacity duration-75 ${face === "heads" || phase === "idle" ? "opacity-100" : "opacity-0"
                  }`}
                draggable={false}
              />
              <img
                src="/coin_tails.png"
                alt="Tails"
                className={`absolute inset-0 h-full w-full object-cover rounded-full transition-opacity duration-75 ${face === "tails" && phase !== "idle" ? "opacity-100" : "opacity-0"
                  }`}
                draggable={false}
              />
            </div>

            {phase !== "idle" && phase !== "done" && (
              <span className="text-[0.65rem] font-bold uppercase tracking-[0.25em] text-sand font-mono bg-charcoal px-2 py-0.5 border border-border">
                {face === "heads" ? "Heads" : "Tails"}
              </span>
            )}
          </div>
        )}

        {/* Single Streamlined Prompt: Which team will choose tails or heads? */}
        {phase === "idle" && (
          <div className="space-y-3.5 pt-1">
            <div className="text-left space-y-2.5 border-2 border-border bg-card p-3 rounded-lg">
              <div>
                <span className="block text-xs sm:text-sm font-bold uppercase tracking-wider text-foreground">
                  Which team will choose tails or heads?
                </span>
                <span className="block text-[0.65rem] text-muted-foreground mt-0.5">
                  Select the calling team and their call before flipping.
                </span>
              </div>

              {/* Team Calling Selection */}
              <div className="space-y-1 pt-1">
                <span className="block text-[0.6rem] uppercase tracking-wider text-muted-foreground font-mono font-bold">
                  Calling Team
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCallingTeam("A")}
                    className={`p-2.5 text-xs font-bold uppercase tracking-wider border-2 transition-all text-center cursor-pointer truncate rounded ${callingTeam === "A"
                        ? "bg-pickle text-sand border-pickle shadow-sm"
                        : "bg-card text-foreground border-border hover:border-pickle hover:text-pickle"
                      }`}
                  >
                    {teamAName}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCallingTeam("B")}
                    className={`p-2.5 text-xs font-bold uppercase tracking-wider border-2 transition-all text-center cursor-pointer truncate rounded ${callingTeam === "B"
                        ? "bg-pickle text-sand border-pickle shadow-sm"
                        : "bg-card text-foreground border-border hover:border-pickle hover:text-pickle"
                      }`}
                  >
                    {teamBName}
                  </button>
                </div>
              </div>

              {/* Call Choice (Heads or Tails) */}
              <div className="space-y-1">
                <span className="block text-[0.6rem] uppercase tracking-wider text-muted-foreground font-mono font-bold">
                  {callingTeamName}&apos;s Call
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCallingChoice("heads")}
                    className={`p-2.5 text-xs font-bold uppercase tracking-wider border-2 transition-all text-center cursor-pointer rounded ${callingChoice === "heads"
                        ? "bg-pickle text-sand border-pickle shadow-sm"
                        : "bg-card text-foreground border-border hover:border-pickle hover:text-pickle"
                      }`}
                  >
                    Heads
                  </button>
                  <button
                    type="button"
                    onClick={() => setCallingChoice("tails")}
                    className={`p-2.5 text-xs font-bold uppercase tracking-wider border-2 transition-all text-center cursor-pointer rounded ${callingChoice === "tails"
                        ? "bg-pickle text-sand border-pickle shadow-sm"
                        : "bg-card text-foreground border-border hover:border-pickle hover:text-pickle"
                      }`}
                  >
                    Tails
                  </button>
                </div>
              </div>

              {/* Call Summary Pill */}
              <div className="p-2 bg-card border-2 border-border text-[0.65rem] text-center text-foreground font-mono leading-relaxed mt-1 rounded">
                <span className="text-pickle font-bold">{callingTeamName}</span> chose{" "}
                <span className="text-foreground font-bold uppercase tracking-wide">{callingChoice}</span>.{" "}
                <span className="text-muted-foreground">({otherTeamName} has {otherChoice})</span>
              </div>
            </div>

            <button
              onClick={startToss}
              className="w-full bg-pickle text-sand font-display text-xl tracking-widest py-3.5 hover:opacity-90 active:scale-[0.97] transition-all cursor-pointer shadow-lg shadow-pickle/20"
            >
              Flip Coin
            </button>
          </div>
        )}

        {phase === "flipping" && (
          <div className="py-3 space-y-1">
            <span className="text-xs font-bold uppercase tracking-widest text-pickle animate-pulse block font-sans">
              Flipping...
            </span>
            <span className="text-xs text-foreground/80 font-bold font-sans">
              {callingTeamName} called {callingChoice.toUpperCase()}
            </span>
          </div>
        )}

        {phase === "result" && (
          <div className="space-y-3.5 pt-1 font-sans">
            <div className="p-3 bg-pickle/15 border-2 border-pickle/40 text-center space-y-1">
              <div className="flex items-center justify-center gap-2">
                <span className="text-xs uppercase tracking-wider text-pickle font-bold">
                  Coin Landed On:
                </span>
                <span className="text-xs font-bold uppercase tracking-wider text-sand font-sans bg-charcoal px-2.5 py-0.5 border border-border">
                  {face}
                </span>
              </div>
              <span className="block text-xs uppercase tracking-wider text-foreground/70 font-bold pt-1">
                Toss Winner
              </span>
              <span className="block font-display text-2xl text-foreground font-bold">
                {winnerName}
              </span>
              <span className="block text-xs text-foreground/90 font-medium">
                {winnerName === callingTeamName
                  ? `${winnerName} called ${callingChoice} correctly!`
                  : `${winnerName} won as coin landed on ${face}!`}
              </span>
            </div>

            <div className="flex flex-col gap-2">
              <button
                onClick={() => setPhase("choosing")}
                className="w-full bg-pickle text-sand font-display text-lg tracking-widest py-3 hover:opacity-90 transition-opacity cursor-pointer shadow-md"
              >
                Select Serve or Receive
              </button>
              <button
                onClick={() => setPhase("idle")}
                className="w-full py-2 text-xs font-bold uppercase tracking-wider text-sand/70 hover:text-sand border border-border bg-charcoal transition-colors cursor-pointer"
              >
                Re-Toss
              </button>
            </div>
          </div>
        )}

        {phase === "choosing" && (
          <div className="space-y-3 pt-1">
            <div>
              <span className="text-[0.6rem] uppercase tracking-widest text-pickle font-bold block">
                Winner Choice
              </span>
              <p className="text-xs text-foreground/80 font-medium mt-0.5">
                What does <strong>{winnerName}</strong> choose?
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handleChoice("serve")}
                className="bg-pickle text-sand font-display text-lg tracking-widest py-3.5 hover:opacity-90 active:scale-[0.97] transition-all cursor-pointer shadow-md"
              >
                Serve
              </button>
              <button
                onClick={() => handleChoice("receive")}
                className="border border-border bg-charcoal text-sand font-display text-lg tracking-widest py-3.5 hover:border-sand/50 active:scale-[0.97] transition-all cursor-pointer shadow-md"
              >
                Receive
              </button>
            </div>
          </div>
        )}

        {/* Positioning Phase: Assign Base 1 (Right/Even) and Base 2 (Left/Odd) */}
        {phase === "positioning" && (
          <div className="space-y-4 pt-1 font-sans text-left">
            <div className="text-center">
              <span className="text-[0.6rem] uppercase tracking-widest text-pickle font-bold block">
                Court Starting Positions
              </span>
              <p className="text-xs text-foreground/80 font-medium mt-0.5">
                Confirm starting sides. Base 1 starts on Right (Even) court, Base 2 starts on Left (Odd) court.
              </p>
            </div>

            {/* Team A Box */}
            <div className="p-3 border-2 border-border bg-card rounded-lg space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold uppercase tracking-wider text-foreground truncate">
                  {teamAName}
                </span>
                <span
                  className={`text-[0.6rem] font-bold uppercase px-2 py-0.5 rounded font-mono shrink-0 ${chosenServingTeam === "A"
                      ? "bg-pickle text-sand"
                      : "bg-muted text-foreground border border-border"
                    }`}
                >
                  {chosenServingTeam === "A" ? "Opening Server (0-0-2)" : "Opening Receiver"}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="p-2.5 border-2 border-border bg-background rounded space-y-1">
                  <div className="flex items-center justify-between text-[0.6rem] font-mono font-bold">
                    <span className="text-muted-foreground uppercase">Right (Even)</span>
                    <span className="font-bold text-sand bg-pickle px-1.5 py-0.2 rounded">BASE 1</span>
                  </div>
                  <div className="text-sm font-bold text-foreground truncate" title={teamABase1}>
                    {teamABase1}
                  </div>
                  <span className="text-[0.65rem] text-muted-foreground block font-medium">
                    {chosenServingTeam === "A" ? "Opening server" : "Opening receiver"}
                  </span>
                </div>

                <div className="p-2.5 border-2 border-border bg-background rounded space-y-1">
                  <div className="flex items-center justify-between text-[0.6rem] font-mono font-bold">
                    <span className="text-muted-foreground uppercase">Left (Odd)</span>
                    <span className="font-bold text-sand bg-charcoal px-1.5 py-0.2 rounded border border-border">BASE 2</span>
                  </div>
                  <div className="text-sm font-bold text-foreground truncate" title={teamABase2}>
                    {teamABase2}
                  </div>
                  <span className="text-[0.65rem] text-muted-foreground block font-medium">Partner</span>
                </div>
              </div>

              {rawA.length >= 2 && (
                <button
                  type="button"
                  onClick={() => {
                    const next = rawA.find((p) => p !== teamABase1) || rawA[1] || rawA[0] || "Player A1";
                    setTeamABase1(next);
                  }}
                  className="w-full py-1.5 text-xs font-mono font-bold uppercase tracking-wider text-foreground hover:text-pickle border-2 border-border hover:border-pickle transition-colors cursor-pointer text-center rounded bg-card"
                >
                  Swap Starting Sides (Base 1 &harr; 2)
                </button>
              )}
            </div>

            {/* Team B Box */}
            <div className="p-3 border-2 border-border bg-card rounded-lg space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold uppercase tracking-wider text-foreground truncate">
                  {teamBName}
                </span>
                <span
                  className={`text-[0.6rem] font-bold uppercase px-2 py-0.5 rounded font-mono shrink-0 ${chosenServingTeam === "B"
                      ? "bg-pickle text-sand"
                      : "bg-muted text-foreground border border-border"
                    }`}
                >
                  {chosenServingTeam === "B" ? "Opening Server (0-0-2)" : "Opening Receiver"}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="p-2.5 border-2 border-border bg-background rounded space-y-1">
                  <div className="flex items-center justify-between text-[0.6rem] font-mono font-bold">
                    <span className="text-muted-foreground uppercase">Right (Even)</span>
                    <span className="font-bold text-sand bg-pickle px-1.5 py-0.2 rounded">BASE 1</span>
                  </div>
                  <div className="text-sm font-bold text-foreground truncate" title={teamBBase1}>
                    {teamBBase1}
                  </div>
                  <span className="text-[0.65rem] text-muted-foreground block font-medium">
                    {chosenServingTeam === "B" ? "Opening server" : "Opening receiver"}
                  </span>
                </div>

                <div className="p-2.5 border-2 border-border bg-background rounded space-y-1">
                  <div className="flex items-center justify-between text-[0.6rem] font-mono font-bold">
                    <span className="text-muted-foreground uppercase">Left (Odd)</span>
                    <span className="font-bold text-sand bg-charcoal px-1.5 py-0.2 rounded border border-border">BASE 2</span>
                  </div>
                  <div className="text-sm font-bold text-foreground truncate" title={teamBBase2}>
                    {teamBBase2}
                  </div>
                  <span className="text-[0.65rem] text-muted-foreground block font-medium">Partner</span>
                </div>
              </div>

              {rawB.length >= 2 && (
                <button
                  type="button"
                  onClick={() => {
                    const next = rawB.find((p) => p !== teamBBase1) || rawB[1] || rawB[0] || "Player B1";
                    setTeamBBase1(next);
                  }}
                  className="w-full py-1.5 text-xs font-mono font-bold uppercase tracking-wider text-foreground hover:text-pickle border-2 border-border hover:border-pickle transition-colors cursor-pointer text-center rounded bg-card"
                >
                  Swap Starting Sides (Base 1 &harr; 2)
                </button>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                onClick={handleConfirmPositions}
                className="w-full bg-pickle text-sand font-display text-lg tracking-widest py-3.5 hover:opacity-90 active:scale-[0.97] transition-all cursor-pointer shadow-md text-center"
              >
                Confirm Positions &amp; Start Match
              </button>
              <button
                type="button"
                onClick={() => setPhase("choosing")}
                className="w-full py-2 text-xs font-bold uppercase tracking-wider text-foreground hover:text-pickle border-2 border-border bg-card hover:bg-muted transition-colors cursor-pointer text-center"
              >
                Back to Serve / Receive
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   HELPERS & BADGES
═══════════════════════════════════════════════ */

function ScoreboardCard({
  match,
  station,
  onSelect,
}: {
  match: LiveMatch;
  station?: CourtStation | undefined;
  onSelect: () => void;
}) {
  const s = match.score;
  const isLive = match.status === "live";

  return (
    <button
      onClick={onSelect}
      className={`surface-card p-0 overflow-hidden border text-left transition-all hover:scale-[1.01] cursor-pointer ${isLive
        ? "border-pickle/60 shadow-lg shadow-pickle/10"
        : match.status === "final"
          ? "border-brick/30"
          : "border-border"
        }`}
    >
      {/* Court header */}
      <div
        className={`px-4 py-2 flex items-center justify-between ${isLive ? "bg-pickle/20" : "bg-charcoal"
          }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold uppercase tracking-widest text-sand font-mono">
            {match.court}
          </span>
          {match.stage && (
            <span className="text-[0.6rem] font-bold uppercase tracking-wider text-pickle font-mono bg-pickle/15 px-1.5 py-0.5 border border-pickle/30 truncate">
              {match.stage}
            </span>
          )}
        </div>
        <MatchStatusBadge status={match.status} />
      </div>

      <div className="p-4 sm:p-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          {/* Team A */}
          <div className="text-center">
            <span
              className={`block font-display text-3xl sm:text-4xl ${match.winnerTeam === match.teamAName ? "text-pickle" : "text-foreground"
                }`}
            >
              {s.teamAScore}
            </span>
            <span className="block text-xs font-semibold text-foreground mt-1 truncate">
              {match.teamAName}
            </span>
            {isLive && s.servingTeam === "A" && (
              <span className="inline-block mt-1 text-[0.5rem] uppercase tracking-widest bg-pickle text-sand px-1.5 py-0.5 font-bold">
                Serving (#{s.serverNumber})
              </span>
            )}
          </div>

          <span className="font-display text-lg text-brick">VS</span>

          {/* Team B */}
          <div className="text-center">
            <span
              className={`block font-display text-3xl sm:text-4xl ${match.winnerTeam === match.teamBName ? "text-pickle" : "text-foreground"
                }`}
            >
              {s.teamBScore}
            </span>
            <span className="block text-xs font-semibold text-foreground mt-1 truncate">
              {match.teamBName}
            </span>
            {isLive && s.servingTeam === "B" && (
              <span className="inline-block mt-1 text-[0.5rem] uppercase tracking-widest bg-pickle text-sand px-1.5 py-0.5 font-bold">
                Serving (#{s.serverNumber})
              </span>
            )}
          </div>
        </div>

        {/* 3-number call for live matches */}
        {isLive && (
          <div className="mt-3 pt-3 border-t border-border/60 text-center">
            <span className="font-mono text-lg text-pickle font-bold">
              {s.servingTeam === "A" ? s.teamAScore : s.teamBScore}
              {" - "}
              {s.servingTeam === "A" ? s.teamBScore : s.teamAScore}
              {" - "}
              {s.serverNumber}
            </span>
            <span className="block text-[0.55rem] uppercase tracking-[0.2em] text-foreground/80 font-bold mt-0.5">
              Score Call
            </span>
          </div>
        )}

        {/* Winner display for final */}
        {match.status === "final" && match.winnerTeam && (
          <div className="mt-3 pt-3 border-t border-border/60 text-center">
            <span className="text-[0.6rem] uppercase tracking-[0.2em] font-bold text-pickle">
              Winner: {match.winnerTeam}
            </span>
          </div>
        )}

        {/* Official */}
        <div className="mt-3 pt-2.5 border-t border-border/60 flex items-center justify-between text-[0.65rem] uppercase tracking-widest">
          <span className="text-foreground/70 font-semibold">Live Official:</span>
          <span className="font-mono text-pickle font-bold">
            {match.officiatedBy ?? station?.assignedUmpire ?? "Unassigned"}
          </span>
        </div>
      </div>
    </button>
  );
}

function MatchStatusBadge({ status }: { status: LiveMatch["status"] }) {
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[0.6rem] font-bold uppercase tracking-widest text-pickle">
        <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
        Live
      </span>
    );
  }
  if (status === "final") {
    return (
      <span className="text-[0.6rem] font-bold uppercase tracking-widest text-brick">
        Final
      </span>
    );
  }
  return (
    <span className="text-[0.6rem] font-bold uppercase tracking-widest text-foreground bg-card px-1.5 py-0.5 border-2 border-border rounded">
      Scheduled
    </span>
  );
}

function CourtStatusBadge({
  status,
  isLiveMatch,
}: {
  status: string;
  isLiveMatch?: boolean;
}) {
  if (isLiveMatch || status === "live") {
    return (
      <span className="inline-flex items-center gap-1 text-[0.55rem] font-bold uppercase tracking-wider text-pickle">
        <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
        Live
      </span>
    );
  }
  if (status === "warmup") {
    return (
      <span className="text-[0.55rem] font-bold uppercase tracking-wider text-amber-300">
        Warm-up
      </span>
    );
  }
  if (status === "maintenance") {
    return (
      <span className="text-[0.55rem] font-bold uppercase tracking-wider text-brick">
        Maintenance
      </span>
    );
  }
  return (
    <span className="text-[0.55rem] font-bold uppercase tracking-wider text-foreground/80 bg-card px-1.5 py-0.5 border border-border">
      Available
    </span>
  );
}

function StatBadge({
  label,
  value,
  color,
  pulse,
}: {
  label: string;
  value: number;
  color: "pickle" | "brick" | "sand";
  pulse?: boolean;
}) {
  const colorMap = {
    pickle: "text-pickle",
    brick: "text-brick",
    sand: "text-foreground",
  };

  return (
    <div className="text-center">
      <span className={`block font-display text-2xl ${colorMap[color]} ${pulse ? "animate-pulse" : ""}`}>
        {value}
      </span>
      <span className="block text-[0.55rem] uppercase tracking-widest text-foreground/80 font-bold">
        {label}
      </span>
    </div>
  );
}
