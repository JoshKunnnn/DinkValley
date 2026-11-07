import { useState, useMemo, useEffect, useCallback } from "react";
import type { Team, Tournament, Category } from "@/data/tournaments";
import { getDrawnGroups } from "./BracketDraw";
import {
  useMatchStore,
  getMatches,
  saveMatches,
  sanitizeCourtName,
  type LiveMatch,
  createPairMatchId,
  createCategoryScopedMatchId,
  findMatchForPair,
  markLocalMatchDeleted,
  markLocalMatchMutation,
  createInitialScore,
  getMatchTeamDisplay,
  isGenericTeamName,
  resolveMatchWinnerSide,
} from "@/lib/match-store";
import { getDispatchQueue, saveDispatchQueue } from "@/lib/court-dispatch";
import {
  dbSaveMainDraw,
  dbDeleteMainDraw,
  getCachedMainDraw,
  clearMainDrawCache,
  isSameCategory,
  isDrawResetMarked,
  dbDeleteMatchesBatch,
  dbSaveMatch,
} from "@/lib/supabase-service";

export type BracketMatch = {
  id: string;
  court: string;
  teamAId: string;
  teamBId: string;
  scoreA: number | undefined;
  scoreB: number | undefined;
  status: "scheduled" | "in_progress" | "completed";
};

export type BracketGroup = {
  id: string;
  name: string;
  teams: Team[];
  matches: BracketMatch[];
};

export type KnockoutMatch = {
  id: string;
  round: "Round of 16" | "Quarterfinal" | "Semifinal" | "Final" | "Bronze";
  label: string;
  teamA?: Team | undefined;
  teamB?: Team | undefined;
  manualTeamA?: boolean | undefined;
  manualTeamB?: boolean | undefined;
  seedA?: string | undefined;
  seedB?: string | undefined;
  scoreA?: number | undefined;
  scoreB?: number | undefined;
  winner?: Team | undefined;
  court: string;
  feedWinnerTo?: { matchId: string; slot: "teamA" | "teamB" } | undefined;
  feedLoserTo?: { matchId: string; slot: "teamA" | "teamB" } | undefined;
};

export type StandingRow = {
  team: Team;
  played: number;
  won: number;
  lost: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  isQualified: boolean;
  rank: number;
};

export type Qualifier = {
  team: Team;
  bracketLetter: string;
  bracketName: string;
  bracketRank: number; // 1 (Winner) or 2 (Runner-Up)
  bracketSeed: string; // e.g. "A1", "B2"
  won: number;
  lost: number;
  played: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  overallSeed: number; // 1 to N based on Point Differential
};

/* ─────────────────────────────────────────────
   Persistence Helpers for Main Draw Knockout
───────────────────────────────────────────── */

const MAIN_DRAW_KEY = (slug: string, catId: string) => `dv_main_draw_${slug}_${catId}`;

export function saveMainDrawMatches(slug: string, catId: string, matches: KnockoutMatch[]) {
  try {
    const cached = getMainDrawMatches(slug, catId);
    if (cached && JSON.stringify(cached) === JSON.stringify(matches)) {
      return;
    }
    dbSaveMainDraw(slug, catId, matches).catch((err) => {
      console.warn("[Supabase] Failed to save main draw:", err);
    });
    try {
      localStorage.setItem(MAIN_DRAW_KEY(slug, catId), JSON.stringify(matches));
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event("dv_main_draw_updated"));
    window.dispatchEvent(new Event("storage"));
  } catch {
    // ignore
  }
}

export function resetMainDrawMatches(slug: string, catId: string) {
  clearMainDrawCache(slug, catId);
  try {
    dbDeleteMainDraw(slug, catId).catch(() => {});
    try {
      localStorage.removeItem(MAIN_DRAW_KEY(slug, catId));
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`dv_main_draw_${slug}_`)) {
          const suffix = k.substring(`dv_main_draw_${slug}_`.length);
          if (suffix === catId || isSameCategory(suffix, catId)) {
            localStorage.removeItem(k);
          }
        }
      }
      const allMatches = getMatches();
      const koIdsToDelete: string[] = [];
      const retained = allMatches.filter((m) => {
        const isTargetCat = m.categoryId && isSameCategory(m.categoryId, catId);
        const isKoStage =
          !m.stage?.includes("Pool Play") &&
          !m.stage?.includes("Bracket ") &&
          (m.id.startsWith("live-ko-") ||
            /quarter|semi|final|playoff|bronze|gold|knockout|round of 16/i.test(m.stage || ""));
        if (isTargetCat && isKoStage) {
          koIdsToDelete.push(m.id);
          markLocalMatchDeleted(m.id);
          return false;
        }
        return true;
      });
      if (koIdsToDelete.length > 0) {
        saveMatches(retained, false);
        dbDeleteMatchesBatch(koIdsToDelete).catch(() => {});
      }
    } catch {
      // ignore
    }
    window.dispatchEvent(new Event("dv_main_draw_updated"));
    window.dispatchEvent(new Event("storage"));
  } catch {
    // ignore
  }
}

export function getMainDrawMatches(slug: string, catId: string): KnockoutMatch[] | null {
  if (!slug || !catId || isDrawResetMarked(slug, catId)) return null;
  const cached = getCachedMainDraw(slug, catId);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached as KnockoutMatch[];
  }

  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(MAIN_DRAW_KEY(slug, catId)) : null;
    let parsed: KnockoutMatch[] | null = null;
    if (raw) {
      try {
        const val = JSON.parse(raw);
        if (Array.isArray(val) && val.length > 0) parsed = val;
      } catch {
        // ignore
      }
    }

    // Fallback: check other keys in localStorage matching slug and catId alias
    if (!parsed && typeof localStorage !== "undefined") {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`dv_main_draw_${slug}_`)) {
          const suffix = k.replace(`dv_main_draw_${slug}_`, "").toLowerCase();
          const target = (catId || "").toLowerCase();
          if (suffix === target || isSameCategory(suffix, target)) {
            const rawVal = localStorage.getItem(k);
            if (rawVal) {
              try {
                const val = JSON.parse(rawVal);
                if (Array.isArray(val) && val.length > 0) {
                  parsed = val;
                  break;
                }
              } catch {
                // ignore
              }
            }
          }
        }
      }
    }

    if (!parsed || !Array.isArray(parsed)) return null;

    let modified = false;
    const sanitized = parsed.map((m) => {
      const cleanCourt = sanitizeCourtName(m.court);
      if (cleanCourt !== m.court) {
        modified = true;
        return { ...m, court: cleanCourt };
      }
      return m;
    });

    if (modified && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(MAIN_DRAW_KEY(slug, catId), JSON.stringify(sanitized));
      } catch {
        // ignore
      }
    }
    return sanitized;
  } catch {
    return null;
  }
}

function normalizePlayoffPlayers(players?: string[]): string {
  return (players || [])
    .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
    .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((p) => Boolean(p) && !isGenericTeamName(p))
    .sort()
    .join("|");
}

function isSamePlayoffTeam(t1?: Team, t2?: Team): boolean {
  if (!t1 && !t2) return true;
  if (!t1 || !t2) return false;
  if (t1.id && t2.id && t1.id === t2.id) return true;
  const p1 = normalizePlayoffPlayers(t1.players);
  const p2 = normalizePlayoffPlayers(t2.players);
  if (p1 && p2) return p1 === p2;
  const n1 = t1.name.replace(/\s+/g, " ").trim().toLowerCase();
  const n2 = t2.name.replace(/\s+/g, " ").trim().toLowerCase();
  if (!isGenericTeamName(n1) && !isGenericTeamName(n2)) {
    return n1 === n2;
  }
  return false;
}

function isExactSamePlayoffTeam(t1?: Team, t2?: Team): boolean {
  if (!isSamePlayoffTeam(t1, t2)) return false;
  if (!t1 && !t2) return true;
  if (!t1 || !t2) return false;
  return (
    t1.name === t2.name &&
    (t1.club || "") === (t2.club || "") &&
    JSON.stringify(t1.players || []) === JSON.stringify(t2.players || [])
  );
}

/**
 * Executes automatic tournament bracket advancement rules across rounds:
 * Round of 16 -> Quarterfinals -> Semifinals -> Finals & Bronze
 * Supports dynamic linkages (feedWinnerTo / feedLoserTo) with automatic cascading,
 * while preserving any manually overridden slots (manualTeamA / manualTeamB).
 */
export function advancePlayoffBracket(matches: KnockoutMatch[]): { updated: KnockoutMatch[]; hasChanges: boolean } {
  let hasChanges = false;
  let updated = matches.map((m) => ({ ...m }));

  const isSlotManual = (target: KnockoutMatch, slot: "teamA" | "teamB") =>
    slot === "teamA" ? Boolean(target.manualTeamA) : Boolean(target.manualTeamB);

  const hasMetadata = updated.some((m) => m.feedWinnerTo !== undefined);

  if (hasMetadata) {
    let passChanged = true;
    let passes = 0;
    while (passChanged && passes < 4) {
      passChanged = false;
      passes++;

      for (const m of updated) {
        if (m.winner) {
          if (m.feedWinnerTo) {
            const targetIdx = updated.findIndex((x) => x.id === m.feedWinnerTo!.matchId);
            if (targetIdx !== -1) {
              const target = updated[targetIdx]!;
              const slot = m.feedWinnerTo.slot;
              if (!isSlotManual(target, slot) && !isExactSamePlayoffTeam(target[slot], m.winner)) {
                const identityChanged = !isSamePlayoffTeam(target[slot], m.winner);
                const nextTarget: KnockoutMatch = {
                  ...target,
                  [slot]: m.winner,
                };
                if (identityChanged && target[slot] !== undefined) {
                  nextTarget.winner = undefined;
                  nextTarget.scoreA = undefined;
                  nextTarget.scoreB = undefined;
                } else if (nextTarget.winner && isSamePlayoffTeam(nextTarget.winner, m.winner)) {
                  nextTarget.winner = m.winner;
                }
                updated[targetIdx] = nextTarget;
                passChanged = true;
                hasChanges = true;
              }
            }
          }
          if (m.feedLoserTo && m.teamA && m.teamB) {
            const isAWinner = isSamePlayoffTeam(m.winner, m.teamA);
            const loser = isAWinner ? m.teamB : m.teamA;
            const targetIdx = updated.findIndex((x) => x.id === m.feedLoserTo!.matchId);
            if (targetIdx !== -1 && loser) {
              const target = updated[targetIdx]!;
              const slot = m.feedLoserTo.slot;
              if (!isSlotManual(target, slot) && !isExactSamePlayoffTeam(target[slot], loser)) {
                const identityChanged = !isSamePlayoffTeam(target[slot], loser);
                const nextTarget: KnockoutMatch = {
                  ...target,
                  [slot]: loser,
                };
                if (identityChanged && target[slot] !== undefined) {
                  nextTarget.winner = undefined;
                  nextTarget.scoreA = undefined;
                  nextTarget.scoreB = undefined;
                } else if (nextTarget.winner && isSamePlayoffTeam(nextTarget.winner, loser)) {
                  nextTarget.winner = loser;
                }
                updated[targetIdx] = nextTarget;
                passChanged = true;
                hasChanges = true;
              }
            }
          }
        } else {
          // If a match score was reset and winner was removed, clear the downstream fed slot unless manually overridden
          if (m.feedWinnerTo) {
            const targetIdx = updated.findIndex((x) => x.id === m.feedWinnerTo!.matchId);
            if (targetIdx !== -1) {
              const target = updated[targetIdx]!;
              const slot = m.feedWinnerTo.slot;
              if (!isSlotManual(target, slot) && target[slot] !== undefined) {
                updated[targetIdx] = {
                  ...target,
                  [slot]: undefined,
                  winner: undefined,
                  scoreA: undefined,
                  scoreB: undefined,
                };
                passChanged = true;
                hasChanges = true;
              }
            }
          }
          if (m.feedLoserTo) {
            const targetIdx = updated.findIndex((x) => x.id === m.feedLoserTo!.matchId);
            if (targetIdx !== -1) {
              const target = updated[targetIdx]!;
              const slot = m.feedLoserTo.slot;
              if (!isSlotManual(target, slot) && target[slot] !== undefined) {
                updated[targetIdx] = {
                  ...target,
                  [slot]: undefined,
                  winner: undefined,
                  scoreA: undefined,
                  scoreB: undefined,
                };
                passChanged = true;
                hasChanges = true;
              }
            }
          }
        }
      }
    }
  } else {
    // Legacy fallback for brackets saved without feedWinnerTo metadata
    const r16Matches = updated.filter((m) => m.round === "Round of 16");
    if (r16Matches.length > 0) {
      const getWinner = (id: string) => updated.find((m) => m.id === id)?.winner;

      updated = updated.map((m) => {
        let teamA = m.teamA;
        let teamB = m.teamB;
        if (m.id === "md-qf-1") {
          if (!m.manualTeamA) teamA = getWinner("md-r16-1") ?? m.teamA;
          if (!m.manualTeamB) teamB = getWinner("md-r16-2") ?? m.teamB;
        } else if (m.id === "md-qf-2") {
          if (!m.manualTeamA) teamA = getWinner("md-r16-3") ?? m.teamA;
          if (!m.manualTeamB) teamB = getWinner("md-r16-4") ?? m.teamB;
        } else if (m.id === "md-qf-3") {
          if (!m.manualTeamA) teamA = getWinner("md-r16-5") ?? m.teamA;
          if (!m.manualTeamB) teamB = getWinner("md-r16-6") ?? m.teamB;
        } else if (m.id === "md-qf-4") {
          if (!m.manualTeamA) teamA = getWinner("md-r16-7") ?? m.teamA;
          if (!m.manualTeamB) teamB = getWinner("md-r16-8") ?? m.teamB;
        }
        if (!isExactSamePlayoffTeam(teamA, m.teamA) || !isExactSamePlayoffTeam(teamB, m.teamB)) {
          hasChanges = true;
          return { ...m, teamA, teamB };
        }
        return m;
      });
    }

    const qfMatches = updated.filter((m) => m.round === "Quarterfinal");
    if (qfMatches.length > 0) {
      const qf1 = updated.find((m) => m.id === "md-qf-1");
      const qf2 = updated.find((m) => m.id === "md-qf-2");
      const qf3 = updated.find((m) => m.id === "md-qf-3");
      const qf4 = updated.find((m) => m.id === "md-qf-4");

      updated = updated.map((m) => {
        let teamA = m.teamA;
        let teamB = m.teamB;
        if (m.id === "md-sf-1") {
          if (!m.manualTeamA) teamA = qf1?.winner ?? m.teamA;
          if (!m.manualTeamB) teamB = qf2?.winner ?? m.teamB;
        } else if (m.id === "md-sf-2") {
          if (!m.manualTeamA) teamA = qf3?.winner ?? m.teamA;
          if (!m.manualTeamB) teamB = qf4?.winner ?? m.teamB;
        }
        if (!isExactSamePlayoffTeam(teamA, m.teamA) || !isExactSamePlayoffTeam(teamB, m.teamB)) {
          hasChanges = true;
          return { ...m, teamA, teamB };
        }
        return m;
      });
    }

    const sf1 = updated.find((m) => m.id === "md-sf-1");
    const sf2 = updated.find((m) => m.id === "md-sf-2");

    updated = updated.map((m) => {
      if (m.id === "md-final") {
        const teamA = m.manualTeamA ? m.teamA : (sf1?.winner ?? m.teamA);
        const teamB = m.manualTeamB ? m.teamB : (sf2?.winner ?? m.teamB);
        if (!isExactSamePlayoffTeam(teamA, m.teamA) || !isExactSamePlayoffTeam(teamB, m.teamB)) {
          hasChanges = true;
          return { ...m, teamA, teamB };
        }
      }
      if (m.id === "md-bronze") {
        let teamA = m.teamA;
        let teamB = m.teamB;
        if (!m.manualTeamA && sf1?.winner && sf1.teamA && sf1.teamB) {
          const isAWinner = isSamePlayoffTeam(sf1.winner, sf1.teamA);
          teamA = isAWinner ? sf1.teamB : sf1.teamA;
        }
        if (!m.manualTeamB && sf2?.winner && sf2.teamA && sf2.teamB) {
          const isAWinner = isSamePlayoffTeam(sf2.winner, sf2.teamA);
          teamB = isAWinner ? sf2.teamB : sf2.teamA;
        }
        if (!isExactSamePlayoffTeam(teamA, m.teamA) || !isExactSamePlayoffTeam(teamB, m.teamB)) {
          hasChanges = true;
          return { ...m, teamA, teamB };
        }
      }
      return m;
    });
  }

  return { updated, hasChanges };
}

/**
 * Automatically synchronizes playoff knockout matches with completed/live matches
 * from the live court match store and advances winners to subsequent rounds.
 */
export function syncMainDrawWithLiveMatches(
  tournamentSlug: string,
  categoryId: string,
  liveMatches?: LiveMatch[],
  persist: boolean = true,
): KnockoutMatch[] | null {
  const currentDraw = getMainDrawMatches(tournamentSlug, categoryId);
  if (!currentDraw || currentDraw.length === 0) return null;

  const matches = liveMatches ?? getMatches();
  let modified = false;

  const koScopedMatches = matches.filter((m) => {
    if (tournamentSlug && m.tournamentSlug && m.tournamentSlug !== tournamentSlug) return false;
    if (m.categoryId && !isSameCategory(m.categoryId, categoryId)) return false;
    if (m.stage?.includes("Pool Play") || m.stage?.includes("Bracket ")) return false;
    return true;
  });

  const claimedLiveIds = new Set<string>();

  const updatedMatches = currentDraw.map((km) => {
    if (!km.teamA || !km.teamB) return km;

    const nameA = km.teamA.name.replace(/\s+/g, " ").trim().toLowerCase();
    const nameB = km.teamB.name.replace(/\s+/g, " ").trim().toLowerCase();
    const pA = normalizePlayoffPlayers(km.teamA.players);
    const pB = normalizePlayoffPlayers(km.teamB.players);

    const stage = `${km.round} - ${km.label}`;
    const legacyId = `live-ko-${tournamentSlug}-${categoryId}-${km.id}`;
    const canonicalId = createPairMatchId(
      tournamentSlug,
      categoryId,
      stage,
      km.teamA.name,
      km.teamB.name,
      km.teamA.players,
      km.teamB.players,
    );

    const unclaimedKoMatches = koScopedMatches.filter((m) => !claimedLiveIds.has(m.id));
    const live =
      unclaimedKoMatches.find((m) => m.id === canonicalId || m.id === legacyId || m.id === km.id) ||
      findMatchForPair(
        unclaimedKoMatches,
        km.teamA.name,
        km.teamB.name,
        tournamentSlug,
        categoryId,
        stage,
        km.teamA.players,
        km.teamB.players,
      );

    if (!live) return km;
    claimedLiveIds.add(live.id);

    let nextKm = { ...km };

    // Determine side alignment using player rosters first so generic "n/a" team names never flip scores
    const lpA = normalizePlayoffPlayers(live.teamAPlayers);
    const lpB = normalizePlayoffPlayers(live.teamBPlayers);
    const liveAName = (live.teamAName || "").replace(/\s+/g, " ").trim().toLowerCase();

    let isSameOrder = true;
    if (pA && lpA && (pA !== pB || lpA !== lpB)) {
      if (pA === lpA || (pB && lpB && pB === lpB)) {
        isSameOrder = true;
      } else if (pA === lpB || (pB && pB === lpA)) {
        isSameOrder = false;
      }
    } else if (nameA !== nameB) {
      isSameOrder = liveAName !== nameB;
    }

    const scoreA = isSameOrder ? live.score?.teamAScore : live.score?.teamBScore;
    const scoreB = isSameOrder ? live.score?.teamBScore : live.score?.teamAScore;

    if (scoreA !== undefined && scoreA !== nextKm.scoreA) {
      nextKm.scoreA = scoreA;
      modified = true;
    }
    if (scoreB !== undefined && scoreB !== nextKm.scoreB) {
      nextKm.scoreB = scoreB;
      modified = true;
    }

    // Determine winner accurately
    const isFinished =
      live.status === "final" ||
      Boolean(live.winnerTeam) ||
      (scoreA !== undefined &&
        scoreB !== undefined &&
        (scoreA >= 11 || scoreB >= 11) &&
        Math.abs(scoreA - scoreB) >= 2);

    if (isFinished) {
      let winningTeam: Team | undefined;
      if (scoreA !== undefined && scoreB !== undefined && scoreA !== scoreB) {
        winningTeam = scoreA > scoreB ? km.teamA : km.teamB;
      } else {
        const liveSide = resolveMatchWinnerSide(live);
        if (liveSide === "A") {
          winningTeam = isSameOrder ? km.teamA : km.teamB;
        } else if (liveSide === "B") {
          winningTeam = isSameOrder ? km.teamB : km.teamA;
        }
      }

      if (winningTeam && (!nextKm.winner || !isExactSamePlayoffTeam(nextKm.winner, winningTeam))) {
        nextKm.winner = winningTeam;
        modified = true;
      }
    }

    return nextKm;
  });

  const { updated: advanced, hasChanges: advancedChanges } = advancePlayoffBracket(updatedMatches);

  if (modified || advancedChanges) {
    if (persist) {
      saveMainDrawMatches(tournamentSlug, categoryId, advanced);
      syncKnockoutToLiveMatches(tournamentSlug, categoryId, advanced);
    }
    return advanced;
  }

  return currentDraw;
}

/**
 * Syncs generated or manually edited playoff knockout matches to the live match store
 * and dispatch queue so umpires, court dispatch, and spectators stay in real-time sync.
 */
export function syncKnockoutToLiveMatches(
  tournamentSlug: string,
  categoryId: string,
  knockoutMatches: KnockoutMatch[],
): void {
  const current = getMatches();
  const newMatches: LiveMatch[] = [];
  const staleIdsToRemove = new Set<string>();

  const isTargetDivisionKoMatch = (m: LiveMatch) => {
    if (tournamentSlug && m.tournamentSlug && m.tournamentSlug !== tournamentSlug) return false;
    if (m.categoryId && !isSameCategory(m.categoryId, categoryId)) return false;
    if (!m.categoryId && !m.id.toLowerCase().includes(categoryId.toLowerCase())) return false;
    if (m.stage?.includes("Pool Play") || m.stage?.includes("Bracket ")) return false;
    return true;
  };

  let queueItems = getDispatchQueue();
  let queueModified = false;

  for (const km of knockoutMatches) {
    const stage = `${km.round} - ${km.label}`;
    const legacyId = `live-ko-${tournamentSlug}-${categoryId}-${km.id}`;

    const stageMatches = current.filter(
      (m) =>
        isTargetDivisionKoMatch(m) &&
        (m.stage === stage || m.id === legacyId || m.id === km.id),
    );

    if (!km.teamA || !km.teamB) {
      // Slot was cleared to TBD: remove any unplayed live match & queued item for this knockout stage
      for (const sm of stageMatches) {
        if (sm.status !== "final") {
          staleIdsToRemove.add(sm.id);
          markLocalMatchDeleted(sm.id);
        }
      }
      const prevQueueLen = queueItems.length;
      queueItems = queueItems.filter((q) => {
        const sameScope =
          (!tournamentSlug || q.tournamentSlug === tournamentSlug) &&
          isSameCategory(q.categoryId, categoryId) &&
          q.stage === stage &&
          q.status !== "completed";
        return !sameScope;
      });
      if (queueItems.length !== prevQueueLen) queueModified = true;
      continue;
    }

    const teamA = km.teamA;
    const teamB = km.teamB;
    const canonicalId = createPairMatchId(
      tournamentSlug,
      categoryId,
      stage,
      teamA.name,
      teamB.name,
      teamA.players,
      teamB.players,
    );
    const cleanCourt = sanitizeCourtName(km.court);

    const exactPairMatch = findMatchForPair(
      current.filter(isTargetDivisionKoMatch),
      teamA.name,
      teamB.name,
      tournamentSlug,
      categoryId,
      stage,
      teamA.players,
      teamB.players,
    );

    const activeStageMatch = stageMatches.find((m) => m.status !== "final");
    const resettableFinalStageMatch =
      !km.winner && km.scoreA === undefined && km.scoreB === undefined
        ? stageMatches.find((m) => m.status === "final")
        : undefined;

    const existing = exactPairMatch || activeStageMatch || resettableFinalStageMatch;

    // Mark any extra duplicate records on this exact stage for removal
    for (const sm of stageMatches) {
      if (sm.id !== existing?.id && (sm.status !== "final" || (!km.winner && km.scoreA === undefined && km.scoreB === undefined))) {
        staleIdsToRemove.add(sm.id);
        markLocalMatchDeleted(sm.id);
      }
    }

    const dispWinner = km.winner
      ? getMatchTeamDisplay(km.winner.name, km.winner.players, km.winner.name).primary
      : undefined;

    if (existing) {
      const canUpgradeScheduledId =
        existing.status === "scheduled" &&
        (!existing.court || existing.court === "Queue") &&
        !existing.id.startsWith("live-ko-") &&
        !existing.id.startsWith("match_") &&
        existing.id !== canonicalId;
      if (canUpgradeScheduledId) {
        staleIdsToRemove.add(existing.id);
        markLocalMatchDeleted(existing.id);
      }
      const effectiveId = canUpgradeScheduledId ? canonicalId : existing.id;
      const isPairUnchanged = Boolean(exactPairMatch && exactPairMatch.id === existing.id);
      const shouldResetScore =
        !isPairUnchanged || (!km.winner && km.scoreA === undefined && km.scoreB === undefined && existing.status === "final");

      const nextStatus: LiveMatch["status"] = km.winner
        ? "final"
        : shouldResetScore
          ? existing.court && existing.court !== "Queue" && existing.status === "live"
            ? "live"
            : "scheduled"
          : existing.status;

      const nextScore = shouldResetScore
        ? {
            ...createInitialScore(),
            teamAScore: km.scoreA ?? 0,
            teamBScore: km.scoreB ?? 0,
          }
        : {
            ...(existing.score || createInitialScore()),
            teamAScore: km.scoreA ?? existing.score?.teamAScore ?? 0,
            teamBScore: km.scoreB ?? existing.score?.teamBScore ?? 0,
          };

      const updatedRecord: LiveMatch = {
        ...existing,
        id: effectiveId,
        court: sanitizeCourtName(existing.court),
        tournamentSlug: tournamentSlug || existing.tournamentSlug,
        categoryId: categoryId || existing.categoryId,
        stage,
        teamAName: teamA.name,
        teamAPlayers: teamA.players,
        teamAClub: teamA.club || existing.teamAClub,
        teamBName: teamB.name,
        teamBPlayers: teamB.players,
        teamBClub: teamB.club || existing.teamBClub,
        score: nextScore,
        winnerTeam: km.winner ? dispWinner : shouldResetScore ? undefined : existing.winnerTeam,
        status: nextStatus,
        endedAt: km.winner ? (existing.endedAt || Date.now()) : shouldResetScore ? undefined : existing.endedAt,
      };

      markLocalMatchMutation(effectiveId);
      newMatches.push(updatedRecord);

      // Update any matching dispatch queue item in place
      queueItems = queueItems.map((q) => {
        const matchesStageOrId =
          q.status !== "completed" &&
          (!tournamentSlug || q.tournamentSlug === tournamentSlug) &&
          isSameCategory(q.categoryId, categoryId) &&
          (q.matchId === effectiveId || q.matchId === legacyId || q.matchId === canonicalId || q.stage === stage);
        if (!matchesStageOrId) return q;
        if (
          q.matchId === effectiveId &&
          q.teamAName === teamA.name &&
          q.teamBName === teamB.name &&
          JSON.stringify(q.teamAPlayers) === JSON.stringify(teamA.players) &&
          JSON.stringify(q.teamBPlayers) === JSON.stringify(teamB.players)
        ) {
          return q;
        }
        queueModified = true;
        return {
          ...q,
          matchId: effectiveId,
          stage,
          teamAName: teamA.name,
          teamAPlayers: teamA.players,
          teamAClub: teamA.club,
          teamBName: teamB.name,
          teamBPlayers: teamB.players,
          teamBClub: teamB.club,
        };
      });
    } else {
      const effectiveId = canonicalId;
      const createdRecord: LiveMatch = {
        id: effectiveId,
        court: cleanCourt,
        teamAName: teamA.name,
        teamAPlayers: teamA.players,
        teamAClub: teamA.club,
        teamBName: teamB.name,
        teamBPlayers: teamB.players,
        teamBClub: teamB.club,
        status: km.winner ? "final" : (km.scoreA !== undefined || km.scoreB !== undefined) ? "live" : "scheduled",
        score: {
          teamAScore: km.scoreA ?? 0,
          teamBScore: km.scoreB ?? 0,
          servingTeam: "A",
          serverNumber: 2,
          activeServerBase: 1,
          rallies: [],
        },
        winnerTeam: dispWinner,
        startedAt: undefined,
        endedAt: km.winner ? Date.now() : undefined,
        officiatedBy: undefined,
        tournamentSlug,
        categoryId,
        stage,
      };
      markLocalMatchMutation(effectiveId);
      newMatches.push(createdRecord);

      queueItems = queueItems.map((q) => {
        const matchesStage =
          q.status !== "completed" &&
          (!tournamentSlug || q.tournamentSlug === tournamentSlug) &&
          isSameCategory(q.categoryId, categoryId) &&
          q.stage === stage;
        if (!matchesStage) return q;
        queueModified = true;
        return {
          ...q,
          matchId: effectiveId,
          stage,
          teamAName: teamA.name,
          teamAPlayers: teamA.players,
          teamAClub: teamA.club,
          teamBName: teamB.name,
          teamBPlayers: teamB.players,
          teamBClub: teamB.club,
        };
      });
    }
  }

  const updatedIds = new Set(newMatches.map((m) => m.id));
  const retained = current.filter((m) => !updatedIds.has(m.id) && !staleIdsToRemove.has(m.id));
  saveMatches([...newMatches, ...retained], true, newMatches);

  if (staleIdsToRemove.size > 0) {
    dbDeleteMatchesBatch(Array.from(staleIdsToRemove)).catch(() => {});
  }
  if (queueModified) {
    saveDispatchQueue(queueItems);
  }
}

/* ─────────────────────────────────────────────
   Component Props
───────────────────────────────────────────── */

interface DrawsManagerProps {
  tournament: Tournament;
  category: Category;
  tournaments: Tournament[];
  tournamentSlug: string;
  setTournamentSlug: (slug: string) => void;
  categoryId: string;
  setCategoryId: (id: string) => void;
  onSwitchToBracketDraw?: () => void;
}

export function DrawsManager({
  tournament,
  category,
  tournaments,
  tournamentSlug,
  setTournamentSlug,
  categoryId,
  setCategoryId,
  onSwitchToBracketDraw,
}: DrawsManagerProps) {
  const { matches: liveStoreMatches } = useMatchStore(tournamentSlug || undefined);
  const [stageView, setStageView] = useState<"round_robin" | "main_draw">("round_robin");
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  const [threePairFormat, setThreePairFormat] = useState<"round_robin_direct" | "knockout_bracket">(() => {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(`dv_3pair_format_${tournamentSlug}_${categoryId}`);
      if (saved === "knockout_bracket" || saved === "round_robin_direct") return saved;
    }
    return "round_robin_direct";
  });

  const handleToggleThreePairFormat = (fmt: "round_robin_direct" | "knockout_bracket") => {
    setThreePairFormat(fmt);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(`dv_3pair_format_${tournamentSlug}_${categoryId}`, fmt);
    }
    window.dispatchEvent(new Event("dv_drawn_groups_updated"));
  };

  // Initialize groups directly from Bracket Draw (MAIN) and sync with live scores
  const initializeGroupsFromDrawn = useCallback((): BracketGroup[] => {
    const drawn = getDrawnGroups(tournamentSlug, categoryId);
    if (!drawn || drawn.length === 0) return [];

    const rosterById = new Map((category?.teams || []).map((t) => [t.id, t]));
    const liveMatches = getMatches();
    let courtCounter = 1;

    return drawn.map((dGrp) => {
      const teams = dGrp.slots
        .map((s) => (s.team ? (rosterById.get(s.team.id) ?? s.team) : null))
        .filter((t): t is Team => t !== null);

      const nameCounts = new Map<string, number>();
      for (const t of teams) {
        const k = t.name.trim().toLowerCase();
        nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
      }

      const matches: BracketMatch[] = [];
      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const teamA = teams[i]!;
          const teamB = teams[j]!;
          const isDupA = (nameCounts.get(teamA.name.trim().toLowerCase()) || 0) > 1;
          const isDupB = (nameCounts.get(teamB.name.trim().toLowerCase()) || 0) > 1;

          const scopedId =
            teamA.id && teamB.id
              ? createCategoryScopedMatchId(categoryId, dGrp.letter, teamA.id, teamB.id)
              : null;
          const bracketMatchId = scopedId || `bracket-${dGrp.letter}-m${i + 1}-${j + 1}`;

          const liveMatch = findMatchForPair(
            liveMatches,
            teamA.name,
            teamB.name,
            tournamentSlug,
            categoryId,
            dGrp.letter,
            teamA.players,
            teamB.players,
            scopedId,
          );

          let scoreA: number | undefined = undefined;
          let scoreB: number | undefined = undefined;
          let status: BracketMatch["status"] = "scheduled";
          let court = courtCounter <= 4 ? `Court ${courtCounter}` : "Queue";

          if (liveMatch) {
            court = liveMatch.court;
            const normP = (arr?: string[]) =>
              (arr || [])
                .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
                .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
                .filter(Boolean)
                .sort()
                .join("|");
            const pA = normP(teamA.players);
            const pB = normP(teamB.players);
            const lpA = normP(liveMatch.teamAPlayers);
            const lpB = normP(liveMatch.teamBPlayers);
            const aNameLower = teamA.name.replace(/\s+/g, " ").trim().toLowerCase();
            const bNameLower = teamB.name.replace(/\s+/g, " ").trim().toLowerCase();
            const liveALower = (liveMatch.teamAName || "").replace(/\s+/g, " ").trim().toLowerCase();

            let isSameOrder = true;
            if (pA && lpA && (pA !== pB || lpA !== lpB)) {
              if (pA === lpA || (pB && lpB && pB === lpB)) {
                isSameOrder = true;
              } else if (pA === lpB || (pB && pB === lpA)) {
                isSameOrder = false;
              }
            } else if (aNameLower !== bNameLower) {
              isSameOrder = liveALower !== bNameLower;
            }

            const isCompletedLive =
              liveMatch.status === "final" || Boolean(liveMatch.winnerTeam) || Boolean(liveMatch.endedAt);

            if (isCompletedLive) {
              status = "completed";
              if (isSameOrder) {
                scoreA = liveMatch.score.teamAScore;
                scoreB = liveMatch.score.teamBScore;
              } else {
                scoreA = liveMatch.score.teamBScore;
                scoreB = liveMatch.score.teamAScore;
              }
            } else if (liveMatch.status === "live") {
              status = "in_progress";
              if (isSameOrder) {
                scoreA = liveMatch.score.teamAScore;
                scoreB = liveMatch.score.teamBScore;
              } else {
                scoreA = liveMatch.score.teamBScore;
                scoreB = liveMatch.score.teamAScore;
              }
            }
          }

          matches.push({
            id: bracketMatchId,
            court,
            teamAId: teamA.id,
            teamBId: teamB.id,
            scoreA,
            scoreB,
            status,
          });
          courtCounter++;
        }
      }

      return {
        id: `bracket-${dGrp.letter}`,
        name: `Bracket ${dGrp.letter}`,
        teams,
        matches,
      };
    });
  }, [tournamentSlug, categoryId, category?.teams]);

  // State for brackets and main draw
  const [brackets, setBrackets] = useState<BracketGroup[]>(() => initializeGroupsFromDrawn());
  const [mainDrawMatches, setMainDrawMatches] = useState<KnockoutMatch[]>(() => {
    return getMainDrawMatches(tournamentSlug, categoryId) ?? [];
  });
  const [mainDrawGenerated, setMainDrawGenerated] = useState(() => {
    const existing = getMainDrawMatches(tournamentSlug, categoryId);
    return Boolean(existing && existing.length > 0);
  });

  const syncFromStorage = useCallback(() => {
    const nextBrackets = initializeGroupsFromDrawn();
    setBrackets((prev) =>
      nextBrackets.map((nb) => {
        const prevGrp = prev.find((g) => g.id === nb.id);
        if (!prevGrp) return nb;
        return {
          ...nb,
          matches: nb.matches.map((nm) => {
            const pm = prevGrp.matches.find((x) => x.id === nm.id);
            if (
              pm &&
              pm.status === "in_progress" &&
              nm.status === "scheduled" &&
              (pm.scoreA !== undefined || pm.scoreB !== undefined)
            ) {
              return pm;
            }
            return nm;
          }),
        };
      }),
    );
    const existing = getMainDrawMatches(tournamentSlug, categoryId);
    if (existing && existing.length > 0) {
      setMainDrawMatches(existing);
      setMainDrawGenerated(true);
    } else {
      setMainDrawMatches([]);
      setMainDrawGenerated(false);
    }
  }, [initializeGroupsFromDrawn, tournamentSlug, categoryId]);

  // Real-time synchronization across cloud updates, draw resets, score entries, and cross-tab actions
  useEffect(() => {
    syncFromStorage();
  }, [syncFromStorage, liveStoreMatches]);

  useEffect(() => {
    const handleSync = () => {
      syncFromStorage();
    };

    window.addEventListener("dv_drawn_groups_updated", handleSync);
    window.addEventListener("dv_live_matches_updated", handleSync);
    window.addEventListener("dv_main_draw_updated", handleSync);
    window.addEventListener("dv_tournaments_updated", handleSync);
    window.addEventListener("storage", handleSync);

    return () => {
      window.removeEventListener("dv_drawn_groups_updated", handleSync);
      window.removeEventListener("dv_live_matches_updated", handleSync);
      window.removeEventListener("dv_main_draw_updated", handleSync);
      window.removeEventListener("dv_tournaments_updated", handleSync);
      window.removeEventListener("storage", handleSync);
    };
  }, [syncFromStorage]);

  // Compute standings for a bracket (Point Differential is primary tie-breaker)
  const calculateBracketStandings = (group: BracketGroup): StandingRow[] => {
    const stats: Record<
      string,
      { played: number; won: number; lost: number; pointsFor: number; pointsAgainst: number }
    > = {};

    group.teams.forEach((t) => {
      stats[t.id] = { played: 0, won: 0, lost: 0, pointsFor: 0, pointsAgainst: 0 };
    });

    group.matches.forEach((m) => {
      if (m.scoreA !== undefined && m.scoreB !== undefined) {
        const teamA = stats[m.teamAId];
        const teamB = stats[m.teamBId];
        if (teamA && teamB) {
          teamA.played += 1;
          teamB.played += 1;
          teamA.pointsFor += m.scoreA;
          teamA.pointsAgainst += m.scoreB;
          teamB.pointsFor += m.scoreB;
          teamB.pointsAgainst += m.scoreA;

          if (m.scoreA > m.scoreB) {
            teamA.won += 1;
            teamB.lost += 1;
          } else if (m.scoreB > m.scoreA) {
            teamB.won += 1;
            teamA.lost += 1;
          }
        }
      }
    });

    const rows = group.teams.map((t) => {
      const s = stats[t.id] ?? { played: 0, won: 0, lost: 0, pointsFor: 0, pointsAgainst: 0 };
      const pointDiff = s.pointsFor - s.pointsAgainst;
      return {
        team: t,
        played: s.played,
        won: s.won,
        lost: s.lost,
        pointsFor: s.pointsFor,
        pointsAgainst: s.pointsAgainst,
        pointDiff,
        isQualified: false,
        rank: 1,
      };
    });

    // PRIMARY TIE-BREAKER: Wins desc -> Point Differential desc -> Points For desc -> Points Against asc
    rows.sort((a, b) => {
      return (
        b.won - a.won ||
        b.pointDiff - a.pointDiff ||
        b.pointsFor - a.pointsFor ||
        a.pointsAgainst - b.pointsAgainst
      );
    });

    const allMatchesCompleted =
      group.matches.length > 0 &&
      group.matches.every((m) => m.scoreA !== undefined && m.scoreB !== undefined);

    // Set rank and top 2 qualification status
    rows.forEach((row, i) => {
      row.rank = i + 1;
      row.isQualified = allMatchesCompleted && i < 2; // Top 2 advance once bracket is done
    });

    return rows;
  };

  // Standings per bracket
  const allStandings = useMemo(() => {
    return brackets.map((b) => ({
      groupId: b.id,
      name: b.name,
      rows: calculateBracketStandings(b),
    }));
  }, [brackets]);

  /* ─────────────────────────────────────────────────────────────
     Automated Playoff Seeding Engine (Ranked by Point Differential)
  ───────────────────────────────────────────────────────────── */
  const qualifiers = useMemo((): Qualifier[] => {
    const rawQualifiers: Omit<Qualifier, "overallSeed">[] = [];

    // Special case for single-bracket round robin (e.g. 3 pairs in 1 pool)
    const firstStanding = allStandings[0];
    if (allStandings.length === 1 && firstStanding && firstStanding.rows.length <= 4) {
      const b = firstStanding;
      const letter = b.name.replace("Bracket ", "").trim();
      b.rows.forEach((row) => {
        rawQualifiers.push({
          team: row.team,
          bracketLetter: letter,
          bracketName: b.name,
          bracketRank: row.rank,
          bracketSeed: `${letter}${row.rank}`,
          won: row.won,
          lost: row.lost,
          played: row.played,
          pointsFor: row.pointsFor,
          pointsAgainst: row.pointsAgainst,
          pointDiff: row.pointDiff,
        });
      });

      const compareByPointDiff = (a: Omit<Qualifier, "overallSeed">, b: Omit<Qualifier, "overallSeed">) => {
        return (
          b.won - a.won ||
          b.pointDiff - a.pointDiff ||
          b.pointsFor - a.pointsFor ||
          a.pointsAgainst - b.pointsAgainst
        );
      };

      rawQualifiers.sort(compareByPointDiff);

      let seedCounter = 1;
      return rawQualifiers.map((q) => ({
        ...q,
        overallSeed: seedCounter++,
      }));
    }

    allStandings.forEach((b) => {
      const letter = b.name.replace("Bracket ", "").trim();
      b.rows.slice(0, 2).forEach((row) => {
        rawQualifiers.push({
          team: row.team,
          bracketLetter: letter,
          bracketName: b.name,
          bracketRank: row.rank,
          bracketSeed: `${letter}${row.rank}`,
          won: row.won,
          lost: row.lost,
          played: row.played,
          pointsFor: row.pointsFor,
          pointsAgainst: row.pointsAgainst,
          pointDiff: row.pointDiff,
        });
      });
    });

    // Separate into Winners (rank 1) and Runners-Up (rank 2)
    const winners = rawQualifiers.filter((q) => q.bracketRank === 1);
    const runnersUp = rawQualifiers.filter((q) => q.bracketRank === 2);

    // Primary ranking function: Wins desc -> Point Differential desc -> Points For desc -> Points Against asc
    const compareByPointDiff = (a: Omit<Qualifier, "overallSeed">, b: Omit<Qualifier, "overallSeed">) => {
      return (
        b.won - a.won ||
        b.pointDiff - a.pointDiff ||
        b.pointsFor - a.pointsFor ||
        a.pointsAgainst - b.pointsAgainst
      );
    };

    winners.sort(compareByPointDiff);
    runnersUp.sort(compareByPointDiff);

    // Group winners receive top seeds (1 to K)
    let seedCounter = 1;
    const seededWinners: Qualifier[] = winners.map((w) => ({
      ...w,
      overallSeed: seedCounter++,
    }));

    // Runners-up receive seeds (K+1 to 2K)
    const seededRunnersUp: Qualifier[] = runnersUp.map((r) => ({
      ...r,
      overallSeed: seedCounter++,
    }));

    return [...seededWinners, ...seededRunnersUp];
  }, [allStandings]);

  // Refresh brackets from Bracket Draw (MAIN)
  const handleRefreshFromDrawn = () => {
    const next = initializeGroupsFromDrawn();
    setBrackets(next);
    setMainDrawMatches([]);
    setMainDrawGenerated(false);
    resetMainDrawMatches(tournamentSlug, categoryId);
  };

  // Update a match score in round-robin
  const handleScoreChange = (
    bracketId: string,
    matchId: string,
    field: "scoreA" | "scoreB",
    val: string,
  ) => {
    const num = val === "" ? undefined : Math.max(0, parseInt(val, 10) || 0);
    setBrackets((prev) =>
      prev.map((grp) => {
        if (grp.id !== bracketId) return grp;
        return {
          ...grp,
          matches: grp.matches.map((m) => {
            if (m.id !== matchId) return m;
            const updated = { ...m, [field]: num };
            if (updated.scoreA !== undefined && updated.scoreB !== undefined) {
              updated.status = "completed";
            } else if (updated.scoreA !== undefined || updated.scoreB !== undefined) {
              updated.status = "in_progress";
            } else {
              updated.status = "scheduled";
            }
            return updated;
          }),
        };
      }),
    );
  };

  // Persist Pool Play score entry or reset directly to live match store & Supabase so Match History stays in sync
  const persistPoolMatchScoreToStore = (
    bracketId: string,
    matchId: string,
    scoreA: number | undefined,
    scoreB: number | undefined,
  ) => {
    const grp = brackets.find((g) => g.id === bracketId);
    const bm = grp?.matches.find((m) => m.id === matchId);
    if (!grp || !bm) return;
    const teamA = grp.teams.find((t) => t.id === bm.teamAId);
    const teamB = grp.teams.find((t) => t.id === bm.teamBId);
    if (!teamA || !teamB) return;

    const letter = grp.name.replace("Bracket ", "").trim().toUpperCase();
    const all = getMatches();
    const scopedId =
      teamA.id && teamB.id
        ? createCategoryScopedMatchId(categoryId, letter, teamA.id, teamB.id)
        : matchId;
    const existing = findMatchForPair(
      all,
      teamA.name,
      teamB.name,
      tournamentSlug,
      categoryId,
      letter,
      teamA.players,
      teamB.players,
      scopedId,
    );

    const normP = (arr?: string[]) =>
      (arr || [])
        .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
        .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join("|");

    let isSameOrder = true;
    if (existing) {
      const pA = normP(teamA.players);
      const pB = normP(teamB.players);
      const lpA = normP(existing.teamAPlayers);
      const lpB = normP(existing.teamBPlayers);
      const aName = teamA.name.replace(/\s+/g, " ").trim().toLowerCase();
      const bName = teamB.name.replace(/\s+/g, " ").trim().toLowerCase();
      const liveA = (existing.teamAName || "").replace(/\s+/g, " ").trim().toLowerCase();

      if (pA && lpA && (pA !== pB || lpA !== lpB)) {
        if (pA === lpA || (pB && lpB && pB === lpB)) isSameOrder = true;
        else if (pA === lpB || (pB && pB === lpA)) isSameOrder = false;
      } else if (aName !== bName) {
        isSameOrder = liveA !== bName;
      }
    }

    const now = Date.now();

    if (scoreA === undefined && scoreB === undefined) {
      if (!existing) return;
      const resetRecord: LiveMatch = {
        ...existing,
        status: "scheduled",
        score: createInitialScore(),
        winnerTeam: undefined,
        startedAt: undefined,
        endedAt: undefined,
        resetAt: now,
      };
      markLocalMatchMutation(resetRecord.id);
      const nextAll = all.map((m) => (m.id === resetRecord.id ? resetRecord : m));
      saveMatches(nextAll, false);
      dbSaveMatch(resetRecord).catch((err) => console.warn("[Supabase] Pool match reset failed:", err));
      return;
    }

    if (scoreA === undefined || scoreB === undefined || scoreA === scoreB) return;

    const dispA = getMatchTeamDisplay(teamA.name, teamA.players, teamA.name || "Team A");
    const dispB = getMatchTeamDisplay(teamB.name, teamB.players, teamB.name || "Team B");
    const winnerLabel = scoreA > scoreB ? dispA.primary : dispB.primary;

    const storeScoreA = isSameOrder ? scoreA : scoreB;
    const storeScoreB = isSameOrder ? scoreB : scoreA;
    const targetId = existing?.id || scopedId;

    const record: LiveMatch = existing
      ? {
          ...existing,
          tournamentSlug: tournamentSlug || existing.tournamentSlug,
          categoryId: categoryId || existing.categoryId,
          stage: existing.stage || `Bracket ${letter} (Pool Play)`,
          bracketLetter: existing.bracketLetter || letter,
          status: "final",
          score: {
            ...(existing.score || createInitialScore()),
            teamAScore: storeScoreA,
            teamBScore: storeScoreB,
          },
          winnerTeam: winnerLabel,
          startedAt: existing.startedAt || now,
          endedAt: existing.endedAt || now,
        }
      : {
          id: targetId,
          tournamentSlug,
          categoryId,
          court: sanitizeCourtName(bm.court || "Queue"),
          stage: `Bracket ${letter} (Pool Play)`,
          bracketLetter: letter,
          teamAName: teamA.name,
          teamAPlayers: teamA.players,
          teamAClub: teamA.club,
          teamBName: teamB.name,
          teamBPlayers: teamB.players,
          teamBClub: teamB.club,
          officiatedBy: "Tournament Desk",
          status: "final",
          score: {
            ...createInitialScore(),
            teamAScore: scoreA,
            teamBScore: scoreB,
          },
          winnerTeam: winnerLabel,
          startedAt: now,
          endedAt: now,
        };

    markLocalMatchMutation(record.id);
    const nextAll = existing
      ? all.map((m) => (m.id === existing.id ? record : m))
      : [...all, record];
    saveMatches(nextAll, false);
    dbSaveMatch(record).catch((err) => console.warn("[Supabase] Pool match save failed:", err));
  };

  // Quick preset score
  const handleQuickScore = (
    bracketId: string,
    matchId: string,
    scoreA: number,
    scoreB: number,
  ) => {
    setBrackets((prev) =>
      prev.map((grp) => {
        if (grp.id !== bracketId) return grp;
        return {
          ...grp,
          matches: grp.matches.map((m) => {
            if (m.id !== matchId) return m;
            return {
              ...m,
              scoreA,
              scoreB,
              status: "completed",
            };
          }),
        };
      }),
    );
    persistPoolMatchScoreToStore(bracketId, matchId, scoreA, scoreB);
  };

  // Reset match score
  const handleResetScore = (bracketId: string, matchId: string) => {
    setBrackets((prev) =>
      prev.map((grp) => {
        if (grp.id !== bracketId) return grp;
        return {
          ...grp,
          matches: grp.matches.map((m) =>
            m.id === matchId
              ? { ...m, scoreA: undefined, scoreB: undefined, status: "scheduled" }
              : m,
          ),
        };
      }),
    );
    persistPoolMatchScoreToStore(bracketId, matchId, undefined, undefined);
  };

  /* ─────────────────────────────────────────────────────────────
     Generate Main Draw Elimination Tree using Point Differential
  ───────────────────────────────────────────────────────────── */
  const handleGenerateMainDraw = () => {
    if (qualifiers.length < 2) {
      alert("At least 2 qualified teams are needed to generate the Main Draw.");
      return;
    }

    const matches: KnockoutMatch[] = [];
    const n = Math.min(qualifiers.length, 16);
    const qBySeed = (seedNum: number) => qualifiers.find((q) => q.overallSeed === seedNum);

    const formatSeedLabel = (q?: Qualifier, isBye = false) => {
      if (!q) return undefined;
      const diffStr = q.pointDiff > 0 ? `+${q.pointDiff}` : `${q.pointDiff}`;
      if (isBye) {
        return `#${q.overallSeed} (${q.bracketSeed}, ${diffStr} diff - BYE)`;
      }
      return `#${q.overallSeed} (${q.bracketSeed}, ${diffStr} diff)`;
    };

    if (n >= 9) {
      // 16-slot bracket (Round of 16 -> Quarterfinals -> Semifinals -> Final & Bronze)
      // Standard 16 pairings feeding 4 Quarterfinals:
      // QF 1: Top slot 1v16, Bot slot 8v9 -> feeds SF 1 top
      // QF 2: Top slot 4v13, Bot slot 5v12 -> feeds SF 1 bot
      // QF 3: Top slot 2v15, Bot slot 7v10 -> feeds SF 2 top
      // QF 4: Top slot 3v14, Bot slot 6v11 -> feeds SF 2 bot
      const pairConfigs = [
        { top: 1, bot: 16, targetQf: "md-qf-1", slot: "teamA" as const },
        { top: 8, bot: 9,  targetQf: "md-qf-1", slot: "teamB" as const },
        { top: 4, bot: 13, targetQf: "md-qf-2", slot: "teamA" as const },
        { top: 5, bot: 12, targetQf: "md-qf-2", slot: "teamB" as const },
        { top: 2, bot: 15, targetQf: "md-qf-3", slot: "teamA" as const },
        { top: 7, bot: 10, targetQf: "md-qf-3", slot: "teamB" as const },
        { top: 3, bot: 14, targetQf: "md-qf-4", slot: "teamA" as const },
        { top: 6, bot: 11, targetQf: "md-qf-4", slot: "teamB" as const },
      ];

      // Prevent early rematch for playable R16 matches:
      const playable = pairConfigs.filter((cfg) => cfg.bot <= n && qBySeed(cfg.bot));
      for (let i = 0; i < playable.length; i++) {
        const p = playable[i]!;
        const qTop = qBySeed(p.top);
        const qBot = qBySeed(p.bot);
        if (qTop && qBot && qTop.bracketLetter === qBot.bracketLetter) {
          for (let j = 0; j < playable.length; j++) {
            if (i === j) continue;
            const otherP = playable[j]!;
            const otherTop = qBySeed(otherP.top);
            const otherBot = qBySeed(otherP.bot);
            if (otherTop && otherBot) {
              if (qTop.bracketLetter !== otherBot.bracketLetter && otherTop.bracketLetter !== qBot.bracketLetter) {
                const temp = p.bot;
                p.bot = otherP.bot;
                otherP.bot = temp;
                break;
              }
            }
          }
        }
      }

      // Shells for Quarterfinals
      const qfMap: Record<string, KnockoutMatch> = {
        "md-qf-1": {
          id: "md-qf-1",
          round: "Quarterfinal",
          label: "Quarterfinal 1",
          court: "Court 1",
          feedWinnerTo: { matchId: "md-sf-1", slot: "teamA" },
        },
        "md-qf-2": {
          id: "md-qf-2",
          round: "Quarterfinal",
          label: "Quarterfinal 2",
          court: "Court 2",
          feedWinnerTo: { matchId: "md-sf-1", slot: "teamB" },
        },
        "md-qf-3": {
          id: "md-qf-3",
          round: "Quarterfinal",
          label: "Quarterfinal 3",
          court: "Court 3",
          feedWinnerTo: { matchId: "md-sf-2", slot: "teamA" },
        },
        "md-qf-4": {
          id: "md-qf-4",
          round: "Quarterfinal",
          label: "Quarterfinal 4",
          court: "Court 4",
          feedWinnerTo: { matchId: "md-sf-2", slot: "teamB" },
        },
      };

      let r16Counter = 1;
      for (const cfg of pairConfigs) {
        const qTop = qBySeed(cfg.top);
        const qBot = qBySeed(cfg.bot);

        if (cfg.bot <= n && qBot) {
          // Playable R16 match
          const r16Id = `md-r16-${r16Counter}`;
          const r16Label = `Round of 16 - Match ${r16Counter}`;
          const courtName = r16Counter <= 4 ? `Court ${r16Counter}` : "Queue";
          matches.push({
            id: r16Id,
            round: "Round of 16",
            label: r16Label,
            court: courtName,
            teamA: qTop?.team,
            teamB: qBot?.team,
            seedA: formatSeedLabel(qTop),
            seedB: formatSeedLabel(qBot),
            feedWinnerTo: { matchId: cfg.targetQf, slot: cfg.slot },
          });
          const targetQf = qfMap[cfg.targetQf]!;
          if (cfg.slot === "teamA") {
            targetQf.seedA = `Winner of ${r16Label}`;
          } else {
            targetQf.seedB = `Winner of ${r16Label}`;
          }
          r16Counter++;
        } else {
          // Bottom seed does not exist -> Top seed gets a BYE directly to QF!
          const targetQf = qfMap[cfg.targetQf]!;
          targetQf[cfg.slot] = qTop?.team;
          if (cfg.slot === "teamA") {
            targetQf.seedA = formatSeedLabel(qTop, true);
          } else {
            targetQf.seedB = formatSeedLabel(qTop, true);
          }
        }
      }

      // Add the 4 Quarterfinals
      matches.push(qfMap["md-qf-1"]!, qfMap["md-qf-2"]!, qfMap["md-qf-3"]!, qfMap["md-qf-4"]!);

      // Semifinals
      matches.push({
        id: "md-sf-1",
        round: "Semifinal",
        label: "Semifinal 1",
        court: "Court 1",
        seedA: "Winner of Quarterfinal 1",
        seedB: "Winner of Quarterfinal 2",
        feedWinnerTo: { matchId: "md-final", slot: "teamA" },
        feedLoserTo: { matchId: "md-bronze", slot: "teamA" },
      });
      matches.push({
        id: "md-sf-2",
        round: "Semifinal",
        label: "Semifinal 2",
        court: "Court 2",
        seedA: "Winner of Quarterfinal 3",
        seedB: "Winner of Quarterfinal 4",
        feedWinnerTo: { matchId: "md-final", slot: "teamB" },
        feedLoserTo: { matchId: "md-bronze", slot: "teamB" },
      });

      // Championship Final & 3rd Place Match
      matches.push({
        id: "md-final",
        round: "Final",
        label: "Championship Final",
        court: "Court 1",
        seedA: "Winner of Semifinal 1",
        seedB: "Winner of Semifinal 2",
      });
      matches.push({
        id: "md-bronze",
        round: "Bronze",
        label: "3rd Place Match",
        court: "Court 3",
        seedA: "Runner-up of Semifinal 1",
        seedB: "Runner-up of Semifinal 2",
      });
    } else if (n >= 5) {
      // 8-slot bracket (Quarterfinals -> Semifinals -> Final & Bronze)
      // Standard 8 pairings feeding 2 Semifinals:
      // SF 1: Top slot 1v8, Bot slot 4v5 -> feeds SF 1
      // SF 2: Top slot 2v7, Bot slot 3v6 -> feeds SF 2
      const pairConfigs = [
        { top: 1, bot: 8, targetSf: "md-sf-1", slot: "teamA" as const },
        { top: 4, bot: 5, targetSf: "md-sf-1", slot: "teamB" as const },
        { top: 2, bot: 7, targetSf: "md-sf-2", slot: "teamA" as const },
        { top: 3, bot: 6, targetSf: "md-sf-2", slot: "teamB" as const },
      ];

      // Prevent early rematch for playable QF matches:
      const playable = pairConfigs.filter((cfg) => cfg.bot <= n && qBySeed(cfg.bot));
      for (let i = 0; i < playable.length; i++) {
        const p = playable[i]!;
        const qTop = qBySeed(p.top);
        const qBot = qBySeed(p.bot);
        if (qTop && qBot && qTop.bracketLetter === qBot.bracketLetter) {
          for (let j = 0; j < playable.length; j++) {
            if (i === j) continue;
            const otherP = playable[j]!;
            const otherTop = qBySeed(otherP.top);
            const otherBot = qBySeed(otherP.bot);
            if (otherTop && otherBot) {
              if (qTop.bracketLetter !== otherBot.bracketLetter && otherTop.bracketLetter !== qBot.bracketLetter) {
                const temp = p.bot;
                p.bot = otherP.bot;
                otherP.bot = temp;
                break;
              }
            }
          }
        }
      }

      // Shells for Semifinals
      const sfMap: Record<string, KnockoutMatch> = {
        "md-sf-1": {
          id: "md-sf-1",
          round: "Semifinal",
          label: "Semifinal 1",
          court: "Court 1",
          feedWinnerTo: { matchId: "md-final", slot: "teamA" },
          feedLoserTo: { matchId: "md-bronze", slot: "teamA" },
        },
        "md-sf-2": {
          id: "md-sf-2",
          round: "Semifinal",
          label: "Semifinal 2",
          court: "Court 2",
          feedWinnerTo: { matchId: "md-final", slot: "teamB" },
          feedLoserTo: { matchId: "md-bronze", slot: "teamB" },
        },
      };

      let qfCounter = 1;
      for (const cfg of pairConfigs) {
        const qTop = qBySeed(cfg.top);
        const qBot = qBySeed(cfg.bot);

        if (cfg.bot <= n && qBot) {
          // Playable QF match
          const qfId = `md-qf-${qfCounter}`;
          const qfLabel = `Quarterfinal ${qfCounter}`;
          const courtName = qfCounter <= 4 ? `Court ${qfCounter}` : "Queue";
          matches.push({
            id: qfId,
            round: "Quarterfinal",
            label: qfLabel,
            court: courtName,
            teamA: qTop?.team,
            teamB: qBot?.team,
            seedA: formatSeedLabel(qTop),
            seedB: formatSeedLabel(qBot),
            feedWinnerTo: { matchId: cfg.targetSf, slot: cfg.slot },
          });
          const targetSf = sfMap[cfg.targetSf]!;
          if (cfg.slot === "teamA") {
            targetSf.seedA = `Winner of ${qfLabel}`;
          } else {
            targetSf.seedB = `Winner of ${qfLabel}`;
          }
          qfCounter++;
        } else {
          // Bottom seed does not exist -> Top seed gets a BYE directly to SF!
          const targetSf = sfMap[cfg.targetSf]!;
          targetSf[cfg.slot] = qTop?.team;
          if (cfg.slot === "teamA") {
            targetSf.seedA = formatSeedLabel(qTop, true);
          } else {
            targetSf.seedB = formatSeedLabel(qTop, true);
          }
        }
      }

      // Add Semifinals
      matches.push(sfMap["md-sf-1"]!, sfMap["md-sf-2"]!);

      // Championship Final & 3rd Place Match
      matches.push({
        id: "md-final",
        round: "Final",
        label: "Championship Final",
        court: "Court 1",
        seedA: "Winner of Semifinal 1",
        seedB: "Winner of Semifinal 2",
      });
      matches.push({
        id: "md-bronze",
        round: "Bronze",
        label: "3rd Place Match",
        court: "Court 3",
        seedA: "Runner-up of Semifinal 1",
        seedB: "Runner-up of Semifinal 2",
      });
    } else {
      // 4-slot bracket (4, 3, or 2 teams)
      const q1 = qBySeed(1);
      const q2 = qBySeed(2);
      const q3 = qBySeed(3);
      const q4 = qBySeed(4);

      if (n >= 4) {
        let sf1Opp = q4;
        let sf2Opp = q3;
        if (q1 && q4 && q1.bracketLetter === q4.bracketLetter) {
          sf1Opp = q3;
          sf2Opp = q4;
        }

        matches.push({
          id: "md-sf-1",
          round: "Semifinal",
          label: "Semifinal 1",
          court: "Court 1",
          teamA: q1?.team,
          teamB: sf1Opp?.team,
          seedA: formatSeedLabel(q1),
          seedB: formatSeedLabel(sf1Opp),
          feedWinnerTo: { matchId: "md-final", slot: "teamA" },
          feedLoserTo: { matchId: "md-bronze", slot: "teamA" },
        });

        matches.push({
          id: "md-sf-2",
          round: "Semifinal",
          label: "Semifinal 2",
          court: "Court 2",
          teamA: q2?.team,
          teamB: sf2Opp?.team,
          seedA: formatSeedLabel(q2),
          seedB: formatSeedLabel(sf2Opp),
          feedWinnerTo: { matchId: "md-final", slot: "teamB" },
          feedLoserTo: { matchId: "md-bronze", slot: "teamB" },
        });

        matches.push({
          id: "md-bronze",
          round: "Bronze",
          label: "3rd Place Match",
          court: "Court 3",
          seedA: "Runner-up of Semifinal 1",
          seedB: "Runner-up of Semifinal 2",
        });
        matches.push({
          id: "md-final",
          round: "Final",
          label: "Championship Final",
          court: "Court 1",
          seedA: "Winner of Semifinal 1",
          seedB: "Winner of Semifinal 2",
        });
      } else if (n === 3) {
        // Seed 1 gets a BYE directly into Championship Final
        matches.push({
          id: "md-sf-1",
          round: "Semifinal",
          label: "Semifinal 1",
          court: "Court 1",
          teamA: q2?.team,
          teamB: q3?.team,
          seedA: formatSeedLabel(q2),
          seedB: formatSeedLabel(q3),
          feedWinnerTo: { matchId: "md-final", slot: "teamB" },
        });

        matches.push({
          id: "md-final",
          round: "Final",
          label: "Championship Final",
          court: "Court 1",
          teamA: q1?.team,
          seedA: formatSeedLabel(q1, true),
          seedB: "Winner of Semifinal 1",
        });
      } else {
        // 2 teams
        matches.push({
          id: "md-final",
          round: "Final",
          label: "Championship Final",
          court: "Court 1",
          teamA: q1?.team,
          teamB: q2?.team,
          seedA: formatSeedLabel(q1),
          seedB: formatSeedLabel(q2),
        });
      }
    }

    setMainDrawMatches(matches);
    saveMainDrawMatches(tournamentSlug, categoryId, matches);
    syncKnockoutToLiveMatches(tournamentSlug, categoryId, matches);
    setMainDrawGenerated(true);
    setStageView("main_draw");
  };

  // Sync current playoff matches to live court store
  const handleSyncToLiveCourts = () => {
    syncKnockoutToLiveMatches(tournamentSlug, categoryId, mainDrawMatches);
    setSyncNotice("Playoff matches successfully synced to Umpire Terminals and Live Courts!");
    setTimeout(() => setSyncNotice(null), 4000);
  };

  /* ─────────────────────────────────────────────────────────────
     Manual Knockout Stage Player Assignment & Editing
  ───────────────────────────────────────────────────────────── */
  const [editingKoSlot, setEditingKoSlot] = useState<{
    matchId: string;
    slot: "teamA" | "teamB";
    matchLabel: string;
    round: KnockoutMatch["round"];
    initialTeamId: string;
    selectedTeamId: string;
    swapWithMatchSlot: boolean;
    player1: string;
    player2: string;
    teamName: string;
    club: string;
    seedLabel: string;
    keepScore: boolean;
  } | null>(null);

  const availableKnockoutTeams = useMemo(() => {
    const items: Array<{ team: Team; sourceLabel: string; defaultSeed?: string | undefined }> = [];
    const seenIds = new Set<string>();
    const seenRosters = new Set<string>();

    const registerItem = (team: Team, sourceLabel: string, defaultSeed?: string) => {
      const rosterKey = `${normalizePlayoffPlayers(team.players)}::${team.name.trim().toLowerCase()}`;
      if ((team.id && seenIds.has(team.id)) || (rosterKey !== "::" && seenRosters.has(rosterKey))) {
        return;
      }
      if (team.id) seenIds.add(team.id);
      seenRosters.add(rosterKey);
      items.push({ team, sourceLabel, defaultSeed });
    };

    for (const q of qualifiers) {
      const diffStr = q.pointDiff > 0 ? `+${q.pointDiff}` : `${q.pointDiff}`;
      registerItem(
        q.team,
        `Seed #${q.overallSeed} (${q.bracketSeed}, ${q.won}W-${q.lost}L, ${diffStr})`,
        `#${q.overallSeed} (${q.bracketSeed})`,
      );
    }

    for (const b of allStandings) {
      const letter = b.name.replace("Bracket ", "").trim();
      for (const row of b.rows) {
        registerItem(
          row.team,
          `${b.name} - Rank ${row.rank} (${row.won}W-${row.lost}L)`,
          `${letter}${row.rank}`,
        );
      }
    }

    for (const t of category?.teams || []) {
      registerItem(t, "Registered Pair");
    }

    return items;
  }, [qualifiers, allStandings, category?.teams]);

  const handleCreateCustomMainDraw = (slotSize: 2 | 4 | 8 | 16) => {
    const seedPool: Array<{ team: Team; seedLabel: string }> =
      qualifiers.length > 0
        ? qualifiers.map((q) => ({
            team: q.team,
            seedLabel: `#${q.overallSeed} (${q.bracketSeed})`,
          }))
        : (category?.teams || []).map((t, idx) => ({
            team: t,
            seedLabel: `#${idx + 1}`,
          }));

    const pickSeed = (num: number) => seedPool[num - 1];
    const matches: KnockoutMatch[] = [];

    if (slotSize === 16) {
      const r16Pairs: Array<[number, number, string, "teamA" | "teamB"]> = [
        [1, 16, "md-qf-1", "teamA"],
        [8, 9, "md-qf-1", "teamB"],
        [4, 13, "md-qf-2", "teamA"],
        [5, 12, "md-qf-2", "teamB"],
        [2, 15, "md-qf-3", "teamA"],
        [7, 10, "md-qf-3", "teamB"],
        [3, 14, "md-qf-4", "teamA"],
        [6, 11, "md-qf-4", "teamB"],
      ];
      r16Pairs.forEach(([sA, sB, targetQf, targetSlot], idx) => {
        const entryA = pickSeed(sA);
        const entryB = pickSeed(sB);
        matches.push({
          id: `md-r16-${idx + 1}`,
          round: "Round of 16",
          label: `Round of 16 - Match ${idx + 1}`,
          court: idx < 4 ? `Court ${idx + 1}` : "Queue",
          teamA: entryA?.team,
          teamB: entryB?.team,
          seedA: entryA?.seedLabel ?? `#${sA}`,
          seedB: entryB?.seedLabel ?? `#${sB}`,
          feedWinnerTo: { matchId: targetQf, slot: targetSlot },
        });
      });
      matches.push(
        {
          id: "md-qf-1",
          round: "Quarterfinal",
          label: "Quarterfinal 1",
          court: "Court 1",
          seedA: "Winner of Round of 16 - Match 1",
          seedB: "Winner of Round of 16 - Match 2",
          feedWinnerTo: { matchId: "md-sf-1", slot: "teamA" },
        },
        {
          id: "md-qf-2",
          round: "Quarterfinal",
          label: "Quarterfinal 2",
          court: "Court 2",
          seedA: "Winner of Round of 16 - Match 3",
          seedB: "Winner of Round of 16 - Match 4",
          feedWinnerTo: { matchId: "md-sf-1", slot: "teamB" },
        },
        {
          id: "md-qf-3",
          round: "Quarterfinal",
          label: "Quarterfinal 3",
          court: "Court 3",
          seedA: "Winner of Round of 16 - Match 5",
          seedB: "Winner of Round of 16 - Match 6",
          feedWinnerTo: { matchId: "md-sf-2", slot: "teamA" },
        },
        {
          id: "md-qf-4",
          round: "Quarterfinal",
          label: "Quarterfinal 4",
          court: "Court 4",
          seedA: "Winner of Round of 16 - Match 7",
          seedB: "Winner of Round of 16 - Match 8",
          feedWinnerTo: { matchId: "md-sf-2", slot: "teamB" },
        },
        {
          id: "md-sf-1",
          round: "Semifinal",
          label: "Semifinal 1",
          court: "Court 1",
          seedA: "Winner of Quarterfinal 1",
          seedB: "Winner of Quarterfinal 2",
          feedWinnerTo: { matchId: "md-final", slot: "teamA" },
          feedLoserTo: { matchId: "md-bronze", slot: "teamA" },
        },
        {
          id: "md-sf-2",
          round: "Semifinal",
          label: "Semifinal 2",
          court: "Court 2",
          seedA: "Winner of Quarterfinal 3",
          seedB: "Winner of Quarterfinal 4",
          feedWinnerTo: { matchId: "md-final", slot: "teamB" },
          feedLoserTo: { matchId: "md-bronze", slot: "teamB" },
        },
        {
          id: "md-final",
          round: "Final",
          label: "Championship Final",
          court: "Court 1",
          seedA: "Winner of Semifinal 1",
          seedB: "Winner of Semifinal 2",
        },
        {
          id: "md-bronze",
          round: "Bronze",
          label: "3rd Place Match",
          court: "Court 3",
          seedA: "Runner-up of Semifinal 1",
          seedB: "Runner-up of Semifinal 2",
        },
      );
    } else if (slotSize === 8) {
      const qfPairs: Array<[number, number, string, "teamA" | "teamB"]> = [
        [1, 8, "md-sf-1", "teamA"],
        [4, 5, "md-sf-1", "teamB"],
        [2, 7, "md-sf-2", "teamA"],
        [3, 6, "md-sf-2", "teamB"],
      ];
      qfPairs.forEach(([sA, sB, targetSf, targetSlot], idx) => {
        const entryA = pickSeed(sA);
        const entryB = pickSeed(sB);
        matches.push({
          id: `md-qf-${idx + 1}`,
          round: "Quarterfinal",
          label: `Quarterfinal ${idx + 1}`,
          court: `Court ${idx + 1}`,
          teamA: entryA?.team,
          teamB: entryB?.team,
          seedA: entryA?.seedLabel ?? `#${sA}`,
          seedB: entryB?.seedLabel ?? `#${sB}`,
          feedWinnerTo: { matchId: targetSf, slot: targetSlot },
        });
      });
      matches.push(
        {
          id: "md-sf-1",
          round: "Semifinal",
          label: "Semifinal 1",
          court: "Court 1",
          seedA: "Winner of Quarterfinal 1",
          seedB: "Winner of Quarterfinal 2",
          feedWinnerTo: { matchId: "md-final", slot: "teamA" },
          feedLoserTo: { matchId: "md-bronze", slot: "teamA" },
        },
        {
          id: "md-sf-2",
          round: "Semifinal",
          label: "Semifinal 2",
          court: "Court 2",
          seedA: "Winner of Quarterfinal 3",
          seedB: "Winner of Quarterfinal 4",
          feedWinnerTo: { matchId: "md-final", slot: "teamB" },
          feedLoserTo: { matchId: "md-bronze", slot: "teamB" },
        },
        {
          id: "md-final",
          round: "Final",
          label: "Championship Final",
          court: "Court 1",
          seedA: "Winner of Semifinal 1",
          seedB: "Winner of Semifinal 2",
        },
        {
          id: "md-bronze",
          round: "Bronze",
          label: "3rd Place Match",
          court: "Court 3",
          seedA: "Runner-up of Semifinal 1",
          seedB: "Runner-up of Semifinal 2",
        },
      );
    } else if (slotSize === 4) {
      const s1 = pickSeed(1);
      const s2 = pickSeed(2);
      const s3 = pickSeed(3);
      const s4 = pickSeed(4);
      matches.push(
        {
          id: "md-sf-1",
          round: "Semifinal",
          label: "Semifinal 1",
          court: "Court 1",
          teamA: s1?.team,
          teamB: s4?.team,
          seedA: s1?.seedLabel ?? "#1",
          seedB: s4?.seedLabel ?? "#4",
          feedWinnerTo: { matchId: "md-final", slot: "teamA" },
          feedLoserTo: { matchId: "md-bronze", slot: "teamA" },
        },
        {
          id: "md-sf-2",
          round: "Semifinal",
          label: "Semifinal 2",
          court: "Court 2",
          teamA: s2?.team,
          teamB: s3?.team,
          seedA: s2?.seedLabel ?? "#2",
          seedB: s3?.seedLabel ?? "#3",
          feedWinnerTo: { matchId: "md-final", slot: "teamB" },
          feedLoserTo: { matchId: "md-bronze", slot: "teamB" },
        },
        {
          id: "md-bronze",
          round: "Bronze",
          label: "3rd Place Match",
          court: "Court 3",
          seedA: "Runner-up of Semifinal 1",
          seedB: "Runner-up of Semifinal 2",
        },
        {
          id: "md-final",
          round: "Final",
          label: "Championship Final",
          court: "Court 1",
          seedA: "Winner of Semifinal 1",
          seedB: "Winner of Semifinal 2",
        },
      );
    } else {
      const s1 = pickSeed(1);
      const s2 = pickSeed(2);
      matches.push({
        id: "md-final",
        round: "Final",
        label: "Championship Final",
        court: "Court 1",
        teamA: s1?.team,
        teamB: s2?.team,
        seedA: s1?.seedLabel ?? "#1",
        seedB: s2?.seedLabel ?? "#2",
      });
    }

    setMainDrawMatches(matches);
    saveMainDrawMatches(tournamentSlug, categoryId, matches);
    syncKnockoutToLiveMatches(tournamentSlug, categoryId, matches);
    setMainDrawGenerated(true);
    setStageView("main_draw");
    setSyncNotice(`Initialized ${slotSize}-slot Knockout Bracket. Click EDIT or ASSIGN on any match slot to customize players.`);
    setTimeout(() => setSyncNotice(null), 4000);
  };

  const handleOpenEditKoSlot = (match: KnockoutMatch, slot: "teamA" | "teamB") => {
    const currentTeam = slot === "teamA" ? match.teamA : match.teamB;
    const currentSeed = slot === "teamA" ? match.seedA : match.seedB;
    const rawPlayers = (currentTeam?.players || [])
      .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
      .map((p) => p.trim())
      .filter(Boolean);

    const matchedOption = currentTeam
      ? availableKnockoutTeams.find((opt) => isSamePlayoffTeam(opt.team, currentTeam))
      : undefined;

    setEditingKoSlot({
      matchId: match.id,
      slot,
      matchLabel: match.label,
      round: match.round,
      initialTeamId: currentTeam?.id || "",
      selectedTeamId: matchedOption?.team.id ?? (currentTeam ? "__custom__" : ""),
      swapWithMatchSlot: true,
      player1: rawPlayers[0] ?? "",
      player2: rawPlayers[1] ?? "",
      teamName: currentTeam?.name ?? "",
      club: currentTeam?.club ?? "",
      seedLabel: currentSeed ?? "",
      keepScore: Boolean(match.scoreA !== undefined || match.scoreB !== undefined),
    });
  };

  const handleSelectQuickKoTeam = (selectedId: string) => {
    if (!editingKoSlot) return;
    if (!selectedId || selectedId === "__custom__") {
      setEditingKoSlot({
        ...editingKoSlot,
        selectedTeamId: selectedId,
      });
      return;
    }

    const found = availableKnockoutTeams.find((opt) => opt.team.id === selectedId);
    if (!found) return;

    const splitPlayers = (found.team.players || [])
      .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
      .map((p) => p.trim())
      .filter(Boolean);

    const isSameAsInitial = editingKoSlot.initialTeamId === found.team.id;

    setEditingKoSlot({
      ...editingKoSlot,
      selectedTeamId: found.team.id,
      player1: splitPlayers[0] ?? "",
      player2: splitPlayers[1] ?? "",
      teamName: found.team.name,
      club: found.team.club || "",
      seedLabel: found.defaultSeed || editingKoSlot.seedLabel,
      keepScore: isSameAsInitial ? editingKoSlot.keepScore : false,
    });
  };

  const handleSaveKoSlot = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingKoSlot) return;

    const p1 = editingKoSlot.player1.replace(/\s+/g, " ").trim();
    const p2 = editingKoSlot.player2.replace(/\s+/g, " ").trim();
    const rawTeamName = editingKoSlot.teamName.replace(/\s+/g, " ").trim();
    const cleanClub = editingKoSlot.club.replace(/\s+/g, " ").trim();
    const cleanSeed = editingKoSlot.seedLabel.replace(/\s+/g, " ").trim();

    if (!p1 && !p2 && !rawTeamName) {
      handleClearKoSlot(editingKoSlot.matchId, editingKoSlot.slot);
      return;
    }

    const nextPlayers = [p1, p2].filter(Boolean);
    const effectiveTeamName = rawTeamName || (nextPlayers.length > 0 ? "n/a" : "Team");

    // Resolve the cleanest Team ID: match known roster pair if players match, otherwise avoid colliding with an unrelated ID
    const enteredNormPlayers = normalizePlayoffPlayers(nextPlayers);
    const matchedByRoster = enteredNormPlayers
      ? availableKnockoutTeams.find((opt) => normalizePlayoffPlayers(opt.team.players) === enteredNormPlayers)
      : undefined;
    const selectedOption =
      editingKoSlot.selectedTeamId && editingKoSlot.selectedTeamId !== "__custom__"
        ? availableKnockoutTeams.find((opt) => opt.team.id === editingKoSlot.selectedTeamId)
        : undefined;

    let resolvedTeamId = `ko-manual-${editingKoSlot.matchId}-${editingKoSlot.slot}-${Date.now()}`;
    if (matchedByRoster?.team.id) {
      resolvedTeamId = matchedByRoster.team.id;
    } else if (selectedOption?.team.id) {
      const optPlayers = (selectedOption.team.players || [])
        .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
        .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
        .filter(Boolean);
      const sharesAnyPlayer =
        nextPlayers.length === 0 ||
        optPlayers.length === 0 ||
        nextPlayers.some((np) => optPlayers.includes(np.toLowerCase()));
      if (sharesAnyPlayer) {
        resolvedTeamId = selectedOption.team.id;
      }
    }

    const nextTeam: Team = {
      id: resolvedTeamId,
      name: effectiveTeamName,
      players: nextPlayers.length > 0 ? nextPlayers : [effectiveTeamName],
      club: cleanClub,
    };

    setMainDrawMatches((prev) => {
      const targetMatch = prev.find((m) => m.id === editingKoSlot.matchId);
      if (!targetMatch) return prev;

      const prevTeamInTarget =
        editingKoSlot.slot === "teamA" ? targetMatch.teamA : targetMatch.teamB;
      const prevSeedInTarget =
        editingKoSlot.slot === "teamA" ? targetMatch.seedA : targetMatch.seedB;

      // Locate if nextTeam already occupies another slot (preferring same round) for optional swap
      let swapSource: { matchId: string; slot: "teamA" | "teamB" } | null = null;
      if (editingKoSlot.swapWithMatchSlot) {
        const sameRoundOther = prev.find(
          (m) =>
            m.round === editingKoSlot.round &&
            ((!(m.id === editingKoSlot.matchId && editingKoSlot.slot === "teamA") &&
              m.teamA &&
              isSamePlayoffTeam(m.teamA, nextTeam)) ||
              (!(m.id === editingKoSlot.matchId && editingKoSlot.slot === "teamB") &&
                m.teamB &&
                isSamePlayoffTeam(m.teamB, nextTeam))),
        );
        if (sameRoundOther) {
          if (
            !(sameRoundOther.id === editingKoSlot.matchId && editingKoSlot.slot === "teamA") &&
            sameRoundOther.teamA &&
            isSamePlayoffTeam(sameRoundOther.teamA, nextTeam)
          ) {
            swapSource = { matchId: sameRoundOther.id, slot: "teamA" };
          } else if (
            !(sameRoundOther.id === editingKoSlot.matchId && editingKoSlot.slot === "teamB") &&
            sameRoundOther.teamB &&
            isSamePlayoffTeam(sameRoundOther.teamB, nextTeam)
          ) {
            swapSource = { matchId: sameRoundOther.id, slot: "teamB" };
          }
        }
      }

      const updated = prev.map((m) => {
        let nextM: KnockoutMatch = { ...m };
        let touched = false;

        if (m.id === editingKoSlot.matchId) {
          touched = true;
          if (editingKoSlot.slot === "teamA") {
            nextM.teamA = nextTeam;
            nextM.manualTeamA = true;
            nextM.seedA = cleanSeed || undefined;
          } else {
            nextM.teamB = nextTeam;
            nextM.manualTeamB = true;
            nextM.seedB = cleanSeed || undefined;
          }
        }

        if (swapSource && m.id === swapSource.matchId) {
          touched = true;
          if (swapSource.slot === "teamA") {
            nextM.teamA = prevTeamInTarget;
            nextM.manualTeamA = Boolean(prevTeamInTarget);
            if (prevSeedInTarget) nextM.seedA = prevSeedInTarget;
          } else {
            nextM.teamB = prevTeamInTarget;
            nextM.manualTeamB = Boolean(prevTeamInTarget);
            if (prevSeedInTarget) nextM.seedB = prevSeedInTarget;
          }
        }

        if (touched) {
          const preserveScores =
            m.id === editingKoSlot.matchId &&
            editingKoSlot.keepScore &&
            !(swapSource && swapSource.matchId === m.id);
          if (!preserveScores) {
            delete nextM.scoreA;
            delete nextM.scoreB;
            delete nextM.winner;
          } else if (nextM.scoreA !== undefined && nextM.scoreB !== undefined) {
            if (nextM.scoreA > nextM.scoreB && nextM.teamA) {
              nextM.winner = nextM.teamA;
            } else if (nextM.scoreB > nextM.scoreA && nextM.teamB) {
              nextM.winner = nextM.teamB;
            } else {
              delete nextM.winner;
            }
          }
        }

        return nextM;
      });

      const { updated: advanced } = advancePlayoffBracket(updated);
      saveMainDrawMatches(tournamentSlug, categoryId, advanced);
      syncKnockoutToLiveMatches(tournamentSlug, categoryId, advanced);
      return advanced;
    });

    setEditingKoSlot(null);
    setSyncNotice("Knockout stage players updated and synced to Live Courts.");
    setTimeout(() => setSyncNotice(null), 4000);
  };

  const handleClearKoSlot = (matchId: string, slot: "teamA" | "teamB") => {
    setMainDrawMatches((prev) => {
      const updated = prev.map((m) => {
        if (m.id !== matchId) return m;
        const nextM: KnockoutMatch = { ...m };
        if (slot === "teamA") {
          delete nextM.teamA;
          nextM.manualTeamA = false;
        } else {
          delete nextM.teamB;
          nextM.manualTeamB = false;
        }
        delete nextM.scoreA;
        delete nextM.scoreB;
        delete nextM.winner;
        return nextM;
      });

      const { updated: advanced } = advancePlayoffBracket(updated);
      saveMainDrawMatches(tournamentSlug, categoryId, advanced);
      syncKnockoutToLiveMatches(tournamentSlug, categoryId, advanced);
      return advanced;
    });

    setEditingKoSlot(null);
    setSyncNotice("Knockout slot reset to TBD / Auto Feeder.");
    setTimeout(() => setSyncNotice(null), 4000);
  };

  const handleSwapKoMatchSides = (matchId: string) => {
    setMainDrawMatches((prev) => {
      const updated = prev.map((m) => {
        if (m.id !== matchId) return m;
        const nextM: KnockoutMatch = {
          ...m,
          teamA: m.teamB,
          teamB: m.teamA,
          manualTeamA: m.teamB ? true : Boolean(m.manualTeamB),
          manualTeamB: m.teamA ? true : Boolean(m.manualTeamA),
          seedA: m.seedB,
          seedB: m.seedA,
          scoreA: m.scoreB,
          scoreB: m.scoreA,
        };
        if (nextM.scoreA !== undefined && nextM.scoreB !== undefined) {
          if (nextM.scoreA > nextM.scoreB && nextM.teamA) {
            nextM.winner = nextM.teamA;
          } else if (nextM.scoreB > nextM.scoreA && nextM.teamB) {
            nextM.winner = nextM.teamB;
          } else {
            delete nextM.winner;
          }
        }
        return nextM;
      });

      const { updated: advanced } = advancePlayoffBracket(updated);
      saveMainDrawMatches(tournamentSlug, categoryId, advanced);
      syncKnockoutToLiveMatches(tournamentSlug, categoryId, advanced);
      return advanced;
    });
  };

  // Update Main Draw match score and advance winners
  const handleMainDrawScoreChange = (
    matchId: string,
    field: "scoreA" | "scoreB",
    val: string,
  ) => {
    const num = val === "" ? undefined : Math.max(0, parseInt(val, 10) || 0);

    setMainDrawMatches((prev) => {
      let updated = prev.map((m) => {
        if (m.id !== matchId) return m;
        const nextMatch: KnockoutMatch = { ...m, [field]: num };
        if (nextMatch.scoreA !== undefined && nextMatch.scoreB !== undefined) {
          if (nextMatch.scoreA > nextMatch.scoreB && nextMatch.teamA) {
            nextMatch.winner = nextMatch.teamA;
          } else if (nextMatch.scoreB > nextMatch.scoreA && nextMatch.teamB) {
            nextMatch.winner = nextMatch.teamB;
          } else {
            delete nextMatch.winner;
          }
        } else {
          delete nextMatch.winner;
        }
        return nextMatch;
      });

      const { updated: advanced } = advancePlayoffBracket(updated);
      saveMainDrawMatches(tournamentSlug, categoryId, advanced);
      syncKnockoutToLiveMatches(tournamentSlug, categoryId, advanced);
      return advanced;
    });
  };

  // Summary counts
  const totalMatchesCount = brackets.reduce((sum, b) => sum + b.matches.length, 0);
  const completedMatchesCount = brackets.reduce(
    (sum, b) => sum + b.matches.filter((m) => m.status === "completed").length,
    0,
  );
  const isRoundRobinFinished = totalMatchesCount > 0 && completedMatchesCount === totalMatchesCount;
  const isSingle3PairPool = brackets.length === 1 && Boolean(brackets[0]?.teams && brackets[0].teams.length === 3);
  const q0 = qualifiers[0];
  const q1 = qualifiers[1];
  const q2 = qualifiers[2];

  return (
    <div className="space-y-8 max-w-6xl pb-16">
      {/* ── Top Bar / Selector ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-6">
        <div>
          <span className="text-xs font-bold uppercase tracking-[0.28em] text-pickle">
            Tournament Engine
          </span>
          <h2 className="font-display text-4xl text-foreground mt-1">Brackets &amp; Standings</h2>
          <p className="text-sm text-muted-foreground">
            Official brackets generated from <strong>Bracket Draw (MAIN)</strong>. Automated playoff seeding powered by <strong>Point Differential</strong> tie-breakers.
          </p>
        </div>

        {/* Event & Category selectors */}
        <div className="flex flex-wrap gap-2 sm:gap-3">
          <select
            value={tournamentSlug}
            onChange={(e) => {
              setTournamentSlug(e.target.value);
              const t = tournaments.find((item) => item.slug === e.target.value);
              if (t && t.categories[0]) {
                setCategoryId(t.categories[0].id);
              }
            }}
            className="border border-input bg-background px-3 py-2 text-sm focus:border-pickle focus:outline-none font-medium"
          >
            {tournaments.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </select>

          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="border border-input bg-background px-3 py-2 text-sm focus:border-pickle focus:outline-none font-medium"
          >
            {tournament.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} ({c.teams.length} Teams)
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Sync Toast Notice */}
      {syncNotice && (
        <div className="p-3 bg-pickle/20 border border-pickle text-pickle text-xs font-bold uppercase tracking-wider flex items-center justify-between animate-in fade-in">
          <span>{syncNotice}</span>
          <button onClick={() => setSyncNotice(null)} className="cursor-pointer text-foreground hover:text-pickle">
            Dismiss
          </button>
        </div>
      )}

      {/* ── Empty State if no brackets drawn yet and no direct knockout draw created ── */}
      {brackets.length === 0 && !mainDrawGenerated ? (
        <div className="surface-card p-8 sm:p-12 text-center space-y-5 border-2 border-pickle/40 my-8">
          <span className="block text-xs uppercase tracking-[0.28em] font-bold text-pickle">
            Brackets Pending
          </span>
          <h3 className="font-display text-3xl sm:text-4xl text-foreground">
            No Brackets Generated Yet
          </h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            The official brackets for <strong>{category.label}</strong> have not been drawn yet. Launch the <strong>Bracket Draw (MAIN)</strong> ceremony for pool play, or create a direct Knockout Stage bracket to assign players manually.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            {onSwitchToBracketDraw && (
              <button
                onClick={onSwitchToBracketDraw}
                className="px-6 py-3.5 bg-brick text-sand font-display text-xl tracking-widest hover:bg-brick-deep transition-all cursor-pointer shadow-lg inline-flex items-center gap-2"
              >
                <span>Launch Bracket Draw (MAIN) &rarr;</span>
              </button>
            )}
          </div>
          <div className="pt-3 border-t border-border/60 max-w-md mx-auto space-y-2">
            <span className="block text-[0.65rem] font-mono font-bold uppercase tracking-widest text-muted-foreground">
              Or Initialize Manual Knockout Stage Directly
            </span>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {([4, 8, 16] as const).map((sz) => (
                <button
                  key={sz}
                  type="button"
                  onClick={() => handleCreateCustomMainDraw(sz)}
                  className="border border-border bg-charcoal px-3.5 py-2 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors rounded cursor-pointer"
                >
                  {sz}-Pair Knockout
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* ── Stage Switcher Navigation ── */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b-2 border-border pb-4">
            <div className="grid grid-cols-2 p-1 bg-card rounded-lg border-2 border-border sm:flex sm:bg-transparent sm:border-0 sm:p-0 sm:gap-2">
              <button
                onClick={() => setStageView("round_robin")}
                className={`flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 text-xs font-bold uppercase tracking-widest rounded transition-all cursor-pointer ${
                  stageView === "round_robin"
                    ? "bg-brick text-white shadow-sm font-bold"
                    : "text-foreground hover:text-pickle hover:bg-card font-bold"
                }`}
              >
                <span>1. Pools</span>
                <span className="rounded-full bg-sand/30 text-foreground font-bold px-2 py-0.5 text-[0.65rem]">
                  {completedMatchesCount}/{totalMatchesCount}
                </span>
              </button>

              <button
                onClick={() => setStageView("main_draw")}
                className={`flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 text-xs font-bold uppercase tracking-widest rounded transition-all cursor-pointer ${
                  stageView === "main_draw"
                    ? "bg-brick text-white shadow-sm font-bold"
                    : "text-foreground hover:text-pickle hover:bg-card font-bold"
                }`}
              >
                <span>2. Playoffs</span>
                {mainDrawGenerated ? (
                  <span className="rounded-full bg-pickle/30 text-pickle px-2 py-0.5 text-[0.65rem] font-bold">
                    Seeded
                  </span>
                ) : (
                  <span className="rounded-full bg-sand/10 px-2 py-0.5 text-[0.65rem] text-sand/50">
                    Ready
                  </span>
                )}
              </button>
            </div>

            {/* Quick action button based on current stage */}
            {stageView === "round_robin" ? (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={handleRefreshFromDrawn}
                  className="flex items-center gap-2 bg-charcoal border border-border px-4 py-2 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
                >
                  <span>Refresh from Bracket Draw (MAIN)</span>
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleGenerateMainDraw}
                  className="flex items-center gap-2 bg-pickle px-4 py-2 text-xs font-bold uppercase tracking-widest text-sand shadow hover:opacity-95 transition-opacity cursor-pointer"
                >
                  <span>Auto-Seed by Point Diff</span>
                </button>
                {mainDrawGenerated && (
                  <button
                    onClick={handleSyncToLiveCourts}
                    className="flex items-center gap-2 bg-charcoal border border-border px-4 py-2 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
                  >
                    <span>Sync to Live Courts</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* ────────────────────────────────────────────────
             STAGE 1: ROUND ROBIN BRACKETS
          ──────────────────────────────────────────────── */}
          {stageView === "round_robin" && (
            <div className="space-y-8">
              {/* Status banner */}
              <div className="surface-card flex flex-col md:flex-row items-start md:items-center justify-between gap-4 p-5 bg-card border-2 border-border border-l-4 border-l-pickle rounded-xl shadow-xs">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-pickle" />
                    <span className="text-xs font-bold uppercase tracking-widest text-pickle">
                      {isSingle3PairPool ? "3-Pair Single Pool Division" : `Round Robin Stage (${brackets.length} Pools)`}
                    </span>
                  </div>
                  <h3 className="font-display text-2xl text-foreground mt-0.5">
                    {isSingle3PairPool
                      ? threePairFormat === "round_robin_direct"
                        ? "Round-Robin Point Differential Mode"
                        : "Round-Robin with Playoff Bracket"
                      : `Round Robin Stage (${brackets.length} Pools, ${category.teams.length} Teams)`}
                  </h3>
                  <p className="text-xs text-foreground/80 font-medium mt-0.5 max-w-2xl">
                    {isSingle3PairPool
                      ? threePairFormat === "round_robin_direct"
                        ? "All 3 pairs play each other. Standings decide the podium directly based on Matches Won and Point Differential (+/-). Highest / Seed 1 is crowned Champion."
                        : "All 3 pairs play round-robin. Seed 1 advances to Final with a bye; Seed 2 and Seed 3 play a semifinal elimination match."
                      : "Top 2 teams from each bracket qualify for the Main Draw playoffs. Standings and playoff seeds are ranked automatically by Point Differential (+/-)."}
                  </p>

                  {isSingle3PairPool && (
                    <div className="mt-3 flex items-center gap-2">
                      <span className="text-[0.65rem] font-mono text-muted-foreground uppercase font-bold">Format:</span>
                      <button
                        type="button"
                        onClick={() => handleToggleThreePairFormat("round_robin_direct")}
                        className={`px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider rounded transition-colors cursor-pointer ${
                          threePairFormat === "round_robin_direct"
                            ? "bg-pickle text-sand border border-pickle"
                            : "bg-charcoal text-sand/70 border border-border hover:text-sand"
                        }`}
                      >
                        Round Robin Champion (Point Diff)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleThreePairFormat("knockout_bracket")}
                        className={`px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider rounded transition-colors cursor-pointer ${
                          threePairFormat === "knockout_bracket"
                            ? "bg-brick text-sand border border-brick"
                            : "bg-charcoal text-sand/70 border border-border hover:text-sand"
                        }`}
                      >
                        Playoff Bracket
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-4 shrink-0">
                  <div className="text-right">
                    <span className="block font-display text-2xl text-foreground">
                      {completedMatchesCount} / {totalMatchesCount}
                    </span>
                    <span className="text-[0.65rem] uppercase tracking-widest text-foreground font-bold">
                      Matches Completed
                    </span>
                  </div>
                  {isSingle3PairPool && threePairFormat === "round_robin_direct" ? (
                    <button
                      onClick={() => setStageView("main_draw")}
                      className="px-5 py-2.5 text-xs font-bold uppercase tracking-widest bg-pickle text-white hover:opacity-90 cursor-pointer shadow-lg rounded transition-opacity"
                    >
                      View Champion &rarr;
                    </button>
                  ) : (
                    <button
                      onClick={handleGenerateMainDraw}
                      disabled={qualifiers.length < 2}
                      className={`px-5 py-2.5 text-xs font-bold uppercase tracking-widest transition-all rounded ${
                        isRoundRobinFinished
                          ? "bg-pickle text-white animate-pulse hover:opacity-90 cursor-pointer shadow-lg font-bold"
                          : qualifiers.length >= 2
                            ? "bg-brick text-white hover:bg-brick-deep cursor-pointer font-bold"
                            : "border-2 border-border bg-card text-foreground/40 cursor-not-allowed font-bold"
                      }`}
                    >
                      Seed Main Draw &rarr;
                    </button>
                  )}
                </div>
              </div>

              {/* Champion Podium Banner for 3-pair round-robin direct champion mode */}
              {isSingle3PairPool && threePairFormat === "round_robin_direct" && isRoundRobinFinished && q0 && q1 && q2 && (
                <div className="surface-card p-6 bg-pickle/20 border-2 border-pickle rounded-xl text-center space-y-3 animate-in fade-in zoom-in duration-300">
                  <span className="block text-xs uppercase tracking-[0.28em] font-bold text-pickle">
                    Tournament Champion
                  </span>
                  <h4 className="font-display text-4xl text-foreground font-bold">
                    {getMatchTeamDisplay(q0.team.name, q0.team.players, q0.team.name).primary}
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    {q0.team.players.join(" & ")} &bull; Official Division Champion (Point Differential: {q0.pointDiff > 0 ? `+${q0.pointDiff}` : q0.pointDiff})
                  </p>
                  <div className="pt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 border-t border-pickle/30 text-xs max-w-xl mx-auto">
                    <div className="bg-amber-400/20 border border-amber-400/50 p-2.5 rounded text-center">
                      <span className="font-mono text-[0.65rem] font-black uppercase text-amber-500 block">1st Place / Gold</span>
                      <span className="font-bold text-foreground truncate block mt-0.5">{getMatchTeamDisplay(q0.team.name, q0.team.players, q0.team.name).primary}</span>
                      <span className="font-mono text-[0.65rem] text-muted-foreground mt-0.5 block">{q0.won}W - {q0.lost}L ({q0.pointDiff > 0 ? "+" : ""}{q0.pointDiff} diff)</span>
                    </div>
                    <div className="bg-slate-300/20 border border-slate-300/50 p-2.5 rounded text-center">
                      <span className="font-mono text-[0.65rem] font-black uppercase text-slate-400 block">2nd Place / Silver</span>
                      <span className="font-bold text-foreground truncate block mt-0.5">{getMatchTeamDisplay(q1.team.name, q1.team.players, q1.team.name).primary}</span>
                      <span className="font-mono text-[0.65rem] text-muted-foreground mt-0.5 block">{q1.won}W - {q1.lost}L ({q1.pointDiff > 0 ? "+" : ""}{q1.pointDiff} diff)</span>
                    </div>
                    <div className="bg-amber-700/20 border border-amber-700/50 p-2.5 rounded text-center">
                      <span className="font-mono text-[0.65rem] font-black uppercase text-amber-600 block">3rd Place / Bronze</span>
                      <span className="font-bold text-foreground truncate block mt-0.5">{getMatchTeamDisplay(q2.team.name, q2.team.players, q2.team.name).primary}</span>
                      <span className="font-mono text-[0.65rem] text-muted-foreground mt-0.5 block">{q2.won}W - {q2.lost}L ({q2.pointDiff > 0 ? "+" : ""}{q2.pointDiff} diff)</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Bracket cards grid */}
              <div className="grid gap-8 lg:grid-cols-2">
                {brackets.map((group) => {
                  const standings = calculateBracketStandings(group);
                  return (
                    <div
                      key={group.id}
                      className="surface-card p-0 overflow-hidden border-2 border-border shadow-xs rounded-xl flex flex-col"
                    >
                      {/* Bracket header */}
                      <div className="bg-card px-6 py-4 flex items-center justify-between border-b-2 border-border">
                        <div className="flex items-center gap-3">
                          <span className="font-display text-2xl text-foreground tracking-wide font-bold">
                            {group.name}
                          </span>
                          <span className="text-xs font-bold uppercase tracking-widest text-pickle bg-pickle/15 px-2.5 py-0.5 rounded border border-pickle/40">
                            {group.teams.length} Teams
                          </span>
                        </div>
                        <span className="text-xs text-foreground font-mono font-bold">
                          {group.matches.filter((m) => m.status === "completed").length}/
                          {group.matches.length} Finished
                        </span>
                      </div>

                      {/* ── Standings Table (with Point Differential Highlight) ── */}
                      <div className="p-4 border-b-2 border-border bg-card">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[0.68rem] uppercase tracking-[0.2em] font-bold text-muted-foreground">
                            Group Standings
                          </span>
                          <span className="text-[0.65rem] uppercase tracking-wider text-pickle font-bold">
                            Top 2 Advance to Playoffs
                          </span>
                        </div>
                        {/* Desktop Table */}
                        <div className="hidden sm:block overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-border text-muted-foreground text-left font-bold uppercase tracking-wider">
                                <th className="py-2 px-2 w-8">#</th>
                                <th className="py-2 px-2">Team</th>
                                <th className="py-2 px-1 text-center w-8">P</th>
                                <th className="py-2 px-1 text-center w-8 text-pickle">W</th>
                                <th className="py-2 px-1 text-center w-8 text-brick">L</th>
                                <th className="py-2 px-1 text-center w-12 font-bold text-pickle bg-pickle/10">+/- Diff</th>
                                <th className="py-2 px-2 text-right">Status</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                              {standings.map((row) => (
                                <tr
                                  key={row.team.id}
                                  className={`transition-colors ${
                                    row.isQualified ? "bg-pickle/10 font-semibold" : "hover:bg-pickle/5"
                                  }`}
                                >
                                  <td className="py-2 px-2 font-display text-sm">
                                    {row.rank}
                                  </td>
                                  <td className="py-2 px-2">
                                    {(() => {
                                      const disp = getMatchTeamDisplay(row.team.name, row.team.players, row.team.name);
                                      return (
                                        <>
                                          <div className="font-semibold text-foreground truncate max-w-[140px] sm:max-w-[180px]">
                                            {disp.primary}
                                          </div>
                                          <div className="flex items-center gap-1.5 text-[0.65rem] text-muted-foreground truncate mt-0.5">
                                            <span className="truncate">
                                              {disp.secondary ?? `Team: ${row.team.name}`}
                                            </span>
                                            {row.team.club && (
                                              <>
                                                <span className="text-muted-foreground/40 shrink-0">•</span>
                                                <span className="text-[0.6rem] px-1.5 py-0.2 rounded bg-charcoal/40 text-sand/80 border border-border/60 shrink-0 font-medium">
                                                  {row.team.club}
                                                </span>
                                              </>
                                            )}
                                          </div>
                                        </>
                                      );
                                    })()}
                                  </td>
                                  <td className="py-2 px-1 text-center">{row.played}</td>
                                  <td className="py-2 px-1 text-center text-pickle font-bold">
                                    {row.won}
                                  </td>
                                  <td className="py-2 px-1 text-center text-brick">{row.lost}</td>
                                  <td
                                    className={`py-2 px-1 text-center font-mono font-bold bg-pickle/5 ${
                                      row.pointDiff > 0
                                        ? "text-pickle"
                                        : row.pointDiff < 0
                                          ? "text-brick"
                                          : "text-muted-foreground"
                                    }`}
                                  >
                                    {row.pointDiff > 0 ? `+${row.pointDiff}` : row.pointDiff}
                                  </td>
                                  <td className="py-2 px-2 text-right">
                                    {row.isQualified ? (
                                      <span className="inline-block bg-pickle text-sand text-[0.6rem] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded">
                                        Qualified ({group.name.replace("Bracket ", "")}{row.rank})
                                      </span>
                                    ) : (
                                      <span className="text-[0.65rem] text-muted-foreground">-</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Mobile Standings Cards (Zero Horizontal Scroll) */}
                        <div className="sm:hidden space-y-2 pt-1">
                          {standings.map((row) => (
                            <div
                              key={row.team.id}
                              className={`p-2.5 rounded border transition-colors ${
                                row.isQualified
                                  ? "border-pickle/50 bg-pickle/10"
                                  : "border-2 border-border bg-card"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full font-display text-sm shrink-0 ${
                                    row.isQualified ? "bg-pickle text-sand font-bold" : "bg-charcoal text-sand/70 border border-border"
                                  }`}>
                                    {row.rank}
                                  </span>
                                  <div className="min-w-0">
                                    {(() => {
                                      const disp = getMatchTeamDisplay(row.team.name, row.team.players, row.team.name);
                                      return (
                                        <>
                                          <div className="font-semibold text-xs text-foreground truncate">
                                            {disp.primary}
                                          </div>
                                          <div className="flex items-center gap-1 text-[0.62rem] text-muted-foreground truncate mt-0.5">
                                            <span className="truncate">
                                              {disp.secondary ?? `Team: ${row.team.name}`}
                                            </span>
                                            {row.team.club && (
                                              <>
                                                <span className="text-muted-foreground/40 shrink-0">•</span>
                                                <span className="text-[0.6rem] px-1 py-0.2 rounded bg-charcoal/40 text-sand/80 border border-border/60 shrink-0 font-medium">
                                                  {row.team.club}
                                                </span>
                                              </>
                                            )}
                                          </div>
                                        </>
                                      );
                                    })()}
                                  </div>
                                </div>
                                {isSingle3PairPool && threePairFormat === "round_robin_direct" ? (
                                  <span className={`text-[0.62rem] font-bold uppercase tracking-wider px-2 py-0.5 rounded shrink-0 ${
                                    row.rank === 1
                                      ? "bg-amber-400 text-charcoal font-black"
                                      : row.rank === 2
                                        ? "bg-slate-300 text-charcoal font-black"
                                        : "bg-amber-700 text-sand font-black"
                                  }`}>
                                    {isRoundRobinFinished
                                      ? row.rank === 1 ? "Champion (Gold)" : row.rank === 2 ? "Runner-Up (Silver)" : "3rd Place (Bronze)"
                                      : row.rank === 1 ? "Current Leader (#1)" : `Rank ${row.rank}`}
                                  </span>
                                ) : (
                                  <span className={`text-[0.62rem] font-bold uppercase tracking-wider px-2 py-0.5 rounded shrink-0 ${
                                    row.isQualified
                                      ? "bg-pickle text-sand font-black"
                                      : "text-muted-foreground border border-border/60"
                                  }`}>
                                    {row.isQualified ? "Advances" : `Rank ${row.rank}`}
                                  </span>
                                )}
                              </div>

                              {/* Stats Row */}
                              <div className="mt-2 pt-2 border-t-2 border-border grid grid-cols-4 gap-1 text-center font-mono text-[0.65rem]">
                                <div className="bg-card border-2 border-border rounded py-1">
                                  <span className="text-foreground/80 font-bold block text-[0.55rem]">PLAYED</span>
                                  <span className="font-bold text-foreground">{row.played}</span>
                                </div>
                                <div className="bg-card border-2 border-border rounded py-1">
                                  <span className="text-foreground/80 font-bold block text-[0.55rem]">WON</span>
                                  <span className="font-bold text-pickle">{row.won}</span>
                                </div>
                                <div className="bg-card border-2 border-border rounded py-1">
                                  <span className="text-foreground/80 font-bold block text-[0.55rem]">LOST</span>
                                  <span className="font-bold text-brick">{row.lost}</span>
                                </div>
                                <div className="bg-pickle/15 rounded py-1 border-2 border-pickle/30">
                                  <span className="text-pickle block text-[0.55rem] font-bold">DIFF</span>
                                  <span className={`font-bold ${row.pointDiff > 0 ? "text-pickle" : row.pointDiff < 0 ? "text-brick" : "text-foreground"}`}>
                                    {row.pointDiff > 0 ? `+${row.pointDiff}` : row.pointDiff}
                                  </span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* ── Match Fixtures List ── */}
                      <div className="p-4 flex-1 flex flex-col justify-between">
                        <div>
                          <span className="block text-[0.68rem] uppercase tracking-[0.2em] font-bold text-muted-foreground mb-3">
                            Matches &amp; Score Entry
                          </span>

                          <div className="space-y-3">
                            {group.matches.map((m) => {
                              const teamA = group.teams.find((t) => t.id === m.teamAId);
                              const teamB = group.teams.find((t) => t.id === m.teamBId);
                              const dispA = getMatchTeamDisplay(teamA?.name, teamA?.players, "Team A");
                              const dispB = getMatchTeamDisplay(teamB?.name, teamB?.players, "Team B");
                              const isFinished = m.status === "completed";
                              const winnerA = isFinished && (m.scoreA ?? 0) > (m.scoreB ?? 0);
                              const winnerB = isFinished && (m.scoreB ?? 0) > (m.scoreA ?? 0);

                              return (
                                <div
                                  key={m.id}
                                  className={`border p-3 transition-colors ${
                                    isFinished
                                      ? "border-2 border-border bg-card"
                                      : m.status === "in_progress"
                                        ? "border-pickle/50 bg-pickle/5"
                                        : "border-border/60 bg-background"
                                  }`}
                                >
                                  <div className="flex items-center justify-between text-[0.65rem] uppercase tracking-wider text-muted-foreground mb-2">
                                    <span className="font-mono text-pickle font-semibold">
                                      {m.court}
                                    </span>
                                    <div className="flex items-center gap-2">
                                      <span
                                        className={`px-1.5 py-0.2 rounded font-mono ${
                                          isFinished
                                            ? "text-pickle bg-pickle/15 font-bold"
                                            : m.status === "in_progress"
                                              ? "text-brick bg-brick/15 font-bold"
                                              : ""
                                        }`}
                                      >
                                        {m.status === "completed"
                                          ? "Final"
                                          : m.status === "in_progress"
                                            ? "In Play"
                                            : "Scheduled"}
                                      </span>
                                      {isFinished && (
                                        <button
                                          onClick={() => handleResetScore(group.id, m.id)}
                                          className="hover:text-brick underline text-[0.6rem] cursor-pointer"
                                        >
                                          Reset
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  <div className="grid grid-cols-[1fr_auto_auto_auto_1fr] items-center gap-2 text-sm">
                                    {/* Team A */}
                                    <div className="truncate">
                                      <span
                                        className={`block truncate ${
                                          winnerA ? "font-bold text-pickle" : "font-semibold text-foreground"
                                        }`}
                                      >
                                        {dispA.primary}
                                      </span>
                                      {dispA.secondary && (
                                        <span className="block text-[0.65rem] text-muted-foreground truncate">
                                          {dispA.secondary}
                                        </span>
                                      )}
                                    </div>

                                    {/* Score A Input */}
                                    <input
                                      type="number"
                                      min={0}
                                      placeholder="0"
                                      value={m.scoreA ?? ""}
                                      onChange={(e) =>
                                        handleScoreChange(group.id, m.id, "scoreA", e.target.value)
                                      }
                                      onBlur={() =>
                                        persistPoolMatchScoreToStore(group.id, m.id, m.scoreA, m.scoreB)
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          persistPoolMatchScoreToStore(group.id, m.id, m.scoreA, m.scoreB);
                                        }
                                      }}
                                      className={`w-12 h-9 text-center font-display text-xl border-2 focus:border-pickle focus:outline-none transition-colors rounded ${
                                        winnerA
                                          ? "border-pickle bg-pickle/20 text-pickle font-bold"
                                          : "border-border bg-card text-foreground font-bold"
                                      }`}
                                    />

                                    {/* VS Divider */}
                                    <span className="font-display text-sm text-brick px-1 font-bold">VS</span>

                                    {/* Score B Input */}
                                    <input
                                      type="number"
                                      min={0}
                                      placeholder="0"
                                      value={m.scoreB ?? ""}
                                      onChange={(e) =>
                                        handleScoreChange(group.id, m.id, "scoreB", e.target.value)
                                      }
                                      onBlur={() =>
                                        persistPoolMatchScoreToStore(group.id, m.id, m.scoreA, m.scoreB)
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          persistPoolMatchScoreToStore(group.id, m.id, m.scoreA, m.scoreB);
                                        }
                                      }}
                                      className={`w-12 h-9 text-center font-display text-xl border-2 focus:border-pickle focus:outline-none transition-colors rounded ${
                                        winnerB
                                          ? "border-pickle bg-pickle/20 text-pickle font-bold"
                                          : "border-border bg-card text-foreground font-bold"
                                      }`}
                                    />

                                    {/* Team B */}
                                    <div className="truncate text-right">
                                      <span
                                        className={`block truncate ${
                                          winnerB ? "font-bold text-pickle" : "font-semibold text-foreground"
                                        }`}
                                      >
                                        {dispB.primary}
                                      </span>
                                      {dispB.secondary && (
                                        <span className="block text-[0.65rem] text-muted-foreground truncate">
                                          {dispB.secondary}
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  {/* Quick win presets */}
                                  {!isFinished && (
                                    <div className="mt-2.5 pt-2 border-t border-border/60 flex items-center justify-end gap-1.5">
                                      <span className="text-[0.6rem] text-muted-foreground uppercase mr-1">
                                        Quick Score:
                                      </span>
                                      <button
                                        onClick={() => handleQuickScore(group.id, m.id, 11, 7)}
                                        className="px-2 py-0.5 text-[0.65rem] border border-border hover:border-pickle hover:text-pickle transition-colors"
                                      >
                                        11-7 (A)
                                      </button>
                                      <button
                                        onClick={() => handleQuickScore(group.id, m.id, 7, 11)}
                                        className="px-2 py-0.5 text-[0.65rem] border border-border hover:border-pickle hover:text-pickle transition-colors"
                                      >
                                        7-11 (B)
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ────────────────────────────────────────────────
             STAGE 2: MAIN DRAW (KNOCKOUT TOURNAMENT TREE)
          ──────────────────────────────────────────────── */}
          {stageView === "main_draw" && (
            <div className="space-y-8">
              {/* ── Playoff Seeding Board (Point Differential Engine) ── */}
              <div className="surface-card p-5 bg-card border-2 border-border border-l-4 border-l-pickle rounded-xl shadow-xs">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-pickle" />
                      <span className="text-xs font-bold uppercase tracking-[0.28em] text-pickle">
                        Point Differential Seeding Engine
                      </span>
                    </div>
                    <h3 className="font-display text-2xl sm:text-3xl text-foreground mt-0.5">
                      Playoff Seeding Standings ({qualifiers.length} Teams)
                    </h3>
                    <p className="text-xs text-foreground/80 font-medium mt-1 max-w-2xl">
                      Qualifiers are seeded strictly by <strong>Wins</strong> and <strong>Point Differential (+/-)</strong>.
                      Pool winners claim the top seeds (1 to {qualifiers.length / 2 || 1}); pool runners-up claim seeds ({qualifiers.length / 2 + 1 || 2} to {qualifiers.length}). First-round group rematches are automatically avoided.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 self-start md:self-auto">
                    <button
                      onClick={handleGenerateMainDraw}
                      className="bg-pickle px-5 py-2.5 font-display text-lg tracking-widest text-sand hover:opacity-90 transition-opacity flex items-center gap-2 cursor-pointer shadow-md"
                    >
                      <span>Auto-Seed Main Draw</span>
                    </button>
                    {mainDrawGenerated && (
                      <button
                        onClick={handleSyncToLiveCourts}
                        className="bg-charcoal border border-border px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
                      >
                        <span>Sync to Live Courts</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Desktop Seeding Table */}
                <div className="mt-5 border-t border-border pt-4 hidden sm:block overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground text-left font-bold uppercase tracking-wider">
                        <th className="py-2 px-2 w-12 text-center">Seed</th>
                        <th className="py-2 px-2">Team</th>
                        <th className="py-2 px-2">Group Origin</th>
                        <th className="py-2 px-1 text-center w-12">Record</th>
                        <th className="py-2 px-1 text-center w-16">PF / PA</th>
                        <th className="py-2 px-2 text-center w-20 bg-pickle/10 font-bold text-pickle">
                          Point Diff
                        </th>
                        <th className="py-2 px-2 text-right">Projected Matchup</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {qualifiers.map((q) => {
                        // Determine projected opponent in bracket
                        let oppSeed = qualifiers.length + 1 - q.overallSeed;
                        if (qualifiers.length === 16) {
                          // In 16-draw pairings: [1,16], [8,9], [4,13], [5,12], [2,15], [7,10], [3,14], [6,11]
                          const pairMap: Record<number, number> = {
                            1: 16, 16: 1, 8: 9, 9: 8, 4: 13, 13: 4, 5: 12, 12: 5,
                            2: 15, 15: 2, 7: 10, 10: 7, 3: 14, 14: 3, 6: 11, 11: 6,
                          };
                          oppSeed = pairMap[q.overallSeed] ?? oppSeed;
                        } else if (qualifiers.length === 8) {
                          const pairMap: Record<number, number> = {
                            1: 8, 8: 1, 4: 5, 5: 4, 2: 7, 7: 2, 3: 6, 6: 3,
                          };
                          oppSeed = pairMap[q.overallSeed] ?? oppSeed;
                        }
                        const opp = qualifiers.find((x) => x.overallSeed === oppSeed);

                        return (
                          <tr
                            key={q.team.id}
                            className="hover:bg-pickle/5 transition-colors"
                          >
                            <td className="py-2 px-2 text-center">
                              <span className={`inline-block px-2 py-0.5 font-display text-sm rounded ${
                                q.overallSeed <= (qualifiers.length / 2)
                                  ? "bg-pickle text-sand font-bold"
                                  : "bg-charcoal text-sand/80 border border-border"
                              }`}>
                                #{q.overallSeed}
                              </span>
                            </td>
                            <td className="py-2 px-2">
                              {(() => {
                                const disp = getMatchTeamDisplay(q.team.name, q.team.players, q.team.name);
                                return (
                                  <>
                                    <span className="font-semibold text-foreground block truncate">
                                      {disp.primary}
                                    </span>
                                    <span className="text-[0.65rem] text-muted-foreground truncate block">
                                      {disp.secondary ?? `Team: ${q.team.name}`}
                                    </span>
                                  </>
                                );
                              })()}
                            </td>
                            <td className="py-2 px-2">
                              <span className="font-mono text-muted-foreground">
                                {q.bracketName} ({q.bracketRank === 1 ? "1st" : "2nd"})
                              </span>
                            </td>
                            <td className="py-2 px-1 text-center font-mono">
                              {q.won}W - {q.lost}L
                            </td>
                            <td className="py-2 px-1 text-center font-mono text-muted-foreground">
                              {q.pointsFor} / {q.pointsAgainst}
                            </td>
                            <td className="py-2 px-2 text-center font-mono font-bold bg-pickle/5">
                              <span className={`px-2 py-0.5 rounded text-xs ${
                                q.pointDiff > 0
                                  ? "bg-pickle/20 text-pickle font-bold"
                                  : q.pointDiff < 0
                                    ? "bg-brick/20 text-brick font-bold"
                                    : "bg-muted text-muted-foreground"
                              }`}>
                                {q.pointDiff > 0 ? `+${q.pointDiff}` : q.pointDiff}
                              </span>
                            </td>
                            <td className="py-2 px-2 text-right">
                              {opp ? (
                                <span className="text-muted-foreground font-mono">
                                  vs #{opp.overallSeed} {getMatchTeamDisplay(opp.team.name, opp.team.players, opp.team.name).primary} ({opp.pointDiff > 0 ? "+" : ""}{opp.pointDiff})
                                </span>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile View: Vertical Seeding Cards (Zero horizontal scrolling) */}
                <div className="sm:hidden space-y-2.5 mt-4 border-t border-border pt-4">
                  {qualifiers.map((q) => {
                    let oppSeed = qualifiers.length + 1 - q.overallSeed;
                    if (qualifiers.length === 16) {
                      const pairMap: Record<number, number> = {
                        1: 16, 16: 1, 8: 9, 9: 8, 4: 13, 13: 4, 5: 12, 12: 5,
                        2: 15, 15: 2, 7: 10, 10: 7, 3: 14, 14: 3, 6: 11, 11: 6,
                      };
                      oppSeed = pairMap[q.overallSeed] ?? oppSeed;
                    } else if (qualifiers.length === 8) {
                      const pairMap: Record<number, number> = {
                        1: 8, 8: 1, 4: 5, 5: 4, 2: 7, 7: 2, 3: 6, 6: 3,
                      };
                      oppSeed = pairMap[q.overallSeed] ?? oppSeed;
                    }
                    const opp = qualifiers.find((x) => x.overallSeed === oppSeed);
                    const isTopHalf = q.overallSeed <= (qualifiers.length / 2 || 1);

                    return (
                      <div
                        key={`m-seed-${q.team.id}`}
                        className="bg-card border-2 border-border rounded-xl p-3.5 space-y-2 shadow-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`shrink-0 px-2 py-0.5 font-display text-sm rounded ${
                                isTopHalf
                                  ? "bg-pickle text-white font-bold"
                                  : "bg-card text-foreground font-bold border-2 border-border"
                              }`}
                            >
                              #{q.overallSeed}
                            </span>
                            <div className="min-w-0">
                              {(() => {
                                const disp = getMatchTeamDisplay(q.team.name, q.team.players, q.team.name);
                                return (
                                  <>
                                    <span className="font-semibold text-foreground text-xs block truncate">
                                      {disp.primary}
                                    </span>
                                    <span className="text-[0.65rem] text-foreground/80 font-bold truncate block">
                                      {disp.secondary ?? `Team: ${q.team.name}`}
                                    </span>
                                  </>
                                );
                              })()}
                            </div>
                          </div>
                          <span className="shrink-0 text-[0.65rem] font-mono px-2 py-0.5 rounded bg-card border-2 border-border text-foreground font-bold">
                            {q.bracketName} ({q.bracketRank === 1 ? "1st" : "2nd"})
                          </span>
                        </div>

                        {/* Mini stat pills */}
                        <div className="grid grid-cols-3 gap-1.5 pt-1 border-t-2 border-border text-center font-mono">
                          <div className="bg-card px-1.5 py-1 rounded border-2 border-border">
                            <span className="block text-[0.55rem] uppercase text-foreground/80 font-bold">Record</span>
                            <span className="text-xs text-foreground font-bold">{q.won}W - {q.lost}L</span>
                          </div>
                          <div className="bg-card px-1.5 py-1 rounded border-2 border-border">
                            <span className="block text-[0.55rem] uppercase text-foreground/80 font-bold">PF / PA</span>
                            <span className="text-xs text-foreground font-bold">{q.pointsFor} / {q.pointsAgainst}</span>
                          </div>
                          <div className={`px-1.5 py-1 rounded border-2 ${
                            q.pointDiff > 0
                              ? "bg-pickle/15 border-pickle/40 text-pickle font-bold"
                              : q.pointDiff < 0
                                ? "bg-brick/15 border-brick/40 text-brick font-bold"
                                : "bg-card border-border text-foreground font-bold"
                          }`}>
                            <span className="block text-[0.55rem] uppercase font-bold">Point Diff</span>
                            <span className="text-xs font-bold">{q.pointDiff > 0 ? `+${q.pointDiff}` : q.pointDiff}</span>
                          </div>
                        </div>

                        {/* Projected Matchup */}
                        <div className="text-[0.65rem] font-mono text-muted-foreground flex items-center justify-between pt-1">
                          <span className="uppercase text-[0.55rem] tracking-wider text-muted-foreground/70">Projected:</span>
                          {opp ? (
                            <span className="text-sand/90 truncate ml-2">
                              vs #{opp.overallSeed} {getMatchTeamDisplay(opp.team.name, opp.team.players, opp.team.name).primary} ({opp.pointDiff > 0 ? "+" : ""}{opp.pointDiff})
                            </span>
                          ) : (
                            <span>-</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ── Main Draw Knockout Tree / 3-Pair Round Robin Champion ── */}
              {isSingle3PairPool && threePairFormat === "round_robin_direct" ? (
                <div className="surface-card p-8 border-2 border-pickle/60 bg-pickle/10 rounded-xl space-y-4 text-center">
                  <span className="text-xs uppercase tracking-[0.28em] font-bold text-pickle block">
                    Round-Robin Direct Champion Format
                  </span>
                  <h4 className="font-display text-3xl sm:text-4xl text-foreground">
                    {isRoundRobinFinished && q0
                      ? `Champion: ${getMatchTeamDisplay(q0.team.name, q0.team.players, q0.team.name).primary}`
                      : "Standings Determine The Champion"}
                  </h4>
                  <p className="text-sm text-foreground/80 max-w-lg mx-auto">
                    {isRoundRobinFinished
                      ? "All 3 round-robin matches are completed. The highest-ranked team by point differential has been crowned the Official Division Champion."
                      : "Matches are currently in progress. The team with the highest record and point differential will be crowned Champion directly."}
                  </p>
                  {isRoundRobinFinished && q0 && q1 && q2 && (
                    <div className="pt-2 grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-lg mx-auto text-left">
                      <div className="p-3 bg-amber-400/20 border border-amber-400/50 rounded text-center">
                        <span className="text-[0.65rem] font-black uppercase text-amber-500 block">Gold / Champion</span>
                        <span className="font-bold text-foreground truncate block mt-0.5">{getMatchTeamDisplay(q0.team.name, q0.team.players, q0.team.name).primary}</span>
                        <span className="text-xs font-mono text-muted-foreground">{q0.won}W - {q0.lost}L ({q0.pointDiff > 0 ? "+" : ""}{q0.pointDiff})</span>
                      </div>
                      <div className="p-3 bg-slate-300/20 border border-slate-300/50 rounded text-center">
                        <span className="text-[0.65rem] font-black uppercase text-slate-400 block">Silver / Runner-Up</span>
                        <span className="font-bold text-foreground truncate block mt-0.5">{getMatchTeamDisplay(q1.team.name, q1.team.players, q1.team.name).primary}</span>
                        <span className="text-xs font-mono text-muted-foreground">{q1.won}W - {q1.lost}L ({q1.pointDiff > 0 ? "+" : ""}{q1.pointDiff})</span>
                      </div>
                      <div className="p-3 bg-amber-700/20 border border-amber-700/50 rounded text-center">
                        <span className="text-[0.65rem] font-black uppercase text-amber-600 block">Bronze / 3rd Place</span>
                        <span className="font-bold text-foreground truncate block mt-0.5">{getMatchTeamDisplay(q2.team.name, q2.team.players, q2.team.name).primary}</span>
                        <span className="text-xs font-mono text-muted-foreground">{q2.won}W - {q2.lost}L ({q2.pointDiff > 0 ? "+" : ""}{q2.pointDiff})</span>
                      </div>
                    </div>
                  )}
                  <div className="pt-4 flex flex-wrap items-center justify-center gap-3">
                    <button
                      onClick={() => setStageView("round_robin")}
                      className="bg-pickle px-5 py-2 text-xs font-bold uppercase tracking-widest text-sand hover:opacity-90 transition-opacity cursor-pointer shadow-md rounded"
                    >
                      &larr; View Round-Robin Standings
                    </button>
                    <button
                      onClick={() => handleToggleThreePairFormat("knockout_bracket")}
                      className="border border-border bg-charcoal px-4 py-2 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors cursor-pointer rounded"
                    >
                      Switch to Playoff Bracket
                    </button>
                  </div>
                </div>
              ) : !mainDrawGenerated || mainDrawMatches.length === 0 ? (
                <div className="surface-card p-8 sm:p-12 text-center space-y-5 border border-border">
                  <span className="text-xs uppercase tracking-[0.28em] font-bold text-pickle block">
                    Playoff Bracket
                  </span>
                  <h4 className="font-display text-3xl text-foreground">Main Draw Ready to Seed</h4>
                  <p className="text-sm text-muted-foreground max-w-md mx-auto">
                    Seed qualified pairs automatically by Point Differential, or initialize a custom Knockout Stage bracket and manually assign players to any slot.
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    {qualifiers.length >= 2 && (
                      <button
                        onClick={handleGenerateMainDraw}
                        className="bg-brick px-6 py-3 font-display text-2xl tracking-widest text-sand hover:bg-brick-deep transition-colors cursor-pointer shadow-lg"
                      >
                        Seed Main Draw (Point Differential) &rarr;
                      </button>
                    )}
                  </div>
                  <div className="pt-3 border-t border-border/60 max-w-md mx-auto space-y-2">
                    <span className="block text-[0.65rem] font-mono font-bold uppercase tracking-widest text-muted-foreground">
                      Or Create Custom Knockout Bracket
                    </span>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {([2, 4, 8, 16] as const).map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          onClick={() => handleCreateCustomMainDraw(sz)}
                          className="border border-border bg-charcoal px-3.5 py-2 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors rounded cursor-pointer"
                        >
                          {sz}-Pair Bracket
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                    <div>
                      <span className="text-xs font-bold uppercase tracking-[0.28em] text-pickle">
                        Single Elimination Stage
                      </span>
                      <h3 className="font-display text-3xl text-foreground">Championship Playoff Tree</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Click <strong>EDIT</strong> or <strong>ASSIGN</strong> on any slot to manually change players, or <strong>SWAP</strong> to flip sides.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {qualifiers.length >= 2 && (
                        <button
                          onClick={handleGenerateMainDraw}
                          className="border border-border bg-charcoal px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors cursor-pointer rounded"
                        >
                          Re-Seed by Point Diff
                        </button>
                      )}
                      {([4, 8, 16] as const).map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          onClick={() => handleCreateCustomMainDraw(sz)}
                          className="border border-border bg-card px-2.5 py-1.5 text-[0.68rem] font-mono font-bold uppercase tracking-wider text-foreground hover:border-pickle hover:text-pickle transition-colors cursor-pointer rounded"
                          title={`Initialize ${sz}-Pair Bracket`}
                        >
                          {sz}-Slot
                        </button>
                      ))}
                      <button
                        onClick={handleSyncToLiveCourts}
                        className="bg-pickle px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-sand hover:opacity-90 transition-opacity cursor-pointer rounded"
                      >
                        Sync to Live Courts
                      </button>
                    </div>
                  </div>

                  {/* Responsive Elimination Tree View */}
                  <div className={`grid gap-6 ${
                    mainDrawMatches.some((m) => m.round === "Round of 16")
                      ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-4"
                      : mainDrawMatches.some((m) => m.round === "Quarterfinal")
                        ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
                        : "grid-cols-1 md:grid-cols-2"
                  }`}>
                    {/* Round of 16 (if 16 teams) */}
                    {mainDrawMatches.some((m) => m.round === "Round of 16") && (
                      <div className="space-y-4">
                        <div className="flex items-center gap-2 border-b border-border pb-2">
                          <span className="h-2 w-2 rounded-full bg-pickle" />
                          <h4 className="font-display text-xl text-foreground">Round of 16</h4>
                        </div>

                        {mainDrawMatches
                          .filter((m) => m.round === "Round of 16")
                          .map((m) => (
                            <KnockoutMatchCard
                              key={m.id}
                              match={m}
                              onScoreChange={handleMainDrawScoreChange}
                              onEditSlot={handleOpenEditKoSlot}
                              onSwapSides={handleSwapKoMatchSides}
                            />
                          ))}
                      </div>
                    )}

                    {/* Quarterfinals */}
                    {mainDrawMatches.some((m) => m.round === "Quarterfinal") && (
                      <div className="space-y-4">
                        <div className="flex items-center gap-2 border-b border-border pb-2">
                          <span className="h-2 w-2 rounded-full bg-pickle" />
                          <h4 className="font-display text-xl text-foreground">Quarterfinals</h4>
                        </div>

                        {mainDrawMatches
                          .filter((m) => m.round === "Quarterfinal")
                          .map((m) => (
                            <KnockoutMatchCard
                              key={m.id}
                              match={m}
                              onScoreChange={handleMainDrawScoreChange}
                              onEditSlot={handleOpenEditKoSlot}
                              onSwapSides={handleSwapKoMatchSides}
                            />
                          ))}
                      </div>
                    )}

                    {/* Semifinals */}
                    {mainDrawMatches.some((m) => m.round === "Semifinal") && (
                      <div className="space-y-4">
                        <div className="flex items-center gap-2 border-b border-border pb-2">
                          <span className="h-2 w-2 rounded-full bg-pickle" />
                          <h4 className="font-display text-xl text-foreground">Semifinals</h4>
                        </div>

                        {mainDrawMatches
                          .filter((m) => m.round === "Semifinal")
                          .map((m) => (
                            <KnockoutMatchCard
                              key={m.id}
                              match={m}
                              onScoreChange={handleMainDrawScoreChange}
                              onEditSlot={handleOpenEditKoSlot}
                              onSwapSides={handleSwapKoMatchSides}
                            />
                          ))}
                      </div>
                    )}

                    {/* Championship Final & 3rd Place Match */}
                    <div className="space-y-6">
                      <div className="space-y-4">
                        <div className="flex items-center gap-2 border-b border-border pb-2">
                          <span className="h-2 w-2 rounded-full bg-brick" />
                          <h4 className="font-display text-xl text-brick">Championship Final</h4>
                        </div>

                        {mainDrawMatches
                          .filter((m) => m.round === "Final")
                          .map((m) => (
                            <KnockoutMatchCard
                              key={m.id}
                              match={m}
                              onScoreChange={handleMainDrawScoreChange}
                              onEditSlot={handleOpenEditKoSlot}
                              onSwapSides={handleSwapKoMatchSides}
                              isFinal
                            />
                          ))}

                        {/* Champion Banner */}
                        {(() => {
                          const finalMatch = mainDrawMatches.find((m) => m.round === "Final");
                          if (finalMatch?.winner) {
                            const champDisp = getMatchTeamDisplay(
                              finalMatch.winner.name,
                              finalMatch.winner.players,
                              finalMatch.winner.name,
                            );
                            return (
                              <div className="surface-card p-6 bg-pickle/20 border-2 border-pickle text-center space-y-2 animate-in fade-in zoom-in duration-300">
                                <span className="block text-xs uppercase tracking-[0.28em] font-bold text-pickle">
                                  Tournament Champion
                                </span>
                                <h4 className="font-display text-3xl text-foreground">
                                  {champDisp.primary}
                                </h4>
                                {champDisp.secondary && (
                                  <p className="text-xs text-muted-foreground">
                                    {champDisp.secondary}
                                  </p>
                                )}
                              </div>
                            );
                          }
                          return null;
                        })()}
                      </div>

                      {/* 3rd Place Match */}
                      {mainDrawMatches.some((m) => m.round === "Bronze") && (
                        <div className="space-y-4">
                          <div className="flex items-center gap-2 border-b border-border pb-2">
                            <span className="h-2 w-2 rounded-full bg-muted-foreground" />
                            <h4 className="font-display text-xl text-muted-foreground">3rd Place Match</h4>
                          </div>

                          {mainDrawMatches
                            .filter((m) => m.round === "Bronze")
                            .map((m) => (
                              <KnockoutMatchCard
                                key={m.id}
                                match={m}
                                onScoreChange={handleMainDrawScoreChange}
                                onEditSlot={handleOpenEditKoSlot}
                                onSwapSides={handleSwapKoMatchSides}
                              />
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Change Knockout Stage Players / Team Modal ───────────────────────── */}
      {editingKoSlot && (() => {
        const targetMatch = mainDrawMatches.find((m) => m.id === editingKoSlot.matchId);
        const currentSlotTeam =
          editingKoSlot.slot === "teamA" ? targetMatch?.teamA : targetMatch?.teamB;
        const isCurrentlyManual =
          editingKoSlot.slot === "teamA"
            ? Boolean(targetMatch?.manualTeamA)
            : Boolean(targetMatch?.manualTeamB);
        const hasExistingScores = Boolean(
          targetMatch && (targetMatch.scoreA !== undefined || targetMatch.scoreB !== undefined),
        );

        const candidateTeamPreview: Team | null =
          editingKoSlot.player1.trim() || editingKoSlot.player2.trim() || editingKoSlot.teamName.trim()
            ? {
                id:
                  editingKoSlot.selectedTeamId && editingKoSlot.selectedTeamId !== "__custom__"
                    ? editingKoSlot.selectedTeamId
                    : "",
                name: editingKoSlot.teamName.trim() || "n/a",
                players: [editingKoSlot.player1.trim(), editingKoSlot.player2.trim()].filter(Boolean),
                club: editingKoSlot.club.trim(),
              }
            : null;

        let sameRoundCollisionLabel: string | null = null;
        if (candidateTeamPreview) {
          const otherInRound = mainDrawMatches.find(
            (m) =>
              m.round === editingKoSlot.round &&
              ((!(m.id === editingKoSlot.matchId && editingKoSlot.slot === "teamA") &&
                m.teamA &&
                isSamePlayoffTeam(m.teamA, candidateTeamPreview)) ||
                (!(m.id === editingKoSlot.matchId && editingKoSlot.slot === "teamB") &&
                  m.teamB &&
                  isSamePlayoffTeam(m.teamB, candidateTeamPreview))),
          );
          if (otherInRound) {
            const collidedSide =
              !(otherInRound.id === editingKoSlot.matchId && editingKoSlot.slot === "teamA") &&
              otherInRound.teamA &&
              isSamePlayoffTeam(otherInRound.teamA, candidateTeamPreview)
                ? "Slot 1 (Top)"
                : "Slot 2 (Bottom)";
            sameRoundCollisionLabel = `${otherInRound.label} • ${collidedSide}`;
          }
        }

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4 backdrop-blur-xs"
            onClick={() => setEditingKoSlot(null)}
          >
            <div
              className="w-full max-w-md max-h-[92vh] overflow-y-auto rounded-xl border-2 border-border bg-card shadow-2xl animate-in fade-in zoom-in-95 duration-150"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="bg-charcoal px-5 py-4 flex items-center justify-between border-b border-border sticky top-0 z-10">
                <div className="min-w-0 pr-2">
                  <span className="block text-[0.62rem] font-bold uppercase tracking-[0.25em] text-pickle truncate">
                    {editingKoSlot.matchLabel} • {editingKoSlot.slot === "teamA" ? "Slot 1 (Top)" : "Slot 2 (Bottom)"}
                  </span>
                  <h3 className="font-display text-2xl text-sand leading-tight mt-0.5">
                    Change Knockout Players
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingKoSlot(null)}
                  className="rounded border border-sand/30 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider text-sand/80 hover:border-sand hover:text-sand cursor-pointer shrink-0"
                >
                  Close
                </button>
              </div>

              <form onSubmit={handleSaveKoSlot} className="p-4 sm:p-5 space-y-4">
                {availableKnockoutTeams.length > 0 && (
                  <div className="space-y-1.5">
                    <label className="block text-[0.68rem] font-bold uppercase tracking-widest text-pickle">
                      Quick Select Pair from Division
                    </label>
                    <select
                      value={editingKoSlot.selectedTeamId}
                      onChange={(e) => handleSelectQuickKoTeam(e.target.value)}
                      className="w-full rounded border border-input bg-background px-3 py-2.5 text-xs sm:text-sm font-medium text-foreground focus:border-pickle focus:outline-none"
                    >
                      <option value="">-- Choose a pair or type manually below --</option>
                      {availableKnockoutTeams.map((opt) => {
                        const disp = getMatchTeamDisplay(opt.team.name, opt.team.players, opt.team.name);
                        return (
                          <option key={opt.team.id} value={opt.team.id}>
                            {disp.combined} — {opt.sourceLabel}
                          </option>
                        );
                      })}
                      <option value="__custom__">Custom / Manual Entry</option>
                    </select>
                  </div>
                )}

                {sameRoundCollisionLabel && (
                  <label className="flex items-start gap-2.5 rounded-lg border border-pickle/40 bg-pickle/10 p-3 text-xs text-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editingKoSlot.swapWithMatchSlot}
                      onChange={(e) =>
                        setEditingKoSlot({ ...editingKoSlot, swapWithMatchSlot: e.target.checked })
                      }
                      className="mt-0.5 h-4 w-4 accent-pickle shrink-0"
                    />
                    <span className="leading-snug">
                      This pair is already assigned in <strong>{sameRoundCollisionLabel}</strong>. Swap their positions automatically.
                    </span>
                  </label>
                )}

                <div className="space-y-1.5">
                  <label className="block text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground">
                    Player 1 Full Name
                  </label>
                  <input
                    type="text"
                    value={editingKoSlot.player1}
                    onChange={(e) => setEditingKoSlot({ ...editingKoSlot, player1: e.target.value })}
                    placeholder="Enter Player 1 name"
                    autoFocus
                    className="w-full rounded border border-input bg-background px-3 py-2.5 text-sm font-medium text-foreground focus:border-pickle focus:outline-none"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground">
                    Player 2 Full Name
                  </label>
                  <input
                    type="text"
                    value={editingKoSlot.player2}
                    onChange={(e) => setEditingKoSlot({ ...editingKoSlot, player2: e.target.value })}
                    placeholder="Enter Player 2 name (leave blank for singles)"
                    className="w-full rounded border border-input bg-background px-3 py-2.5 text-sm font-medium text-foreground focus:border-pickle focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="block text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground">
                      Team Name
                    </label>
                    <input
                      type="text"
                      value={editingKoSlot.teamName}
                      onChange={(e) => setEditingKoSlot({ ...editingKoSlot, teamName: e.target.value })}
                      placeholder="Team name (or n/a)"
                      className="w-full rounded border border-input bg-background px-3 py-2.5 text-sm font-medium text-foreground focus:border-pickle focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground">
                      Seed / Label (Optional)
                    </label>
                    <input
                      type="text"
                      value={editingKoSlot.seedLabel}
                      onChange={(e) => setEditingKoSlot({ ...editingKoSlot, seedLabel: e.target.value })}
                      placeholder="e.g. #1 (A1) or Wildcard"
                      className="w-full rounded border border-input bg-background px-3 py-2.5 text-sm font-medium text-foreground focus:border-pickle focus:outline-none"
                    />
                  </div>
                </div>

                {hasExistingScores && (
                  <label className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/30 p-2.5 text-xs text-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editingKoSlot.keepScore}
                      onChange={(e) =>
                        setEditingKoSlot({ ...editingKoSlot, keepScore: e.target.checked })
                      }
                      className="h-4 w-4 accent-pickle shrink-0"
                    />
                    <span>
                      Keep existing score ({targetMatch?.scoreA ?? 0} - {targetMatch?.scoreB ?? 0})
                    </span>
                  </label>
                )}

                <div className="pt-2 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 border-t border-border/60">
                  <div>
                    {(currentSlotTeam || isCurrentlyManual) && (
                      <button
                        type="button"
                        onClick={() => handleClearKoSlot(editingKoSlot.matchId, editingKoSlot.slot)}
                        className="w-full sm:w-auto border border-brick/50 bg-brick/10 px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-brick hover:bg-brick hover:text-sand transition-colors rounded cursor-pointer"
                      >
                        Reset to TBD
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingKoSlot(null)}
                      className="w-full sm:w-auto border border-border bg-charcoal px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors rounded cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="w-full sm:w-auto bg-pickle px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-sand hover:opacity-90 transition-opacity rounded shadow cursor-pointer"
                    >
                      Save Players
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// Sub-component for individual knockout match card
function KnockoutMatchCard({
  match,
  onScoreChange,
  onEditSlot,
  onSwapSides,
  isFinal = false,
}: {
  match: KnockoutMatch;
  onScoreChange: (matchId: string, field: "scoreA" | "scoreB", val: string) => void;
  onEditSlot: (match: KnockoutMatch, slot: "teamA" | "teamB") => void;
  onSwapSides: (matchId: string) => void;
  isFinal?: boolean | undefined;
}) {
  const hasFinalScore =
    match.scoreA !== undefined &&
    match.scoreB !== undefined &&
    match.scoreA !== match.scoreB &&
    Boolean(match.winner);

  const winnerA = Boolean(
    match.teamA &&
      match.winner &&
      (hasFinalScore
        ? (match.scoreA ?? 0) > (match.scoreB ?? 0)
        : isSamePlayoffTeam(match.winner, match.teamA)),
  );
  const winnerB = Boolean(
    match.teamB &&
      match.winner &&
      !winnerA &&
      (hasFinalScore
        ? (match.scoreB ?? 0) > (match.scoreA ?? 0)
        : isSamePlayoffTeam(match.winner, match.teamB)),
  );

  const dispA = match.teamA
    ? getMatchTeamDisplay(match.teamA.name, match.teamA.players, match.teamA.name)
    : null;
  const dispB = match.teamB
    ? getMatchTeamDisplay(match.teamB.name, match.teamB.players, match.teamB.name)
    : null;

  return (
    <div
      className={`surface-card p-0 overflow-hidden border ${
        isFinal ? "border-brick/60 shadow-md" : "border-border"
      }`}
    >
      <div className="bg-charcoal px-3 py-1.5 flex items-center justify-between gap-2 text-[0.65rem] uppercase tracking-widest text-sand">
        <span className="font-bold truncate">{match.label}</span>
        <div className="flex items-center gap-2 shrink-0">
          {(match.teamA || match.teamB) && (
            <button
              type="button"
              onClick={() => onSwapSides(match.id)}
              title="Swap Top and Bottom Slots"
              className="px-1.5 py-0.5 rounded border border-sand/30 text-[0.58rem] font-mono font-bold uppercase tracking-wider text-sand/85 hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
            >
              Swap
            </button>
          )}
          <span className="text-pickle font-mono">{match.court}</span>
        </div>
      </div>

      <div className="p-3 space-y-2">
        {/* Team A Row */}
        <div
          className={`flex items-center justify-between gap-2 p-2 rounded border-2 transition-colors ${
            winnerA ? "border-pickle/60 bg-pickle/20" : "border-border bg-card"
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              {match.seedA && (match.seedA.startsWith("#") || match.teamA) && (
                <span className="text-[0.58rem] font-bold font-mono px-1.5 py-0.2 bg-charcoal text-sand rounded max-w-[130px] truncate">
                  {match.seedA}
                </span>
              )}
              {match.manualTeamA && (
                <span className="text-[0.55rem] font-mono font-bold uppercase px-1 py-0.2 rounded bg-pickle/20 text-pickle border border-pickle/40">
                  Manual
                </span>
              )}
            </div>
            <span
              className={`block truncate mt-0.5 ${
                winnerA
                  ? "text-sm font-bold text-pickle"
                  : dispA
                    ? "text-sm font-semibold text-foreground"
                    : "text-muted-foreground italic text-xs"
              }`}
            >
              {dispA
                ? dispA.primary
                : match.seedA?.startsWith("#")
                  ? "TBD (Qualifier)"
                  : (match.seedA || "TBD (Qualifier)")}
            </span>
            {match.teamA && dispA && (
              <span className="block text-[0.65rem] text-muted-foreground truncate">
                {dispA.secondary ?? `Team: ${match.teamA.name}`}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => onEditSlot(match, "teamA")}
              className="px-2 py-1 text-[0.6rem] font-mono font-bold uppercase tracking-wider rounded border border-border bg-background text-foreground hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
            >
              {match.teamA ? "Edit" : "Assign"}
            </button>
            <input
              type="number"
              min={0}
              placeholder="0"
              disabled={!match.teamA || !match.teamB}
              value={match.scoreA ?? ""}
              onChange={(e) => onScoreChange(match.id, "scoreA", e.target.value)}
              className={`w-11 h-8 text-center font-display text-lg border focus:border-pickle focus:outline-none rounded ${
                winnerA
                  ? "border-pickle bg-pickle/30 text-pickle font-bold"
                  : "border-input bg-background"
              }`}
            />
          </div>
        </div>

        {/* Team B Row */}
        <div
          className={`flex items-center justify-between gap-2 p-2 rounded border-2 transition-colors ${
            winnerB ? "border-pickle/60 bg-pickle/20" : "border-border bg-card"
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              {match.seedB && (match.seedB.startsWith("#") || match.teamB) && (
                <span className="text-[0.58rem] font-bold font-mono px-1.5 py-0.2 bg-charcoal text-sand rounded max-w-[130px] truncate">
                  {match.seedB}
                </span>
              )}
              {match.manualTeamB && (
                <span className="text-[0.55rem] font-mono font-bold uppercase px-1 py-0.2 rounded bg-pickle/20 text-pickle border border-pickle/40">
                  Manual
                </span>
              )}
            </div>
            <span
              className={`block truncate mt-0.5 ${
                winnerB
                  ? "text-sm font-bold text-pickle"
                  : dispB
                    ? "text-sm font-semibold text-foreground"
                    : "text-muted-foreground italic text-xs"
              }`}
            >
              {dispB
                ? dispB.primary
                : match.seedB?.startsWith("#")
                  ? "TBD (Qualifier)"
                  : (match.seedB || "TBD (Qualifier)")}
            </span>
            {match.teamB && dispB && (
              <span className="block text-[0.65rem] text-muted-foreground truncate">
                {dispB.secondary ?? `Team: ${match.teamB.name}`}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => onEditSlot(match, "teamB")}
              className="px-2 py-1 text-[0.6rem] font-mono font-bold uppercase tracking-wider rounded border border-border bg-background text-foreground hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
            >
              {match.teamB ? "Edit" : "Assign"}
            </button>
            <input
              type="number"
              min={0}
              placeholder="0"
              disabled={!match.teamA || !match.teamB}
              value={match.scoreB ?? ""}
              onChange={(e) => onScoreChange(match.id, "scoreB", e.target.value)}
              className={`w-11 h-8 text-center font-display text-lg border focus:border-pickle focus:outline-none rounded ${
                winnerB
                  ? "border-pickle bg-pickle/30 text-pickle font-bold"
                  : "border-input bg-background"
              }`}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
