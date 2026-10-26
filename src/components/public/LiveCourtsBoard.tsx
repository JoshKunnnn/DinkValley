import { useState, useEffect, useMemo } from "react";
import type { Category } from "@/data/tournaments";
import { useMatchStore, type LiveMatch } from "@/lib/match-store";
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
import { dbSubscribeToLive } from "@/lib/supabase-service";
import { MiniCourtVisualizer } from "@/components/public/MiniCourtVisualizer";

interface LiveCourtsBoardProps {
  tournamentSlug: string;
  categories: Category[];
  currentCategoryId?: string;
  onTeamClick?: (teamName: string) => void;
}

export function LiveCourtsBoard({
  tournamentSlug,
  categories,
  currentCategoryId,
  onTeamClick,
}: LiveCourtsBoardProps) {
  const { matches, refreshFromCloud } = useMatchStore(tournamentSlug || undefined);
  const [stations, setStations] = useState<Record<FacilityCourt, CourtStation>>(() => getCourtStations());
  const [revision, setRevision] = useState(0);
  const [expandedCourt, setExpandedCourt] = useState<FacilityCourt | null>(null);

  // Synchronize with dispatch desk and live court station updates
  useEffect(() => {
    let mounted = true;

    // Initial hydration of court stations from Supabase
    hydrateCourtStationsFromCloud().then((cloud) => {
      if (mounted) setStations(cloud);
    });

    const handleUpdate = () => {
      setStations(getCourtStations());
      setRevision((prev) => prev + 1);
    };

    window.addEventListener("dv_live_matches_updated", handleUpdate);
    window.addEventListener("dv_court_stations_updated", handleUpdate);
    window.addEventListener("dv_dispatch_queue_updated", handleUpdate);
    window.addEventListener("storage", handleUpdate);

    // Listen to shared Realtime channel for court station changes
    const unsubRealtime = dbSubscribeToLive(
      () => {
        refreshFromCloud().catch(() => {});
        hydrateCourtStationsFromCloud().then((cloud) => {
          if (mounted) setStations(cloud);
        });
      },
      () => {
        hydrateCourtStationsFromCloud().then((cloud) => {
          if (mounted) setStations(cloud);
        });
      }
    );

    return () => {
      mounted = false;
      unsubRealtime();
      window.removeEventListener("dv_live_matches_updated", handleUpdate);
      window.removeEventListener("dv_court_stations_updated", handleUpdate);
      window.removeEventListener("dv_dispatch_queue_updated", handleUpdate);
      window.removeEventListener("storage", handleUpdate);
    };
  }, []);

  const queue: QueueItem[] = useMemo(
    () => getDispatchQueue(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [matches, revision],
  );

  // Filter tournament-relevant matches
  const tournamentMatches = useMemo(() => {
    return matches.filter(
      (m) => !m.tournamentSlug || m.tournamentSlug === tournamentSlug,
    );
  }, [matches, tournamentSlug]);

  // Count active live courts
  const liveCourtsCount = useMemo(() => {
    return FACILITY_COURTS.filter((courtName) => {
      const live = tournamentMatches.find(
        (m) => m.court === courtName && m.status === "live",
      );
      return !!live;
    }).length;
  }, [tournamentMatches]);

  // Fallback queued matches without court assignment for standby display
  const unassignedQueue = useMemo(() => {
    return queue.filter(
      (q) =>
        (!q.tournamentSlug || q.tournamentSlug === tournamentSlug) &&
        (q.status === "queued" || q.status === "on_deck") &&
        (!q.assignedCourt || q.assignedCourt === ("Queue" as any)),
    );
  }, [queue, tournamentSlug]);

  return (
    <div className="surface-card p-4 sm:p-5 border-2 border-border rounded-2xl space-y-4 bg-card">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b-2 border-border/80 pb-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold uppercase tracking-[0.24em] text-emerald-700 dark:text-emerald-400 font-mono">
              Facility Courts 1–4 &middot; Live Action
            </span>
            {liveCourtsCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-extrabold uppercase tracking-wider bg-emerald-600 text-white rounded-full shadow-sm">
                <span className="h-2 w-2 rounded-full bg-white animate-ping" />
                {liveCourtsCount} {liveCourtsCount === 1 ? "Court" : "Courts"} Live Now
              </span>
            ) : (
              <span className="px-3 py-1 text-xs font-bold uppercase tracking-wider bg-stone-200 dark:bg-stone-800 text-stone-800 dark:text-stone-200 border border-border rounded-full">
                All Courts Standby
              </span>
            )}
          </div>
          <h3 className="font-display text-3xl sm:text-4xl text-foreground font-black mt-1 tracking-wide">
            Courts Live View
          </h3>
          <p className="text-xs sm:text-sm text-foreground/80 font-medium mt-1">
            Real-time score counters, serving indicators, and match progress streamed directly from umpire terminals.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <span className="text-xs font-mono font-bold uppercase tracking-wider border-2 border-border px-3 py-1 rounded-lg bg-stone-100 dark:bg-stone-800 text-stone-800 dark:text-stone-200 shadow-xs">
            Auto-Sync Active
          </span>
        </div>
      </div>

      {/* ── 4 Dedicated Facility Courts Grid ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {FACILITY_COURTS.map((courtName, courtIdx) => {
          const station = stations[courtName];

          // 1. Resolve active match occupying this court station
          const activeMatch = findMatchForCourtStation(courtName, station, tournamentMatches);
          const liveMatch = activeMatch?.status === "live" ? activeMatch : null;
          const scheduledMatch = activeMatch?.status === "scheduled" ? activeMatch : null;

          // 3. Find on-deck match
          const onDeckMatch = station?.onDeckMatchId
            ? tournamentMatches.find((m) => m.id === station.onDeckMatchId)
            : queue.find(
                (q) =>
                  q.assignedCourt === courtName &&
                  (q.status === "on_deck" || q.status === "queued"),
              );

          // 4. Resolve category information for active match
          const activeCategory = activeMatch?.categoryId
            ? categories.find(
                (c) =>
                  c.id === activeMatch.categoryId ||
                  (c as any).category_slug === activeMatch.categoryId,
              )
            : null;

          const isCurrentCategoryMatch =
            currentCategoryId && activeCategory?.id === currentCategoryId;

          // Fallback queue item for standby court
          const standbyNext = !activeMatch && !onDeckMatch ? unassignedQueue[courtIdx] : null;

          const isExpanded = expandedCourt === courtName;

          return (
            <div
              key={courtName}
              className={`p-4 rounded-xl border-2 flex flex-col justify-between transition-all ${
                liveMatch
                  ? isCurrentCategoryMatch
                    ? "bg-card border-emerald-600 shadow-md ring-2 ring-emerald-600/30"
                    : "bg-card border-emerald-600/80 shadow-sm"
                  : station?.status === "warmup"
                    ? "bg-card border-amber-500 shadow-sm"
                    : station?.status === "maintenance"
                      ? "bg-card border-red-600 shadow-sm"
                      : "bg-card border-border hover:border-emerald-600/50"
              }`}
            >
              <div className="space-y-3">
                {/* Court Top Bar */}
                <div className="flex items-center justify-between border-b-2 border-border/80 pb-2.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-display text-2xl text-foreground font-black tracking-wide">
                      {courtName}
                    </span>
                    {isCurrentCategoryMatch && (
                      <span className="px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider bg-emerald-700 text-white rounded font-mono shadow-xs">
                        This Division
                      </span>
                    )}
                  </div>

                  {liveMatch ? (
                    <span className="px-2.5 py-1 text-xs font-black uppercase tracking-wider bg-emerald-600 text-white rounded-md shadow-xs flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-white animate-ping" />
                      Live Now
                    </span>
                  ) : station?.status === "warmup" ? (
                    <span className="px-2.5 py-1 text-xs font-black uppercase tracking-wider bg-amber-500 text-white rounded-md shadow-xs">
                      Warm-up
                    </span>
                  ) : station?.status === "maintenance" ? (
                    <span className="px-2.5 py-1 text-xs font-black uppercase tracking-wider bg-red-600 text-white rounded-md shadow-xs">
                      Maintenance
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 text-xs font-bold uppercase tracking-wider bg-stone-200 dark:bg-stone-800 text-stone-800 dark:text-stone-200 border border-stone-300 dark:border-stone-700 rounded-md">
                      Open / Ready
                    </span>
                  )}
                </div>

                {/* Division & Stage Header */}
                {activeMatch && (
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="font-extrabold text-foreground text-xs sm:text-sm truncate">
                      {activeCategory?.label || "Tournament Match"}
                    </span>
                    <span className="text-emerald-800 dark:text-emerald-300 font-mono font-bold text-xs px-2 py-0.5 bg-emerald-100 dark:bg-emerald-950/60 rounded border border-emerald-300 dark:border-emerald-800/60 shrink-0">
                      {activeMatch.stage || "Pool Play"}
                    </span>
                  </div>
                )}

                {/* ── High-Contrast Broadcast Digital Scoreboard ── */}
                {activeMatch ? (
                  <div className="space-y-2 bg-[#0c1410] border-2 border-emerald-500/70 p-3 rounded-xl shadow-lg text-white">
                    {/* Team A */}
                    {(() => {
                      const isServing = activeMatch.score.servingTeam === "A" && Boolean(liveMatch);
                      return (
                        <div
                          onClick={() => onTeamClick?.(activeMatch.teamAName)}
                          className={`p-2.5 rounded-lg flex items-center justify-between transition-all ${
                            isServing
                              ? "bg-[#182920] border-2 border-emerald-400 shadow-sm"
                              : "bg-[#121c17] border border-white/10"
                          } ${onTeamClick ? "cursor-pointer hover:ring-1 hover:ring-white/40" : ""}`}
                        >
                          <div className="min-w-0 pr-2 space-y-0.5">
                            <div className="flex items-center gap-2">
                              {isServing && (
                                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399] shrink-0" />
                              )}
                              <span
                                className={`truncate font-black text-base sm:text-lg tracking-wide ${
                                  isServing ? "text-white" : "text-white/95"
                                }`}
                              >
                                {activeMatch.teamAName}
                              </span>
                              {isServing && (
                                <span className="bg-emerald-400 text-black text-[0.6rem] font-black px-1.5 py-0.2 rounded font-mono uppercase shrink-0">
                                  Serve
                                </span>
                              )}
                            </div>
                            {activeMatch.teamAPlayers && activeMatch.teamAPlayers.length > 0 && (
                              <div
                                className={`text-xs font-mono truncate ${
                                  isServing ? "text-emerald-200 font-semibold pl-4" : "text-stone-300 font-medium"
                                }`}
                              >
                                {activeMatch.teamAPlayers.join(" & ")}
                              </div>
                            )}
                          </div>
                          <span
                            className={`font-display text-4xl sm:text-5xl font-black tabular-nums shrink-0 ml-3 ${
                              isServing
                                ? "text-emerald-400 drop-shadow-[0_2px_8px_rgba(52,211,153,0.35)]"
                                : "text-white"
                            }`}
                          >
                            {activeMatch.score.teamAScore}
                          </span>
                        </div>
                      );
                    })()}

                    <div className="h-px bg-white/15 my-1" />

                    {/* Team B */}
                    {(() => {
                      const isServing = activeMatch.score.servingTeam === "B" && Boolean(liveMatch);
                      return (
                        <div
                          onClick={() => onTeamClick?.(activeMatch.teamBName)}
                          className={`p-2.5 rounded-lg flex items-center justify-between transition-all ${
                            isServing
                              ? "bg-[#182920] border-2 border-emerald-400 shadow-sm"
                              : "bg-[#121c17] border border-white/10"
                          } ${onTeamClick ? "cursor-pointer hover:ring-1 hover:ring-white/40" : ""}`}
                        >
                          <div className="min-w-0 pr-2 space-y-0.5">
                            <div className="flex items-center gap-2">
                              {isServing && (
                                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_#34d399] shrink-0" />
                              )}
                              <span
                                className={`truncate font-black text-base sm:text-lg tracking-wide ${
                                  isServing ? "text-white" : "text-white/95"
                                }`}
                              >
                                {activeMatch.teamBName}
                              </span>
                              {isServing && (
                                <span className="bg-emerald-400 text-black text-[0.6rem] font-black px-1.5 py-0.2 rounded font-mono uppercase shrink-0">
                                  Serve
                                </span>
                              )}
                            </div>
                            {activeMatch.teamBPlayers && activeMatch.teamBPlayers.length > 0 && (
                              <div
                                className={`text-xs font-mono truncate ${
                                  isServing ? "text-emerald-200 font-semibold pl-4" : "text-stone-300 font-medium"
                                }`}
                              >
                                {activeMatch.teamBPlayers.join(" & ")}
                              </div>
                            )}
                          </div>
                          <span
                            className={`font-display text-4xl sm:text-5xl font-black tabular-nums shrink-0 ml-3 ${
                              isServing
                                ? "text-emerald-400 drop-shadow-[0_2px_8px_rgba(52,211,153,0.35)]"
                                : "text-white"
                            }`}
                          >
                            {activeMatch.score.teamBScore}
                          </span>
                        </div>
                      );
                    })()}

                    {/* Service Call Readout & 2D Court Toggle */}
                    {liveMatch && (
                      <div className="mt-2.5 pt-2 border-t border-white/15 flex items-center justify-between text-xs font-mono">
                        <span className="text-emerald-400 font-black tracking-wider flex items-center gap-1.5">
                          <span>CALL:</span>
                          <span className="text-white bg-black/60 px-2 py-0.5 rounded border border-emerald-500/40 text-xs">
                            {activeMatch.score.servingTeam === "A"
                              ? activeMatch.score.teamAScore
                              : activeMatch.score.teamBScore}
                            -
                            {activeMatch.score.servingTeam === "A"
                              ? activeMatch.score.teamBScore
                              : activeMatch.score.teamAScore}
                            -{activeMatch.score.serverNumber}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedCourt((curr) => (curr === courtName ? null : courtName))
                          }
                          className="bg-emerald-950/90 hover:bg-emerald-900 text-emerald-200 hover:text-white border border-emerald-700/60 px-2.5 py-1 rounded text-[0.65rem] font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer"
                        >
                          {isExpanded ? "Hide 2D Court" : "View 2D Court"}
                        </button>
                      </div>
                    )}

                    {/* Embedded 2D Court View when expanded */}
                    {liveMatch && isExpanded && (
                      <div className="mt-2 pt-2 border-t border-white/15">
                        <MiniCourtVisualizer
                          score={liveMatch.score}
                          teamAName={liveMatch.teamAName}
                          teamBName={liveMatch.teamBName}
                          compact={true}
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="py-6 px-4 text-center space-y-2 bg-stone-100/90 dark:bg-stone-900/60 rounded-xl border-2 border-dashed border-stone-300 dark:border-stone-700">
                    <span className="text-xs font-mono uppercase tracking-widest text-foreground/60 font-bold block">
                      Court Available
                    </span>
                    <h4 className="text-foreground font-display text-2xl font-bold tracking-wide">
                      Ready for Play
                    </h4>
                    {standbyNext ? (
                      <div className="p-3 bg-white dark:bg-stone-800 border-2 border-emerald-600/40 rounded-lg text-left space-y-1 shadow-xs">
                        <span className="text-[0.65rem] text-emerald-800 dark:text-emerald-400 block uppercase font-mono font-black tracking-wider">
                          Next in Queue:
                        </span>
                        <span className="font-extrabold text-foreground text-sm block truncate">
                          {standbyNext.teamAName} vs {standbyNext.teamBName}
                        </span>
                        <span className="text-[0.7rem] text-foreground/70 font-mono block">
                          {standbyNext.stage}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-foreground/70 font-medium block">
                        Awaiting next match dispatch from desk
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* On-Deck Footer */}
              {onDeckMatch && (
                <div className="mt-3.5 pt-2.5 border-t-2 border-border/80 text-xs">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-black text-emerald-800 dark:text-emerald-400 uppercase font-mono tracking-wider text-[0.68rem] shrink-0">
                      ON DECK:
                    </span>
                    <span className="truncate text-foreground font-bold text-xs text-right">
                      {"teamAName" in onDeckMatch
                        ? `${onDeckMatch.teamAName} vs ${onDeckMatch.teamBName}`
                        : "Next Match"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
