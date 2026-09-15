import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";

import {
  useMatchStore,
  generateMockMatches,
  saveMatches,
  scorePoint,
  sideOut,
  endGame,
  undoLastRally,
  type LiveMatch,
} from "@/lib/match-store";

export const Route = createFileRoute("/umpire")({
  beforeLoad: () => {
    if (typeof localStorage !== "undefined") {
      const isAuthenticated = localStorage.getItem("mock_umpire_auth") === "true";
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
  const { matches, refresh, update, resetAll } = useMatchStore();
  const [activeTab, setActiveTab] = useState<UmpireTab>("desk");
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [umpireName, setUmpireName] = useState("Official");

  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      setUmpireName(localStorage.getItem("mock_umpire_name") ?? "Official");
    }
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

  const selectedMatch = matches.find((m) => m.id === selectedMatchId) ?? null;

  const tabs: { key: UmpireTab; label: string }[] = [
    { key: "desk", label: "Tournament Desk" },
    { key: "console", label: "Umpire Console" },
    { key: "scoreboard", label: "Live Scoreboard" },
  ];

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      {/* Top bar */}
      <div className="sticky top-16 z-40 border-b border-border bg-charcoal/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-8 w-8 rounded-full bg-pickle/20 flex items-center justify-center flex-shrink-0">
                <span className="font-display text-sm text-pickle">
                  {umpireName.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="min-w-0">
                <span className="block text-[0.6rem] uppercase tracking-[0.28em] text-pickle font-bold">
                  Umpire Console
                </span>
                <span className="block text-sm text-sand truncate">{umpireName}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={resetAll}
                className="px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest border border-border text-sand hover:border-sand hover:text-sand/90 transition-colors"
              >
                Clear Matches
              </button>
              <button
                onClick={handleLogout}
                className="px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest bg-brick/20 text-brick hover:bg-brick/30 transition-colors"
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
                className={`whitespace-nowrap px-4 py-2.5 text-xs font-bold uppercase tracking-widest transition-all border-b-2 ${
                  activeTab === tab.key
                    ? "border-pickle text-pickle"
                    : "border-transparent text-sand/70 hover:text-sand"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto max-w-6xl px-4 py-6">
        {activeTab === "desk" && (
          <TournamentDesk
            matches={matches}
            currentUmpire={umpireName}
            onSelectMatch={openConsole}
          />
        )}
        {activeTab === "console" && (
          <UmpireConsole
            match={selectedMatch}
            matches={matches}
            currentUmpire={umpireName}
            onUpdate={update}
            onSelectMatch={(id) => setSelectedMatchId(id)}
            onBack={() => setActiveTab("desk")}
          />
        )}
        {activeTab === "scoreboard" && <LiveScoreboard matches={matches} />}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   TAB 1: TOURNAMENT DESK
═══════════════════════════════════════════════ */

function TournamentDesk({
  matches,
  currentUmpire,
  onSelectMatch,
}: {
  matches: LiveMatch[];
  currentUmpire: string;
  onSelectMatch: (id: string) => void;
}) {
  const [courtFilter, setCourtFilter] = useState<string>("all");

  const liveCount = matches.filter((m) => m.status === "live").length;
  const finalCount = matches.filter((m) => m.status === "final").length;
  const scheduledCount = matches.filter((m) => m.status === "scheduled").length;

  const displayedMatches = matches.filter((m) => {
    if (courtFilter === "all") return true;
    return m.court === courtFilter;
  });

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-5">
        <div>
          <span className="text-xs font-bold uppercase tracking-[0.28em] text-pickle">
            Tournament Desk
          </span>
          <h2 className="font-display text-3xl sm:text-4xl text-foreground mt-1">
            Match Overview
          </h2>
          <p className="text-sm text-foreground/80 mt-1">
            Tap a match card to open the scoring console.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {/* Facility Court Filters */}
          <div className="flex items-center gap-1 border border-border p-1 bg-charcoal">
            {["all", "Court 1", "Court 2", "Court 3", "Court 4", "Queue"].map((c) => (
              <button
                key={c}
                onClick={() => setCourtFilter(c)}
                className={`px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider transition-colors cursor-pointer ${
                  courtFilter === c
                    ? "bg-pickle text-sand"
                    : "text-sand/70 hover:text-sand"
                }`}
              >
                {c === "all" ? "All Courts" : c}
              </button>
            ))}
          </div>

          <div className="flex gap-3">
            <StatBadge label="Live" value={liveCount} color="pickle" pulse={liveCount > 0} />
            <StatBadge label="Scheduled" value={scheduledCount} color="sand" />
            <StatBadge label="Final" value={finalCount} color="brick" />
          </div>
        </div>
      </div>

      {/* Match cards grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {displayedMatches.map((match) => (
          <button
            key={match.id}
            onClick={() => onSelectMatch(match.id)}
            className={`surface-card p-0 overflow-hidden text-left transition-all hover:scale-[1.01] active:scale-[0.99] border cursor-pointer ${
              match.status === "live"
                ? "border-pickle/60 shadow-lg shadow-pickle/10"
                : match.status === "final"
                  ? "border-brick/40"
                  : "border-border hover:border-foreground/40"
            }`}
          >
            {/* Card header */}
            <div className="bg-charcoal px-4 py-2.5 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-widest text-sand">
                {match.court}
              </span>
              <MatchStatusBadge status={match.status} />
            </div>

            {/* Teams & Score */}
            <div className="p-4 space-y-3">
              {/* Team A */}
              <div className="flex items-center justify-between">
                <div className="min-w-0 mr-3">
                  <span
                    className={`block text-sm font-semibold truncate ${
                      match.winnerTeam === match.teamAName
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
                  className={`font-display text-2xl ${
                    match.status !== "scheduled" ? "text-foreground" : "text-foreground/50"
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
                    className={`block text-sm font-semibold truncate ${
                      match.winnerTeam === match.teamBName
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
                  className={`font-display text-2xl ${
                    match.status !== "scheduled" ? "text-foreground" : "text-foreground/50"
                  }`}
                >
                  {match.score.teamBScore}
                </span>
              </div>

              {/* Serving indicator for live matches */}
              {match.status === "live" && (
                <div className="pt-2 border-t border-border/60 text-[0.65rem] uppercase tracking-widest text-pickle font-bold">
                  Serving: {match.score.servingTeam === "A" ? match.teamAName : match.teamBName}
                  {" "} (Server {match.score.serverNumber})
                </div>
              )}

              {/* Winner for final matches */}
              {match.status === "final" && match.winnerTeam && (
                <div className="pt-2 border-t border-border/60 text-[0.65rem] uppercase tracking-widest text-pickle font-bold">
                  Winner: {match.winnerTeam}
                </div>
              )}

              {/* Live Official assignment */}
              <div className="pt-2 border-t border-border/60 flex items-center justify-between text-[0.65rem] uppercase tracking-widest">
                <span className="text-foreground/70 font-semibold">Live Official:</span>
                <span
                  className={`font-mono ${
                    match.officiatedBy ? "text-pickle font-bold" : "text-foreground/50"
                  }`}
                >
                  {match.officiatedBy
                    ? match.officiatedBy === currentUmpire
                      ? `${match.officiatedBy} (You)`
                      : match.officiatedBy
                    : "Unassigned"}
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>

      {matches.length === 0 && (
        <div className="surface-card p-12 text-center">
          <h3 className="font-display text-2xl text-foreground">No Matches Assigned</h3>
          <p className="text-sm text-foreground/80 mt-2">
            No matches currently assigned to facility courts. Matches will appear here once dispatched from the tournament desk.
          </p>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   COIN TOSS OVERLAY
═══════════════════════════════════════════════ */

type TossPhase = "idle" | "flipping" | "result" | "choosing" | "done";

function CoinTossOverlay({
  teamAName,
  teamBName,
  onDone,
}: {
  teamAName: string;
  teamBName: string;
  onDone: (servingTeam: "A" | "B") => void;
}) {
  const [phase, setPhase] = useState<TossPhase>("idle");
  const [face, setFace] = useState<"heads" | "tails">("heads");
  const [winnerTeam, setWinnerTeam] = useState<"A" | "B" | null>(null);
  const [choosingTeam, setChoosingTeam] = useState<"A" | "B" | null>(null);
  const flipRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startToss = () => {
    setPhase("flipping");
    setFace("heads");
    let count = 0;
    const totalFlips = 18 + Math.floor(Math.random() * 10);
    flipRef.current = setInterval(() => {
      count++;
      setFace((f) => (f === "heads" ? "tails" : "heads"));
      if (count >= totalFlips) {
        clearInterval(flipRef.current!);
        const landedFace: "heads" | "tails" = count % 2 === 0 ? "heads" : "tails";
        setFace(landedFace);
        const winner: "A" | "B" = Math.random() < 0.5 ? "A" : "B";
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
    setTimeout(() => onDone(serving), 600);
  };

  const winnerName = winnerTeam === "A" ? teamAName : teamBName;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/96 backdrop-blur-sm p-4">
      <div className="surface-card border-2 border-pickle/50 max-w-sm w-full p-6 sm:p-8 space-y-6 text-center">
        <div>
          <span className="block text-[0.6rem] uppercase tracking-[0.3em] font-bold text-pickle mb-1">
            Pre-Match
          </span>
          <h2 className="font-display text-3xl text-foreground">Coin Toss</h2>
          <p className="text-xs text-foreground/70 mt-1 font-medium">
            {teamAName} vs {teamBName}
          </p>
        </div>

        {/* Realistic Coin */}
        <div className="flex flex-col items-center gap-2">
          <div
            className={`relative h-32 w-32 rounded-full overflow-hidden select-none ${
              phase === "flipping"
                ? "coin-flip"
                : phase === "result" || phase === "choosing"
                  ? "coin-land"
                  : phase === "done"
                    ? "opacity-0 scale-90 transition-all duration-500"
                    : ""
            }`}
            style={{ willChange: "transform" }}
          >
            {/* Heads face */}
            <img
              src="/coin_heads.png"
              alt="Heads"
              className={`absolute inset-0 h-full w-full object-cover rounded-full transition-opacity duration-75 ${
                face === "heads" || phase === "idle" ? "opacity-100" : "opacity-0"
              }`}
              draggable={false}
            />
            {/* Tails face */}
            <img
              src="/coin_tails.png"
              alt="Tails"
              className={`absolute inset-0 h-full w-full object-cover rounded-full transition-opacity duration-75 ${
                face === "tails" && phase !== "idle" ? "opacity-100" : "opacity-0"
              }`}
              draggable={false}
            />
          </div>

          {/* Face label */}
          {phase !== "idle" && phase !== "done" && (
            <span className="text-[0.6rem] font-bold uppercase tracking-[0.25em] text-foreground/60">
              {face === "heads" ? "Heads" : "Tails"}
            </span>
          )}
        </div>

        {/* Actions */}
        {phase === "idle" && (
          <button
            onClick={startToss}
            className="w-full bg-pickle text-sand font-display text-xl tracking-widest py-4 hover:opacity-90 active:scale-[0.97] transition-all cursor-pointer"
          >
            Flip Coin
          </button>
        )}

        {phase === "flipping" && (
          <p className="text-sm font-bold text-foreground/60 uppercase tracking-widest animate-pulse">
            Flipping...
          </p>
        )}

        {(phase === "result" || phase === "choosing") && winnerTeam && (
          <div className="space-y-4">
            <div className="bg-pickle/15 border border-pickle/40 px-4 py-3">
              <span className="block text-[0.6rem] uppercase tracking-[0.28em] font-bold text-pickle">
                Coin Toss Winner
              </span>
              <span className="block font-display text-2xl text-foreground mt-0.5">
                {winnerName}
              </span>
            </div>
            <p className="text-xs text-foreground/70 font-medium uppercase tracking-widest">
              {winnerName} chooses:
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handleChoice("serve")}
                className="bg-pickle text-sand font-display text-base tracking-widest py-3 hover:opacity-90 active:scale-[0.97] transition-all cursor-pointer"
              >
                Serve First
              </button>
              <button
                onClick={() => handleChoice("receive")}
                className="border border-border text-foreground font-display text-base tracking-widest py-3 hover:border-foreground/50 transition-colors cursor-pointer"
              >
                Receive First
              </button>
            </div>
          </div>
        )}

        {phase === "done" && (
          <p className="text-sm font-bold text-pickle uppercase tracking-widest">
            Starting match...
          </p>
        )}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════
   TAB 2: UMPIRE CONSOLE (LIVE SCORING)
═══════════════════════════════════════════════ */

function UmpireConsole({
  match,
  matches,
  currentUmpire,
  onUpdate,
  onSelectMatch,
  onBack,
}: {
  match: LiveMatch | null;
  matches: LiveMatch[];
  currentUmpire: string;
  onUpdate: (matchId: string, updater: (m: LiveMatch) => LiveMatch) => void;
  onSelectMatch: (id: string) => void;
  onBack: () => void;
}) {
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [showToss, setShowToss] = useState(false);
  const [tossDone, setTossDone] = useState(false);
  const [tossServingTeam, setTossServingTeam] = useState<"A" | "B" | null>(null);

  // Reset toss state when match changes
  useEffect(() => {
    setShowToss(false);
    setTossDone(false);
    setTossServingTeam(null);
  }, [match?.id]);

  if (!match) {
    return (
      <div className="space-y-6">
        <div className="border-b border-border pb-5">
          <span className="text-xs font-bold uppercase tracking-[0.28em] text-pickle">
            Umpire Console
          </span>
          <h2 className="font-display text-3xl sm:text-4xl text-foreground mt-1">
            Select a Match
          </h2>
          <p className="text-sm text-foreground/80 mt-1">
            Choose a match below or go to the Tournament Desk to pick one.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {matches
            .filter((m) => m.status !== "final")
            .map((m) => (
              <button
                key={m.id}
                onClick={() => onSelectMatch(m.id)}
                className="surface-card p-4 text-left border border-border hover:border-foreground/50 transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-widest text-foreground font-mono">
                    {m.court}
                  </span>
                  <MatchStatusBadge status={m.status} />
                </div>
                <div className="my-2 text-sm font-semibold text-foreground">
                  {m.teamAName} vs {m.teamBName}
                </div>
                <div className="pt-2 border-t border-border/60 flex items-center justify-between text-[0.65rem] uppercase tracking-widest">
                  <span className="text-foreground/70 font-semibold">Official:</span>
                  <span
                    className={`font-mono ${
                      m.officiatedBy ? "text-pickle font-bold" : "text-foreground/50"
                    }`}
                  >
                    {m.officiatedBy
                      ? m.officiatedBy === currentUmpire
                        ? `${m.officiatedBy} (You)`
                        : m.officiatedBy
                      : "Unassigned"}
                  </span>
                </div>
              </button>
            ))}
        </div>

        <button
          onClick={onBack}
          className="text-xs font-bold uppercase tracking-widest text-foreground hover:text-foreground/70 transition-colors underline underline-offset-2 cursor-pointer"
        >
          &larr; Back to Tournament Desk
        </button>
      </div>
    );
  }

  const isLiveOrScheduled = match.status !== "final";
  // A toss is needed only for scheduled matches that haven't started (no rallies)
  const needsToss = match.status === "scheduled" && match.score.rallies.length === 0 && !tossDone;
  const s = match.score;
  const servingTeamName = s.servingTeam === "A" ? match.teamAName : match.teamBName;
  const effectiveUmpire = match.officiatedBy ?? currentUmpire;

  // Build the 3-number score call from serving team's perspective
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
  };

  const handleEndGame = () => {
    onUpdate(match.id, (m) => {
      const updated = endGame(m);
      return {
        ...updated,
        officiatedBy: m.officiatedBy ?? currentUmpire,
      };
    });
    setShowEndConfirm(false);
  };

  const handleUndo = () => {
    if (s.rallies.length === 0) return;
    onUpdate(match.id, undoLastRally);
  };

  const handleTossDone = (serving: "A" | "B") => {
    setTossDone(true);
    setTossServingTeam(serving);
    setShowToss(false);
    // Apply the toss result — update serving team and ensure score starts at 0-0-2
    onUpdate(match.id, (m) => ({
      ...m,
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
        />
      )}
      {/* Back button + match header + live official badge */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-foreground hover:text-foreground/70 transition-colors cursor-pointer w-fit"
        >
          <span className="text-base leading-none">&larr;</span> Desk
        </button>

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
          <span className="text-xs font-bold uppercase tracking-widest font-mono bg-charcoal text-sand px-2.5 py-1 border border-border">
            {match.court}
          </span>
        </div>
      </div>

      {/* Reassignment / Claim banner if another official was assigned */}
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

      {/* Score Display -- the big 3-number call */}
      <div className="surface-card p-0 overflow-hidden border-2 border-pickle/40">
        {/* Serving team indicator */}
        <div className="bg-pickle/15 px-4 py-2 text-center">
          <span className="text-[0.65rem] uppercase tracking-[0.28em] font-bold text-pickle">
            {match.status === "final" ? "Final Score" : `Serving: ${servingTeamName}`}
          </span>
        </div>

        {/* 3-Number Score Call */}
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
            className={`p-4 sm:p-5 text-center transition-colors ${
              s.servingTeam === "A" && match.status !== "final"
                ? "bg-pickle/10"
                : match.winnerTeam === match.teamAName
                  ? "bg-pickle/15"
                  : ""
            }`}
          >
            <span
              className={`block font-display text-4xl sm:text-5xl ${
                match.winnerTeam === match.teamAName ? "text-pickle" : "text-foreground"
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
            className={`p-4 sm:p-5 text-center transition-colors ${
              s.servingTeam === "B" && match.status !== "final"
                ? "bg-pickle/10"
                : match.winnerTeam === match.teamBName
                  ? "bg-pickle/15"
                  : ""
            }`}
          >
            <span
              className={`block font-display text-4xl sm:text-5xl ${
                match.winnerTeam === match.teamBName ? "text-pickle" : "text-foreground"
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

      {/* Pre-match Toss Banner */}
      {needsToss && !showToss && (
        <div className="border border-pickle/40 bg-pickle/10 px-4 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <span className="block text-[0.6rem] uppercase tracking-[0.28em] font-bold text-pickle">
              Pre-Match Required
            </span>
            <span className="block text-sm font-semibold text-foreground mt-0.5">
              Conduct coin toss before scoring
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

      {/* Toss result summary */}
      {tossDone && tossServingTeam && (
        <div className="border border-border bg-charcoal/50 px-4 py-2.5 flex items-center justify-between text-xs">
          <span className="text-foreground/70 font-semibold uppercase tracking-widest">Toss Result</span>
          <span className="font-bold text-foreground font-mono">
            {tossServingTeam === "A" ? match.teamAName : match.teamBName} serves first
          </span>
        </div>
      )}

      {/* Action Buttons */}
      {isLiveOrScheduled && (
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handlePoint}
            disabled={needsToss}
            className={`font-display text-2xl sm:text-3xl tracking-widest py-5 sm:py-6 transition-all ${
              needsToss
                ? "bg-pickle/30 text-sand/40 cursor-not-allowed"
                : "bg-pickle text-sand active:scale-[0.97] hover:opacity-90 cursor-pointer"
            }`}
          >
            Point Scored
          </button>

          <button
            onClick={handleSideOut}
            disabled={needsToss}
            className={`font-display text-2xl sm:text-3xl tracking-widest py-5 sm:py-6 transition-all ${
              needsToss
                ? "bg-brick/30 text-sand/40 cursor-not-allowed"
                : "bg-brick text-sand active:scale-[0.97] hover:bg-brick-deep cursor-pointer"
            }`}
          >
            Side Out
          </button>

          <button
            onClick={handleUndo}
            disabled={s.rallies.length === 0}
            className={`col-span-1 border border-border bg-charcoal font-display text-xl tracking-widest py-4 transition-colors ${
              s.rallies.length > 0
                ? "text-sand hover:border-sand/50 cursor-pointer"
                : "text-sand/30 cursor-not-allowed"
            }`}
          >
            Undo
          </button>

          <button
            onClick={() => setShowEndConfirm(true)}
            className="col-span-1 border border-brick/50 bg-brick/10 font-display text-xl tracking-widest py-4 text-brick hover:bg-brick/20 transition-colors cursor-pointer"
          >
            End Game
          </button>
        </div>
      )}

      {/* End Game Confirmation */}
      {showEndConfirm && (
        <div className="surface-card p-6 border-2 border-brick space-y-4">
          <h3 className="font-display text-2xl text-foreground text-center">
            End this game?
          </h3>
          <p className="text-sm text-foreground/80 font-medium text-center">
            Final score: {match.teamAName} {s.teamAScore} - {s.teamBScore} {match.teamBName}
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={handleEndGame}
              className="bg-brick text-sand font-display text-xl tracking-widest px-8 py-3 hover:bg-brick-deep transition-colors"
            >
              Confirm
            </button>
            <button
              onClick={() => setShowEndConfirm(false)}
              className="border border-border text-foreground font-display text-xl tracking-widest px-8 py-3 hover:border-foreground/50 transition-colors"
            >
              Cancel
            </button>
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

        <div className="max-h-64 overflow-y-auto divide-y divide-border/60">
          {s.rallies.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-foreground/80">
              No rallies yet. Start the match by scoring a point or calling a side out.
            </div>
          ) : (
            [...s.rallies].reverse().map((rally, idx) => (
              <div
                key={rally.id}
                className={`px-4 py-2.5 flex items-center justify-between gap-3 text-xs ${
                  idx === 0 ? "bg-pickle/5" : ""
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      rally.type === "point"
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

      {/* Match selector at bottom */}
      {matches.filter((m) => m.status !== "final").length > 1 && (
        <div className="border-t border-border pt-4">
          <span className="block text-[0.65rem] uppercase tracking-[0.2em] font-bold text-foreground mb-3">
            Switch Match
          </span>
          <div className="flex flex-wrap gap-2">
            {matches
              .filter((m) => m.status !== "final")
              .map((m) => (
                <button
                  key={m.id}
                  onClick={() => onSelectMatch(m.id)}
                  className={`px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-widest border transition-colors cursor-pointer font-mono inline-flex items-center gap-1.5 ${
                    m.id === match.id
                      ? "border-foreground bg-charcoal text-sand shadow-sm"
                      : "border-border bg-card text-foreground hover:border-foreground/60 hover:bg-muted/50"
                  }`}
                >
                  <span>{m.court}</span>
                  {m.officiatedBy && (
                    <span className="text-[0.55rem] font-normal opacity-80">
                      ({m.officiatedBy === currentUmpire ? "You" : m.officiatedBy})
                    </span>
                  )}
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

function LiveScoreboard({ matches }: { matches: LiveMatch[] }) {
  const liveMatches = matches.filter((m) => m.status === "live");
  const scheduledMatches = matches.filter((m) => m.status === "scheduled");
  const finalMatches = matches.filter((m) => m.status === "final");

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="border-b border-border pb-5 text-center">
        <span className="text-xs font-bold uppercase tracking-[0.28em] text-pickle">
          Live Scoreboard
        </span>
        <h2 className="font-display text-3xl sm:text-4xl text-foreground mt-1">
          Dink Valley Live Scores
        </h2>
        <p className="text-sm text-foreground/80 mt-1">
          Auto-refreshes every 2 seconds
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

      {/* Live matches first */}
      {liveMatches.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-display text-xl text-pickle flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-pickle animate-pulse" />
            Live Now
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {liveMatches.map((match) => (
              <ScoreboardCard key={match.id} match={match} />
            ))}
          </div>
        </div>
      )}

      {/* Scheduled matches */}
      {scheduledMatches.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-display text-xl text-foreground">Upcoming</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {scheduledMatches.map((match) => (
              <ScoreboardCard key={match.id} match={match} />
            ))}
          </div>
        </div>
      )}

      {/* Completed matches */}
      {finalMatches.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-display text-xl text-brick">Completed</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {finalMatches.map((match) => (
              <ScoreboardCard key={match.id} match={match} />
            ))}
          </div>
        </div>
      )}

      {matches.length === 0 && (
        <div className="surface-card p-12 text-center">
          <h3 className="font-display text-2xl text-foreground">No Matches Scheduled</h3>
          <p className="text-sm text-foreground/80 mt-2">
            Matches will appear here when an umpire starts officiating.
          </p>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SHARED SUB-COMPONENTS
═══════════════════════════════════════════════ */

function ScoreboardCard({ match }: { match: LiveMatch }) {
  const s = match.score;
  const isLive = match.status === "live";

  return (
    <div
      className={`surface-card p-0 overflow-hidden border transition-all ${
        isLive
          ? "border-pickle/50 shadow-lg shadow-pickle/10"
          : match.status === "final"
            ? "border-brick/30"
            : "border-border"
      }`}
    >
      {/* Court header */}
      <div
        className={`px-4 py-2 flex items-center justify-between ${
          isLive ? "bg-pickle/15" : "bg-charcoal"
        }`}
      >
        <span className="text-xs font-bold uppercase tracking-widest text-sand">
          {match.court}
        </span>
        <MatchStatusBadge status={match.status} />
      </div>

      {/* Score display */}
      <div className="p-4 sm:p-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          {/* Team A */}
          <div className="text-center">
            <span
              className={`block font-display text-3xl sm:text-4xl ${
                match.winnerTeam === match.teamAName
                  ? "text-pickle"
                  : "text-foreground"
              }`}
            >
              {s.teamAScore}
            </span>
            <span className="block text-xs font-semibold text-foreground mt-1 truncate">
              {match.teamAName}
            </span>
            {isLive && s.servingTeam === "A" && (
              <span className="inline-block mt-1 text-[0.5rem] uppercase tracking-widest bg-pickle text-sand px-1.5 py-0.5 font-bold">
                Serving
              </span>
            )}
          </div>

          {/* VS */}
          <span className="font-display text-lg text-brick">VS</span>

          {/* Team B */}
          <div className="text-center">
            <span
              className={`block font-display text-3xl sm:text-4xl ${
                match.winnerTeam === match.teamBName
                  ? "text-pickle"
                  : "text-foreground"
              }`}
            >
              {s.teamBScore}
            </span>
            <span className="block text-xs font-semibold text-foreground mt-1 truncate">
              {match.teamBName}
            </span>
            {isLive && s.servingTeam === "B" && (
              <span className="inline-block mt-1 text-[0.5rem] uppercase tracking-widest bg-pickle text-sand px-1.5 py-0.5 font-bold">
                Serving
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

        {/* Live Official assignment */}
        <div className="mt-3 pt-2.5 border-t border-border/60 flex items-center justify-between text-[0.65rem] uppercase tracking-widest">
          <span className="text-foreground/70 font-semibold">Live Official</span>
          <span
            className={`font-mono ${
              match.officiatedBy ? "text-pickle font-bold" : "text-foreground/50"
            }`}
          >
            {match.officiatedBy ?? "Pending Assignment"}
          </span>
        </div>
      </div>
    </div>
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
