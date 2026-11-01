import { useState, useMemo, useEffect, useCallback } from "react";
import type { Team, Tournament, Category } from "@/data/tournaments";
import { getDrawnGroups } from "./BracketDraw";
import { getMatches, saveMatches, sanitizeCourtName, type LiveMatch, createPairMatchId, createCategoryScopedMatchId, findMatchForPair } from "@/lib/match-store";
import {
  dbSaveMainDraw,
  dbDeleteMainDraw,
  getCachedMainDraw,
  clearMainDrawCache,
  isSameCategory,
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
          if (suffix === target || target.includes(suffix) || suffix.includes(target)) {
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

function isSamePlayoffTeam(t1?: Team, t2?: Team): boolean {
  if (!t1 && !t2) return true;
  if (!t1 || !t2) return false;
  if (t1.id && t2.id && t1.id === t2.id) return true;
  return t1.name.trim().toLowerCase() === t2.name.trim().toLowerCase();
}

/**
 * Executes automatic tournament bracket advancement rules across rounds:
 * Round of 16 -> Quarterfinals -> Semifinals -> Finals & Bronze
 * Supports dynamic linkages (feedWinnerTo / feedLoserTo) with automatic cascading and legacy fallback.
 */
export function advancePlayoffBracket(matches: KnockoutMatch[]): { updated: KnockoutMatch[]; hasChanges: boolean } {
  let hasChanges = false;
  let updated = matches.map((m) => ({ ...m }));

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
              const slot = m.feedWinnerTo.slot;
              if (!isSamePlayoffTeam(updated[targetIdx]![slot], m.winner)) {
                updated[targetIdx] = {
                  ...updated[targetIdx]!,
                  [slot]: m.winner,
                };
                passChanged = true;
                hasChanges = true;
              }
            }
          }
          if (m.feedLoserTo && m.teamA && m.teamB) {
            const isAWinner =
              m.winner.id === m.teamA.id ||
              m.winner.name.trim().toLowerCase() === m.teamA.name.trim().toLowerCase();
            const loser = isAWinner ? m.teamB : m.teamA;
            const targetIdx = updated.findIndex((x) => x.id === m.feedLoserTo!.matchId);
            if (targetIdx !== -1 && loser) {
              const slot = m.feedLoserTo.slot;
              if (!isSamePlayoffTeam(updated[targetIdx]![slot], loser)) {
                updated[targetIdx] = {
                  ...updated[targetIdx]!,
                  [slot]: loser,
                };
                passChanged = true;
                hasChanges = true;
              }
            }
          }
        } else {
          // If a match score was reset and winner was removed, clear the downstream fed slot
          if (m.feedWinnerTo) {
            const targetIdx = updated.findIndex((x) => x.id === m.feedWinnerTo!.matchId);
            if (targetIdx !== -1) {
              const slot = m.feedWinnerTo.slot;
              if (updated[targetIdx]![slot] !== undefined) {
                updated[targetIdx] = {
                  ...updated[targetIdx]!,
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
              const slot = m.feedLoserTo.slot;
              if (updated[targetIdx]![slot] !== undefined) {
                updated[targetIdx] = {
                  ...updated[targetIdx]!,
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
    // 1. Auto-advance R16 winners to Quarterfinals
    const r16Matches = updated.filter((m) => m.round === "Round of 16");
    if (r16Matches.length > 0) {
      const getWinner = (id: string) => updated.find((m) => m.id === id)?.winner;

      updated = updated.map((m) => {
        let teamA = m.teamA;
        let teamB = m.teamB;
        if (m.id === "md-qf-1") {
          teamA = getWinner("md-r16-1") ?? m.teamA;
          teamB = getWinner("md-r16-2") ?? m.teamB;
        } else if (m.id === "md-qf-2") {
          teamA = getWinner("md-r16-3") ?? m.teamA;
          teamB = getWinner("md-r16-4") ?? m.teamB;
        } else if (m.id === "md-qf-3") {
          teamA = getWinner("md-r16-5") ?? m.teamA;
          teamB = getWinner("md-r16-6") ?? m.teamB;
        } else if (m.id === "md-qf-4") {
          teamA = getWinner("md-r16-7") ?? m.teamA;
          teamB = getWinner("md-r16-8") ?? m.teamB;
        }
        if (!isSamePlayoffTeam(teamA, m.teamA) || !isSamePlayoffTeam(teamB, m.teamB)) {
          hasChanges = true;
          return { ...m, teamA, teamB };
        }
        return m;
      });
    }

    // 2. Auto-advance QF winners to Semifinals
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
          teamA = qf1?.winner ?? m.teamA;
          teamB = qf2?.winner ?? m.teamB;
        } else if (m.id === "md-sf-2") {
          teamA = qf3?.winner ?? m.teamA;
          teamB = qf4?.winner ?? m.teamB;
        }
        if (!isSamePlayoffTeam(teamA, m.teamA) || !isSamePlayoffTeam(teamB, m.teamB)) {
          hasChanges = true;
          return { ...m, teamA, teamB };
        }
        return m;
      });
    }

    // 3. Auto-advance SF winners to Final & losers to Bronze
    const sf1 = updated.find((m) => m.id === "md-sf-1");
    const sf2 = updated.find((m) => m.id === "md-sf-2");

    updated = updated.map((m) => {
      if (m.id === "md-final") {
        const teamA = sf1?.winner ?? m.teamA;
        const teamB = sf2?.winner ?? m.teamB;
        if (!isSamePlayoffTeam(teamA, m.teamA) || !isSamePlayoffTeam(teamB, m.teamB)) {
          hasChanges = true;
          return { ...m, teamA, teamB };
        }
      }
      if (m.id === "md-bronze") {
        let teamA = m.teamA;
        let teamB = m.teamB;
        if (sf1?.winner && sf1.teamA && sf1.teamB) {
          const isAWinner =
            sf1.winner.id === sf1.teamA.id ||
            sf1.winner.name.trim().toLowerCase() === sf1.teamA.name.trim().toLowerCase();
          teamA = isAWinner ? sf1.teamB : sf1.teamA;
        }
        if (sf2?.winner && sf2.teamA && sf2.teamB) {
          const isAWinner =
            sf2.winner.id === sf2.teamA.id ||
            sf2.winner.name.trim().toLowerCase() === sf2.teamA.name.trim().toLowerCase();
          teamB = isAWinner ? sf2.teamB : sf2.teamA;
        }
        if (!isSamePlayoffTeam(teamA, m.teamA) || !isSamePlayoffTeam(teamB, m.teamB)) {
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

  const updatedMatches = currentDraw.map((km) => {
    if (!km.teamA || !km.teamB) return km;

    const nameA = km.teamA.name.trim().toLowerCase();
    const nameB = km.teamB.name.trim().toLowerCase();

    // Find corresponding match in liveMatches strictly scoped to categoryId and knockout round
    const stage = `${km.round} - ${km.label}`;
    const canonical = createPairMatchId(tournamentSlug, categoryId, stage, km.teamA.name, km.teamB.name);
    const legacy = `live-ko-${tournamentSlug}-${categoryId}-${km.id}`;

    const live =
      matches.find((m) => {
        if (tournamentSlug && m.tournamentSlug && m.tournamentSlug !== tournamentSlug) return false;
        if (m.categoryId && !isSameCategory(m.categoryId, categoryId)) return false;
        if (m.stage?.includes("Pool Play") || m.stage?.includes("Bracket ")) return false;
        if (m.id === canonical || m.id === legacy) return true;
        if (m.id === km.id && m.categoryId && isSameCategory(m.categoryId, categoryId)) return true;
        return false;
      }) ||
      findMatchForPair(
        matches.filter(
          (m) =>
            !m.stage?.includes("Pool Play") &&
            !m.stage?.includes("Bracket ") &&
            (!m.categoryId || isSameCategory(m.categoryId, categoryId)),
        ),
        km.teamA.name,
        km.teamB.name,
        tournamentSlug,
        categoryId,
        stage,
        km.teamA.players,
        km.teamB.players,
      );

    if (!live) return km;

    let nextKm = { ...km };

    // Sync score if available
    const scoreA = live.teamAName?.trim().toLowerCase() === nameA ? live.score?.teamAScore : live.score?.teamBScore;
    const scoreB = live.teamAName?.trim().toLowerCase() === nameA ? live.score?.teamBScore : live.score?.teamAScore;

    if (scoreA !== undefined && scoreA !== nextKm.scoreA) {
      nextKm.scoreA = scoreA;
      modified = true;
    }
    if (scoreB !== undefined && scoreB !== nextKm.scoreB) {
      nextKm.scoreB = scoreB;
      modified = true;
    }

    // Determine winner
    if (live.status === "final" || live.winnerTeam || (scoreA !== undefined && scoreB !== undefined && (scoreA >= 11 || scoreB >= 11) && Math.abs(scoreA - scoreB) >= 2)) {
      let winningTeam: Team | undefined;
      const winName = live.winnerTeam?.trim().toLowerCase();
      if (winName) {
        winningTeam = winName === nameA ? km.teamA : winName === nameB ? km.teamB : undefined;
      } else if (scoreA !== undefined && scoreB !== undefined && scoreA !== scoreB) {
        winningTeam = scoreA > scoreB ? km.teamA : km.teamB;
      }

      if (winningTeam && (!nextKm.winner || !isSamePlayoffTeam(nextKm.winner, winningTeam))) {
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
 * Syncs generated playoff knockout matches to the live match store
 * so umpires can officiate them in the Umpire Console and admins can dispatch them.
 */
export function syncKnockoutToLiveMatches(
  tournamentSlug: string,
  categoryId: string,
  knockoutMatches: KnockoutMatch[],
): void {
  const current = getMatches();
  const newMatches: LiveMatch[] = [];

  for (const km of knockoutMatches) {
    if (!km.teamA || !km.teamB) continue;
    const teamA = km.teamA;
    const teamB = km.teamB;
    const stage = `${km.round} - ${km.label}`;
    const legacyId = `live-ko-${tournamentSlug}-${categoryId}-${km.id}`;
    const canonicalId = createPairMatchId(tournamentSlug, categoryId, stage, teamA.name, teamB.name);
    const cleanCourt = sanitizeCourtName(km.court);

    // Look for existing match strictly within this category and knockout round (never Pool Play / Bracket)
    const existing =
      current.find((m) => {
        if (tournamentSlug && m.tournamentSlug && m.tournamentSlug !== tournamentSlug) return false;
        if (m.categoryId && !isSameCategory(m.categoryId, categoryId)) return false;
        if (m.stage?.includes("Pool Play") || m.stage?.includes("Bracket ")) return false;
        if (m.id === canonicalId || m.id === legacyId) return true;
        if (m.id === km.id && m.categoryId && isSameCategory(m.categoryId, categoryId)) return true;
        return false;
      }) ||
      findMatchForPair(
        current.filter(
          (m) =>
            !m.stage?.includes("Pool Play") &&
            !m.stage?.includes("Bracket ") &&
            (!m.categoryId || isSameCategory(m.categoryId, categoryId)),
        ),
        teamA.name,
        teamB.name,
        tournamentSlug,
        categoryId,
        stage,
        teamA.players,
        teamB.players,
      );

    const effectiveId = existing?.id || canonicalId;

    if (existing) {
      newMatches.push({
        ...existing,
        id: effectiveId,
        court: sanitizeCourtName(existing.court),
        tournamentSlug: tournamentSlug || existing.tournamentSlug,
        categoryId: categoryId || existing.categoryId,
        stage: existing.stage || stage,
        winnerTeam: km.winner?.name || existing.winnerTeam,
        status: km.winner ? "final" : existing.status,
      });
    } else {
      newMatches.push({
        id: effectiveId,
        court: cleanCourt,
        teamAName: km.teamA.name,
        teamAPlayers: km.teamA.players,
        teamBName: km.teamB.name,
        teamBPlayers: km.teamB.players,
        status: km.winner ? "final" : (km.scoreA !== undefined || km.scoreB !== undefined) ? "live" : "scheduled",
        score: {
          teamAScore: km.scoreA ?? 0,
          teamBScore: km.scoreB ?? 0,
          servingTeam: "A",
          serverNumber: 2,
          activeServerBase: 1,
          rallies: [],
        },
        winnerTeam: km.winner?.name,
        startedAt: undefined,
        endedAt: undefined,
        officiatedBy: undefined,
        tournamentSlug,
        categoryId,
        stage,
      });
    }
  }

  const updatedIds = new Set(newMatches.map((m) => m.id));
  const retained = current.filter((m) => !updatedIds.has(m.id));
  saveMatches([...newMatches, ...retained], true, newMatches);
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
  const [stageView, setStageView] = useState<"round_robin" | "main_draw">("round_robin");
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  // Initialize groups directly from Bracket Draw (MAIN) and sync with live scores
  const initializeGroupsFromDrawn = useCallback((): BracketGroup[] => {
    const drawn = getDrawnGroups(tournamentSlug, categoryId);
    if (!drawn || drawn.length === 0) return [];

    const liveMatches = getMatches();
    let courtCounter = 1;

    return drawn.map((dGrp) => {
      const teams = dGrp.slots
        .map((s) => s.team)
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

          const liveMatch =
            (scopedId
              ? liveMatches.find(
                  (m) => m.id === scopedId && (!m.categoryId || isSameCategory(m.categoryId, categoryId)),
                )
              : undefined) ||
            findMatchForPair(
              liveMatches,
              teamA.name,
              teamB.name,
              tournamentSlug,
              categoryId,
              dGrp.letter,
              teamA.players,
              teamB.players,
            );

          let scoreA: number | undefined = undefined;
          let scoreB: number | undefined = undefined;
          let status: BracketMatch["status"] = "scheduled";
          let court = courtCounter <= 4 ? `Court ${courtCounter}` : "Queue";

          if (liveMatch) {
            court = liveMatch.court;
            const aNameLower = teamA.name.trim().toLowerCase();
            const bNameLower = teamB.name.trim().toLowerCase();
            const liveALower = (liveMatch.teamAName || "").trim().toLowerCase();
            let isSameOrder = liveALower === aNameLower && aNameLower !== bNameLower;
            if (aNameLower === bNameLower && teamA.players?.length && liveMatch.teamAPlayers?.length) {
              const pA = [...teamA.players].map((p) => p.trim().toLowerCase()).sort().join(",");
              const lpA = [...liveMatch.teamAPlayers].map((p) => p.trim().toLowerCase()).sort().join(",");
              isSameOrder = pA === lpA;
            } else if (liveALower === bNameLower && aNameLower !== bNameLower) {
              isSameOrder = false;
            }

            if (liveMatch.status === "final") {
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
  }, [tournamentSlug, categoryId]);

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
    setBrackets(initializeGroupsFromDrawn());
    const existing = getMainDrawMatches(tournamentSlug, categoryId);
    if (existing && existing.length > 0) {
      setMainDrawMatches(existing);
      setMainDrawGenerated(true);
    } else {
      setMainDrawMatches([]);
      setMainDrawGenerated(false);
    }
  }, [initializeGroupsFromDrawn, tournamentSlug, categoryId]);

  // Real-time synchronization across draw resets, score entries, and cross-tab actions
  useEffect(() => {
    syncFromStorage();

    const handleSync = () => {
      syncFromStorage();
    };

    window.addEventListener("dv_drawn_groups_updated", handleSync);
    window.addEventListener("dv_live_matches_updated", handleSync);
    window.addEventListener("dv_main_draw_updated", handleSync);
    window.addEventListener("storage", handleSync);

    return () => {
      window.removeEventListener("dv_drawn_groups_updated", handleSync);
      window.removeEventListener("dv_live_matches_updated", handleSync);
      window.removeEventListener("dv_main_draw_updated", handleSync);
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
    saveMainDrawMatches(tournamentSlug, categoryId, []);
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

      {/* ── Empty State if no brackets drawn yet ── */}
      {brackets.length === 0 ? (
        <div className="surface-card p-12 text-center space-y-4 border-2 border-pickle/40 my-8">
          <span className="block text-xs uppercase tracking-[0.28em] font-bold text-pickle">
            Brackets Pending
          </span>
          <h3 className="font-display text-3xl sm:text-4xl text-foreground">
            No Brackets Generated Yet
          </h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            The official brackets for <strong>{category.label}</strong> have not been drawn yet. Launch the <strong>Bracket Draw (MAIN)</strong> ceremony to perform the randomized team draw.
          </p>
          {onSwitchToBracketDraw && (
            <button
              onClick={onSwitchToBracketDraw}
              className="px-6 py-3.5 bg-brick text-sand font-display text-xl tracking-widest hover:bg-brick-deep transition-all cursor-pointer shadow-lg inline-flex items-center gap-2"
            >
              <span>Launch Bracket Draw (MAIN) &rarr;</span>
            </button>
          )}
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
                  <h3 className="font-display text-2xl text-foreground">
                    Round Robin Stage ({brackets.length} Pools, {category.teams.length} Teams)
                  </h3>
                  <p className="text-xs text-foreground/80 font-medium mt-0.5">
                    Top 2 teams from each bracket qualify for the Main Draw playoffs. Standings and playoff seeds are ranked automatically by <strong>Point Differential (+/-)</strong>.
                  </p>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <span className="block font-display text-2xl text-foreground">
                      {completedMatchesCount} / {totalMatchesCount}
                    </span>
                    <span className="text-[0.65rem] uppercase tracking-widest text-foreground font-bold">
                      Matches Completed
                    </span>
                  </div>
                  <button
                    onClick={handleGenerateMainDraw}
                    disabled={completedMatchesCount === 0}
                    className={`px-5 py-2.5 text-xs font-bold uppercase tracking-widest transition-all rounded ${
                      isRoundRobinFinished
                        ? "bg-pickle text-white animate-pulse hover:opacity-90 cursor-pointer shadow-lg font-bold"
                        : completedMatchesCount > 0
                          ? "bg-brick text-white hover:bg-brick-deep cursor-pointer font-bold"
                          : "border-2 border-border bg-card text-foreground/40 cursor-not-allowed font-bold"
                    }`}
                  >
                    Seed Main Draw &rarr;
                  </button>
                </div>
              </div>

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
                                    <div className="font-semibold text-foreground truncate max-w-[140px] sm:max-w-[180px]">
                                      {row.team.name}
                                    </div>
                                    <div className="flex items-center gap-1.5 text-[0.65rem] text-muted-foreground truncate mt-0.5">
                                      <span className="truncate">{row.team.players.join(" & ")}</span>
                                      {row.team.club && (
                                        <>
                                          <span className="text-muted-foreground/40 shrink-0">•</span>
                                          <span className="text-[0.6rem] px-1.5 py-0.2 rounded bg-charcoal/40 text-sand/80 border border-border/60 shrink-0 font-medium">
                                            {row.team.club}
                                          </span>
                                        </>
                                      )}
                                    </div>
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
                                    <div className="font-semibold text-xs text-foreground truncate">
                                      {row.team.name}
                                    </div>
                                    <div className="flex items-center gap-1 text-[0.62rem] text-muted-foreground truncate mt-0.5">
                                      <span className="truncate">{row.team.players.join(" & ")}</span>
                                      {row.team.club && (
                                        <>
                                          <span className="text-muted-foreground/40 shrink-0">•</span>
                                          <span className="text-[0.6rem] px-1 py-0.2 rounded bg-charcoal/40 text-sand/80 border border-border/60 shrink-0 font-medium">
                                            {row.team.club}
                                          </span>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                <span className={`text-[0.62rem] font-bold uppercase tracking-wider px-2 py-0.5 rounded shrink-0 ${
                                  row.isQualified
                                    ? "bg-pickle text-sand font-black"
                                    : "text-muted-foreground border border-border/60"
                                }`}>
                                  {row.isQualified ? "Advances" : `Rank ${row.rank}`}
                                </span>
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
                                        {teamA?.name ?? "Team A"}
                                      </span>
                                      <span className="block text-[0.65rem] text-muted-foreground truncate">
                                        {teamA?.players.join(" / ")}
                                      </span>
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
                                        {teamB?.name ?? "Team B"}
                                      </span>
                                      <span className="block text-[0.65rem] text-muted-foreground truncate">
                                        {teamB?.players.join(" / ")}
                                      </span>
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
                              <span className="font-semibold text-foreground block truncate">
                                {q.team.name}
                              </span>
                              <span className="text-[0.65rem] text-muted-foreground truncate block">
                                {q.team.players.join(" & ")}
                              </span>
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
                                  vs #{opp.overallSeed} {opp.team.name} ({opp.pointDiff > 0 ? "+" : ""}{opp.pointDiff})
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
                              <span className="font-semibold text-foreground text-xs block truncate">
                                {q.team.name}
                              </span>
                              <span className="text-[0.65rem] text-foreground/80 font-bold truncate block">
                                {q.team.players.join(" & ")}
                              </span>
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
                              vs #{opp.overallSeed} {opp.team.name} ({opp.pointDiff > 0 ? "+" : ""}{opp.pointDiff})
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

              {/* ── Main Draw Knockout Tree ── */}
              {!mainDrawGenerated || mainDrawMatches.length === 0 ? (
                <div className="surface-card p-12 text-center space-y-4 border border-border">
                  <span className="text-xs uppercase tracking-[0.28em] font-bold text-pickle block">
                    Playoff Bracket
                  </span>
                  <h4 className="font-display text-3xl text-foreground">Main Draw Ready to Seed</h4>
                  <p className="text-sm text-muted-foreground max-w-md mx-auto">
                    Click the button below to seed all {qualifiers.length} qualified teams into the knockout bracket using Point Differential tie-breakers.
                  </p>
                  <button
                    onClick={handleGenerateMainDraw}
                    className="bg-brick px-6 py-3 font-display text-2xl tracking-widest text-sand hover:bg-brick-deep transition-colors cursor-pointer shadow-lg"
                  >
                    Seed Main Draw (Point Differential) &rarr;
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <span className="text-xs font-bold uppercase tracking-[0.28em] text-pickle">
                        Single Elimination Stage
                      </span>
                      <h3 className="font-display text-3xl text-foreground">Championship Playoff Tree</h3>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={handleGenerateMainDraw}
                        className="border border-border bg-charcoal px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
                      >
                        Re-Seed by Point Diff
                      </button>
                      <button
                        onClick={handleSyncToLiveCourts}
                        className="bg-pickle px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-sand hover:opacity-90 transition-opacity cursor-pointer"
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
                            />
                          ))}
                      </div>
                    )}

                    {/* Semifinals */}
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
                          />
                        ))}
                    </div>

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
                              isFinal
                            />
                          ))}

                        {/* Champion Banner */}
                        {(() => {
                          const finalMatch = mainDrawMatches.find((m) => m.round === "Final");
                          if (finalMatch?.winner) {
                            return (
                              <div className="surface-card p-6 bg-pickle/20 border-2 border-pickle text-center space-y-2 animate-in fade-in zoom-in duration-300">
                                <span className="block text-xs uppercase tracking-[0.28em] font-bold text-pickle">
                                  Tournament Champion
                                </span>
                                <h4 className="font-display text-3xl text-foreground">
                                  {finalMatch.winner.name}
                                </h4>
                                <p className="text-xs text-muted-foreground">
                                  {finalMatch.winner.players.join(" & ")}
                                </p>
                              </div>
                            );
                          }
                          return null;
                        })()}
                      </div>

                      {/* 3rd Place Match */}
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
                            />
                          ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Sub-component for individual knockout match card
function KnockoutMatchCard({
  match,
  onScoreChange,
  isFinal = false,
}: {
  match: KnockoutMatch;
  onScoreChange: (matchId: string, field: "scoreA" | "scoreB", val: string) => void;
  isFinal?: boolean;
}) {
  const winnerA = match.winner && match.teamA && match.winner.id === match.teamA.id;
  const winnerB = match.winner && match.teamB && match.winner.id === match.teamB.id;

  return (
    <div
      className={`surface-card p-0 overflow-hidden border ${
        isFinal ? "border-brick/60 shadow-md" : "border-border"
      }`}
    >
      <div className="bg-charcoal px-3 py-1.5 flex items-center justify-between text-[0.65rem] uppercase tracking-widest text-sand">
        <span className="font-bold">{match.label}</span>
        <span className="text-pickle font-mono">{match.court}</span>
      </div>

      <div className="p-3 space-y-2">
        {/* Team A Row */}
        <div
          className={`flex items-center justify-between p-2 rounded border-2 transition-colors ${
            winnerA ? "border-pickle/60 bg-pickle/20" : "border-border bg-card"
          }`}
        >
          <div className="truncate mr-2">
            <div className="flex items-center gap-1.5">
              {match.seedA && match.seedA.startsWith("#") && (
                <span className="text-[0.6rem] font-bold font-mono px-1 py-0.2 bg-charcoal text-sand rounded">
                  {match.seedA}
                </span>
              )}
              <span
                className={`text-sm truncate ${
                  winnerA
                    ? "font-bold text-pickle"
                    : match.teamA
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground italic text-xs"
                }`}
              >
                {match.teamA?.name ?? (match.seedA?.startsWith("#") ? "TBD (Qualifier)" : (match.seedA || "TBD (Qualifier)"))}
              </span>
            </div>
            {match.teamA && (
              <span className="block text-[0.65rem] text-muted-foreground truncate">
                {match.teamA.players.join(" & ")}
              </span>
            )}
          </div>

          <input
            type="number"
            min={0}
            placeholder="0"
            disabled={!match.teamA || !match.teamB}
            value={match.scoreA ?? ""}
            onChange={(e) => onScoreChange(match.id, "scoreA", e.target.value)}
            className={`w-11 h-8 text-center font-display text-lg border focus:border-pickle focus:outline-none ${
              winnerA
                ? "border-pickle bg-pickle/30 text-pickle font-bold"
                : "border-input bg-background"
            }`}
          />
        </div>

        {/* Team B Row */}
        <div
          className={`flex items-center justify-between p-2 rounded border-2 transition-colors ${
            winnerB ? "border-pickle/60 bg-pickle/20" : "border-border bg-card"
          }`}
        >
          <div className="truncate mr-2">
            <div className="flex items-center gap-1.5">
              {match.seedB && match.seedB.startsWith("#") && (
                <span className="text-[0.6rem] font-bold font-mono px-1 py-0.2 bg-charcoal text-sand rounded">
                  {match.seedB}
                </span>
              )}
              <span
                className={`text-sm truncate ${
                  winnerB
                    ? "font-bold text-pickle"
                    : match.teamB
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground italic text-xs"
                }`}
              >
                {match.teamB?.name ?? (match.seedB?.startsWith("#") ? "TBD (Qualifier)" : (match.seedB || "TBD (Qualifier)"))}
              </span>
            </div>
            {match.teamB && (
              <span className="block text-[0.65rem] text-muted-foreground truncate">
                {match.teamB.players.join(" & ")}
              </span>
            )}
          </div>

          <input
            type="number"
            min={0}
            placeholder="0"
            disabled={!match.teamA || !match.teamB}
            value={match.scoreB ?? ""}
            onChange={(e) => onScoreChange(match.id, "scoreB", e.target.value)}
            className={`w-11 h-8 text-center font-display text-lg border focus:border-pickle focus:outline-none ${
              winnerB
                ? "border-pickle bg-pickle/30 text-pickle font-bold"
                : "border-input bg-background"
            }`}
          />
        </div>
      </div>
    </div>
  );
}
