import React, { useState, useMemo } from "react";
import type { Category } from "@/data/tournaments";
import type { LiveMatch } from "@/lib/match-store";
import {
  clearCompletedMatches,
  deduplicateCompletedMatches,
  getMatchTeamDisplay,
  resolveMatchWinnerSide,
} from "@/lib/match-store";
import { isMatchInCategory } from "@/lib/court-dispatch";
import { getCachedDrawnGroups, isSameCategory } from "@/lib/supabase-service";
import { Search, ChevronDown, ChevronUp, Trash2, AlertTriangle, Loader2, Check, RefreshCw } from "lucide-react";

interface MatchHistoryProps {
  tournamentSlug: string;
  categories: Category[];
  matches: LiveMatch[];
  initialCategoryId?: string;
  onSelectCategory?: (categoryId: string) => void;
  onRefresh?: () => Promise<unknown> | void;
}

export function MatchHistory({
  tournamentSlug,
  categories,
  matches,
  initialCategoryId,
  onSelectCategory,
  onRefresh,
}: MatchHistoryProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>(
    initialCategoryId || (categories[0]?.id ?? "ALL"),
  );
  const [selectedBracket, setSelectedBracket] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sortOrder, setSortOrder] = useState<"recent" | "earliest">("recent");
  const [expandedRalliesMatchId, setExpandedRalliesMatchId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  // Clear History Modal & Action State
  const [showClearModal, setShowClearModal] = useState<boolean>(false);
  const [clearScope, setClearScope] = useState<"selected" | "all">("selected");
  const [isClearing, setIsClearing] = useState<boolean>(false);
  const [clearNotice, setClearNotice] = useState<string | null>(null);

  // Single Match Delete State
  const [matchToDelete, setMatchToDelete] = useState<LiveMatch | null>(null);
  const [isDeletingSingle, setIsDeletingSingle] = useState<boolean>(false);

  // Sync category if initialCategoryId changes
  React.useEffect(() => {
    if (initialCategoryId) {
      setSelectedCategory(initialCategoryId);
    }
  }, [initialCategoryId]);

  // Pull fresh cloud matches immediately when opening Match History
  React.useEffect(() => {
    if (onRefresh) {
      void onRefresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleManualSync = async () => {
    if (!onRefresh || isSyncing) return;
    setIsSyncing(true);
    try {
      await onRefresh();
    } finally {
      setIsSyncing(false);
    }
  };

  // Deduplicate and filter completed matches belonging to this tournament
  const allCompletedMatches = useMemo(
    () => deduplicateCompletedMatches(matches, { tournamentSlug, categories }),
    [matches, tournamentSlug, categories],
  );

  function isPlayoffMatch(m: LiveMatch): boolean {
    const stage = (m.stage || "").toLowerCase();
    const id = (m.id || "").toLowerCase();
    if (stage.includes("pool play") || /(?:bracket|pool)\s+[a-z]\b/i.test(stage)) {
      return false;
    }
    return (
      stage.includes("quarter") ||
      stage.includes("semi") ||
      stage.includes("final") ||
      stage.includes("playoff") ||
      stage.includes("bronze") ||
      stage.includes("championship") ||
      stage.includes("consolation") ||
      id.includes("quarterfinal") ||
      id.includes("semifinal") ||
      id.includes("playoff") ||
      id.includes("-qf-") ||
      id.includes("-sf-") ||
      id.includes("_qf_") ||
      id.includes("_sf_")
    );
  }

  function getMatchBracketLetter(m: LiveMatch): string | undefined {
    // Playoff matches can NEVER belong to a pool bracket (e.g., Bracket A)
    if (isPlayoffMatch(m)) return undefined;
    if (m.bracketLetter) return m.bracketLetter.toUpperCase();
    const stage = (m.stage || "").toLowerCase();
    const stageLetter = stage.match(/(?:bracket|pool)\s*([a-z])\b/i)?.[1]?.toUpperCase();
    if (stageLetter) return stageLetter;
    const idMatch = m.id?.match(/[-_](?:bracket|b)[-_]?([a-z])\b/i) || m.id?.match(/^match_.+?_([A-Z])_/);
    if (idMatch?.[1]) return idMatch[1].toUpperCase();

    // Fallback: look up drawn groups for this match's category to resolve bracket letter by player roster
    const assignedCat = getMatchAssignedCategory(m, categories, tournamentSlug);
    if (assignedCat) {
      const drawn =
        getCachedDrawnGroups(tournamentSlug, assignedCat.id) ||
        getCachedDrawnGroups(tournamentSlug, (assignedCat as any).category_slug);
      if (drawn && Array.isArray(drawn)) {
        const normP = (arr?: string[]) =>
          (arr || [])
            .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
            .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
            .filter(Boolean)
            .sort()
            .join("|");
        const pA = normP(m.teamAPlayers);
        const pB = normP(m.teamBPlayers);
        if (pA && pB) {
          for (const g of drawn) {
            const letter = (g.letter || g.bracketLetter)?.toUpperCase();
            if (!letter || !Array.isArray(g.slots)) continue;
            const slotRosters = new Set(
              g.slots.map((s: any) => normP(s?.team?.players)).filter(Boolean),
            );
            if (slotRosters.has(pA) && slotRosters.has(pB)) {
              return letter;
            }
          }
        }
      }
    }
    return undefined;
  }

/**
 * Resolves the single authoritative category that a match belongs to.
 * Enforces 1:1 match-to-category mapping so no match ever cross-pollinates
 * into another division or age group in match archives.
 */
function getMatchAssignedCategory(
  m: LiveMatch,
  allCategories: Category[],
  tournamentSlug?: string,
): Category | null {
  if (!m || !allCategories || allCategories.length === 0) return null;

  // 1. Direct Category ID / Slug / UUID match (Authoritative ground truth from database)
  if (m.categoryId) {
    const cleanMatchCat = m.categoryId.trim().toLowerCase();
    for (const cat of allCategories) {
      const cleanCatId = cat.id.trim().toLowerCase();
      const cleanSlug = (cat as any).category_slug?.trim().toLowerCase();
      const cleanUuid = (cat as any).uuid?.trim().toLowerCase();

      if (
        cleanMatchCat === cleanCatId ||
        (cleanSlug && cleanMatchCat === cleanSlug) ||
        (cleanUuid && cleanMatchCat === cleanUuid) ||
        isSameCategory(m.categoryId, cat.id) ||
        ((cat as any).uuid && isSameCategory(m.categoryId, (cat as any).uuid)) ||
        ((cat as any).category_slug && isSameCategory(m.categoryId, (cat as any).category_slug))
      ) {
        return cat;
      }
    }
  }

  // 1b. Category-scoped match_ ID prefix
  if (m.id?.startsWith("match_")) {
    const seg = m.id.match(/^match_(.+?)_(?:[A-Z]|PLAYOFF|KO)_/i)?.[1];
    if (seg) {
      for (const cat of allCategories) {
        if (
          isSameCategory(seg, cat.id) ||
          ((cat as any).uuid && isSameCategory(seg, (cat as any).uuid)) ||
          ((cat as any).category_slug && isSameCategory(seg, (cat as any).category_slug))
        ) {
          return cat;
        }
      }
    }
  }

  // 2. Division & Age Isolation pre-filter for legacy matches without categoryId
  const matchText = `${m.categoryId || ""} ${m.id || ""}`.toLowerCase();
  const isMatchWomen = matchText.includes("women") || matchText.includes("female");
  const isMatchMen = (matchText.includes("men") || matchText.includes("male")) && !isMatchWomen;
  const isMatchMixed = matchText.includes("mix");
  const isMatch45 = /\b45\+?|\b50\+?|\bsenior\b|\bmaster/i.test(matchText);
  const isMatchBeg = matchText.includes("beginner") && !isMatch45;
  const isMatchNov = matchText.includes("novice") && !isMatch45;
  const isMatchInt = matchText.includes("intermediate") && !isMatch45;

  const isCompatible = (c: Category): boolean => {
    const cText = `${c.id} ${(c as any).category_slug || ""} ${c.label || ""} ${c.division || ""} ${c.level || ""}`.toLowerCase();
    const isCatWomen = cText.includes("women") || cText.includes("female");
    const isCatMen = (cText.includes("men") || cText.includes("male")) && !isCatWomen;
    const isCatMixed = cText.includes("mix");
    const isCat45 = /\b45\+?|\b50\+?|\bsenior\b|\bmaster/i.test(cText);
    const isCatBeg = cText.includes("beginner") && !isCat45;
    const isCatNov = cText.includes("novice") && !isCat45;
    const isCatInt = cText.includes("intermediate") && !isCat45;

    // Gender / Division isolation
    if (isCatWomen && (isMatchMen || isMatchMixed)) return false;
    if (isCatMen && (isMatchWomen || isMatchMixed)) return false;
    if (isCatMixed && (isMatchMen || isMatchWomen)) return false;

    // Age isolation
    if (isCat45 && !isMatch45 && (isMatchBeg || isMatchNov || isMatchInt)) return false;
    if (!isCat45 && isMatch45) return false;

    // Skill level isolation
    if (isCatBeg && (isMatchNov || isMatchInt)) return false;
    if (isCatNov && (isMatchBeg || isMatchInt)) return false;

    return true;
  };

  const pool = allCategories.filter(isCompatible);
  const candidatePool = pool.length > 0 ? pool : allCategories;

  // 3. Player roster membership (Definitive ground truth for unrostered or custom match names)
  const matchPlayers = [
    ...(m.teamAPlayers || []),
    ...(m.teamBPlayers || []),
  ]
    .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
    .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);

  if (matchPlayers.length > 0) {
    let bestCatByPlayers: Category | null = null;
    let maxPlayerMatches = 0;

    for (const cat of candidatePool) {
      if (cat.teams && cat.teams.length > 0) {
        const catPlayers = new Set(
          cat.teams.flatMap((t) =>
            (t.players || [])
              .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
              .map((p) => p.replace(/\s+/g, " ").trim().toLowerCase()),
          ),
        );
        const matchCount = matchPlayers.filter((p) => catPlayers.has(p)).length;
        if (matchCount > maxPlayerMatches) {
          maxPlayerMatches = matchCount;
          bestCatByPlayers = cat;
        }
      }
    }

    if (bestCatByPlayers && maxPlayerMatches > 0) {
      return bestCatByPlayers;
    }
  }

  // 4. Team roster membership (Both teams registered in category or official drawn groups)
  const tA = m.teamAName?.replace(/\s+/g, " ").trim().toLowerCase();
  const tB = m.teamBName?.replace(/\s+/g, " ").trim().toLowerCase();
  if (tA && tB && tA !== "n/a" && tB !== "n/a") {
    // Official category teams
    for (const cat of candidatePool) {
      if (cat.teams && cat.teams.length > 0) {
        const validTeams = new Set(cat.teams.map((t) => t.name.replace(/\s+/g, " ").trim().toLowerCase()));
        if (validTeams.has(tA) && validTeams.has(tB)) {
          return cat;
        }
      }
    }

    // Official drawn groups
    for (const cat of candidatePool) {
      const cachedDrawn =
        getCachedDrawnGroups(tournamentSlug || "", cat.id) ||
        getCachedDrawnGroups(tournamentSlug || "", (cat as any).category_slug);
      if (cachedDrawn && Array.isArray(cachedDrawn)) {
        const drawnTeams = new Set<string>();
        for (const g of cachedDrawn) {
          for (const s of g.slots || []) {
            if (s.team?.name) drawnTeams.add(s.team.name.replace(/\s+/g, " ").trim().toLowerCase());
          }
        }
        if (drawnTeams.has(tA) && drawnTeams.has(tB)) {
          return cat;
        }
      }
    }
  }

  // 5. Match ID token match (Prioritize longest specific category slug)
  if (m.id) {
    const cleanMatchId = m.id.toLowerCase();
    const sortedCats = [...candidatePool].sort((a, b) => {
      const lenA = Math.max(a.id.length, (a as any).category_slug?.length || 0, a.label.length);
      const lenB = Math.max(b.id.length, (b as any).category_slug?.length || 0, b.label.length);
      return lenB - lenA;
    });

    for (const cat of sortedCats) {
      const cId = cat.id.toLowerCase();
      const cSlug = (cat as any).category_slug?.toLowerCase();
      const labelSlug = cat.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

      const checkToken = (token?: string) => {
        if (!token || token.length < 3) return false;
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
        return regex.test(cleanMatchId);
      };

      if (checkToken(cSlug) || checkToken(cId) || checkToken(labelSlug)) {
        return cat;
      }
    }
  }

  // 6. Fallback to court-dispatch heuristic if only 1 category matches
  const fallbackMatches = candidatePool.filter((c) => isMatchInCategory(m, c, tournamentSlug));
  if (fallbackMatches.length === 1) {
    return fallbackMatches[0]!;
  }

  return candidatePool[0] || null;
}

function isMatchBelongsToCategory(
  m: LiveMatch,
  cat: Category,
  allCategories?: Category[],
  tournamentSlug?: string,
): boolean {
  if (!m || !cat) return false;
  if (!allCategories || allCategories.length === 0) {
    return isMatchInCategory(m, cat, tournamentSlug);
  }
  const assigned = getMatchAssignedCategory(m, allCategories, tournamentSlug);
  if (!assigned) return false;
  return (
    assigned.id === cat.id ||
    (Boolean((assigned as any).uuid && (cat as any).uuid) &&
      (assigned as any).uuid === (cat as any).uuid) ||
    (Boolean((assigned as any).category_slug && (cat as any).category_slug) &&
      (assigned as any).category_slug === (cat as any).category_slug)
  );
}

  // Matches for the selected category
  const categoryMatches = useMemo(() => {
    if (selectedCategory === "ALL") return allCompletedMatches;
    const cat = categories.find((c) => c.id === selectedCategory || (c as any).category_slug === selectedCategory);
    if (!cat) return [];

    return allCompletedMatches.filter((m) => isMatchBelongsToCategory(m, cat, categories, tournamentSlug));
  }, [allCompletedMatches, selectedCategory, categories, tournamentSlug]);

  // Available brackets for selected category
  const availableBrackets = useMemo(() => {
    const bracketsSet = new Set<string>();

    // If a specific category is selected, pre-populate with its official drawn groups
    if (selectedCategory !== "ALL") {
      const cat = categories.find((c) => c.id === selectedCategory || (c as any).category_slug === selectedCategory);
      if (cat) {
        const cachedDrawn = getCachedDrawnGroups(tournamentSlug, cat.id) || getCachedDrawnGroups(tournamentSlug, (cat as any).category_slug);
        if (cachedDrawn && Array.isArray(cachedDrawn) && cachedDrawn.length > 0) {
          for (const g of cachedDrawn) {
            const letter = (g.letter || g.bracketLetter)?.toUpperCase();
            if (letter) bracketsSet.add(`Bracket ${letter}`);
          }
        } else if (cat.teams && cat.teams.length > 0) {
          const numBrackets = Math.ceil(cat.teams.length / 4);
          for (let i = 0; i < numBrackets; i++) {
            bracketsSet.add(`Bracket ${String.fromCharCode(65 + i)}`);
          }
        }
      }
    }

    for (const m of categoryMatches) {
      if (isPlayoffMatch(m)) {
        bracketsSet.add("Playoffs");
      } else {
        const letter = getMatchBracketLetter(m);
        if (letter) {
          bracketsSet.add(`Bracket ${letter}`);
        }
      }
    }

    const sortedBrackets = Array.from(bracketsSet).sort((a, b) => {
      if (a === "Playoffs") return 1;
      if (b === "Playoffs") return -1;
      return a.localeCompare(b);
    });

    return ["ALL", ...sortedBrackets];
  }, [categoryMatches, selectedCategory, categories, tournamentSlug]);

  // Reset selectedBracket to ALL if it no longer exists in availableBrackets
  React.useEffect(() => {
    if (selectedBracket !== "ALL" && !availableBrackets.includes(selectedBracket)) {
      setSelectedBracket("ALL");
    }
  }, [availableBrackets, selectedBracket]);

  // Filter matches by selected bracket
  const bracketMatches = useMemo(() => {
    if (selectedBracket === "ALL") return categoryMatches;

    return categoryMatches.filter((m) => {
      const isPlayoff = isPlayoffMatch(m);
      if (selectedBracket === "Playoffs") {
        return isPlayoff;
      }
      if (isPlayoff) {
        return false;
      }
      const targetLetter = selectedBracket.replace("Bracket ", "").trim().toUpperCase();
      const matchLetter = getMatchBracketLetter(m);
      return matchLetter === targetLetter;
    });
  }, [categoryMatches, selectedBracket]);

  // Search and sort matches
  const displayedMatches = useMemo(() => {
    let result = [...bracketMatches];

    if (searchQuery.trim()) {
      const q = searchQuery.replace(/\s+/g, " ").toLowerCase().trim();
      result = result.filter((m) => {
        const teamA = (m.teamAName || "").replace(/\s+/g, " ").toLowerCase();
        const teamB = (m.teamBName || "").replace(/\s+/g, " ").toLowerCase();
        const stage = (m.stage || "").toLowerCase();
        const court = (m.court || "").toLowerCase();
        const playersA = (m.teamAPlayers || []).join(" ").replace(/\s+/g, " ").toLowerCase();
        const playersB = (m.teamBPlayers || []).join(" ").replace(/\s+/g, " ").toLowerCase();
        return (
          teamA.includes(q) ||
          teamB.includes(q) ||
          stage.includes(q) ||
          court.includes(q) ||
          playersA.includes(q) ||
          playersB.includes(q)
        );
      });
    }

    result.sort((a, b) => {
      const timeA = a.endedAt || a.startedAt || 0;
      const timeB = b.endedAt || b.startedAt || 0;
      if (sortOrder === "recent") {
        return (timeB as number) - (timeA as number);
      }
      return (timeA as number) - (timeB as number);
    });

    return result;
  }, [bracketMatches, searchQuery, sortOrder]);

  // Key stats for displayed list
  const stats = useMemo(() => {
    let totalPoints = 0;
    let totalDiff = 0;
    for (const m of displayedMatches) {
      const sA = m.score?.teamAScore ?? 0;
      const sB = m.score?.teamBScore ?? 0;
      totalPoints += sA + sB;
      totalDiff += Math.abs(sA - sB);
    }
    const count = displayedMatches.length;
    return {
      count,
      totalPoints,
      avgDiff: count > 0 ? (totalDiff / count).toFixed(1) : "0",
    };
  }, [displayedMatches]);

  const formatTimestamp = (timestamp?: string | number | null) => {
    if (!timestamp) return "Final";
    try {
      const d = new Date(timestamp);
      if (isNaN(d.getTime())) return "Final";
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return "Final";
    }
  };

  const selectedCategoryObj = useMemo(() => {
    if (selectedCategory === "ALL") return null;
    return categories.find((c) => c.id === selectedCategory || (c as any).category_slug === selectedCategory) || null;
  }, [selectedCategory, categories]);

  const selectedCategoryLabel = selectedCategoryObj?.label || selectedCategory;

  const handleClearHistory = async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      const isCurrentDivision = clearScope === "selected" && selectedCategory !== "ALL";
      const targetMatches = isCurrentDivision ? categoryMatches : allCompletedMatches;
      const targetIds = targetMatches.map((m) => m.id);

      const result = await clearCompletedMatches({
        tournamentSlug,
        matchIds: targetIds,
        categoryId: isCurrentDivision ? (selectedCategoryObj?.id || selectedCategory) : undefined,
        targetMatches,
        purgeAllCompletedInScope: true,
      });

      setShowClearModal(false);
      setClearNotice(
        isCurrentDivision
          ? `Cleared ${result.deletedCount} match history records for ${selectedCategoryLabel}.`
          : `Cleared ${result.deletedCount} match history records across all divisions.`
      );
      setTimeout(() => setClearNotice(null), 4000);
    } catch (err) {
      console.error("Failed to clear match history:", err);
    } finally {
      setIsClearing(false);
    }
  };

  const handleConfirmDeleteSingle = async () => {
    if (!matchToDelete || isDeletingSingle) return;
    setIsDeletingSingle(true);
    try {
      await clearCompletedMatches({
        tournamentSlug,
        matchIds: [matchToDelete.id],
        categoryId: matchToDelete.categoryId,
        targetMatch: matchToDelete,
        purgeAllCompletedInScope: false,
      });
      const dispA = getMatchTeamDisplay(matchToDelete.teamAName, matchToDelete.teamAPlayers, "Team A");
      const dispB = getMatchTeamDisplay(matchToDelete.teamBName, matchToDelete.teamBPlayers, "Team B");
      setMatchToDelete(null);
      setClearNotice(`Deleted match record: ${dispA.combined} vs ${dispB.combined}.`);
      setTimeout(() => setClearNotice(null), 4000);
    } catch (err) {
      console.error("Failed to delete single match:", err);
    } finally {
      setIsDeletingSingle(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Subheader ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">
              Match History
            </span>
            <span className="px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-border">
              {allCompletedMatches.length} Recorded
            </span>
          </div>
          <h2 className="mt-1 font-display text-2xl sm:text-3xl text-foreground">
            Completed Match Archives
          </h2>
          <p className="text-xs text-muted-foreground">
            Review official results, scores, and match statistics organized by category and bracket.
          </p>
        </div>

        {/* Right side controls: Search bar, Sync & Clear History buttons */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
          {/* Search bar */}
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search teams, players, courts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-card text-foreground pl-9 pr-3 py-1.5 text-xs border border-border rounded focus:border-pickle focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {onRefresh && (
              <button
                type="button"
                onClick={handleManualSync}
                disabled={isSyncing}
                className="flex flex-1 sm:flex-initial items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider border border-pickle/50 bg-pickle/10 text-pickle hover:bg-pickle hover:text-sand transition-all rounded disabled:opacity-50 cursor-pointer shrink-0"
                title="Sync match history with cloud database"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} />
                <span>{isSyncing ? "Syncing" : "Sync"}</span>
              </button>
            )}

            {/* Clear Match History Button */}
            <button
              type="button"
              onClick={() => {
                setClearScope(selectedCategory !== "ALL" ? "selected" : "all");
                setShowClearModal(true);
              }}
              disabled={allCompletedMatches.length === 0}
              className="flex flex-1 sm:flex-initial items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider border border-brick/50 bg-brick/10 text-brick hover:bg-brick hover:text-sand transition-all rounded disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
              title="Clear recorded match history"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Clear History</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Clear Success Alert ── */}
      {clearNotice && (
        <div className="surface-card flex items-center justify-between gap-3 p-3 bg-pickle/15 border border-pickle/40 rounded text-xs animate-in fade-in">
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-pickle" />
            <span className="text-foreground font-medium">{clearNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setClearNotice(null)}
            className="text-[0.65rem] text-muted-foreground hover:text-foreground uppercase tracking-wider font-semibold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Division Horizontal Tabs ── */}
      <div className="space-y-1.5">
        <label className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold">
          Division / Category:
        </label>
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
          <button
            onClick={() => {
              setSelectedCategory("ALL");
              setSelectedBracket("ALL");
            }}
            className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider border transition-all shrink-0 cursor-pointer rounded ${
              selectedCategory === "ALL"
                ? "bg-brick text-sand border-brick font-bold shadow-xs"
                : "bg-card text-foreground border-border hover:border-pickle hover:text-pickle"
            }`}
          >
            All Divisions ({allCompletedMatches.length})
          </button>
          {categories.map((c) => {
            const count = allCompletedMatches.filter((m) =>
              isMatchBelongsToCategory(m, c, categories, tournamentSlug)
            ).length;
            const isActive = selectedCategory === c.id || (c as any).category_slug === selectedCategory;
            return (
              <button
                key={c.id}
                onClick={() => {
                  setSelectedCategory(c.id);
                  setSelectedBracket("ALL");
                  onSelectCategory?.(c.id);
                }}
                className={`px-3 py-1.5 text-xs font-semibold tracking-wide border transition-all shrink-0 cursor-pointer rounded ${
                  isActive
                    ? "bg-brick text-sand border-brick font-bold shadow-xs"
                    : "bg-card text-foreground border-border hover:border-pickle hover:text-pickle"
                }`}
              >
                {c.label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Bracket Horizontal Tabs ── */}
      <div className="space-y-1.5">
        <label className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold">
          Bracket Stage:
        </label>
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
          {availableBrackets.map((br) => {
            let count = categoryMatches.length;
            if (br !== "ALL") {
              if (br === "Playoffs") {
                count = categoryMatches.filter((m) => isPlayoffMatch(m)).length;
              } else {
                const letter = br.replace("Bracket ", "").trim().toUpperCase();
                count = categoryMatches.filter((m) => {
                  if (isPlayoffMatch(m)) return false;
                  return getMatchBracketLetter(m) === letter;
                }).length;
              }
            }

            const isActive = selectedBracket === br;
            return (
              <button
                key={br}
                onClick={() => setSelectedBracket(br)}
                className={`px-3 py-1.5 text-xs font-semibold uppercase tracking-wider border transition-all shrink-0 cursor-pointer rounded flex items-center gap-1.5 ${
                  isActive
                    ? "bg-pickle text-sand border-pickle font-bold shadow-xs"
                    : "bg-charcoal text-sand/80 border-border hover:border-sand"
                }`}
              >
                <span>{br === "ALL" ? "All Brackets" : br}</span>
                <span
                  className={`px-1.5 py-0.2 text-[0.6rem] font-mono font-bold rounded ${
                    isActive ? "bg-sand text-charcoal" : "bg-pickle/20 text-pickle"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Stats Strip & Sort Filter ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
        <div className="p-3 bg-card border border-border rounded">
          <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold block">
            Matches Displayed
          </span>
          <span className="font-mono text-xl sm:text-2xl font-bold text-foreground">
            {stats.count}
          </span>
        </div>

        <div className="p-3 bg-card border border-border rounded">
          <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold block">
            Total Points Scored
          </span>
          <span className="font-mono text-xl sm:text-2xl font-bold text-pickle">
            {stats.totalPoints}
          </span>
        </div>

        <div className="p-3 bg-card border border-border rounded">
          <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold block">
            Avg Winning Margin
          </span>
          <span className="font-mono text-xl sm:text-2xl font-bold text-foreground">
            {stats.avgDiff} pts
          </span>
        </div>

        <div className="p-3 bg-card border border-border rounded flex flex-col justify-between">
          <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold block">
            Sort Order
          </span>
          <div className="flex items-center gap-1 mt-1">
            <button
              onClick={() => setSortOrder("recent")}
              className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase rounded border transition-colors cursor-pointer ${
                sortOrder === "recent"
                  ? "bg-pickle text-sand border-pickle"
                  : "bg-card text-muted-foreground border-border"
              }`}
            >
              Newest
            </button>
            <button
              onClick={() => setSortOrder("earliest")}
              className={`px-2 py-0.5 text-[0.65rem] font-bold uppercase rounded border transition-colors cursor-pointer ${
                sortOrder === "earliest"
                  ? "bg-pickle text-sand border-pickle"
                  : "bg-card text-muted-foreground border-border"
              }`}
            >
              Oldest
            </button>
          </div>
        </div>
      </div>

      {/* ── Matches Grid ── */}
      {displayedMatches.length === 0 ? (
        <div className="p-12 text-center bg-card border-2 border-dashed border-border rounded-lg space-y-2">
          <p className="font-display text-lg text-foreground">No matches found</p>
          <p className="text-xs text-muted-foreground">
            No completed matches match the selected division, bracket, or search term.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
          {displayedMatches.map((m, idx) => {
            const scoreA = m.score?.teamAScore ?? 0;
            const scoreB = m.score?.teamBScore ?? 0;
            const displayA = getMatchTeamDisplay(m.teamAName, m.teamAPlayers, "Team A");
            const displayB = getMatchTeamDisplay(m.teamBName, m.teamBPlayers, "Team B");
            const winnerSide = resolveMatchWinnerSide(m);
            const isAWinner = winnerSide === "A";
            const isBWinner = winnerSide === "B";
            const rallies = m.score?.rallies || [];
            const isRalliesExpanded = expandedRalliesMatchId === m.id;

            return (
              <div
                key={m.id || idx}
                className="bg-card border-2 border-border hover:border-pickle/60 transition-all rounded p-3.5 space-y-3 flex flex-col justify-between shadow-xs"
              >
                {/* Match Header */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    {(() => {
                      const isPlayoff = isPlayoffMatch(m);
                      const letter = getMatchBracketLetter(m);
                      const displayStage = isPlayoff
                        ? m.stage
                        : letter
                        ? `Bracket ${letter} (Pool Play)`
                        : m.stage || "Pool Play";
                      return (
                        <span className="px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-charcoal text-sand border border-border">
                          {displayStage}
                        </span>
                      );
                    })()}
                    {m.court && m.court !== "Queue" && (
                      <span className="px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider bg-pickle/15 text-pickle border border-pickle/30">
                        {m.court}
                      </span>
                    )}
                    <div className="flex items-center gap-1.5 ml-auto">
                      <span className="text-[0.65rem] text-muted-foreground font-mono">
                        {formatTimestamp(m.endedAt || m.startedAt)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setMatchToDelete(m)}
                        className="p-1 rounded text-muted-foreground/60 hover:text-brick hover:bg-brick/10 transition-colors cursor-pointer"
                        title="Delete this match record"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>

                  {m.officiatedBy && (
                    <div className="text-[0.65rem] text-muted-foreground">
                      Officiated by: <span className="font-semibold text-foreground">{m.officiatedBy}</span>
                    </div>
                  )}
                </div>

                {/* Teams & Scoreboard */}
                <div className="space-y-2 pt-1">
                  {/* Team A */}
                  <div
                    className={`p-2.5 rounded border transition-colors flex items-center justify-between gap-3 ${
                      isAWinner
                        ? "bg-pickle/10 border-pickle/50 shadow-xs"
                        : "bg-card border-border/80 opacity-80"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-sm font-bold truncate ${isAWinner ? "text-pickle" : "text-foreground"}`} title={displayA.primary}>
                          {displayA.primary}
                        </span>
                        {isAWinner && (
                          <span className="px-1.5 py-0.2 text-[0.55rem] font-bold uppercase tracking-wider bg-pickle text-sand rounded shrink-0">
                            Winner
                          </span>
                        )}
                      </div>
                      {displayA.secondary && (
                        <span className="text-[0.65rem] text-muted-foreground block truncate">
                          {displayA.secondary}
                        </span>
                      )}
                    </div>
                    <span className={`font-mono text-2xl font-bold shrink-0 ${isAWinner ? "text-pickle" : "text-muted-foreground"}`}>
                      {scoreA}
                    </span>
                  </div>

                  {/* Team B */}
                  <div
                    className={`p-2.5 rounded border transition-colors flex items-center justify-between gap-3 ${
                      isBWinner
                        ? "bg-pickle/10 border-pickle/50 shadow-xs"
                        : "bg-card border-border/80 opacity-80"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-sm font-bold truncate ${isBWinner ? "text-pickle" : "text-foreground"}`} title={displayB.primary}>
                          {displayB.primary}
                        </span>
                        {isBWinner && (
                          <span className="px-1.5 py-0.2 text-[0.55rem] font-bold uppercase tracking-wider bg-pickle text-sand rounded shrink-0">
                            Winner
                          </span>
                        )}
                      </div>
                      {displayB.secondary && (
                        <span className="text-[0.65rem] text-muted-foreground block truncate">
                          {displayB.secondary}
                        </span>
                      )}
                    </div>
                    <span className={`font-mono text-2xl font-bold shrink-0 ${isBWinner ? "text-pickle" : "text-muted-foreground"}`}>
                      {scoreB}
                    </span>
                  </div>
                </div>

                {/* Optional Rally Log Collapsible */}
                {rallies.length > 0 && (
                  <div className="border-t border-border/60 pt-2">
                    <button
                      onClick={() => setExpandedRalliesMatchId(isRalliesExpanded ? null : m.id)}
                      className="w-full flex items-center justify-between text-[0.65rem] font-semibold text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                    >
                      <span>Rally Log ({rallies.length} entries)</span>
                      {isRalliesExpanded ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </button>

                    {isRalliesExpanded && (
                      <div className="mt-2 space-y-1 max-h-36 overflow-y-auto p-2 bg-charcoal/80 text-sand/90 rounded text-[0.65rem] font-mono border border-border">
                        {rallies.map((r, rIdx) => (
                          <div key={r.id || rIdx} className="flex items-center justify-between border-b border-white/10 pb-0.5">
                            <span className="truncate">{r.description || `Rally #${rIdx + 1}`}</span>
                            {r.scoreSnapshot && (
                              <span className="font-bold text-pickle shrink-0 ml-2">
                                {r.scoreSnapshot[0]}-{r.scoreSnapshot[1]}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Clear Match History Confirmation Modal ── */}
      {showClearModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="surface-card max-w-md w-full p-5 sm:p-6 border border-border shadow-2xl rounded-xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-lg bg-brick/15 text-brick border border-brick/30 shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <h3 className="font-display text-xl text-foreground">
                  Clear Match History
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  This action permanently removes archived match scores, winners, and rally logs from both your browser and the cloud database.
                </p>
              </div>
            </div>

            {/* Scope Selection if a specific category is selected */}
            {selectedCategory !== "ALL" && (
              <div className="space-y-2 border-y border-border py-3">
                <label className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold block">
                  Select Scope:
                </label>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-2 p-2.5 rounded border border-border bg-card hover:border-pickle cursor-pointer text-xs transition-colors">
                    <input
                      type="radio"
                      name="clearScope"
                      checked={clearScope === "selected"}
                      onChange={() => setClearScope("selected")}
                      className="accent-brick cursor-pointer"
                    />
                    <div className="flex-1 flex items-center justify-between">
                      <span className="font-medium text-foreground truncate">
                        {selectedCategoryLabel}
                      </span>
                      <span className="font-mono text-[0.65rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-bold">
                        {categoryMatches.length} {categoryMatches.length === 1 ? "Match" : "Matches"}
                      </span>
                    </div>
                  </label>

                  <label className="flex items-center gap-2 p-2.5 rounded border border-border bg-card hover:border-pickle cursor-pointer text-xs transition-colors">
                    <input
                      type="radio"
                      name="clearScope"
                      checked={clearScope === "all"}
                      onChange={() => setClearScope("all")}
                      className="accent-brick cursor-pointer"
                    />
                    <div className="flex-1 flex items-center justify-between">
                      <span className="font-medium text-foreground">All Divisions</span>
                      <span className="font-mono text-[0.65rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-bold">
                        {allCompletedMatches.length} {allCompletedMatches.length === 1 ? "Match" : "Matches"}
                      </span>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {selectedCategory === "ALL" && (
              <div className="p-3 bg-muted/40 border border-border rounded text-xs space-y-1">
                <div className="flex items-center justify-between text-foreground font-medium">
                  <span>Scope: All Divisions</span>
                  <span className="font-mono font-bold text-brick">{allCompletedMatches.length} Matches</span>
                </div>
                <p className="text-[0.7rem] text-muted-foreground">
                  All recorded matches across every division in this tournament will be deleted.
                </p>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowClearModal(false)}
                disabled={isClearing}
                className="px-4 py-2 text-xs font-semibold uppercase tracking-wider border border-border hover:bg-muted text-foreground rounded transition-colors cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleClearHistory}
                disabled={isClearing || (clearScope === "selected" ? categoryMatches.length === 0 : allCompletedMatches.length === 0)}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-brick text-sand hover:bg-brick-deep rounded transition-colors cursor-pointer shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isClearing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Clearing…</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Clear {clearScope === "selected" && selectedCategory !== "ALL" ? `${categoryMatches.length} Matches` : `${allCompletedMatches.length} Matches`}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Single Match Delete Confirmation Modal ── */}
      {matchToDelete && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="surface-card max-w-sm w-full p-5 border border-border shadow-2xl rounded-xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-lg bg-brick/15 text-brick border border-brick/30 shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <h3 className="font-display text-lg text-foreground">
                  Delete Match Record
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Permanently delete this match from history and database:
                </p>
                <p className="text-xs font-bold text-foreground">
                  {getMatchTeamDisplay(matchToDelete.teamAName, matchToDelete.teamAPlayers, "Team A").combined} vs {getMatchTeamDisplay(matchToDelete.teamBName, matchToDelete.teamBPlayers, "Team B").combined}
                </p>
                <p className="text-[0.65rem] text-muted-foreground font-mono">
                  {matchToDelete.stage || "Completed Match"}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={() => setMatchToDelete(null)}
                disabled={isDeletingSingle}
                className="px-3.5 py-1.5 text-xs font-semibold uppercase tracking-wider border border-border hover:bg-muted text-foreground rounded transition-colors cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteSingle}
                disabled={isDeletingSingle}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider bg-brick text-sand hover:bg-brick-deep rounded transition-colors cursor-pointer shadow-sm disabled:opacity-50"
              >
                {isDeletingSingle ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>Deleting…</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3 w-3" />
                    <span>Delete Match</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
