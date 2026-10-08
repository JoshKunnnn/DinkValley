import { useMemo, useState } from "react";
import type { Team } from "@/data/tournaments";

export type FinishedMatchResult = {
  key: string;
  round?: string | null | undefined;
  teamAName: string;
  teamBName: string;
  teamA?: Team | null | undefined;
  teamB?: Team | null | undefined;
  scoreA: number;
  scoreB: number;
  winnerName: string;
  court?: string | null | undefined;
  stage?: string | null | undefined;
};

interface FinalResultsViewProps {
  results: FinishedMatchResult[];
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
  title?: string | undefined;
  emptyMessage?: string | undefined;
}

function formatCourtName(court?: string | null): string | null {
  if (!court || court.toLowerCase() === "queue") return null;
  const num = court.replace(/[^0-9]/g, "");
  return num ? `Court ${num}` : court;
}

export function FinalResultsView({
  results,
  highlightTeam,
  onTeamTap,
  title = "Final Match Results",
  emptyMessage = "No matches have finished yet. Completed game results will show here.",
}: FinalResultsViewProps) {
  const [filterQuery, setFilterQuery] = useState("");

  const filteredResults = useMemo(() => {
    if (!filterQuery.trim()) return results;
    const q = filterQuery.trim().toLowerCase();
    return results.filter(
      (r) =>
        r.teamAName.toLowerCase().includes(q) ||
        r.teamBName.toLowerCase().includes(q) ||
        r.winnerName.toLowerCase().includes(q)
    );
  }, [results, filterQuery]);

  if (results.length === 0) {
    return (
      <div className="surface-card p-6 sm:p-8 border-2 border-border rounded-2xl text-center space-y-2">
        <span className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground block">
          Match Results
        </span>
        <h4 className="font-display text-xl sm:text-2xl text-foreground">
          {title}
        </h4>
        <p className="text-sm text-foreground/75 max-w-md mx-auto">
          {emptyMessage}
        </p>
      </div>
    );
  }

  return (
    <div className="surface-card p-4 sm:p-5 border-2 border-border rounded-2xl space-y-4">
      {/* Header with Title and Search Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/80 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-pickle" />
            <h4 className="font-display text-xl sm:text-2xl text-foreground">
              {title}
            </h4>
            <span className="px-2 py-0.5 text-xs font-mono font-bold bg-charcoal text-sand rounded">
              {results.length} {results.length === 1 ? "Result" : "Results"}
            </span>
          </div>
          <p className="text-xs text-foreground/70 mt-0.5">
            Official confirmed match outcomes and final scores.
          </p>
        </div>

        {results.length > 3 && (
          <div className="w-full sm:w-64">
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Search by team..."
              aria-label="Search results by team"
              className="w-full px-3 py-2 text-xs rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground focus:border-pickle focus:outline-none"
            />
          </div>
        )}
      </div>

      {/* Results Cards List */}
      <div className="space-y-3">
        {filteredResults.map((r) => {
          const isHighlight =
            Boolean(highlightTeam) &&
            (r.teamAName === highlightTeam || r.teamBName === highlightTeam);
          const isWinnerA = r.winnerName === r.teamAName;
          const isWinnerB = r.winnerName === r.teamBName;
          const margin = Math.abs(r.scoreA - r.scoreB);
          const formattedCourt = formatCourtName(r.court);

          return (
            <div
              key={r.key}
              className={`p-3.5 sm:p-4 rounded-xl border-2 transition-all ${
                isHighlight
                  ? "border-pickle bg-pickle/15 ring-2 ring-pickle/40"
                  : "border-border/80 bg-background hover:border-pickle/50"
              }`}
            >
              {/* Meta row: Stage/Round, Court badge, and Margin summary */}
              <div className="flex items-center justify-between text-xs mb-2.5 gap-2">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand rounded font-mono">
                    Final Result
                  </span>
                  {r.round && (
                    <span className="text-[0.7rem] uppercase font-mono text-muted-foreground">
                      {r.round}
                    </span>
                  )}
                </div>

                {formattedCourt && (
                  <span className="px-2.5 py-0.5 text-xs font-mono font-bold uppercase tracking-wider bg-pickle/20 border border-pickle/40 text-pickle rounded">
                    {formattedCourt}
                  </span>
                )}
              </div>

              {/* Main Score & Teams Grid */}
              <div className="space-y-2">
                {/* Team A */}
                <div
                  onClick={() => r.teamA && onTeamTap?.(r.teamA)}
                  className={`flex items-center justify-between gap-3 p-2.5 rounded-lg transition-colors ${
                    isWinnerA
                      ? "bg-pickle/20 border border-pickle/40 font-bold"
                      : "bg-card border border-transparent"
                  } ${r.teamA ? "cursor-pointer hover:bg-pickle/10" : ""}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isWinnerA && (
                      <span className="px-2 py-0.5 rounded text-[0.65rem] font-bold uppercase tracking-wider bg-pickle text-sand font-mono shrink-0">
                        Winner
                      </span>
                    )}
                    <span
                      className={`text-sm sm:text-base truncate ${
                        isWinnerA ? "text-pickle font-bold" : "text-foreground/75"
                      }`}
                    >
                      {r.teamAName}
                    </span>
                  </div>
                  <span
                    className={`font-display text-xl sm:text-2xl font-bold shrink-0 ${
                      isWinnerA ? "text-pickle" : "text-foreground/75"
                    }`}
                  >
                    {r.scoreA}
                  </span>
                </div>

                {/* Team B */}
                <div
                  onClick={() => r.teamB && onTeamTap?.(r.teamB)}
                  className={`flex items-center justify-between gap-3 p-2.5 rounded-lg transition-colors ${
                    isWinnerB
                      ? "bg-pickle/20 border border-pickle/40 font-bold"
                      : "bg-card border border-transparent"
                  } ${r.teamB ? "cursor-pointer hover:bg-pickle/10" : ""}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {isWinnerB && (
                      <span className="px-2 py-0.5 rounded text-[0.65rem] font-bold uppercase tracking-wider bg-pickle text-sand font-mono shrink-0">
                        Winner
                      </span>
                    )}
                    <span
                      className={`text-sm sm:text-base truncate ${
                        isWinnerB ? "text-pickle font-bold" : "text-foreground/75"
                      }`}
                    >
                      {r.teamBName}
                    </span>
                  </div>
                  <span
                    className={`font-display text-xl sm:text-2xl font-bold shrink-0 ${
                      isWinnerB ? "text-pickle" : "text-foreground/75"
                    }`}
                  >
                    {r.scoreB}
                  </span>
                </div>
              </div>

              {/* Friendly summary line */}
              <div className="mt-2.5 pt-2 border-t border-border/50 flex items-center justify-between text-[0.7rem] text-muted-foreground font-mono">
                <span>
                  {r.winnerName} won by {margin} {margin === 1 ? "point" : "points"}
                </span>
                <span>Final Score: {Math.max(r.scoreA, r.scoreB)} - {Math.min(r.scoreA, r.scoreB)}</span>
              </div>
            </div>
          );
        })}

        {filteredResults.length === 0 && (
          <div className="p-6 text-center text-xs text-muted-foreground">
            No results matching "{filterQuery}"
          </div>
        )}
      </div>
    </div>
  );
}
