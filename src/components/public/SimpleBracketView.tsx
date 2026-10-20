import { useEffect, useMemo, useRef, useState } from "react";
import type { Category, Team } from "@/data/tournaments";
import { findLiveMatchForTeams, generateBalancedRoundRobinPairs, type LiveMatch } from "@/lib/match-store";
import type { BracketGroup } from "@/components/admin/BracketDraw";
import type { KnockoutMatch } from "@/components/admin/DrawsManager";
import { UpNextSlider } from "./UpNextSlider";
import { FinalResultsView } from "./FinalResultsView";

type MatchStatusKind = "playing" | "next" | "done";

type SimpleMatchItem = {
  key: string;
  round?: string;
  teamAName: string;
  teamBName: string;
  teamA?: Team | null;
  teamB?: Team | null;
  status: MatchStatusKind;
  scoreA: number;
  scoreB: number;
  court: string | null;
  statusText: string;
  winnerName: string | null;
};

function formatCourtName(court?: string | null): string | null {
  if (!court || court.toLowerCase() === "queue") return null;
  const num = court.replace(/[^0-9]/g, "");
  return num ? `Court ${num}` : court;
}

/**
 * Step 3: Simplified mobile-first bracket viewer.
 * 1. One group at a time (Bracket A, B, C...) with swipe & simple "Top 2 Advance" standings.
 * 2. Mobile-first match cards by round for Finals (Semifinals -> Finals -> Champion Spotlight).
 * 3. Prominent 'Find My Team / Player' spotlight at the top.
 */
export function SimpleBracketView({
  category,
  matches,
  drawnGroups,
  mainDrawMatches,
  highlightTeam,
  onTeamTap,
  onClearHighlight,
}: {
  category: Category;
  matches: LiveMatch[];
  drawnGroups: BracketGroup[] | null;
  mainDrawMatches?: KnockoutMatch[] | null;
  highlightTeam?: string | null;
  onTeamTap?: (team: Team) => void;
  onClearHighlight?: () => void;
}) {
  const groups = useMemo(() => {
    if (!drawnGroups || drawnGroups.length === 0) return [];
    return drawnGroups.filter(
      (g) => g.isDrawn || g.slots.some((s) => s.team !== null)
    );
  }, [drawnGroups]);

  // Section list: Groups A, B, C... + Playoffs / Finals if present
  const sections = useMemo(() => {
    const list: Array<{
      id: string;
      title: string;
      subtitle: string;
      isPlayoff: boolean;
      groupIndex?: number;
    }> = [];

    groups.forEach((g, idx) => {
      list.push({
        id: `group-${g.letter}`,
        title: `Bracket ${g.letter}`,
        subtitle: `Group ${idx + 1} of ${groups.length}`,
        isPlayoff: false,
        groupIndex: idx,
      });
    });

    if (mainDrawMatches && mainDrawMatches.length > 0) {
      list.push({
        id: "playoffs",
        title: "Championship Finals",
        subtitle: "Single Elimination Playoffs",
        isPlayoff: true,
      });
    }

    return list;
  }, [groups, mainDrawMatches]);

  const [activeIdx, setActiveIdx] = useState(0);

  // Reset to first group when category changes
  useEffect(() => {
    setActiveIdx(0);
  }, [category.id]);

  // Jump to group containing highlighted team
  useEffect(() => {
    if (!highlightTeam) return;
    const targetGroupIndex = groups.findIndex((g) =>
      g.slots.some((s) => s.team?.name === highlightTeam)
    );
    if (targetGroupIndex >= 0) {
      setActiveIdx(targetGroupIndex);
    }
  }, [highlightTeam, groups]);

  const safeIdx = Math.min(activeIdx, Math.max(0, sections.length - 1));
  const currentSection = sections[safeIdx];

  // Touch swipe support
  const touchStartX = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const endX = e.changedTouches[0]?.clientX ?? touchStartX.current;
    const diff = endX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(diff) < 50) return;
    if (diff < 0) goNext();
    else goPrev();
  };

  const goPrev = () => setActiveIdx((i) => Math.max(0, i - 1));
  const goNext = () => setActiveIdx((i) => Math.min(sections.length - 1, i + 1));

  // Determine active champion if playoff finals match is finished
  const tournamentChampion = useMemo(() => {
    if (!mainDrawMatches || mainDrawMatches.length === 0) return null;
    const finalMatch = mainDrawMatches.find((m) => m.round === "Final");
    if (!finalMatch) return null;
    return finalMatch.winner?.name ?? null;
  }, [mainDrawMatches]);

  // Build match items for the active section
  const { matchItems, standings, roundsMap } = useMemo(() => {
    if (!currentSection) {
      return { matchItems: [] as SimpleMatchItem[], standings: [], roundsMap: new Map<string, SimpleMatchItem[]>() };
    }

    // Playoff / Finals section
    if (currentSection.isPlayoff && mainDrawMatches) {
      const items: SimpleMatchItem[] = mainDrawMatches.map((m) => {
        const teamAName = m.teamA?.name ?? (m.seedA ? `Seed ${m.seedA}` : "TBD");
        const teamBName = m.teamB?.name ?? (m.seedB ? `Seed ${m.seedB}` : "TBD");
        const live = matches.find(
          (lm) =>
            lm.status === "live" &&
            ((lm.teamAName === teamAName && lm.teamBName === teamBName) ||
              (lm.teamAName === teamBName && lm.teamBName === teamAName))
        );
        const isLive = Boolean(live);
        const isDone =
          Boolean(m.winner) ||
          (typeof m.scoreA === "number" && typeof m.scoreB === "number" && (m.scoreA > 0 || m.scoreB > 0));
        const rawCourt = live?.court ?? (m.court && m.court !== "Queue" ? m.court : null);
        const court = formatCourtName(rawCourt);

        let statusText = "Up Next";
        let statusKind: MatchStatusKind = "next";
        let winnerName: string | null = m.winner?.name ?? null;

        if (isLive) {
          statusKind = "playing";
          statusText = court ? `Live on ${court}` : "Playing Now";
        } else if (isDone) {
          statusKind = "done";
          statusText = winnerName ? `Done - ${winnerName} won` : "Finished";
        }

        return {
          key: m.id,
          round: m.round,
          teamAName,
          teamBName,
          teamA: m.teamA ?? null,
          teamB: m.teamB ?? null,
          status: statusKind,
          scoreA: m.scoreA ?? (live ? live.score.teamAScore : 0),
          scoreB: m.scoreB ?? (live ? live.score.teamBScore : 0),
          court,
          statusText,
          winnerName,
        };
      });

      // Group playoff items by round order
      const rounds = new Map<string, SimpleMatchItem[]>();
      const roundOrder = ["Round of 16", "Quarterfinal", "Semifinal", "Bronze", "Final"];
      roundOrder.forEach((rName) => {
        const matchesForRound = items.filter((x) => x.round === rName);
        if (matchesForRound.length > 0) {
          rounds.set(rName, matchesForRound);
        }
      });

      return { matchItems: items, standings: [], roundsMap: rounds };
    }

    // Round-robin pool group section
    const currentGroup = groups[currentSection.groupIndex ?? 0];
    if (!currentGroup) return { matchItems: [], standings: [], roundsMap: new Map() };

    const teams = currentGroup.slots
      .map((s) => s.team)
      .filter((t): t is Team => t !== null);

    const categoryTeams = category?.teams || [];
    const items: SimpleMatchItem[] = [];
    const tableMap = new Map<
      string,
      {
        name: string;
        w: number;
        l: number;
        pd: number;
        team?: Team | undefined;
        players?: string[] | undefined;
        club?: string | undefined;
      }
    >();

    teams.forEach((t) => {
      const fullTeam =
        categoryTeams.find(
          (ct) => ct.id === t.id || ct.name.toLowerCase() === t.name.toLowerCase()
        ) || t;
      tableMap.set(t.name, {
        name: t.name,
        w: 0,
        l: 0,
        pd: 0,
        team: fullTeam,
        players: fullTeam.players,
        club: fullTeam.club,
      });
    });

    const pairs = generateBalancedRoundRobinPairs(teams);
    pairs.forEach(([a, b], pIdx) => {
      const teamAModel =
        categoryTeams.find(
          (ct) => ct.id === a.id || ct.name.toLowerCase() === a.name.toLowerCase()
        ) || a;
      const teamBModel =
        categoryTeams.find(
          (ct) => ct.id === b.id || ct.name.toLowerCase() === b.name.toLowerCase()
        ) || b;

      const live = findLiveMatchForTeams(matches, a.name, b.name);
      const flipped = live ? live.teamAName !== a.name : false;
      const scoreA = live ? (flipped ? live.score.teamBScore : live.score.teamAScore) : 0;
      const scoreB = live ? (flipped ? live.score.teamAScore : live.score.teamBScore) : 0;
      const rawCourt = live && live.court && live.court !== "Queue" ? live.court : null;
      const court = formatCourtName(rawCourt);

      let statusKind: MatchStatusKind = "next";
      let statusText = "Up Next";
      let winnerName: string | null = null;

      if (live?.status === "live") {
        statusKind = "playing";
        statusText = court ? `Live on ${court}` : "Playing Now";
      } else if (live?.status === "final") {
        statusKind = "done";
        winnerName = live.winnerTeam ?? (scoreA > scoreB ? a.name : scoreB > scoreA ? b.name : null);
        statusText = winnerName ? `Done - ${winnerName} won` : "Finished";
      }

      if (statusKind === "done") {
        const statsA = tableMap.get(a.name);
        const statsB = tableMap.get(b.name);
        if (statsA && statsB) {
          if (scoreA > scoreB) {
            statsA.w += 1;
            statsB.l += 1;
          } else if (scoreB > scoreA) {
            statsB.w += 1;
            statsA.l += 1;
          }
          statsA.pd += scoreA - scoreB;
          statsB.pd += scoreB - scoreA;
        }
      }

      items.push({
        key: `${currentGroup.letter}-${a.id}-${b.id}-${pIdx}`,
        teamAName: a.name,
        teamBName: b.name,
        teamA: teamAModel,
        teamB: teamBModel,
        status: statusKind,
        scoreA,
        scoreB,
        court,
        statusText,
        winnerName,
      });
    });

    const sortedStandings = [...tableMap.values()].sort((x, y) => y.w - x.w || y.pd - x.pd);
    return { matchItems: items, standings: sortedStandings, roundsMap: new Map() };
  }, [currentSection, groups, matches, mainDrawMatches]);

  if (sections.length === 0 || !currentSection) {
    const teamCount = category.teams?.length ?? 0;
    return (
      <div className="rounded-2xl border-2 border-border bg-card p-6 sm:p-10 text-center">
        <span className="block text-xs font-bold uppercase tracking-[0.2em] text-pickle">
          Brackets In Preparation
        </span>
        <h3 className="mt-2 font-display text-2xl sm:text-3xl text-foreground">
          Brackets Have Not Been Drawn Yet
        </h3>
        <p className="mt-2 text-sm sm:text-base text-foreground/75 max-w-md mx-auto">
          Tournament officials will draw the brackets soon. This page refreshes automatically.
        </p>
        <div className="mt-4 inline-block px-3 py-1 bg-charcoal border border-border rounded text-xs font-mono text-sand">
          {teamCount} {teamCount === 1 ? "team" : "teams"} registered
        </div>
      </div>
    );
  }

  const playingMatches = matchItems.filter((m) => m.status === "playing");
  const upcomingMatches = matchItems.filter((m) => m.status === "next");
  const finishedMatches = matchItems.filter((m) => m.status === "done");
  const isBracketDone = matchItems.length > 0 && finishedMatches.length === matchItems.length;

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="space-y-5 select-none"
    >
      {/* ── Highlighted Team Spotlight Banner ── */}
      {highlightTeam && (
        <div className="p-4 sm:p-5 rounded-2xl border-2 border-pickle bg-pickle/15 flex items-center justify-between gap-3 animate-in fade-in">
          <div className="min-w-0">
            <span className="block text-[0.65rem] font-bold uppercase tracking-[0.2em] text-pickle">
              Spotlight Player &middot; Team Focus
            </span>
            <span className="font-display text-xl sm:text-2xl text-foreground block truncate mt-0.5">
              {highlightTeam}
            </span>
            <span className="text-xs text-foreground/75 block">
              Showing matches and bracket standing for this team.
            </span>
          </div>
          {onClearHighlight && (
            <button
              type="button"
              onClick={onClearHighlight}
              className="px-3 py-1.5 rounded-xl border border-border bg-card text-xs font-bold uppercase tracking-wider text-foreground hover:border-pickle cursor-pointer shrink-0"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* ── Section selector pills (Bracket A, B, Finals) ── */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
        {sections.map((s, idx) => {
          const isSelected = idx === safeIdx;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveIdx(idx)}
              className={`min-h-[3rem] px-4 py-2 rounded-xl font-display text-base sm:text-lg transition-all shrink-0 cursor-pointer border-2 ${
                isSelected
                  ? "border-pickle bg-pickle text-sand font-bold shadow-sm"
                  : "border-border bg-card text-foreground/80 hover:border-pickle"
              }`}
            >
              {s.title}
            </button>
          );
        })}
      </div>

      {/* ── Group Header with Next / Prev buttons ── */}
      <div className="surface-card p-4 sm:p-5 border-2 border-border rounded-2xl flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={goPrev}
          disabled={safeIdx === 0}
          className={`min-h-[3rem] px-3.5 py-2 rounded-xl border-2 text-xs sm:text-sm font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 shrink-0 ${
            safeIdx === 0
              ? "opacity-30 border-border bg-background cursor-not-allowed text-muted-foreground"
              : "border-border bg-card text-foreground hover:border-pickle cursor-pointer"
          }`}
          aria-label="Previous bracket group"
        >
          <span>&larr;</span>
          <span className="hidden sm:inline">Previous</span>
        </button>

        <div className="text-center min-w-0 flex-1">
          <span className="block text-xs font-bold uppercase tracking-[0.2em] text-pickle">
            {currentSection.subtitle}
          </span>
          <h3 className="font-display text-2xl sm:text-3xl text-foreground truncate mt-0.5">
            {currentSection.title}
          </h3>
        </div>

        <button
          type="button"
          onClick={goNext}
          disabled={safeIdx >= sections.length - 1}
          className={`min-h-[3rem] px-3.5 py-2 rounded-xl border-2 text-xs sm:text-sm font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 shrink-0 ${
            safeIdx >= sections.length - 1
              ? "opacity-30 border-border bg-background cursor-not-allowed text-muted-foreground"
              : "border-border bg-card text-foreground hover:border-pickle cursor-pointer"
          }`}
          aria-label="Next bracket group"
        >
          <span className="hidden sm:inline">Next</span>
          <span>&rarr;</span>
        </button>
      </div>

      {/* ── PLAYOFFS VIEW: Round by Round ── */}
      {currentSection.isPlayoff ? (
        <div className="space-y-6">
          {/* Champion Crown Banner if Final is completed */}
          {tournamentChampion && (
            <div className="surface-card p-6 border-2 border-pickle bg-pickle/15 rounded-2xl text-center space-y-1 shadow-md">
              <span className="text-xs font-bold uppercase tracking-[0.24em] text-pickle block">
                Tournament Champion
              </span>
              <h4 className="text-3xl sm:text-4xl font-display text-foreground font-bold">
                {tournamentChampion}
              </h4>
              <p className="text-xs sm:text-sm text-foreground/75">
                Official {category.label} Division Champions
              </p>
            </div>
          )}

          {/* Group playoff matches by round */}
          {Array.from(roundsMap.entries()).map(([roundTitle, roundMatches]) => {
            const isFinalRound = roundTitle === "Final";
            return (
              <div key={roundTitle} className="space-y-3">
                <div className="flex items-center justify-between border-b border-border pb-1.5">
                  <span className="font-display text-xl sm:text-2xl text-foreground">
                    {roundTitle === "Final"
                      ? "Championship Final"
                      : roundTitle === "Bronze"
                        ? "Bronze Medal Match (3rd Place)"
                        : roundTitle}
                  </span>
                  <span className="text-xs uppercase font-mono tracking-wider text-muted-foreground">
                    {roundMatches.length} {roundMatches.length === 1 ? "match" : "matches"}
                  </span>
                </div>

                <div className="space-y-2.5">
                  {roundMatches.map((m: SimpleMatchItem) => renderMatchCard(m, highlightTeam, onTeamTap, isFinalRound))}
                </div>
              </div>
            );
          })}

          {matchItems.length === 0 && (
            <div className="p-8 text-center bg-card rounded-2xl border-2 border-border text-foreground/70 text-sm">
              Playoff matches will be scheduled after pool play concludes.
            </div>
          )}
        </div>
      ) : (
        /* ── ROUND-ROBIN GROUP VIEW ── */
        <div className="space-y-5">
          {/* Standings Summary Box with 'Top 2 Advance' Badges */}
          {standings.length > 0 && (
            <div className="surface-card p-4 sm:p-5 border-2 border-border rounded-2xl">
              <div className="flex items-center justify-between pb-3 border-b border-border">
                <div>
                  <h4 className="font-display text-xl sm:text-2xl text-foreground">
                    {currentSection.title} Standings
                  </h4>
                  <p className="text-xs text-foreground/70 mt-0.5">
                    {isBracketDone
                      ? "Group play concluded. Top 2 teams advance to Championship Finals."
                      : "Top 2 teams advance once all group matches conclude."}
                  </p>
                </div>
                <div className="flex items-center gap-3 sm:gap-4 text-xs uppercase tracking-wider font-mono text-muted-foreground shrink-0">
                  <span className="w-14 text-center">W - L</span>
                  <span className="w-12 text-right">DIFF</span>
                </div>
              </div>

              <div className="mt-3 divide-y divide-border/60">
                {standings.map((team, rank) => {
                  const isHighlight = highlightTeam === team.name;
                  const isAdvancing = isBracketDone && rank < 2;

                  return (
                    <div
                      key={team.name}
                      className={`py-3 flex items-center justify-between gap-3 text-sm sm:text-base ${
                        isHighlight ? "bg-pickle/15 px-3 rounded-xl font-bold" : ""
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span
                          className={`w-6 h-6 rounded-full flex items-center justify-center font-mono text-xs font-bold ${
                            isAdvancing
                              ? "bg-pickle text-sand"
                              : "bg-charcoal text-sand"
                          }`}
                        >
                          #{rank + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-foreground truncate block">
                              {team.name}
                            </span>
                            {isAdvancing && (
                              <span className="text-[0.65rem] font-mono px-1.5 py-0.5 rounded bg-pickle/20 text-pickle border border-pickle/30 font-bold shrink-0">
                                Seed {rank + 1}
                              </span>
                            )}
                          </div>
                          {((team.players && team.players.length > 0) || team.club) && (
                            <div className="flex items-center gap-1.5 text-xs text-foreground/80 truncate mt-0.5 font-normal">
                              {team.players && team.players.length > 0 && (
                                <span className="truncate">{team.players.join(" & ")}</span>
                              )}
                              {team.club && (
                                <>
                                  <span className="text-muted-foreground/50 shrink-0">•</span>
                                  <span className="text-[0.65rem] px-1.5 py-0.2 rounded bg-charcoal text-sand border border-white/20 shrink-0 font-bold">
                                    {team.club}
                                  </span>
                                </>
                              )}
                            </div>
                          )}
                          {isAdvancing && (
                            <span className="text-[0.65rem] font-bold uppercase tracking-wider text-pickle block mt-0.5">
                              Advances to Finals
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 sm:gap-4 font-mono text-xs sm:text-sm shrink-0">
                        <div className="w-14 flex items-center justify-center gap-1.5">
                          <span className="text-pickle font-bold">{team.w}W</span>
                          <span className="text-foreground/80 font-bold">{team.l}L</span>
                        </div>
                        <span
                          className={`w-12 text-right font-bold ${
                            team.pd > 0
                              ? "text-pickle"
                              : team.pd < 0
                                ? "text-red-400"
                                : "text-foreground/80 font-bold"
                          }`}
                        >
                          {team.pd > 0 ? `+${team.pd}` : team.pd}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Matches Container for Pool Play */}
          <div className="space-y-4">
            {/* Playing Now Section */}
            {playingMatches.length > 0 && (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-pickle animate-pulse" />
                  <span className="text-xs font-bold uppercase tracking-[0.2em] text-pickle">
                    Live Court Action
                  </span>
                </div>
                <div className="space-y-2.5">
                  {playingMatches.map((m) => renderMatchCard(m, highlightTeam, onTeamTap))}
                </div>
              </div>
            )}

            {/* Up Next Section as a Compact Horizontal Slider */}
            {upcomingMatches.length > 0 && (
              <UpNextSlider
                title={`${currentSection.title} Up Next`}
                matches={upcomingMatches.map((m, idx) => ({
                  key: m.key,
                  orderNumber: idx + 1,
                  teamAName: m.teamAName,
                  teamBName: m.teamBName,
                  teamA: m.teamA,
                  teamB: m.teamB,
                  teamAPlayers: m.teamA?.players,
                  teamAClub: m.teamA?.club,
                  teamBPlayers: m.teamB?.players,
                  teamBClub: m.teamB?.club,
                  court: m.court,
                  round: m.round,
                }))}
                highlightTeam={highlightTeam}
                onTeamTap={onTeamTap}
              />
            )}

            {/* Final Match Results */}
            {finishedMatches.length > 0 && (
              <FinalResultsView
                title={`${currentSection.title} Match Results`}
                results={finishedMatches.map((m) => ({
                  key: m.key,
                  round: m.round,
                  teamAName: m.teamAName,
                  teamBName: m.teamBName,
                  teamA: m.teamA,
                  teamB: m.teamB,
                  teamAPlayers: m.teamA?.players,
                  teamAClub: m.teamA?.club,
                  teamBPlayers: m.teamB?.players,
                  teamBClub: m.teamB?.club,
                  scoreA: m.scoreA,
                  scoreB: m.scoreB,
                  winnerName: m.winnerName || (m.scoreA > m.scoreB ? m.teamAName : m.teamBName),
                  court: m.court,
                }))}
                highlightTeam={highlightTeam}
                onTeamTap={onTeamTap}
              />
            )}

            {matchItems.length === 0 && (
              <div className="p-8 text-center bg-card rounded-2xl border-2 border-border text-foreground/70 text-sm">
                No matches scheduled for this bracket yet.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function renderMatchCard(
  m: SimpleMatchItem,
  highlightTeam?: string | null,
  onTeamTap?: (team: Team) => void,
  isChampionshipFinal?: boolean
) {
  const isHighlight =
    Boolean(highlightTeam) &&
    (m.teamAName === highlightTeam || m.teamBName === highlightTeam);
  const formattedCourt = formatCourtName(m.court);

  return (
    <div
      key={m.key}
      className={`rounded-2xl border-2 p-4 sm:p-5 bg-card transition-all ${
        isHighlight
          ? "border-pickle bg-pickle/10 ring-2 ring-pickle/40"
          : isChampionshipFinal
            ? "border-pickle/80 shadow-md"
            : m.status === "playing"
              ? "border-pickle shadow-sm"
              : "border-border hover:border-pickle/50"
      }`}
    >
      {/* Top Status & Court Pill */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-bold uppercase tracking-wider ${
            m.status === "playing"
              ? "bg-pickle text-sand font-bold shadow-sm"
              : m.status === "done"
                ? "bg-charcoal text-sand/80 border border-border"
                : "bg-foreground/10 text-foreground/70"
          }`}
        >
          {m.status === "playing" && (
            <span className="h-2 w-2 rounded-full bg-sand animate-pulse" />
          )}
          <span>{m.statusText}</span>
        </span>

        {formattedCourt && (
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono font-bold uppercase tracking-wider rounded-lg border ${
              m.status === "playing"
                ? "bg-pickle text-sand border-pickle shadow-sm"
                : "bg-card border-border text-pickle"
            }`}
          >
            {m.status === "playing" && (
              <span className="h-1.5 w-1.5 rounded-full bg-sand animate-ping" />
            )}
            {formattedCourt}
          </span>
        )}
      </div>

      {/* Teams and Scores */}
      <div className="space-y-2">
        {/* Team A */}
        <div
          onClick={() => m.teamA && onTeamTap?.(m.teamA)}
          className={`flex items-center justify-between gap-3 p-2.5 rounded-xl transition-colors ${
            m.winnerName === m.teamAName
              ? "bg-pickle/20 border border-pickle/40 font-bold"
              : "bg-background border border-transparent"
          } ${m.teamA ? "cursor-pointer hover:bg-pickle/10" : ""}`}
        >
          <div className="min-w-0">
            <span
              className={`text-base sm:text-lg truncate block ${
                m.winnerName === m.teamAName
                  ? "text-pickle font-bold"
                  : m.status === "done" && m.winnerName && m.winnerName !== m.teamAName
                    ? "text-foreground/75 font-semibold"
                    : "text-foreground font-semibold"
              }`}
            >
              {m.teamAName}
            </span>
            {((m.teamA?.players && m.teamA.players.length > 0) || m.teamA?.club) && (
              <div className="flex items-center gap-1.5 text-xs text-foreground/80 truncate mt-0.5 font-normal">
                {m.teamA?.players && m.teamA.players.length > 0 && (
                  <span className="truncate">{m.teamA.players.join(" & ")}</span>
                )}
                {m.teamA?.club && (
                  <>
                    <span className="text-muted-foreground/50 shrink-0">•</span>
                    <span className="text-[0.65rem] px-1.5 py-0.2 rounded bg-charcoal text-sand border border-white/20 shrink-0 font-bold">
                      {m.teamA.club}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
          <span className="font-display text-xl sm:text-2xl text-foreground font-bold shrink-0">
            {m.status === "next" ? "-" : m.scoreA}
          </span>
        </div>

        {/* Team B */}
        <div
          onClick={() => m.teamB && onTeamTap?.(m.teamB)}
          className={`flex items-center justify-between gap-3 p-2.5 rounded-xl transition-colors ${
            m.winnerName === m.teamBName
              ? "bg-pickle/20 border border-pickle/40 font-bold"
              : "bg-background border border-transparent"
          } ${m.teamB ? "cursor-pointer hover:bg-pickle/10" : ""}`}
        >
          <div className="min-w-0">
            <span
              className={`text-base sm:text-lg truncate block ${
                m.winnerName === m.teamBName
                  ? "text-pickle font-bold"
                  : m.status === "done" && m.winnerName && m.winnerName !== m.teamBName
                    ? "text-foreground/75 font-semibold"
                    : "text-foreground font-semibold"
              }`}
            >
              {m.teamBName}
            </span>
            {((m.teamB?.players && m.teamB.players.length > 0) || m.teamB?.club) && (
              <div className="flex items-center gap-1.5 text-xs text-foreground/80 truncate mt-0.5 font-normal">
                {m.teamB?.players && m.teamB.players.length > 0 && (
                  <span className="truncate">{m.teamB.players.join(" & ")}</span>
                )}
                {m.teamB?.club && (
                  <>
                    <span className="text-muted-foreground/50 shrink-0">•</span>
                    <span className="text-[0.65rem] px-1.5 py-0.2 rounded bg-charcoal text-sand border border-white/20 shrink-0 font-bold">
                      {m.teamB.club}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
          <span className="font-display text-xl sm:text-2xl text-foreground font-bold shrink-0">
            {m.status === "next" ? "-" : m.scoreB}
          </span>
        </div>
      </div>
    </div>
  );
}
