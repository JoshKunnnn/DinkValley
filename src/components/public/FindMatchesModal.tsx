import { useState, useEffect } from "react";
import type { Team, Category } from "@/data/tournaments";
import { type LiveMatch, findLiveMatchForTeams } from "@/lib/match-store";
import { type BracketGroup } from "@/components/admin/BracketDraw";

interface FindMatchesModalProps {
  isOpen: boolean;
  onClose: () => void;
  team: Team | null;
  category: Category;
  matches: LiveMatch[];
  drawnGroups: BracketGroup[] | null;
  onViewLiveCourts?: (courtName?: string) => void;
  onToast?: (msg: string) => void;
}

export function FindMatchesModal({
  isOpen,
  onClose,
  team,
  category,
  matches,
  drawnGroups,
  onViewLiveCourts,
  onToast,
}: FindMatchesModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !team) return null;

  // Find which bracket group this team belongs to
  let assignedBracketLetter: string | null = null;
  if (drawnGroups) {
    for (const group of drawnGroups) {
      if (group.slots.some((s) => s.team?.id === team.id || s.team?.name.toLowerCase() === team.name.toLowerCase())) {
        assignedBracketLetter = group.letter;
        break;
      }
    }
  }

  // Find all matches involving this team
  const cleanTeamName = team.name.trim().toLowerCase();
  const teamMatches: {
    id: string;
    opponentName: string;
    opponentPlayers: string[];
    stage: string;
    scoreOur: number | undefined;
    scoreOpp: number | undefined;
    court: string;
    status: "live" | "final" | "scheduled" | "warmup";
    isServing: boolean;
    serverNumber?: number;
    liveMatch?: LiveMatch;
  }[] = [];

  // 1. Matches from live match store
  for (const m of matches) {
    const isTeamA = m.teamAName.trim().toLowerCase() === cleanTeamName;
    const isTeamB = m.teamBName.trim().toLowerCase() === cleanTeamName;
    if (isTeamA || isTeamB) {
      const isServing = (isTeamA && m.score.servingTeam === "A") || (isTeamB && m.score.servingTeam === "B");
      teamMatches.push({
        id: m.id,
        opponentName: isTeamA ? m.teamBName : m.teamAName,
        opponentPlayers: isTeamA ? m.teamBPlayers : m.teamAPlayers,
        stage: m.stage || "Match",
        scoreOur: isTeamA ? m.score.teamAScore : m.score.teamBScore,
        scoreOpp: isTeamA ? m.score.teamBScore : m.score.teamAScore,
        court: m.court,
        status: m.status === "live" ? "live" : m.status === "final" ? "final" : "scheduled",
        isServing,
        serverNumber: m.score.serverNumber,
        liveMatch: m,
      });
    }
  }

  // Calculate quick stats
  const completed = teamMatches.filter((m) => m.status === "final");
  const wonCount = completed.filter((m) => (m.scoreOur ?? 0) > (m.scoreOpp ?? 0)).length;
  const lostCount = completed.filter((m) => (m.scoreOur ?? 0) < (m.scoreOpp ?? 0)).length;
  const pointDiff = completed.reduce((acc, m) => acc + ((m.scoreOur ?? 0) - (m.scoreOpp ?? 0)), 0);

  const [copied, setCopied] = useState(false);

  const handleShare = () => {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("team", team.name);
      navigator.clipboard.writeText(url.toString()).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
        if (onToast) {
          onToast(`Match link for ${team.name} copied to clipboard`);
        }
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
      <div className="surface-card bg-card border border-border w-full max-w-2xl max-h-[90vh] flex flex-col rounded-lg shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 sm:p-6 border-b border-border bg-charcoal text-sand flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[0.65rem] font-bold uppercase tracking-[0.24em] text-pickle">
                {category.label} &middot; {category.level}
              </span>
              {assignedBracketLetter && (
                <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-widest bg-pickle/20 text-pickle border border-pickle/40 rounded">
                  Bracket {assignedBracketLetter}
                </span>
              )}
            </div>
            <h2 className="text-2xl sm:text-3xl font-display text-sand mt-1 truncate">
              {team.name}
            </h2>
            <p className="text-xs text-sand/75 mt-0.5">
              Players: {team.players.join(" & ")} {team.club ? `(${team.club})` : ""}
            </p>
          </div>

          <button
            onClick={onClose}
            className="h-8 w-8 rounded-full border border-sand/20 hover:bg-sand/10 flex items-center justify-center text-sand transition-colors cursor-pointer shrink-0"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Quick Performance & Standing Bar */}
        <div className="grid grid-cols-4 border-b border-border bg-charcoal/50 text-center py-3 text-xs">
          <div>
            <div className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">Played</div>
            <div className="font-display text-lg text-foreground font-bold">{completed.length}</div>
          </div>
          <div>
            <div className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">Won</div>
            <div className="font-display text-lg text-pickle font-bold">{wonCount}</div>
          </div>
          <div>
            <div className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">Lost</div>
            <div className="font-display text-lg text-brick font-bold">{lostCount}</div>
          </div>
          <div>
            <div className="text-[0.65rem] uppercase tracking-wider text-muted-foreground">Diff (+/-)</div>
            <div className={`font-display text-lg font-bold ${pointDiff > 0 ? "text-pickle" : pointDiff < 0 ? "text-brick" : "text-foreground"}`}>
              {pointDiff > 0 ? `+${pointDiff}` : pointDiff}
            </div>
          </div>
        </div>

        {/* Matches List */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-3">
          <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-muted-foreground">
            <span>Scheduled &amp; Completed Matches ({teamMatches.length})</span>
            <button
              onClick={handleShare}
              className="text-pickle hover:underline cursor-pointer font-mono"
            >
              {copied ? "Link Copied!" : "Share Match Link \u2192"}
            </button>
          </div>

          {teamMatches.length === 0 ? (
            <div className="text-center py-10 surface-card p-6 border border-border">
              <span className="text-xs uppercase tracking-widest text-muted-foreground block font-bold">
                No active matches scheduled yet
              </span>
              <p className="text-xs text-muted-foreground mt-1">
                Matches will appear once the bracket draw is completed and courts are dispatched by the desk.
              </p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {teamMatches.map((m) => {
                const isLive = m.status === "live";
                const isFinal = m.status === "final";
                const wonThis = isFinal && (m.scoreOur ?? 0) > (m.scoreOpp ?? 0);
                const lostThis = isFinal && (m.scoreOur ?? 0) < (m.scoreOpp ?? 0);

                return (
                  <li
                    key={m.id}
                    className={`surface-card p-3.5 border rounded flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 transition-colors ${
                      isLive
                        ? "border-pickle bg-pickle/5 shadow"
                        : wonThis
                        ? "border-pickle/40"
                        : lostThis
                        ? "border-brick/40"
                        : "border-border"
                    }`}
                  >
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-mono">
                          {m.stage}
                        </span>
                        <span className="text-muted-foreground text-xs">&middot;</span>
                        <span className="text-[0.65rem] font-bold text-foreground font-mono">
                          {m.court === "Queue" ? "Queue (Standby)" : m.court}
                        </span>
                      </div>

                      <div className="text-sm font-semibold text-foreground flex items-center gap-2">
                        <span>vs. {m.opponentName}</span>
                        {m.opponentPlayers.length > 0 && (
                          <span className="text-xs text-muted-foreground font-normal truncate hidden sm:inline">
                            ({m.opponentPlayers.join(" & ")})
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Status & Scores */}
                    <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                      {isLive ? (
                        <div className="flex items-center gap-3">
                          <span className="font-display text-2xl text-pickle font-bold tracking-wider">
                            {m.scoreOur ?? 0} &ndash; {m.scoreOpp ?? 0}
                          </span>
                          <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-pickle/20 text-pickle border border-pickle/40 rounded flex items-center gap-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-ping" />
                            Live
                          </span>
                          {onViewLiveCourts && (
                            <button
                              onClick={() => {
                                onClose();
                                onViewLiveCourts(m.court);
                              }}
                              className="px-2.5 py-1 text-xs font-bold uppercase tracking-wider bg-pickle text-sand rounded hover:opacity-90 transition-opacity cursor-pointer"
                            >
                              Watch &rarr;
                            </button>
                          )}
                        </div>
                      ) : isFinal ? (
                        <div className="flex items-center gap-2">
                          <span className="font-display text-xl text-foreground font-bold">
                            {m.scoreOur ?? 0} &ndash; {m.scoreOpp ?? 0}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider rounded ${
                              wonThis
                                ? "bg-pickle/20 text-pickle border border-pickle/40"
                                : "bg-brick/20 text-brick border border-brick/40"
                            }`}
                          >
                            {wonThis ? "Won" : "Lost"}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[0.65rem] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-muted/50 border border-border text-muted-foreground">
                          Scheduled
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-3 sm:p-4 border-t border-border bg-charcoal/30 flex items-center justify-between text-xs">
          <span className="text-[0.65rem] text-muted-foreground uppercase tracking-widest font-mono">
            Dink Valley Tournament Desk
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 border border-border bg-card text-foreground font-semibold uppercase tracking-wider text-xs hover:border-pickle transition-colors cursor-pointer rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
