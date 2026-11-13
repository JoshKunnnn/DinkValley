import { useState, useMemo } from "react";
import type { Category, Team } from "@/data/tournaments";
import {
  type LiveMatch,
  resolveMatchTeamPlayers,
  getMatchTeamDisplay,
  findMatchForPair,
  isGenericTeamName,
} from "@/lib/match-store";
import type { BracketGroup } from "@/components/admin/BracketDraw";
import type { KnockoutMatch } from "@/components/admin/DrawsManager";
import { isSameCategory } from "@/lib/supabase-service";
import { KnockoutTreeVisualizer } from "./KnockoutTreeVisualizer";
import { buildFoldBracketPlan, type FoldParticipantInput } from "@/lib/bracket-utils";
import {
  Trophy,
  ShieldCheck,
  Layers,
  Activity,
  CheckCircle2,
  Clock,
  ArrowRight,
  Sparkles,
} from "lucide-react";

export interface ProjectedSlot {
  label: string; // e.g. "1st Pool A (Seed #1)"
  seedNum: number;
  poolLetter?: string | undefined;
  poolRank?: number | undefined; // 1 or 2
  team?: Team | null | undefined;
  isLocked: boolean; // pool finished
  isProjected: boolean; // pool in progress
  pointDiff?: number | undefined;
  wins?: number | undefined;
  isBye?: boolean | undefined;
  provisionalTeamName?: string | null | undefined;
}

export interface KnockoutCardItem {
  id: string;
  round: "Round of 32" | "Round of 16" | "Quarterfinal" | "Semifinal" | "Final" | "Bronze";
  label: string;
  slotIndex?: number | undefined;
  matchNumber?: number | undefined;
  feedWinnerTo?: { matchId: string; slot: "teamA" | "teamB" } | undefined;
  slotA: ProjectedSlot;
  slotB: ProjectedSlot;
  court?: string | null | undefined;
  status: "live" | "final" | "scheduled" | "projected" | "bye";
  scoreA?: number | null | undefined;
  scoreB?: number | null | undefined;
  winnerTeamName?: string | null | undefined;
  advancesTo?: string | null | undefined;
}

interface KnockoutBracketListViewProps {
  category: Category;
  matches: LiveMatch[];
  drawnGroups: BracketGroup[] | null;
  mainDrawMatches?: KnockoutMatch[] | null | undefined;
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
  onSwitchToPools?: (() => void) | undefined;
}

export function KnockoutBracketListView({
  category,
  matches,
  drawnGroups,
  mainDrawMatches,
  highlightTeam,
  onTeamTap,
  onSwitchToPools,
}: KnockoutBracketListViewProps) {
  const [viewMode, setViewMode] = useState<"cards" | "tree">("tree");
  const [selectedRoundFilter, setSelectedRoundFilter] = useState<string>("all");

  const groups = useMemo(() => {
    if (!drawnGroups || drawnGroups.length === 0) return [];
    return drawnGroups.filter(
      (g) => g.isDrawn || g.slots.some((s) => s.team !== null)
    );
  }, [drawnGroups]);

  // Compute pool standings & qualifiers dynamically from pool play matches
  const { poolStandingsMap, poolCompletionMap, isAllRoundRobinComplete, rankedQualifiers } = useMemo(() => {
    const standingsMap = new Map<
      string,
      Array<{
        team: Team;
        played: number;
        won: number;
        lost: number;
        pointsFor: number;
        pointsAgainst: number;
        pointDiff: number;
        rank: number;
      }>
    >();
    const completionMap = new Map<string, boolean>();

    groups.forEach((g) => {
      const teams = g.slots
        .map((s) => s.team)
        .filter((t): t is Team => t !== null);

      const groupMatches = matches.filter(
        (m) =>
          (m.stage?.includes(`Bracket ${g.letter}`) ||
            m.stage?.includes(`Pool ${g.letter}`) ||
            m.stage === `Bracket ${g.letter}`) &&
          (!m.categoryId || isSameCategory(m.categoryId, category.id))
      );

      const stats = new Map<
        string,
        { team: Team; played: number; won: number; lost: number; pointsFor: number; pointsAgainst: number }
      >();

      teams.forEach((t) => {
        stats.set(t.id || t.name, {
          team: t,
          played: 0,
          won: 0,
          lost: 0,
          pointsFor: 0,
          pointsAgainst: 0,
        });
      });

      let finishedCount = 0;
      groupMatches.forEach((m) => {
        const isFinal = m.status === "final" || m.score.teamAScore > 0 || m.score.teamBScore > 0;
        if (!isFinal) return;

        finishedCount++;
        const sA = m.score.teamAScore;
        const sB = m.score.teamBScore;

        const findEntry = (name: string, players?: string[]) => {
          for (const entry of stats.values()) {
            if (entry.team.name.trim().toLowerCase() === name.trim().toLowerCase()) return entry;
            if (players?.length && entry.team.players?.length) {
              const p1 = [...players].map((x) => x.trim().toLowerCase()).sort().join(",");
              const p2 = [...entry.team.players].map((x) => x.trim().toLowerCase()).sort().join(",");
              if (p1 === p2) return entry;
            }
          }
          return undefined;
        };

        const entryA = findEntry(m.teamAName, m.teamAPlayers);
        const entryB = findEntry(m.teamBName, m.teamBPlayers);

        if (entryA && entryB) {
          entryA.played++;
          entryB.played++;
          entryA.pointsFor += sA;
          entryA.pointsAgainst += sB;
          entryB.pointsFor += sB;
          entryB.pointsAgainst += sA;

          if (sA > sB) {
            entryA.won++;
            entryB.lost++;
          } else if (sB > sA) {
            entryB.won++;
            entryA.lost++;
          }
        }
      });

      const rows = Array.from(stats.values()).map((s) => ({
        team: s.team,
        played: s.played,
        won: s.won,
        lost: s.lost,
        pointsFor: s.pointsFor,
        pointsAgainst: s.pointsAgainst,
        pointDiff: s.pointsFor - s.pointsAgainst,
        rank: 1,
      }));

      // Sort by Wins desc -> Point Diff desc -> Points For desc -> Points Against asc
      rows.sort(
        (a, b) =>
          b.won - a.won ||
          b.pointDiff - a.pointDiff ||
          b.pointsFor - a.pointsFor ||
          a.pointsAgainst - b.pointsAgainst
      );

      rows.forEach((r, idx) => {
        r.rank = idx + 1;
      });

      const totalExpectedMatches = (teams.length * (teams.length - 1)) / 2;
      const isComplete = totalExpectedMatches > 0 && finishedCount >= totalExpectedMatches;

      standingsMap.set(g.letter, rows);
      completionMap.set(g.letter, isComplete);
    });

    // Collect qualifiers across all groups
    interface RawQualifier {
      team: Team;
      poolLetter: string;
      poolRank: number;
      won: number;
      lost: number;
      pointDiff: number;
      isLocked: boolean;
      isProjected: boolean;
    }

    const rawQualifiers: RawQualifier[] = [];

    // Special case for single-group round robin (e.g. 3 pairs in 1 pool)
    if (groups.length === 1) {
      const g = groups[0]!;
      const rows = standingsMap.get(g.letter) || [];
      const isComplete = completionMap.get(g.letter) || false;
      rows.forEach((r) => {
        rawQualifiers.push({
          team: r.team,
          poolLetter: g.letter,
          poolRank: r.rank,
          won: r.won,
          lost: r.lost,
          pointDiff: r.pointDiff,
          isLocked: isComplete,
          isProjected: !isComplete && r.played > 0,
        });
      });
    } else {
      // Standard multi-group: Top 2 advance from each pool
      groups.forEach((g) => {
        const rows = standingsMap.get(g.letter) || [];
        const isComplete = completionMap.get(g.letter) || false;
        rows.slice(0, 2).forEach((r) => {
          rawQualifiers.push({
            team: r.team,
            poolLetter: g.letter,
            poolRank: r.rank,
            won: r.won,
            lost: r.lost,
            pointDiff: r.pointDiff,
            isLocked: isComplete,
            isProjected: !isComplete && r.played > 0,
          });
        });
      });
    }

    // Sort winners (rank 1) and runners-up (rank 2)
    const winners = rawQualifiers.filter((q) => q.poolRank === 1);
    const runnersUp = rawQualifiers.filter((q) => q.poolRank === 2);
    const thirds = rawQualifiers.filter((q) => q.poolRank === 3);

    const comparePD = (a: RawQualifier, b: RawQualifier) =>
      b.won - a.won || b.pointDiff - a.pointDiff;

    winners.sort(comparePD);
    runnersUp.sort(comparePD);
    thirds.sort(comparePD);

    // Combine into ranked list with assigned seeds (1, 2, 3...)
    const rankedList: Array<RawQualifier & { overallSeed: number }> = [];
    let seedIdx = 1;

    if (groups.length === 1) {
      // 1 pool: seeds 1..N in direct pool standings order (up to 32)
      [...rawQualifiers]
        .sort((a, b) => a.poolRank - b.poolRank || comparePD(a, b))
        .slice(0, 32)
        .forEach((q) => {
          rankedList.push({ ...q, overallSeed: seedIdx++ });
        });
    } else {
      winners.forEach((q) => rankedList.push({ ...q, overallSeed: seedIdx++ }));
      runnersUp.forEach((q) => rankedList.push({ ...q, overallSeed: seedIdx++ }));
    }

    const isDivisionDone =
      groups.length > 0 && groups.every((g) => completionMap.get(g.letter) === true);

    return {
      poolStandingsMap: standingsMap,
      poolCompletionMap: completionMap,
      isAllRoundRobinComplete: isDivisionDone,
      rankedQualifiers: rankedList,
    };
  }, [groups, matches, category.id]);

  // Determine dynamic situational bracket layout
  const { bracketItems, bracketCapacity, isPlayoffLive, isPlayoffFinished, championName } = useMemo(() => {
    // Check if official Point Differential seeded Main Draw exists from Admin
    if (mainDrawMatches && mainDrawMatches.length > 0) {
      const koMatches = matches.filter(
        (lm) =>
          !lm.stage?.includes("Pool Play") &&
          !lm.stage?.includes("Bracket ") &&
          (!lm.categoryId || isSameCategory(lm.categoryId, category.id))
      );

      let finalChamp: string | null = null;
      let hasLive = false;
      let allDone = true;

      const normPlayers = (arr?: string[]) =>
        (arr || [])
          .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
          .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
          .filter((p) => Boolean(p) && !isGenericTeamName(p))
          .sort()
          .join("|");

      const items: KnockoutCardItem[] = mainDrawMatches.map((m) => {
        const stage = `${m.round} - ${m.label}`;
        const matched =
          m.teamA && m.teamB
            ? findMatchForPair(
                koMatches,
                m.teamA.name,
                m.teamB.name,
                undefined,
                category.id,
                stage,
                m.teamA.players,
                m.teamB.players,
              )
            : undefined;

        const isLive = matched?.status === "live";
        if (isLive) hasLive = true;

        const isFinal =
          Boolean(m.winner) ||
          matched?.status === "final" ||
          (!isLive &&
            typeof m.scoreA === "number" &&
            typeof m.scoreB === "number" &&
            (m.scoreA > 0 || m.scoreB > 0));

        if (!isFinal) allDone = false;

        let isSameOrder = true;
        if (matched && m.teamA && m.teamB) {
          const pA = normPlayers(m.teamA.players);
          const pB = normPlayers(m.teamB.players);
          const lpA = normPlayers(matched.teamAPlayers);
          const lpB = normPlayers(matched.teamBPlayers);
          const nA = m.teamA.name.replace(/\s+/g, " ").trim().toLowerCase();
          const nB = m.teamB.name.replace(/\s+/g, " ").trim().toLowerCase();
          const liveA = (matched.teamAName || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (pA && lpA && (pA !== pB || lpA !== lpB)) {
            if (pA === lpA || (pB && lpB && pB === lpB)) isSameOrder = true;
            else if (pA === lpB || (pB && pB === lpA)) isSameOrder = false;
          } else if (nA !== nB) {
            isSameOrder = liveA !== nB;
          }
        }

        const scoreA = matched
          ? isSameOrder
            ? matched.score.teamAScore
            : matched.score.teamBScore
          : (m.scoreA ?? null);
        const scoreB = matched
          ? isSameOrder
            ? matched.score.teamBScore
            : matched.score.teamAScore
          : (m.scoreB ?? null);

        const dispTeamA = m.teamA ? getMatchTeamDisplay(m.teamA.name, m.teamA.players, m.teamA.name) : null;
        const dispTeamB = m.teamB ? getMatchTeamDisplay(m.teamB.name, m.teamB.players, m.teamB.name) : null;
        const dispWinner = m.winner ? getMatchTeamDisplay(m.winner.name, m.winner.players, m.winner.name) : null;

        let winnerName = dispWinner?.primary ?? matched?.winnerTeam ?? null;
        if (isFinal && scoreA !== null && scoreB !== null && scoreA !== scoreB) {
          winnerName = scoreA > scoreB ? (dispTeamA?.primary ?? null) : (dispTeamB?.primary ?? null);
        }

        if (m.round === "Final" && winnerName) {
          finalChamp = winnerName;
        }

        const parseSeedNum = (seedText?: string): number => {
          if (!seedText) return 0;
          const match = seedText.trim().match(/^#(\d+)\b/);
          return match ? Number(match[1]) : 0;
        };

        const slotA: ProjectedSlot = {
          label: m.seedA || (dispTeamA ? dispTeamA.primary : "TBD"),
          seedNum: parseSeedNum(m.seedA),
          team: m.teamA ?? null,
          isLocked: Boolean(m.teamA),
          isProjected: false,
          provisionalTeamName: dispTeamA ? dispTeamA.primary : null,
        };

        const slotB: ProjectedSlot = {
          label: m.seedB || (dispTeamB ? dispTeamB.primary : "TBD"),
          seedNum: parseSeedNum(m.seedB),
          team: m.teamB ?? null,
          isLocked: Boolean(m.teamB),
          isProjected: false,
          provisionalTeamName: dispTeamB ? dispTeamB.primary : null,
        };

        let cardStatus: KnockoutCardItem["status"] = "scheduled";
        if (isLive) cardStatus = "live";
        else if (isFinal) cardStatus = "final";

        return {
          id: m.id,
          round: m.round,
          label: m.label,
          slotIndex: m.slotIndex,
          matchNumber: m.matchNumber,
          feedWinnerTo: m.feedWinnerTo,
          slotA,
          slotB,
          court: matched?.court ?? m.court,
          status: cardStatus,
          scoreA,
          scoreB,
          winnerTeamName: winnerName,
          advancesTo: m.feedWinnerTo?.matchId ? "Advances to next round" : undefined,
        };
      });

      const nonBronzeCount = items.filter((i) => i.round !== "Bronze").length;
      return {
        bracketItems: items,
        bracketCapacity: Math.max(2, nonBronzeCount + 1),
        isPlayoffLive: hasLive,
        isPlayoffFinished: allDone && Boolean(finalChamp),
        championName: finalChamp,
      };
    }

    // When mainDrawMatches has NOT yet been officially created by Admin:
    // Build the projected situational bracket dynamically for any qualifier count 2..32
    const singlePoolTeamCount =
      groups.length === 1
        ? Math.max(
            groups[0]?.slots.filter((s) => s.team !== null).length || 0,
            poolStandingsMap.get(groups[0]?.letter || "")?.length || 0,
          )
        : 0;

    const totalExpected = Math.min(
      32,
      groups.length >= 2
        ? groups.length * 2
        : groups.length === 1
          ? singlePoolTeamCount
          : category.teams?.length || 0,
    );

    if (totalExpected < 2) {
      return {
        bracketItems: [],
        bracketCapacity: 0,
        isPlayoffLive: false,
        isPlayoffFinished: false,
        championName: null,
      };
    }

    const getBySeed = (seed: number, isBye = false): ProjectedSlot => {
      const found = rankedQualifiers.find((q) => q.overallSeed === seed);
      const disp = found
        ? getMatchTeamDisplay(found.team.name, found.team.players, found.team.name)
        : null;

      if (found && isAllRoundRobinComplete) {
        const diffText = found.pointDiff > 0 ? `+${found.pointDiff}` : `${found.pointDiff}`;
        return {
          label: `Seed #${seed} (${found.poolLetter}${found.poolRank}, ${diffText} PD${isBye ? " - BYE" : ""})`,
          seedNum: seed,
          poolLetter: found.poolLetter,
          poolRank: found.poolRank,
          team: found.team,
          isLocked: true,
          isProjected: false,
          pointDiff: found.pointDiff,
          wins: found.won,
        };
      }

      return {
        label: isBye ? `Seed #${seed} (BYE)` : `Seed #${seed}`,
        seedNum: seed,
        poolLetter: found?.poolLetter,
        poolRank: found?.poolRank,
        team: null,
        isLocked: false,
        isProjected: Boolean(found && found.isProjected),
        provisionalTeamName: found && found.isProjected && disp ? disp.primary : null,
        pointDiff: found?.pointDiff,
        wins: found?.won,
      };
    };

    const inputs: FoldParticipantInput<number>[] = Array.from({ length: totalExpected }, (_, i) => {
      const seedNum = i + 1;
      const found = rankedQualifiers.find((q) => q.overallSeed === seedNum);
      return {
        seedNumber: seedNum,
        poolLetter: found?.poolLetter,
        seedLabel: `Seed #${seedNum}`,
        byeSeedLabel: `Seed #${seedNum} (BYE)`,
        item: seedNum,
      };
    });

    const plan = buildFoldBracketPlan(inputs, {
      skipByes: true,
      includeBronze: totalExpected >= 4,
    });

    const labelByMatchId = new Map(plan.matches.map((m) => [m.id, m.label]));

    const items: KnockoutCardItem[] = plan.matches.map((pm) => {
      const isDirectByeA = pm.roundIndex > 0 && pm.participantA !== undefined;
      const isDirectByeB = pm.roundIndex > 0 && pm.participantB !== undefined;

      const slotA: ProjectedSlot =
        pm.participantA !== undefined
          ? getBySeed(pm.participantA, isDirectByeA)
          : {
              label: pm.seedA || "TBD",
              seedNum: 0,
              isLocked: false,
              isProjected: false,
            };

      const slotB: ProjectedSlot =
        pm.participantB !== undefined
          ? getBySeed(pm.participantB, isDirectByeB)
          : {
              label: pm.seedB || "TBD",
              seedNum: 0,
              isLocked: false,
              isProjected: false,
            };

      let advancesTo: string | undefined;
      if (pm.feedWinnerTo?.matchId) {
        const targetLabel = labelByMatchId.get(pm.feedWinnerTo.matchId) || "next round";
        advancesTo = `Winner advances to ${targetLabel}`;
      } else if (pm.round === "Final") {
        advancesTo = "Tournament Champion";
      } else if (pm.round === "Bronze") {
        advancesTo = "3rd Place Podium";
      }

      return {
        id: `proj-${pm.id.replace(/^md-/, "")}`,
        round: pm.round,
        label: pm.label,
        slotIndex: pm.slotIndex,
        matchNumber: pm.matchNumber,
        feedWinnerTo: pm.feedWinnerTo
          ? {
              matchId: `proj-${pm.feedWinnerTo.matchId.replace(/^md-/, "")}`,
              slot: pm.feedWinnerTo.slot,
            }
          : undefined,
        slotA,
        slotB,
        status: "projected",
        advancesTo,
      };
    });

    return {
      bracketItems: items,
      bracketCapacity: totalExpected,
      isPlayoffLive: false,
      isPlayoffFinished: false,
      championName: null,
    };
  }, [
    mainDrawMatches,
    matches,
    category.id,
    category.teams,
    groups,
    rankedQualifiers,
    poolStandingsMap,
    isAllRoundRobinComplete,
  ]);

  // Round filtering for the view
  const rounds = useMemo(() => {
    const list = [
      "Round of 32",
      "Round of 16",
      "Quarterfinal",
      "Semifinal",
      "Final",
      "Bronze",
    ] as const;
    return list.filter((r) => bracketItems.some((item) => item.round === r));
  }, [bracketItems]);

  const filteredItems = useMemo(() => {
    if (selectedRoundFilter === "all") return bracketItems;
    return bracketItems.filter((m) => m.round === selectedRoundFilter);
  }, [bracketItems, selectedRoundFilter]);

  if (bracketItems.length === 0) {
    return (
      <div className="surface-card p-8 rounded-2xl border-2 border-border text-center space-y-3 bg-card">
        <span className="text-xs uppercase font-bold tracking-[0.22em] text-pickle block">
          Knockout Stage
        </span>
        <h3 className="font-display text-2xl text-foreground">
          Playoff Bracket In Preparation
        </h3>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Knockout matches will populate dynamically once groups are drawn and round-robin matches are recorded.
        </p>
        {onSwitchToPools && (
          <button
            type="button"
            onClick={onSwitchToPools}
            className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 bg-pickle text-sand text-xs font-bold uppercase tracking-wider rounded cursor-pointer hover:opacity-90 transition-opacity"
          >
            <span>View Round Robin Groups</span>
            <ArrowRight size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Champion Celebration Card (if concluded) ── */}
      {championName && (
        <div className="surface-card p-6 sm:p-8 rounded-2xl border-2 border-pickle bg-pickle/15 text-center space-y-2 shadow-lg animate-in fade-in zoom-in duration-300">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-pickle text-sand text-xs font-bold uppercase tracking-widest font-mono">
            <Trophy size={14} />
            <span>Tournament Champion</span>
          </div>
          <h2 className="font-display text-3xl sm:text-5xl text-foreground font-bold">
            {championName}
          </h2>
          <p className="text-xs sm:text-sm text-foreground/80 max-w-md mx-auto">
            Official Champion of the {category.label} Division
          </p>
        </div>
      )}

      {/* ── Bracket Header & Status Strip ── */}
      <div className="surface-card p-4 sm:p-6 rounded-2xl border-2 border-border bg-charcoal text-sand space-y-4 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono font-bold uppercase tracking-[0.24em] text-pickle">
                {bracketCapacity}-Pair Single Elimination
              </span>
              <span className="text-xs text-sand/60">&bull;</span>
              <span className="text-xs font-mono uppercase tracking-wider text-sand/80">
                Seeded by Point Differential
              </span>
            </div>
            <h3 className="font-display text-2xl sm:text-3xl text-sand mt-0.5">
              Championship Knockout Stage
            </h3>
            <p className="text-xs text-sand/70 mt-1 max-w-xl leading-relaxed">
              Top 2 pairs from each round-robin pool qualify into single elimination. Bracket slots display TBD until pool standings are finalized.
            </p>
          </div>

          {/* Status pill & switcher */}
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            {isPlayoffLive ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-pickle/20 text-pickle border border-pickle/40 rounded-full text-xs font-bold uppercase tracking-wider font-mono">
                <span className="w-2 h-2 rounded-full bg-pickle animate-ping" />
                Playoffs Live Now
              </span>
            ) : isPlayoffFinished ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-brick/20 text-brick border border-brick/40 rounded-full text-xs font-bold uppercase tracking-wider font-mono">
                <CheckCircle2 size={13} />
                Stage Concluded
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-sand/15 text-sand border border-white/20 rounded-full text-xs font-bold uppercase tracking-wider font-mono">
                <Clock size={13} />
                Round Robin Active &bull; Slots TBD
              </span>
            )}

            {/* View Mode Toggle */}
            <div className="inline-flex rounded-lg border border-white/20 bg-black/40 p-0.5 text-xs font-mono">
              <button
                type="button"
                onClick={() => setViewMode("cards")}
                className={`px-3 py-1 rounded font-bold uppercase tracking-wider transition-colors cursor-pointer ${
                  viewMode === "cards" ? "bg-pickle text-sand shadow-xs" : "text-sand/70 hover:text-sand"
                }`}
              >
                Cards List
              </button>
              <button
                type="button"
                onClick={() => setViewMode("tree")}
                className={`px-3 py-1 rounded font-bold uppercase tracking-wider transition-colors cursor-pointer ${
                  viewMode === "tree" ? "bg-pickle text-sand shadow-xs" : "text-sand/70 hover:text-sand"
                }`}
              >
                Tree View
              </button>
            </div>
          </div>
        </div>

        {/* Round Filter Tabs */}
        {rounds.length > 1 && (
          <div className="pt-3 border-t border-white/10 flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            <button
              type="button"
              onClick={() => setSelectedRoundFilter("all")}
              className={`px-3 py-1 rounded text-xs font-mono font-bold uppercase tracking-wider transition-colors whitespace-nowrap cursor-pointer ${
                selectedRoundFilter === "all"
                  ? "bg-sand text-charcoal"
                  : "bg-white/10 text-sand/80 hover:bg-white/20"
              }`}
            >
              All Rounds ({bracketItems.length})
            </button>
            {rounds.map((r) => {
              const count = bracketItems.filter((m) => m.round === r).length;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setSelectedRoundFilter(r)}
                  className={`px-3 py-1 rounded text-xs font-mono font-bold uppercase tracking-wider transition-colors whitespace-nowrap cursor-pointer ${
                    selectedRoundFilter === r
                      ? "bg-sand text-charcoal"
                      : "bg-white/10 text-sand/80 hover:bg-white/20"
                  }`}
                >
                  {r === "Final" ? "Finals" : r} ({count})
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Round Robin Active Alert ── */}
      {!isAllRoundRobinComplete && onSwitchToPools && (
        <div className="surface-card p-4 rounded-xl border border-pickle/30 bg-pickle/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-pickle flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-pickle animate-pulse" />
              Round Robin In Progress &bull; Playoff Slots TBD
            </span>
            <p className="text-xs text-foreground/80">
              Knockout matchups show TBD while pool play is underway. As round-robin groups conclude, qualified pairs and official seeds will lock in here automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={onSwitchToPools}
            className="px-3.5 py-2 bg-pickle text-sand text-xs font-bold font-mono uppercase tracking-wider rounded-lg hover:opacity-90 transition-opacity shrink-0 cursor-pointer"
          >
            View Group Matches &rarr;
          </button>
        </div>
      )}

      {/* ── CARDS LIST VIEW (Mobile-Optimized & Quick Scanning) ── */}
      {viewMode === "cards" && (
        <div className="space-y-6">
          {rounds
            .filter((r) => selectedRoundFilter === "all" || selectedRoundFilter === r)
            .map((roundName) => {
              const roundMatches = bracketItems.filter((m) => m.round === roundName);
              if (roundMatches.length === 0) return null;

              return (
                <div key={roundName} className="space-y-3">
                  <div className="flex items-center justify-between border-b border-border pb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-pickle" />
                      <h4 className="font-display text-xl sm:text-2xl text-foreground">
                        {roundName === "Final"
                          ? "Championship Final"
                          : roundName === "Bronze"
                            ? "3rd Place Match (Bronze)"
                            : roundName}
                      </h4>
                    </div>
                    <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                      {roundMatches.length} {roundMatches.length === 1 ? "match" : "matches"}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                    {roundMatches.map((item) => (
                      <KnockoutMatchCard
                        key={item.id}
                        item={item}
                        highlightTeam={highlightTeam}
                        onTeamTap={onTeamTap}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* ── TREE VIEW (Visual Tournament Tree with Connecting Lines) ── */}
      {viewMode === "tree" && (
        <KnockoutTreeVisualizer
          category={category}
          bracketItems={bracketItems}
          isAllRoundRobinComplete={isAllRoundRobinComplete}
          highlightTeam={highlightTeam}
          onTeamTap={onTeamTap}
          poolCount={groups.length || undefined}
        />
      )}
    </div>
  );
}

function KnockoutMatchCard({
  item,
  highlightTeam,
  onTeamTap,
}: {
  item: KnockoutCardItem;
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
}) {
  const isFinal = item.round === "Final";
  const isLive = item.status === "live";
  const isDone = item.status === "final";
  const isBye = item.status === "bye";

  const isHighlightedA = Boolean(
    highlightTeam && item.slotA.team && item.slotA.team.name.toLowerCase() === highlightTeam.toLowerCase()
  );
  const isHighlightedB = Boolean(
    highlightTeam && item.slotB.team && item.slotB.team.name.toLowerCase() === highlightTeam.toLowerCase()
  );

  const dispA = item.slotA.team
    ? getMatchTeamDisplay(item.slotA.team.name, item.slotA.team.players, item.slotA.team.name)
    : null;
  const dispB = item.slotB.team
    ? getMatchTeamDisplay(item.slotB.team.name, item.slotB.team.players, item.slotB.team.name)
    : null;

  const playersA = item.slotA.team
    ? resolveMatchTeamPlayers(item.slotA.team.players, item.slotA.team.name, "")
    : [];
  const playersB = item.slotB.team
    ? resolveMatchTeamPlayers(item.slotB.team.players, item.slotB.team.name, "")
    : [];

  const hasDecisiveScores =
    typeof item.scoreA === "number" &&
    typeof item.scoreB === "number" &&
    item.scoreA !== item.scoreB;

  const wonA = Boolean(
    isDone &&
      (hasDecisiveScores
        ? (item.scoreA ?? 0) > (item.scoreB ?? 0)
        : item.winnerTeamName &&
          (dispA?.primary === item.winnerTeamName ||
            (!isGenericTeamName(item.slotA.team?.name) && item.slotA.team?.name === item.winnerTeamName))),
  );
  const wonB = Boolean(
    isDone &&
      !wonA &&
      (hasDecisiveScores
        ? (item.scoreB ?? 0) > (item.scoreA ?? 0)
        : item.winnerTeamName &&
          (dispB?.primary === item.winnerTeamName ||
            (!isGenericTeamName(item.slotB.team?.name) && item.slotB.team?.name === item.winnerTeamName))),
  );

  return (
    <div
      className={`surface-card rounded-xl overflow-hidden border-2 transition-all ${
        isLive
          ? "border-pickle shadow-md shadow-pickle/15 bg-charcoal text-sand"
          : isFinal
            ? "border-brick/70 shadow-sm bg-card text-foreground"
            : "border-border bg-card text-foreground"
      } ${isHighlightedA || isHighlightedB ? "ring-2 ring-pickle" : ""}`}
    >
      {/* Match Header Bar */}
      <div className="bg-charcoal px-3 py-1.5 text-[0.62rem] font-mono uppercase tracking-widest text-sand/90 flex items-center justify-between border-b border-white/10">
        <span className="font-bold truncate max-w-[170px]">{item.label}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {item.court && <span className="text-pickle font-bold">{item.court}</span>}
          {isLive && (
            <span className="inline-flex items-center gap-1 text-pickle font-bold">
              <span className="w-1.5 h-1.5 rounded-full bg-pickle animate-ping" />
              Live
            </span>
          )}
          {isDone && <span className="text-brick font-bold">Final</span>}
          {isBye && <span className="text-sand/60 font-bold">Bye</span>}
          {!isLive && !isDone && !isBye && (
            <span className="text-sand/50">
              {item.slotA.isLocked && (item.slotB.isLocked || item.slotB.isBye) ? "Scheduled" : "TBD"}
            </span>
          )}
        </div>
      </div>

      {/* Team A Slot */}
      <div
        onClick={() => item.slotA.isLocked && item.slotA.team && onTeamTap?.(item.slotA.team)}
        className={`p-3 flex items-center justify-between gap-2 border-b border-border/60 transition-colors ${
          wonA ? "bg-pickle/15 font-bold" : ""
        } ${item.slotA.isLocked && item.slotA.team ? "cursor-pointer hover:bg-muted/40" : ""}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {/* Seed / Position badge */}
            <span
              className={`text-[0.6rem] font-mono px-1.5 py-0.2 rounded font-bold shrink-0 border ${
                item.slotA.isLocked
                  ? "bg-pickle/20 border-pickle/40 text-pickle"
                  : "bg-muted/60 border-border text-muted-foreground"
              }`}
            >
              {item.slotA.isLocked ? "Qualified" : "TBD"}
            </span>
            <span className="text-[0.65rem] font-mono text-muted-foreground truncate">
              {item.slotA.label}
            </span>
          </div>

          {/* Team Name */}
          <div className="mt-1">
            {item.slotA.isLocked && item.slotA.team && dispA ? (
              <>
                <span
                  className={`text-sm font-bold block truncate ${
                    wonA ? "text-pickle" : "text-foreground"
                  }`}
                >
                  {dispA.primary}
                </span>
                {dispA.secondary ? (
                  <span className="text-[0.68rem] text-muted-foreground font-mono block truncate">
                    {dispA.secondary}
                  </span>
                ) : playersA.length > 0 && !isGenericTeamName(item.slotA.team.name) ? (
                  <span className="text-[0.68rem] text-muted-foreground font-mono block truncate">
                    {playersA.join(" & ")}
                  </span>
                ) : null}
              </>
            ) : (
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-bold font-mono tracking-wider text-muted-foreground">
                    TBD
                  </span>
                  <span className="text-[0.6rem] font-mono uppercase px-1.5 py-0.5 rounded bg-muted/60 border border-border text-muted-foreground">
                    Round Robin in progress
                  </span>
                </div>
                {item.slotA.provisionalTeamName && (
                  <span className="text-[0.68rem] text-muted-foreground/75 font-mono block truncate">
                    Current leader: {item.slotA.provisionalTeamName}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Score */}
        <div className="text-right shrink-0">
          {item.scoreA !== null && item.scoreA !== undefined ? (
            <span className={`font-display text-2xl ${wonA ? "text-pickle font-bold" : "text-foreground"}`}>
              {item.scoreA}
            </span>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">-</span>
          )}
        </div>
      </div>

      {/* Team B Slot */}
      <div
        onClick={() => item.slotB.isLocked && item.slotB.team && onTeamTap?.(item.slotB.team)}
        className={`p-3 flex items-center justify-between gap-2 transition-colors ${
          wonB ? "bg-pickle/15 font-bold" : ""
        } ${item.slotB.isLocked && item.slotB.team ? "cursor-pointer hover:bg-muted/40" : ""}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {/* Seed / Position badge */}
            <span
              className={`text-[0.6rem] font-mono px-1.5 py-0.2 rounded font-bold shrink-0 border ${
                item.slotB.isBye
                  ? "bg-muted border-border text-muted-foreground"
                  : item.slotB.isLocked
                    ? "bg-pickle/20 border-pickle/40 text-pickle"
                    : "bg-muted/60 border-border text-muted-foreground"
              }`}
            >
              {item.slotB.isBye ? "BYE" : item.slotB.isLocked ? "Qualified" : "TBD"}
            </span>
            <span className="text-[0.65rem] font-mono text-muted-foreground truncate">
              {item.slotB.label}
            </span>
          </div>

          {/* Team Name */}
          <div className="mt-1">
            {item.slotB.isBye ? (
              <span className="text-sm font-bold text-muted-foreground font-mono block truncate">
                No Match (BYE Advance)
              </span>
            ) : item.slotB.isLocked && item.slotB.team && dispB ? (
              <>
                <span
                  className={`text-sm font-bold block truncate ${
                    wonB ? "text-pickle" : "text-foreground"
                  }`}
                >
                  {dispB.primary}
                </span>
                {dispB.secondary ? (
                  <span className="text-[0.68rem] text-muted-foreground font-mono block truncate">
                    {dispB.secondary}
                  </span>
                ) : playersB.length > 0 && !isGenericTeamName(item.slotB.team.name) ? (
                  <span className="text-[0.68rem] text-muted-foreground font-mono block truncate">
                    {playersB.join(" & ")}
                  </span>
                ) : null}
              </>
            ) : (
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-bold font-mono tracking-wider text-muted-foreground">
                    TBD
                  </span>
                  <span className="text-[0.6rem] font-mono uppercase px-1.5 py-0.5 rounded bg-muted/60 border border-border text-muted-foreground">
                    Round Robin in progress
                  </span>
                </div>
                {item.slotB.provisionalTeamName && (
                  <span className="text-[0.68rem] text-muted-foreground/75 font-mono block truncate">
                    Current leader: {item.slotB.provisionalTeamName}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Score */}
        <div className="text-right shrink-0">
          {item.scoreB !== null && item.scoreB !== undefined ? (
            <span className={`font-display text-2xl ${wonB ? "text-pickle font-bold" : "text-foreground"}`}>
              {item.scoreB}
            </span>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">-</span>
          )}
        </div>
      </div>

      {/* Footer: Advancement or Status */}
      {item.advancesTo && (
        <div className="bg-muted/30 px-3 py-1.5 text-[0.62rem] font-mono text-muted-foreground border-t border-border/40 flex items-center justify-between">
          <span>{item.advancesTo}</span>
          {wonA || wonB ? (
            <span className="text-pickle font-bold flex items-center gap-1">
              <span>{wonA ? dispA?.primary : dispB?.primary} Won</span>
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
