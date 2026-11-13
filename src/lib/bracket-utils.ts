import { getCachedDrawnGroups } from "./supabase-service";

// Memoized JSON.parse results keyed by localStorage key; reused while the raw string is unchanged.
const _parsedGroupsCache = new Map<string, { raw: string; parsed: any }>();

function readGroupsFromStorage(key: string): any | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(key);
  if (!raw) {
    _parsedGroupsCache.delete(key);
    return null;
  }
  const hit = _parsedGroupsCache.get(key);
  if (hit && hit.raw === raw) return hit.parsed;
  const parsed = JSON.parse(raw);
  _parsedGroupsCache.set(key, { raw, parsed });
  return parsed;
}

/**
 * Validates that a pool play match only pairs teams that are actually in the exact same bracket.
 * If drawn groups exist for the tournament and category, both teamAName and teamBName
 * must belong to the same bracket group (e.g. Bracket A, Bracket B, etc.).
 * Knockout playoff matches (Quarterfinals, Semifinals, etc.) or exhibition matches are allowed cross-bracket.
 */
export function isMatchInSameBracket(
  tournamentSlug: string,
  categoryId?: string,
  stage?: string,
  teamAName?: string,
  teamBName?: string,
  teamAId?: string,
  teamBId?: string,
  teamAPlayers?: string[],
  teamBPlayers?: string[],
): boolean {
  if (!teamAName || !teamBName) return false;
  const cleanA = teamAName.replace(/\s+/g, " ").trim().toLowerCase();
  const cleanB = teamBName.replace(/\s+/g, " ").trim().toLowerCase();
  const isGeneric = (n: string) =>
    ["n/a", "na", "tbd", "tba", "null", "undefined", "none", "-", "team a", "team b"].includes(n);
  const normPlayerRoster = (arr?: string[]) =>
    (arr || [])
      .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
      .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
      .filter((p) => Boolean(p) && !isGeneric(p))
      .sort()
      .join("|");

  // Same team playing itself
  if (teamAId && teamBId && teamAId === teamBId) return false;
  if (!teamAId && !teamBId && cleanA === cleanB) {
    const pA = normPlayerRoster(teamAPlayers);
    const pB = normPlayerRoster(teamBPlayers);
    if (pA && pB) {
      if (pA === pB) return false;
    } else if (!isGeneric(cleanA)) {
      return false;
    }
  }

  if (!stage) return true;

  // Non-bracket stages (e.g. Finals, Semifinals, Exhibition) are not pool play brackets
  const match = stage.match(/(?:bracket|pool)\s*([a-z])\b/i);
  if (!match) {
    return true; // Knockout or exhibition match
  }

  const bracketLetter = match[1]!.toUpperCase();

  const isSlotMatch = (slot: any, cleanName: string, teamId?: string, players?: string[]): boolean => {
    if (teamId && slot?.team?.id && slot.team.id === teamId) return true;
    const sName = (slot?.team?.name || slot?.name || "").replace(/\s+/g, " ").trim().toLowerCase();
    const p1 = normPlayerRoster(players);
    const p2 = normPlayerRoster(slot?.team?.players);
    if (p1 && p2) {
      return p1 === p2;
    }
    if (!sName || !cleanName) return false;

    if (sName === cleanName) {
      if (isGeneric(cleanName) && Boolean(p1) !== Boolean(p2)) {
        return false;
      }
      return true;
    }
    // Disallow substring collision on short team names (e.g. 'nv', 'dv', 'ro', 'dmd')
    if (sName.length >= 4 && cleanName.length >= 4 && !isGeneric(sName) && !isGeneric(cleanName)) {
      if (sName.includes(cleanName) || cleanName.includes(sName)) return true;
    }
    return false;
  };

  // Collect candidate group lists
  const allCandidateGroups: Array<any[]> = [];

  // Priority 1: Category-specific groups (Never mix other categories if categoryId is provided)
  if (tournamentSlug && categoryId) {
    const cached = getCachedDrawnGroups(tournamentSlug, categoryId);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      allCandidateGroups.push(cached);
    }
    const direct = readGroupsFromStorage(`dv_drawn_groups_${tournamentSlug}_${categoryId}`);
    if (direct && Array.isArray(direct) && direct.length > 0) {
      allCandidateGroups.push(direct);
    }
  }

  // Priority 2: Only fallback to scanning other keys if no category-specific groups were found
  if (allCandidateGroups.length === 0 && typeof localStorage !== "undefined") {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("dv_drawn_groups_")) {
          if (tournamentSlug && !key.includes(tournamentSlug)) continue;
          const parsed = readGroupsFromStorage(key);
          if (parsed && Array.isArray(parsed) && parsed.length > 0) {
            allCandidateGroups.push(parsed);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (allCandidateGroups.length === 0) {
    return true; // No draw found, allow match
  }

  for (const groups of allCandidateGroups) {
    // 0. If this category has drawn groups, verify that the bracket letter exists in this draw
    const hasGroupWithLetter = groups.some(
      (g: any) => (g.letter || g.bracketLetter)?.toUpperCase() === bracketLetter,
    );
    if (!hasGroupWithLetter) {
      return false;
    }

    // 1. Check target group directly
    const targetGroup = groups.find(
      (g: any) => (g.letter || g.bracketLetter)?.toUpperCase() === bracketLetter,
    );
    if (targetGroup && Array.isArray(targetGroup.slots)) {
      const hasA = targetGroup.slots.some((s: any) => isSlotMatch(s, cleanA, teamAId, teamAPlayers));
      const hasB = targetGroup.slots.some((s: any) => isSlotMatch(s, cleanB, teamBId, teamBPlayers));

      // Both belong to the target bracket
      if (hasA && hasB) {
        return true;
      }

      // If either team is not in this bracket of the active draw, this is not a valid match for this bracket
      return false;
    }

    // 2. Check if both teams belong together in a different bracket of this draw
    for (const grp of groups) {
      const letter = grp.letter?.toUpperCase();
      if (!letter || letter === bracketLetter || !Array.isArray(grp.slots)) continue;
      const inThisA = grp.slots.some((s: any) => isSlotMatch(s, cleanA, teamAId, teamAPlayers));
      const inThisB = grp.slots.some((s: any) => isSlotMatch(s, cleanB, teamBId, teamBPlayers));
      if (inThisA && inThisB) {
        return false; // Both belong to this OTHER bracket, not the target bracket!
      }
    }
  }

  return true;
}

export type KnockoutRoundName =
  | "Round of 32"
  | "Round of 16"
  | "Quarterfinal"
  | "Semifinal"
  | "Final"
  | "Bronze";

/**
 * Generates standard tournament fold seeding order for a power-of-2 bracket size (2..32).
 * Pairs top half vs bottom half recursively so #1 and #2 meet only in the Final,
 * and #1/#4 and #2/#3 meet in opposite Semifinals.
 */
export function generateTournamentSeedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const nextSize = order.length * 2;
    const nextOrder: number[] = [];
    for (const seed of order) {
      nextOrder.push(seed, nextSize + 1 - seed);
    }
    order = nextOrder;
  }
  return order;
}

/**
 * Maps a round's power-of-2 slot count to the canonical KnockoutMatch round name.
 */
export function getRoundNameForSize(roundBracketSize: number): Exclude<KnockoutRoundName, "Bronze"> {
  if (roundBracketSize >= 32) return "Round of 32";
  if (roundBracketSize >= 16) return "Round of 16";
  if (roundBracketSize >= 8) return "Quarterfinal";
  if (roundBracketSize >= 4) return "Semifinal";
  return "Final";
}

/**
 * Returns the Challonge-style display column header for a round.
 */
export function getDisplayRoundHeader(
  roundName: KnockoutRoundName,
  roundIndex: number,
  totalMainRounds: number,
): string {
  if (roundName === "Bronze") return "3rd Place";
  if (roundName === "Final") return "Finals";
  if (roundName === "Semifinal") return "Semifinals";
  if (totalMainRounds >= 4 && roundIndex === 0) return "Round 1";
  if (totalMainRounds >= 4 && roundIndex === 1) return "Round 2";
  if (roundName === "Quarterfinal") return "Quarterfinals";
  if (roundName === "Round of 16") return "Round of 16";
  return "Round of 32";
}

export interface FoldParticipantInput<T> {
  seedNumber: number; // 1-indexed overall seed
  poolLetter?: string | undefined; // Used for Round 0 same-pool rematch prevention
  seedLabel: string;
  byeSeedLabel?: string | undefined;
  item: T;
}

export interface PlannedKnockoutMatch<T> {
  id: string;
  round: KnockoutRoundName;
  roundIndex: number; // 0-indexed main bracket round (Bronze uses totalMainRounds - 1)
  slotIndex: number; // 0-indexed position in that power-of-2 round column
  matchNumber: number; // Sequential 1..M across playable matches
  label: string;
  seedA?: string | undefined;
  seedB?: string | undefined;
  participantA?: T | undefined;
  participantB?: T | undefined;
  feedWinnerTo?: { matchId: string; slot: "teamA" | "teamB" } | undefined;
  feedLoserTo?: { matchId: string; slot: "teamA" | "teamB" } | undefined;
}

export interface FoldBracketPlan<T> {
  totalTeams: number;
  bracketSize: number;
  totalMainRounds: number;
  matches: PlannedKnockoutMatch<T>[];
}

function getRoundIdPrefix(round: Exclude<KnockoutRoundName, "Bronze">): string {
  switch (round) {
    case "Round of 32":
      return "r32";
    case "Round of 16":
      return "r16";
    case "Quarterfinal":
      return "qf";
    case "Semifinal":
      return "sf";
    case "Final":
      return "final";
  }
}

/**
 * Unified dynamic fold-bracket planner supporting any team count 2..32
 * (or custom fixed bracket capacities 2, 4, 8, 16, 32).
 *
 * - Pads to smallest power of 2 >= N (`P` in {2, 4, 8, 16, 32}).
 * - Optionally swaps adjacent Round 0 pairings to avoid same-pool rematches
 *   when `participantA` and `participantB` share a non-empty `poolLetter`.
 * - When `skipByes` is true (default), Round 0 pairs where `botSeed > N`
 *   do not create dummy BYE match cards; the top seed advances directly into
 *   their Round 1 target slot while preserving binary `slotIndex` values for tree alignment.
 */
export function buildFoldBracketPlan<T>(
  participants: FoldParticipantInput<T>[],
  options: {
    bracketSizeOverride?: 2 | 4 | 8 | 16 | 32 | undefined;
    skipByes?: boolean | undefined;
    includeBronze?: boolean | undefined;
  } = {},
): FoldBracketPlan<T> {
  const skipByes = options.skipByes ?? true;
  const includeBronze = options.includeBronze ?? true;
  const clampedCount = Math.min(participants.length, 32);

  let bracketSize = options.bracketSizeOverride ?? 2;
  if (!options.bracketSizeOverride) {
    while (bracketSize < Math.max(2, clampedCount) && bracketSize < 32) {
      bracketSize *= 2;
    }
  }

  const participantBySeed = new Map<number, FoldParticipantInput<T>>();
  for (const p of participants) {
    if (p.seedNumber >= 1 && p.seedNumber <= bracketSize) {
      participantBySeed.set(p.seedNumber, p);
    }
  }

  const seedOrder = generateTournamentSeedOrder(bracketSize);
  const r0PairCount = bracketSize / 2;
  const r0Pairs: Array<{ topSeed: number; botSeed: number }> = [];
  for (let i = 0; i < r0PairCount; i++) {
    r0Pairs.push({
      topSeed: seedOrder[i * 2] ?? i * 2 + 1,
      botSeed: seedOrder[i * 2 + 1] ?? bracketSize - i,
    });
  }

  // Round 0 same-pool rematch prevention among real non-BYE matches.
  // Swaps `botSeed` with the closest non-BYE opponent that resolves both same-pool conflicts.
  if (r0PairCount > 1) {
    for (let i = 0; i < r0Pairs.length; i++) {
      const pairI = r0Pairs[i];
      if (!pairI) continue;
      const pA = participantBySeed.get(pairI.topSeed);
      const pB = participantBySeed.get(pairI.botSeed);
      if (!pA || !pB) continue;
      if (!pA.poolLetter || !pB.poolLetter || pA.poolLetter !== pB.poolLetter) continue;

      let bestJ = -1;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (let j = 0; j < r0Pairs.length; j++) {
        if (i === j) continue;
        const pairJ = r0Pairs[j];
        if (!pairJ) continue;
        const oTop = participantBySeed.get(pairJ.topSeed);
        const oBot = participantBySeed.get(pairJ.botSeed);
        // Only swap against another real seeded opponent (never pull a BYE into a real slot or vice versa)
        if (!oTop || !oBot) continue;
        const okI = !oBot.poolLetter || oBot.poolLetter !== pA.poolLetter;
        const okJ = !oTop.poolLetter || !pB.poolLetter || oTop.poolLetter !== pB.poolLetter;
        if (!okI || !okJ) continue;

        const delta = Math.abs(pairI.botSeed - pairJ.botSeed);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestJ = j;
        }
      }

      if (bestJ >= 0) {
        const pairJ = r0Pairs[bestJ];
        if (pairJ) {
          const tmp = pairI.botSeed;
          pairI.botSeed = pairJ.botSeed;
          pairJ.botSeed = tmp;
        }
      }
    }
  }

  const totalMainRounds = Math.round(Math.log2(bracketSize));
  const roundsMeta: Array<{
    roundIndex: number;
    roundSize: number;
    roundName: Exclude<KnockoutRoundName, "Bronze">;
    matchCount: number;
    idPrefix: string;
  }> = [];

  for (let r = 0; r < totalMainRounds; r++) {
    const roundSize = bracketSize / Math.pow(2, r);
    const roundName = getRoundNameForSize(roundSize);
    roundsMeta.push({
      roundIndex: r,
      roundSize,
      roundName,
      matchCount: roundSize / 2,
      idPrefix: getRoundIdPrefix(roundName),
    });
  }

  const getMatchId = (roundIndex: number, slotIndex: number): string => {
    const meta = roundsMeta[roundIndex];
    if (!meta || meta.roundName === "Final") return "md-final";
    return `md-${meta.idPrefix}-${slotIndex + 1}`;
  };

  // Pre-seed Round 1 direct BYE advances when skipByes is enabled.
  const directAdvances = new Map<
    string,
    {
      seedA?: string | undefined;
      seedB?: string | undefined;
      participantA?: T | undefined;
      participantB?: T | undefined;
    }
  >();

  const setDirectAdvance = (
    targetMatchId: string,
    slot: "teamA" | "teamB",
    p: FoldParticipantInput<T>,
  ) => {
    const existing = directAdvances.get(targetMatchId) || {};
    const label = p.byeSeedLabel ?? p.seedLabel;
    if (slot === "teamA") {
      existing.participantA = p.item;
      existing.seedA = label;
    } else {
      existing.participantB = p.item;
      existing.seedB = label;
    }
    directAdvances.set(targetMatchId, existing);
  };

  const playableRoundSlots: Array<{
    roundIndex: number;
    slotIndex: number;
    pair?: { topSeed: number; botSeed: number } | undefined;
  }> = [];

  for (let r = 0; r < totalMainRounds; r++) {
    const meta = roundsMeta[r];
    if (!meta) continue;
    for (let s = 0; s < meta.matchCount; s++) {
      if (r === 0) {
        const pair = r0Pairs[s];
        if (!pair) continue;
        const pTop = participantBySeed.get(pair.topSeed);
        const pBot = participantBySeed.get(pair.botSeed);
        const hasTwoSidesOrCustom = !skipByes || (Boolean(pTop) && Boolean(pBot));

        if (!hasTwoSidesOrCustom) {
          // Off-court Round 0 BYE resolution: advance existing seed directly into Round 1
          const winnerP = pTop ?? pBot;
          if (winnerP && r + 1 < totalMainRounds) {
            const targetMatchId = getMatchId(r + 1, Math.floor(s / 2));
            const targetSlot: "teamA" | "teamB" = s % 2 === 0 ? "teamA" : "teamB";
            setDirectAdvance(targetMatchId, targetSlot, winnerP);
          }
          continue;
        }
        playableRoundSlots.push({ roundIndex: r, slotIndex: s, pair });
      } else {
        playableRoundSlots.push({ roundIndex: r, slotIndex: s });
      }
    }
  }

  // Keep track of created matches by roundIndex:slotIndex so downstream rounds reference the exact sequential match label.
  const roundSequentialCounter = new Map<number, number>();
  const createdByRoundSlot = new Map<string, { perRoundNum: number; roundName: KnockoutRoundName; matchNumber: number }>();
  const matches: PlannedKnockoutMatch<T>[] = [];
  let seqMatchNum = 1;

  for (const entry of playableRoundSlots) {
    const { roundIndex, slotIndex, pair } = entry;
    const meta = roundsMeta[roundIndex];
    if (!meta) continue;
    const perRoundNum = (roundSequentialCounter.get(roundIndex) || 0) + 1;
    roundSequentialCounter.set(roundIndex, perRoundNum);

    const id = getMatchId(roundIndex, slotIndex);
    const feedWinnerTo =
      roundIndex + 1 < totalMainRounds
        ? {
            matchId: getMatchId(roundIndex + 1, Math.floor(slotIndex / 2)),
            slot: (slotIndex % 2 === 0 ? "teamA" : "teamB") as "teamA" | "teamB",
          }
        : undefined;

    const feedLoserTo =
      includeBronze && meta.roundName === "Semifinal" && totalMainRounds >= 2
        ? {
            matchId: "md-bronze",
            slot: (slotIndex === 0 ? "teamA" : "teamB") as "teamA" | "teamB",
          }
        : undefined;

    let label: string;
    if (meta.roundName === "Final") {
      label = "Championship Final";
    } else if (meta.roundName === "Round of 32" || meta.roundName === "Round of 16") {
      label = `${meta.roundName} - Match ${perRoundNum}`;
    } else if (meta.matchCount > 1) {
      label = `${meta.roundName} ${perRoundNum}`;
    } else {
      label = meta.roundName;
    }

    let seedA: string | undefined;
    let seedB: string | undefined;
    let participantA: T | undefined;
    let participantB: T | undefined;

    if (roundIndex === 0 && pair) {
      const pTop = participantBySeed.get(pair.topSeed);
      const pBot = participantBySeed.get(pair.botSeed);
      seedA = pTop?.seedLabel ?? `#${pair.topSeed}`;
      seedB = pBot?.seedLabel ?? `#${pair.botSeed}`;
      participantA = pTop?.item;
      participantB = pBot?.item;
    } else {
      const direct = directAdvances.get(id);
      const prevRoundName = roundIndex > 0 ? roundsMeta[roundIndex - 1]?.roundName : undefined;
      const feederLabel = (feederSlot: number) => {
        if (!prevRoundName) return "TBD";
        const created = createdByRoundSlot.get(`${roundIndex - 1}:${feederSlot}`);
        const num = created ? created.perRoundNum : feederSlot + 1;
        const shortTag =
          prevRoundName === "Quarterfinal"
            ? "QF"
            : prevRoundName === "Semifinal"
              ? "SF"
              : prevRoundName === "Round of 16"
                ? "R16"
                : "R32";
        return `Winner ${shortTag} ${num}`;
      };

      seedA = direct?.seedA ?? feederLabel(slotIndex * 2);
      seedB = direct?.seedB ?? feederLabel(slotIndex * 2 + 1);
      participantA = direct?.participantA;
      participantB = direct?.participantB;
    }

    createdByRoundSlot.set(`${roundIndex}:${slotIndex}`, {
      perRoundNum,
      roundName: meta.roundName,
      matchNumber: seqMatchNum,
    });

    matches.push({
      id,
      round: meta.roundName,
      roundIndex,
      slotIndex,
      matchNumber: seqMatchNum++,
      label,
      seedA,
      seedB,
      participantA,
      participantB,
      feedWinnerTo,
      feedLoserTo,
    });
  }

  // Bronze Medal match for brackets with Semifinals (at least 4 teams or unskipped custom template >= 4)
  if (includeBronze && bracketSize >= 4 && (!skipByes || clampedCount >= 4)) {
    matches.push({
      id: "md-bronze",
      round: "Bronze",
      roundIndex: totalMainRounds - 1,
      slotIndex: 1,
      matchNumber: seqMatchNum++,
      label: "3rd Place Match",
      seedA: "Runner-up of Semifinal 1",
      seedB: "Runner-up of Semifinal 2",
    });
  }

  return {
    totalTeams: participants.length,
    bracketSize,
    totalMainRounds,
    matches,
  };
}
