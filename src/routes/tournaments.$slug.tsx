import { createFileRoute, notFound, Link } from "@tanstack/react-router";
import { useState, useMemo, useEffect } from "react";
import {
  getTournament,
  teamName,
  type Category,
  type Tournament,
  type Team,
} from "@/data/tournaments";
import { useTournamentStore } from "@/lib/tournament-store";
import {
  useMatchStore,
  findLiveMatchForTeams,
  type LiveMatch,
} from "@/lib/match-store";
import {
  FACILITY_COURTS,
  type FacilityCourt,
  getCourtStations,
  getDispatchQueue,
  isConfirmedDispatchedMatch,
} from "@/lib/court-dispatch";
import { getDrawnGroups, type BracketGroup } from "@/components/admin/BracketDraw";
import { getMainDrawMatches, type KnockoutMatch } from "@/components/admin/DrawsManager";

export const Route = createFileRoute("/tournaments/$slug")({
  loader: ({ params }) => {
    const tournament = getTournament(params.slug);
    if (!tournament) throw notFound();
    return tournament;
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.name ?? "Tournament"} | Dink Valley` },
      { name: "description", content: loaderData?.tagline ?? "Dink Valley tournament details and live scores." },
      { property: "og:title", content: loaderData?.name ?? "Dink Valley tournament" },
      { property: "og:description", content: loaderData?.tagline ?? "Live scores, brackets, and results." },
    ],
  }),
  component: TournamentPage,
  errorComponent: () => (
    <div className="mx-auto max-w-3xl px-5 py-24 text-center">
      <h1 className="text-4xl font-display">This tournament didn't load</h1>
      <Link to="/" className="mt-4 inline-block text-primary underline font-semibold">
        Back to tournaments
      </Link>
    </div>
  ),
  notFoundComponent: () => (
    <div className="mx-auto max-w-3xl px-5 py-24 text-center">
      <h1 className="text-4xl font-display">Tournament not found</h1>
      <Link to="/" className="mt-4 inline-block text-primary underline font-semibold">
        Back to tournaments
      </Link>
    </div>
  ),
});

type TabKey = "live" | "bracket" | "pools" | "teams";

function TournamentPage() {
  const loaderTournament = Route.useLoaderData();
  const { tournaments } = useTournamentStore();
  const t = tournaments.find((x) => x.slug === loaderTournament.slug) ?? loaderTournament;
  const [activeId, setActiveId] = useState(() => t.categories?.[0]?.id ?? "");
  const { matches } = useMatchStore();

  const category = t.categories?.find((c) => c.id === activeId) ?? t.categories?.[0];

  // Check how many confirmed/dispatched matches exist across the tournament
  const confirmedMatches = useMemo(() => matches.filter((m) => isConfirmedDispatchedMatch(m)), [matches]);
  const liveMatches = useMemo(() => confirmedMatches.filter((m) => m.status === "live"), [confirmedMatches]);
  const finalMatches = useMemo(() => confirmedMatches.filter((m) => m.status === "final"), [confirmedMatches]);
  const scheduledMatches = useMemo(() => confirmedMatches.filter((m) => m.status === "scheduled"), [confirmedMatches]);

  // Default to live tab if there are active live matches, otherwise bracket
  const [tab, setTab] = useState<TabKey>("bracket");
  const [drawRevision, setDrawRevision] = useState(0);

  useEffect(() => {
    const handleDrawChange = () => {
      setDrawRevision((v) => v + 1);
    };

    window.addEventListener("dv_drawn_groups_updated", handleDrawChange);
    window.addEventListener("dv_main_draw_updated", handleDrawChange);
    window.addEventListener("dv_live_matches_updated", handleDrawChange);
    window.addEventListener("storage", handleDrawChange);

    return () => {
      window.removeEventListener("dv_drawn_groups_updated", handleDrawChange);
      window.removeEventListener("dv_main_draw_updated", handleDrawChange);
      window.removeEventListener("dv_live_matches_updated", handleDrawChange);
      window.removeEventListener("storage", handleDrawChange);
    };
  }, []);

  // Check if drawn brackets exist from Bracket Draw (MAIN)
  const drawnGroups = useMemo(() => {
    if (!category) return null;
    return getDrawnGroups(t.slug, category.id);
  }, [t.slug, category, drawRevision]);

  // Check if Point Differential seeded Main Draw exists from DrawsManager
  const mainDrawMatches = useMemo(() => {
    if (!category) return [];
    return getMainDrawMatches(t.slug, category.id);
  }, [t.slug, category, drawRevision]);

  if (!category) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center">
        <Link to="/" className="text-xs uppercase tracking-[0.28em] text-pickle font-bold hover:underline">
          &larr; All tournaments
        </Link>
        <h1 className="mt-4 text-4xl font-display text-foreground">{t.name}</h1>
        <p className="mt-2 text-muted-foreground">{t.tagline}</p>
        <div className="surface-card mt-8 p-10 text-center border border-border">
          <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">
            Registration & Divisions
          </span>
          <h2 className="font-display text-2xl text-foreground mt-2">No Divisions Configured Yet</h2>
          <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
            Tournament categories, player rosters, and schedules are currently being set up by the organizers.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* ── Hero / Header ── */}
      <section className="court-lines">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-5 sm:py-14">
          <Link to="/" className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">
            &larr; All tournaments
          </Link>
          <h1 className="mt-4 font-display text-4xl leading-tight text-sand sm:text-5xl md:text-7xl">
            {t.name}
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-sand/75 sm:text-base">{t.tagline}</p>

          {/* Info grid — 2 cols on mobile, 4 on large */}
          <dl className="mt-6 grid grid-cols-2 gap-3 sm:mt-8 sm:gap-4 lg:grid-cols-4">
            {[
              ["Dates", t.date],
              ["Venue", `${t.venue}, ${t.city}`],
              ["Divisions", `${t.categories?.length || 0} Categories`],
              ["Format", t.format],
            ].map(([label, value]) => (
              <div key={label} className="border-l-2 border-pickle pl-3">
                <dt className="text-[0.6rem] uppercase tracking-[0.2em] text-sand/60 sm:text-[0.65rem] sm:tracking-[0.22em]">
                  {label}
                </dt>
                <dd className="text-sm text-sand sm:text-base font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── Live Court Action Broadcast Ticker ── */}
      <LiveActionTicker
        liveMatches={liveMatches}
        finalMatchesCount={finalMatches.length}
        scheduledMatchesCount={scheduledMatches.length}
        onViewLiveCourts={() => setTab("live")}
      />

      {/* ── Category picker + tabs ── */}
      <section className="mx-auto max-w-6xl px-4 py-8 sm:px-5 sm:py-10">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <span className="text-[0.65rem] uppercase tracking-[0.24em] font-bold text-pickle block">
              Division &amp; Category
            </span>
            <h2 className="text-2xl sm:text-3xl font-display mt-0.5">Select Category</h2>
          </div>

          {/* Real-time sync heartbeat pill */}
          <div className="inline-flex items-center gap-2 self-start sm:self-auto px-3 py-1.5 bg-charcoal border border-border text-[0.65rem] font-mono uppercase tracking-widest text-sand">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-pickle"></span>
            </span>
            <span>Live Sync Active (2s)</span>
          </div>
        </div>

        {/* Category pills — horizontal scroll on mobile */}
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
          {t.categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={`flex-shrink-0 border px-3 py-1.5 text-xs font-semibold transition-colors sm:px-4 sm:py-2 sm:text-sm ${
                c.id === category.id
                  ? "border-primary bg-primary text-primary-foreground font-bold shadow-sm"
                  : "border-border bg-card text-foreground hover:border-primary"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* View tabs — horizontal scroll on mobile */}
        <div className="mt-8 flex gap-0 overflow-x-auto border-b-2 border-charcoal">
          {(
            [
              { key: "live", label: "Live Courts", badge: liveMatches.length },
              { key: "bracket", label: "Playoff Bracket" },
              { key: "pools", label: drawnGroups ? "Drawn Brackets & Pools" : "Pool Play" },
              { key: "teams", label: "Teams" },
            ] as const
          ).map((item) => {
            const isActive = tab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={`flex-shrink-0 px-3 py-2 font-display text-sm uppercase tracking-wide sm:px-5 sm:text-lg transition-colors flex items-center gap-2 ${
                  isActive ? "bg-charcoal text-sand" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>{item.label}</span>
                {item.key === "live" && item.badge > 0 && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[0.6rem] font-bold bg-pickle text-sand rounded">
                    <span className="h-1.5 w-1.5 rounded-full bg-sand animate-pulse" />
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab Contents */}
        <div className="mt-6 sm:mt-8">
          {tab === "live" && (
            <LiveCourtsTab
              matches={matches}
              category={category}
            />
          )}
          {tab === "bracket" && (
            <Bracket
              category={category}
              matches={matches}
              mainDrawMatches={mainDrawMatches}
            />
          )}
          {tab === "pools" && (
            <Pools
              category={category}
              matches={matches}
              drawnGroups={drawnGroups}
            />
          )}
          {tab === "teams" && <Teams category={category} />}
        </div>
      </section>

      {/* ── Schedule & Rules ── */}
      <section className="mx-auto grid max-w-6xl gap-6 px-4 pb-10 sm:px-5 sm:pb-8 md:grid-cols-2 md:gap-8">
        <div className="surface-card p-5 sm:p-6">
          <h2 className="text-2xl sm:text-3xl font-display">Event Day Schedule</h2>
          <ul className="mt-4 space-y-4">
            {t.schedule.map((s) => (
              <li key={s.time} className="flex gap-3 sm:gap-4">
                <span className="w-16 shrink-0 font-display text-lg text-primary sm:w-20 sm:text-xl">
                  {s.time}
                </span>
                <span>
                  <span className="block font-semibold text-sm sm:text-base">{s.title}</span>
                  <span className="text-xs text-muted-foreground sm:text-sm">{s.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="surface-card p-5 sm:p-6">
          <h2 className="text-2xl sm:text-3xl font-display">Rules &amp; Regulations</h2>
          <ul className="mt-4 space-y-3 text-sm">
            {t.rules.map((r) => (
              <li key={r} className="flex gap-3">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-accent" />
                {r}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   LIVE ACTION BROADCAST TICKER
═══════════════════════════════════════════════ */

function LiveActionTicker({
  liveMatches,
  finalMatchesCount,
  scheduledMatchesCount,
  onViewLiveCourts,
}: {
  liveMatches: LiveMatch[];
  finalMatchesCount: number;
  scheduledMatchesCount: number;
  onViewLiveCourts: () => void;
}) {
  if (liveMatches.length === 0) {
    return (
      <section className="border-b border-border bg-charcoal/90 py-3 text-sand">
        <div className="mx-auto max-w-6xl px-4 sm:px-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-sand/40" />
            <span className="uppercase tracking-widest font-mono text-[0.7rem] text-sand/70">
              Live Scoring Broadcast:
            </span>
            <span className="font-semibold text-sand">No matches currently in play</span>
          </div>
          <div className="flex items-center gap-3 text-[0.65rem] uppercase tracking-wider text-sand/60">
            <span>{scheduledMatchesCount} Scheduled</span>
            <span>&middot;</span>
            <span>{finalMatchesCount} Completed</span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="border-b-2 border-pickle bg-charcoal text-sand py-4 shadow-md">
      <div className="mx-auto max-w-6xl px-4 sm:px-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-pickle"></span>
            </span>
            <span className="font-display text-base sm:text-lg uppercase tracking-wider text-sand">
              Live Court Action
            </span>
            <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest bg-pickle/30 text-pickle border border-pickle/50 rounded">
              {liveMatches.length} In Progress
            </span>
          </div>
          <button
            onClick={onViewLiveCourts}
            className="text-[0.65rem] uppercase tracking-[0.2em] font-bold text-pickle hover:text-sand transition-colors cursor-pointer self-start sm:self-auto"
          >
            Open Live Courts Board &rarr;
          </button>
        </div>

        {/* Horizontal scrollable live cards */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {liveMatches.map((m) => {
            const s = m.score;
            const serverScore = s.servingTeam === "A" ? s.teamAScore : s.teamBScore;
            const receiverScore = s.servingTeam === "A" ? s.teamBScore : s.teamAScore;
            return (
              <div
                key={m.id}
                onClick={onViewLiveCourts}
                className="bg-card/90 border border-pickle/50 p-3 hover:border-pickle transition-colors cursor-pointer text-foreground rounded-sm flex flex-col justify-between"
              >
                <div className="flex items-center justify-between text-[0.65rem] uppercase tracking-widest border-b border-border/50 pb-1.5 mb-2">
                  <span className="font-bold text-pickle font-mono">{m.court}</span>
                  <span className="font-mono text-muted-foreground">
                    Call: {serverScore}-{receiverScore}-{s.serverNumber}
                  </span>
                </div>

                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 truncate">
                      {s.servingTeam === "A" && (
                        <span className="h-2 w-2 rounded-full bg-pickle shrink-0" />
                      )}
                      <span className={`truncate ${s.servingTeam === "A" ? "font-bold text-foreground" : "text-muted-foreground"}`}>
                        {m.teamAName}
                      </span>
                    </div>
                    <span className="font-display text-xl shrink-0 pl-2">{s.teamAScore}</span>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 truncate">
                      {s.servingTeam === "B" && (
                        <span className="h-2 w-2 rounded-full bg-pickle shrink-0" />
                      )}
                      <span className={`truncate ${s.servingTeam === "B" ? "font-bold text-foreground" : "text-muted-foreground"}`}>
                        {m.teamBName}
                      </span>
                    </div>
                    <span className="font-display text-xl shrink-0 pl-2">{s.teamBScore}</span>
                  </div>
                </div>

                {m.officiatedBy && (
                  <div className="mt-2 pt-1.5 border-t border-border/40 text-[0.6rem] text-muted-foreground uppercase tracking-widest">
                    Official: <span className="text-foreground font-medium">{m.officiatedBy}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════
   TAB 1: LIVE COURTS TAB (REAL-TIME ACTION BOARD)
═══════════════════════════════════════════════ */

function LiveCourtsTab({
  matches,
  category,
}: {
  matches: LiveMatch[];
  category: Category;
}) {
  const [filter, setFilter] = useState<"all" | "live" | "final" | "scheduled">("all");

  const stations = useMemo(() => getCourtStations(), [matches]);
  const queue = useMemo(() => getDispatchQueue(), [matches]);
  const queuedUpcoming = useMemo(() => queue.filter((q) => q.status === "queued" || q.status === "on_deck"), [queue]);

  const confirmedMatches = useMemo(() => {
    return matches.filter((m) => isConfirmedDispatchedMatch(m, stations));
  }, [matches, stations]);

  const liveMatches = confirmedMatches.filter((m) => m.status === "live");
  const finalMatches = confirmedMatches.filter((m) => m.status === "final");
  const scheduledMatches = confirmedMatches.filter((m) => m.status === "scheduled");

  const filteredMatches = useMemo(() => {
    if (filter === "live") return liveMatches;
    if (filter === "final") return finalMatches;
    if (filter === "scheduled") return scheduledMatches;
    return confirmedMatches;
  }, [filter, confirmedMatches, liveMatches, finalMatches, scheduledMatches]);

  const [scheduledMinimized, setScheduledMinimized] = useState(false);
  const queueScheduledMatches = useMemo(() => {
    return scheduledMatches.filter(
      (m) => m.court === "Queue" || !FACILITY_COURTS.includes(m.court as FacilityCourt),
    );
  }, [scheduledMatches]);

  return (
    <div className="space-y-8">
      {/* Overview & Filter Bar */}
      <div className="surface-card p-4 sm:p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4 border border-border">
        <div>
          <span className="text-xs font-bold uppercase tracking-[0.24em] text-pickle">
            Real-Time Scoreboard
          </span>
          <h3 className="font-display text-2xl sm:text-3xl text-foreground mt-0.5">
            Court Action &amp; Live Scoring
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Official scores streamed directly from umpire terminals across facility Courts 1–4.
          </p>
        </div>

        {/* Filter pills */}
        <div className="flex flex-wrap gap-2">
          {[
            { key: "all", label: "All Courts", count: confirmedMatches.length },
            { key: "live", label: "Live Now", count: liveMatches.length, isLive: true },
            { key: "final", label: "Final Results", count: finalMatches.length },
            { key: "scheduled", label: "Upcoming", count: scheduledMatches.length },
          ].map((btn) => (
            <button
              key={btn.key}
              onClick={() => setFilter(btn.key as typeof filter)}
              className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider border transition-colors flex items-center gap-1.5 ${
                filter === btn.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-foreground hover:border-primary"
              }`}
            >
              {btn.isLive && btn.count > 0 && (
                <span className="h-2 w-2 rounded-full bg-pickle animate-pulse" />
              )}
              <span>{btn.label}</span>
              <span className="font-mono text-[0.65rem] opacity-75">({btn.count})</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── 4 Dedicated Facility Courts Live Board ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-pickle" />
            <h4 className="font-display text-xl uppercase tracking-wide text-foreground">
              Facility Courts Board (Courts 1–4)
            </h4>
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            4 Courts Active
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FACILITY_COURTS.map((courtName) => {
            const station = stations[courtName];
            const liveMatch = matches.find((m) => m.court === courtName && m.status === "live");
            const scheduledMatch = matches.find((m) => m.court === courtName && m.status === "scheduled");
            const activeMatch = liveMatch ?? scheduledMatch;
            const onDeck = station?.onDeckMatchId ? matches.find((m) => m.id === station.onDeckMatchId) : null;

            return (
              <div
                key={courtName}
                className={`p-3.5 border rounded flex flex-col justify-between transition-all ${
                  liveMatch
                    ? "bg-card border-pickle/70 shadow-sm"
                    : station?.status === "warmup"
                    ? "bg-card border-amber-500/70"
                    : station?.status === "maintenance"
                    ? "bg-card border-brick/60"
                    : "bg-card/70 border-border"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between border-b border-border/50 pb-2 mb-2.5">
                    <span className="font-display text-lg text-foreground">{courtName}</span>
                    {liveMatch ? (
                      <span className="px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40 flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-ping" />
                        Live
                      </span>
                    ) : station?.status === "warmup" ? (
                      <span className="px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40">
                        Warm-up
                      </span>
                    ) : station?.status === "maintenance" ? (
                      <span className="px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-brick/20 text-brick border border-brick/40">
                        Hold
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                        Open
                      </span>
                    )}
                  </div>

                  {activeMatch ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className={`truncate font-semibold ${activeMatch.score.servingTeam === "A" && liveMatch ? "text-pickle" : "text-foreground"}`}>
                          {activeMatch.teamAName}
                        </span>
                        <span className="font-display text-base font-bold ml-2">
                          {activeMatch.score.teamAScore}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className={`truncate font-semibold ${activeMatch.score.servingTeam === "B" && liveMatch ? "text-pickle" : "text-foreground"}`}>
                          {activeMatch.teamBName}
                        </span>
                        <span className="font-display text-base font-bold ml-2">
                          {activeMatch.score.teamBScore}
                        </span>
                      </div>

                      {liveMatch && (
                        <div className="text-[0.65rem] font-mono text-pickle pt-1">
                          Call: {activeMatch.score.servingTeam === "A" ? activeMatch.score.teamAScore : activeMatch.score.teamBScore}-
                          {activeMatch.score.servingTeam === "A" ? activeMatch.score.teamBScore : activeMatch.score.teamAScore}-
                          {activeMatch.score.serverNumber}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="py-3 text-center text-xs text-muted-foreground">
                      Court Available
                    </div>
                  )}
                </div>

                {onDeck && (
                  <div className="mt-2.5 pt-2 border-t border-border/40 text-[0.65rem] text-muted-foreground truncate">
                    <span className="font-semibold text-foreground">On Deck: </span>
                    {onDeck.teamAName} vs {onDeck.teamBName}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Up Next in Queue (Spectator Queue Board) ── */}
      {queuedUpcoming.length > 0 && (
        <div className="surface-card p-4 sm:p-5 border border-border space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-display text-lg uppercase tracking-wide text-foreground">
              Up Next in Queue ({queuedUpcoming.length} Matches)
            </h4>
            <span className="text-xs text-muted-foreground">
              Order of play for facility courts
            </span>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {queuedUpcoming.slice(0, 6).map((q, idx) => (
              <div
                key={q.id}
                className="p-2.5 bg-card border border-border rounded flex items-center justify-between gap-2"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="h-6 w-6 rounded bg-charcoal text-sand flex items-center justify-center font-display text-xs shrink-0 border border-border">
                    #{idx + 1}
                  </div>
                  <div className="min-w-0">
                    <span className="text-[0.65rem] text-pickle font-bold block truncate">
                      {q.stage}
                    </span>
                    <span className="text-xs font-semibold text-foreground block truncate">
                      {q.teamAName} vs {q.teamBName}
                    </span>
                  </div>
                </div>

                {q.assignedCourt && (
                  <span className="px-1.5 py-0.5 text-[0.6rem] uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40 shrink-0 font-bold">
                    {q.assignedCourt}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live matches section */}
      {(filter === "all" || filter === "live") && liveMatches.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-pickle"></span>
            </span>
            <h4 className="font-display text-xl uppercase tracking-wide text-foreground">
              Live In Progress
            </h4>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {liveMatches.map((m) => (
              <LiveCourtCard key={m.id} match={m} />
            ))}
          </div>
        </div>
      )}

      {/* Completed matches section */}
      {(filter === "all" || filter === "final") && finalMatches.length > 0 && (
        <div className="space-y-4">
          <h4 className="font-display text-xl uppercase tracking-wide text-brick">
            Final Match Results
          </h4>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {finalMatches.map((m) => (
              <LiveCourtCard key={m.id} match={m} />
            ))}
          </div>
        </div>
      )}

      {/* ── Minimized Per-Court Scheduled Matches ── */}
      {(filter === "all" || filter === "scheduled") && scheduledMatches.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border pb-3">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-pickle" />
              <h4 className="font-display text-xl uppercase tracking-wide text-foreground">
                Scheduled Matches (By Court)
              </h4>
              <span className="text-xs font-mono text-muted-foreground ml-1">
                ({scheduledMatches.length} total upcoming)
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground font-mono">
                Facility Courts 1–4
              </span>
              <button
                onClick={() => setScheduledMinimized((prev) => !prev)}
                className="px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-widest border border-border bg-card text-foreground hover:border-pickle transition-colors cursor-pointer"
              >
                {scheduledMinimized ? "Expand Schedule" : "Minimize"}
              </button>
            </div>
          </div>

          {!scheduledMinimized && (
            <div className="space-y-3">
              {/* 4 Dedicated Facility Courts Columns */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {FACILITY_COURTS.map((courtName) => {
                  const courtMatches = scheduledMatches.filter((m) => m.court === courtName);
                  const hasMatch = courtMatches.length > 0;
                  const station = stations[courtName];

                  return (
                    <div
                      key={courtName}
                      className="surface-card border border-border p-3.5 flex flex-col justify-between"
                    >
                      <div>
                        {/* Court Header */}
                        <div className="flex items-center justify-between border-b border-border/50 pb-2 mb-2.5">
                          <span className="font-display text-base text-foreground">{courtName}</span>
                          <span
                            className={`px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider rounded ${
                              hasMatch
                                ? "bg-pickle/15 text-pickle border border-pickle/40"
                                : station?.status === "maintenance"
                                  ? "bg-brick/20 text-brick border border-brick/40"
                                  : "bg-muted text-muted-foreground border border-border"
                            }`}
                          >
                            {hasMatch
                              ? `${courtMatches.length} Scheduled`
                              : station?.status === "maintenance"
                                ? "Maintenance"
                                : "Court Open"}
                          </span>
                        </div>

                        {/* Match content */}
                        {hasMatch ? (
                          <div className="space-y-2">
                            {courtMatches.map((m, idx) => (
                              <div
                                key={m.id}
                                className="p-2.5 bg-background border border-border/70 rounded space-y-1"
                              >
                                <div className="flex items-center justify-between text-[0.6rem] uppercase tracking-widest text-muted-foreground">
                                  <span className="font-mono text-pickle font-bold">
                                    {idx === 0 ? "Next On Court" : `Match #${idx + 1}`}
                                  </span>
                                  <span>Scheduled</span>
                                </div>
                                <div className="text-xs font-semibold text-foreground truncate">
                                  {m.teamAName}
                                </div>
                                <div className="text-[0.65rem] text-muted-foreground font-medium uppercase tracking-wider">
                                  vs
                                </div>
                                <div className="text-xs font-semibold text-foreground truncate">
                                  {m.teamBName}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="py-6 text-center text-xs text-muted-foreground italic">
                            No match scheduled yet
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Facility Queue / On-Deck Waiting List */}
              {queueScheduledMatches.length > 0 && (
                <div className="surface-card border border-border p-3.5 sm:p-4 mt-3">
                  <div className="flex items-center justify-between border-b border-border/50 pb-2 mb-3">
                    <div className="flex items-center gap-2">
                      <span className="font-display text-sm sm:text-base text-foreground">
                        Waiting Queue &middot; Facility Order of Play
                      </span>
                      <span className="text-[0.7rem] font-mono text-muted-foreground">
                        ({queueScheduledMatches.length} queued for next court)
                      </span>
                    </div>
                    <span className="text-[0.6rem] uppercase tracking-widest font-mono text-pickle font-bold">
                      Next in Line
                    </span>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {queueScheduledMatches.map((m, idx) => (
                      <div
                        key={m.id}
                        className="p-2 bg-background border border-border/60 rounded flex items-center justify-between gap-2.5 text-xs"
                      >
                        <div className="flex items-center gap-2 truncate min-w-0">
                          <span className="h-5 w-5 rounded bg-charcoal text-sand flex items-center justify-center font-display text-[0.65rem] shrink-0 border border-border">
                            #{idx + 1}
                          </span>
                          <div className="truncate">
                            <span className="font-semibold text-foreground truncate block">
                              {m.teamAName} vs {m.teamBName}
                            </span>
                          </div>
                        </div>
                        <span className="px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-widest bg-charcoal text-sand/80 border border-border shrink-0">
                          Queued
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {filteredMatches.length === 0 && (
        <div className="surface-card p-12 text-center border border-border">
          <h4 className="font-display text-2xl text-foreground">No Matches Found</h4>
          <p className="text-sm text-muted-foreground mt-2">
            There are currently no matches matching the selected filter.
          </p>
        </div>
      )}
    </div>
  );
}

function LiveCourtCard({ match }: { match: LiveMatch }) {
  const s = match.score;
  const isLive = match.status === "live";
  const isFinal = match.status === "final";

  const serverScore = s.servingTeam === "A" ? s.teamAScore : s.teamBScore;
  const receiverScore = s.servingTeam === "A" ? s.teamBScore : s.teamAScore;

  const lastRally = s.rallies && s.rallies.length > 0 ? s.rallies[s.rallies.length - 1] : null;

  return (
    <div
      className={`surface-card p-0 overflow-hidden border transition-all ${
        isLive
          ? "border-pickle/60 shadow-lg shadow-pickle/10"
          : isFinal
            ? "border-brick/40"
            : "border-border"
      }`}
    >
      {/* Card Header */}
      <div
        className={`px-4 py-2.5 flex items-center justify-between ${
          isLive ? "bg-pickle/15 text-foreground" : "bg-charcoal text-sand"
        }`}
      >
        <span className="text-xs font-bold uppercase tracking-widest font-mono">
          {match.court === "Queue" ? "Queue (Courts 1–4)" : match.court}
        </span>
        <span
          className={`px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-widest rounded ${
            isLive
              ? "bg-pickle text-sand animate-pulse"
              : isFinal
                ? "bg-brick text-sand"
                : "bg-muted text-muted-foreground"
          }`}
        >
          {isLive ? "Live Now" : isFinal ? "Final" : "Scheduled"}
        </span>
      </div>

      {/* Main Scoreboard Body */}
      <div className="p-4 sm:p-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          {/* Team A */}
          <div className="text-center">
            <span
              className={`block font-display text-4xl sm:text-5xl ${
                match.winnerTeam === match.teamAName
                  ? "text-pickle font-bold"
                  : "text-foreground"
              }`}
            >
              {s.teamAScore}
            </span>
            <span className="block text-xs font-semibold text-foreground mt-1 truncate">
              {match.teamAName}
            </span>
            <span className="block text-[0.65rem] text-muted-foreground truncate">
              {match.teamAPlayers.join(" / ")}
            </span>
            {isLive && s.servingTeam === "A" && (
              <span className="inline-block mt-2 text-[0.55rem] uppercase tracking-widest bg-pickle text-sand px-2 py-0.5 font-bold rounded">
                Serving #{s.serverNumber}
              </span>
            )}
          </div>

          {/* VS Divider */}
          <div className="flex flex-col items-center">
            <span className="font-display text-sm uppercase tracking-widest text-brick font-bold">
              VS
            </span>
          </div>

          {/* Team B */}
          <div className="text-center">
            <span
              className={`block font-display text-4xl sm:text-5xl ${
                match.winnerTeam === match.teamBName
                  ? "text-pickle font-bold"
                  : "text-foreground"
              }`}
            >
              {s.teamBScore}
            </span>
            <span className="block text-xs font-semibold text-foreground mt-1 truncate">
              {match.teamBName}
            </span>
            <span className="block text-[0.65rem] text-muted-foreground truncate">
              {match.teamBPlayers.join(" / ")}
            </span>
            {isLive && s.servingTeam === "B" && (
              <span className="inline-block mt-2 text-[0.55rem] uppercase tracking-widest bg-pickle text-sand px-2 py-0.5 font-bold rounded">
                Serving #{s.serverNumber}
              </span>
            )}
          </div>
        </div>

        {/* 3-Number Pickleball Call */}
        {isLive && (
          <div className="mt-4 pt-3 border-t border-border/60 text-center bg-muted/20 p-2 rounded">
            <span className="font-mono text-lg text-pickle font-bold tracking-wider">
              {serverScore} - {receiverScore} - {s.serverNumber}
            </span>
            <span className="block text-[0.55rem] uppercase tracking-[0.2em] text-muted-foreground font-bold mt-0.5">
              Current Pickleball Call (Server - Receiver - Server #)
            </span>
          </div>
        )}

        {/* Final Winner Banner */}
        {isFinal && match.winnerTeam && (
          <div className="mt-4 pt-3 border-t border-border/60 text-center bg-pickle/10 p-2 rounded">
            <span className="text-xs uppercase tracking-widest font-bold text-pickle">
              Winner: {match.winnerTeam}
            </span>
          </div>
        )}

        {/* Recent Rally Feed */}
        {isLive && lastRally && (
          <div className="mt-3 pt-2 text-[0.65rem] text-muted-foreground font-mono flex items-center justify-between">
            <span className="uppercase tracking-wider">Latest Rally:</span>
            <span className="text-foreground truncate pl-2 font-medium">{lastRally.description}</span>
          </div>
        )}

        {/* Umpire Assignment */}
        <div className="mt-3 pt-2.5 border-t border-border/50 flex items-center justify-between text-[0.65rem] uppercase tracking-widest">
          <span className="text-muted-foreground font-semibold">Live Official</span>
          <span className={`font-mono ${match.officiatedBy ? "text-pickle font-bold" : "text-muted-foreground"}`}>
            {match.officiatedBy ?? "Official Desk"}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   TAB 2: PLAYOFF BRACKET (WITH LIVE SYNC)
═══════════════════════════════════════════════ */

function MatchCard({
  category,
  a,
  b,
  scoreA,
  scoreB,
  label,
  matches,
}: {
  category: Category;
  a?: string | undefined;
  b?: string | undefined;
  scoreA?: number | undefined;
  scoreB?: number | undefined;
  label: string;
  matches: LiveMatch[];
}) {
  const nameA = teamName(category, a);
  const nameB = teamName(category, b);

  // Check if there is an active or final match in the live store
  const liveMatch = useMemo(() => {
    return findLiveMatchForTeams(matches, nameA, nameB);
  }, [matches, nameA, nameB]);

  const isLive = liveMatch?.status === "live";
  const isFinal = liveMatch?.status === "final";

  // Use live scores if available
  const displayScoreA = liveMatch
    ? (liveMatch.teamAName === nameA ? liveMatch.score.teamAScore : liveMatch.score.teamBScore)
    : scoreA;
  const displayScoreB = liveMatch
    ? (liveMatch.teamAName === nameA ? liveMatch.score.teamBScore : liveMatch.score.teamAScore)
    : scoreB;

  const wonA = displayScoreA !== undefined && displayScoreB !== undefined && displayScoreA > displayScoreB;
  const wonB = displayScoreA !== undefined && displayScoreB !== undefined && displayScoreB > displayScoreA;

  const row = (id?: string, name?: string, score?: number, won?: boolean, isServing?: boolean) => (
    <div
      className={`flex items-center justify-between px-3 py-2 text-sm transition-colors ${
        won ? "bg-accent/10 font-bold" : ""
      }`}
    >
      <div className="flex items-center gap-2 min-w-0 pr-2">
        {isServing && <span className="h-2 w-2 rounded-full bg-pickle shrink-0 animate-pulse" />}
        <span className="truncate">{name ?? "TBD"}</span>
      </div>
      <span className="flex-shrink-0 font-display text-lg">{score ?? "-"}</span>
    </div>
  );

  const isAServing = isLive && liveMatch && ((liveMatch.teamAName === nameA && liveMatch.score.servingTeam === "A") || (liveMatch.teamBName === nameA && liveMatch.score.servingTeam === "B"));
  const isBServing = isLive && liveMatch && ((liveMatch.teamAName === nameB && liveMatch.score.servingTeam === "A") || (liveMatch.teamBName === nameB && liveMatch.score.servingTeam === "B"));

  return (
    <div
      className={`surface-card overflow-hidden border transition-all ${
        isLive
          ? "border-pickle/60 shadow-md shadow-pickle/10"
          : isFinal
            ? "border-brick/40"
            : "border-border"
      }`}
    >
      {/* Header */}
      <div className="bg-charcoal px-3 py-1.5 text-[0.6rem] uppercase tracking-[0.22em] text-sand flex items-center justify-between">
        <span>{label}</span>
        {isLive && (
          <span className="inline-flex items-center gap-1 font-bold text-pickle">
            <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-ping" />
            Live
          </span>
        )}
        {isFinal && <span className="font-bold text-brick">Final</span>}
      </div>

      {row(a, nameA, displayScoreA, wonA, isAServing)}
      <div className="border-t border-border" />
      {row(b, nameB, displayScoreB, wonB, isBServing)}
    </div>
  );
}

function MainDrawKnockoutMatchCard({
  match,
  matches,
  isFinal = false,
}: {
  match: KnockoutMatch;
  matches: LiveMatch[];
  isFinal?: boolean;
}) {
  const nameA = match.teamA?.name;
  const nameB = match.teamB?.name;

  const liveMatch = useMemo(() => {
    return findLiveMatchForTeams(matches, nameA, nameB);
  }, [matches, nameA, nameB]);

  const isLive = liveMatch?.status === "live";
  const isCompleted = match.winner !== undefined || liveMatch?.status === "final";

  const scoreA = liveMatch
    ? (liveMatch.teamAName === nameA ? liveMatch.score.teamAScore : liveMatch.score.teamBScore)
    : match.scoreA;
  const scoreB = liveMatch
    ? (liveMatch.teamAName === nameA ? liveMatch.score.teamBScore : liveMatch.score.teamAScore)
    : match.scoreB;

  const wonA = isCompleted && scoreA !== undefined && scoreB !== undefined && scoreA > scoreB;
  const wonB = isCompleted && scoreA !== undefined && scoreB !== undefined && scoreB > scoreA;

  const isAServing = isLive && liveMatch && ((liveMatch.teamAName === nameA && liveMatch.score.servingTeam === "A") || (liveMatch.teamBName === nameA && liveMatch.score.servingTeam === "B"));
  const isBServing = isLive && liveMatch && ((liveMatch.teamAName === nameB && liveMatch.score.servingTeam === "A") || (liveMatch.teamBName === nameB && liveMatch.score.servingTeam === "B"));

  return (
    <div
      className={`surface-card overflow-hidden border transition-all ${
        isLive
          ? "border-pickle/60 shadow-md shadow-pickle/10"
          : isFinal
            ? "border-brick/50 shadow-sm"
            : "border-border"
      }`}
    >
      <div className="bg-charcoal px-3 py-1.5 text-[0.6rem] uppercase tracking-[0.22em] text-sand flex items-center justify-between">
        <span className="font-bold">{match.label}</span>
        <div className="flex items-center gap-1.5 font-mono">
          <span className="text-pickle">{liveMatch?.court ?? match.court}</span>
          {isLive && (
            <span className="inline-flex items-center gap-1 text-pickle font-bold">
              <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-ping" />
              Live
            </span>
          )}
          {isCompleted && <span className="text-brick font-bold">Final</span>}
        </div>
      </div>

      {/* Team A */}
      <div className={`flex items-center justify-between px-3 py-2 text-sm transition-colors ${wonA ? "bg-accent/10 font-bold" : ""}`}>
        <div className="flex items-center gap-2 min-w-0 pr-2">
          {isAServing && <span className="h-2 w-2 rounded-full bg-pickle shrink-0 animate-pulse" />}
          {match.seedA && (
            <span className="text-[0.6rem] font-bold font-mono px-1.5 py-0.5 bg-muted text-foreground rounded shrink-0">
              {match.seedA}
            </span>
          )}
          <span className={`truncate ${wonA ? "text-pickle" : ""}`}>{nameA ?? "TBD (Qualifier)"}</span>
        </div>
        <span className="flex-shrink-0 font-display text-lg">{scoreA ?? "-"}</span>
      </div>

      <div className="border-t border-border" />

      {/* Team B */}
      <div className={`flex items-center justify-between px-3 py-2 text-sm transition-colors ${wonB ? "bg-accent/10 font-bold" : ""}`}>
        <div className="flex items-center gap-2 min-w-0 pr-2">
          {isBServing && <span className="h-2 w-2 rounded-full bg-pickle shrink-0 animate-pulse" />}
          {match.seedB && (
            <span className="text-[0.6rem] font-bold font-mono px-1.5 py-0.5 bg-muted text-foreground rounded shrink-0">
              {match.seedB}
            </span>
          )}
          <span className={`truncate ${wonB ? "text-pickle" : ""}`}>{nameB ?? "TBD (Qualifier)"}</span>
        </div>
        <span className="flex-shrink-0 font-display text-lg">{scoreB ?? "-"}</span>
      </div>
    </div>
  );
}

function Bracket({
  category,
  matches,
  mainDrawMatches,
}: {
  category: Category;
  matches: LiveMatch[];
  mainDrawMatches: KnockoutMatch[] | null;
}) {
  // If official point differential seeded Main Draw has been generated in admin
  if (mainDrawMatches && mainDrawMatches.length > 0) {
    const r16Matches = mainDrawMatches.filter((m) => m.round === "Round of 16");
    const qfMatches = mainDrawMatches.filter((m) => m.round === "Quarterfinal");
    const sfMatches = mainDrawMatches.filter((m) => m.round === "Semifinal");
    const finalMatch = mainDrawMatches.find((m) => m.round === "Final");
    const bronzeMatch = mainDrawMatches.find((m) => m.round === "Bronze");

    return (
      <div className="space-y-6">
        <div className="border-b border-border pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-pickle" />
              <span className="text-xs font-bold uppercase tracking-[0.24em] text-pickle">
                Seeded by Point Differential
              </span>
            </div>
            <h3 className="text-2xl font-display mt-0.5">Championship Playoff Tree</h3>
            <p className="text-xs text-muted-foreground">
              Official single-elimination bracket seeded from round robin point differential (+/-) tie-breakers.
            </p>
          </div>
        </div>

        {/* Responsive bracket columns */}
        <div className={`grid gap-6 ${
          r16Matches.length > 0
            ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-4"
            : qfMatches.length > 0
              ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
              : "grid-cols-1 md:grid-cols-2"
        }`}>
          {/* Round of 16 */}
          {r16Matches.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-border pb-2">
                <span className="h-2 w-2 rounded-full bg-pickle" />
                <h4 className="font-display text-lg text-foreground uppercase tracking-wider">Round of 16</h4>
              </div>
              <div className="space-y-3">
                {r16Matches.map((m) => (
                  <MainDrawKnockoutMatchCard key={m.id} match={m} matches={matches} />
                ))}
              </div>
            </div>
          )}

          {/* Quarterfinals */}
          {qfMatches.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-border pb-2">
                <span className="h-2 w-2 rounded-full bg-pickle" />
                <h4 className="font-display text-lg text-foreground uppercase tracking-wider">Quarterfinals</h4>
              </div>
              <div className="space-y-3">
                {qfMatches.map((m) => (
                  <MainDrawKnockoutMatchCard key={m.id} match={m} matches={matches} />
                ))}
              </div>
            </div>
          )}

          {/* Semifinals */}
          {sfMatches.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 border-b border-border pb-2">
                <span className="h-2 w-2 rounded-full bg-pickle" />
                <h4 className="font-display text-lg text-foreground uppercase tracking-wider">Semifinals</h4>
              </div>
              <div className="space-y-3">
                {sfMatches.map((m) => (
                  <MainDrawKnockoutMatchCard key={m.id} match={m} matches={matches} />
                ))}
              </div>
            </div>
          )}

          {/* Championship Final & 3rd Place Match */}
          <div className="space-y-6">
            {finalMatch && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 border-b border-border pb-2">
                  <span className="h-2 w-2 rounded-full bg-brick" />
                  <h4 className="font-display text-lg text-brick uppercase tracking-wider">Championship Final</h4>
                </div>
                <MainDrawKnockoutMatchCard match={finalMatch} matches={matches} isFinal />

                {finalMatch.winner && (
                  <div className="surface-card p-5 bg-pickle/20 border-2 border-pickle text-center space-y-1 mt-3">
                    <span className="block text-[0.6rem] uppercase tracking-[0.28em] font-bold text-pickle">
                      Tournament Champion
                    </span>
                    <h5 className="font-display text-2xl text-foreground">
                      {finalMatch.winner.name}
                    </h5>
                    <p className="text-xs text-muted-foreground">
                      {finalMatch.winner.players.join(" & ")}
                    </p>
                  </div>
                )}
              </div>
            )}

            {bronzeMatch && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 border-b border-border pb-2">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground" />
                  <h4 className="font-display text-lg text-muted-foreground uppercase tracking-wider">3rd Place Match</h4>
                </div>
                <MainDrawKnockoutMatchCard match={bronzeMatch} matches={matches} />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Fallback to preview semifinals/finals
  const semis = category.playoffs.filter((m) => m.round === "Semifinal");
  const final = category.playoffs.find((m) => m.round === "Final");

  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <span className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">
            Playoff Preview
          </span>
          <h3 className="text-2xl font-display mt-0.5">Projected Knockout Stage</h3>
          <p className="text-xs text-muted-foreground">
            Official playoff seeds will be automatically finalized from pool play Point Differential standings.
          </p>
        </div>
      </div>

      <div className="space-y-6 md:space-y-0 md:grid md:grid-cols-[1fr_auto_1fr] md:items-center md:gap-6">
        <div className="space-y-4 sm:space-y-6">
          {semis.map((m, i) => (
            <MatchCard
              key={m.id}
              category={category}
              a={m.teamA}
              b={m.teamB}
              scoreA={m.scoreA}
              scoreB={m.scoreB}
              label={`Semifinal ${i + 1}`}
              matches={matches}
            />
          ))}
        </div>
        <div className="hidden h-24 w-10 border-y-2 border-r-2 border-charcoal md:block" />
        <div>
          {final && (
            <MatchCard
              category={category}
              a={final.teamA}
              b={final.teamB}
              scoreA={final.scoreA}
              scoreB={final.scoreB}
              label="Championship Final"
              matches={matches}
            />
          )}
          <p className="mt-3 text-xs uppercase tracking-widest text-muted-foreground">
            Top seeds of pool play advance to knockouts
          </p>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   TAB 3: POOL PLAY & DRAWN BRACKETS (WITH LIVE SYNC)
═══════════════════════════════════════════════ */

function BracketCard({
  grp,
  matches,
  defaultOpen = false,
}: {
  grp: BracketGroup;
  matches: LiveMatch[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const teams = grp.slots.map((s) => s.team).filter((t): t is Team => t !== null);

  // Generate round-robin match pairings
  const groupMatches: { id: string; teamA: Team; teamB: Team }[] = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      groupMatches.push({
        id: `drawn-${grp.letter}-${i}-${j}`,
        teamA: teams[i]!,
        teamB: teams[j]!,
      });
    }
  }

  // Compute live standings for this group from match-store
  const standings = useMemo(() => {
    const map = new Map<string, { name: string; w: number; l: number; pd: number }>();
    teams.forEach((t) => map.set(t.name, { name: t.name, w: 0, l: 0, pd: 0 }));

    groupMatches.forEach((gm) => {
      const live = findLiveMatchForTeams(matches, gm.teamA.name, gm.teamB.name);
      if (!live || live.status !== "final") return;

      const sA = live.teamAName === gm.teamA.name ? live.score.teamAScore : live.score.teamBScore;
      const sB = live.teamAName === gm.teamA.name ? live.score.teamBScore : live.score.teamAScore;

      const entryA = map.get(gm.teamA.name);
      const entryB = map.get(gm.teamB.name);
      if (!entryA || !entryB) return;

      if (sA > sB) {
        entryA.w++;
        entryB.l++;
      } else if (sB > sA) {
        entryB.w++;
        entryA.l++;
      }
      entryA.pd += sA - sB;
      entryB.pd += sB - sA;
    });

    return [...map.values()].sort((a, b) => b.w - a.w || b.pd - a.pd);
  }, [matches, groupMatches, teams]);

  const completedCount = groupMatches.filter((gm) => {
    const live = findLiveMatchForTeams(matches, gm.teamA.name, gm.teamB.name);
    return live?.status === "final";
  }).length;

  const liveCount = groupMatches.filter((gm) => {
    const live = findLiveMatchForTeams(matches, gm.teamA.name, gm.teamB.name);
    return live?.status === "live";
  }).length;

  return (
    <div className="surface-card border border-border overflow-hidden">
      {/* Bracket header — always visible */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-4 sm:px-5 sm:py-5 hover:bg-charcoal/30 transition-colors text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center bg-pickle/10 border border-pickle/30 shrink-0">
            <span className="font-display text-xl text-pickle font-bold">{grp.letter}</span>
          </div>
          <div>
            <div className="font-display text-xl sm:text-2xl text-foreground leading-tight">
              Bracket {grp.letter}
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-[0.6rem] font-mono uppercase tracking-widest text-muted-foreground">
                {teams.length} teams &middot; {groupMatches.length} matches
              </span>
              {liveCount > 0 && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[0.6rem] font-bold bg-pickle/15 border border-pickle/30 text-pickle uppercase tracking-widest">
                  <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-ping" />
                  {liveCount} Live
                </span>
              )}
              {completedCount > 0 && (
                <span className="text-[0.6rem] font-mono text-muted-foreground">
                  {completedCount}/{groupMatches.length} done
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Quick team pills — visible on wider screens when collapsed */}
        <div className="hidden md:flex items-center gap-1.5 flex-1 justify-end mx-4">
          {teams.slice(0, 4).map((t) => (
            <span
              key={t.id}
              className="px-2 py-0.5 text-[0.6rem] font-semibold bg-background border border-border text-muted-foreground truncate max-w-[80px]"
            >
              {t.name}
            </span>
          ))}
          {teams.length > 4 && (
            <span className="text-[0.6rem] text-muted-foreground">+{teams.length - 4}</span>
          )}
        </div>

        <div className={`shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
          <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Expanded body */}
      {open && (
        <div className="border-t border-border px-4 py-5 sm:px-5 space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Seeds list */}
            <div>
              <div className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                Bracket Seeds
              </div>
              <div className="space-y-1.5">
                {teams.map((t, idx) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between px-3 py-2 bg-background border border-border/60 text-xs"
                  >
                    <div className="flex items-center gap-2.5 truncate">
                      <span className="font-mono font-bold text-pickle shrink-0 w-5">{idx + 1}.</span>
                      <span className="font-semibold text-foreground truncate">{t.name}</span>
                    </div>
                    <span className="text-[0.6rem] text-muted-foreground truncate pl-3">
                      {t.players.join(" & ")}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Live standings table */}
            <div>
              <div className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                Group Standings
              </div>
              <table className="w-full text-xs border border-border">
                <thead>
                  <tr className="bg-charcoal text-sand text-left">
                    <th className="px-3 py-2 font-semibold">Team</th>
                    <th className="px-2 py-2 font-semibold text-center">W</th>
                    <th className="px-2 py-2 font-semibold text-center">L</th>
                    <th className="px-2 py-2 font-semibold text-center">+/-</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((row, i) => (
                    <tr
                      key={row.name}
                      className={`border-t border-border/60 transition-colors ${
                        i === 0 && (row.w > 0 || row.pd > 0)
                          ? "bg-pickle/5"
                          : i % 2 === 0
                            ? "bg-background"
                            : "bg-card"
                      }`}
                    >
                      <td className="px-3 py-2 font-semibold truncate max-w-[120px]">
                        {i === 0 && row.w > 0 && (
                          <span className="inline-block mr-1.5 h-1.5 w-1.5 rounded-full bg-pickle align-middle" />
                        )}
                        {row.name}
                      </td>
                      <td className="px-2 py-2 text-center font-mono font-bold text-pickle">{row.w}</td>
                      <td className="px-2 py-2 text-center font-mono text-muted-foreground">{row.l}</td>
                      <td className={`px-2 py-2 text-center font-mono ${row.pd > 0 ? "text-pickle" : row.pd < 0 ? "text-brick" : "text-muted-foreground"}`}>
                        {row.pd > 0 ? `+${row.pd}` : row.pd}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {completedCount === 0 && (
                <p className="text-[0.6rem] text-muted-foreground mt-2 font-mono uppercase tracking-widest">
                  Standings update as matches are finalized.
                </p>
              )}
            </div>
          </div>

          {/* Match list */}
          <div>
            <div className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground mb-3">
              Matches &amp; Live Scores
            </div>
            <div className="space-y-2">
              {groupMatches.map((gm, matchIdx) => {
                const live = findLiveMatchForTeams(matches, gm.teamA.name, gm.teamB.name);
                const isLive = live?.status === "live";
                const isFinal = live?.status === "final";

                const scoreA = live
                  ? (live.teamAName === gm.teamA.name ? live.score.teamAScore : live.score.teamBScore)
                  : undefined;
                const scoreB = live
                  ? (live.teamAName === gm.teamA.name ? live.score.teamBScore : live.score.teamAScore)
                  : undefined;

                const servingA = isLive && live && (
                  (live.teamAName === gm.teamA.name && live.score.servingTeam === "A") ||
                  (live.teamBName === gm.teamA.name && live.score.servingTeam === "B")
                );
                const servingB = isLive && live && (
                  (live.teamAName === gm.teamB.name && live.score.servingTeam === "A") ||
                  (live.teamBName === gm.teamB.name && live.score.servingTeam === "B")
                );

                return (
                  <div
                    key={gm.id}
                    className={`border transition-colors ${
                      isLive
                        ? "border-pickle/50 bg-pickle/5 shadow-sm"
                        : isFinal
                          ? "border-brick/25 bg-card"
                          : "border-border bg-card"
                    }`}
                  >
                    {/* Match row header */}
                    <div className="flex items-center justify-between px-3 pt-2 pb-1 text-[0.6rem] uppercase tracking-widest">
                      <span className="font-mono text-muted-foreground">
                        Match {matchIdx + 1} &middot; {live?.court === "Queue" ? "Queue (Courts 1–4)" : (live?.court ?? "Court TBD")}
                      </span>
                      {isLive && (
                        <span className="inline-flex items-center gap-1 font-bold text-pickle">
                          <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-ping" />
                          Live
                        </span>
                      )}
                      {isFinal && (
                        <span className="font-bold text-brick">Final</span>
                      )}
                      {!isLive && !isFinal && (
                        <span className="text-muted-foreground">Scheduled</span>
                      )}
                    </div>

                    {/* Score row */}
                    <div className="flex items-center px-3 pb-2.5 gap-2">
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        {servingA && <span className="h-2 w-2 rounded-full bg-pickle shrink-0" />}
                        <span className={`text-sm font-semibold truncate ${isFinal && scoreA !== undefined && scoreB !== undefined && scoreA > scoreB ? "text-pickle" : ""}`}>
                          {gm.teamA.name}
                        </span>
                      </div>

                      <div className="font-display text-xl shrink-0 px-2 tabular-nums">
                        {scoreA !== undefined && scoreB !== undefined
                          ? `${scoreA} \u2013 ${scoreB}`
                          : "vs"}
                      </div>

                      <div className="flex items-center justify-end gap-1.5 flex-1 min-w-0 text-right">
                        <span className={`text-sm font-semibold truncate ${isFinal && scoreA !== undefined && scoreB !== undefined && scoreB > scoreA ? "text-pickle" : ""}`}>
                          {gm.teamB.name}
                        </span>
                        {servingB && <span className="h-2 w-2 rounded-full bg-pickle shrink-0" />}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Pools({
  category,
  matches,
  drawnGroups,
}: {
  category: Category;
  matches: LiveMatch[];
  drawnGroups: BracketGroup[] | null;
}) {
  const [expandedAll, setExpandedAll] = useState(false);

  // If drawn groups exist from Bracket Draw ceremony, display official drawn brackets
  if (drawnGroups && drawnGroups.length > 0) {
    return (
      <div className="space-y-6">
        {/* Section header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-5">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="h-2 w-2 rounded-full bg-pickle" />
              <span className="text-xs font-bold uppercase tracking-[0.24em] text-pickle">
                Bracket Draw Verified
              </span>
            </div>
            <h3 className="text-2xl sm:text-3xl font-display">Pool Play Brackets</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Brackets generated from the official draw ceremony. Standings and scores update live.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
              {drawnGroups.length} brackets
            </span>
            <button
              onClick={() => setExpandedAll((v) => !v)}
              className="px-3 py-1.5 text-xs font-semibold border border-border bg-card hover:border-pickle hover:text-pickle transition-colors uppercase tracking-widest"
            >
              {expandedAll ? "Collapse All" : "Expand All"}
            </button>
          </div>
        </div>

        {/* Bracket cards */}
        <div className="space-y-3">
          {drawnGroups.map((grp, idx) => (
            <BracketCard
              key={grp.letter}
              grp={grp}
              matches={matches}
              defaultOpen={expandedAll || idx === 0}
            />
          ))}
        </div>
      </div>
    );
  }

  // Fallback to standard tournament category pools if Bracket Draw hasn't been run
  const pools = Array.from(new Set(category.pools.map((p) => p.pool)));
  const sorted = [...category.standings].sort(
    (a, b) => b.won - a.won || b.pointDiff - a.pointDiff,
  );

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      {/* Standings table */}
      <div>
        <h3 className="text-2xl font-display">Standings</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full surface-card text-sm">
            <thead className="bg-charcoal text-sand">
              <tr className="text-left">
                <th className="p-2 whitespace-nowrap">Team</th>
                <th className="p-2">W</th>
                <th className="p-2">L</th>
                <th className="p-2">+/-</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s, i) => (
                <tr key={s.teamId} className={i < 4 ? "bg-accent/10" : ""}>
                  <td className="border-t border-border p-2 font-semibold whitespace-nowrap">
                    {teamName(category, s.teamId)}
                  </td>
                  <td className="border-t border-border p-2">{s.won}</td>
                  <td className="border-t border-border p-2">{s.lost}</td>
                  <td className="border-t border-border p-2">{s.pointDiff}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pool match lists with live sync */}
      <div className="space-y-6">
        {pools.map((pool) => (
          <div key={pool}>
            <h3 className="text-2xl font-display">Pool {pool}</h3>
            <ul className="mt-3 space-y-2">
              {category.pools
                .filter((m) => m.pool === pool)
                .map((m) => {
                  const nameA = teamName(category, m.teamA);
                  const nameB = teamName(category, m.teamB);
                  const live = findLiveMatchForTeams(matches, nameA, nameB);

                  const isLive = live?.status === "live";
                  const isFinal = live?.status === "final";

                  const scoreA = live
                    ? (live.teamAName === nameA ? live.score.teamAScore : live.score.teamBScore)
                    : m.scoreA;
                  const scoreB = live
                    ? (live.teamAName === nameA ? live.score.teamBScore : live.score.teamAScore)
                    : m.scoreB;

                  const isServingA = isLive && live && ((live.teamAName === nameA && live.score.servingTeam === "A") || (live.teamBName === nameA && live.score.servingTeam === "B"));
                  const isServingB = isLive && live && ((live.teamAName === nameB && live.score.servingTeam === "A") || (live.teamBName === nameB && live.score.servingTeam === "B"));

                  return (
                    <li
                      key={m.id}
                      className={`surface-card flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-center sm:gap-4 border transition-colors ${
                        isLive
                          ? "border-pickle/60 bg-pickle/5 shadow-sm"
                          : isFinal
                            ? "border-brick/30"
                            : "border-border"
                      }`}
                    >
                      {/* Teams & score row */}
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-1 min-w-0">
                          {isServingA && <span className="h-2 w-2 rounded-full bg-pickle shrink-0" />}
                          <span className={`truncate font-semibold ${isFinal && scoreA !== undefined && scoreB !== undefined && scoreA > scoreB ? "text-pickle" : ""}`}>
                            {nameA}
                          </span>
                        </div>

                        <span className="flex-shrink-0 font-display text-lg px-2">
                          {scoreA ?? "-"} &ndash; {scoreB ?? "-"}
                        </span>

                        <div className="flex items-center justify-end gap-1.5 flex-1 min-w-0 text-right">
                          <span className={`truncate font-semibold ${isFinal && scoreA !== undefined && scoreB !== undefined && scoreB > scoreA ? "text-pickle" : ""}`}>
                            {nameB}
                          </span>
                          {isServingB && <span className="h-2 w-2 rounded-full bg-pickle shrink-0" />}
                        </div>
                      </div>

                      {/* Court, time, & live status badge */}
                      <div className="flex items-center justify-between sm:justify-end gap-2 text-[0.65rem] uppercase tracking-widest text-muted-foreground sm:flex-shrink-0">
                        <span>{live?.court === "Queue" ? "Queue (Courts 1–4)" : (live?.court ?? m.court)} &middot; {m.time}</span>
                        {isLive && (
                          <span className="font-bold text-pickle inline-flex items-center gap-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-ping" />
                            Live
                          </span>
                        )}
                        {isFinal && <span className="font-bold text-brick">Final</span>}
                      </div>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   TAB 4: TEAMS & PAYMENT PROOF
═══════════════════════════════════════════════ */

function Teams({ category }: { category: Category }) {
  if (!category.teams || category.teams.length === 0) {
    return (
      <div className="surface-card p-10 text-center border border-border space-y-3">
        <span className="text-xs uppercase tracking-[0.28em] font-bold text-pickle block">
          Roster Standby
        </span>
        <h3 className="font-display text-2xl text-foreground">No Teams Registered Yet</h3>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Teams and player rosters will appear here once registered. Organizers can add, auto-populate, or delete teams in the Admin Console.
        </p>
        <Link
          to="/admin"
          className="inline-block mt-2 px-4 py-2 bg-pickle text-sand text-xs font-bold uppercase tracking-widest hover:opacity-90 transition-opacity"
        >
          Open Organizer Console &rarr;
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border pb-3">
        <span className="text-xs uppercase tracking-widest text-muted-foreground font-bold">
          {category.teams.length} Registered Teams
        </span>
        <Link
          to="/admin"
          className="text-xs text-pickle font-bold uppercase tracking-wider hover:underline"
        >
          Organizer Console: Manage &amp; Delete Players &rarr;
        </Link>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {category.teams.map((t) => {
          const isPaid = t.paid ?? false;
          return (
            <li key={t.id} className="surface-card p-4 flex flex-col justify-between gap-3 border border-border">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display text-xl sm:text-2xl text-foreground truncate">{t.name}</span>
                  <span
                    className={`flex-shrink-0 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-widest rounded ${
                      isPaid
                        ? "bg-pickle/20 text-pickle border border-pickle/40"
                        : "bg-brick/20 text-brick border border-brick/40"
                    }`}
                  >
                    {isPaid ? "Verified Paid" : "Pending"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t.players.join(" & ")}</p>
              </div>

              <div className="pt-2 border-t border-border/50 flex items-center justify-between text-[0.65rem] text-muted-foreground uppercase tracking-widest font-mono">
                <span>Ref: {t.paymentRef ?? "GC-98214309"}</span>
                {t.paymentProofUrl && (
                  <span className="text-pickle font-bold flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-pickle" /> Photo Attached
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
