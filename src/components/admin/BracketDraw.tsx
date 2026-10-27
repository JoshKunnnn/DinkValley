import { useState, useEffect, useRef, useMemo } from "react";
import type { Team, Tournament, Category } from "@/data/tournaments";
import {
  syncDrawnBracketsToLiveMatches,
  purgeMatchesForCategory,
  createPairMatchId,
  createCategoryScopedMatchId,
  getMatches,
} from "@/lib/match-store";
import { bulkSetTeamsInCategory, deleteAllTeamsInCategory, getTournaments } from "@/lib/tournament-store";
import { generateMockTeams, generate32Teams } from "@/lib/team-generator";
import {
  addMatchesToQueue,
  purgeQueueForCategory,
  getDispatchQueue,
  saveDispatchQueue,
} from "@/lib/court-dispatch";
import { isMatchInSameBracket } from "@/lib/bracket-utils";
import {
  dbSaveDrawnGroups,
  dbDeleteDrawnGroups,
  dbDeleteMainDraw,
  getCachedDrawnGroups,
  clearDrawnGroupsCache,
  clearMainDrawCache,
  markDrawAsReset,
} from "@/lib/supabase-service";

export type BracketSlot = {
  team: Team | null;
  revealed: boolean;
};

export type BracketGroup = {
  name: string;
  letter: string;
  slots: BracketSlot[];
  revealed: boolean;
  isDrawn: boolean;
};

export function saveDrawnGroups(
  tournamentSlug: string,
  categoryId: string,
  groups: BracketGroup[],
  allTeams?: Team[],
  isSilent = false
) {
  try {
    // Save directly to Supabase
    dbSaveDrawnGroups(tournamentSlug, categoryId, groups).catch((err) => {
      console.warn("[Supabase] Failed to save drawn groups:", err);
    });

    try {
      localStorage.setItem(`dv_drawn_groups_${tournamentSlug}_${categoryId}`, JSON.stringify(groups));
    } catch {
      // ignore
    }

    // In silent mode (intermediate auto-draw step), skip store thrashing and event broadcasts
    if (isSilent) {
      return;
    }

    // Sync the full roster into tournament category teams store and Supabase only if needed.
    // Use allTeams when provided (full roster) so a mid-draw save never
    // overwrites the category with only the partial set of revealed teams.
    const drawnTeams = groups
      .flatMap((g) => g.slots.map((s) => s.team))
      .filter((t): t is Team => t !== null);
    const teamsToSync = (allTeams && allTeams.length > 0) ? allTeams : drawnTeams;

    if (teamsToSync.length > 0) {
      try {
        const currentTournaments = getTournaments();
        const currentTourn = currentTournaments.find((t) => t.slug === tournamentSlug);
        const currentCat = currentTourn?.categories.find(
          (c) => c.id === categoryId || (c as any).category_slug === categoryId
        );
        const existingTeams = currentCat?.teams || [];
        const existingIds = new Set(existingTeams.map((t) => t.id));
        const hasChange =
          existingTeams.length !== teamsToSync.length ||
          teamsToSync.some((t) => !existingIds.has(t.id));

        if (hasChange) {
          bulkSetTeamsInCategory(tournamentSlug, currentCat?.id || categoryId, teamsToSync);
        }
      } catch {
        // ignore
      }
    }

    syncDrawnBracketsToLiveMatches(tournamentSlug, categoryId, groups);

    // Auto-enqueue initial ready matches into dispatch queue (1 match per team to prevent simultaneous play conflicts)
    const drawnMatches: {
      matchId: string;
      tournamentSlug: string;
      categoryId: string;
      stage: string;
      teamAName: string;
      teamAPlayers: string[];
      teamBName: string;
      teamBPlayers: string[];
    }[] = [];

    const scheduledTeams = new Set<string>();
    const existingQueue = getDispatchQueue();
    existingQueue.forEach((q) => {
      if (q.status === "queued" || q.status === "on_deck" || q.status === "live" || q.status === "dispatched") {
        scheduledTeams.add(q.teamAName.trim().toLowerCase());
        scheduledTeams.add(q.teamBName.trim().toLowerCase());
      }
    });

    for (const group of groups) {
      if (!group.isDrawn && !group.slots.some((s) => s.team !== null)) continue;
      const teams = group.slots
        .map((s) => s.team)
        .filter((t): t is Team => t !== null);

      const nameCounts = new Map<string, number>();
      for (const t of teams) {
        const k = t.name.trim().toLowerCase();
        nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
      }

      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const teamA = teams[i]!;
          const teamB = teams[j]!;
          const isDupA = (nameCounts.get(teamA.name.trim().toLowerCase()) || 0) > 1;
          const isDupB = (nameCounts.get(teamB.name.trim().toLowerCase()) || 0) > 1;

          const matchId = (teamA.id && teamB.id)
            ? createCategoryScopedMatchId(categoryId, group.letter, teamA.id, teamB.id)
            : createPairMatchId(
                tournamentSlug,
                categoryId,
                `Bracket ${group.letter}`,
                teamA.name,
                teamB.name,
                teamA.players,
                teamB.players,
                isDupA,
                isDupB,
              );
          const aKey = teamA.id || `${teamA.name}-${(teamA.players || []).join(",")}`.toLowerCase();
          const bKey = teamB.id || `${teamB.name}-${(teamB.players || []).join(",")}`.toLowerCase();

          // Only queue initial matchups if neither team is already scheduled in this batch
          // Subsequent matchups remain in Unassigned Matches and are added after each game finishes
          if (!scheduledTeams.has(aKey) && !scheduledTeams.has(bKey)) {
            scheduledTeams.add(aKey);
            scheduledTeams.add(bKey);
            drawnMatches.push({
              matchId,
              tournamentSlug,
              categoryId,
              stage: `Bracket ${group.letter} (Pool Play)`,
              teamAName: teamA.name,
              teamAPlayers: teamA.players || [],
              teamBName: teamB.name,
              teamBPlayers: teamB.players || [],
            });
          }
        }
      }
    }

    if (drawnMatches.length > 0) {
      addMatchesToQueue(drawnMatches);
    }

    window.dispatchEvent(new Event("dv_drawn_groups_updated"));
    window.dispatchEvent(new Event("dv_dispatch_queue_updated"));
    window.dispatchEvent(new Event("dv_live_matches_updated"));
    window.dispatchEvent(new Event("storage"));
  } catch {
    // ignore
  }
}

export function getDrawnGroups(tournamentSlug: string, categoryId: string): BracketGroup[] | null {
  // First check in-memory cache populated from Supabase
  const cached = getCachedDrawnGroups(tournamentSlug, categoryId);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached as BracketGroup[];
  }

  // Fallback to local storage if present (e.g. migrating existing draw on mobile) and sync to Supabase
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(`dv_drawn_groups_${tournamentSlug}_${categoryId}`) : null;
    if (raw) {
      const parsed = JSON.parse(raw) as BracketGroup[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export function resetDrawnGroups(
  tournamentSlug: string,
  categoryId: string,
  extraCategoryIds: string[] = []
): void {
  const targetIds = Array.from(new Set([categoryId, ...extraCategoryIds].filter(Boolean)));

  // 1. Immediately wipe in-memory caches and register tombstones so background cloud reads cannot resurrect stale draws
  for (const cid of targetIds) {
    markDrawAsReset(tournamentSlug, cid);
    clearDrawnGroupsCache(tournamentSlug, cid);
    clearMainDrawCache(tournamentSlug, cid);
  }

  // 2. Remove all localStorage variations
  if (typeof localStorage !== "undefined") {
    try {
      for (const cid of targetIds) {
        localStorage.removeItem(`dv_drawn_groups_${tournamentSlug}_${cid}`);
        localStorage.removeItem(`dv_main_draw_${tournamentSlug}_${cid}`);
      }
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (
          k &&
          (k.startsWith(`dv_drawn_groups_${tournamentSlug}_`) ||
            k.startsWith(`dv_main_draw_${tournamentSlug}_`))
        ) {
          const matchTarget = targetIds.some((cid) => k.endsWith(`_${cid}`));
          if (matchTarget) {
            keysToRemove.push(k);
          }
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {
      // ignore
    }
  }

  // 3. Delete from Supabase cloud database (single targeted call cleans both slug and uuid)
  const primaryId = targetIds[0] || categoryId;
  dbDeleteDrawnGroups(tournamentSlug, primaryId).catch((err) => {
    console.warn("[Supabase] Failed to delete drawn groups from cloud:", err);
  });
  dbDeleteMainDraw(tournamentSlug, primaryId).catch(() => {});

  // 4. Purge all matches (including final ones) for this category from live match store & database
  for (const cid of targetIds) {
    purgeMatchesForCategory(tournamentSlug, cid, true);
    purgeQueueForCategory(tournamentSlug, cid);
  }

  // 5. Broadcast real-time update events across all tabs, components, and spectator views
  window.dispatchEvent(new Event("dv_drawn_groups_updated"));
  window.dispatchEvent(new Event("dv_main_draw_updated"));
  window.dispatchEvent(new Event("dv_dispatch_queue_updated"));
  window.dispatchEvent(new Event("dv_live_matches_updated"));
  window.dispatchEvent(new Event("storage"));
}

interface BracketDrawProps {
  tournament: Tournament;
  category: Category;
  tournaments: Tournament[];
  tournamentSlug: string;
  setTournamentSlug: (slug: string) => void;
  categoryId: string;
  setCategoryId: (id: string) => void;
}

// ── Delay helper ──────────────────────────────────────────────────────────
function delay(ms: number) {
  return new Promise<void>((res) => setTimeout(res, ms));
}

// ── Shuffle utility ────────────────────────────────────────────────────────
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ── Balanced bracket distribution ──────────────────────────────────────────
function balancedDistribute(teams: Team[], numGroups: number): Team[][] {
  const buckets: Team[][] = Array.from({ length: numGroups }, () => []);
  const shuffled = shuffle(teams);
  shuffled.forEach((t, i) => buckets[i % numGroups]!.push(t));
  return buckets.map((b) => shuffle(b));
}

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

function getBracketsForCapacity(cap: number): number {
  if (cap >= 48) return 12;
  if (cap >= 32) return 8;
  if (cap >= 24) return 6;
  if (cap >= 16) return 4;
  if (cap >= 12) return 3;
  return 2;
}

// ── Main Component ─────────────────────────────────────────────────────────
export function BracketDraw({
  tournament,
  category,
  tournaments,
  tournamentSlug,
  setTournamentSlug,
  categoryId,
  setCategoryId,
}: BracketDrawProps) {
  const rawTeams = category?.teams || [];
  const [groups, setGroups] = useState<BracketGroup[]>([]);

  const teams = rawTeams;
  const maxCapacity = category?.maxEntries || (teams.length >= 24 ? 32 : teams.length >= 12 ? 16 : 8);
  const targetBrackets = getBracketsForCapacity(maxCapacity);
  const [numBrackets, setNumBrackets] = useState(targetBrackets);
  const [teamsByGroup, setTeamsByGroup] = useState<Team[][]>([]);
  const [drawnCount, setDrawnCount] = useState(0);
  const [drawingBracketIdx, setDrawingBracketIdx] = useState(-1);
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);

  // Drag and click swap state for manual rebalancing
  const [selectedSlot, setSelectedSlot] = useState<{
    groupIndex: number;
    slotIndex: number;
  } | null>(null);
  const [draggedSlot, setDraggedSlot] = useState<{
    groupIndex: number;
    slotIndex: number;
  } | null>(null);
  const [swapNotice, setSwapNotice] = useState<{
    message: string;
    previousGroups: BracketGroup[];
  } | null>(null);

  // Synchronous refs to prevent race conditions and mid-animation aborts
  const animCancelRef = useRef(false);
  const isDrawingRef = useRef(false);
  const isAutoPlayingRef = useRef(false);
  const groupsRef = useRef<BracketGroup[]>([]);
  const teamsByGroupRef = useRef<Team[][]>([]);
  const drawnCountRef = useRef(0);
  const skipEffectRef = useRef(false);
  const lastAutoDrawStartTimeRef = useRef(0);

  // Normalize effective category ID to handle mismatch between categoryId prop and category.id / category_slug
  const matchedCategory = tournament?.categories?.find(
    (c) => c.id === categoryId || (c as any).category_slug === categoryId || c.id === category?.id
  ) || category;
  const effectiveCategoryId = (matchedCategory as any)?.category_slug || matchedCategory?.id || categoryId;
  const currentCategoryKey = `${tournamentSlug}_${effectiveCategoryId}`;
  const loadedCategoryKeyRef = useRef(currentCategoryKey);

  // Keep refs synchronized with state
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  useEffect(() => {
    teamsByGroupRef.current = teamsByGroup;
  }, [teamsByGroup]);

  useEffect(() => {
    drawnCountRef.current = drawnCount;
  }, [drawnCount]);

  // Cleanly abort on unmount only
  useEffect(() => {
    return () => {
      animCancelRef.current = true;
      isDrawingRef.current = false;
      isAutoPlayingRef.current = false;
    };
  }, []);

  // Restore previously drawn groups or prepare initial empty standby groups
  useEffect(() => {
    // If an animation or auto-draw is actively running, NEVER abort or wipe state!
    if (isDrawingRef.current || isAutoPlayingRef.current) {
      return;
    }

    const safeTeams = category?.teams || [];

    // Only cancel and reset if the user genuinely switched to a different tournament or category
    const isNewCategory = loadedCategoryKeyRef.current !== currentCategoryKey;
    if (isNewCategory) {
      loadedCategoryKeyRef.current = currentCategoryKey;
      animCancelRef.current = true;
      setDrawingBracketIdx(-1);
      setIsAutoPlaying(false);
      const existingDrawn = getDrawnGroups(tournamentSlug, effectiveCategoryId);
      if (!existingDrawn || existingDrawn.length === 0) {
        const catCap = category?.maxEntries || (safeTeams.length >= 24 ? 32 : safeTeams.length >= 12 ? 16 : 8);
        setNumBrackets(getBracketsForCapacity(catCap));
      }
    }

    // Skip if a direct populate already set the correct state
    if (skipEffectRef.current) {
      skipEffectRef.current = false;
      return;
    }

    if (safeTeams.length === 0) {
      setGroups([]);
      groupsRef.current = [];
      setTeamsByGroup([]);
      teamsByGroupRef.current = [];
      setDrawnCount(0);
      drawnCountRef.current = 0;
      return;
    }

    const n = Math.max(1, Math.min(numBrackets, Math.ceil(safeTeams.length / 2) || 1));

    // Check if brackets were already drawn for this tournament & category
    const existingDrawn = getDrawnGroups(tournamentSlug, effectiveCategoryId);
    if (existingDrawn && existingDrawn.length > 0) {
      const drawnNum = existingDrawn.filter((g) => g.isDrawn).length;
      if (drawnNum > 0) {
        // Use IDs (not names) so teams with duplicate names are tracked individually
        const _cachedIds = new Set<string>(
          existingDrawn.flatMap((g) =>
            g.slots.map((s) => s.team?.id).filter((id): id is string => !!id)
          )
        );
        const _currentIds = new Set(safeTeams.map((t) => t.id));
        const _rosterMatch =
          _cachedIds.size <= _currentIds.size && [..._cachedIds].every((id) => _currentIds.has(id));

        if (_rosterMatch) {
          setGroups(existingDrawn);
          groupsRef.current = existingDrawn;
          setDrawnCount(drawnNum);
          drawnCountRef.current = drawnNum;

          // Rebuild teamsByGroup: drawn brackets keep their revealed teams;
          // undrawn brackets use balancedDistribute for remaining teams.
          const _undrawnPool = safeTeams.filter((t) => !_cachedIds.has(t.id));
          const _undrawnCount = existingDrawn.filter((g) => !g.isDrawn).length;
          const _undrawnBuckets =
            _undrawnCount > 0 ? balancedDistribute(_undrawnPool, _undrawnCount) : [];
          let _ubIdx = 0;
          const buckets: Team[][] = existingDrawn.map((g) => {
            if (g.isDrawn) {
              return g.slots.map((s) => s.team).filter((t): t is Team => t !== null);
            }
            return _undrawnBuckets[_ubIdx++] ?? [];
          });

          setTeamsByGroup(buckets);
          teamsByGroupRef.current = buckets;
          if (existingDrawn.length !== numBrackets) {
            setNumBrackets(existingDrawn.length);
          }
          // Ensure live matches are synced into match store
          syncDrawnBracketsToLiveMatches(tournamentSlug, effectiveCategoryId, existingDrawn);
          return;
        }
      }
    }

    setDrawnCount(0);
    drawnCountRef.current = 0;

    // Distribute teams into buckets with balanced seeding
    const buckets = balancedDistribute(safeTeams, n);
    setTeamsByGroup(buckets);
    teamsByGroupRef.current = buckets;

    // Setup initial standby groups
    const initial: BracketGroup[] = buckets.map((bucketTeams, i) => ({
      name: `Bracket ${LETTERS[i] ?? i + 1}`,
      letter: LETTERS[i] ?? String(i + 1),
      slots: bucketTeams.map(() => ({ team: null, revealed: false })),
      revealed: false,
      isDrawn: false,
    }));

    setGroups(initial);
    groupsRef.current = initial;
  }, [category, numBrackets, tournamentSlug, effectiveCategoryId]);

  // Total teams and stats
  const totalTeams = teams.length;
  const hasTeams = totalTeams > 0;
  const isAllDone = groups.length > 0 && drawnCount >= groups.length;
  const isAnimating = drawingBracketIdx !== -1 || isAutoPlaying;
  const nextBracketIdx = drawnCount < groups.length ? drawnCount : -1;
  const nextBracketLetter = nextBracketIdx >= 0 ? (LETTERS[nextBracketIdx] ?? String(nextBracketIdx + 1)) : "";

  // ── Draw ONE single bracket at a time ────────────────────────────────────
  const drawSingleBracket = async (bracketIndex: number, isSilent = false) => {
    if (isDrawingRef.current || bracketIndex < 0 || bracketIndex >= groupsRef.current.length) return;
    if (groupsRef.current[bracketIndex]?.isDrawn) return;

    isDrawingRef.current = true;
    animCancelRef.current = false;
    setDrawingBracketIdx(bracketIndex);

    try {
      let targetTeams = teamsByGroupRef.current[bracketIndex] ?? [];
      if (!targetTeams || targetTeams.length === 0) {
        const safeTeams = category?.teams || [];
        const drawnTeamIds = new Set(
          groupsRef.current.flatMap((g) => (g.isDrawn ? g.slots.map((s) => s.team?.id).filter((id): id is string => !!id) : []))
        );
        const remaining = safeTeams.filter((t) => !drawnTeamIds.has(t.id));
        const expectedPerBracket = Math.max(1, Math.floor(safeTeams.length / (groupsRef.current.length || numBrackets)) || 4);
        targetTeams = remaining.slice(0, expectedPerBracket);
        if (targetTeams.length > 0) {
          teamsByGroupRef.current[bracketIndex] = targetTeams;
        }
      }

      // 1. Reveal Header with active highlight
      const headerRevealed = groupsRef.current.map((g, idx) =>
        idx === bracketIndex ? { ...g, revealed: true } : g
      );
      groupsRef.current = headerRevealed;
      setGroups(headerRevealed);

      await delay(350);
      if (animCancelRef.current) return;

      // 2. Drop in each team in this bracket one by one
      for (let ti = 0; ti < targetTeams.length; ti++) {
        if (animCancelRef.current) break;

        const team = targetTeams[ti]!;
        const teamDropped = groupsRef.current.map((g, gidx) => {
          if (gidx !== bracketIndex) return g;
          return {
            ...g,
            slots: g.slots.map((s, sidx) => (sidx === ti ? { team, revealed: true } : s)),
          };
        });
        groupsRef.current = teamDropped;
        setGroups(teamDropped);

        // Stagger delay between team drops
        await delay(targetTeams.length > 6 ? 140 : 220);
      }

      if (!animCancelRef.current) {
        // 3. Mark this bracket as completed and save
        const safeTeams = category?.teams || [];
        const fullRoster = safeTeams.length > 0 ? safeTeams : teamsByGroupRef.current.flat();
        const completedGroups = groupsRef.current.map((g, idx) =>
          idx === bracketIndex ? { ...g, isDrawn: true, revealed: true } : g
        );
        groupsRef.current = completedGroups;
        setGroups(completedGroups);

        const nextCount = Math.max(drawnCountRef.current, bracketIndex + 1);
        drawnCountRef.current = nextCount;
        setDrawnCount(nextCount);

        saveDrawnGroups(tournamentSlug, effectiveCategoryId, completedGroups, fullRoster, isSilent);
      }
    } finally {
      setDrawingBracketIdx(-1);
      isDrawingRef.current = false;
    }
  };

  // ── Auto-Draw all remaining brackets sequentially ────────────────────────
  const runAutoDrawRemaining = async () => {
    if (isDrawingRef.current || isAutoPlayingRef.current || isAllDone) return;
    setIsAutoPlaying(true);
    isAutoPlayingRef.current = true;
    animCancelRef.current = false;
    lastAutoDrawStartTimeRef.current = Date.now();

    try {
      const total = groupsRef.current.length;
      for (let gi = 0; gi < total; gi++) {
        if (animCancelRef.current) break;
        // Skip brackets that are already drawn
        if (groupsRef.current[gi]?.isDrawn) continue;

        await drawSingleBracket(gi, true /* isSilent during auto draw sequence */);

        if (animCancelRef.current) break;
        await delay(350); // Pause between brackets
      }
    } finally {
      setIsAutoPlaying(false);
      isAutoPlayingRef.current = false;
      // Final comprehensive sync to Supabase, Match Store, and Dispatch Queue
      const safeTeams = category?.teams || [];
      const fullRoster = safeTeams.length > 0 ? safeTeams : teamsByGroupRef.current.flat();
      saveDrawnGroups(tournamentSlug, effectiveCategoryId, groupsRef.current, fullRoster, false /* broadcast */);
    }
  };

  const handleStopAutoDraw = () => {
    if (Date.now() - lastAutoDrawStartTimeRef.current < 1000) {
      // Ignore accidental double clicks within 1000ms of clicking start
      return;
    }
    animCancelRef.current = true;
    setIsAutoPlaying(false);
    isAutoPlayingRef.current = false;
  };

  // ── Reset everything & re-shuffle ─────────────────────────────────────────
  const handleReset = () => {
    animCancelRef.current = true;
    isDrawingRef.current = false;
    isAutoPlayingRef.current = false;
    setIsAutoPlaying(false);
    setDrawingBracketIdx(-1);
    setDrawnCount(0);
    drawnCountRef.current = 0;
    setSelectedSlot(null);
    setDraggedSlot(null);
    setSwapNotice(null);

    // Completely clear drawn groups, main draw, live matches, and queue across system
    resetDrawnGroups(
      tournamentSlug,
      effectiveCategoryId,
      [categoryId, category?.id].filter(Boolean) as string[]
    );

    const safeTeams = category?.teams || [];
    if (safeTeams.length === 0) {
      setGroups([]);
      groupsRef.current = [];
      setTeamsByGroup([]);
      teamsByGroupRef.current = [];
      return;
    }

    const n = Math.max(1, Math.min(numBrackets, Math.ceil(safeTeams.length / 2) || 1));

    // Redistribute fresh roster on reset
    const buckets = balancedDistribute(safeTeams, n);
    setTeamsByGroup(buckets);
    teamsByGroupRef.current = buckets;

    const initial: BracketGroup[] = buckets.map((bucketTeams, i) => ({
      name: `Bracket ${LETTERS[i] ?? i + 1}`,
      letter: LETTERS[i] ?? String(i + 1),
      slots: bucketTeams.map(() => ({ team: null, revealed: false })),
      revealed: false,
      isDrawn: false,
    }));

    setGroups(initial);
    groupsRef.current = initial;
  };

  // ── Locked Team Checker ───────────────────────────────────────────────────
  const isTeamLocked = (team?: Team | null) => {
    if (!team) return false;
    const tId = team.id;
    const tName = team.name.trim().toLowerCase();
    const liveMatches = getMatches();
    return liveMatches.some((m) => {
      const isThisCat =
        (m.tournamentSlug === tournamentSlug || !m.tournamentSlug) &&
        (m.categoryId === effectiveCategoryId || !m.categoryId);
      if (!isThisCat) return false;
      if (m.status !== "live" && m.status !== "final") return false;
      const matchA =
        (tId && m.id.includes(tId)) ||
        (m.teamAName && m.teamAName.trim().toLowerCase() === tName);
      const matchB =
        (tId && m.id.includes(tId)) ||
        (m.teamBName && m.teamBName.trim().toLowerCase() === tName);
      return matchA || matchB;
    });
  };

  // ── Drag & Click Swap Handler ─────────────────────────────────────────────
  const handleSwapSlots = (
    fromGroupIdx: number,
    fromSlotIdx: number,
    toGroupIdx: number,
    toSlotIdx: number
  ) => {
    if (isAnimating) return;
    if (fromGroupIdx === toGroupIdx && fromSlotIdx === toSlotIdx) {
      setSelectedSlot(null);
      return;
    }

    const currentGroups = groupsRef.current;
    const sourceGroup = currentGroups[fromGroupIdx];
    const targetGroup = currentGroups[toGroupIdx];
    if (!sourceGroup || !targetGroup) return;

    const sourceSlot = sourceGroup.slots[fromSlotIdx];
    const targetSlot = targetGroup.slots[toSlotIdx];
    if (!sourceSlot || !targetSlot) return;

    // Both cannot be completely empty
    if (!sourceSlot.team && !targetSlot.team) {
      setSelectedSlot(null);
      return;
    }

    // Safety checks against moving teams with live or completed match history
    if (isTeamLocked(sourceSlot.team)) {
      alert(`Cannot move ${sourceSlot.team?.name || "this team"}: they already have an active or completed match on court.`);
      setSelectedSlot(null);
      return;
    }
    if (isTeamLocked(targetSlot.team)) {
      alert(`Cannot move ${targetSlot.team?.name || "this team"}: they already have an active or completed match on court.`);
      setSelectedSlot(null);
      return;
    }

    const prevGroupsSnapshot = JSON.parse(JSON.stringify(currentGroups)) as BracketGroup[];

    // Deep clone groups to prevent accidental state mutation
    const nextGroups = currentGroups.map((g) => ({
      ...g,
      slots: g.slots.map((s) => ({ ...s })),
    }));

    const nextSource = nextGroups[fromGroupIdx]!.slots[fromSlotIdx]!;
    const nextTarget = nextGroups[toGroupIdx]!.slots[toSlotIdx]!;

    const sourceTeam = nextSource.team;
    const targetTeam = nextTarget.team;

    nextSource.team = targetTeam;
    nextTarget.team = sourceTeam;

    if (sourceTeam && targetTeam === null) {
      nextTarget.revealed = true;
      nextSource.revealed = false;
    } else if (targetTeam && sourceTeam === null) {
      nextSource.revealed = true;
      nextTarget.revealed = false;
    }

    // Update state and ref
    setGroups(nextGroups);
    groupsRef.current = nextGroups;

    // Update teamsByGroup buckets
    const nextBuckets = nextGroups.map((g) =>
      g.slots.map((s) => s.team).filter((t): t is Team => t !== null)
    );
    setTeamsByGroup(nextBuckets);
    teamsByGroupRef.current = nextBuckets;

    // Clean any unplayed dispatch queue items that now cross brackets
    try {
      const q = getDispatchQueue();
      const cleanedQ = q.filter((item) => {
        if (item.status === "live" || item.status === "dispatched") return true;
        return isMatchInSameBracket(
          item.tournamentSlug || tournamentSlug,
          item.categoryId || effectiveCategoryId,
          item.stage,
          item.teamAName,
          item.teamBName,
          undefined,
          undefined,
          item.teamAPlayers,
          item.teamBPlayers
        );
      });
      saveDispatchQueue(cleanedQ);
    } catch {
      // ignore
    }

    // Comprehensive sync to Supabase, localStorage, and MatchStore
    const safeTeams = category?.teams || [];
    const fullRoster = safeTeams.length > 0 ? safeTeams : nextBuckets.flat();
    saveDrawnGroups(tournamentSlug, effectiveCategoryId, nextGroups, fullRoster, false);

    const sourceLabel = sourceTeam?.name || "Empty Slot";
    const targetLabel = targetTeam?.name || "Empty Slot";
    setSwapNotice({
      message: `Swapped ${sourceLabel} (Bracket ${sourceGroup.letter}) and ${targetLabel} (Bracket ${targetGroup.letter})`,
      previousGroups: prevGroupsSnapshot,
    });

    setSelectedSlot(null);
    setDraggedSlot(null);
  };

  const handleUndoSwap = () => {
    if (!swapNotice) return;
    const restoredGroups = swapNotice.previousGroups;
    setGroups(restoredGroups);
    groupsRef.current = restoredGroups;

    const nextBuckets = restoredGroups.map((g) =>
      g.slots.map((s) => s.team).filter((t): t is Team => t !== null)
    );
    setTeamsByGroup(nextBuckets);
    teamsByGroupRef.current = nextBuckets;

    // Clean dispatch queue items
    try {
      const q = getDispatchQueue();
      const cleanedQ = q.filter((item) => {
        if (item.status === "live" || item.status === "dispatched") return true;
        return isMatchInSameBracket(
          item.tournamentSlug || tournamentSlug,
          item.categoryId || effectiveCategoryId,
          item.stage,
          item.teamAName,
          item.teamBName,
          undefined,
          undefined,
          item.teamAPlayers,
          item.teamBPlayers
        );
      });
      saveDispatchQueue(cleanedQ);
    } catch {
      // ignore
    }

    const safeTeams = category?.teams || [];
    const fullRoster = safeTeams.length > 0 ? safeTeams : nextBuckets.flat();
    saveDrawnGroups(tournamentSlug, effectiveCategoryId, restoredGroups, fullRoster, false);

    setSwapNotice(null);
    setSelectedSlot(null);
    setDraggedSlot(null);
  };

  const [undoRoster, setUndoRoster] = useState<{
    action: "populate" | "delete";
    teams: Team[];
    label: string;
  } | null>(null);

  const handleQuickPopulate = () => {
    const confirmMsg =
      teams.length > 0
        ? `Replace current roster (${teams.length} teams) with ${maxCapacity} verified teams for a ${targetBrackets}-bracket draw?`
        : `Generate and populate ${maxCapacity} verified teams for a ${targetBrackets}-bracket draw?`;
    if (!window.confirm(confirmMsg)) return;

    setUndoRoster({
      action: "populate",
      teams: [...teams],
      label: `Previous roster (${teams.length} teams)`,
    });

    resetDrawnGroups(
      tournamentSlug,
      effectiveCategoryId,
      [categoryId, category?.id].filter(Boolean) as string[]
    );

    const generated = generateMockTeams(maxCapacity, { verifiedOnly: true });
    bulkSetTeamsInCategory(tournamentSlug, categoryId, generated);

    // Immediately compute the correct bracket distribution with the fresh roster.
    // This prevents the useEffect from running with a stale category.teams count
    // (old value) and producing the wrong number of brackets.
    const _n = targetBrackets;
    const _buckets = balancedDistribute(generated, _n);
    const _initial: BracketGroup[] = _buckets.map((bt, i) => ({
      name: `Bracket ${LETTERS[i] ?? i + 1}`,
      letter: LETTERS[i] ?? String(i + 1),
      slots: bt.map(() => ({ team: null, revealed: false })),
      revealed: false,
      isDrawn: false,
    }));
    setTeamsByGroup(_buckets);
    teamsByGroupRef.current = _buckets;
    setGroups(_initial);
    groupsRef.current = _initial;
    setDrawnCount(0);
    drawnCountRef.current = 0;
    setSelectedSlot(null);
    setDraggedSlot(null);
    setSwapNotice(null);
    // Tell useEffect to skip its next run (triggered by setNumBrackets below)
    skipEffectRef.current = true;
    setNumBrackets(_n);
  };

  const handleDeleteAllTeams = () => {
    if (teams.length === 0) return;
    if (!window.confirm(`Delete all ${teams.length} teams and players from ${category.label}? This will reset the bracket draw.`)) return;

    setUndoRoster({
      action: "delete",
      teams: [...teams],
      label: `Deleted roster (${teams.length} teams)`,
    });

    resetDrawnGroups(
      tournamentSlug,
      effectiveCategoryId,
      [categoryId, category?.id].filter(Boolean) as string[]
    );
    deleteAllTeamsInCategory(tournamentSlug, categoryId);
    setGroups([]);
    groupsRef.current = [];
    setTeamsByGroup([]);
    teamsByGroupRef.current = [];
    setDrawnCount(0);
    drawnCountRef.current = 0;
    setSelectedSlot(null);
    setDraggedSlot(null);
    setSwapNotice(null);
  };

  const handleUndoRoster = () => {
    if (!undoRoster) return;
    bulkSetTeamsInCategory(tournamentSlug, categoryId, undoRoster.teams);
    setUndoRoster(null);
  };

  return (
    <div className="space-y-6 max-w-7xl pb-20 sm:space-y-8">
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex flex-col gap-5 border-b border-border pb-6">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-[0.3em] text-pickle">
                Live Draw Ceremony
              </span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[0.65rem] font-semibold bg-pickle/15 text-pickle border border-pickle/30">
                1 Bracket at a Time
              </span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[0.65rem] font-semibold bg-pickle/15 text-pickle border border-pickle/30">
                Auto-Synced to Umpire
              </span>
            </div>
            <h2 className="font-display text-3xl text-foreground mt-1 leading-none sm:text-4xl md:text-5xl">
              Randomized Bracket Draw
            </h2>
            <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
              Seed your tournament live in front of players. Draw one bracket at a time to build excitement, or let it auto-play.
            </p>
          </div>

          {/* Progress summary badge */}
          <div className="flex items-center gap-3 surface-card p-3 md:px-5 md:py-3 self-start md:self-auto border border-border">
            <div className="text-right">
              <span className="font-display text-3xl text-pickle leading-none block">
                {drawnCount} / {groups.length}
              </span>
              <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground">
                Brackets Drawn
              </span>
            </div>
            <div className="h-8 w-px bg-border mx-1" />
            <div>
              <span className="font-display text-3xl text-foreground leading-none block">
                {totalTeams}
              </span>
              <span className="text-[0.65rem] uppercase tracking-widest text-muted-foreground">
                Teams Seeded
              </span>
            </div>
          </div>
        </div>

        {/* Controls — 3-col grid on mobile, row on sm+ */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
              Tournament
            </span>
            <select
              value={tournamentSlug}
              disabled={isAnimating}
              onChange={(e) => {
                setTournamentSlug(e.target.value);
                const t = tournaments.find((x) => x.slug === e.target.value);
                if (t?.categories[0]) setCategoryId(t.categories[0].id);
              }}
              className="w-full border border-input bg-background px-3 py-2 text-xs sm:text-sm focus:border-pickle focus:outline-none disabled:opacity-60"
            >
              {tournaments.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
              Category / Division
            </span>
            <select
              value={categoryId}
              disabled={isAnimating}
              onChange={(e) => setCategoryId(e.target.value)}
              className="w-full border border-input bg-background px-3 py-2 text-xs sm:text-sm focus:border-pickle focus:outline-none disabled:opacity-60 font-medium"
            >
              {tournament.categories.map((c) => {
                const grps = getCachedDrawnGroups(tournament.slug, c.id);
                const countFromGrps = grps
                  ? grps.flatMap((g: any) => g.slots?.map((s: any) => s.team)).filter(Boolean).length
                  : 0;
                const count = Math.max(c.teams?.length || 0, countFromGrps);
                return (
                  <option key={c.id} value={c.id}>
                    {c.label} ({count} Teams)
                  </option>
                );
              })}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
              Pools / Brackets
            </span>
            <select
              value={numBrackets}
              disabled={isAnimating}
              onChange={(e) => setNumBrackets(parseInt(e.target.value, 10))}
              className="w-full border border-input bg-background px-3 py-2 text-xs sm:text-sm focus:border-pickle focus:outline-none disabled:opacity-60 font-semibold text-pickle"
            >
              <option value={2}>2 Brackets (A &amp; B - 8 Teams)</option>
              <option value={3}>3 Brackets (A, B, C - 12 Teams)</option>
              <option value={4}>4 Brackets (A, B, C, D - 16 Teams)</option>
              <option value={6}>6 Brackets (A to F - 24 Teams)</option>
              <option value={8}>8 Brackets (A to H - 32 Teams)</option>
              <option value={12}>12 Brackets (A to L - 48 Teams)</option>
            </select>
            {teams.length < maxCapacity && (
              <button
                type="button"
                onClick={handleQuickPopulate}
                disabled={isAnimating}
                className="self-start text-[0.65rem] text-pickle hover:text-foreground font-semibold uppercase tracking-wider underline cursor-pointer mt-1"
              >
                + Auto-Populate {maxCapacity} Teams ({targetBrackets} Brackets)
              </button>
            )}
          </div>
        </div>

        {/* Undo Banner if an action just occurred */}
        {undoRoster && (
          <div className="surface-card flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 bg-pickle/15 border border-pickle/40 rounded text-xs animate-in fade-in duration-300">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-pickle animate-pulse" />
              <span className="text-foreground font-medium">
                {undoRoster.action === "populate"
                  ? `Populated ${maxCapacity} teams into ${category.label}.`
                  : `Deleted all teams from ${category.label}.`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleUndoRoster}
                className="px-3 py-1.5 bg-pickle text-sand font-bold uppercase tracking-wider text-[0.7rem] rounded hover:opacity-90 transition-opacity cursor-pointer shadow-sm"
              >
                Undo ({undoRoster.label})
              </button>
              <button
                type="button"
                onClick={() => setUndoRoster(null)}
                className="text-[0.7rem] text-muted-foreground hover:text-foreground uppercase tracking-wider font-semibold cursor-pointer px-1.5 py-1"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Interactive Bracket Step Navigator ───────────────── */}
      {hasTeams && groups.length > 0 && (
        <div className="border-2 border-border bg-card rounded-xl p-3.5 space-y-2.5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-[0.65rem] uppercase tracking-widest text-foreground font-bold">
              Ceremony Sequence ({drawnCount}/{groups.length} Drawn)
            </span>
            <span className="text-[0.65rem] font-mono text-pickle font-bold">
              {isAllDone ? "Ceremony Complete" : nextBracketLetter ? `Next: Bracket ${nextBracketLetter}` : ""}
            </span>
          </div>

          {/* Responsive grid — wraps cleanly on mobile into 4 columns without horizontal scrolling */}
          <div className="grid grid-cols-4 sm:flex sm:flex-wrap gap-1.5">
            {groups.map((grp, idx) => {
              const isCurrentDrawing = drawingBracketIdx === idx;
              const isGroupDrawn = grp.isDrawn;
              const isNext = nextBracketIdx === idx && !isAnimating;

              return (
                <button
                  key={grp.letter}
                  onClick={() => !isGroupDrawn && !isAnimating && drawSingleBracket(idx)}
                  disabled={isAnimating || isGroupDrawn}
                  className={`flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 py-2 px-1 sm:px-3 text-xs font-bold rounded border-2 transition-all select-none ${isCurrentDrawing
                      ? "border-pickle bg-pickle text-white shadow-md shadow-pickle/25 animate-pulse"
                      : isGroupDrawn
                        ? "border-pickle/40 bg-pickle/15 text-pickle cursor-default"
                        : isNext
                          ? "border-brick bg-brick text-white shadow-sm hover:bg-brick-deep cursor-pointer scale-[1.02]"
                          : "border-border bg-card text-foreground font-bold hover:border-pickle hover:text-pickle cursor-pointer"
                    }`}
                >
                  <span className="font-display text-base sm:text-sm leading-none">{grp.letter}</span>
                  <span className="text-[0.6rem] sm:text-[0.65rem] uppercase font-sans tracking-tight truncate">
                    {isCurrentDrawing ? "Drawing…" : isGroupDrawn ? "Ready" : isNext ? "Next" : "Pending"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Action Buttons Bar ───────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        {/* Step-by-Step Main CTA */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Main Draw Button for Next Bracket */}
          {!isAllDone ? (
            <button
              onClick={() => nextBracketIdx >= 0 && drawSingleBracket(nextBracketIdx)}
              disabled={isAnimating || !hasTeams || nextBracketIdx < 0}
              className={`relative flex items-center gap-3 px-6 py-4 font-display text-2xl tracking-[0.15em] text-sand shadow-lg transition-all duration-200 select-none ${isAnimating
                  ? "bg-brick/70 cursor-not-allowed opacity-80"
                  : !hasTeams
                    ? "bg-muted text-muted-foreground cursor-not-allowed"
                    : "bg-brick hover:bg-brick-deep active:scale-[0.98] cursor-pointer hover:shadow-xl ring-2 ring-brick/50"
                }`}
            >
              {isAnimating ? (
                <>
                  <SpinnerIcon />
                  <span>Drawing Bracket {drawingBracketIdx >= 0 ? LETTERS[drawingBracketIdx] : ""}…</span>
                </>
              ) : (
                <>
                  <span>Draw Bracket {nextBracketLetter}</span>
                  <span className="text-xs font-sans font-bold bg-black/30 px-2 py-0.5 rounded tracking-normal">
                    {drawnCount + 1} of {groups.length}
                  </span>
                </>
              )}
            </button>
          ) : (
            <div className="flex items-center gap-2 bg-pickle/20 border border-pickle px-5 py-3 text-pickle font-display text-xl tracking-wider">
              <span>All {groups.length} Brackets Drawn</span>
            </div>
          )}

          {/* Auto-Play Remaining Button */}
          {!isAllDone && !isAutoPlaying && drawnCount < groups.length - 1 && (
            <button
              type="button"
              onClick={runAutoDrawRemaining}
              disabled={isAnimating}
              className="flex items-center gap-2 border border-pickle/50 bg-charcoal/80 px-4 py-3.5 text-xs font-bold uppercase tracking-widest text-pickle hover:bg-pickle hover:text-sand hover:border-pickle transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <span>Auto-Draw All Remaining</span>
            </button>
          )}

          {/* Active Auto-Play Button with Click to Stop */}
          {isAutoPlaying && (
            <button
              type="button"
              onClick={handleStopAutoDraw}
              className="flex items-center gap-2 border border-brick/60 bg-brick/20 px-4 py-3.5 text-xs font-bold uppercase tracking-widest text-brick hover:bg-brick hover:text-sand transition-all cursor-pointer shadow-sm animate-pulse"
            >
              <SpinnerIcon />
              <span>Drawing Brackets… (Click to Stop)</span>
            </button>
          )}

          {/* Reset button */}
          {(drawnCount > 0 || isAllDone) && (
            <button
              onClick={handleReset}
              disabled={isAnimating}
              className="flex items-center gap-2 border border-border bg-charcoal px-4 py-3.5 text-xs font-bold uppercase tracking-widest text-sand hover:border-brick hover:text-brick transition-colors disabled:opacity-50"
            >
              <span>Reset Draw</span>
            </button>
          )}

          {/* Delete All Players */}
          <button
            onClick={handleDeleteAllTeams}
            disabled={isAnimating || teams.length === 0}
            className={`flex items-center gap-1.5 border px-4 py-3.5 text-xs font-bold uppercase tracking-widest transition-all ${
              teams.length > 0
                ? "border-brick/40 bg-brick/10 text-brick hover:bg-brick hover:text-sand cursor-pointer"
                : "border-border/60 bg-muted/30 text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            <span>Delete All Players {teams.length > 0 ? `(${teams.length})` : "(0)"}</span>
          </button>

          {/* Undo Action Button */}
          {undoRoster && (
            <button
              onClick={handleUndoRoster}
              disabled={isAnimating}
              className="flex items-center gap-1.5 border border-pickle bg-pickle/20 px-4 py-3.5 text-xs font-bold uppercase tracking-widest text-pickle hover:bg-pickle hover:text-sand transition-all cursor-pointer shadow-sm"
            >
              <span>Undo ({undoRoster.label})</span>
            </button>
          )}
        </div>

        {/* Info hint */}
        <div className="text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-pickle" />
            <span>Click any pending bracket card or button to reveal one at a time.</span>
          </div>
          {drawnCount > 0 && (
            <div className="flex items-center gap-1.5 text-pickle text-[0.7rem] font-semibold uppercase tracking-wider">
              <span>Drag or tap teams to switch brackets</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Empty State ──────────────────────────────────────── */}
      {!hasTeams && (
        <div className="surface-card flex flex-col items-center justify-center gap-4 p-12 text-center border border-border">
          <span className="text-xs uppercase tracking-[0.28em] font-bold text-pickle">
            Bracket Draw Standby
          </span>
          <h3 className="font-display text-3xl text-foreground">No Teams in Category</h3>
          <p className="max-w-md text-sm text-muted-foreground">
            Add teams in the <strong>Teams</strong> tab first, or auto-populate {maxCapacity} verified doubles teams to run a {targetBrackets}-bracket ceremony right now.
          </p>
          <button
            type="button"
            onClick={handleQuickPopulate}
            className="px-5 py-2.5 bg-pickle text-sand hover:opacity-90 font-semibold text-xs tracking-wider uppercase rounded transition-all cursor-pointer shadow"
          >
            Auto-Populate {maxCapacity} Teams for Draw
          </button>
        </div>
      )}

      {/* ── Brackets Grid (Supports up to 8 brackets with 32 teams) ── */}
      {hasTeams && groups.length > 0 && (
        <div className="space-y-4">
          {/* Active selection banner for mobile / desktop click to swap */}
          {selectedSlot && (
            <div className="flex flex-wrap items-center justify-between gap-3 bg-pickle/15 border-2 border-pickle px-4 py-3 rounded-xl text-xs sm:text-sm text-foreground shadow-sm animate-in fade-in duration-200">
              <div className="flex items-center gap-2 min-w-0">
                <span className="h-2 w-2 rounded-full bg-pickle animate-ping shrink-0" />
                <span className="truncate">
                  Selected: <strong>{groups[selectedSlot.groupIndex]?.slots[selectedSlot.slotIndex]?.team?.name || "Empty Slot"}</strong> (Bracket {groups[selectedSlot.groupIndex]?.letter}, Slot {selectedSlot.slotIndex + 1}) — Tap another slot to switch brackets.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSlot(null)}
                className="border border-border bg-charcoal px-3 py-1.5 text-[0.7rem] font-bold uppercase tracking-wider text-sand hover:border-pickle hover:text-pickle transition-colors cursor-pointer shrink-0"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Swap Notice Banner with Undo */}
          {swapNotice && (
            <div className="flex flex-wrap items-center justify-between gap-3 bg-card border border-pickle/40 px-4 py-2.5 rounded-xl text-xs sm:text-sm text-foreground shadow-sm animate-in fade-in duration-200">
              <div className="flex items-center gap-2 min-w-0">
                <span className="h-1.5 w-1.5 rounded-full bg-pickle shrink-0" />
                <span className="truncate">{swapNotice.message}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleUndoSwap}
                  className="bg-pickle text-sand px-3 py-1 text-[0.7rem] font-bold uppercase tracking-wider hover:opacity-90 transition-opacity cursor-pointer rounded"
                >
                  Undo Swap
                </button>
                <button
                  type="button"
                  onClick={() => setSwapNotice(null)}
                  className="text-muted-foreground hover:text-foreground text-[0.7rem] uppercase font-semibold px-1 cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <div
            className={`grid gap-6 ${numBrackets === 1
                ? "max-w-md mx-auto"
                : numBrackets === 2
                  ? "grid-cols-1 md:grid-cols-2"
                  : numBrackets === 3
                    ? "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
                    : numBrackets === 4
                      ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
                      : numBrackets === 6
                        ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3"
                        : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              }`}
          >
            {groups.map((group, gi) => {
              const isActive = drawingBracketIdx === gi;
              const isDrawn = group.isDrawn;
              const isNext = nextBracketIdx === gi && !isAnimating;

              return (
                <BracketCard
                  key={group.letter}
                  group={group}
                  index={gi}
                  isActive={isActive}
                  isDrawn={isDrawn}
                  isNext={isNext}
                  isAnimating={isAnimating}
                  onDrawThisBracket={() => drawSingleBracket(gi)}
                  selectedSlot={selectedSlot}
                  onSelectSlot={(groupIdx, slotIdx) => {
                    if (!selectedSlot) {
                      setSelectedSlot({ groupIndex: groupIdx, slotIndex: slotIdx });
                    } else if (selectedSlot.groupIndex === groupIdx && selectedSlot.slotIndex === slotIdx) {
                      setSelectedSlot(null);
                    } else {
                      handleSwapSlots(selectedSlot.groupIndex, selectedSlot.slotIndex, groupIdx, slotIdx);
                    }
                  }}
                  draggedSlot={draggedSlot}
                  onDragStartSlot={(groupIdx, slotIdx) => {
                    setDraggedSlot({ groupIndex: groupIdx, slotIndex: slotIdx });
                  }}
                  onDropSlot={(groupIdx, slotIdx) => {
                    if (draggedSlot) {
                      handleSwapSlots(draggedSlot.groupIndex, draggedSlot.slotIndex, groupIdx, slotIdx);
                    }
                  }}
                  isTeamLocked={isTeamLocked}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* ── Done Banner ─────────────────────────────────────── */}
      {isAllDone && (
        <div className="border-2 border-pickle bg-pickle/10 p-6 text-center space-y-3 animate-in fade-in zoom-in duration-500 rounded-sm">
          <span className="text-xs uppercase tracking-[0.28em] font-bold text-pickle block">
            Draw Completed
          </span>
          <h3 className="font-display text-3xl text-foreground sm:text-4xl">
            All {groups.length} Brackets Seeded
          </h3>
          <p className="text-sm text-muted-foreground max-w-xl mx-auto">
            {totalTeams} teams have been randomized across Brackets A through {LETTERS[groups.length - 1]}. You can now record match scores and advance players in <strong>Draws &amp; Brackets</strong>.
          </p>
          <div className="pt-2 flex flex-wrap justify-center gap-3">
            <button
              onClick={handleReset}
              className="border border-border bg-charcoal px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors"
            >
              Re-Shuffle &amp; Draw Again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── BracketCard ────────────────────────────────────────────────────────────
function BracketCard({
  group,
  index,
  isActive,
  isDrawn,
  isNext,
  isAnimating,
  onDrawThisBracket,
  selectedSlot,
  onSelectSlot,
  draggedSlot,
  onDragStartSlot,
  onDropSlot,
  isTeamLocked,
}: {
  group: BracketGroup;
  index: number;
  isActive: boolean;
  isDrawn: boolean;
  isNext: boolean;
  isAnimating: boolean;
  onDrawThisBracket: () => void;
  selectedSlot: { groupIndex: number; slotIndex: number } | null;
  onSelectSlot: (groupIndex: number, slotIndex: number) => void;
  draggedSlot: { groupIndex: number; slotIndex: number } | null;
  onDragStartSlot: (groupIndex: number, slotIndex: number) => void;
  onDropSlot: (groupIndex: number, slotIndex: number) => void;
  isTeamLocked: (team?: Team | null) => boolean;
}) {
  const revealedCount = group.slots.filter((s) => s.revealed).length;
  const totalSlots = group.slots.length;

  return (
    <div
      className={`flex flex-col overflow-hidden border-2 transition-all duration-300 rounded-xl shadow-xs ${isActive
          ? "border-pickle shadow-xl shadow-pickle/20 scale-[1.02] ring-2 ring-pickle"
          : isDrawn
            ? "border-pickle/50 bg-card"
            : isNext
              ? "border-brick/80 shadow-md shadow-brick/10 scale-[1.01]"
              : "border-border/80 opacity-70 hover:opacity-100"
        }`}
    >
      {/* ── Card Header ── */}
      <div
        className={`relative flex items-center justify-between overflow-hidden px-5 py-4 transition-colors duration-400 ${isActive
            ? "bg-pickle text-sand"
            : isDrawn
              ? "bg-charcoal text-sand"
              : isNext
                ? "bg-brick text-sand"
                : "bg-charcoal/70 text-sand/80"
          }`}
      >
        {/* Animated scan line when this bracket is active */}
        {isActive && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 50%, transparent 100%)",
              animation: "scan-line 1.2s linear infinite",
            }}
          />
        )}

        <div className="flex items-center gap-3 relative z-10">
          {/* Big bracket letter */}
          <span className="font-display text-4xl leading-none text-sand">
            {group.letter}
          </span>
          <div>
            <span className="block font-display text-xl leading-tight text-sand">
              {group.name}
            </span>
            <span className="block text-[0.6rem] uppercase tracking-[0.22em] text-sand/70">
              {revealedCount} / {totalSlots} Teams
            </span>
          </div>
        </div>

        {/* Status indicator / Trigger button */}
        <div className="relative z-10">
          {isActive ? (
            <span className="flex items-center gap-1.5 rounded-full bg-sand/20 px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-widest text-sand animate-pulse">
              <span className="h-1.5 w-1.5 rounded-full bg-sand" /> Drawing…
            </span>
          ) : isDrawn ? (
            <span className="rounded-full bg-pickle/30 px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-widest text-pickle border border-pickle/40">
              Ready
            </span>
          ) : isNext ? (
            <button
              onClick={onDrawThisBracket}
              disabled={isAnimating}
              className="rounded bg-sand text-charcoal px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider hover:bg-white active:scale-95 transition-all shadow cursor-pointer"
            >
              Draw Now
            </button>
          ) : (
            <button
              onClick={onDrawThisBracket}
              disabled={isAnimating}
              className="rounded border border-sand/30 bg-black/20 text-sand/70 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-widest hover:border-sand hover:text-sand hover:bg-black/40 transition-all"
            >
              Draw
            </button>
          )}
        </div>
      </div>

      {/* ── Team Slots List ── */}
      <div className="flex flex-col divide-y divide-border/60 bg-card min-h-[140px]">
        {group.slots.length === 0 ? (
          Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 opacity-20">
              <span className="font-display text-lg text-muted-foreground">{i + 1}</span>
              <div className="h-3.5 flex-1 rounded bg-border" />
            </div>
          ))
        ) : (
          group.slots.map((slot, ti) => {
            const isSelected = selectedSlot?.groupIndex === index && selectedSlot?.slotIndex === ti;
            const isOtherSelected = Boolean(selectedSlot && !isSelected);
            const isLocked = isTeamLocked(slot.team);

            return (
              <TeamSlot
                key={ti}
                slot={slot}
                index={ti}
                groupIndex={index}
                bracketLetter={group.letter}
                isGroupActive={isActive}
                isAnimating={isAnimating}
                isSelected={isSelected}
                isOtherSelected={isOtherSelected}
                isLocked={isLocked}
                onSelect={() => onSelectSlot(index, ti)}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", `${index},${ti}`);
                  onDragStartSlot(index, ti);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                }}
                onDrop={() => {
                  onDropSlot(index, ti);
                }}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

// ── TeamSlot ──────────────────────────────────────────────────────────────
function TeamSlot({
  slot,
  index,
  groupIndex,
  bracketLetter,
  isGroupActive,
  isAnimating,
  isSelected,
  isOtherSelected,
  isLocked,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  slot: BracketSlot;
  index: number;
  groupIndex: number;
  bracketLetter: string;
  isGroupActive: boolean;
  isAnimating: boolean;
  isSelected: boolean;
  isOtherSelected: boolean;
  isLocked: boolean;
  onSelect: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const hasTeam = Boolean(slot.team);
  const canInteract = !isAnimating && (hasTeam || isOtherSelected);
  const canDrag = !isAnimating && !isLocked && hasTeam && slot.revealed;

  return (
    <div
      draggable={canDrag}
      onDragStart={canDrag ? onDragStart : undefined}
      onDragOver={canInteract ? onDragOver : undefined}
      onDrop={canInteract ? onDrop : undefined}
      onClick={() => {
        if (!canInteract) return;
        onSelect();
      }}
      className={`group relative flex items-center gap-3 px-4 py-3 transition-all duration-200 select-none ${
        slot.revealed
          ? "opacity-100 translate-y-0"
          : "opacity-35 translate-y-1"
      } ${
        isSelected
          ? "bg-pickle/20 border-l-4 border-l-pickle ring-2 ring-pickle/80 shadow-md"
          : isOtherSelected
            ? "cursor-pointer hover:bg-pickle/15 hover:border-l-4 hover:border-l-pickle/60 active:scale-[0.99]"
            : canDrag
              ? "cursor-pointer hover:bg-muted/40 active:cursor-grabbing"
              : ""
      } ${
        slot.revealed && isGroupActive
          ? "bg-pickle/10 border-l-2 border-l-pickle"
          : slot.revealed && !isSelected
            ? "border-l-2 border-l-transparent bg-card"
            : "bg-card/50"
      }`}
    >
      {/* Seed number or Drag Indicator */}
      <div className="flex-shrink-0 flex items-center justify-center w-6 text-center">
        {canDrag && !isSelected ? (
          <div
            title="Drag to switch bracket"
            className="hidden group-hover:flex items-center justify-center text-muted-foreground/60 hover:text-pickle transition-colors"
          >
            {/* 6 dots drag handle icon */}
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="9" cy="6" r="1.5" />
              <circle cx="15" cy="6" r="1.5" />
              <circle cx="9" cy="12" r="1.5" />
              <circle cx="15" cy="12" r="1.5" />
              <circle cx="9" cy="18" r="1.5" />
              <circle cx="15" cy="18" r="1.5" />
            </svg>
          </div>
        ) : null}
        <span
          className={`font-display text-lg leading-none transition-colors ${
            canDrag && !isSelected ? "group-hover:hidden" : ""
          } ${
            isSelected
              ? "text-pickle font-bold"
              : slot.revealed
                ? "text-pickle"
                : "text-muted-foreground/40"
          }`}
        >
          {index + 1}
        </span>
      </div>

      {/* Team info */}
      <div className="flex-1 min-w-0">
        {slot.revealed && slot.team ? (
          <>
            <div className="flex items-center justify-between gap-1">
              <span className="block font-semibold text-foreground truncate text-xs sm:text-sm">
                {slot.team.name}
              </span>
              {isSelected ? (
                <span className="text-[0.6rem] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-pickle text-sand shrink-0 shadow-xs">
                  Selected
                </span>
              ) : isLocked ? (
                <span
                  title="Team has an active or completed match on court"
                  className="flex items-center gap-1 text-[0.6rem] font-bold uppercase tracking-wider text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/30 shrink-0"
                >
                  <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <span>Locked</span>
                </span>
              ) : isOtherSelected ? (
                <span className="text-[0.6rem] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-pickle/20 text-pickle border border-pickle/40 shrink-0 hidden sm:inline-block">
                  Tap to Swap
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5 text-[0.65rem] text-foreground/80 font-medium truncate mt-0.5">
              <span className="truncate">{slot.team.players.join(" & ")}</span>
              {slot.team.club && (
                <>
                  <span className="text-muted-foreground/40 shrink-0">•</span>
                  <span className="text-[0.6rem] px-1.5 py-0.2 rounded bg-charcoal/40 text-sand/80 border border-border/60 shrink-0 font-medium">
                    {slot.team.club}
                  </span>
                </>
              )}
            </div>
          </>
        ) : isOtherSelected ? (
          <div className="flex items-center justify-between py-1">
            <span className="text-xs text-pickle font-medium italic">Empty Slot — Tap to move team here</span>
            <span className="text-[0.6rem] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-pickle/20 text-pickle border border-pickle/40">
              Move Here
            </span>
          </div>
        ) : (
          <div className="space-y-1.5 py-0.5">
            <div className="h-3 w-3/4 rounded bg-border/40" />
            <div className="h-2 w-1/2 rounded bg-border/20" />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Spinner Icon ───────────────────────────────────────────────────────────
function SpinnerIcon() {
  return (
    <svg
      className="h-5 w-5 animate-spin text-sand"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
