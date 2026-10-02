import { useState, useMemo } from "react";
import { X, Search, Users, Trophy, Shield, ChevronRight } from "lucide-react";
import { useTournamentStore } from "@/lib/tournament-store";
import type { Tournament, Category, Team } from "@/data/tournaments";

interface PlayerDirectoryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function PlayerDirectoryModal({ isOpen, onClose }: PlayerDirectoryModalProps) {
  const { tournaments } = useTournamentStore();
  const [selectedSlug, setSelectedSlug] = useState<string>(() => {
    return tournaments[0]?.slug ?? "";
  });
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Sync selected slug if not set
  const currentTournament: Tournament | undefined = useMemo(() => {
    if (!tournaments.length) return undefined;
    return tournaments.find((t) => t.slug === selectedSlug) || tournaments[0];
  }, [tournaments, selectedSlug]);

  const categories = useMemo(() => {
    return currentTournament?.categories ?? [];
  }, [currentTournament]);

  // Aggregate all teams from categories for the selected tournament
  const filteredTeams = useMemo(() => {
    if (!currentTournament) return [];

    let teamList: { team: Team; categoryLabel: string; division: string; level: string }[] = [];

    categories.forEach((cat) => {
      if (selectedCategory !== "all" && cat.id !== selectedCategory) {
        return;
      }
      cat.teams?.forEach((team) => {
        teamList.push({
          team,
          categoryLabel: cat.label,
          division: cat.division,
          level: cat.level,
        });
      });
    });

    const query = searchQuery.trim().toLowerCase();
    if (query) {
      teamList = teamList.filter(({ team, categoryLabel }) => {
        const teamNameMatch = team.name.toLowerCase().includes(query);
        const playerMatch = team.players?.some((p) => p.toLowerCase().includes(query));
        const clubMatch = team.club?.toLowerCase().includes(query);
        const catMatch = categoryLabel.toLowerCase().includes(query);
        return teamNameMatch || playerMatch || clubMatch || catMatch;
      });
    }

    return teamList;
  }, [currentTournament, categories, selectedCategory, searchQuery]);

  const totalPlayersInTournament = useMemo(() => {
    if (!currentTournament) return 0;
    return (
      currentTournament.categories?.reduce((acc, cat) => {
        const teamCount = cat.teams?.length || 0;
        const playersCount = cat.teams?.reduce(
          (pAcc, t) => pAcc + (t.players?.length || 2),
          0
        );
        return acc + (playersCount || teamCount * 2);
      }, 0) || 0
    );
  }, [currentTournament]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="player-directory-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-charcoal/90 backdrop-blur-md animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-3xl max-h-[90vh] bg-charcoal border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4 bg-charcoal/95 sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded bg-pickle/15 text-pickle border border-pickle/30">
              <Users size={20} />
            </div>
            <div>
              <span className="block text-[0.65rem] uppercase tracking-[0.28em] text-pickle font-bold">
                Player Directory
              </span>
              <h2 id="player-directory-title" className="font-display text-2xl sm:text-3xl text-sand">
                Tournament Rosters
              </h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-sand/60 hover:text-sand rounded-lg border border-border hover:border-pickle/50 transition-colors cursor-pointer"
            aria-label="Close player directory"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5 text-sand">
          {tournaments.length === 0 ? (
            <div className="p-10 text-center border border-border rounded-xl surface-card my-4">
              <Trophy size={36} className="mx-auto text-sand/40 mb-3" />
              <h3 className="font-display text-2xl text-sand">No Active Tournaments</h3>
              <p className="text-xs text-sand/60 mt-1 max-w-sm mx-auto">
                No tournament records are currently published. Check back soon or visit the tournament desk.
              </p>
            </div>
          ) : (
            <>
              {/* Step 1: Choose Tournament */}
              <div className="space-y-2">
                <label className="block text-xs uppercase tracking-widest text-sand/70 font-semibold">
                  Step 1: Choose Tournament
                </label>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {tournaments.map((t) => {
                    const isSelected = (currentTournament?.slug || "") === t.slug;
                    return (
                      <button
                        key={t.slug}
                        onClick={() => {
                          setSelectedSlug(t.slug);
                          setSelectedCategory("all");
                        }}
                        className={`flex-shrink-0 px-3.5 py-2 rounded-lg text-xs font-semibold tracking-wide border transition-all text-left cursor-pointer ${
                          isSelected
                            ? "border-pickle bg-pickle/15 text-sand ring-1 ring-pickle/40"
                            : "border-border bg-charcoal/40 text-sand/70 hover:border-sand/40 hover:text-sand"
                        }`}
                      >
                        <div className="font-display text-sm leading-tight">{t.name}</div>
                        <div className="text-[0.65rem] text-sand/60 flex items-center gap-2 mt-0.5">
                          <span>{t.date}</span>
                          <span>&middot;</span>
                          <span className="text-pickle font-bold uppercase tracking-wider">
                            {t.status}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Tournament Summary & Step 2: Search & Filter */}
              {currentTournament && (
                <div className="space-y-3 pt-2 border-t border-border">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <span className="text-xs uppercase tracking-widest text-sand/60 font-semibold block">
                        Step 2: Filter Players & Teams
                      </span>
                      <h3 className="font-display text-xl text-sand">
                        {currentTournament.name}
                      </h3>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-sand/70">
                      <span className="px-2 py-1 rounded bg-charcoal/60 border border-border">
                        {filteredTeams.length} {filteredTeams.length === 1 ? "Team" : "Teams"}
                      </span>
                      <span className="px-2 py-1 rounded bg-charcoal/60 border border-border">
                        {totalPlayersInTournament} Registered Players
                      </span>
                    </div>
                  </div>

                  {/* Search bar & Category filters */}
                  <div className="space-y-2">
                    <div className="relative">
                      <Search
                        size={16}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-sand/40"
                      />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search player name, partner, team, or club..."
                        className="w-full pl-9 pr-4 py-2.5 bg-charcoal/70 border border-border rounded-lg text-xs text-sand placeholder:text-sand/40 focus:outline-none focus:border-pickle"
                      />
                    </div>

                    {/* Category tabs */}
                    {categories.length > 0 && (
                      <div className="flex gap-1.5 overflow-x-auto pb-1 text-xs">
                        <button
                          onClick={() => setSelectedCategory("all")}
                          className={`px-3 py-1.5 rounded text-[0.7rem] uppercase tracking-wider font-bold transition-all cursor-pointer whitespace-nowrap ${
                            selectedCategory === "all"
                              ? "bg-brick text-sand"
                              : "border border-border text-sand/60 hover:text-sand hover:bg-charcoal/50"
                          }`}
                        >
                          All Categories ({currentTournament.teamsCount || 0})
                        </button>
                        {categories.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => setSelectedCategory(c.id)}
                            className={`px-3 py-1.5 rounded text-[0.7rem] uppercase tracking-wider font-bold transition-all cursor-pointer whitespace-nowrap ${
                              selectedCategory === c.id
                                ? "bg-brick text-sand"
                                : "border border-border text-sand/60 hover:text-sand hover:bg-charcoal/50"
                            }`}
                          >
                            {c.label} ({c.teams?.length || 0})
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Teams / Players Roster Grid */}
                  <div className="pt-2">
                    {filteredTeams.length === 0 ? (
                      <div className="p-8 text-center border border-dashed border-border rounded-lg bg-charcoal/20">
                        <p className="text-xs text-sand/60">
                          No players or teams found matching your selection.
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[360px] overflow-y-auto pr-1">
                        {filteredTeams.map(({ team, categoryLabel, division, level }) => (
                          <div
                            key={team.id}
                            className="p-3 border border-border rounded-lg bg-charcoal/40 hover:border-pickle/50 transition-colors flex flex-col justify-between"
                          >
                            <div>
                              <div className="flex items-center justify-between gap-2 mb-1.5">
                                <h4 className="font-semibold text-sm text-sand leading-snug truncate">
                                  {team.name}
                                </h4>
                                <span className="text-[0.6rem] font-bold uppercase tracking-wider px-2 py-0.5 rounded border border-pickle/40 text-pickle bg-pickle/10 whitespace-nowrap">
                                  {categoryLabel}
                                </span>
                              </div>

                              {/* Players */}
                              <div className="space-y-1 text-xs text-sand/90">
                                {team.players?.map((player, pIdx) => (
                                  <div key={pIdx} className="flex items-center gap-1.5">
                                    <span className="h-1.5 w-1.5 rounded-full bg-pickle flex-shrink-0" />
                                    <span className="font-medium">{player}</span>
                                    {pIdx === 0 && team.players.length > 1 && (
                                      <span className="text-[0.65rem] text-sand/40 font-mono">
                                        &amp;
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* Club / Division Footer */}
                            <div className="mt-2.5 pt-2 border-t border-border/50 flex items-center justify-between text-[0.65rem] text-sand/60">
                              <span className="truncate">
                                {team.club ? `Club: ${team.club}` : `${level} · ${division}`}
                              </span>
                              {team.paid && (
                                <span className="text-pickle font-bold uppercase tracking-widest text-[0.6rem]">
                                  Verified
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3 bg-charcoal/95 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 text-xs font-bold uppercase tracking-widest bg-pickle text-charcoal hover:bg-pickle/90 rounded transition-colors cursor-pointer"
          >
            Close Directory
          </button>
        </div>
      </div>
    </div>
  );
}
