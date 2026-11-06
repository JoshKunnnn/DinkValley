import { useState, useMemo } from "react";
import type { Category, Team } from "@/data/tournaments";
import { type LiveMatch, resolveMatchTeamPlayers } from "@/lib/match-store";
import type { BracketGroup } from "@/components/admin/BracketDraw";
import type { KnockoutMatch } from "@/components/admin/DrawsManager";
import { isSameCategory } from "@/lib/supabase-service";
import { KnockoutTreeVisualizer } from "./KnockoutTreeVisualizer";
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
  round: "Round of 16" | "Quarterfinal" | "Semifinal" | "Final" | "Bronze";
  label: string;
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
  const [viewMode, setViewMode] = useState<"cards" | "tree">("cards");
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
      // 1 pool: seeds 1, 2, 3 in direct order
      [...winners, ...runnersUp, ...thirds].sort(comparePD).forEach((q) => {
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

      const items: KnockoutCardItem[] = mainDrawMatches.map((m) => {
        const stage = `${m.round} - ${m.label}`;
        const matched =
          koMatches.find(
            (lm) => lm.id === m.id && lm.categoryId && isSameCategory(lm.categoryId, category.id)
          ) ||
          koMatches.find((lm) => lm.stage === stage);

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

        const scoreA = matched ? matched.score.teamAScore : (m.scoreA ?? null);
        const scoreB = matched ? matched.score.teamBScore : (m.scoreB ?? null);

        let winnerName = m.winner?.name ?? matched?.winnerTeam ?? null;
        if (!winnerName && isFinal && scoreA !== null && scoreB !== null && scoreA !== scoreB) {
          winnerName = scoreA > scoreB ? m.teamA?.name ?? null : m.teamB?.name ?? null;
        }

        if (m.round === "Final" && winnerName) {
          finalChamp = winnerName;
        }

        const isLiveOrDone = isLive || isFinal || Boolean(matched);

        const slotA: ProjectedSlot = {
          label: m.seedA || (m.teamA?.name ? m.teamA.name : "TBD"),
          seedNum: 1,
          team: m.teamA ?? null,
          isLocked: Boolean(m.teamA && (isAllRoundRobinComplete || isLiveOrDone || m.winner)),
          isProjected: false,
          provisionalTeamName: m.teamA?.name ?? null,
        };

        const slotB: ProjectedSlot = {
          label: m.seedB || (m.teamB?.name ? m.teamB.name : "TBD"),
          seedNum: 2,
          team: m.teamB ?? null,
          isLocked: Boolean(m.teamB && (isAllRoundRobinComplete || isLiveOrDone || m.winner)),
          isProjected: false,
          provisionalTeamName: m.teamB?.name ?? null,
        };

        let cardStatus: KnockoutCardItem["status"] = "scheduled";
        if (isLive) cardStatus = "live";
        else if (isFinal) cardStatus = "final";

        return {
          id: m.id,
          round: m.round,
          label: m.label,
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

      return {
        bracketItems: items,
        bracketCapacity: items.length > 8 ? 16 : items.length > 4 ? 8 : 4,
        isPlayoffLive: hasLive,
        isPlayoffFinished: allDone && Boolean(finalChamp),
        championName: finalChamp,
      };
    }

    // When mainDrawMatches has NOT yet been officially created by Admin:
    // Build the projected situational bracket based on number of groups / teams
    const totalExpected = Math.max(groups.length * 2, category.teams?.length || 0);

    // Helpers to find team by seed or pool position
    const getBySeed = (seed: number): ProjectedSlot => {
      const found = rankedQualifiers.find((q) => q.overallSeed === seed);
      if (found && isAllRoundRobinComplete) {
        const diffText = found.pointDiff > 0 ? `+${found.pointDiff}` : `${found.pointDiff}`;
        return {
          label: `Seed #${seed} (${found.poolLetter}${found.poolRank}, ${diffText} PD)`,
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
        label: `Seed #${seed}`,
        seedNum: seed,
        team: null,
        isLocked: false,
        isProjected: Boolean(found),
        provisionalTeamName: found ? found.team.name : null,
        pointDiff: found?.pointDiff,
        wins: found?.won,
      };
    };

    const getByPoolSlot = (poolLetter: string, rank: number, defaultSeed: number): ProjectedSlot => {
      const rows = poolStandingsMap.get(poolLetter) || [];
      const isComplete = poolCompletionMap.get(poolLetter) || false;
      const target = rows[rank - 1];

      if (target && isComplete) {
        const diffText = target.pointDiff > 0 ? `+${target.pointDiff}` : `${target.pointDiff}`;
        return {
          label: `${rank === 1 ? "1st" : "2nd"} Pool ${poolLetter} (#${defaultSeed}, ${diffText} PD)`,
          seedNum: defaultSeed,
          poolLetter,
          poolRank: rank,
          team: target.team,
          isLocked: true,
          isProjected: false,
          pointDiff: target.pointDiff,
          wins: target.won,
        };
      }

      return {
        label: `${rank === 1 ? "1st" : "2nd"} Pool ${poolLetter} (Seed #${defaultSeed})`,
        seedNum: defaultSeed,
        poolLetter,
        poolRank: rank,
        team: null,
        isLocked: false,
        isProjected: Boolean(target && target.played > 0),
        provisionalTeamName: target && target.played > 0 ? target.team.name : null,
        pointDiff: target?.pointDiff,
        wins: target?.won,
      };
    };

    const items: KnockoutCardItem[] = [];

    // CASE 0: 10-Team / 5-Pool Bracket (2 Play-Ins in R16 + 6 BYEs directly to Quarterfinals)
    if (groups.length === 5 || (rankedQualifiers.length === 10 && groups.length <= 5)) {
      // 2 Play-In Matches (Round of 16)
      items.push({
        id: "proj-r16-1",
        round: "Round of 16",
        label: "Round of 16 - Match 1",
        slotA: getBySeed(8),
        slotB: getBySeed(9),
        status: "projected",
        advancesTo: "Winner advances to Quarterfinal 1",
      });

      items.push({
        id: "proj-r16-2",
        round: "Round of 16",
        label: "Round of 16 - Match 2",
        slotA: getBySeed(7),
        slotB: getBySeed(10),
        status: "projected",
        advancesTo: "Winner advances to Quarterfinal 3",
      });

      // 4 Quarterfinals (Seeds #1, #4, #5, #2, #3, #6 hold BYEs)
      const s1 = getBySeed(1);
      items.push({
        id: "proj-qf-1",
        round: "Quarterfinal",
        label: "Quarterfinal 1",
        slotA: {
          ...s1,
          label: s1.team ? `${s1.label} (BYE)` : "Seed #1 (BYE - Direct to QF)",
          isBye: true,
        },
        slotB: {
          label: "Winner of R16 Match 1 (Seed #8 vs #9)",
          seedNum: 8,
          isLocked: false,
          isProjected: false,
        },
        status: "projected",
        advancesTo: "Winner advances to Semifinal 1",
      });

      const s4 = getBySeed(4);
      const s5 = getBySeed(5);
      items.push({
        id: "proj-qf-2",
        round: "Quarterfinal",
        label: "Quarterfinal 2",
        slotA: {
          ...s4,
          label: s4.team ? `${s4.label} (BYE)` : "Seed #4 (BYE - Direct to QF)",
          isBye: true,
        },
        slotB: {
          ...s5,
          label: s5.team ? `${s5.label} (BYE)` : "Seed #5 (BYE - Direct to QF)",
          isBye: true,
        },
        status: "projected",
        advancesTo: "Winner advances to Semifinal 1",
      });

      const s2 = getBySeed(2);
      items.push({
        id: "proj-qf-3",
        round: "Quarterfinal",
        label: "Quarterfinal 3",
        slotA: {
          ...s2,
          label: s2.team ? `${s2.label} (BYE)` : "Seed #2 (BYE - Direct to QF)",
          isBye: true,
        },
        slotB: {
          label: "Winner of R16 Match 2 (Seed #7 vs #10)",
          seedNum: 7,
          isLocked: false,
          isProjected: false,
        },
        status: "projected",
        advancesTo: "Winner advances to Semifinal 2",
      });

      const s3 = getBySeed(3);
      const s6 = getBySeed(6);
      items.push({
        id: "proj-qf-4",
        round: "Quarterfinal",
        label: "Quarterfinal 4",
        slotA: {
          ...s3,
          label: s3.team ? `${s3.label} (BYE)` : "Seed #3 (BYE - Direct to QF)",
          isBye: true,
        },
        slotB: {
          ...s6,
          label: s6.team ? `${s6.label} (BYE)` : "Seed #6 (BYE - Direct to QF)",
          isBye: true,
        },
        status: "projected",
        advancesTo: "Winner advances to Semifinal 2",
      });

      // 2 Semifinals
      items.push({
        id: "proj-sf-1",
        round: "Semifinal",
        label: "Semifinal 1",
        slotA: { label: "Winner of Quarterfinal 1", seedNum: 1, isLocked: false, isProjected: false },
        slotB: { label: "Winner of Quarterfinal 2", seedNum: 4, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "Winner advances to Championship Final",
      });
      items.push({
        id: "proj-sf-2",
        round: "Semifinal",
        label: "Semifinal 2",
        slotA: { label: "Winner of Quarterfinal 3", seedNum: 2, isLocked: false, isProjected: false },
        slotB: { label: "Winner of Quarterfinal 4", seedNum: 3, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "Winner advances to Championship Final",
      });

      // Championship Final & Bronze
      items.push({
        id: "proj-final",
        round: "Final",
        label: "Championship Final",
        slotA: { label: "Winner of Semifinal 1", seedNum: 1, isLocked: false, isProjected: false },
        slotB: { label: "Winner of Semifinal 2", seedNum: 2, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "Tournament Champion",
      });
      items.push({
        id: "proj-bronze",
        round: "Bronze",
        label: "3rd Place Match",
        slotA: { label: "Runner-up of Semifinal 1", seedNum: 1, isLocked: false, isProjected: false },
        slotB: { label: "Runner-up of Semifinal 2", seedNum: 2, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "3rd Place Podium",
      });

      return {
        bracketItems: items,
        bracketCapacity: 10,
        isPlayoffLive: false,
        isPlayoffFinished: false,
        championName: null,
      };
    }

    // CASE 1: 16-Pair Bracket (e.g. 6 to 8 groups, or 17-32 participants)
    if (totalExpected >= 11 || groups.length >= 6) {
      const r16Pairs = [
        { top: { p: "A", r: 1, s: 1 }, bot: { p: "B", r: 2, s: 16 }, qf: "Quarterfinal 1" },
        { top: { p: "C", r: 1, s: 8 }, bot: { p: "D", r: 2, s: 9 },  qf: "Quarterfinal 1" },
        { top: { p: "E", r: 1, s: 4 }, bot: { p: "F", r: 2, s: 13 }, qf: "Quarterfinal 2" },
        { top: { p: "G", r: 1, s: 5 }, bot: { p: "H", r: 2, s: 12 }, qf: "Quarterfinal 2" },
        { top: { p: "B", r: 1, s: 2 }, bot: { p: "A", r: 2, s: 15 }, qf: "Quarterfinal 3" },
        { top: { p: "D", r: 1, s: 7 }, bot: { p: "C", r: 2, s: 10 }, qf: "Quarterfinal 3" },
        { top: { p: "F", r: 1, s: 3 }, bot: { p: "E", r: 2, s: 14 }, qf: "Quarterfinal 4" },
        { top: { p: "H", r: 1, s: 6 }, bot: { p: "G", r: 2, s: 11 }, qf: "Quarterfinal 4" },
      ];

      r16Pairs.forEach((pair, idx) => {
        const topSlot = groups.find((g) => g.letter === pair.top.p)
          ? getByPoolSlot(pair.top.p, pair.top.r, pair.top.s)
          : getBySeed(pair.top.s);

        const botSlot = groups.find((g) => g.letter === pair.bot.p)
          ? getByPoolSlot(pair.bot.p, pair.bot.r, pair.bot.s)
          : getBySeed(pair.bot.s);

        items.push({
          id: `proj-r16-${idx + 1}`,
          round: "Round of 16",
          label: `Round of 16 - Match ${idx + 1}`,
          slotA: topSlot,
          slotB: botSlot,
          status: "projected",
          advancesTo: `Winner advances to ${pair.qf}`,
        });
      });

      // 4 Quarterfinals
      for (let qf = 1; qf <= 4; qf++) {
        items.push({
          id: `proj-qf-${qf}`,
          round: "Quarterfinal",
          label: `Quarterfinal ${qf}`,
          slotA: { label: `Winner of R16 Match ${qf * 2 - 1}`, seedNum: qf * 2 - 1, isLocked: false, isProjected: false },
          slotB: { label: `Winner of R16 Match ${qf * 2}`, seedNum: qf * 2, isLocked: false, isProjected: false },
          status: "projected",
          advancesTo: `Winner advances to Semifinal ${qf <= 2 ? 1 : 2}`,
        });
      }

      // 2 Semifinals
      items.push({
        id: "proj-sf-1",
        round: "Semifinal",
        label: "Semifinal 1",
        slotA: { label: "Winner of Quarterfinal 1", seedNum: 1, isLocked: false, isProjected: false },
        slotB: { label: "Winner of Quarterfinal 2", seedNum: 2, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "Winner advances to Championship Final",
      });
      items.push({
        id: "proj-sf-2",
        round: "Semifinal",
        label: "Semifinal 2",
        slotA: { label: "Winner of Quarterfinal 3", seedNum: 3, isLocked: false, isProjected: false },
        slotB: { label: "Winner of Quarterfinal 4", seedNum: 4, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "Winner advances to Championship Final",
      });

      // Championship Final & Bronze
      items.push({
        id: "proj-final",
        round: "Final",
        label: "Championship Final",
        slotA: { label: "Winner of Semifinal 1", seedNum: 1, isLocked: false, isProjected: false },
        slotB: { label: "Winner of Semifinal 2", seedNum: 2, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "Tournament Champion",
      });
      items.push({
        id: "proj-bronze",
        round: "Bronze",
        label: "3rd Place Match",
        slotA: { label: "Runner-up of Semifinal 1", seedNum: 1, isLocked: false, isProjected: false },
        slotB: { label: "Runner-up of Semifinal 2", seedNum: 2, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "3rd Place Podium",
      });

      return {
        bracketItems: items,
        bracketCapacity: 16,
        isPlayoffLive: false,
        isPlayoffFinished: false,
        championName: null,
      };
    }

    // CASE 2: 8-Pair Bracket (e.g. 3 to 4 groups, or 9-16 participants)
    if (totalExpected >= 5 || groups.length >= 3) {
      const qfPairs = [
        { top: { p: "A", r: 1, s: 1 }, bot: { p: "B", r: 2, s: 8 }, sf: "Semifinal 1" },
        { top: { p: "C", r: 1, s: 4 }, bot: { p: "D", r: 2, s: 5 }, sf: "Semifinal 1" },
        { top: { p: "B", r: 1, s: 2 }, bot: { p: "A", r: 2, s: 7 }, sf: "Semifinal 2" },
        { top: { p: "D", r: 1, s: 3 }, bot: { p: "C", r: 2, s: 6 }, sf: "Semifinal 2" },
      ];

      qfPairs.forEach((pair, idx) => {
        const hasTopPool = groups.find((g) => g.letter === pair.top.p);
        const hasBotPool = groups.find((g) => g.letter === pair.bot.p);

        const topSlot = hasTopPool ? getByPoolSlot(pair.top.p, pair.top.r, pair.top.s) : getBySeed(pair.top.s);
        const botSlot = hasBotPool ? getByPoolSlot(pair.bot.p, pair.bot.r, pair.bot.s) : getBySeed(pair.bot.s);

        // Check if 6 teams total: Seed 1 & 2 receive BYEs to Semifinals
        const isBye = totalExpected <= 6 && (pair.top.s === 1 || pair.top.s === 2);

        items.push({
          id: `proj-qf-${idx + 1}`,
          round: "Quarterfinal",
          label: `Quarterfinal ${idx + 1}`,
          slotA: topSlot,
          slotB: isBye ? { label: "BYE (Advances Directly)", seedNum: 99, isLocked: true, isProjected: false, isBye: true } : botSlot,
          status: isBye ? "bye" : "projected",
          advancesTo: `Advances to ${pair.sf}`,
        });
      });

      // 2 Semifinals
      items.push({
        id: "proj-sf-1",
        round: "Semifinal",
        label: "Semifinal 1",
        slotA: { label: "Winner of Quarterfinal 1", seedNum: 1, isLocked: false, isProjected: false },
        slotB: { label: "Winner of Quarterfinal 2", seedNum: 2, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "Winner advances to Championship Final",
      });
      items.push({
        id: "proj-sf-2",
        round: "Semifinal",
        label: "Semifinal 2",
        slotA: { label: "Winner of Quarterfinal 3", seedNum: 3, isLocked: false, isProjected: false },
        slotB: { label: "Winner of Quarterfinal 4", seedNum: 4, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "Winner advances to Championship Final",
      });

      // Championship Final & Bronze
      items.push({
        id: "proj-final",
        round: "Final",
        label: "Championship Final",
        slotA: { label: "Winner of Semifinal 1", seedNum: 1, isLocked: false, isProjected: false },
        slotB: { label: "Winner of Semifinal 2", seedNum: 2, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "Tournament Champion",
      });
      items.push({
        id: "proj-bronze",
        round: "Bronze",
        label: "3rd Place Match",
        slotA: { label: "Runner-up of Semifinal 1", seedNum: 1, isLocked: false, isProjected: false },
        slotB: { label: "Runner-up of Semifinal 2", seedNum: 2, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "3rd Place Podium",
      });

      return {
        bracketItems: items,
        bracketCapacity: 8,
        isPlayoffLive: false,
        isPlayoffFinished: false,
        championName: null,
      };
    }

    // CASE 3: 4-Pair Bracket (e.g. 2 groups of 4, or 4 teams total)
    if (totalExpected >= 4 || groups.length === 2) {
      const topA = groups.find((g) => g.letter === "A") ? getByPoolSlot("A", 1, 1) : getBySeed(1);
      const botB = groups.find((g) => g.letter === "B") ? getByPoolSlot("B", 2, 4) : getBySeed(4);
      const topB = groups.find((g) => g.letter === "B") ? getByPoolSlot("B", 1, 2) : getBySeed(2);
      const botA = groups.find((g) => g.letter === "A") ? getByPoolSlot("A", 2, 3) : getBySeed(3);

      items.push({
        id: "proj-sf-1",
        round: "Semifinal",
        label: "Semifinal 1",
        slotA: topA,
        slotB: botB,
        status: "projected",
        advancesTo: "Winner advances to Championship Final",
      });
      items.push({
        id: "proj-sf-2",
        round: "Semifinal",
        label: "Semifinal 2",
        slotA: topB,
        slotB: botA,
        status: "projected",
        advancesTo: "Winner advances to Championship Final",
      });
      items.push({
        id: "proj-final",
        round: "Final",
        label: "Championship Final",
        slotA: { label: "Winner of Semifinal 1", seedNum: 1, isLocked: false, isProjected: false },
        slotB: { label: "Winner of Semifinal 2", seedNum: 2, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "Tournament Champion",
      });
      items.push({
        id: "proj-bronze",
        round: "Bronze",
        label: "3rd Place Match",
        slotA: { label: "Runner-up of Semifinal 1", seedNum: 1, isLocked: false, isProjected: false },
        slotB: { label: "Runner-up of Semifinal 2", seedNum: 2, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "3rd Place Podium",
      });

      return {
        bracketItems: items,
        bracketCapacity: 4,
        isPlayoffLive: false,
        isPlayoffFinished: false,
        championName: null,
      };
    }

    // CASE 4: 3-Pair Bracket (1 pool of 3 pairs)
    if (totalExpected === 3 || groups.length === 1) {
      const s1 = getBySeed(1);
      const s2 = getBySeed(2);
      const s3 = getBySeed(3);

      items.push({
        id: "proj-sf-1",
        round: "Semifinal",
        label: "Semifinal Playoff",
        slotA: s2,
        slotB: s3,
        status: "projected",
        advancesTo: "Winner plays Seed #1 in Championship Final",
      });

      items.push({
        id: "proj-final",
        round: "Final",
        label: "Championship Final",
        slotA: { ...s1, label: `${s1.team ? s1.team.name : "Seed #1"} (BYE - Direct to Final)` },
        slotB: { label: "Winner of Semifinal Playoff", seedNum: 2, isLocked: false, isProjected: false },
        status: "projected",
        advancesTo: "Tournament Champion",
      });

      return {
        bracketItems: items,
        bracketCapacity: 3,
        isPlayoffLive: false,
        isPlayoffFinished: false,
        championName: null,
      };
    }

    // Default Fallback
    return {
      bracketItems: [],
      bracketCapacity: 0,
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
    poolCompletionMap,
  ]);

  // Round filtering for the view
  const rounds = useMemo(() => {
    const list = ["Round of 16", "Quarterfinal", "Semifinal", "Final", "Bronze"] as const;
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
          poolCount={groups.length || 5}
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

  const playersA = item.slotA.team
    ? resolveMatchTeamPlayers(item.slotA.team.players, item.slotA.team.name, "")
    : [];
  const playersB = item.slotB.team
    ? resolveMatchTeamPlayers(item.slotB.team.players, item.slotB.team.name, "")
    : [];

  const wonA = isDone && item.winnerTeamName && item.slotA.team?.name === item.winnerTeamName;
  const wonB = isDone && item.winnerTeamName && item.slotB.team?.name === item.winnerTeamName;

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
            {item.slotA.isLocked && item.slotA.team ? (
              <>
                <span
                  className={`text-sm font-bold block truncate ${
                    wonA ? "text-pickle" : "text-foreground"
                  }`}
                >
                  {item.slotA.team.name}
                </span>
                {playersA.length > 0 && (
                  <span className="text-[0.68rem] text-muted-foreground font-mono block truncate">
                    {playersA.join(" & ")}
                  </span>
                )}
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
            ) : item.slotB.isLocked && item.slotB.team ? (
              <>
                <span
                  className={`text-sm font-bold block truncate ${
                    wonB ? "text-pickle" : "text-foreground"
                  }`}
                >
                  {item.slotB.team.name}
                </span>
                {playersB.length > 0 && (
                  <span className="text-[0.68rem] text-muted-foreground font-mono block truncate">
                    {playersB.join(" & ")}
                  </span>
                )}
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
              <span>{wonA ? item.slotA.team?.name : item.slotB.team?.name} Won</span>
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
