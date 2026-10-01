import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";

import {
  useMatchStore,
  scorePoint,
  sideOut,
  endGame,
  undoLastRally,
  resetMatch,
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
} from "@/lib/court-dispatch";
import { useTournamentStore } from "@/lib/tournament-store";
import { dbUpdateCourtStation } from "@/lib/supabase-service";

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

type UmpireTab = "desk" | "console" | "scoreboard";

function Umpire() {
  const navigate = useNavigate();
  const { tournaments } = useTournamentStore();
  const [tournamentFilter, setTournamentFilter] = useState<string>("all");
  const { matches, refresh, update, resetAll, isCloudSynced } = useMatchStore(
    tournamentFilter === "all" ? undefined : tournamentFilter
  );

  const [activeTab, setActiveTab] = useState<UmpireTab>("console");
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [umpireName, setUmpireName] = useState("Official");
  const [stations, setStations] = useState<Record<FacilityCourt, CourtStation>>(() => getCourtStations());
  const [showQuickMatchModal, setShowQuickMatchModal] = useState(false);
  const [preselectedCourt, setPreselectedCourt] = useState<FacilityCourt>("Court 1");
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);

  // Load umpire identity
  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      setUmpireName(localStorage.getItem("mock_umpire_name") ?? "Official");
    }
  }, []);

  // Hydrate court stations from Supabase on mount and keep updated
  useEffect(() => {
    let mounted = true;
    hydrateCourtStationsFromCloud().then((hydrated) => {
      if (mounted) setStations(hydrated);
    });

    const reloadStations = () => {
      setStations(getCourtStations());
    };

    window.addEventListener("storage", reloadStations);
    window.addEventListener("dv_matches_updated", reloadStations);
    const interval = setInterval(() => {
      hydrateCourtStationsFromCloud().then((cloud) => {
        if (mounted) setStations(cloud);
      });
    }, 4000);

    return () => {
      mounted = false;
      window.removeEventListener("storage", reloadStations);
      window.removeEventListener("dv_matches_updated", reloadStations);
      clearInterval(interval);
    };
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("mock_umpire_auth");
    localStorage.removeItem("mock_umpire_name");
    navigate({ to: "/login" });
  };

  const openConsole = (matchId: string) => {
    setSelectedMatchId(matchId);
    setActiveTab("console");
  };

  const handleClaimCourt = (court: FacilityCourt) => {
    claimCourtStation(court, umpireName);
    setStations(getCourtStations());
  };

  const handleReleaseCourt = (court: FacilityCourt) => {
    releaseCourtStation(court);
    setStations(getCourtStations());
  };

  const handleOpenQuickMatch = (court?: FacilityCourt) => {
    if (court) setPreselectedCourt(court);
    setShowQuickMatchModal(true);
  };

  const selectedMatch = matches.find((m) => m.id === selectedMatchId) ?? null;

  const tabs: { key: UmpireTab; label: string }[] = [
    { key: "console", label: "Live Console" },
    { key: "desk", label: "Tournament Desk" },
    { key: "scoreboard", label: "Live Scoreboard" },
  ];

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      {/* Top bar */}
      <div className="sticky top-16 z-40 border-b border-border bg-charcoal/95 backdrop-blur">
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

            {/* Tournament Selector & Actions */}
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={tournamentFilter}
                onChange={(e) => setTournamentFilter(e.target.value)}
                className="bg-charcoal border border-border text-sand text-xs font-semibold px-2.5 py-1.5 rounded-none focus:outline-none focus:border-pickle cursor-pointer"
              >
                <option value="all">All Tournaments & Facility</option>
                {tournaments.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </select>

              <button
                onClick={() => handleOpenQuickMatch()}
                className="px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1"
              >
                <span>+</span> Quick Match
              </button>

              {/* Overflow menu — hides Clear + Sign Out on mobile */}
              <div className="relative sm:contents">
                {/* On sm+: always show these buttons inline */}
                <button
                  onClick={() => setShowResetConfirm(true)}
                  className="hidden sm:block px-2.5 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest border border-border text-sand/80 hover:border-sand hover:text-sand transition-colors cursor-pointer"
                >
                  Clear
                </button>
                <button
                  onClick={handleLogout}
                  className="hidden sm:block px-2.5 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest bg-brick/20 border border-brick/40 text-brick hover:bg-brick/30 transition-colors cursor-pointer"
                >
                  Sign Out
                </button>

                {/* On mobile: overflow toggle */}
                <button
                  onClick={() => setShowOverflow((v) => !v)}
                  className="sm:hidden px-2.5 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest border border-border text-sand/80 hover:text-sand transition-colors cursor-pointer"
                  aria-label="More options"
                >
                  ...
                </button>

                {/* Overflow dropdown */}
                {showOverflow && (
                  <div
                    className="absolute right-0 top-full mt-1 z-50 flex flex-col bg-charcoal border border-border shadow-lg sm:hidden"
                    onBlur={() => setShowOverflow(false)}
                  >
                    <button
                      onClick={() => { setShowResetConfirm(true); setShowOverflow(false); }}
                      className="px-4 py-2.5 text-left text-[0.65rem] font-bold uppercase tracking-widest text-sand/80 hover:text-sand hover:bg-charcoal/60 transition-colors cursor-pointer"
                    >
                      Clear All Matches
                    </button>
                    <button
                      onClick={() => { handleLogout(); setShowOverflow(false); }}
                      className="px-4 py-2.5 text-left text-[0.65rem] font-bold uppercase tracking-widest text-brick hover:bg-brick/10 transition-colors cursor-pointer"
                    >
                      Sign Out
                    </button>
                  </div>
                )}
              </div>
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

      {/* Main Content Area */}
      <div className="mx-auto max-w-6xl px-4 py-6">
        {activeTab === "desk" && (
          <TournamentDesk
            matches={matches}
            stations={stations}
            currentUmpire={umpireName}
            onSelectMatch={openConsole}
            onClaimCourt={handleClaimCourt}
            onReleaseCourt={handleReleaseCourt}
            onOpenQuickMatch={handleOpenQuickMatch}
            onUpdate={update}
          />
        )}
        {activeTab === "console" && (
          <UmpireConsole
            match={selectedMatch}
            matches={matches}
            stations={stations}
            currentUmpire={umpireName}
            onUpdate={update}
            onSelectMatch={(id) => setSelectedMatchId(id)}
            onBack={() => setActiveTab("desk")}
            onOpenQuickMatch={() => handleOpenQuickMatch()}
          />
        )}
        {activeTab === "scoreboard" && (
          <LiveScoreboard
            matches={matches}
            stations={stations}
            onSelectMatch={openConsole}
          />
        )}
      </div>

      {/* Quick Match Modal */}
      {showQuickMatchModal && (
        <QuickMatchModal
          defaultCourt={preselectedCourt}
          currentUmpire={umpireName}
          tournaments={tournaments}
          matches={matches}
          initialTournamentSlug={tournamentFilter === "all" ? "" : tournamentFilter}
          onClose={() => setShowQuickMatchModal(false)}
          onCreated={(matchId) => {
            setShowQuickMatchModal(false);
            refresh();
            setStations(getCourtStations());
            openConsole(matchId);
          }}
        />
      )}

      {/* Reset Confirmation Modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/90 backdrop-blur-sm p-4">
          <div className="surface-card border-2 border-brick/60 max-w-sm w-full p-6 space-y-4">
            <h3 className="font-display text-2xl text-foreground">Clear All Matches?</h3>
            <p className="text-sm text-foreground/80">
              This will remove all active and scheduled matches from the local store and database. This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest border border-border text-foreground hover:border-foreground/50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  resetAll();
                  for (const court of FACILITY_COURTS) {
                    vacateCourt(court);
                  }
                  setStations(getCourtStations());
                  setShowResetConfirm(false);
                }}
                className="px-4 py-2 text-xs font-bold uppercase tracking-widest bg-brick text-sand hover:bg-brick-deep transition-colors cursor-pointer"
              >
                Confirm Clear
              </button>
            </div>
          </div>
        </div>
      )}
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
            const courtMatch =
              matches.find((m) => m.id === st.currentMatchId) ??
              matches.find((m) => m.court === court && (m.status === "live" || m.status === "scheduled"));

            const isAssignedToMe = st.assignedUmpire === currentUmpire;

            return (
              <div
                key={court}
                className={`surface-card p-0 overflow-hidden border flex flex-col justify-between transition-all ${courtMatch?.status === "live"
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
                      ) : (
                        <button
                          onClick={() => onOpenQuickMatch(court)}
                          className="flex-1 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest border border-border text-foreground hover:border-pickle hover:text-pickle transition-colors text-center cursor-pointer"
                        >
                          + Dispatch
                        </button>
                      )}

                      {isAssignedToMe ? (
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

function UmpireConsole({
  match,
  matches,
  stations,
  currentUmpire,
  onUpdate,
  onSelectMatch,
  onBack,
  onOpenQuickMatch,
}: {
  match: LiveMatch | null;
  matches: LiveMatch[];
  stations?: Record<FacilityCourt, CourtStation>;
  currentUmpire: string;
  onUpdate: (matchId: string, updater: (m: LiveMatch) => LiveMatch) => void;
  onSelectMatch: (id: string) => void;
  onBack: () => void;
  onOpenQuickMatch: () => void;
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
      // 1. Actively assigned to a court station
      if (dispatchedStationMatchIds.has(m.id)) return true;
      // 2. Or is live on an active facility court
      if (
        m.status === "live" &&
        m.court &&
        m.court !== "Queue" &&
        (FACILITY_COURTS as readonly string[]).includes(m.court as FacilityCourt)
      ) {
        return true;
      }
      return false;
    },
    [dispatchedStationMatchIds],
  );

  const dispatchedMatches = useMemo(
    () => matches.filter(isDispatchedMatch),
    [matches, isDispatchedMatch],
  );

  if (!match) {
    const liveMatches = dispatchedMatches.filter((m) => m.status === "live");
    const scheduledMatches = dispatchedMatches.filter((m) => m.status === "scheduled");

    return (
      <div className="space-y-6 max-w-2xl mx-auto">
        {/* Header */}
        <div className="border-b border-border pb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <span className="text-xs font-bold uppercase tracking-[0.28em] text-pickle">
              Live Console
            </span>
            <h2 className="font-display text-3xl sm:text-4xl text-foreground mt-1">
              Select a Match
            </h2>
            <p className="text-sm text-foreground/80 mt-1">
              Pick an active or scheduled match below to begin officiating.
            </p>
          </div>
          <button
            onClick={onOpenQuickMatch}
            className="px-4 py-2 text-xs font-bold uppercase tracking-widest bg-pickle text-sand hover:opacity-90 transition-opacity cursor-pointer w-fit"
          >
            + New Quick Match
          </button>
        </div>

        {/* No matches at all */}
        {dispatchedMatches.length === 0 && (
          <div className="surface-card p-10 text-center border border-dashed border-border">
            <span className="text-xs uppercase tracking-widest text-pickle font-bold block">No Dispatched Matches</span>
            <p className="mt-2 text-sm text-foreground/70">
              No matches have been dispatched yet. When an admin dispatches a match to a court, it will appear here.
            </p>
            <div className="flex flex-col sm:flex-row gap-2 justify-center mt-5">
              <button
                onClick={onOpenQuickMatch}
                className="px-4 py-2.5 bg-pickle text-sand text-xs font-bold uppercase tracking-widest hover:opacity-90 transition-opacity cursor-pointer"
              >
                + New Quick Match
              </button>
              <button
                onClick={onBack}
                className="px-4 py-2.5 border border-border text-sand text-xs font-bold uppercase tracking-widest hover:border-foreground/50 transition-colors cursor-pointer"
              >
                Tournament Desk
              </button>
            </div>
          </div>
        )}

        {/* Live matches */}
        {liveMatches.length > 0 && (
          <div className="space-y-2">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-pickle">
              Live Now ({liveMatches.length})
            </span>
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              {liveMatches.map((m) => (
                <button
                  key={m.id}
                  onClick={() => onSelectMatch(m.id)}
                  className="surface-card p-4 text-left border border-pickle/60 hover:border-pickle shadow-sm shadow-pickle/10 transition-all cursor-pointer"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs font-bold uppercase tracking-widest text-foreground font-mono">{m.court}</span>
                      {m.stage && (
                        <span className="text-[0.6rem] font-bold uppercase tracking-wider text-pickle font-mono bg-pickle/15 px-1.5 py-0.5 border border-pickle/30 truncate">
                          {m.stage}
                        </span>
                      )}
                    </div>
                    <MatchStatusBadge status={m.status} />
                  </div>
                  <div className="text-sm font-semibold text-foreground">
                    {m.teamAName} <span className="text-pickle font-display text-lg">{m.score.teamAScore}</span>
                    <span className="text-foreground/40 mx-1">-</span>
                    <span className="text-pickle font-display text-lg">{m.score.teamBScore}</span> {m.teamBName}
                  </div>
                  <div className="mt-2 pt-2 border-t border-border/60 flex items-center justify-between text-[0.65rem] uppercase tracking-widest">
                    <span className="text-pickle font-bold">Score this match</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (typeof localStorage !== "undefined") {
                          try {
                            localStorage.removeItem(`dv_toss_done_${m.id}`);
                          } catch {}
                        }
                        onUpdate(m.id, resetMatch);
                        onSelectMatch(m.id);
                      }}
                      title="Reset score to 0-0 and rerun coin toss"
                      className="px-2 py-1 text-[0.6rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-pickle/40 hover:bg-pickle hover:text-sand transition-colors cursor-pointer"
                    >
                      Coin Toss (Reset)
                    </button>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Scheduled matches */}
        {scheduledMatches.length > 0 && (
          <div className="space-y-2">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-foreground/60">
              Scheduled ({scheduledMatches.length})
            </span>
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              {scheduledMatches.map((m) => (
                <button
                  key={m.id}
                  onClick={() => onSelectMatch(m.id)}
                  className="surface-card p-4 text-left border border-border hover:border-foreground/40 transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs font-bold uppercase tracking-widest text-foreground font-mono">{m.court}</span>
                      {m.stage && (
                        <span className="text-[0.6rem] font-bold uppercase tracking-wider text-pickle font-mono bg-pickle/15 px-1.5 py-0.5 border border-pickle/30 truncate">
                          {m.stage}
                        </span>
                      )}
                    </div>
                    <MatchStatusBadge status={m.status} />
                  </div>
                  <div className="text-sm font-semibold text-foreground">
                    {m.teamAName} vs {m.teamBName}
                  </div>
                  <div className="mt-2 pt-2 border-t border-border/60 flex items-center justify-between text-[0.65rem] uppercase tracking-widest">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="text-foreground/70 font-semibold">Official:</span>
                      <span className={`font-mono truncate max-w-[100px] ${m.officiatedBy ? "text-pickle font-bold" : "text-foreground/50"}`}>
                        {m.officiatedBy
                          ? m.officiatedBy === currentUmpire
                            ? `${m.officiatedBy} (You)`
                            : m.officiatedBy
                          : "Unassigned"}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (typeof localStorage !== "undefined") {
                          try {
                            localStorage.removeItem(`dv_toss_done_${m.id}`);
                          } catch {}
                        }
                        onUpdate(m.id, resetMatch);
                        onSelectMatch(m.id);
                      }}
                      title="Reset score to 0-0 and rerun coin toss"
                      className="px-2 py-1 text-[0.6rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-pickle/40 hover:bg-pickle hover:text-sand transition-colors cursor-pointer shrink-0"
                    >
                      Coin Toss (Reset)
                    </button>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
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

  const handleEndGame = () => {
    onUpdate(match.id, (m) => {
      const updated = endGame(m);
      return {
        ...updated,
        officiatedBy: m.officiatedBy ?? currentUmpire,
      };
    });
    // Complete match in dispatch queue
    completeQueueMatch(match.id);
    // Vacate court station in database
    if (match.court && match.court !== "Queue") {
      vacateCourt(match.court as FacilityCourt);
    }
    setShowEndConfirm(false);
  };

  const handleUndo = () => {
    if (s.rallies.length === 0) return;
    onUpdate(match.id, undoLastRally);
  };

  const handleTossDone = (serving: "A" | "B", winner?: "A" | "B") => {
    setTossDone(true);
    setTossServingTeam(serving);
    setShowToss(false);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(`dv_toss_done_${match.id}`, "true");
      } catch {
        // ignore
      }
    }
    const winnerName = winner === "A" ? match.teamAName : winner === "B" ? match.teamBName : undefined;
    onUpdate(match.id, (m) => ({
      ...m,
      tossDone: true,
      tossWinner: winnerName ?? m.tossWinner,
      officiatedBy: m.officiatedBy ?? currentUmpire,
      score: { ...m.score, servingTeam: serving, serverNumber: 2, teamAScore: 0, teamBScore: 0 },
    }));
  };

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Coin Toss Overlay */}
      {showToss && (
        <CoinTossOverlay
          teamAName={match.teamAName}
          teamBName={match.teamBName}
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

      {/* Navigation Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-foreground hover:text-foreground/70 transition-colors cursor-pointer w-fit"
          >
            <span className="text-base leading-none">&larr;</span> Desk
          </button>
          <span className="text-border">|</span>
          <button
            onClick={() => onSelectMatch("")}
            className="text-xs font-bold uppercase tracking-widest text-sand/70 hover:text-sand transition-colors cursor-pointer w-fit"
          >
            All Dispatched
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Umpire / Official Badge */}
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs uppercase tracking-widest border border-border bg-charcoal text-sand">
            <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
            <span className="text-[0.65rem] font-bold text-sand/70">Official:</span>
            <span className="font-bold text-pickle font-mono">
              {effectiveUmpire}
            </span>
            {effectiveUmpire === currentUmpire && (
              <span className="text-[0.6rem] text-sand/60 font-semibold">(You)</span>
            )}
          </div>

          <MatchStatusBadge status={match.status} />
          {match.stage && (
            <span className="text-xs font-bold uppercase tracking-widest font-mono bg-pickle/20 text-pickle px-2.5 py-1 border border-pickle/40">
              {match.stage}
            </span>
          )}
          <span className="text-xs font-bold uppercase tracking-widest font-mono bg-charcoal text-sand px-2.5 py-1 border border-border">
            {match.court}
          </span>
          <button
            type="button"
            onClick={handleRequestResetToss}
            title="Reset match score to 0-0 and rerun coin toss"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase tracking-widest bg-charcoal text-sand border border-pickle/50 hover:bg-pickle hover:text-sand transition-colors cursor-pointer"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-pickle" />
            Coin Toss (Reset)
          </button>
        </div>
      </div>

      {/* Reassignment banner if another official was designated */}
      {match.officiatedBy && match.officiatedBy !== currentUmpire && (
        <div className="border border-brick/40 bg-brick/10 px-4 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
          <span className="text-brick font-medium">
            Assigned official: <strong>{match.officiatedBy}</strong>
          </span>
          <button
            onClick={() =>
              onUpdate(match.id, (m) => ({ ...m, officiatedBy: currentUmpire }))
            }
            className="px-3 py-1 text-[0.65rem] font-bold uppercase tracking-widest bg-brick text-sand hover:bg-brick-deep transition-colors cursor-pointer w-fit"
          >
            Claim Officiating
          </button>
        </div>
      )}

      {/* Score Display: 3-number call for Pickleball */}
      <div className="surface-card p-0 overflow-hidden border-2 border-pickle/40">
        <div className="bg-pickle/15 px-4 py-2 text-center border-b border-pickle/30">
          <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-pickle">
            {match.status === "final" ? "Final Score" : `Serving: ${servingTeamName}`}
          </span>
        </div>

        {/* The 3-Number Score Call */}
        {match.status !== "final" && (
          <div className="bg-charcoal px-4 py-6 text-center">
            <div className="font-display text-7xl sm:text-8xl text-sand tracking-widest">
              {serverScore}
              <span className="text-pickle mx-2 sm:mx-4">-</span>
              {receiverScore}
              <span className="text-pickle mx-2 sm:mx-4">-</span>
              {s.serverNumber}
            </div>
            <div className="mt-2 flex justify-center gap-8 text-[0.65rem] uppercase tracking-[0.2em] text-sand/90 font-semibold">
              <span>Server</span>
              <span>Receiver</span>
              <span>Server #</span>
            </div>
          </div>
        )}

        {/* Team scores breakdown */}
        <div className="grid grid-cols-2 divide-x divide-border">
          {/* Team A */}
          <div
            className={`p-4 sm:p-5 text-center transition-colors ${s.servingTeam === "A" && match.status !== "final"
              ? "bg-pickle/10"
              : match.winnerTeam === match.teamAName
                ? "bg-pickle/15"
                : ""
              }`}
          >
            <span
              className={`block font-display text-4xl sm:text-5xl ${match.winnerTeam === match.teamAName ? "text-pickle" : "text-foreground"
                }`}
            >
              {s.teamAScore}
            </span>
            <span className="block text-xs font-semibold text-foreground mt-1 truncate">
              {match.teamAName}
            </span>
            <span className="block text-[0.7rem] text-foreground/80 font-medium truncate">
              {match.teamAPlayers.join(" / ")}
            </span>
            {s.servingTeam === "A" && match.status !== "final" && (
              <span className="inline-block mt-2 text-[0.55rem] uppercase tracking-widest bg-pickle text-sand px-2 py-0.5 font-bold">
                Serving (#{s.serverNumber})
              </span>
            )}
          </div>

          {/* Team B */}
          <div
            className={`p-4 sm:p-5 text-center transition-colors ${s.servingTeam === "B" && match.status !== "final"
              ? "bg-pickle/10"
              : match.winnerTeam === match.teamBName
                ? "bg-pickle/15"
                : ""
              }`}
          >
            <span
              className={`block font-display text-4xl sm:text-5xl ${match.winnerTeam === match.teamBName ? "text-pickle" : "text-foreground"
                }`}
            >
              {s.teamBScore}
            </span>
            <span className="block text-xs font-semibold text-foreground mt-1 truncate">
              {match.teamBName}
            </span>
            <span className="block text-[0.7rem] text-foreground/80 font-medium truncate">
              {match.teamBPlayers.join(" / ")}
            </span>
            {s.servingTeam === "B" && match.status !== "final" && (
              <span className="inline-block mt-2 text-[0.55rem] uppercase tracking-widest bg-pickle text-sand px-2 py-0.5 font-bold">
                Serving (#{s.serverNumber})
              </span>
            )}
          </div>
        </div>

        {/* Winner banner */}
        {match.status === "final" && match.winnerTeam && (
          <div className="bg-pickle/20 px-4 py-3 text-center border-t border-pickle/40">
            <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-pickle">
              Winner
            </span>
            <span className="block font-display text-2xl text-foreground mt-0.5">
              {match.winnerTeam}
            </span>
          </div>
        )}
      </div>

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

      {/* Pre-match Toss Banner */}
      {needsToss && !showToss && (
        <div className="border border-pickle/40 bg-pickle/10 px-4 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
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

      {/* Primary Scoring Action Buttons */}
      {isLiveOrScheduled && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={handlePoint}
              disabled={needsToss}
              className={`font-display text-2xl sm:text-3xl tracking-widest py-5 sm:py-6 transition-all ${needsToss
                ? "bg-pickle/30 text-sand/40 cursor-not-allowed"
                : "bg-pickle text-sand active:scale-[0.97] hover:opacity-90 cursor-pointer shadow-lg shadow-pickle/20"
                }`}
            >
              Point Scored
            </button>

            <button
              onClick={handleSideOut}
              disabled={needsToss}
              className={`font-display text-2xl sm:text-3xl tracking-widest py-5 sm:py-6 transition-all ${needsToss
                ? "bg-brick/30 text-sand/40 cursor-not-allowed"
                : "bg-brick text-sand active:scale-[0.97] hover:bg-brick-deep cursor-pointer shadow-lg shadow-brick/20"
                }`}
            >
              Side Out
            </button>
          </div>

          {/* Tactical and Management Controls */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <button
              onClick={handleUndo}
              disabled={s.rallies.length === 0}
              className={`py-3 border font-bold uppercase tracking-wider transition-all ${s.rallies.length > 0
                ? "border-sand/40 bg-charcoal text-sand hover:border-sand hover:bg-black/40 cursor-pointer shadow-sm"
                : "border-border/40 bg-charcoal/40 text-sand/30 cursor-not-allowed"
                }`}
            >
              Undo Point {s.rallies.length > 0 ? `(${s.rallies.length})` : ""}
            </button>

            <button
              onClick={handleSwapServerNumber}
              disabled={needsToss}
              title="Toggle between Server 1 and Server 2"
              className="py-3 border border-border bg-charcoal text-sand font-semibold uppercase tracking-wider hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
            >
              Swap Server #
            </button>

            <button
              onClick={handleSwapServingTeam}
              disabled={needsToss}
              title="Switch initial serving side"
              className="py-3 border border-border bg-charcoal text-sand font-semibold uppercase tracking-wider hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
            >
              Swap Team
            </button>

            <button
              onClick={handleRequestResetToss}
              title="Reset match score to 0-0 and launch coin toss"
              className="py-3 border border-pickle/50 bg-pickle/10 text-pickle font-bold uppercase tracking-wider hover:bg-pickle hover:text-sand transition-colors cursor-pointer"
            >
              Coin Toss (Reset)
            </button>

            <button
              onClick={() => setShowEndConfirm(true)}
              className="py-3 border border-brick/50 bg-brick/10 text-brick font-semibold uppercase tracking-wider hover:bg-brick/20 transition-colors cursor-pointer col-span-2 sm:col-span-1"
            >
              End Match
            </button>
          </div>

          {/* Official Timeouts */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => handleStartTimeout("A")}
              disabled={needsToss || timeoutActive}
              className="flex-1 py-2 text-[0.65rem] font-bold uppercase tracking-wider border border-border bg-muted/40 text-foreground hover:border-foreground/50 transition-colors cursor-pointer"
            >
              Timeout {match.teamAName} (60s)
            </button>
            <button
              onClick={() => handleStartTimeout("B")}
              disabled={needsToss || timeoutActive}
              className="flex-1 py-2 text-[0.65rem] font-bold uppercase tracking-wider border border-border bg-muted/40 text-foreground hover:border-foreground/50 transition-colors cursor-pointer"
            >
              Timeout {match.teamBName} (60s)
            </button>
          </div>
        </div>
      )}

      {/* End Game Confirmation Dialog */}
      {showEndConfirm && (
        <div className="surface-card p-6 border-2 border-brick space-y-4">
          <h3 className="font-display text-2xl text-foreground text-center">
            Finalize this match?
          </h3>
          <p className="text-sm text-foreground/80 font-medium text-center">
            Score: {match.teamAName} {s.teamAScore} - {s.teamBScore} {match.teamBName}
          </p>
          <p className="text-xs text-foreground/60 text-center">
            Confirming will declare the winner, record final scores in Supabase, and vacate {match.court}.
          </p>
          <div className="flex gap-3 justify-center pt-2">
            <button
              onClick={handleEndGame}
              className="bg-brick text-sand font-display text-xl tracking-widest px-8 py-3 hover:bg-brick-deep transition-colors cursor-pointer"
            >
              Confirm End Match
            </button>
            <button
              onClick={() => setShowEndConfirm(false)}
              className="border border-border text-foreground font-display text-xl tracking-widest px-8 py-3 hover:border-foreground/50 transition-colors cursor-pointer"
            >
              Cancel
            </button>
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
   TAB 3: LIVE SCOREBOARD (SPECTATOR VIEW)
═══════════════════════════════════════════════ */

function LiveScoreboard({
  matches,
  stations,
  onSelectMatch,
}: {
  matches: LiveMatch[];
  stations: Record<FacilityCourt, CourtStation>;
  onSelectMatch: (id: string) => void;
}) {
  const confirmedMatches = useMemo(() => {
    return matches.filter((m) => isConfirmedDispatchedMatch(m, stations));
  }, [matches, stations]);

  const liveMatches = confirmedMatches.filter((m) => m.status === "live");
  const scheduledMatches = confirmedMatches.filter((m) => m.status === "scheduled");
  const finalMatches = confirmedMatches.filter((m) => m.status === "final");

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="border-b border-border pb-5 text-center">
        <span className="text-xs font-bold uppercase tracking-[0.28em] text-pickle">
          Facility Live Scoreboard
        </span>
        <h2 className="font-display text-3xl sm:text-4xl text-foreground mt-1">
          Dink Valley Real-Time Court Broadcast
        </h2>
        <p className="text-sm text-foreground/80 mt-1">
          Live courtside synchronization powered by Supabase Realtime
        </p>
        <div className="mt-3 flex justify-center gap-4">
          {liveMatches.length > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-pickle">
              <span className="h-2 w-2 rounded-full bg-pickle animate-pulse" />
              {liveMatches.length} Live
            </span>
          )}
          {scheduledMatches.length > 0 && (
            <span className="text-xs font-bold uppercase tracking-widest text-foreground">
              {scheduledMatches.length} Scheduled
            </span>
          )}
          {finalMatches.length > 0 && (
            <span className="text-xs font-bold uppercase tracking-widest text-brick">
              {finalMatches.length} Final
            </span>
          )}
        </div>
      </div>

      {/* Live matches */}
      {liveMatches.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-display text-xl text-pickle flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-pickle animate-pulse" />
            Live In Play
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {liveMatches.map((match) => (
              <ScoreboardCard
                key={match.id}
                match={match}
                station={stations[match.court as FacilityCourt]}
                onSelect={() => onSelectMatch(match.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Scheduled matches */}
      {scheduledMatches.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-display text-xl text-foreground">Next Up</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {scheduledMatches.map((match) => (
              <ScoreboardCard
                key={match.id}
                match={match}
                station={stations[match.court as FacilityCourt]}
                onSelect={() => onSelectMatch(match.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Completed matches */}
      {finalMatches.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-display text-xl text-brick">Completed Matches</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {finalMatches.map((match) => (
              <ScoreboardCard
                key={match.id}
                match={match}
                station={stations[match.court as FacilityCourt]}
                onSelect={() => onSelectMatch(match.id)}
              />
            ))}
          </div>
        </div>
      )}

      {confirmedMatches.length === 0 && (
        <div className="surface-card p-12 text-center border border-dashed border-border">
          <h3 className="font-display text-2xl text-foreground">No Matches Active</h3>
          <p className="text-sm text-foreground/80 mt-2">
            Matches will broadcast here immediately once an umpire or desk official launches a match.
          </p>
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
      return Boolean(m.teamAName && m.teamBName);
    });
  }, [matches, selectedTournament]);

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
          <div className="space-y-2 p-3 bg-charcoal/40 border border-border/80">
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
          <div className="space-y-2 p-3 bg-charcoal/40 border border-border/80">
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

type TossPhase = "idle" | "flipping" | "result" | "choosing" | "done";

function CoinTossOverlay({
  teamAName,
  teamBName,
  onDone,
  onClose,
}: {
  teamAName: string;
  teamBName: string;
  onDone: (servingTeam: "A" | "B", winnerTeam?: "A" | "B") => void;
  onClose?: () => void;
}) {
  const [phase, setPhase] = useState<TossPhase>("idle");
  const [face, setFace] = useState<"heads" | "tails">("heads");
  const [callingTeam, setCallingTeam] = useState<"A" | "B">("A");
  const [callingChoice, setCallingChoice] = useState<"heads" | "tails">("heads");
  const [winnerTeam, setWinnerTeam] = useState<"A" | "B" | null>(null);
  const [choosingTeam, setChoosingTeam] = useState<"A" | "B" | null>(null);
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
    setPhase("done");
    setTimeout(() => onDone(serving, winnerTeam ?? undefined), 600);
  };

  const winnerName = winnerTeam === "A" ? teamAName : teamBName;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/96 backdrop-blur-sm p-4">
      <div className="surface-card border-2 border-pickle/50 max-w-sm w-full p-5 sm:p-6 space-y-4 text-center relative max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-border/40 pb-2">
          <span className="block text-[0.6rem] uppercase tracking-[0.3em] font-bold text-pickle">
            Pre-Match Officiating
          </span>
          {onClose && (
            <button
              onClick={onClose}
              className="text-[0.65rem] font-bold uppercase tracking-wider text-sand/60 hover:text-sand transition-colors px-2 py-0.5 border border-border/40 hover:border-sand cursor-pointer"
            >
              Skip
            </button>
          )}
        </div>
        <div>
          <h2 className="font-display text-2xl sm:text-3xl text-foreground">Coin Toss</h2>
          <p className="text-xs text-foreground/70 mt-0.5 font-medium truncate">
            {teamAName} vs {teamBName}
          </p>
        </div>

        {/* Coin representation */}
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

        {/* Single Streamlined Prompt: Which team will choose tails or heads? */}
        {phase === "idle" && (
          <div className="space-y-3.5 pt-1">
            <div className="text-left space-y-2.5 border border-border bg-charcoal/50 p-3">
              <div>
                <span className="block text-xs sm:text-sm font-bold uppercase tracking-wider text-sand">
                  Which team will choose tails or heads?
                </span>
                <span className="block text-[0.65rem] text-sand/60 mt-0.5">
                  Select the calling team and their call before flipping.
                </span>
              </div>

              {/* Team Calling Selection */}
              <div className="space-y-1 pt-1">
                <span className="block text-[0.6rem] uppercase tracking-wider text-sand/50 font-mono">
                  Calling Team
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCallingTeam("A")}
                    className={`p-2.5 text-xs font-bold uppercase tracking-wider border transition-all text-center cursor-pointer truncate ${
                      callingTeam === "A"
                        ? "bg-pickle text-sand border-pickle shadow-sm"
                        : "bg-charcoal text-sand/70 border-border hover:border-sand/40"
                    }`}
                  >
                    {teamAName}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCallingTeam("B")}
                    className={`p-2.5 text-xs font-bold uppercase tracking-wider border transition-all text-center cursor-pointer truncate ${
                      callingTeam === "B"
                        ? "bg-pickle text-sand border-pickle shadow-sm"
                        : "bg-charcoal text-sand/70 border-border hover:border-sand/40"
                    }`}
                  >
                    {teamBName}
                  </button>
                </div>
              </div>

              {/* Call Choice (Heads or Tails) */}
              <div className="space-y-1">
                <span className="block text-[0.6rem] uppercase tracking-wider text-sand/50 font-mono">
                  {callingTeamName}&apos;s Call
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCallingChoice("heads")}
                    className={`p-2.5 text-xs font-bold uppercase tracking-wider border transition-all text-center cursor-pointer ${
                      callingChoice === "heads"
                        ? "bg-pickle text-sand border-pickle shadow-sm"
                        : "bg-charcoal text-sand/70 border-border hover:border-sand/40"
                    }`}
                  >
                    Heads
                  </button>
                  <button
                    type="button"
                    onClick={() => setCallingChoice("tails")}
                    className={`p-2.5 text-xs font-bold uppercase tracking-wider border transition-all text-center cursor-pointer ${
                      callingChoice === "tails"
                        ? "bg-pickle text-sand border-pickle shadow-sm"
                        : "bg-charcoal text-sand/70 border-border hover:border-sand/40"
                    }`}
                  >
                    Tails
                  </button>
                </div>
              </div>

              {/* Call Summary Pill */}
              <div className="p-2 bg-charcoal border border-border text-[0.65rem] text-center text-sand/80 font-mono leading-relaxed mt-1">
                <span className="text-pickle font-bold">{callingTeamName}</span> chose{" "}
                <span className="text-sand font-bold uppercase tracking-wide">{callingChoice}</span>.{" "}
                <span className="text-sand/60">({otherTeamName} has {otherChoice})</span>
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
            <span className="text-xs font-bold uppercase tracking-widest text-pickle animate-pulse block">
              Flipping...
            </span>
            <span className="text-[0.65rem] text-sand/70 font-mono">
              {callingTeamName} called {callingChoice.toUpperCase()}
            </span>
          </div>
        )}

        {phase === "result" && (
          <div className="space-y-3.5 pt-1">
            <div className="p-3 bg-pickle/15 border border-pickle/40 text-center space-y-1">
              <div className="flex items-center justify-center gap-2">
                <span className="text-[0.6rem] uppercase tracking-widest text-pickle font-bold">
                  Coin Landed On:
                </span>
                <span className="text-xs font-bold uppercase tracking-wider text-sand font-mono bg-charcoal px-2 py-0.5 border border-border">
                  {face}
                </span>
              </div>
              <span className="block text-[0.6rem] uppercase tracking-widest text-sand/60 font-semibold pt-1">
                Toss Winner
              </span>
              <span className="block font-display text-2xl text-foreground">
                {winnerName}
              </span>
              <span className="block text-[0.65rem] text-sand/80 font-medium">
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
    <span className="text-[0.6rem] font-bold uppercase tracking-widest text-foreground bg-muted/60 px-1.5 py-0.5 border border-border">
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
    <span className="text-[0.55rem] font-bold uppercase tracking-wider text-sand/60">
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
