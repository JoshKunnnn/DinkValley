import { useMemo, useState } from "react";
import type { Category, Team } from "@/data/tournaments";

/**
 * Large, forgiving search box for kids, elders, and players.
 * Matches team names and player names across categories.
 */
export function TeamFinder({
  categories,
  onPick,
}: {
  categories: Category[];
  onPick: (team: Team, categoryId: string) => void;
}) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const found: { team: Team; category: Category }[] = [];
    for (const c of categories) {
      for (const t of c.teams ?? []) {
        if (
          t.name.toLowerCase().includes(q) ||
          (t.players ?? []).some((p) => p.toLowerCase().includes(q))
        ) {
          found.push({ team: t, category: c });
        }
      }
    }
    return found.slice(0, 6);
  }, [query, categories]);

  const showNoResults = query.trim().length >= 2 && results.length === 0;

  return (
    <div className="rounded-2xl border-2 border-border bg-card p-4 sm:p-5">
      <label
        htmlFor="team-finder-input"
        className="block font-display text-xl sm:text-2xl text-foreground"
      >
        Find My Team
      </label>
      <p className="text-xs sm:text-sm text-foreground/70 mt-0.5">
        Type a player name or team name to find your court and matches.
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
          {results.map(({ team, category }) => (
            <li key={`${category.id}-${team.id}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(team, category.id);
                  setQuery("");
                }}
                className="w-full min-h-[3.75rem] rounded-xl border-2 border-pickle/40 bg-pickle/5 px-4 py-2.5 text-left hover:border-pickle hover:bg-pickle/15 cursor-pointer flex items-center justify-between gap-3 transition-colors"
              >
                <div className="min-w-0">
                  <span className="block truncate text-base sm:text-lg font-semibold text-foreground">
                    {team.name}
                  </span>
                  <span className="block truncate text-xs sm:text-sm text-foreground/65">
                    {category.label}
                    {team.players?.length ? ` · ${team.players.join(" & ")}` : ""}
                  </span>
                </div>
                <span className="shrink-0 text-xs sm:text-sm font-bold uppercase tracking-wider text-pickle">
                  Show Matches &rsaquo;
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {showNoResults && (
        <p className="mt-3 rounded-xl bg-foreground/5 px-4 py-2.5 text-xs sm:text-sm text-foreground/75">
          No team found with that name. Check spelling or try searching first name.
        </p>
      )}
    </div>
  );
}
