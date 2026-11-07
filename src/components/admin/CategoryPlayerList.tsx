import { useState, useEffect, useMemo } from "react";
import type { Team, Tournament, Category } from "@/data/tournaments";
import {
  getDrawnGroups,
  saveDrawnGroups,
  type BracketGroup,
} from "./BracketDraw";
import { isGenericTeamName } from "@/lib/match-store";
import {
  addTeamToCategory,
  updateTeamInTournament,
} from "@/lib/tournament-store";
import {
  getDispatchQueue,
  saveDispatchQueue,
} from "@/lib/court-dispatch";

interface CategoryPlayerListProps {
  tournament: Tournament;
  tournaments: Tournament[];
  tournamentSlug: string;
  setTournamentSlug: (slug: string) => void;
  onOpenCategoryDraw?: (categoryId: string) => void;
}

type StatusFilter = "all" | "missing";

interface CategoryPairRow {
  key: string;
  kind: "bracket_slot" | "roster_team";
  categoryId: string;
  effectiveCategoryId: string;
  categoryLabel: string;
  isSingles: boolean;
  groupIndex?: number | undefined;
  slotIndex?: number | undefined;
  bracketLetter: string | null;
  team: Team | null;
  p1: string;
  p2: string;
  extraPlayers: string[];
  p1Valid: boolean;
  p2Valid: boolean;
  hasTeam: boolean;
  isComplete: boolean;
  missingLabel: string;
}

interface EditingState {
  mode: "bracket_slot" | "roster_team" | "add_to_category";
  categoryId: string;
  effectiveCategoryId: string;
  categoryLabel: string;
  isSingles: boolean;
  groupIndex?: number | undefined;
  slotIndex?: number | undefined;
  bracketLetter?: string | null | undefined;
  teamId?: string | undefined;
  teamName: string;
  club: string;
  player1: string;
  player2: string;
}

function extractIndividualPlayers(team: Team | null | undefined): string[] {
  if (!team) return [];
  return (team.players || [])
    .flatMap((p) => String(p).split(/\s*[\/&]\s*/))
    .map((p) => p.trim())
    .filter(Boolean);
}

function isPlaceholderPlayerName(name: string | undefined): boolean {
  if (!name) return true;
  const clean = name.trim().toLowerCase();
  return (
    !clean ||
    clean === "n/a" ||
    clean === "na" ||
    clean === "none" ||
    clean === "tbd" ||
    clean === "tba" ||
    clean === "unknown" ||
    clean === "-" ||
    clean === "--" ||
    /^player\s*\d+$/i.test(clean)
  );
}

function isSinglesDivision(category?: Category): boolean {
  if (!category) return false;
  const label = `${category.label || ""} ${category.id || ""}`.toLowerCase();
  return label.includes("single");
}

export function CategoryPlayerList({
  tournament,
  tournaments,
  tournamentSlug,
  setTournamentSlug,
  onOpenCategoryDraw,
}: CategoryPlayerListProps) {
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [syncVersion, setSyncVersion] = useState<number>(0);

  // Reset category filter if tournament changes and selected category no longer exists
  useEffect(() => {
    if (
      selectedCategoryFilter !== "all" &&
      !(tournament.categories || []).some((c) => c.id === selectedCategoryFilter)
    ) {
      setSelectedCategoryFilter("all");
    }
  }, [tournament, selectedCategoryFilter]);

  // Listen for bracket draw & tournament store updates so pair lists stay live
  useEffect(() => {
    const handleSync = () => setSyncVersion((v) => v + 1);
    window.addEventListener("dv_drawn_groups_updated", handleSync);
    window.addEventListener("dv_tournaments_updated", handleSync);
    window.addEventListener("storage", handleSync);
    return () => {
      window.removeEventListener("dv_drawn_groups_updated", handleSync);
      window.removeEventListener("dv_tournaments_updated", handleSync);
      window.removeEventListener("storage", handleSync);
    };
  }, []);

  // Build structured pair list per category
  const categorySections = useMemo(() => {
    void syncVersion;

    return (tournament.categories || []).map((cat) => {
      const effectiveCategoryId = (cat as any)?.category_slug || cat.id;
      const isSingles = isSinglesDivision(cat);
      const rosterTeams = cat.teams || [];
      const rosterById = new Map(rosterTeams.map((t) => [t.id, t]));

      const rawGroups: BracketGroup[] =
        getDrawnGroups(tournament.slug, effectiveCategoryId) ||
        getDrawnGroups(tournament.slug, cat.id) ||
        [];

      const hasDrawnGroups = rawGroups.some(
        (g) => g.isDrawn || g.slots.some((s) => s.team !== null),
      );

      const rows: CategoryPairRow[] = [];
      const seenTeamIds = new Set<string>();

      const buildRow = (params: {
        key: string;
        kind: "bracket_slot" | "roster_team";
        groupIndex?: number;
        slotIndex?: number;
        bracketLetter: string | null;
        team: Team | null;
      }): CategoryPairRow => {
        const players = extractIndividualPlayers(params.team);
        const p1 = players[0] || "";
        const p2 = players[1] || "";
        const extraPlayers = players.slice(2);
        const hasTeam = Boolean(params.team);
        const p1Valid = !isPlaceholderPlayerName(p1);
        const p2Valid = isSingles ? true : !isPlaceholderPlayerName(p2);
        const isComplete = hasTeam && p1Valid && p2Valid;

        let missingLabel = "";
        if (!hasTeam) {
          missingLabel = "Empty Bracket Slot";
        } else if (!p1Valid && !p2Valid) {
          missingLabel = isSingles ? "Missing Player" : "Missing Pair Names";
        } else if (!p1Valid) {
          missingLabel = "Missing Player 1";
        } else if (!isSingles && !p2Valid) {
          missingLabel = "Missing Partner";
        }

        return {
          key: params.key,
          kind: params.kind,
          categoryId: cat.id,
          effectiveCategoryId,
          categoryLabel: cat.label,
          isSingles,
          groupIndex: params.groupIndex,
          slotIndex: params.slotIndex,
          bracketLetter: params.bracketLetter,
          team: params.team,
          p1,
          p2,
          extraPlayers,
          p1Valid,
          p2Valid,
          hasTeam,
          isComplete,
          missingLabel,
        };
      };

      if (hasDrawnGroups) {
        rawGroups.forEach((group, gIdx) => {
          const groupActive = group.isDrawn || group.slots.some((s) => s.team !== null);
          if (!groupActive) return;

          group.slots.forEach((slot, sIdx) => {
            let reconciledTeam: Team | null = slot.team;
            if (reconciledTeam) {
              const fresh = rosterById.get(reconciledTeam.id);
              if (fresh) {
                reconciledTeam = {
                  ...reconciledTeam,
                  name: fresh.name,
                  players: fresh.players,
                  club: fresh.club ?? reconciledTeam.club,
                };
              }
              seenTeamIds.add(reconciledTeam.id);
            }

            rows.push(
              buildRow({
                key: `slot-${cat.id}-${group.letter}-${sIdx}`,
                kind: "bracket_slot",
                groupIndex: gIdx,
                slotIndex: sIdx,
                bracketLetter: group.letter,
                team: reconciledTeam,
              }),
            );
          });
        });

        // Include any registered pairs in this category not yet placed into a drawn bracket
        rosterTeams.forEach((team, idx) => {
          if (seenTeamIds.has(team.id)) return;
          rows.push(
            buildRow({
              key: `roster-${cat.id}-${team.id}-${idx}`,
              kind: "roster_team",
              bracketLetter: null,
              team,
            }),
          );
        });
      } else {
        rosterTeams.forEach((team, idx) => {
          rows.push(
            buildRow({
              key: `roster-${cat.id}-${team.id}-${idx}`,
              kind: "roster_team",
              bracketLetter: null,
              team,
            }),
          );
        });
      }

      const completePairsCount = rows.filter((r) => r.isComplete).length;
      const totalPairsCount = rows.filter((r) => r.hasTeam).length;
      const missingCount = rows.filter((r) => !r.isComplete).length;

      return {
        category: cat,
        effectiveCategoryId,
        isSingles,
        hasDrawnGroups,
        rows,
        completePairsCount,
        totalPairsCount,
        missingCount,
      };
    });
  }, [tournament, syncVersion]);

  // Overall tournament pair totals
  const overallTotals = useMemo(() => {
    const totalCategories = categorySections.length;
    const totalPairs = categorySections.reduce((sum, s) => sum + s.totalPairsCount, 0);
    const totalMissing = categorySections.reduce((sum, s) => sum + s.missingCount, 0);
    return { totalCategories, totalPairs, totalMissing };
  }, [categorySections]);

  // Apply category filter, status filter, and search query
  const cleanSearch = searchQuery.trim().toLowerCase();

  const visibleSections = useMemo(() => {
    return categorySections
      .filter(
        (sec) =>
          selectedCategoryFilter === "all" || sec.category.id === selectedCategoryFilter,
      )
      .map((sec) => {
        const filteredRows = sec.rows.filter((row) => {
          if (statusFilter === "missing" && row.isComplete) return false;
          if (!cleanSearch) return true;

          const teamName = (row.team?.name || "").toLowerCase();
          const club = (row.team?.club || "").toLowerCase();
          const bracketText = row.bracketLetter
            ? `bracket ${row.bracketLetter.toLowerCase()}`
            : "";
          const combinedPair = `${row.p1} / ${row.p2}`.toLowerCase();

          return (
            combinedPair.includes(cleanSearch) ||
            row.p1.toLowerCase().includes(cleanSearch) ||
            row.p2.toLowerCase().includes(cleanSearch) ||
            row.extraPlayers.some((p) => p.toLowerCase().includes(cleanSearch)) ||
            teamName.includes(cleanSearch) ||
            club.includes(cleanSearch) ||
            bracketText.includes(cleanSearch) ||
            sec.category.label.toLowerCase().includes(cleanSearch)
          );
        });

        return {
          ...sec,
          filteredRows,
        };
      })
      .filter((sec) => {
        if (selectedCategoryFilter !== "all") return true;
        if (cleanSearch || statusFilter === "missing") {
          return sec.filteredRows.length > 0;
        }
        return true;
      });
  }, [categorySections, selectedCategoryFilter, statusFilter, cleanSearch]);

  const openEditRow = (row: CategoryPairRow) => {
    setEditing({
      mode: row.kind,
      categoryId: row.categoryId,
      effectiveCategoryId: row.effectiveCategoryId,
      categoryLabel: row.categoryLabel,
      isSingles: row.isSingles,
      groupIndex: row.groupIndex,
      slotIndex: row.slotIndex,
      bracketLetter: row.bracketLetter,
      teamId: row.team?.id,
      teamName: row.team?.name || "n/a",
      club: row.team?.club || "",
      player1: row.p1,
      player2: row.p2,
    });
  };

  const openAddPairModal = (cat: Category) => {
    const effectiveCategoryId = (cat as any)?.category_slug || cat.id;
    setEditing({
      mode: "add_to_category",
      categoryId: cat.id,
      effectiveCategoryId,
      categoryLabel: cat.label,
      isSingles: isSinglesDivision(cat),
      teamName: "n/a",
      club: "",
      player1: "",
      player2: "",
    });
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;

    const p1 = editing.player1.trim();
    const p2 = editing.player2.trim();
    const nextPlayers = editing.isSingles
      ? [p1].filter(Boolean)
      : [p1, p2].filter(Boolean);
    const nextTeamName =
      editing.teamName.trim() || nextPlayers.join(" / ") || "n/a";
    const nextClub = editing.club.trim() || undefined;

    if (nextPlayers.length === 0 && isGenericTeamName(nextTeamName)) {
      return;
    }

    const catObj = (tournament.categories || []).find(
      (c) => c.id === editing.categoryId,
    );
    const existingRoster = catObj?.teams || [];

    if (editing.mode === "add_to_category") {
      const newTeam: Team = {
        id: `team-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: nextTeamName,
        players: nextPlayers,
        club: nextClub,
        paid: true,
        paymentStatus: "Verified",
      };
      addTeamToCategory(tournament.slug, editing.categoryId, newTeam);
      setSaveNotice(
        `Added pair ${nextPlayers.join(" / ") || nextTeamName} to ${editing.categoryLabel}.`,
      );
      setTimeout(() => setSaveNotice(null), 4000);
      setEditing(null);
      setSyncVersion((v) => v + 1);
      return;
    }

    if (editing.mode === "roster_team" && editing.teamId) {
      updateTeamInTournament(tournament.slug, editing.categoryId, editing.teamId, {
        name: nextTeamName,
        players: nextPlayers,
        club: nextClub,
      });
      setSaveNotice(
        `Updated pair ${nextPlayers.join(" / ") || nextTeamName} in ${editing.categoryLabel}.`,
      );
      setTimeout(() => setSaveNotice(null), 4000);
      setEditing(null);
      setSyncVersion((v) => v + 1);
      return;
    }

    if (
      editing.mode === "bracket_slot" &&
      editing.groupIndex !== undefined &&
      editing.slotIndex !== undefined
    ) {
      const rawGroups =
        getDrawnGroups(tournament.slug, editing.effectiveCategoryId) ||
        getDrawnGroups(tournament.slug, editing.categoryId) ||
        [];

      const gi = editing.groupIndex;
      const si = editing.slotIndex;
      const targetGroup = rawGroups[gi];
      const targetSlot = targetGroup?.slots[si];

      if (!targetGroup || !targetSlot) {
        setEditing(null);
        return;
      }

      const prevTeam = targetSlot.team;
      const updatedTeam: Team = prevTeam
        ? {
            ...prevTeam,
            name: nextTeamName,
            players: nextPlayers,
            club: nextClub,
          }
        : {
            id: `team-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: nextTeamName,
            players: nextPlayers,
            club: nextClub,
            paid: true,
            paymentStatus: "Verified",
          };

      const nextGroups: BracketGroup[] = rawGroups.map((g, gIdx) => ({
        ...g,
        isDrawn: gIdx === gi ? true : g.isDrawn,
        revealed: gIdx === gi ? true : g.revealed,
        slots: g.slots.map((s, sIdx) =>
          gIdx === gi && sIdx === si
            ? { team: updatedTeam, revealed: true }
            : { ...s },
        ),
      }));

      // Sync category.teams
      let updatedAllTeams: Team[];
      if (prevTeam && existingRoster.some((t) => t.id === updatedTeam.id)) {
        updateTeamInTournament(tournament.slug, editing.categoryId, updatedTeam.id, {
          name: updatedTeam.name,
          players: updatedTeam.players,
          club: updatedTeam.club,
        });
        updatedAllTeams = existingRoster.map((t) =>
          t.id === updatedTeam.id ? { ...t, ...updatedTeam } : t,
        );
      } else {
        addTeamToCategory(tournament.slug, editing.categoryId, updatedTeam);
        updatedAllTeams = [...existingRoster, updatedTeam];
      }

      // Sync dispatch queue if pair was queued
      if (prevTeam) {
        try {
          const queue = getDispatchQueue();
          let queueModified = false;
          const prevSig = extractIndividualPlayers(prevTeam)
            .map((p) => p.toLowerCase())
            .sort()
            .join("|");

          const nextQueue = queue.map((qm) => {
            if (qm.tournamentSlug !== tournament.slug) return qm;
            if (qm.status === "completed") return qm;

            const sigA = (qm.teamAPlayers || [])
              .flatMap((p) => p.split(/\s*[\/&]\s*/))
              .map((p) => p.trim().toLowerCase())
              .filter(Boolean)
              .sort()
              .join("|");
            const sigB = (qm.teamBPlayers || [])
              .flatMap((p) => p.split(/\s*[\/&]\s*/))
              .map((p) => p.trim().toLowerCase())
              .filter(Boolean)
              .sort()
              .join("|");

            const matchA = prevSig
              ? sigA === prevSig
              : !isGenericTeamName(prevTeam.name) && qm.teamAName === prevTeam.name;
            const matchB = prevSig
              ? sigB === prevSig
              : !isGenericTeamName(prevTeam.name) && qm.teamBName === prevTeam.name;

            if (!matchA && !matchB) return qm;
            queueModified = true;
            return {
              ...qm,
              teamAName: matchA ? updatedTeam.name : qm.teamAName,
              teamAPlayers: matchA ? updatedTeam.players : qm.teamAPlayers,
              teamBName: matchB ? updatedTeam.name : qm.teamBName,
              teamBPlayers: matchB ? updatedTeam.players : qm.teamBPlayers,
            };
          });

          if (queueModified) {
            saveDispatchQueue(nextQueue);
          }
        } catch {
          // ignore
        }
      }

      saveDrawnGroups(
        tournament.slug,
        editing.effectiveCategoryId,
        nextGroups,
        updatedAllTeams,
        false,
      );

      setSaveNotice(
        `Saved pair ${nextPlayers.join(" / ") || nextTeamName} (${editing.categoryLabel}, Bracket ${targetGroup.letter}).`,
      );
      setTimeout(() => setSaveNotice(null), 4000);
      setEditing(null);
      setSyncVersion((v) => v + 1);
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Top Control Bar ── */}
      <div className="surface-card bg-card border-2 border-border rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          {/* Tournament Selector + Pair Summary */}
          <div className="flex flex-col sm:flex-row sm:items-end gap-3 sm:gap-4 flex-1 min-w-0">
            {tournaments.length > 1 ? (
              <div className="w-full sm:w-64 shrink-0">
                <label className="block text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground mb-1">
                  Tournament
                </label>
                <select
                  value={tournamentSlug}
                  onChange={(e) => setTournamentSlug(e.target.value)}
                  className="w-full rounded border-2 border-border bg-background px-3 py-2 text-xs sm:text-sm font-bold text-foreground focus:border-pickle focus:outline-none cursor-pointer"
                >
                  {tournaments.map((t) => (
                    <option key={t.slug} value={t.slug}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <span className="block text-[0.65rem] font-bold uppercase tracking-widest text-pickle">
                  Active Tournament
                </span>
                <h2 className="font-display text-2xl text-foreground leading-tight">
                  {tournament.name}
                </h2>
              </div>
            )}

            {/* Quick Pair Totals */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded border border-border bg-background px-2.5 py-1.5 text-[0.68rem] font-mono font-bold uppercase tracking-wider text-foreground">
                <span>{overallTotals.totalCategories}</span>
                <span className="text-muted-foreground">Categories</span>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded border border-pickle/40 bg-pickle/10 px-2.5 py-1.5 text-[0.68rem] font-mono font-bold uppercase tracking-wider text-pickle">
                <span>{overallTotals.totalPairs}</span>
                <span>Pairs Inputted</span>
              </span>
              {overallTotals.totalMissing > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setStatusFilter((prev) => (prev === "missing" ? "all" : "missing"))
                  }
                  className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[0.68rem] font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer ${
                    statusFilter === "missing"
                      ? "border-brick bg-brick text-sand"
                      : "border-brick/50 bg-brick/10 text-brick hover:bg-brick/20"
                  }`}
                >
                  <span>{overallTotals.totalMissing} Incomplete</span>
                </button>
              )}
            </div>
          </div>

          {/* Search Input */}
          <div className="relative w-full lg:w-72">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search pair, player, or bracket..."
              className="w-full rounded border-2 border-border bg-background pl-3 pr-8 py-2 text-xs sm:text-sm font-medium text-foreground placeholder:text-muted-foreground focus:border-pickle focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 px-1 text-xs font-bold text-muted-foreground hover:text-foreground cursor-pointer"
              >
                X
              </button>
            )}
          </div>
        </div>

        {/* Category Filter Pills */}
        {categorySections.length > 0 && (
          <div className="pt-3 border-t border-border">
            <span className="block text-[0.62rem] font-bold uppercase tracking-widest text-muted-foreground mb-2">
              Division / Category (Pairs)
            </span>
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              <button
                type="button"
                onClick={() => setSelectedCategoryFilter("all")}
                className={`px-3 py-1.5 rounded border text-xs font-bold transition-colors cursor-pointer ${
                  selectedCategoryFilter === "all"
                    ? "border-brick bg-brick text-sand shadow-xs"
                    : "border-border bg-background text-foreground hover:border-pickle"
                }`}
              >
                All Categories ({overallTotals.totalPairs})
              </button>
              {categorySections.map((sec) => {
                const isSelected = selectedCategoryFilter === sec.category.id;
                return (
                  <button
                    key={sec.category.id}
                    type="button"
                    onClick={() =>
                      setSelectedCategoryFilter(
                        isSelected ? "all" : sec.category.id,
                      )
                    }
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-bold transition-colors cursor-pointer ${
                      isSelected
                        ? "border-brick bg-brick text-sand shadow-xs"
                        : "border-border bg-background text-foreground hover:border-pickle"
                    }`}
                  >
                    <span>{sec.category.label}</span>
                    <span
                      className={`font-mono text-[0.68rem] ${
                        isSelected ? "text-sand/90" : "text-muted-foreground"
                      }`}
                    >
                      ({sec.totalPairsCount})
                    </span>
                    {sec.missingCount > 0 && (
                      <span
                        className={`ml-0.5 rounded px-1.5 py-0.2 text-[0.6rem] font-mono uppercase ${
                          isSelected
                            ? "bg-sand text-brick"
                            : "bg-brick/15 text-brick"
                        }`}
                      >
                        {sec.missingCount} incomplete
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Save Feedback Notice */}
      {saveNotice && (
        <div className="flex items-center justify-between gap-3 rounded-lg border-2 border-pickle bg-pickle/10 px-4 py-2.5 text-xs sm:text-sm font-semibold text-foreground">
          <span>{saveNotice}</span>
          <button
            type="button"
            onClick={() => setSaveNotice(null)}
            className="text-[0.68rem] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Empty Search / Filter State */}
      {visibleSections.length === 0 && (
        <div className="surface-card bg-card border-2 border-border rounded-xl p-10 text-center space-y-3">
          <h3 className="font-display text-2xl text-foreground">
            No Matching Pairs Found
          </h3>
          <p className="text-xs sm:text-sm text-muted-foreground max-w-md mx-auto">
            No pairs matched your current search or filter across the categories in{" "}
            <strong>{tournament.name}</strong>.
          </p>
          {(cleanSearch || statusFilter !== "all" || selectedCategoryFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                setStatusFilter("all");
                setSelectedCategoryFilter("all");
              }}
              className="mt-2 rounded bg-charcoal px-4 py-2 text-xs font-bold uppercase tracking-widest text-sand hover:opacity-90 transition-opacity cursor-pointer"
            >
              Reset Filters
            </button>
          )}
        </div>
      )}

      {/* ── Category Sections (By Pair per Category in One Tab) ── */}
      <div className="space-y-6">
        {visibleSections.map((sec) => {
          const rowsToRender = sec.filteredRows;

          return (
            <section
              key={sec.category.id}
              className="rounded-xl border-2 border-border bg-card overflow-hidden shadow-xs"
            >
              {/* Category Header */}
              <div className="bg-charcoal px-4 py-3.5 sm:px-5 sm:py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-2xl sm:text-3xl text-sand leading-none tracking-wide">
                      {sec.category.label}
                    </h3>
                    {sec.missingCount === 0 && sec.rows.length > 0 && (
                      <span className="rounded border border-pickle/60 bg-pickle/20 px-2 py-0.5 text-[0.6rem] font-mono font-bold uppercase tracking-wider text-pickle">
                        All Pairs Inputted
                      </span>
                    )}
                    {sec.missingCount > 0 && (
                      <span className="rounded border border-brick bg-brick px-2 py-0.5 text-[0.6rem] font-mono font-bold uppercase tracking-wider text-sand">
                        {sec.missingCount} Incomplete
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[0.68rem] font-mono uppercase tracking-wider text-sand/75">
                    {sec.totalPairsCount} {sec.isSingles ? "Entries" : "Pairs"} Inputted
                    {sec.hasDrawnGroups ? " • Brackets Drawn" : " • Pre-Draw Roster"}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {onOpenCategoryDraw && (
                    <button
                      type="button"
                      onClick={() => onOpenCategoryDraw(sec.category.id)}
                      className="rounded border border-sand/30 bg-transparent px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-sand/90 hover:border-sand hover:text-sand transition-colors cursor-pointer"
                    >
                      Open Draw
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => openAddPairModal(sec.category)}
                    className="rounded bg-pickle px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-sand hover:opacity-90 transition-opacity cursor-pointer"
                  >
                    + Add Pair
                  </button>
                </div>
              </div>

              {/* Empty Category State */}
              {sec.rows.length === 0 ? (
                <div className="p-8 text-center space-y-2">
                  <p className="text-sm font-semibold text-muted-foreground">
                    No pairs inputted in {sec.category.label} yet.
                  </p>
                  <button
                    type="button"
                    onClick={() => openAddPairModal(sec.category)}
                    className="inline-block rounded border border-pickle bg-pickle/10 px-4 py-2 text-xs font-bold uppercase tracking-wider text-pickle hover:bg-pickle hover:text-sand transition-colors cursor-pointer"
                  >
                    + Input First Pair
                  </button>
                </div>
              ) : (
                <>
                  {/* Desktop Table (sm and up) — Unified Pair Column */}
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-border bg-background/60 text-[0.65rem] font-mono font-bold uppercase tracking-widest text-muted-foreground">
                          <th className="py-2.5 pl-5 pr-3 w-12">#</th>
                          <th className="py-2.5 px-3">
                            {sec.isSingles ? "Player" : "Pair (Player 1 / Player 2)"}
                          </th>
                          <th className="py-2.5 px-3 w-48">Team / Club</th>
                          <th className="py-2.5 px-3 w-32">Bracket</th>
                          <th className="py-2.5 pl-3 pr-5 text-right w-24">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border text-sm">
                        {rowsToRender.map((row, idx) => {
                          const hasCustomTeamName =
                            row.team && !isGenericTeamName(row.team.name);

                          return (
                            <tr
                              key={row.key}
                              className={`transition-colors ${
                                !row.isComplete
                                  ? "bg-brick/5 hover:bg-brick/10"
                                  : "hover:bg-background/50"
                              }`}
                            >
                              <td className="py-2.5 pl-5 pr-3 font-mono text-xs font-bold text-muted-foreground">
                                {String(idx + 1).padStart(2, "0")}
                              </td>

                              <td className="py-2.5 px-3 font-bold text-foreground">
                                {!row.hasTeam ? (
                                  <span className="inline-block rounded bg-brick/15 px-2 py-0.5 text-xs font-bold text-brick">
                                    Empty Bracket Slot
                                  </span>
                                ) : sec.isSingles ? (
                                  row.p1Valid ? (
                                    <span>{row.p1}</span>
                                  ) : (
                                    <span className="inline-block rounded bg-brick/15 px-2 py-0.5 text-xs font-bold text-brick">
                                      Missing Player
                                    </span>
                                  )
                                ) : (
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {row.p1Valid ? (
                                      <span>{row.p1}</span>
                                    ) : (
                                      <span className="inline-block rounded bg-brick/15 px-2 py-0.5 text-xs font-bold text-brick">
                                        Missing Player 1
                                      </span>
                                    )}
                                    <span className="text-pickle font-mono font-bold">/</span>
                                    {row.p2Valid ? (
                                      <span>{row.p2}</span>
                                    ) : (
                                      <span className="inline-block rounded bg-brick/15 px-2 py-0.5 text-xs font-bold text-brick">
                                        Missing Partner
                                      </span>
                                    )}
                                    {row.extraPlayers.length > 0 && (
                                      <span className="text-xs font-normal text-muted-foreground">
                                        (+{row.extraPlayers.join(", ")})
                                      </span>
                                    )}
                                  </div>
                                )}
                              </td>

                              <td className="py-2.5 px-3 text-xs text-muted-foreground">
                                {hasCustomTeamName ? (
                                  <span className="font-medium text-foreground/85">
                                    {row.team?.name}
                                  </span>
                                ) : (
                                  <span>—</span>
                                )}
                                {row.team?.club && (
                                  <span className="ml-1.5 text-[0.68rem] text-muted-foreground">
                                    ({row.team.club})
                                  </span>
                                )}
                              </td>

                              <td className="py-2.5 px-3">
                                {row.bracketLetter ? (
                                  <span className="inline-block rounded bg-charcoal px-2 py-0.5 font-mono text-[0.65rem] font-bold uppercase tracking-wider text-sand">
                                    Bracket {row.bracketLetter}
                                  </span>
                                ) : (
                                  <span className="text-[0.68rem] font-mono uppercase text-muted-foreground">
                                    {sec.hasDrawnGroups ? "Unassigned" : "Roster"}
                                  </span>
                                )}
                              </td>

                              <td className="py-2.5 pl-3 pr-5 text-right">
                                <button
                                  type="button"
                                  onClick={() => openEditRow(row)}
                                  className={`rounded border px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider transition-colors cursor-pointer ${
                                    !row.isComplete
                                      ? "border-brick bg-brick text-sand hover:bg-brick-deep"
                                      : "border-border bg-background text-foreground hover:border-pickle hover:text-pickle"
                                  }`}
                                >
                                  {row.hasTeam ? "Edit" : "+ Input"}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile Compact Pair Cards (below sm) */}
                  <div className="sm:hidden divide-y divide-border">
                    {rowsToRender.map((row, idx) => {
                      const hasCustomTeamName =
                        row.team && !isGenericTeamName(row.team.name);

                      return (
                        <div
                          key={row.key}
                          className={`p-3.5 flex items-start justify-between gap-3 ${
                            !row.isComplete ? "bg-brick/5" : ""
                          }`}
                        >
                          <div className="flex items-start gap-2.5 min-w-0 flex-1">
                            <span className="font-mono text-xs font-bold text-muted-foreground pt-0.5 shrink-0">
                              {String(idx + 1).padStart(2, "0")}.
                            </span>
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="text-sm font-bold text-foreground leading-snug break-words">
                                {!row.hasTeam ? (
                                  <span className="text-brick">Empty Bracket Slot</span>
                                ) : sec.isSingles ? (
                                  row.p1Valid ? (
                                    <span>{row.p1}</span>
                                  ) : (
                                    <span className="text-brick">Missing Player</span>
                                  )
                                ) : (
                                  <>
                                    {row.p1Valid ? (
                                      <span>{row.p1}</span>
                                    ) : (
                                      <span className="text-brick">Missing Player 1</span>
                                    )}
                                    <span className="mx-1.5 text-pickle font-mono">/</span>
                                    {row.p2Valid ? (
                                      <span>{row.p2}</span>
                                    ) : (
                                      <span className="text-brick">Missing Partner</span>
                                    )}
                                  </>
                                )}
                              </div>

                              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                                {row.bracketLetter && (
                                  <span className="rounded bg-charcoal px-1.5 py-0.5 font-mono text-[0.6rem] font-bold uppercase tracking-wider text-sand">
                                    Bracket {row.bracketLetter}
                                  </span>
                                )}
                                {hasCustomTeamName && (
                                  <span className="text-[0.68rem] font-medium text-muted-foreground truncate">
                                    {row.team?.name}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => openEditRow(row)}
                            className={`shrink-0 rounded border px-2.5 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider cursor-pointer ${
                              !row.isComplete
                                ? "border-brick bg-brick text-sand"
                                : "border-border bg-background text-foreground"
                            }`}
                          >
                            {row.hasTeam ? "Edit" : "+ Input"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>

      {/* ── Input / Edit Pair Modal ── */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
          onClick={() => setEditing(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border-2 border-border bg-card shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-charcoal px-5 py-4 flex items-center justify-between border-b border-border">
              <div>
                <span className="block text-[0.62rem] font-bold uppercase tracking-[0.25em] text-pickle">
                  {editing.categoryLabel}
                  {editing.bracketLetter ? ` • Bracket ${editing.bracketLetter}` : ""}
                </span>
                <h3 className="font-display text-2xl text-sand leading-tight mt-0.5">
                  {editing.mode === "add_to_category"
                    ? "Add Pair to Category"
                    : "Edit Pair"}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="rounded border border-sand/30 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider text-sand/80 hover:border-sand hover:text-sand cursor-pointer"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="p-5 space-y-4">
              <div className="space-y-1.5">
                <label className="block text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground">
                  {editing.isSingles ? "Player Full Name" : "Player 1 Full Name"}
                </label>
                <input
                  type="text"
                  value={editing.player1}
                  onChange={(e) =>
                    setEditing({ ...editing, player1: e.target.value })
                  }
                  placeholder="Enter full name"
                  autoFocus
                  className="w-full rounded border-2 border-border bg-background px-3 py-2.5 text-sm font-medium text-foreground focus:border-pickle focus:outline-none"
                />
              </div>

              {!editing.isSingles && (
                <div className="space-y-1.5">
                  <label className="block text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground">
                    Player 2 (Partner) Full Name
                  </label>
                  <input
                    type="text"
                    value={editing.player2}
                    onChange={(e) =>
                      setEditing({ ...editing, player2: e.target.value })
                    }
                    placeholder="Enter partner full name"
                    className="w-full rounded border-2 border-border bg-background px-3 py-2.5 text-sm font-medium text-foreground focus:border-pickle focus:outline-none"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <label className="block text-[0.68rem] font-bold uppercase tracking-widest text-muted-foreground">
                  Team Name (Optional)
                </label>
                <input
                  type="text"
                  value={editing.teamName}
                  onChange={(e) =>
                    setEditing({ ...editing, teamName: e.target.value })
                  }
                  placeholder="n/a"
                  className="w-full rounded border-2 border-border bg-background px-3 py-2.5 text-sm font-medium text-foreground focus:border-pickle focus:outline-none"
                />
              </div>

              <div className="pt-2 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="w-full sm:w-auto border border-border bg-charcoal px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-sand hover:border-pickle hover:text-pickle transition-colors rounded cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="w-full sm:w-auto bg-pickle px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-sand hover:opacity-90 transition-opacity rounded shadow cursor-pointer"
                >
                  Save Pair
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
