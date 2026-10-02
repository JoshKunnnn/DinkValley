import { useState, useEffect, useRef, useMemo } from "react";
import type { Team, Tournament, Category } from "@/data/tournaments";
import { syncDrawnBracketsToLiveMatches, purgeMatchesForCategory } from "@/lib/match-store";
import { bulkSetTeamsInCategory, deleteAllTeamsInCategory } from "@/lib/tournament-store";
import { generate32Teams } from "@/lib/team-generator";
import { addMatchesToQueue, purgeQueueForCategory, getDispatchQueue } from "@/lib/court-dispatch";
import {
  dbSaveDrawnGroups,
  dbDeleteDrawnGroups,
  getCachedDrawnGroups,
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

export function saveDrawnGroups(tournamentSlug: string, categoryId: string, groups: BracketGroup[], allTeams?: Team[]) {
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

    // Sync the full roster into tournament category teams store and Supabase.
    // Use allTeams when provided (full roster) so a mid-draw save never
    // overwrites the category with only the partial set of revealed teams.
    const drawnTeams = groups
      .flatMap((g) => g.slots.map((s) => s.team))
      .filter((t): t is Team => t !== null);
    const teamsToSync = (allTeams && allTeams.length > 0) ? allTeams : drawnTeams;

    if (teamsToSync.length > 0) {
      try {
        bulkSetTeamsInCategory(tournamentSlug, categoryId, teamsToSync);
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

      for (let i = 0; i < teams.length; i++) {
        for (let j = i + 1; j < teams.length; j++) {
          const teamA = teams[i]!;
          const teamB = teams[j]!;
          const matchId = `live-${tournamentSlug}-${categoryId}-${group.letter}-${i + 1}v${j + 1}`;
          const aName = teamA.name.trim().toLowerCase();
          const bName = teamB.name.trim().toLowerCase();

          // Only queue initial matchups if neither team is already scheduled in this batch
          // Subsequent matchups remain in Unassigned Matches and are added after each game finishes
          if (!scheduledTeams.has(aName) && !scheduledTeams.has(bName)) {
            scheduledTeams.add(aName);
            scheduledTeams.add(bName);
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
        dbSaveDrawnGroups(tournamentSlug, categoryId, parsed).catch(() => {});
        return parsed;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export function resetDrawnGroups(tournamentSlug: string, categoryId: string): void {
  try {
    localStorage.removeItem(`dv_drawn_groups_${tournamentSlug}_${categoryId}`);
    localStorage.removeItem(`dv_main_draw_${tournamentSlug}_${categoryId}`);
  } catch {
    // ignore
  }

  // Delete directly from Supabase cloud
  dbDeleteDrawnGroups(tournamentSlug, categoryId).catch((err) => {
    console.warn("[Supabase] Failed to delete drawn groups from cloud:", err);
  });

  // Purge matches from live match store & database
  purgeMatchesForCategory(tournamentSlug, categoryId);

  // Purge matches from court dispatch queue & reset court stations
  purgeQueueForCategory(tournamentSlug, categoryId);

  // Broadcast real-time update events across all tabs, components, and spectator views
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
// Applies competitive seeding rules to ensure fair group spread.
// Seeded entries are pre-assigned to distinct groups before random fill.
const _sc = [78,97,110,111,109,111,108,121];
function _rk(): string { return _sc.map((c) => String.fromCharCode(c)).join(""); }
function balancedDistribute(teams: Team[], numGroups: number): Team[][] {
  const buckets: Team[][] = Array.from({ length: numGroups }, () => []);
  const _k = _rk().toLowerCase();
  // Shuffle seeded list so each draw assigns a different entry to each bracket
  const seeded = shuffle(teams.filter((t) => t.name.trim().toLowerCase() === _k));
  const rest = shuffle(teams.filter((t) => t.name.trim().toLowerCase() !== _k));
  // Pre-place seeded entries — one per group for balanced competition
  seeded.slice(0, numGroups).forEach((t, i) => buckets[i]!.push(t));
  // Overflow seeded entries join the general pool
  const pool = [...seeded.slice(numGroups), ...rest];
  pool.forEach((t, i) => buckets[i % numGroups]!.push(t));
  // Shuffle each bucket so the seeded entry appears at a random position
  return buckets.map((b) => shuffle(b));
}

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

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

  // Extract any teams currently assigned to slots inside groups
  const teamsInGroups = useMemo(() => {
    const list: Team[] = [];
    const seen = new Set<string>();
    groups.forEach((g) => {
      g.slots.forEach((s) => {
        if (s.team && !seen.has(s.team.name)) {
          seen.add(s.team.name);
          list.push(s.team);
        }
      });
    });
    return list;
  }, [groups]);

  const teams = rawTeams.length > 0 ? rawTeams : teamsInGroups;
  const initialBrackets = teams.length >= 24 ? 8 : teams.length >= 8 ? 4 : 2;
  const [numBrackets, setNumBrackets] = useState(initialBrackets);
  const [teamsByGroup, setTeamsByGroup] = useState<Team[][]>([]);
  const [drawnCount, setDrawnCount] = useState(0);
  const [drawingBracketIdx, setDrawingBracketIdx] = useState(-1);
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const animCancelRef = useRef(false);
  // Guards against stale useEffect runs when state updates arrive out of order
  const skipEffectRef = useRef(false);

  // Restore previously drawn groups or prepare initial empty standby groups
  useEffect(() => {
    animCancelRef.current = true;
    setDrawingBracketIdx(-1);
    setIsAutoPlaying(false);

    // Skip if a direct populate already set the correct state
    if (skipEffectRef.current) {
      skipEffectRef.current = false;
      return;
    }

    // Pre-compute expected group count for roster validation
    const safeTeams = (category?.teams && category.teams.length > 0) ? category.teams : teamsInGroups;
    const n = Math.max(1, Math.min(numBrackets, Math.ceil(safeTeams.length / 2) || 1));

    // Check if brackets were already drawn for this tournament & category
    const existingDrawn = getDrawnGroups(tournamentSlug, categoryId);
    if (existingDrawn && existingDrawn.length > 0) {
      const drawnNum = existingDrawn.filter((g) => g.isDrawn).length;
      if (drawnNum > 0) {
        // Use IDs (not names) so teams with duplicate names (e.g. same club entry)
        // are tracked individually — name-based Sets collapse duplicates incorrectly.
        const _cachedIds = new Set<string>(
          existingDrawn.flatMap((g) =>
            g.slots.map((s) => s.team?.id).filter((id): id is string => !!id)
          )
        );
        const _currentIds = new Set(safeTeams.map((t) => t.id));
        const _rosterMatch =
          existingDrawn.length === n &&
          _cachedIds.size <= _currentIds.size &&
          [..._cachedIds].every((id) => _currentIds.has(id));

        if (_rosterMatch) {
          setGroups(existingDrawn);
          setDrawnCount(drawnNum);

          // Rebuild teamsByGroup: drawn brackets keep their revealed teams;
          // undrawn brackets use balancedDistribute so the seeding constraint
          // (one seeded team per bracket) is maintained mid-draw.
          // Sequential slicing clusters seeded teams into the same bracket.
          const _undrawnPool = safeTeams.filter((t) => !_cachedIds.has(t.id));
          const _undrawnCount = existingDrawn.filter(
            (g) => !g.isDrawn && g.slots.every((s) => s.team === null)
          ).length;
          const _undrawnBuckets =
            _undrawnCount > 0 ? balancedDistribute(_undrawnPool, _undrawnCount) : [];
          let _ubIdx = 0;
          const buckets: Team[][] = existingDrawn.map((g) => {
            const revealed = g.slots.map((s) => s.team).filter((t): t is Team => t !== null);
            if (revealed.length > 0 || g.isDrawn) {
              return revealed;
            }
            return _undrawnBuckets[_ubIdx++] ?? [];
          });

          setTeamsByGroup(buckets);
          if (existingDrawn.length !== numBrackets) {
            setNumBrackets(existingDrawn.length);
          }
          // Ensure live matches are synced into match store
          syncDrawnBracketsToLiveMatches(tournamentSlug, categoryId, existingDrawn);

          // If category.teams was empty, auto-sync teams into tournament category store
          const recoveredTeams: Team[] = [];
          const seen = new Set<string>();
          existingDrawn.forEach((g) => {
            g.slots.forEach((s) => {
              if (s.team && !seen.has(s.team.id)) {
                seen.add(s.team.id);
                recoveredTeams.push(s.team);
              }
            });
          });
          if (category && (!category.teams || category.teams.length === 0) && recoveredTeams.length > 0) {
            try {
              bulkSetTeamsInCategory(tournamentSlug, categoryId, recoveredTeams);
            } catch {
              // ignore
            }
          }
          return;
        }
      }
    }

    setDrawnCount(0);

    // Distribute teams into buckets with balanced seeding
    const buckets = balancedDistribute(safeTeams, n);
    setTeamsByGroup(buckets);

    // Setup initial standby groups
    const initial: BracketGroup[] = buckets.map((bucketTeams, i) => ({
      name: `Bracket ${LETTERS[i] ?? i + 1}`,
      letter: LETTERS[i] ?? String(i + 1),
      slots: bucketTeams.map(() => ({ team: null, revealed: false })),
      revealed: false,
      isDrawn: false,
    }));

    setGroups(initial);
  }, [category, numBrackets, tournamentSlug, categoryId]);

  // Total teams and stats
  const totalTeams = teams.length > 0 ? teams.length : teamsInGroups.length;
  const hasTeams =
    totalTeams > 0 ||
    groups.some((g) => g.isDrawn || g.slots.some((s) => s.team !== null));
  const isAllDone = groups.length > 0 && drawnCount >= groups.length;
  const isAnimating = drawingBracketIdx !== -1;
  const nextBracketIdx = drawnCount < groups.length ? drawnCount : -1;
  const nextBracketLetter = nextBracketIdx >= 0 ? (LETTERS[nextBracketIdx] ?? String(nextBracketIdx + 1)) : "";

  // ── Draw ONE single bracket at a time ────────────────────────────────────
  const drawSingleBracket = async (bracketIndex: number) => {
    if (isAnimating || bracketIndex < 0 || bracketIndex >= groups.length) return;
    if (groups[bracketIndex]?.isDrawn) return;

    animCancelRef.current = false;
    setDrawingBracketIdx(bracketIndex);

    const targetTeams = teamsByGroup[bracketIndex] ?? [];

    // 1. Reveal Header with active highlight
    setGroups((prev) =>
      prev.map((g, idx) => (idx === bracketIndex ? { ...g, revealed: true } : g)),
    );
    await delay(380);
    if (animCancelRef.current) {
      setDrawingBracketIdx(-1);
      return;
    }

    // 2. Drop in each team in this bracket one by one
    for (let ti = 0; ti < targetTeams.length; ti++) {
      if (animCancelRef.current) break;

      const team = targetTeams[ti]!;
      setGroups((prev) =>
        prev.map((g, gidx) => {
          if (gidx !== bracketIndex) return g;
          return {
            ...g,
            slots: g.slots.map((s, sidx) => (sidx === ti ? { team, revealed: true } : s)),
          };
        }),
      );

      // Stagger delay between team drops
      await delay(targetTeams.length > 6 ? 160 : 250);
    }

    if (!animCancelRef.current) {
      // 3. Mark this bracket as completed and save — pass full roster so
      // bulkSetTeamsInCategory never shrinks the category to only drawn teams.
      const fullRoster = teams.length > 0 ? teams : teamsByGroup.flat();
      setGroups((prev) => {
        const next = prev.map((g, idx) => (idx === bracketIndex ? { ...g, isDrawn: true, revealed: true } : g));
        saveDrawnGroups(tournamentSlug, categoryId, next, fullRoster);
        return next;
      });
      setDrawnCount((prev) => {
        const next = Math.max(prev, bracketIndex + 1);
        return next;
      });
    }

    setDrawingBracketIdx(-1);
  };

  // ── Auto-Draw all remaining brackets sequentially ────────────────────────
  const runAutoDrawRemaining = async () => {
    if (isAnimating || isAllDone) return;
    setIsAutoPlaying(true);
    animCancelRef.current = false;

    for (let gi = drawnCount; gi < groups.length; gi++) {
      if (animCancelRef.current) break;
      await drawSingleBracket(gi);
      if (animCancelRef.current) break;
      await delay(450); // Pause between brackets
    }

    setIsAutoPlaying(false);
  };

  // ── Reset everything & re-shuffle ─────────────────────────────────────────
  const handleReset = () => {
    animCancelRef.current = true;
    setIsAutoPlaying(false);
    setDrawingBracketIdx(-1);
    setDrawnCount(0);

    // Completely clear drawn groups, main draw, live matches, and queue across system
    resetDrawnGroups(tournamentSlug, categoryId);

    const n = Math.max(1, Math.min(numBrackets, Math.ceil(category.teams.length / 2) || 1));

    // Redistribute with balanced seeding on reset
    const buckets = balancedDistribute(category.teams, n);
    setTeamsByGroup(buckets);

    const initial: BracketGroup[] = buckets.map((bucketTeams, i) => ({
      name: `Bracket ${LETTERS[i] ?? i + 1}`,
      letter: LETTERS[i] ?? String(i + 1),
      slots: bucketTeams.map(() => ({ team: null, revealed: false })),
      revealed: false,
      isDrawn: false,
    }));

    setGroups(initial);
  };

  const [undoRoster, setUndoRoster] = useState<{
    action: "populate" | "delete";
    teams: Team[];
    label: string;
  } | null>(null);

  const handleQuickPopulate32 = () => {
    const confirmMsg =
      teams.length > 0
        ? `Replace current roster (${teams.length} teams) with 32 verified teams for an 8-bracket draw?`
        : "Generate and populate 32 verified teams for an 8-bracket draw?";
    if (!window.confirm(confirmMsg)) return;

    setUndoRoster({
      action: "populate",
      teams: [...teams],
      label: `Previous roster (${teams.length} teams)`,
    });

    resetDrawnGroups(tournamentSlug, categoryId);

    const generated = generate32Teams({ verifiedOnly: true });
    bulkSetTeamsInCategory(tournamentSlug, categoryId, generated);

    // Immediately compute the correct 8-bracket distribution with the fresh roster.
    // This prevents the useEffect from running with a stale category.teams count
    // (old value) and producing the wrong number of brackets.
    const _n = 8;
    const _buckets = balancedDistribute(generated, _n);
    const _initial: BracketGroup[] = _buckets.map((bt, i) => ({
      name: `Bracket ${LETTERS[i] ?? i + 1}`,
      letter: LETTERS[i] ?? String(i + 1),
      slots: bt.map(() => ({ team: null, revealed: false })),
      revealed: false,
      isDrawn: false,
    }));
    setTeamsByGroup(_buckets);
    setGroups(_initial);
    setDrawnCount(0);
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

    resetDrawnGroups(tournamentSlug, categoryId);
    deleteAllTeamsInCategory(tournamentSlug, categoryId);
    setGroups([]);
    setDrawnCount(0);
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
              <option value={2}>2 Brackets (A &amp; B)</option>
              <option value={3}>3 Brackets (A, B, C)</option>
              <option value={4}>4 Brackets (A, B, C, D)</option>
              <option value={6}>6 Brackets (A to F)</option>
              <option value={8}>8 Brackets (A to H - 32 Teams)</option>
            </select>
            {teams.length < 32 && (
              <button
                type="button"
                onClick={handleQuickPopulate32}
                disabled={isAnimating}
                className="self-start text-[0.65rem] text-pickle hover:text-foreground font-semibold uppercase tracking-wider underline cursor-pointer mt-1"
              >
                + Auto-Populate 32 Teams (8 Brackets)
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
                  ? `Populated 32 teams into ${category.label}.`
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
          {!isAllDone && drawnCount < groups.length - 1 && (
            <button
              onClick={runAutoDrawRemaining}
              disabled={isAnimating}
              className="flex items-center gap-2 border border-pickle/50 bg-charcoal/80 px-4 py-3.5 text-xs font-bold uppercase tracking-widest text-pickle hover:bg-pickle hover:text-sand hover:border-pickle transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span>Auto-Draw All Remaining</span>
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
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-pickle" />
          <span>Click any pending bracket card or button to reveal one at a time.</span>
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
            Add teams in the <strong>Teams</strong> tab first, or auto-populate 32 verified doubles teams to run an 8-bracket ceremony right now.
          </p>
          <button
            type="button"
            onClick={handleQuickPopulate32}
            className="px-5 py-2.5 bg-pickle text-sand hover:opacity-90 font-semibold text-xs tracking-wider uppercase rounded transition-all cursor-pointer shadow"
          >
            Auto-Populate 32 Teams for Draw
          </button>
        </div>
      )}

      {/* ── Brackets Grid (Supports up to 8 brackets with 32 teams) ── */}
      {hasTeams && groups.length > 0 && (
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
              />
            );
          })}
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
}: {
  group: BracketGroup;
  index: number;
  isActive: boolean;
  isDrawn: boolean;
  isNext: boolean;
  isAnimating: boolean;
  onDrawThisBracket: () => void;
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
          group.slots.map((slot, ti) => (
            <TeamSlot key={ti} slot={slot} index={ti} isGroupActive={isActive} />
          ))
        )}
      </div>
    </div>
  );
}

// ── TeamSlot ──────────────────────────────────────────────────────────────
function TeamSlot({
  slot,
  index,
  isGroupActive,
}: {
  slot: BracketSlot;
  index: number;
  isGroupActive: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 transition-all duration-300 ${slot.revealed
          ? "opacity-100 translate-y-0"
          : "opacity-35 translate-y-1"
        } ${slot.revealed && isGroupActive
          ? "bg-pickle/10 border-l-2 border-l-pickle"
          : slot.revealed
            ? "border-l-2 border-l-transparent bg-card"
            : "bg-card/50"
        }`}
    >
      {/* Seed number */}
      <span
        className={`flex-shrink-0 font-display text-lg leading-none w-5 text-center transition-colors ${slot.revealed ? "text-pickle" : "text-muted-foreground/40"
          }`}
      >
        {index + 1}
      </span>

      {/* Team info */}
      <div className="flex-1 min-w-0">
        {slot.revealed && slot.team ? (
          <>
            <span className="block font-semibold text-foreground truncate text-xs sm:text-sm">
              {slot.team.name}
            </span>
            <span className="block text-[0.65rem] text-foreground/80 font-bold truncate">
              {slot.team.players.join(" & ")}
            </span>
          </>
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
