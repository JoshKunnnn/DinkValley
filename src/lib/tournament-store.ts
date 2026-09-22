import { useState, useEffect, useCallback } from "react";
import type { Tournament, Category, Team } from "@/data/tournaments";
import {
  dbGetTournaments,
  dbSaveTournament,
  dbDeleteTournament,
  dbDeleteTeam,
  dbDeleteAllTeamsInCategory,
  dbSubscribeToLive,
} from "@/lib/supabase-service";
import {
  purgeQueueForCategory,
  purgeQueueForTeam,
} from "@/lib/court-dispatch";
import {
  purgeMatchesForCategory,
  purgeMatchesForTeam,
} from "@/lib/match-store";

const STORAGE_KEY = "dv_tournaments";

/**
 * Get all tournaments stored in localStorage.
 * Defaults to an empty list (clean slate with no preloaded mock tournaments).
 */
export function getTournaments(): Tournament[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as Tournament[];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Persist tournaments to localStorage and dispatch custom event for instant tab sync.
 */
export function saveTournaments(tournaments: Tournament[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tournaments));
    window.dispatchEvent(new Event("dv_tournaments_updated"));
  } catch (err) {
    console.error("Failed to save tournaments", err);
  }
}

/**
 * Find a tournament by slug.
 */
export function getTournament(slug: string): Tournament | undefined {
  const all = getTournaments();
  return all.find((t) => t.slug === slug);
}

/**
 * Helper to slugify a tournament name.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type NewTournamentInput = {
  name: string;
  slug?: string;
  tagline: string;
  status: "Registration open" | "Live" | "Completed";
  date: string;
  venue: string;
  city: string;
  entryFee?: string;
  format: string;
  categories: Category[];
  schedule?: { time: string; title: string; detail: string }[];
  rules?: string[];
};

/**
 * Create and add a new tournament.
 */
export function addTournament(input: NewTournamentInput): Tournament {
  const current = getTournaments();
  const slug = input.slug?.trim() ? slugify(input.slug) : slugify(input.name);

  // Avoid duplicate slug
  let uniqueSlug = slug;
  let counter = 1;
  while (current.some((t) => t.slug === uniqueSlug)) {
    uniqueSlug = `${slug}-${counter}`;
    counter++;
  }

  const newTournament: Tournament = {
    slug: uniqueSlug,
    name: input.name.trim(),
    tagline: input.tagline.trim(),
    status: input.status,
    date: input.date.trim(),
    venue: input.venue.trim(),
    city: input.city.trim(),
    entryFee: input.entryFee?.trim() || undefined,
    format: input.format.trim(),
    teamsCount: input.categories.reduce((acc, c) => acc + (c.teams?.length || 0), 0),
    categories: input.categories,
    schedule: input.schedule || [
      { time: "7:00 AM", title: "Check-in", detail: "Player briefing and court assignments" },
      { time: "8:00 AM", title: "Matches begin", detail: "Courts 1-4" },
    ],
    rules: input.rules || [
      "Standard side-out scoring to 11, win by 2.",
      "Matches strictly assigned to Courts 1 to 4; on-deck teams hold in Queue.",
      "Players must report courtside within 5 minutes of dispatch call.",
    ],
  };

  const updated = [newTournament, ...current];
  saveTournaments(updated);
  // Async sync to Supabase
  dbSaveTournament(newTournament).catch((err) =>
    console.warn("[Supabase] Failed to persist new tournament:", err)
  );
  return newTournament;
}

/**
 * Update an existing tournament.
 */
export function updateTournament(slug: string, updates: Partial<Tournament>): Tournament | undefined {
  const current = getTournaments();
  const index = current.findIndex((t) => t.slug === slug);
  if (index === -1) return undefined;

  const updatedItem: Tournament = {
    ...current[index]!,
    ...updates,
    teamsCount: updates.categories
      ? updates.categories.reduce((acc, c) => acc + (c.teams?.length || 0), 0)
      : current[index]!.teamsCount,
  };

  current[index] = updatedItem;
  saveTournaments(current);
  // Async sync to Supabase
  dbSaveTournament(updatedItem).catch((err) =>
    console.warn("[Supabase] Failed to persist updated tournament:", err)
  );
  return updatedItem;
}

/**
 * Delete a tournament.
 */
export function deleteTournament(slug: string): boolean {
  const current = getTournaments();
  const filtered = current.filter((t) => t.slug !== slug);
  if (filtered.length === current.length) return false;
  saveTournaments(filtered);
  // Async sync to Supabase
  dbDeleteTournament(slug).catch((err) =>
    console.warn("[Supabase] Failed to delete tournament from cloud:", err)
  );
  return true;
}

/**
 * Add a category to a tournament.
 */
export function addCategoryToTournament(tournamentSlug: string, category: Category): Tournament | undefined {
  const current = getTournaments();
  const tournament = current.find((t) => t.slug === tournamentSlug);
  if (!tournament) return undefined;

  const categories = [...tournament.categories, category];
  return updateTournament(tournamentSlug, { categories });
}

/**
 * Add a team to a specific category within a tournament.
 */
export function addTeamToCategory(tournamentSlug: string, categoryId: string, team: Team): Tournament | undefined {
  const current = getTournaments();
  const tournament = current.find((t) => t.slug === tournamentSlug);
  if (!tournament) return undefined;

  const categories = tournament.categories.map((c) => {
    if (c.id === categoryId) {
      const teams = [...c.teams, team];
      return { ...c, teams };
    }
    return c;
  });

  return updateTournament(tournamentSlug, { categories });
}

/**
 * Remove a team from a specific category within a tournament.
 */
export function removeTeamFromCategory(tournamentSlug: string, categoryId: string, teamId: string): Tournament | undefined {
  const current = getTournaments();
  const tournament = current.find((t) => t.slug === tournamentSlug);
  if (!tournament) return undefined;

  let removedTeamName: string | undefined;

  const categories = tournament.categories.map((c) => {
    if (c.id === categoryId) {
      const targetTeam = c.teams.find((t) => t.id === teamId);
      if (targetTeam) {
        removedTeamName = targetTeam.name;
      }
      const teams = c.teams.filter((t) => t.id !== teamId);
      return { ...c, teams };
    }
    return c;
  });

  if (removedTeamName) {
    // Auto delete matches in queue and active matches involving this deleted team
    purgeQueueForTeam(tournamentSlug, categoryId, removedTeamName);
    purgeMatchesForTeam(tournamentSlug, categoryId, removedTeamName);
  }

  // Delete from Supabase in background
  dbDeleteTeam(teamId).catch((err) => {
    console.warn("[Supabase] Failed to delete team:", err);
  });

  return updateTournament(tournamentSlug, { categories });
}

/**
 * Update a team (e.g. payment status, proof url) in a tournament.
 */
export function updateTeamInTournament(
  tournamentSlug: string,
  categoryId: string,
  teamId: string,
  updates: Partial<Team>
): Tournament | undefined {
  const current = getTournaments();
  const tournament = current.find((t) => t.slug === tournamentSlug);
  if (!tournament) return undefined;

  const categories = tournament.categories.map((c) => {
    if (c.id === categoryId) {
      const teams = c.teams.map((t) => (t.id === teamId ? { ...t, ...updates } : t));
      return { ...c, teams };
    }
    return c;
  });

  return updateTournament(tournamentSlug, { categories });
}

/**
 * Bulk set or replace teams in a specific category within a tournament.
 */
export function bulkSetTeamsInCategory(
  tournamentSlug: string,
  categoryId: string,
  teams: Team[]
): Tournament | undefined {
  const current = getTournaments();
  const tournament = current.find((t) => t.slug === tournamentSlug);
  if (!tournament) return undefined;

  const categories = tournament.categories.map((c) => {
    if (c.id === categoryId) {
      return { ...c, teams };
    }
    return c;
  });

  return updateTournament(tournamentSlug, { categories });
}

/**
 * Delete all teams from a specific category within a tournament.
 * Also cleans up any drawn bracket cache for this category and
 * automatically purges all corresponding matches in the dispatch queue.
 */
export function deleteAllTeamsInCategory(
  tournamentSlug: string,
  categoryId: string
): Tournament | undefined {
  try {
    localStorage.removeItem(`dv_drawn_groups_${tournamentSlug}_${categoryId}`);
  } catch {
    // ignore
  }

  // Auto delete matches in queue and active matches for this category
  purgeQueueForCategory(tournamentSlug, categoryId);
  purgeMatchesForCategory(tournamentSlug, categoryId);

  // Delete from Supabase in background
  dbDeleteAllTeamsInCategory(tournamentSlug, categoryId).catch((err) => {
    console.warn("[Supabase] Failed to delete category teams:", err);
  });

  return bulkSetTeamsInCategory(tournamentSlug, categoryId, []);
}

/**
 * React hook to access and synchronize tournament state.
 */
export function useTournamentStore() {
  const [tournaments, setTournaments] = useState<Tournament[]>(() => getTournaments());

  const refresh = useCallback(() => {
    setTournaments(getTournaments());
  }, []);

  useEffect(() => {
    refresh();

    const mergeWithLocal = (cloudTournaments: Tournament[]) => {
      const local = getTournaments();
      if (!cloudTournaments || cloudTournaments.length === 0) return local;
      if (!local || local.length === 0) return cloudTournaments;

      return cloudTournaments.map((cloudT) => {
        const localT = local.find((l) => l.slug === cloudT.slug);
        if (!localT) return cloudT;

        const categories = cloudT.categories.map((cloudC) => {
          const localC = localT.categories.find((lc) => lc.id === cloudC.id);
          if (!localC) return cloudC;

          // If database returned teams array, database is the source of truth
          const teams = Array.isArray(cloudC.teams) ? cloudC.teams : localC.teams || [];

          // If teams were deleted from database, auto purge corresponding matches
          if (localC.teams && localC.teams.length > teams.length) {
            if (teams.length === 0) {
              purgeQueueForCategory(cloudT.slug, cloudC.id);
              purgeMatchesForCategory(cloudT.slug, cloudC.id);
            } else {
              const currentNames = new Set(teams.map((t) => t.name.trim().toLowerCase()));
              const removedTeams = localC.teams.filter(
                (lt) => !currentNames.has(lt.name.trim().toLowerCase())
              );
              for (const rt of removedTeams) {
                purgeQueueForTeam(cloudT.slug, cloudC.id, rt.name);
                purgeMatchesForTeam(cloudT.slug, cloudC.id, rt.name);
              }
            }
          }

          return {
            ...cloudC,
            teams,
          };
        });

        return {
          ...cloudT,
          categories,
          teamsCount: categories.reduce((sum, c) => sum + (c.teams?.length || 0), 0),
        };
      });
    };

    // Fetch from Supabase and hydrate local store
    let mounted = true;
    dbGetTournaments()
      .then((cloudTournaments) => {
        if (mounted && cloudTournaments.length > 0) {
          const merged = mergeWithLocal(cloudTournaments);
          saveTournaments(merged);
          setTournaments(merged);
        }
      })
      .catch((err) => {
        console.warn("[TournamentStore] Cloud fetch failed, using local data:", err);
      });

    // Listen for realtime changes (wrapped so subscription errors don't crash the UI)
    let unsubRealtime: (() => void) | null = null;
    try {
      unsubRealtime = dbSubscribeToLive(
        () => {
          dbGetTournaments()
            .then((cloudTournaments) => {
              if (mounted && cloudTournaments.length > 0) {
                const merged = mergeWithLocal(cloudTournaments);
                saveTournaments(merged);
                setTournaments(merged);
              }
            })
            .catch(() => {});
        },
        () => {}
      );
    } catch (err) {
      console.warn("[TournamentStore] Realtime subscription failed:", err);
    }

    // Listen for storage events across tabs
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        refresh();
      }
    };

    // Listen for same-window updates
    const handleCustom = () => {
      refresh();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("dv_tournaments_updated", handleCustom);

    return () => {
      mounted = false;
      if (unsubRealtime) {
        try {
          unsubRealtime();
        } catch {
          // already cleaned up
        }
      }
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("dv_tournaments_updated", handleCustom);
    };
  }, [refresh]);

  return {
    tournaments,
    refresh,
    addTournament,
    updateTournament,
    deleteTournament,
    addCategoryToTournament,
    addTeamToCategory,
  };
}
