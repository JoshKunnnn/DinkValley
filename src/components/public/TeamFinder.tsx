import { useEffect, useMemo, useState } from "react";
import type { Category, Team } from "@/data/tournaments";
import { getDrawnGroups, type BracketGroup } from "@/components/admin/BracketDraw";
import { dbGetDrawnGroups } from "@/lib/supabase-service";

type FinderResult = {
  team: Team;
  category: Category;
  bracketLetter: string | null;
  matchedPlayer: string | null;
};

/**
 * Large, forgiving search box for kids, elders, and players.
 * Matches team names and player names across categories and tells the
 * player which bracket (group) they were drawn into.
 */
export function TeamFinder({
  categories,
  tournamentSlug,
  onPick,
}: {
  categories: Category[];
  tournamentSlug: string;
  onPick: (team: Team, categoryId: string, bracketLetter: string | null) => void;
}) {
  const [query, setQuery] = useState("");

  // Drawn groups per category (read-only). Seeded from local cache, then refreshed from the database.
  const [groupsByCat, setGroupsByCat] = useState<Record<string, BracketGroup[] | null>>(() => {
    const initial: Record<string, BracketGroup[] | null> = {};
    for (const c of categories) initial[c.id] = getDrawnGroups(tournamentSlug, c.id);
    return initial;
  });

  useEffect(() => {
    let mounted = true;

    const refreshFromCache = () => {
      const next: Record<string, BracketGroup[] | null> = {};
      for (const c of categories) next[c.id] = getDrawnGroups(tournamentSlug, c.id);
      if (mounted) setGroupsByCat(next);
    };

    refreshFromCache();

    categories.forEach((c) => {
      dbGetDrawnGroups(tournamentSlug, c.id)
        .then((grps) => {
          if (!mounted || !grps || grps.length === 0) return;
          setGroupsByCat((prev) => ({ ...prev, [c.id]: grps as BracketGroup[] }));
        })
        .catch(() => {});
    });

    window.addEventListener("dv_drawn_groups_updated", refreshFromCache);
    return () => {
      mounted = false;
      window.removeEventListener("dv_drawn_groups_updated", refreshFromCache);
    };
  }, [tournamentSlug, categories]);

  const results = useMemo<FinderResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];

    const found: FinderResult[] = [];
    for (const c of categories) {
      const groups = groupsByCat[c.id] ?? [];

      // Map team name -> bracket letter for this category
      const letterByTeam = new Map<string, string>();
      const drawnTeams: Team[] = [];
      groups.forEach((g) => {
        g.slots.forEach((s) => {
          if (s.team) {
            letterByTeam.set(s.team.name.toLowerCase(), g.letter);
            drawnTeams.push(s.team);
          }
        });
      });

      // Combine registered roster with drawn teams (draw may exist while roster is empty)
      const seen = new Set<string>();
      const pool: Team[] = [];
      [...(c.teams ?? []), ...drawnTeams].forEach((t) => {
        const key = t.name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        pool.push(t);
      });

      for (const t of pool) {
        const nameHit = t.name.toLowerCase().includes(q);
        const playerHit = (t.players ?? []).find((p) => p.toLowerCase().includes(q)) ?? null;
        if (nameHit || playerHit) {
          found.push({
            team: t,
            category: c,
            bracketLetter: letterByTeam.get(t.name.toLowerCase()) ?? null,
            matchedPlayer: playerHit,
          });
        }
      }
    }
    return found.slice(0, 8);
  }, [query, categories, groupsByCat]);

  const showNoResults = query.trim().length >= 2 && results.length === 0;

  return (
    <div className="rounded-2xl border-2 border-border bg-card p-4 sm:p-5">
      <label
        htmlFor="team-finder-input"
        className="block font-display text-xl sm:text-2xl text-foreground"
      >
        Find My Bracket
      </label>
      <p className="text-xs sm:text-sm text-foreground/70 mt-0.5">
        Type your name or team name to see which bracket you are in.
      </p>

      <div className="mt-3 flex gap-2">
        <input
          id="team-finder-input"
          type="search"
          inputMode="search"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Example: Juan, Maria, or Smashers"
          className="min-h-[3.25rem] w-full rounded-xl border-2 border-border bg-background px-4 text-base sm:text-lg text-foreground placeholder:text-foreground/40 focus:border-pickle focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="min-h-[3.25rem] shrink-0 rounded-xl border-2 border-border px-4 text-xs sm:text-sm font-bold uppercase tracking-wider text-foreground hover:border-foreground/40 cursor-pointer"
          >
            Clear
          </button>
        )}
      </div>

      {results.length > 0 && (
        <ul className="mt-3 space-y-2">
          {results.map(({ team, category, bracketLetter, matchedPlayer }) => (
            <li key={`${category.id}-${team.id}-${team.name}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(team, category.id, bracketLetter);
                  setQuery("");
                }}
                className="w-full min-h-[4rem] rounded-xl border-2 border-pickle/40 bg-pickle/5 px-3 sm:px-4 py-2.5 text-left hover:border-pickle hover:bg-pickle/15 cursor-pointer flex items-center gap-3 transition-colors"
              >
                {/* Bracket badge */}
                <div
                  className={`shrink-0 w-16 sm:w-20 rounded-lg border-2 px-1 py-1.5 text-center ${
                    bracketLetter
                      ? "border-pickle bg-pickle text-sand"
                      : "border-border bg-background text-foreground/60"
                  }`}
                >
                  <span className="block text-[0.55rem] sm:text-[0.6rem] font-bold uppercase tracking-widest">
                    Bracket
                  </span>
                  <span className="block font-display text-2xl sm:text-3xl leading-none mt-0.5">
                    {bracketLetter ?? "TBD"}
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <span className="block truncate text-base sm:text-lg font-semibold text-foreground">
                    {team.name}
                  </span>
                  {team.players?.length ? (
                    <span className="block truncate text-xs sm:text-sm text-foreground/75">
                      {team.players.map((p, i) => (
                        <span key={`${p}-${i}`}>
                          {i > 0 && " & "}
                          <span className={matchedPlayer === p ? "font-bold text-pickle" : ""}>{p}</span>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className="block truncate text-[0.7rem] sm:text-xs text-foreground/60 mt-0.5">
                    {category.label}
                    {!bracketLetter && " \u2014 Bracket not drawn yet"}
                  </span>
                </div>

                <span className="hidden sm:inline shrink-0 text-xs sm:text-sm font-bold uppercase tracking-wider text-pickle">
                  View Bracket &rsaquo;
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {showNoResults && (
        <p className="mt-3 rounded-xl bg-foreground/5 px-4 py-2.5 text-xs sm:text-sm text-foreground/75">
          No player or team found with that name. Check spelling or try your first name only.
        </p>
      )}
    </div>
  );
}
