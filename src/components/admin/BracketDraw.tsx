import { useState, useEffect, useRef, useMemo } from "react";
import type { Team, Tournament, Category } from "@/data/tournaments";
import {
  syncDrawnBracketsToLiveMatches,
  purgeMatchesForCategory,
  createPairMatchId,
  createCategoryScopedMatchId,
  isGenericTeamName,
} from "@/lib/match-store";
import {
  bulkSetTeamsInCategory,
  deleteAllTeamsInCategory,
  getTournaments,
  updateCategoryInTournament,
  updateTeamInTournament,
} from "@/lib/tournament-store";
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
  isSameCategory,
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
      clearMainDrawCache(tournamentSlug, categoryId);
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`dv_main_draw_${tournamentSlug}_`)) {
          const suffix = k.substring(`dv_main_draw_${tournamentSlug}_`.length);
          if (suffix === categoryId || isSameCategory(suffix, categoryId)) {
            localStorage.removeItem(k);
          }
        }
      }
    } catch {
      // ignore
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
        const existingMap = new Map(existingTeams.map((t) => [t.id, t]));
        const hasChange =
          existingTeams.length !== teamsToSync.length ||
          teamsToSync.some((t) => {
            const ex = existingMap.get(t.id);
            if (!ex) return true;
            return (
              ex.name !== t.name ||
              ex.club !== t.club ||
              JSON.stringify(ex.players || []) !== JSON.stringify(t.players || [])
            );
          });

        if (hasChange) {
          bulkSetTeamsInCategory(tournamentSlug, currentCat?.id || categoryId, teamsToSync);
        }
      } catch {
        // ignore
      }
    }

    // In silent mode (intermediate auto-draw step), skip store thrashing and event broadcasts
    if (isSilent) {
      return;
    }

    const syncedMatches = syncDrawnBracketsToLiveMatches(tournamentSlug, categoryId, groups);

    // Clean any unplayed dispatch queue items that no longer belong to the same bracket
    try {
      const currentQ = getDispatchQueue();
      const cleanedQ = currentQ.filter((item) => {
        if (item.status === "live" || item.status === "dispatched") return true;
        return isMatchInSameBracket(
          item.tournamentSlug || tournamentSlug,
          item.categoryId || categoryId,
          item.stage,
          item.teamAName,
          item.teamBName,
          undefined,
          undefined,
          item.teamAPlayers,
          item.teamBPlayers
        );
      });
      if (cleanedQ.length !== currentQ.length) {
        saveDispatchQueue(cleanedQ);
      }
    } catch {
      // ignore
    }

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

    const makeTeamSchedKey = (name: string, players?: string[]) => {
      const pNorm = (players || [])
        .flatMap((p) => p.split(/\s*[\/&]\s*/))
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join("|");
      return pNorm ? `p:${pNorm}` : `n:${name.trim().toLowerCase()}`;
    };

    const finalMatchIds = new Set(
      syncedMatches.filter((m) => m.status === "final").map((m) => m.id)
    );

    const scheduledTeams = new Set<string>();
    syncedMatches.forEach((m) => {
      if (m.status === "live") {
        scheduledTeams.add(makeTeamSchedKey(m.teamAName, m.teamAPlayers));
        scheduledTeams.add(makeTeamSchedKey(m.teamBName, m.teamBPlayers));
      }
    });

    const existingQueue = getDispatchQueue();
    existingQueue.forEach((q) => {
      if (q.status === "queued" || q.status === "on_deck" || q.status === "live" || q.status === "dispatched") {
        scheduledTeams.add(makeTeamSchedKey(q.teamAName, q.teamAPlayers));
        scheduledTeams.add(makeTeamSchedKey(q.teamBName, q.teamBPlayers));
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
          if (finalMatchIds.has(matchId)) continue;

          const aKey = makeTeamSchedKey(teamA.name, teamA.players);
          const bKey = makeTeamSchedKey(teamB.name, teamB.players);

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
    window.dispatchEvent(new Event("dv_main_draw_updated"));
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
          const prefix = k.startsWith(`dv_drawn_groups_${tournamentSlug}_`)
            ? `dv_drawn_groups_${tournamentSlug}_`
            : `dv_main_draw_${tournamentSlug}_`;
          const suffix = k.substring(prefix.length);
          const matchTarget = targetIds.some((cid) => suffix === cid || isSameCategory(suffix, cid));
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
  // Note: dbDeleteDrawnGroups atomically deletes both drawnGroups and mainDraw in a single update

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

export const LETTERS = [
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L",
  "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"
];

export function getBracketsForCapacity(cap: number): number {
  if (cap >= 48) return 12;
  if (cap >= 32) return 8;
  if (cap >= 24) return 6;
  if (cap >= 16) return 4;
  if (cap >= 12) return 3;
  if (cap >= 6) return 2;
  return 1;
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
  const targetBrackets = category?.bracketCount || getBracketsForCapacity(maxCapacity);
  const [numBrackets, setNumBrackets] = useState(targetBrackets);
  const [bracketInputVal, setBracketInputVal] = useState(targetBrackets);
  const [isEditBracketsModalOpen, setIsEditBracketsModalOpen] = useState(false);
  const [modalMakeDefault, setModalMakeDefault] = useState(false);
  const [teamsByGroup, setTeamsByGroup] = useState<Team[][]>([]);
  const [drawnCount, setDrawnCount] = useState(0);
  const [drawingBracketIdx, setDrawingBracketIdx] = useState(-1);
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const [bracketSaveNotice, setBracketSaveNotice] = useState<string | null>(null);

  // Keep direct input value in sync when numBrackets updates
  useEffect(() => {
    setBracketInputVal(numBrackets);
  }, [numBrackets]);

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
  const [editingSlot, setEditingSlot] = useState<{
    groupIndex: number;
    slotIndex: number;
    teamName: string;
    player1: string;
    player2: string;
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

  // Keep local bracket state synced if edited via Players by Bracket checklist
  useEffect(() => {
    const handleDrawnGroupsSync = () => {
      if (isDrawingRef.current || isAutoPlayingRef.current) return;
      const latest = getDrawnGroups(tournamentSlug, effectiveCategoryId);
      if (latest && latest.length > 0) {
        setGroups((prev) =>
          JSON.stringify(prev) === JSON.stringify(latest) ? prev : latest
        );
        groupsRef.current = latest;
        const drawnNum = latest.filter((g) => g.isDrawn).length;
        setDrawnCount(drawnNum);
        drawnCountRef.current = drawnNum;
      }
    };
    window.addEventListener("dv_drawn_groups_updated", handleDrawnGroupsSync);
    return () => {
      window.removeEventListener("dv_drawn_groups_updated", handleDrawnGroupsSync);
    };
  }, [tournamentSlug, effectiveCategoryId]);

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
        setNumBrackets(matchedCategory?.bracketCount || category?.bracketCount || getBracketsForCapacity(catCap));
      }
    }

    // Skip if a direct populate already set the correct state
    if (skipEffectRef.current) {
      skipEffectRef.current = false;
      return;
    }

    const existingDrawn = getDrawnGroups(tournamentSlug, effectiveCategoryId);

    if (safeTeams.length === 0) {
      // Check if existing drawn groups have teams to restore into category.teams
      if (existingDrawn && existingDrawn.length > 0) {
        const drawnTeams = existingDrawn
          .flatMap((g) => g.slots.map((s) => s.team))
          .filter((t): t is Team => t !== null);
        if (drawnTeams.length > 0) {
          try {
            bulkSetTeamsInCategory(tournamentSlug, effectiveCategoryId, drawnTeams);
          } catch {
            // ignore
          }
          setGroups(existingDrawn);
          groupsRef.current = existingDrawn;
          const drawnNum = existingDrawn.filter((g) => g.isDrawn).length;
          setDrawnCount(drawnNum);
          drawnCountRef.current = drawnNum;
          const buckets: Team[][] = existingDrawn.map((g) => {
            return g.slots.map((s) => s.team).filter((t): t is Team => t !== null);
          });
          setTeamsByGroup(buckets);
          teamsByGroupRef.current = buckets;
          if (existingDrawn.length !== numBrackets) {
            setNumBrackets(existingDrawn.length);
          }
          syncDrawnBracketsToLiveMatches(tournamentSlug, effectiveCategoryId, existingDrawn);
          return;
        }
      }
      setGroups([]);
      groupsRef.current = [];
      setTeamsByGroup([]);
      teamsByGroupRef.current = [];
      setDrawnCount(0);
      drawnCountRef.current = 0;
      return;
    }

    const n = Math.max(1, Math.min(numBrackets, 26));

    // Check if brackets were already drawn for this tournament & category
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

        // Sync any missing teams from drawn groups into category.teams so rosters are backed up
        const missingDrawnTeams = existingDrawn
          .flatMap((g) => g.slots.map((s) => s.team))
          .filter((t): t is Team => t !== null && !_currentIds.has(t.id));
        if (missingDrawnTeams.length > 0) {
          try {
            const merged = [...safeTeams, ...missingDrawnTeams];
            bulkSetTeamsInCategory(tournamentSlug, effectiveCategoryId, merged);
            missingDrawnTeams.forEach((t) => _currentIds.add(t.id));
          } catch {
            // ignore
          }
        }

        const _rosterMatch =
          _cachedIds.size <= _currentIds.size && [..._cachedIds].every((id) => _currentIds.has(id));

        if (_rosterMatch) {
          const safeTeamsById = new Map(safeTeams.map((t) => [t.id, t]));
          let didRefreshFromRoster = false;
          const reconciledDrawn: BracketGroup[] = existingDrawn.map((g) => ({
            ...g,
            slots: g.slots.map((s) => {
              if (!s.team) return s;
              const fresh = safeTeamsById.get(s.team.id);
              if (!fresh) return s;
              if (
                fresh.name !== s.team.name ||
                fresh.club !== s.team.club ||
                JSON.stringify(fresh.players || []) !== JSON.stringify(s.team.players || [])
              ) {
                didRefreshFromRoster = true;
                return {
                  ...s,
                  team: {
                    ...s.team,
                    name: fresh.name,
                    players: fresh.players,
                    club: fresh.club,
                  },
                };
              }
              return s;
            }),
          }));

          setGroups(reconciledDrawn);
          groupsRef.current = reconciledDrawn;
          setDrawnCount(drawnNum);
          drawnCountRef.current = drawnNum;

          // Rebuild teamsByGroup: drawn brackets keep their revealed teams;
          // undrawn brackets use balancedDistribute for remaining teams.
          const _undrawnPool = safeTeams.filter((t) => !_cachedIds.has(t.id));
          const _undrawnCount = reconciledDrawn.filter((g) => !g.isDrawn).length;
          const _undrawnBuckets =
            _undrawnCount > 0 ? balancedDistribute(_undrawnPool, _undrawnCount) : [];
          let _ubIdx = 0;
          const buckets: Team[][] = reconciledDrawn.map((g) => {
            if (g.isDrawn) {
              return g.slots.map((s) => s.team).filter((t): t is Team => t !== null);
            }
            return _undrawnBuckets[_ubIdx++] ?? [];
          });

          setTeamsByGroup(buckets);
          teamsByGroupRef.current = buckets;
          if (reconciledDrawn.length !== numBrackets) {
            setNumBrackets(reconciledDrawn.length);
          }
          if (didRefreshFromRoster) {
            dbSaveDrawnGroups(tournamentSlug, effectiveCategoryId, reconciledDrawn).catch(() => {});
            try {
              localStorage.setItem(
                `dv_drawn_groups_${tournamentSlug}_${effectiveCategoryId}`,
                JSON.stringify(reconciledDrawn),
              );
            } catch {
              // ignore
            }
          }
          // Ensure live matches are synced into match store
          syncDrawnBracketsToLiveMatches(tournamentSlug, effectiveCategoryId, reconciledDrawn);
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

  // Suggested divisors and presets based on total teams
  const suggestedCounts = useMemo(() => {
    const counts = new Set<number>();
    if (totalTeams > 0) {
      for (let c = 1; c <= 26; c++) {
        if (totalTeams % c === 0) counts.add(c);
      }
      for (const targetPerPool of [3, 4, 5, 6, 7]) {
        const c = Math.round(totalTeams / targetPerPool);
        if (c >= 1 && c <= 26) counts.add(c);
      }
    }
    [2, 3, 4, 6, 8, 9, 10, 12, 16].forEach((c) => {
      if (c <= 26) counts.add(c);
    });
    return Array.from(counts)
      .sort((a, b) => a - b)
      .map((c) => {
        const base = totalTeams > 0 ? Math.floor(totalTeams / c) : 0;
        const rem = totalTeams > 0 ? totalTeams % c : 0;
        const isEven = rem === 0;
        const label = totalTeams > 0 ? (isEven ? `${base} teams` : `${base}-${base + 1} teams`) : "Empty";
        return { count: c, label, isEven };
      });
  }, [totalTeams]);

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

  const handleSaveCategoryBracketCount = (count?: number) => {
    const finalCount = count ?? numBrackets;
    if (!tournamentSlug || !effectiveCategoryId) return;
    updateCategoryInTournament(tournamentSlug, effectiveCategoryId, {
      bracketCount: finalCount,
    });
    setBracketSaveNotice(
      `Saved: ${category?.label || "Category"} will use ${finalCount} ${finalCount === 1 ? "bracket" : "brackets"}.`
    );
    setTimeout(() => setBracketSaveNotice(null), 3500);
  };

  // ── Directly apply a new bracket count (reshapes or redistributes brackets) ──
  const handleApplyBracketCount = (newCount: number, options?: { makeDefault?: boolean }) => {
    if (isAnimating) return;
    const finalCount = Math.max(1, Math.min(26, newCount));
    const safeTeams = category?.teams || [];
    const currentDrawnCount = groupsRef.current.filter((g) => g.isDrawn).length;

    if (currentDrawnCount > 0) {
      const ok = window.confirm(
        `This category already has ${currentDrawnCount} drawn bracket(s). Changing to ${finalCount} brackets will reset the draw ceremony and redistribute all ${safeTeams.length} teams. Proceed?`
      );
      if (!ok) return;
    }

    // Abort any ongoing animation
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

    // Clear previous drawn groups across the system
    resetDrawnGroups(
      tournamentSlug,
      effectiveCategoryId,
      [categoryId, category?.id].filter(Boolean) as string[]
    );

    setNumBrackets(finalCount);
    setBracketInputVal(finalCount);

    if (safeTeams.length > 0) {
      const buckets = balancedDistribute(safeTeams, finalCount);
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

      skipEffectRef.current = true;
      saveDrawnGroups(tournamentSlug, effectiveCategoryId, initial, safeTeams, true);
    } else {
      setGroups([]);
      groupsRef.current = [];
      setTeamsByGroup([]);
      teamsByGroupRef.current = [];
    }

    if (options?.makeDefault) {
      updateCategoryInTournament(tournamentSlug, effectiveCategoryId, {
        bracketCount: finalCount,
      });
    }

    const endLetter = LETTERS[finalCount - 1] ?? String(finalCount);
    setBracketSaveNotice(
      `Bracket count set to ${finalCount} (${finalCount === 1 ? "Pool A" : `Pools A to ${endLetter}`})${options?.makeDefault ? " and saved as category default" : ""}.`
    );
    setTimeout(() => setBracketSaveNotice(null), 3500);
  };

  const handleAddSingleBracket = () => {
    if (isAnimating) return;
    if (groups.length >= 26) return;
    const newCount = groups.length + 1;
    const newLetter = LETTERS[groups.length] ?? String(newCount);
    const currentDrawnCount = groups.filter((g) => g.isDrawn).length;

    if (currentDrawnCount === 0) {
      handleApplyBracketCount(newCount);
      return;
    }

    // Preserve existing drawn brackets and append an empty one
    const newGroup: BracketGroup = {
      name: `Bracket ${newLetter}`,
      letter: newLetter,
      slots: [],
      revealed: false,
      isDrawn: false,
    };
    const nextGroups = [...groups, newGroup];
    setGroups(nextGroups);
    groupsRef.current = nextGroups;
    setNumBrackets(nextGroups.length);
    setBracketInputVal(nextGroups.length);

    const nextBuckets = nextGroups.map((g) =>
      g.slots.map((s) => s.team).filter((t): t is Team => t !== null)
    );
    setTeamsByGroup(nextBuckets);
    teamsByGroupRef.current = nextBuckets;

    const safeTeams = category?.teams || [];
    const fullRoster = safeTeams.length > 0 ? safeTeams : nextBuckets.flat();
    skipEffectRef.current = true;
    saveDrawnGroups(tournamentSlug, effectiveCategoryId, nextGroups, fullRoster, false);

    setBracketSaveNotice(`Added Bracket ${newLetter}. You can now drag or assign teams into it.`);
    setTimeout(() => setBracketSaveNotice(null), 3500);
  };

  const handleRemoveSingleBracket = () => {
    if (isAnimating) return;
    if (groups.length <= 1) return;
    const lastGroup = groups[groups.length - 1];
    if (!lastGroup) return;

    const lastHasTeams = lastGroup.slots.some((s) => s.team !== null);
    if (lastHasTeams) {
      const ok = window.confirm(
        `Bracket ${lastGroup.letter} has ${lastGroup.slots.filter((s) => s.team !== null).length} assigned team(s). Removing it will return those teams to the pool or redistribute. Continue?`
      );
      if (!ok) return;
    }

    const newCount = groups.length - 1;
    const currentDrawnCount = groups.filter((g) => g.isDrawn).length;

    if (currentDrawnCount === 0 || lastHasTeams) {
      handleApplyBracketCount(newCount);
      return;
    }

    const nextGroups = groups.slice(0, -1);
    setGroups(nextGroups);
    groupsRef.current = nextGroups;
    setNumBrackets(nextGroups.length);
    setBracketInputVal(nextGroups.length);

    const nextBuckets = nextGroups.map((g) =>
      g.slots.map((s) => s.team).filter((t): t is Team => t !== null)
    );
    setTeamsByGroup(nextBuckets);
    teamsByGroupRef.current = nextBuckets;

    const safeTeams = category?.teams || [];
    const fullRoster = safeTeams.length > 0 ? safeTeams : nextBuckets.flat();
    skipEffectRef.current = true;
    saveDrawnGroups(tournamentSlug, effectiveCategoryId, nextGroups, fullRoster, false);

    setBracketSaveNotice(`Removed Bracket ${lastGroup.letter}. Total brackets: ${nextGroups.length}.`);
    setTimeout(() => setBracketSaveNotice(null), 3500);
  };

  const handleResetToAutoBrackets = () => {
    if (!tournamentSlug || !effectiveCategoryId) return;
    const autoCount = getBracketsForCapacity(maxCapacity);
    updateCategoryInTournament(tournamentSlug, effectiveCategoryId, {
      bracketCount: undefined,
    });
    setNumBrackets(autoCount);
    setBracketInputVal(autoCount);
    setBracketSaveNotice(
      `Reset: ${category?.label || "Category"} bracket count set to Auto (${autoCount} brackets).`
    );
    setTimeout(() => setBracketSaveNotice(null), 3500);
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

    const n = Math.max(1, Math.min(numBrackets, 26));

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

  const formatSlotTeamLabel = (team?: Team | null) => {
    if (!team) return "Empty Slot";
    const playersLabel = (team.players || []).filter(Boolean).join(" & ");
    if (isGenericTeamName(team.name) && playersLabel) {
      return playersLabel;
    }
    return team.name || playersLabel || "Team";
  };

  // ── Edit Players / Team Modal Handlers ────────────────────────────────────
  const openEditSlotModal = (groupIdx: number, slotIdx: number) => {
    if (isAnimating) return;
    const slot = groupsRef.current[groupIdx]?.slots[slotIdx];
    if (!slot?.team) return;
    const [p1 = "", p2 = ""] = slot.team.players || [];
    setEditingSlot({
      groupIndex: groupIdx,
      slotIndex: slotIdx,
      teamName: slot.team.name || "",
      player1: p1,
      player2: p2,
    });
  };

  const handleSaveEditedSlot = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!editingSlot) return;

    const { groupIndex, slotIndex, teamName, player1, player2 } = editingSlot;
    const currentGroups = groupsRef.current;
    const targetGroup = currentGroups[groupIndex];
    const targetSlot = targetGroup?.slots[slotIndex];
    if (!targetGroup || !targetSlot?.team) {
      setEditingSlot(null);
      return;
    }

    const nextPlayers = [player1.trim(), player2.trim()].filter(Boolean);
    const nextName = teamName.trim() || nextPlayers.join(" / ") || targetSlot.team.name;
    if (!nextName && nextPlayers.length === 0) {
      return;
    }

    const prevGroupsSnapshot = JSON.parse(JSON.stringify(currentGroups)) as BracketGroup[];
    const prevTeam = targetSlot.team;
    const updatedTeam: Team = {
      ...prevTeam,
      name: nextName,
      players: nextPlayers.length > 0 ? nextPlayers : prevTeam.players,
    };

    const nextGroups = currentGroups.map((g, gi) => ({
      ...g,
      slots: g.slots.map((s, si) =>
        gi === groupIndex && si === slotIndex ? { ...s, team: updatedTeam } : { ...s }
      ),
    }));

    setGroups(nextGroups);
    groupsRef.current = nextGroups;

    const nextBuckets = nextGroups.map((g) =>
      g.slots.map((s) => s.team).filter((t): t is Team => t !== null)
    );
    setTeamsByGroup(nextBuckets);
    teamsByGroupRef.current = nextBuckets;

    // Update category.teams in tournament store
    const targetCatId = category?.id || effectiveCategoryId;
    updateTeamInTournament(tournamentSlug, targetCatId, updatedTeam.id, {
      name: updatedTeam.name,
      players: updatedTeam.players,
    });

    // Update any queued dispatch items referencing this team
    try {
      const q = getDispatchQueue();
      let queueModified = false;
      const prevPlayersNorm = (prevTeam.players || []).map((p) => p.trim().toLowerCase()).filter(Boolean).sort().join("|");
      const nextQ = q.map((item) => {
        const isCat =
          (!item.tournamentSlug || item.tournamentSlug === tournamentSlug) &&
          (!item.categoryId || isSameCategory(item.categoryId, effectiveCategoryId));
        if (!isCat) return item;

        const idHasTeam = Boolean(updatedTeam.id && item.matchId.includes(updatedTeam.id));
        const itemANorm = (item.teamAPlayers || []).map((p) => p.trim().toLowerCase()).filter(Boolean).sort().join("|");
        const itemBNorm = (item.teamBPlayers || []).map((p) => p.trim().toLowerCase()).filter(Boolean).sort().join("|");

        const matchesA =
          (prevPlayersNorm && itemANorm === prevPlayersNorm) ||
          (idHasTeam && !prevPlayersNorm && item.teamAName.trim().toLowerCase() === prevTeam.name.trim().toLowerCase());
        const matchesB =
          (prevPlayersNorm && itemBNorm === prevPlayersNorm) ||
          (idHasTeam && !prevPlayersNorm && item.teamBName.trim().toLowerCase() === prevTeam.name.trim().toLowerCase());

        if (matchesA) {
          queueModified = true;
          return {
            ...item,
            teamAName: updatedTeam.name,
            teamAPlayers: updatedTeam.players,
          };
        }
        if (matchesB) {
          queueModified = true;
          return {
            ...item,
            teamBName: updatedTeam.name,
            teamBPlayers: updatedTeam.players,
          };
        }
        return item;
      });
      if (queueModified) {
        saveDispatchQueue(nextQ);
      }
    } catch {
      // ignore
    }

    const safeTeams = (category?.teams || []).map((t) =>
      t.id === updatedTeam.id ? updatedTeam : t
    );
    const fullRoster = safeTeams.length > 0 ? safeTeams : nextBuckets.flat();
    skipEffectRef.current = true;
    saveDrawnGroups(tournamentSlug, effectiveCategoryId, nextGroups, fullRoster, false);

    setSwapNotice({
      message: `Updated players for ${formatSlotTeamLabel(updatedTeam)} (Bracket ${targetGroup.letter}, Slot ${slotIndex + 1})`,
      previousGroups: prevGroupsSnapshot,
    });
    setEditingSlot(null);
    setSelectedSlot(null);
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
    const nextDrawnCount = nextGroups.filter((g) => g.isDrawn).length;
    setGroups(nextGroups);
    groupsRef.current = nextGroups;
    setDrawnCount(nextDrawnCount);
    drawnCountRef.current = nextDrawnCount;

    // Update teamsByGroup buckets
    const nextBuckets = nextGroups.map((g) =>
      g.slots.map((s) => s.team).filter((t): t is Team => t !== null)
    );
    setTeamsByGroup(nextBuckets);
    teamsByGroupRef.current = nextBuckets;

    // Comprehensive sync to Supabase, localStorage, DispatchQueue, and MatchStore
    const safeTeams = category?.teams || [];
    const fullRoster = safeTeams.length > 0 ? safeTeams : nextBuckets.flat();
    skipEffectRef.current = true;
    saveDrawnGroups(tournamentSlug, effectiveCategoryId, nextGroups, fullRoster, false);

    const sourceLabel = formatSlotTeamLabel(sourceTeam);
    const targetLabel = formatSlotTeamLabel(targetTeam);
    setSwapNotice({
      message: `Swapped ${sourceLabel} (Bracket ${sourceGroup.letter}) and ${targetLabel} (Bracket ${targetGroup.letter})`,
      previousGroups: prevGroupsSnapshot,
    });

    setSelectedSlot(null);
    setDraggedSlot(null);
  };

  // ── Drag & Tap Move Handler (Resizes Brackets, e.g. 5 -> 4 and 4 -> 5) ───
  const handleMoveSlotToBracket = (
    fromGroupIdx: number,
    fromSlotIdx: number,
    toGroupIdx: number
  ) => {
    if (isAnimating) return;
    if (fromGroupIdx === toGroupIdx) {
      setSelectedSlot(null);
      setDraggedSlot(null);
      return;
    }

    const currentGroups = groupsRef.current;
    const sourceGroup = currentGroups[fromGroupIdx];
    const targetGroup = currentGroups[toGroupIdx];
    if (!sourceGroup || !targetGroup) return;

    const sourceSlot = sourceGroup.slots[fromSlotIdx];
    if (!sourceSlot || !sourceSlot.team) {
      setSelectedSlot(null);
      setDraggedSlot(null);
      return;
    }

    const movedTeam = sourceSlot.team;
    const prevGroupsSnapshot = JSON.parse(JSON.stringify(currentGroups)) as BracketGroup[];

    const nextGroups = currentGroups.map((g) => ({
      ...g,
      slots: g.slots.map((s) => ({ ...s })),
    }));

    // Remove slot from source bracket so its slot count shrinks by 1
    nextGroups[fromGroupIdx]!.slots.splice(fromSlotIdx, 1);

    // Add to target bracket: fill an empty slot if already drawn with a vacancy, otherwise append a new slot
    const targetNext = nextGroups[toGroupIdx]!;
    const emptyIdxInDrawn = targetNext.isDrawn
      ? targetNext.slots.findIndex((s) => s.team === null)
      : -1;

    if (emptyIdxInDrawn !== -1) {
      targetNext.slots[emptyIdxInDrawn] = { team: movedTeam, revealed: true };
    } else {
      targetNext.slots.push({ team: movedTeam, revealed: true });
      if (targetNext.slots.every((s) => s.team !== null && s.revealed)) {
        targetNext.isDrawn = true;
        targetNext.revealed = true;
      }
    }

    const nextDrawnCount = nextGroups.filter((g) => g.isDrawn).length;
    setGroups(nextGroups);
    groupsRef.current = nextGroups;
    setDrawnCount(nextDrawnCount);
    drawnCountRef.current = nextDrawnCount;

    const nextBuckets = nextGroups.map((g) =>
      g.slots.map((s) => s.team).filter((t): t is Team => t !== null)
    );
    setTeamsByGroup(nextBuckets);
    teamsByGroupRef.current = nextBuckets;

    const safeTeams = category?.teams || [];
    const fullRoster = safeTeams.length > 0 ? safeTeams : nextBuckets.flat();
    skipEffectRef.current = true;
    saveDrawnGroups(tournamentSlug, effectiveCategoryId, nextGroups, fullRoster, false);

    const movedLabel = formatSlotTeamLabel(movedTeam);
    const newSourceCount = nextGroups[fromGroupIdx]!.slots.filter((s) => s.team !== null).length;
    const newTargetCount = nextGroups[toGroupIdx]!.slots.filter((s) => s.team !== null).length;

    setSwapNotice({
      message: `Moved ${movedLabel} from Bracket ${sourceGroup.letter} (${newSourceCount} teams) to Bracket ${targetGroup.letter} (${newTargetCount} teams)`,
      previousGroups: prevGroupsSnapshot,
    });

    setSelectedSlot(null);
    setDraggedSlot(null);
  };

  const handleUndoSwap = () => {
    if (!swapNotice) return;
    const restoredGroups = swapNotice.previousGroups;
    const nextDrawnCount = restoredGroups.filter((g) => g.isDrawn).length;
    setGroups(restoredGroups);
    groupsRef.current = restoredGroups;
    setDrawnCount(nextDrawnCount);
    drawnCountRef.current = nextDrawnCount;

    const nextBuckets = restoredGroups.map((g) =>
      g.slots.map((s) => s.team).filter((t): t is Team => t !== null)
    );
    setTeamsByGroup(nextBuckets);
    teamsByGroupRef.current = nextBuckets;

    const restoredById = new Map(
      restoredGroups
        .flatMap((g) => g.slots.map((s) => s.team))
        .filter((t): t is Team => t !== null)
        .map((t) => [t.id, t])
    );

    const safeTeams = (category?.teams || []).map((t) => restoredById.get(t.id) ?? t);
    const fullRoster = safeTeams.length > 0 ? safeTeams : nextBuckets.flat();
    skipEffectRef.current = true;
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

  const handlePopulate3Teams = () => {
    const prevTeams = [...(category?.teams || [])];
    setUndoRoster({
      action: "populate",
      teams: prevTeams,
      label: "Previous roster",
    });

    resetDrawnGroups(
      tournamentSlug,
      effectiveCategoryId,
      [categoryId, category?.id].filter(Boolean) as string[]
    );

    const generated = generateMockTeams(3, { verifiedOnly: true });
    bulkSetTeamsInCategory(tournamentSlug, categoryId, generated);

    const _buckets = [generated];
    const _initial: BracketGroup[] = [{
      name: "Bracket A",
      letter: "A",
      slots: generated.map(() => ({ team: null, revealed: false })),
      revealed: false,
      isDrawn: false,
    }];
    setTeamsByGroup(_buckets);
    teamsByGroupRef.current = _buckets;
    setGroups(_initial);
    groupsRef.current = _initial;
    setDrawnCount(0);
    drawnCountRef.current = 0;
    setSelectedSlot(null);
    setDraggedSlot(null);
    setSwapNotice(null);
    skipEffectRef.current = true;
    setNumBrackets(1);
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
            <div className="flex items-center justify-between flex-wrap gap-1">
              <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
                Pools / Brackets
              </span>
              <div className="flex items-center gap-1.5">
                {matchedCategory?.bracketCount ? (
                  <span className="text-[0.6rem] font-mono text-pickle font-bold bg-pickle/15 px-1.5 py-0.5 rounded border border-pickle/30">
                    Category Default: {matchedCategory.bracketCount} Brackets (Manual)
                  </span>
                ) : (
                  <span className="text-[0.6rem] font-mono text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded border border-border">
                    Category Default: Auto ({targetBrackets})
                  </span>
                )}
              </div>
            </div>

            {/* Direct Bracket Count Controls */}
            <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap">
              {/* Stepper Down */}
              <button
                type="button"
                onClick={() => handleApplyBracketCount(numBrackets - 1)}
                disabled={isAnimating || numBrackets <= 1}
                className="h-9 w-9 shrink-0 flex items-center justify-center font-bold text-base border border-border bg-card text-foreground hover:border-pickle hover:text-pickle disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors rounded"
                title="Decrease bracket count by 1"
              >
                -
              </button>

              {/* Direct Numeric Input */}
              <div className="relative shrink-0" title="Directly type bracket count (1 - 26) and press Enter">
                <input
                  type="number"
                  min="1"
                  max="26"
                  value={bracketInputVal}
                  disabled={isAnimating}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setBracketInputVal(isNaN(val) ? 1 : Math.max(1, Math.min(26, val)));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleApplyBracketCount(bracketInputVal);
                    }
                  }}
                  className="w-14 h-9 text-center font-mono font-bold text-sm sm:text-base border-2 border-pickle bg-background text-pickle focus:outline-none focus:ring-1 focus:ring-pickle rounded"
                />
              </div>

              {/* Stepper Up */}
              <button
                type="button"
                onClick={() => handleApplyBracketCount(numBrackets + 1)}
                disabled={isAnimating || numBrackets >= 26}
                className="h-9 w-9 shrink-0 flex items-center justify-center font-bold text-base border border-border bg-card text-foreground hover:border-pickle hover:text-pickle disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors rounded"
                title="Increase bracket count by 1"
              >
                +
              </button>

              {/* Dropdown with all numbers */}
              <select
                value={numBrackets}
                disabled={isAnimating}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) {
                    handleApplyBracketCount(val);
                  }
                }}
                className="h-9 flex-1 min-w-[130px] border border-input bg-background px-2.5 py-1 text-xs sm:text-sm font-semibold text-foreground focus:border-pickle focus:outline-none disabled:opacity-60 rounded"
              >
                {Array.from({ length: 16 }, (_, i) => i + 1).map((n) => {
                  const endLetter = LETTERS[n - 1] ?? String(n);
                  const poolText = n === 1 ? "Single Pool (Round Robin)" : `Pools A to ${endLetter}`;
                  return (
                    <option key={n} value={n}>
                      {n} {n === 1 ? "Bracket" : "Brackets"} ({poolText})
                    </option>
                  );
                })}
                {[18, 20, 24, 26].map((n) => (
                  <option key={n} value={n}>
                    {n} Brackets (Pools A to {LETTERS[n - 1] ?? n})
                  </option>
                ))}
              </select>

              {/* Apply button if typed value differs */}
              {bracketInputVal !== numBrackets && (
                <button
                  type="button"
                  onClick={() => handleApplyBracketCount(bracketInputVal)}
                  disabled={isAnimating}
                  className="h-9 shrink-0 px-3 text-xs font-bold uppercase tracking-wider rounded bg-pickle text-sand border border-pickle hover:bg-pickle/90 transition-all cursor-pointer whitespace-nowrap shadow-xs"
                  title="Apply the typed bracket count to drawing"
                >
                  Apply ({bracketInputVal})
                </button>
              )}

              {/* Direct Edit Calculator Button */}
              <button
                type="button"
                onClick={() => {
                  setBracketInputVal(numBrackets);
                  setIsEditBracketsModalOpen(true);
                }}
                disabled={isAnimating}
                className="h-9 shrink-0 px-2.5 text-xs font-bold uppercase tracking-wider rounded border border-border bg-charcoal text-sand hover:border-pickle hover:text-pickle transition-all cursor-pointer whitespace-nowrap shadow-xs"
                title="Open direct bracket count calculator and divisor presets"
              >
                Edit Brackets
              </button>

              <button
                type="button"
                onClick={() => handleSaveCategoryBracketCount(numBrackets)}
                disabled={isAnimating}
                className="h-9 shrink-0 px-2.5 text-xs font-bold uppercase tracking-wider rounded border border-pickle bg-pickle/15 text-pickle hover:bg-pickle hover:text-sand transition-all cursor-pointer whitespace-nowrap shadow-xs"
                title="Save this bracket count as the category's permanent setting"
              >
                Set for Category
              </button>

              {matchedCategory?.bracketCount && (
                <button
                  type="button"
                  onClick={handleResetToAutoBrackets}
                  disabled={isAnimating}
                  className="h-9 shrink-0 px-2 text-xs font-mono text-muted-foreground hover:text-foreground border border-border bg-card rounded transition-colors cursor-pointer whitespace-nowrap"
                  title="Reset category to automatic bracket count"
                >
                  Reset Auto
                </button>
              )}
            </div>

            {/* Distribution Helper Text */}
            <div className="flex items-center justify-between text-[0.68rem] text-muted-foreground pt-0.5">
              <span>
                Pools A to {LETTERS[numBrackets - 1] ?? numBrackets}:{" "}
                <strong className="text-foreground">
                  {teams.length > 0
                    ? `${teams.length} teams (${Math.floor(teams.length / numBrackets)}${teams.length % numBrackets > 0 ? `-${Math.ceil(teams.length / numBrackets)}` : ""} per pool)`
                    : "No teams in roster"}
                </strong>
              </span>
              <button
                type="button"
                onClick={() => {
                  setBracketInputVal(numBrackets);
                  setIsEditBracketsModalOpen(true);
                }}
                className="text-pickle font-bold hover:underline cursor-pointer ml-2"
              >
                Calculator &rarr;
              </button>
            </div>

            {/* Quick Presets / Factors */}
            {suggestedCounts.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                <span className="text-[0.6rem] uppercase tracking-wider text-muted-foreground font-bold">
                  Quick Divisors:
                </span>
                {suggestedCounts.slice(0, 7).map(({ count, label, isEven }) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => handleApplyBracketCount(count)}
                    disabled={isAnimating}
                    className={`px-2 py-0.5 rounded text-[0.65rem] font-mono font-bold border transition-colors cursor-pointer ${
                      count === numBrackets
                        ? "bg-pickle text-sand border-pickle shadow-xs"
                        : isEven
                          ? "bg-card text-foreground border-border hover:border-pickle hover:text-pickle"
                          : "bg-muted/30 text-muted-foreground border-border/70 hover:border-foreground"
                    }`}
                    title={`${count} Brackets (${label} each)`}
                  >
                    {count} Brackets{isEven ? ` (${label})` : ""}
                  </button>
                ))}
              </div>
            )}

            {bracketSaveNotice && (
              <div className="p-2 bg-pickle/20 border border-pickle rounded text-[0.72rem] text-pickle font-bold animate-in fade-in duration-200">
                {bracketSaveNotice}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 mt-1">
              {teams.length < maxCapacity && (
                <button
                  type="button"
                  onClick={handleQuickPopulate}
                  disabled={isAnimating}
                  className="text-[0.65rem] text-pickle hover:text-foreground font-semibold uppercase tracking-wider underline cursor-pointer"
                >
                  + Auto-Populate {maxCapacity} Teams ({numBrackets} Brackets)
                </button>
              )}
              <button
                type="button"
                onClick={handlePopulate3Teams}
                disabled={isAnimating}
                className="text-[0.65rem] text-sand/90 hover:text-pickle bg-charcoal border border-border px-2 py-0.5 rounded font-semibold uppercase tracking-wider cursor-pointer"
                title="Populate 3 pairs into a single pool to test 3-pair round robin"
              >
                + 3 Pairs (Round Robin Mode)
              </button>
            </div>
            {numBrackets === 1 && (
              <div className="mt-2 p-2 bg-pickle/15 border border-pickle/40 rounded text-[0.7rem] text-foreground font-medium">
                3-Pair Round Robin Mode: All 3 pairs play each other. Standings by point differential determine the Champion directly.
              </div>
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
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-[0.65rem] uppercase tracking-widest text-foreground font-bold">
              Ceremony Sequence ({drawnCount}/{groups.length} Drawn)
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleAddSingleBracket}
                disabled={isAnimating || groups.length >= 26}
                className="px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider border border-pickle/40 bg-pickle/15 text-pickle hover:bg-pickle hover:text-sand transition-colors cursor-pointer rounded"
                title="Add 1 more bracket to this ceremony"
              >
                + Add Bracket ({LETTERS[groups.length] ?? groups.length + 1})
              </button>
              {groups.length > 1 && (
                <button
                  type="button"
                  onClick={handleRemoveSingleBracket}
                  disabled={isAnimating}
                  className="px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider border border-border bg-card text-muted-foreground hover:text-brick hover:border-brick/50 transition-colors cursor-pointer rounded"
                  title="Remove the last bracket"
                >
                  - Remove Last ({LETTERS[groups.length - 1] ?? groups.length})
                </button>
              )}
              <span className="text-[0.65rem] font-mono text-pickle font-bold ml-1">
                {isAllDone ? "Ceremony Complete" : nextBracketLetter ? `Next: Bracket ${nextBracketLetter}` : ""}
              </span>
            </div>
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
              <span>Drag onto a slot to swap, or drag onto another bracket to move and resize</span>
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
          {/* Active selection banner for mobile / desktop click to swap or move */}
          {selectedSlot && (
            <div className="flex flex-col gap-3 bg-pickle/15 border-2 border-pickle px-4 py-3.5 rounded-xl text-xs sm:text-sm text-foreground shadow-sm animate-in fade-in duration-200">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="h-2 w-2 rounded-full bg-pickle animate-ping shrink-0" />
                  <span className="truncate">
                    Selected: <strong>{formatSlotTeamLabel(groups[selectedSlot.groupIndex]?.slots[selectedSlot.slotIndex]?.team)}</strong> (Bracket {groups[selectedSlot.groupIndex]?.letter}, Slot {selectedSlot.slotIndex + 1}) — Tap another slot to swap, or move directly to resize brackets:
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {groups[selectedSlot.groupIndex]?.slots[selectedSlot.slotIndex]?.team && (
                    <button
                      type="button"
                      onClick={() => openEditSlotModal(selectedSlot.groupIndex, selectedSlot.slotIndex)}
                      className="border border-pickle bg-card px-3 py-1.5 text-[0.7rem] font-bold uppercase tracking-wider text-pickle hover:bg-pickle hover:text-sand transition-colors rounded cursor-pointer shrink-0"
                    >
                      Edit Players
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedSlot(null)}
                    className="border border-border bg-charcoal px-3 py-1.5 text-[0.7rem] font-bold uppercase tracking-wider text-sand hover:border-pickle hover:text-pickle transition-colors rounded cursor-pointer shrink-0"
                  >
                    Cancel
                  </button>
                </div>
              </div>

              {/* Quick "Move to Bracket" buttons (changes bracket counts, e.g. 5 -> 4 and 4 -> 5) */}
              {groups.length > 1 && groups[selectedSlot.groupIndex]?.slots[selectedSlot.slotIndex]?.team && (
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-pickle/30">
                  <span className="text-[0.65rem] font-mono font-bold uppercase tracking-widest text-muted-foreground">
                    Move Pair Into:
                  </span>
                  {groups.map((targetGrp, tIdx) => {
                    if (tIdx === selectedSlot.groupIndex) return null;
                    const currentTeamsInTarget = targetGrp.slots.filter((s) => s.team !== null).length;
                    return (
                      <button
                        key={targetGrp.letter}
                        type="button"
                        onClick={() =>
                          handleMoveSlotToBracket(
                            selectedSlot.groupIndex,
                            selectedSlot.slotIndex,
                            tIdx
                          )
                        }
                        className="rounded border border-pickle bg-pickle px-3 py-1.5 text-[0.68rem] font-bold uppercase tracking-wider text-sand hover:opacity-90 transition-opacity cursor-pointer shadow-xs"
                      >
                        + Bracket {targetGrp.letter} ({currentTeamsInTarget} &rarr; {currentTeamsInTarget + 1} Teams)
                      </button>
                    );
                  })}
                </div>
              )}
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
                  Undo
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
                  onEditSlot={(groupIdx, slotIdx) => {
                    openEditSlotModal(groupIdx, slotIdx);
                  }}
                  draggedSlot={draggedSlot}
                  onDragStartSlot={(groupIdx, slotIdx) => {
                    requestAnimationFrame(() => {
                      setDraggedSlot({ groupIndex: groupIdx, slotIndex: slotIdx });
                    });
                  }}
                  onDragEndSlot={() => {
                    setDraggedSlot(null);
                  }}
                  onDropSlot={(groupIdx, slotIdx, fallbackSource) => {
                    const src = fallbackSource || draggedSlot;
                    if (src) {
                      handleSwapSlots(src.groupIndex, src.slotIndex, groupIdx, slotIdx);
                    }
                  }}
                  onMoveToBracket={(targetGroupIdx, fallbackSource) => {
                    const src = fallbackSource || draggedSlot || selectedSlot;
                    if (src) {
                      handleMoveSlotToBracket(src.groupIndex, src.slotIndex, targetGroupIdx);
                    }
                  }}
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

      {/* ── Edit Players / Team Modal ───────────────────────── */}
      {editingSlot && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
          onClick={() => setEditingSlot(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border-2 border-border bg-card shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-charcoal px-5 py-4 flex items-center justify-between border-b border-border">
              <div>
                <span className="block text-[0.62rem] font-bold uppercase tracking-[0.25em] text-pickle">
                  Bracket {groups[editingSlot.groupIndex]?.letter} • Slot {editingSlot.slotIndex + 1}
                </span>
                <h3 className="font-display text-2xl text-sand leading-tight mt-0.5">
                  Change Players / Team
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setEditingSlot(null)}
                className="rounded border border-sand/30 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider text-sand/80 hover:border-sand hover:text-sand cursor-pointer"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleSaveEditedSlot} className="p-5 space-y-4">
              <div className="space-y-1.5">
                <label className="block text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground">
                  Player 1 Full Name
                </label>
                <input
                  type="text"
                  value={editingSlot.player1}
                  onChange={(e) => setEditingSlot({ ...editingSlot, player1: e.target.value })}
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
                  value={editingSlot.player2}
                  onChange={(e) => setEditingSlot({ ...editingSlot, player2: e.target.value })}
                  placeholder="Enter Player 2 name (leave blank for singles)"
                  className="w-full rounded border border-input bg-background px-3 py-2.5 text-sm font-medium text-foreground focus:border-pickle focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground">
                  Team Name
                </label>
                <input
                  type="text"
                  value={editingSlot.teamName}
                  onChange={(e) => setEditingSlot({ ...editingSlot, teamName: e.target.value })}
                  placeholder="Team name (or n/a)"
                  className="w-full rounded border border-input bg-background px-3 py-2.5 text-sm font-medium text-foreground focus:border-pickle focus:outline-none"
                />
              </div>

              <div className="pt-2 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingSlot(null)}
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
            </form>
          </div>
        </div>
      )}

      {/* ── Direct Edit Bracket Count Modal ── */}
      {isEditBracketsModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
          onClick={() => setIsEditBracketsModalOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl border-2 border-border bg-card shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="bg-charcoal px-5 py-4 flex items-center justify-between border-b border-border">
              <div>
                <span className="block text-[0.62rem] font-bold uppercase tracking-[0.25em] text-pickle">
                  Bracket Configuration
                </span>
                <h3 className="font-display text-2xl text-sand leading-tight mt-0.5">
                  Directly Edit Bracket Count
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsEditBracketsModalOpen(false)}
                className="rounded border border-sand/30 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider text-sand/80 hover:border-sand hover:text-sand cursor-pointer"
              >
                Close
              </button>
            </div>

            <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto">
              {/* Category Info Header */}
              <div className="surface-card p-3 rounded border border-border flex items-center justify-between">
                <div>
                  <span className="block text-xs font-bold text-foreground">
                    {category?.label || "Category"}
                  </span>
                  <span className="text-[0.68rem] text-muted-foreground">
                    Total Roster: {totalTeams} teams
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground block">
                    Current Brackets
                  </span>
                  <span className="font-mono text-sm font-bold text-pickle">
                    {groups.length} ({groups.length === 1 ? "Pool A" : `Pools A to ${LETTERS[groups.length - 1] ?? groups.length}`})
                  </span>
                </div>
              </div>

              {/* Stepper & Number Input */}
              <div className="space-y-2">
                <label className="block text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground">
                  Number of Brackets (Pools A to {LETTERS[bracketInputVal - 1] ?? bracketInputVal})
                </label>
                <div className="flex items-center justify-center gap-3 py-2">
                  <button
                    type="button"
                    onClick={() => setBracketInputVal((prev) => Math.max(1, prev - 1))}
                    disabled={bracketInputVal <= 1}
                    className="h-11 w-11 rounded-lg border-2 border-border bg-charcoal text-sand text-xl font-bold flex items-center justify-center hover:border-pickle hover:text-pickle disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                    title="Decrease by 1"
                  >
                    -
                  </button>

                  <div className="text-center">
                    <input
                      type="number"
                      min={1}
                      max={26}
                      value={bracketInputVal}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        setBracketInputVal(isNaN(val) ? 1 : Math.max(1, Math.min(26, val)));
                      }}
                      className="w-24 h-12 text-center font-display text-3xl font-bold text-foreground border-2 border-pickle bg-background rounded-lg focus:outline-none focus:ring-2 focus:ring-pickle"
                    />
                    <span className="block text-[0.65rem] font-mono text-muted-foreground mt-1">
                      Pools A through {LETTERS[bracketInputVal - 1] ?? bracketInputVal}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => setBracketInputVal((prev) => Math.max(1, Math.min(26, prev + 1)))}
                    disabled={bracketInputVal >= 26}
                    className="h-11 w-11 rounded-lg border-2 border-border bg-charcoal text-sand text-xl font-bold flex items-center justify-center hover:border-pickle hover:text-pickle disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                    title="Increase by 1"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Real-time Allocation Breakdown */}
              <div className="p-3.5 bg-card/60 rounded-lg border border-border space-y-1.5 text-xs">
                <div className="flex items-center justify-between font-medium">
                  <span className="text-muted-foreground">Distribution for {totalTeams} teams:</span>
                  <span className="font-bold text-foreground">
                    {totalTeams > 0
                      ? totalTeams % bracketInputVal === 0
                        ? `${Math.floor(totalTeams / bracketInputVal)} teams per bracket (Perfect Balance)`
                        : `${totalTeams % bracketInputVal} brackets of ${Math.ceil(totalTeams / bracketInputVal)} teams, ${bracketInputVal - (totalTeams % bracketInputVal)} brackets of ${Math.floor(totalTeams / bracketInputVal)} teams`
                      : "No teams in roster"}
                  </span>
                </div>
                <p className="text-[0.68rem] text-muted-foreground leading-relaxed">
                  Teams are randomly shuffled and seeded with balanced distribution across Bracket A through Bracket {LETTERS[bracketInputVal - 1] ?? bracketInputVal}.
                </p>
              </div>

              {/* Quick Divisors / Factors */}
              {suggestedCounts.length > 0 && (
                <div className="space-y-2">
                  <span className="block text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground">
                    Recommended Presets for {totalTeams} Teams
                  </span>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {suggestedCounts.slice(0, 9).map(({ count, label, isEven }) => (
                      <button
                        key={count}
                        type="button"
                        onClick={() => setBracketInputVal(count)}
                        className={`p-2 rounded border text-left transition-all cursor-pointer ${
                          bracketInputVal === count
                            ? "border-pickle bg-pickle/20 ring-1 ring-pickle"
                            : "border-border bg-card hover:border-pickle/60"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-xs text-foreground">
                            {count} {count === 1 ? "Bracket" : "Brackets"}
                          </span>
                          {isEven && (
                            <span className="text-[0.55rem] font-bold uppercase bg-pickle/20 text-pickle px-1 py-0.2 rounded">
                              Even
                            </span>
                          )}
                        </div>
                        <span className="text-[0.65rem] text-muted-foreground block font-mono">
                          {label} each
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Save as Category Default Option */}
              <label className="flex items-start gap-2.5 p-3 rounded border border-border bg-card/40 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={modalMakeDefault}
                  onChange={(e) => setModalMakeDefault(e.target.checked)}
                  className="mt-0.5 accent-pickle cursor-pointer"
                />
                <div className="text-xs">
                  <span className="font-bold text-foreground block">
                    Save as permanent default for {category?.label || "this category"}
                  </span>
                  <span className="text-[0.68rem] text-muted-foreground">
                    Future draws and resets for this division will automatically use {bracketInputVal} brackets.
                  </span>
                </div>
              </label>

              {/* Warning if already drawn */}
              {groups.some((g) => g.isDrawn) && (
                <div className="p-3 bg-brick/15 border border-brick/40 rounded text-xs text-brick">
                  <strong>Notice:</strong> Brackets have already been drawn. Applying a new bracket count will reset the ceremony and redistribute all teams into the new brackets.
                </div>
              )}

              {/* Action Buttons */}
              <div className="pt-2 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsEditBracketsModalOpen(false)}
                  className="w-full sm:w-auto border border-border bg-charcoal px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors rounded cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleApplyBracketCount(bracketInputVal, { makeDefault: modalMakeDefault });
                    setIsEditBracketsModalOpen(false);
                  }}
                  className="w-full sm:w-auto bg-pickle px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-sand hover:opacity-90 transition-opacity rounded shadow cursor-pointer"
                >
                  Apply {bracketInputVal} Brackets
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── BracketCard ────────────────────────────────────────────────────────────
function parseDragData(e: React.DragEvent): { groupIndex: number; slotIndex: number } | null {
  try {
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw) return null;
    const [gStr, sStr] = raw.split(",");
    const g = Number(gStr);
    const s = Number(sStr);
    if (Number.isInteger(g) && Number.isInteger(s) && g >= 0 && s >= 0) {
      return { groupIndex: g, slotIndex: s };
    }
  } catch {
    // ignore
  }
  return null;
}

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
  onEditSlot,
  draggedSlot,
  onDragStartSlot,
  onDragEndSlot,
  onDropSlot,
  onMoveToBracket,
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
  onEditSlot: (groupIndex: number, slotIndex: number) => void;
  draggedSlot: { groupIndex: number; slotIndex: number } | null;
  onDragStartSlot: (groupIndex: number, slotIndex: number) => void;
  onDragEndSlot: () => void;
  onDropSlot: (
    groupIndex: number,
    slotIndex: number,
    fallbackSource?: { groupIndex: number; slotIndex: number } | null
  ) => void;
  onMoveToBracket: (
    targetGroupIndex: number,
    fallbackSource?: { groupIndex: number; slotIndex: number } | null
  ) => void;
}) {
  const [isMoveDropOver, setIsMoveDropOver] = useState(false);
  const revealedCount = group.slots.filter((s) => s.revealed).length;
  const totalSlots = group.slots.length;
  const filledTeamsCount = group.slots.filter((s) => s.team !== null).length;

  const isDraggingFromOtherBracket = Boolean(
    !isAnimating && draggedSlot && draggedSlot.groupIndex !== index
  );
  const isSelectedFromOtherBracket = Boolean(
    !isAnimating && selectedSlot && selectedSlot.groupIndex !== index
  );
  const canReceiveBracketMove = isDraggingFromOtherBracket || isSelectedFromOtherBracket;

  return (
    <div
      className={`flex flex-col overflow-hidden border-2 transition-all duration-300 rounded-xl shadow-xs ${
        isMoveDropOver
          ? "border-pickle ring-2 ring-pickle shadow-lg shadow-pickle/20"
          : isActive
            ? "border-pickle shadow-xl shadow-pickle/20 scale-[1.02] ring-2 ring-pickle"
            : isDrawn
              ? "border-pickle/50 bg-card"
              : isNext
                ? "border-brick/80 shadow-md shadow-brick/10 scale-[1.01]"
                : "border-border/80 opacity-70 hover:opacity-100"
      }`}
    >
      {/* ── Card Header (also accepts drop to move pair into this bracket) ── */}
      <div
        onDragOver={(e) => {
          if (isAnimating) return;
          if (!draggedSlot || draggedSlot.groupIndex !== index) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!isMoveDropOver) setIsMoveDropOver(true);
          }
        }}
        onDragLeave={() => {
          if (isMoveDropOver) setIsMoveDropOver(false);
        }}
        onDrop={(e) => {
          if (isAnimating) return;
          e.preventDefault();
          e.stopPropagation();
          setIsMoveDropOver(false);
          const fallback = parseDragData(e);
          if ((draggedSlot && draggedSlot.groupIndex !== index) || (fallback && fallback.groupIndex !== index)) {
            onMoveToBracket(index, fallback);
          }
        }}
        className={`relative flex items-center justify-between overflow-hidden px-5 py-4 transition-colors duration-400 ${isActive
            ? "bg-pickle text-sand"
            : isMoveDropOver
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
                onSelect={() => onSelectSlot(index, ti)}
                onEdit={() => onEditSlot(index, ti)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", `${index},${ti}`);
                  onDragStartSlot(index, ti);
                }}
                onDragEnd={onDragEndSlot}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const fallback = parseDragData(e);
                  onDropSlot(index, ti, fallback);
                }}
              />
            );
          })
        )}

        {/* ── Drop / Tap Zone to ADD pair into this bracket (resizes bracket, e.g. 4 -> 5) ── */}
        {canReceiveBracketMove && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (isSelectedFromOtherBracket) {
                onMoveToBracket(index, selectedSlot);
              }
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && isSelectedFromOtherBracket) {
                e.preventDefault();
                onMoveToBracket(index, selectedSlot);
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
              if (!isMoveDropOver) setIsMoveDropOver(true);
            }}
            onDragLeave={() => {
              if (isMoveDropOver) setIsMoveDropOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsMoveDropOver(false);
              const fallback = parseDragData(e);
              onMoveToBracket(index, fallback);
            }}
            className={`flex-1 min-h-[54px] m-2 rounded-lg border-2 border-dashed px-4 py-3 flex items-center justify-between gap-2 transition-all cursor-pointer select-none ${
              isMoveDropOver
                ? "border-pickle bg-pickle/25 text-pickle shadow-inner scale-[0.99]"
                : "border-pickle/60 bg-pickle/10 text-pickle hover:bg-pickle/20 hover:border-pickle"
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="font-display text-lg leading-none text-pickle">
                {totalSlots + 1}
              </span>
              <span className="text-xs font-bold uppercase tracking-wider truncate">
                {isDraggingFromOtherBracket
                  ? `+ Drop here to move into Bracket ${group.letter}`
                  : `+ Tap to move into Bracket ${group.letter}`}
              </span>
            </div>
            <span className="shrink-0 rounded bg-pickle px-2 py-0.5 font-mono text-[0.62rem] font-bold uppercase tracking-wider text-sand">
              {filledTeamsCount} &rarr; {filledTeamsCount + 1} Teams
            </span>
          </div>
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
  onSelect,
  onEdit,
  onDragStart,
  onDragEnd,
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
  onSelect: () => void;
  onEdit: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [isSlotDragOver, setIsSlotDragOver] = useState(false);
  const hasTeam = Boolean(slot.team);
  const canInteract = !isAnimating && (hasTeam || isOtherSelected);
  const canDrag = !isAnimating && hasTeam && slot.revealed;
  const isGenericName = slot.team ? isGenericTeamName(slot.team.name) : false;
  const playersLine = slot.team?.players?.filter(Boolean).join(" & ") || "";

  return (
    <div
      draggable={canDrag}
      onDragStart={canDrag ? onDragStart : undefined}
      onDragEnd={canDrag ? onDragEnd : undefined}
      onDragOver={
        !isAnimating
          ? (e) => {
              onDragOver(e);
              if (!isSlotDragOver) setIsSlotDragOver(true);
            }
          : undefined
      }
      onDragLeave={() => {
        if (isSlotDragOver) setIsSlotDragOver(false);
      }}
      onDrop={
        !isAnimating
          ? (e) => {
              setIsSlotDragOver(false);
              onDrop(e);
            }
          : undefined
      }
      onClick={() => {
        if (!canInteract) return;
        onSelect();
      }}
      className={`group relative flex items-center gap-3 px-4 py-3 transition-all duration-200 select-none ${
        slot.revealed
          ? "opacity-100 translate-y-0"
          : "opacity-35 translate-y-1"
      } ${
        isSlotDragOver
          ? "bg-pickle/20 border-l-4 border-l-pickle ring-2 ring-pickle/70"
          : isSelected
            ? "bg-pickle/20 border-l-4 border-l-pickle ring-2 ring-pickle/80 shadow-md"
            : isOtherSelected
              ? "cursor-pointer hover:bg-pickle/15 hover:border-l-4 hover:border-l-pickle/60 active:scale-[0.99]"
              : canDrag
                ? "cursor-grab hover:bg-muted/40 active:cursor-grabbing"
                : ""
      } ${
        slot.revealed && isGroupActive
          ? "bg-pickle/10 border-l-2 border-l-pickle"
          : slot.revealed && !isSelected && !isSlotDragOver
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
            <div className="flex items-center justify-between gap-1.5">
              <span className="block font-semibold text-foreground truncate text-xs sm:text-sm">
                {isGenericName && playersLine ? playersLine : slot.team.name}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                {isSelected ? (
                  <span className="text-[0.6rem] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-pickle text-sand shrink-0 shadow-xs">
                    Selected
                  </span>
                ) : isOtherSelected ? (
                  <span className="text-[0.6rem] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-pickle/20 text-pickle border border-pickle/40 shrink-0 hidden sm:inline-block">
                    Tap to Swap
                  </span>
                ) : null}
                {!isAnimating && !isOtherSelected && (
                  <button
                    type="button"
                    title="Change players or team name"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit();
                    }}
                    className="rounded border border-border bg-card px-1.5 py-0.5 text-[0.58rem] font-bold uppercase tracking-wider text-muted-foreground hover:border-pickle hover:text-pickle transition-colors cursor-pointer shrink-0"
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-[0.65rem] text-foreground/80 font-medium truncate mt-0.5">
              {!isGenericName && playersLine ? (
                <span className="truncate">{playersLine}</span>
              ) : isGenericName ? (
                <span className="truncate text-muted-foreground">Team: {slot.team.name}</span>
              ) : null}
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
