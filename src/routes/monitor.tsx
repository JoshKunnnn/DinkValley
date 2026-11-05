import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Monitor,
  Maximize2,
  Minimize2,
  Trophy,
  RotateCw,
  LayoutGrid,
  ArrowLeft,
  Clock,
  X,
  ArrowLeftRight,
} from "lucide-react";
import {
  useMatchStore,
  deriveActiveServerBase,
  isMatchMatchingStation,
  computeCourtPositions,
  resolveMatchTeamPlayers,
  type TeamCourtPositions,
  type LiveMatch,
} from "@/lib/match-store";
import {
  FACILITY_COURTS,
  type FacilityCourt,
  type CourtStation,
  type QueueItem,
  getCourtStations,
  getDispatchQueue,
  hydrateCourtStationsFromCloud,
  findMatchForCourtStation,
} from "@/lib/court-dispatch";
import { useTournamentStore } from "@/lib/tournament-store";
import { dbSubscribeToLive, isSameCategory } from "@/lib/supabase-service";

export const Route = createFileRoute("/monitor")({
  head: () => ({
    meta: [
      { title: "Live Arena Monitor | Dink Valley Pickleball Club" },
      {
        name: "description",
        content:
          "Real-time big-screen public court monitor displaying live pickleball scores, 2D player positions, and match status across Courts 1 to 4.",
      },
    ],
  }),
  component: PublicArenaMonitor,
});

type MonitorFocusMode = "all" | FacilityCourt;

interface WinnerCelebration {
  matchId: string;
  court: string;
  stage?: string | undefined;
  winnerTeam: string;
  winnerPlayers: string[];
  loserTeam: string;
  winnerScore: number;
  loserScore: number;
  timestamp: number;
}

function PublicArenaMonitor() {
  const { tournaments } = useTournamentStore();

  // Select primary active tournament
  const activeTournaments = useMemo(
    () => tournaments.filter((t) => t.status !== "Completed"),
    [tournaments]
  );

  const defaultTournament = useMemo(() => {
    return (
      tournaments.find((t) => t.status === "Live") ||
      tournaments.find((t) => t.status === "Registration open") ||
      activeTournaments[0] ||
      tournaments[0] ||
      null
    );
  }, [tournaments, activeTournaments]);

  const [selectedTournamentSlug, setSelectedTournamentSlug] = useState<string>(
    () => defaultTournament?.slug ?? ""
  );

  useEffect(() => {
    if (!selectedTournamentSlug && defaultTournament?.slug) {
      setSelectedTournamentSlug(defaultTournament.slug);
    }
  }, [defaultTournament, selectedTournamentSlug]);

  const activeTournamentSlug = selectedTournamentSlug || defaultTournament?.slug || "";
  const activeTournament =
    tournaments.find((t) => t.slug === activeTournamentSlug) || defaultTournament;

  const { matches, refresh, refreshFromCloud, isCloudSynced } = useMatchStore(
    activeTournamentSlug || undefined
  );

  const [stations, setStations] = useState<Record<FacilityCourt, CourtStation>>(() =>
    getCourtStations()
  );
  const [queue, setQueue] = useState<QueueItem[]>(() => getDispatchQueue());
  const [focusMode, setFocusMode] = useState<MonitorFocusMode>("all");
  const [autoRotate, setAutoRotate] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(() => Date.now());
  const [sideOverrides, setSideOverrides] = useState<Record<string, "left" | "right">>({});
  const [celebration, setCelebration] = useState<WinnerCelebration | null>(null);

  // Track previously known match statuses to detect newly finalized matches for Winner Celebration
  const prevMatchStatusesRef = useRef<Map<string, LiveMatch["status"]>>(new Map());
  const initializedRef = useRef<boolean>(false);

  // Live clock tick every second (also updates match elapsed timers)
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Fullscreen change listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Ignore fullscreen permission errors
    }
  }, []);

  // Hydrate & subscribe to live court stations, matches, and queue in real time
  useEffect(() => {
    let mounted = true;

    const syncAll = () => {
      if (!mounted) return;
      setStations(getCourtStations());
      setQueue(getDispatchQueue());
      refresh();
    };

    const syncFromCloud = () => {
      if (!mounted) return;
      hydrateCourtStationsFromCloud().then((cloudStations) => {
        if (mounted) {
          setStations(cloudStations);
          setQueue(getDispatchQueue());
        }
      });
      refreshFromCloud()
        .then(() => {
          if (mounted) setQueue(getDispatchQueue());
        })
        .catch(() => {});
    };

    syncFromCloud();

    window.addEventListener("storage", syncAll);
    window.addEventListener("dv_matches_updated", syncAll);
    window.addEventListener("dv_live_matches_updated", syncAll);
    window.addEventListener("dv_court_stations_updated", syncAll);
    window.addEventListener("dv_dispatch_queue_updated", syncAll);

    const unsubRealtime = dbSubscribeToLive(
      () => {
        refresh();
        refreshFromCloud().catch(() => {});
      },
      () => {
        hydrateCourtStationsFromCloud().then((cloudStations) => {
          if (mounted) {
            setStations(cloudStations);
            setQueue(getDispatchQueue());
          }
        });
        refreshFromCloud()
          .then(() => {
            if (mounted) setQueue(getDispatchQueue());
          })
          .catch(() => {});
      }
    );

    const pollInterval = setInterval(syncFromCloud, 3500);

    return () => {
      mounted = false;
      unsubRealtime();
      clearInterval(pollInterval);
      window.removeEventListener("storage", syncAll);
      window.removeEventListener("dv_matches_updated", syncAll);
      window.removeEventListener("dv_live_matches_updated", syncAll);
      window.removeEventListener("dv_court_stations_updated", syncAll);
      window.removeEventListener("dv_dispatch_queue_updated", syncAll);
    };
  }, [refresh, refreshFromCloud]);

  // Filter matches relevant to active event or currently on a facility court
  const activeEventMatches = useMemo(() => {
    const activeCourtMatchIds = new Set<string>();
    for (const c of FACILITY_COURTS) {
      const st = stations[c];
      if (st?.currentMatchId) activeCourtMatchIds.add(st.currentMatchId);
      if (st?.onDeckMatchId) activeCourtMatchIds.add(st.onDeckMatchId);
    }

    return matches.filter((m) => {
      if (activeCourtMatchIds.has(m.id)) return true;
      for (const c of FACILITY_COURTS) {
        const st = stations[c];
        if (st?.currentMatchId && isMatchMatchingStation(m, st.currentMatchId, c)) {
          return true;
        }
      }
      if (
        m.court &&
        m.court !== "Queue" &&
        (FACILITY_COURTS as readonly string[]).includes(m.court as FacilityCourt) &&
        (m.status === "live" || m.status === "scheduled")
      ) {
        return true;
      }
      if (!activeTournamentSlug) return true;
      if (m.tournamentSlug) return m.tournamentSlug === activeTournamentSlug;
      if (
        m.categoryId &&
        activeTournament?.categories?.some(
          (c: any) =>
            isSameCategory(m.categoryId, c.id) ||
            Boolean(c.category_slug && isSameCategory(m.categoryId, c.category_slug)) ||
            Boolean(c.uuid && isSameCategory(m.categoryId, c.uuid))
        )
      ) {
        return true;
      }
      return m.id.includes(activeTournamentSlug);
    });
  }, [matches, stations, activeTournamentSlug, activeTournament]);

  // Detect newly completed matches to trigger Winner Celebration Banner
  useEffect(() => {
    if (!initializedRef.current) {
      if (activeEventMatches.length > 0) {
        for (const m of activeEventMatches) {
          prevMatchStatusesRef.current.set(m.id, m.status);
        }
        initializedRef.current = true;
      }
      return;
    }

    for (const m of activeEventMatches) {
      const prevStatus = prevMatchStatusesRef.current.get(m.id);
      if (
        prevStatus &&
        prevStatus !== "final" &&
        m.status === "final" &&
        (m.winnerTeam || m.score.teamAScore !== m.score.teamBScore)
      ) {
        const isAWinner = m.winnerTeam
          ? m.winnerTeam === m.teamAName
          : m.score.teamAScore >= m.score.teamBScore;
        const winnerTeam = isAWinner ? m.teamAName : m.teamBName;
        const winnerPlayers = isAWinner ? m.teamAPlayers : m.teamBPlayers;
        const loserTeam = isAWinner ? m.teamBName : m.teamAName;
        const winnerScore = isAWinner ? m.score.teamAScore : m.score.teamBScore;
        const loserScore = isAWinner ? m.score.teamBScore : m.score.teamAScore;

        setCelebration({
          matchId: m.id,
          court: m.court && m.court !== "Queue" ? m.court : "Arena Court",
          stage: m.stage,
          winnerTeam,
          winnerPlayers: winnerPlayers || [],
          loserTeam,
          winnerScore,
          loserScore,
          timestamp: Date.now(),
        });
      }
      prevMatchStatusesRef.current.set(m.id, m.status);
    }
  }, [activeEventMatches]);

  // Auto-dismiss Winner Celebration after 16 seconds
  useEffect(() => {
    if (!celebration) return;
    const timer = setTimeout(() => {
      setCelebration(null);
    }, 16000);
    return () => clearTimeout(timer);
  }, [celebration]);

  // Auto-rotate cycle when enabled
  useEffect(() => {
    if (!autoRotate) return;
    const sequence: MonitorFocusMode[] = ["all", ...FACILITY_COURTS];
    const timer = setInterval(() => {
      setFocusMode((prev) => {
        const idx = sequence.indexOf(prev);
        const nextIdx = (idx + 1) % sequence.length;
        return sequence[nextIdx] ?? "all";
      });
    }, 12000);
    return () => clearInterval(timer);
  }, [autoRotate]);

  // Resolve each court's live/scheduled match and on-deck match
  const courtDataList = useMemo(() => {
    return FACILITY_COURTS.map((court) => {
      const st = stations[court];
      const match = findMatchForCourtStation(court, st, activeEventMatches);
      const onDeckMatch = st?.onDeckMatchId
        ? activeEventMatches.find((m) => m.id === st.onDeckMatchId)
        : queue.find(
            (q) =>
              q.assignedCourt === court &&
              (q.status === "on_deck" || q.status === "queued")
          );
      return {
        court,
        station: st,
        match,
        onDeckMatch,
      };
    });
  }, [stations, activeEventMatches, queue]);

  const liveCourtCount = useMemo(
    () => courtDataList.filter((c) => c.match?.status === "live").length,
    [courtDataList]
  );

  const handleToggleSide = useCallback((matchId: string, currentSide: "left" | "right") => {
    const next = currentSide === "left" ? "right" : "left";
    setSideOverrides((prev) => ({ ...prev, [matchId]: next }));
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(`dv_court_side_${matchId}`, next);
      } catch {
        // ignore
      }
    }
  }, []);

  const getEffectiveSide = useCallback(
    (matchId?: string, match?: LiveMatch | null): "left" | "right" => {
      if (!matchId) return "left";
      if (sideOverrides[matchId]) return sideOverrides[matchId]!;
      if (match?.teamASide === "left" || match?.teamASide === "right") {
        return match.teamASide;
      }
      if (typeof localStorage !== "undefined") {
        const saved = localStorage.getItem(`dv_court_side_${matchId}`);
        if (saved === "right" || saved === "left") return saved;
      }
      return "left";
    },
    [sideOverrides]
  );

  const formattedClock = useMemo(() => {
    try {
      return new Date(currentTime).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return "";
    }
  }, [currentTime]);

  const focusedCourtItem =
    focusMode === "all"
      ? null
      : courtDataList.find((c) => c.court === focusMode) ?? courtDataList[0]!;

  return (
    <div className="min-h-screen w-full bg-charcoal text-sand flex flex-col justify-between select-none overflow-x-hidden font-sans">
      {/* ── Winner Celebration Banner / Modal Overlay ── */}
      {celebration && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-in fade-in duration-300">
          <div className="relative w-full max-w-3xl border-4 border-pickle bg-charcoal p-6 sm:p-10 shadow-2xl text-center space-y-6">
            <button
              type="button"
              onClick={() => setCelebration(null)}
              className="absolute top-4 right-4 p-2 text-sand/60 hover:text-sand border border-border hover:border-pickle transition-colors cursor-pointer"
              title="Dismiss Winner Banner"
            >
              <X size={20} />
            </button>

            <div className="inline-flex items-center gap-2.5 px-4 py-1.5 bg-pickle/20 border-2 border-pickle text-pickle text-xs sm:text-sm font-mono font-bold uppercase tracking-[0.28em]">
              <Trophy size={16} />
              <span>Match Final &middot; Official Winner</span>
            </div>

            <div className="space-y-2">
              <div className="text-xs sm:text-sm font-mono uppercase tracking-widest text-sand/70">
                {celebration.court}
                {celebration.stage ? ` · ${celebration.stage}` : ""}
              </div>
              <h2 className="font-display text-5xl sm:text-7xl lg:text-8xl text-pickle tracking-wide leading-none">
                {celebration.winnerTeam}
              </h2>
              {celebration.winnerPlayers.length > 0 && (
                <p className="text-base sm:text-xl font-bold text-sand/90 tracking-wide">
                  {celebration.winnerPlayers.join(" / ")}
                </p>
              )}
            </div>

            <div className="inline-flex items-center justify-center gap-6 px-8 py-4 bg-black/60 border-2 border-pickle/50">
              <div className="text-center">
                <span className="block text-xs font-mono uppercase tracking-wider text-pickle font-bold">
                  {celebration.winnerTeam}
                </span>
                <span className="font-display text-5xl sm:text-7xl text-pickle leading-none">
                  {celebration.winnerScore}
                </span>
              </div>
              <span className="font-display text-3xl sm:text-4xl text-sand/40">-</span>
              <div className="text-center">
                <span className="block text-xs font-mono uppercase tracking-wider text-sand/70 font-bold">
                  {celebration.loserTeam}
                </span>
                <span className="font-display text-5xl sm:text-7xl text-sand/80 leading-none">
                  {celebration.loserScore}
                </span>
              </div>
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={() => setCelebration(null)}
                className="px-6 py-2.5 bg-pickle text-sand font-display text-lg tracking-widest uppercase hover:opacity-90 transition-opacity cursor-pointer"
              >
                Continue Live Broadcast
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Top Broadcast Control Bar ── */}
      <header className="border-b-2 border-pickle/40 bg-black/70 px-3 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 z-20">
        {/* Left: Club Identity & Tournament Title */}
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-charcoal border border-border hover:border-pickle text-sand text-xs font-bold uppercase tracking-wider transition-colors shrink-0"
            title="Return to Dink Valley Home"
          >
            <ArrowLeft size={14} className="text-pickle" />
            <span className="hidden sm:inline">Exit Monitor</span>
          </Link>

          <div className="flex items-center gap-2.5 min-w-0">
            <img
              src="/DinkValley.jpg"
              alt="Dink Valley"
              className="h-8 w-8 sm:h-9 sm:w-9 rounded-full object-cover border border-pickle/50 shrink-0"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-display text-lg sm:text-2xl text-sand tracking-wide leading-none truncate">
                  {activeTournament?.name || "Dink Valley Arena"}
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[0.6rem] font-mono font-bold uppercase tracking-widest border shrink-0 ${
                    isCloudSynced
                      ? "bg-pickle/20 border-pickle/50 text-pickle"
                      : "bg-amber-500/20 border-amber-500/40 text-amber-300"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      isCloudSynced ? "bg-pickle animate-ping" : "bg-amber-400"
                    }`}
                  />
                  {liveCourtCount > 0 ? `${liveCourtCount} Live` : "Live Sync"}
                </span>
              </div>
              <span className="block text-[0.6rem] font-mono uppercase tracking-[0.24em] text-pickle">
                Official Public Court Monitor &middot; Real-Time 2D Arena Display
              </span>
            </div>
          </div>
        </div>

        {/* Center: View Mode & Court Focus Selector */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => {
              setAutoRotate(false);
              setFocusMode("all");
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider border transition-all cursor-pointer ${
              focusMode === "all"
                ? "bg-pickle text-sand border-pickle shadow-sm"
                : "bg-charcoal text-sand/80 border-border hover:border-pickle hover:text-sand"
            }`}
          >
            <LayoutGrid size={13} />
            <span>2x2 All Courts</span>
          </button>

          {FACILITY_COURTS.map((court) => {
            const cData = courtDataList.find((c) => c.court === court);
            const isLive = cData?.match?.status === "live";
            const isSelected = focusMode === court;
            return (
              <button
                key={court}
                type="button"
                onClick={() => {
                  setAutoRotate(false);
                  setFocusMode(court);
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-bold uppercase tracking-wider border transition-all cursor-pointer ${
                  isSelected
                    ? "bg-pickle text-sand border-pickle shadow-sm"
                    : "bg-charcoal text-sand/80 border-border hover:border-pickle hover:text-sand"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    isLive
                      ? isSelected
                        ? "bg-sand animate-pulse"
                        : "bg-pickle animate-pulse"
                      : "bg-sand/30"
                  }`}
                />
                <span>{court}</span>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setAutoRotate((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono font-bold uppercase tracking-wider border transition-all cursor-pointer ${
              autoRotate
                ? "bg-brick text-sand border-brick shadow-sm"
                : "bg-charcoal text-sand/70 border-border hover:border-pickle hover:text-sand"
            }`}
            title="Automatically cycle between 2x2 All Courts and individual Courts every 12 seconds"
          >
            <RotateCw size={12} className={autoRotate ? "animate-spin" : ""} />
            <span className="hidden md:inline">Auto-Rotate</span>
          </button>
        </div>

        {/* Right: Tournament Selector, Clock & Fullscreen Button */}
        <div className="flex items-center gap-2.5">
          {activeTournaments.length > 1 && (
            <select
              value={selectedTournamentSlug}
              onChange={(e) => setSelectedTournamentSlug(e.target.value)}
              className="bg-charcoal border border-border text-sand text-xs font-semibold px-2.5 py-1.5 focus:outline-none focus:border-pickle cursor-pointer"
            >
              {activeTournaments.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          )}

          {formattedClock && (
            <div className="hidden lg:inline-flex items-center gap-1.5 px-2.5 py-1 bg-charcoal border border-border text-xs font-mono font-bold text-sand/90">
              <Clock size={12} className="text-pickle" />
              <span>{formattedClock}</span>
            </div>
          )}

          <button
            type="button"
            onClick={toggleFullscreen}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-pickle/20 border border-pickle/50 hover:bg-pickle text-pickle hover:text-sand text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer"
            title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen TV Mode"}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            <span className="hidden sm:inline">
              {isFullscreen ? "Exit Fullscreen" : "Fullscreen TV"}
            </span>
          </button>
        </div>
      </header>

      {/* ── Main Arena Viewport ── */}
      <div className="flex-1 flex flex-col justify-between p-2.5 sm:p-4 lg:p-5 gap-3 sm:gap-4">
        {focusMode === "all" ? (
          /* 2x2 All-Courts Arena Matrix */
          <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
            {courtDataList.map(({ court, station, match, onDeckMatch }) => (
              <ArenaCourtMonitorCard
                key={court}
                court={court}
                station={station}
                match={match}
                onDeckMatch={onDeckMatch}
                currentTime={currentTime}
                teamASide={getEffectiveSide(match?.id, match)}
                onToggleSide={
                  match
                    ? () => handleToggleSide(match.id, getEffectiveSide(match.id, match))
                    : undefined
                }
                onFocusCourt={() => {
                  setAutoRotate(false);
                  setFocusMode(court);
                }}
                isFocusedSingle={false}
              />
            ))}
          </div>
        ) : (
          /* Single-Court Focus Broadcast View */
          focusedCourtItem && (
            <div className="flex-1 flex flex-col">
              <ArenaCourtMonitorCard
                court={focusedCourtItem.court}
                station={focusedCourtItem.station}
                match={focusedCourtItem.match}
                onDeckMatch={focusedCourtItem.onDeckMatch}
                currentTime={currentTime}
                teamASide={getEffectiveSide(focusedCourtItem.match?.id, focusedCourtItem.match)}
                onToggleSide={
                  focusedCourtItem.match
                    ? () =>
                        handleToggleSide(
                          focusedCourtItem.match!.id,
                          getEffectiveSide(focusedCourtItem.match!.id, focusedCourtItem.match)
                        )
                    : undefined
                }
                onFocusCourt={() => setFocusMode("all")}
                isFocusedSingle={true}
              />
            </div>
          )
        )}

      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   ARENA COURT MONITOR CARD (2x2 & SINGLE FOCUS)
═══════════════════════════════════════════════ */

function ArenaCourtMonitorCard({
  court,
  station,
  match,
  onDeckMatch,
  currentTime,
  teamASide,
  onToggleSide,
  onFocusCourt,
  isFocusedSingle,
}: {
  court: FacilityCourt;
  station?: CourtStation | undefined;
  match: LiveMatch | null;
  onDeckMatch?: LiveMatch | QueueItem | undefined;
  currentTime: number;
  teamASide: "left" | "right";
  onToggleSide?: (() => void) | undefined;
  onFocusCourt: () => void;
  isFocusedSingle: boolean;
}) {
  const isLive = match?.status === "live";
  const isScheduled = match?.status === "scheduled";

  const positions = useMemo(
    () => (match ? computeCourtPositions(match) : null),
    [match]
  );

  // Elapsed time string
  const elapsedLabel = useMemo(() => {
    if (!match?.startedAt) return null;
    const endRef = match.endedAt ?? currentTime;
    const totalSec = Math.max(0, Math.floor((endRef - match.startedAt) / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, [match?.startedAt, match?.endedAt, currentTime]);

  if (!match) {
    return (
      <div
        className={`border-2 border-dashed border-border bg-black/40 flex flex-col justify-between p-4 sm:p-6 ${
          isFocusedSingle ? "min-h-[75vh]" : "min-h-[340px]"
        }`}
      >
        {/* Top Header */}
        <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
          <div className="flex items-center gap-2.5">
            <span
              className={`font-display tracking-wider text-sand ${
                isFocusedSingle ? "text-4xl sm:text-5xl" : "text-2xl sm:text-3xl"
              }`}
            >
              {court}
            </span>
            <span className="px-2.5 py-0.5 text-[0.65rem] font-mono font-bold uppercase tracking-widest bg-charcoal border border-border text-sand/60">
              Standby
            </span>
          </div>
          <button
            type="button"
            onClick={onFocusCourt}
            className="px-2.5 py-1 text-[0.65rem] font-mono font-bold uppercase tracking-wider border border-border hover:border-pickle text-sand/70 hover:text-pickle transition-colors cursor-pointer"
          >
            {isFocusedSingle ? "All Courts" : "Expand Court"}
          </button>
        </div>

        {/* Center Standby Visual */}
        <div className="my-auto py-8 text-center space-y-3">
          <Monitor
            size={isFocusedSingle ? 52 : 34}
            className="mx-auto text-pickle/40"
          />
          <div>
            <span
              className={`font-display uppercase tracking-widest text-sand/80 block ${
                isFocusedSingle ? "text-4xl" : "text-2xl"
              }`}
            >
              Court Available &middot; Waiting for Next Match
            </span>
            <p className="text-xs sm:text-sm text-sand/50 font-medium mt-1">
              Live scoreboard and 2D player positions will appear automatically upon dispatch.
            </p>
          </div>

          {onDeckMatch && (
            <div className="max-w-md mx-auto mt-4 p-3 bg-charcoal border border-pickle/40 text-left space-y-1">
              <span className="text-[0.6rem] font-mono font-bold uppercase tracking-widest text-pickle block">
                On Deck for {court}
              </span>
              <div className="text-sm sm:text-base font-bold text-sand flex items-center justify-between gap-2">
                <span className="truncate">{onDeckMatch.teamAName}</span>
                <span className="text-xs font-mono text-sand/50">vs</span>
                <span className="truncate text-right">{onDeckMatch.teamBName}</span>
              </div>
              {onDeckMatch.stage && (
                <span className="text-[0.62rem] font-mono text-sand/60 block">
                  {onDeckMatch.stage}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border/50 pt-2 flex items-center justify-between text-[0.65rem] font-mono uppercase tracking-wider text-sand/50">
          <span>Dink Valley Facility Station</span>
          <span>Official: {station?.assignedUmpire || "Unassigned"}</span>
        </div>
      </div>
    );
  }

  const s = match.score;
  const leftTeam = teamASide === "right" ? "B" : "A";
  const rightTeam = teamASide === "right" ? "A" : "B";

  const leftTeamName = leftTeam === "A" ? match.teamAName : match.teamBName;
  const rightTeamName = rightTeam === "A" ? match.teamAName : match.teamBName;
  const leftPlayers = resolveMatchTeamPlayers(
    leftTeam === "A" ? match.teamAPlayers : match.teamBPlayers,
    leftTeamName,
    `Player ${leftTeam}1`
  );
  const rightPlayers = resolveMatchTeamPlayers(
    rightTeam === "A" ? match.teamAPlayers : match.teamBPlayers,
    rightTeamName,
    `Player ${rightTeam}1`
  );
  const leftClub = leftTeam === "A" ? match.teamAClub : match.teamBClub;
  const rightClub = rightTeam === "A" ? match.teamAClub : match.teamBClub;
  const leftScore = leftTeam === "A" ? s.teamAScore : s.teamBScore;
  const rightScore = rightTeam === "A" ? s.teamAScore : s.teamBScore;

  const isLeftServing = s.servingTeam === leftTeam && match.status !== "final";
  const isRightServing = s.servingTeam === rightTeam && match.status !== "final";

  const serverScore = s.servingTeam === "A" ? s.teamAScore : s.teamBScore;
  const receiverScore = s.servingTeam === "A" ? s.teamBScore : s.teamAScore;

  const lastRally =
    s.rallies && s.rallies.length > 0 ? s.rallies[s.rallies.length - 1] : null;
  const operatingOfficial = match.officiatedBy || station?.assignedUmpire || "Official";

  return (
    <div
      className={`border-2 flex flex-col justify-between transition-all bg-charcoal ${
        isLive
          ? "border-pickle shadow-lg shadow-pickle/10"
          : isScheduled
          ? "border-sand/50"
          : "border-border"
      } ${isFocusedSingle ? "p-4 sm:p-6 lg:p-8 min-h-[76vh]" : "p-3 sm:p-4"}`}
    >
      {/* 1. Court Top Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/15 pb-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`font-display tracking-wider text-sand leading-none ${
              isFocusedSingle ? "text-3xl sm:text-5xl" : "text-2xl sm:text-3xl"
            }`}
          >
            {court}
          </span>

          {isLive ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[0.65rem] sm:text-xs font-mono font-bold uppercase tracking-widest bg-pickle text-sand">
              <span className="h-2 w-2 rounded-full bg-sand animate-ping" />
              Live
            </span>
          ) : (
            <span className="inline-flex items-center px-2.5 py-0.5 text-[0.65rem] sm:text-xs font-mono font-bold uppercase tracking-widest bg-sand/20 border border-sand/40 text-sand">
              Warm-Up / Ready
            </span>
          )}

          {match.stage && (
            <span className="px-2.5 py-0.5 text-[0.65rem] sm:text-xs font-mono font-bold uppercase tracking-wider bg-pickle/15 border border-pickle/40 text-pickle truncate max-w-[200px] sm:max-w-xs">
              {match.stage}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {elapsedLabel && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-black/60 border border-white/15 text-[0.65rem] sm:text-xs font-mono font-bold text-sand/90">
              <Clock size={11} className="text-pickle" />
              {elapsedLabel}
            </span>
          )}

          {onToggleSide && (
            <button
              type="button"
              onClick={onToggleSide}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-black/60 border border-white/20 hover:border-pickle text-[0.62rem] font-mono font-bold uppercase tracking-wider text-sand/80 hover:text-pickle transition-colors cursor-pointer"
              title="Flip Left/Right Court Orientation on Monitor"
            >
              <ArrowLeftRight size={11} />
              <span>Flip Ends</span>
            </button>
          )}

          <button
            type="button"
            onClick={onFocusCourt}
            className="px-2.5 py-0.5 bg-black/60 border border-white/20 hover:border-pickle text-[0.62rem] font-mono font-bold uppercase tracking-wider text-sand/80 hover:text-pickle transition-colors cursor-pointer"
          >
            {isFocusedSingle ? "2x2 Grid" : "Full View"}
          </button>
        </div>
      </div>

      {/* 2. Giant Broadcast Scoreboard Row */}
      <div
        className={`grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4 my-2 ${
          isFocusedSingle ? "py-3 sm:py-5" : "py-1.5"
        }`}
      >
        {/* Left Team Score & Info */}
        <div
          className={`flex items-center justify-between gap-2 p-2.5 sm:p-3.5 border-2 transition-colors min-w-0 ${
            isLeftServing
              ? "bg-pickle/15 border-pickle"
              : "bg-black/45 border-white/15"
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className={`inline-block px-1.5 py-0.2 text-[0.58rem] font-mono font-bold uppercase tracking-widest ${
                  leftTeam === "A"
                    ? "bg-pickle text-sand"
                    : "bg-brick text-sand"
                }`}
              >
                Team {leftTeam}
              </span>
              {isLeftServing && (
                <span className="inline-flex items-center gap-1 px-2 py-0.2 bg-pickle text-sand text-[0.6rem] font-mono font-bold uppercase tracking-widest">
                  <span className="h-1.5 w-1.5 rounded-full bg-sand animate-pulse" />
                  Server #{s.serverNumber}
                </span>
              )}
              {leftClub && (
                <span className="text-[0.58rem] font-mono uppercase tracking-wider px-1.5 py-0.2 bg-white/10 text-sand/80">
                  {leftClub}
                </span>
              )}
            </div>

            <div
              className={`font-bold text-sand truncate mt-1 ${
                isFocusedSingle
                  ? "text-xl sm:text-3xl lg:text-4xl"
                  : "text-sm sm:text-lg lg:text-xl"
              }`}
              title={leftTeamName}
            >
              {leftTeamName}
            </div>

            {leftPlayers && leftPlayers.length > 0 && (
              <div
                className={`text-sand/75 font-medium truncate ${
                  isFocusedSingle ? "text-sm sm:text-base" : "text-xs"
                }`}
              >
                {leftPlayers.join(" / ")}
              </div>
            )}
          </div>

          <span
            className={`font-display leading-none shrink-0 ${
              isLeftServing ? "text-pickle" : "text-sand"
            } ${
              isFocusedSingle
                ? "text-6xl sm:text-8xl lg:text-9xl"
                : "text-4xl sm:text-6xl"
            }`}
          >
            {leftScore}
          </span>
        </div>

        {/* Center 3-Number Official Score Call */}
        <div className="text-center px-2.5 sm:px-4 py-2 bg-black/80 border-2 border-pickle/50 shrink-0">
          <div
            className={`font-display text-sand tracking-wider leading-none font-bold ${
              isFocusedSingle
                ? "text-3xl sm:text-5xl lg:text-6xl"
                : "text-2xl sm:text-3xl lg:text-4xl"
            }`}
          >
            {serverScore}
            <span className="text-pickle mx-1">-</span>
            {receiverScore}
            <span className="text-pickle mx-1">-</span>
            {s.serverNumber}
          </div>
          <span className="block text-[0.55rem] sm:text-[0.62rem] font-mono uppercase tracking-[0.22em] text-pickle font-bold mt-1">
            Score Call
          </span>
        </div>

        {/* Right Team Score & Info */}
        <div
          className={`flex items-center justify-between gap-2 p-2.5 sm:p-3.5 border-2 transition-colors min-w-0 ${
            isRightServing
              ? "bg-pickle/15 border-pickle"
              : "bg-black/45 border-white/15"
          }`}
        >
          <span
            className={`font-display leading-none shrink-0 ${
              isRightServing ? "text-pickle" : "text-sand"
            } ${
              isFocusedSingle
                ? "text-6xl sm:text-8xl lg:text-9xl"
                : "text-4xl sm:text-6xl"
            }`}
          >
            {rightScore}
          </span>

          <div className="min-w-0 flex-1 text-right">
            <div className="flex items-center justify-end gap-1.5 flex-wrap">
              {rightClub && (
                <span className="text-[0.58rem] font-mono uppercase tracking-wider px-1.5 py-0.2 bg-white/10 text-sand/80">
                  {rightClub}
                </span>
              )}
              {isRightServing && (
                <span className="inline-flex items-center gap-1 px-2 py-0.2 bg-pickle text-sand text-[0.6rem] font-mono font-bold uppercase tracking-widest">
                  <span className="h-1.5 w-1.5 rounded-full bg-sand animate-pulse" />
                  Server #{s.serverNumber}
                </span>
              )}
              <span
                className={`inline-block px-1.5 py-0.2 text-[0.58rem] font-mono font-bold uppercase tracking-widest ${
                  rightTeam === "A"
                    ? "bg-pickle text-sand"
                    : "bg-brick text-sand"
                }`}
              >
                Team {rightTeam}
              </span>
            </div>

            <div
              className={`font-bold text-sand truncate mt-1 ${
                isFocusedSingle
                  ? "text-xl sm:text-3xl lg:text-4xl"
                  : "text-sm sm:text-lg lg:text-xl"
              }`}
              title={rightTeamName}
            >
              {rightTeamName}
            </div>

            {rightPlayers && rightPlayers.length > 0 && (
              <div
                className={`text-sand/75 font-medium truncate ${
                  isFocusedSingle ? "text-sm sm:text-base" : "text-xs"
                }`}
              >
                {rightPlayers.join(" / ")}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3. Live 2D Pickleball Court Diagram */}
      {positions && (
        <Arena2DCourtDiagram
          match={match}
          teamAPos={positions.teamA}
          teamBPos={positions.teamB}
          teamASide={teamASide}
          isFocusedSingle={isFocusedSingle}
        />
      )}

      {/* 4. Bottom Rally Feed & Official Footer */}
      <div className="mt-2 pt-2 border-t border-white/15 flex flex-wrap items-center justify-between gap-2 text-[0.65rem] sm:text-xs font-mono">
        <div className="flex items-center gap-2 min-w-0 truncate">
          <span className="uppercase tracking-wider text-pickle font-bold shrink-0">
            Latest Call:
          </span>
          <span className="text-sand/90 truncate">
            {lastRally
              ? `${lastRally.description} (${lastRally.scoreSnapshot.join("-")})`
              : `Match ready on ${court} · Opening serve (${serverScore}-${receiverScore}-${s.serverNumber})`}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0 text-sand/70">
          {onDeckMatch && (
            <span className="hidden sm:inline text-sand/80">
              On Deck:{" "}
              <strong className="text-pickle">
                {onDeckMatch.teamAName} vs {onDeckMatch.teamBName}
              </strong>
            </span>
          )}
          <span>
            Official: <strong className="text-sand">{operatingOfficial}</strong>
          </span>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   2D OVERHEAD PICKLEBALL COURT DIAGRAM FOR TV
═══════════════════════════════════════════════ */

function Arena2DCourtDiagram({
  match,
  teamAPos,
  teamBPos,
  teamASide,
  isFocusedSingle,
}: {
  match: LiveMatch;
  teamAPos: TeamCourtPositions;
  teamBPos: TeamCourtPositions;
  teamASide: "left" | "right";
  isFocusedSingle: boolean;
}) {
  const s = match.score;
  const leftTeam = teamASide === "right" ? "B" : "A";
  const rightTeam = teamASide === "right" ? "A" : "B";
  const leftPos = leftTeam === "A" ? teamAPos : teamBPos;
  const rightPos = rightTeam === "A" ? teamAPos : teamBPos;

  const renderPlayerBadge = (
    player: { name: string; base: 1 | 2; isServing: boolean; isReceiver: boolean },
    teamLetter: "A" | "B"
  ) => {
    if (!player.name || player.name === "-") {
      return (
        <span className="text-[0.65rem] font-mono text-sand/30 uppercase select-none">
          Empty
        </span>
      );
    }

    return (
      <div
        className={`inline-flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3.5 py-1 sm:py-1.5 rounded-full font-bold max-w-[96%] transition-all shadow-md ${
          player.isServing
            ? "border-2 border-dashed border-amber-300 ring-2 ring-amber-400/30"
            : player.isReceiver
            ? "ring-2 ring-sand shadow-lg"
            : "border border-sand/30"
        } ${teamLetter === "A" ? "bg-pickle text-sand" : "bg-brick text-sand"} ${
          isFocusedSingle ? "text-sm sm:text-lg" : "text-xs sm:text-sm"
        }`}
      >
        {/* Dot marker on active receiver */}
        {player.isReceiver && (
          <span
            className="w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full bg-sand text-charcoal flex items-center justify-center shrink-0 shadow-xs border border-charcoal/30"
            title="Active Receiver"
          >
            <span className="w-2 h-2 rounded-full bg-pickle inline-block" />
          </span>
        )}

        <span className="truncate">{player.name}</span>

        {player.isServing && (
          <span className="px-1.5 py-0.2 rounded bg-black/75 text-pickle font-mono text-[0.58rem] sm:text-xs font-black uppercase shrink-0">
            SRV #{s.serverNumber}
          </span>
        )}

        {player.isReceiver && (
          <span className="px-1.5 py-0.2 rounded bg-amber-400 text-charcoal font-mono text-[0.58rem] sm:text-xs font-black uppercase shrink-0">
            RCV
          </span>
        )}

        <span className="px-1.5 py-0.2 rounded bg-charcoal/85 text-sand/90 font-mono text-[0.55rem] sm:text-[0.65rem] font-bold shrink-0">
          B{player.base}
        </span>
      </div>
    );
  };

  return (
    <div className="w-full bg-[#0e1f16] p-2 sm:p-3 border border-pickle/40">
      <div
        className={`relative w-full bg-[#12281c] border-2 border-sand/70 flex overflow-hidden ${
          isFocusedSingle ? "h-56 sm:h-72 lg:h-80" : "h-36 sm:h-44 lg:h-48"
        }`}
      >
        {/* LEFT HALF OF COURT */}
        <div className="w-1/2 h-full flex border-r-2 border-sand">
          {/* Left Team Service Boxes */}
          <div className="w-[65%] h-full flex flex-col border-r border-sand/50">
            {/* Left Service Court (Top, Odd) */}
            <div
              className={`relative h-1/2 w-full border-b border-sand/50 flex items-center justify-center p-1.5 transition-colors ${
                leftPos.left.isServing
                  ? "bg-pickle/20"
                  : leftPos.left.isReceiver
                  ? "bg-amber-400/10"
                  : "bg-[#152e20]/90"
              }`}
            >
              <span className="absolute top-1 left-1.5 text-[0.6rem] sm:text-xs font-mono font-bold text-sand/40">
                L (ODD)
              </span>
              {renderPlayerBadge(leftPos.left, leftTeam)}
            </div>

            {/* Right Service Court (Bottom, Even) */}
            <div
              className={`relative h-1/2 w-full flex items-center justify-center p-1.5 transition-colors ${
                leftPos.right.isServing
                  ? "bg-pickle/20"
                  : leftPos.right.isReceiver
                  ? "bg-amber-400/10"
                  : "bg-[#152e20]/90"
              }`}
            >
              <span className="absolute bottom-1 left-1.5 text-[0.6rem] sm:text-xs font-mono font-bold text-sand/40">
                R (EVEN)
              </span>
              {renderPlayerBadge(leftPos.right, leftTeam)}
            </div>
          </div>

          {/* Left Kitchen (NVZ) */}
          <div className="w-[35%] h-full bg-[#1b4332] flex items-center justify-center select-none">
            <span className="text-[0.55rem] sm:text-xs font-mono font-bold uppercase tracking-widest text-sand/40 [writing-mode:vertical-lr] rotate-180">
              Kitchen (NVZ)
            </span>
          </div>
        </div>

        {/* RIGHT HALF OF COURT */}
        <div className="w-1/2 h-full flex">
          {/* Right Kitchen (NVZ) */}
          <div className="w-[35%] h-full bg-[#1b4332] border-r border-sand/50 flex items-center justify-center select-none">
            <span className="text-[0.55rem] sm:text-xs font-mono font-bold uppercase tracking-widest text-sand/40 [writing-mode:vertical-lr]">
              Kitchen (NVZ)
            </span>
          </div>

          {/* Right Team Service Boxes */}
          <div className="w-[65%] h-full flex flex-col">
            {/* Right Service Court (Top, Even) */}
            <div
              className={`relative h-1/2 w-full border-b border-sand/50 flex items-center justify-center p-1.5 transition-colors ${
                rightPos.right.isServing
                  ? "bg-pickle/20"
                  : rightPos.right.isReceiver
                  ? "bg-amber-400/10"
                  : "bg-[#152e20]/90"
              }`}
            >
              <span className="absolute top-1 right-1.5 text-[0.6rem] sm:text-xs font-mono font-bold text-sand/40">
                R (EVEN)
              </span>
              {renderPlayerBadge(rightPos.right, rightTeam)}
            </div>

            {/* Left Service Court (Bottom, Odd) */}
            <div
              className={`relative h-1/2 w-full flex items-center justify-center p-1.5 transition-colors ${
                rightPos.left.isServing
                  ? "bg-pickle/20"
                  : rightPos.left.isReceiver
                  ? "bg-amber-400/10"
                  : "bg-[#152e20]/90"
              }`}
            >
              <span className="absolute bottom-1 right-1.5 text-[0.6rem] sm:text-xs font-mono font-bold text-sand/40">
                L (ODD)
              </span>
              {renderPlayerBadge(rightPos.left, rightTeam)}
            </div>
          </div>
        </div>

        {/* CENTER NET */}
        <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-1.5 bg-sand flex flex-col justify-between items-center pointer-events-none z-10">
          <span className="w-2.5 h-2.5 rounded-full bg-charcoal border border-sand -mt-1" />
          <span className="w-2.5 h-2.5 rounded-full bg-charcoal border border-sand -mb-1" />
        </div>
      </div>
    </div>
  );
}
