import { useState, useEffect, useCallback } from "react";
import type { Tournament, Category, Team } from "@/data/tournaments";
import {
  dbGetTournaments,
  dbSaveTournament,
  dbDeleteTournament,
  dbDeleteTeam,
  dbDeleteAllTeamsInCategory,
  dbDeleteDrawnGroups,
  dbSubscribeToLive,
} from "@/lib/supabase-service";
import { supabase } from "@/integrations/supabase/client";
import {
  purgeQueueForCategory,
  purgeQueueForTeam,
  purgeQueueForTournament,
} from "@/lib/court-dispatch";
import {
  purgeMatchesForCategory,
  purgeMatchesForTeam,
  purgeMatchesForTournament,
} from "@/lib/match-store";

// Offline backup storage key only used when disconnected from internet
const OFFLINE_BACKUP_KEY = "dv_tournaments_offline_cache";

// Global in-memory authority
let _memoryTournaments: Tournament[] | null = null;
let _isInitialFetchDone = false;
let _isSyncing = false;
let _hasQueuedSync = false;
let _syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function readOfflineBackup(): Tournament[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(OFFLINE_BACKUP_KEY) || localStorage.getItem("dv_tournaments");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Tournament[]) : [];
  } catch {
    return [];
  }
}

function writeOfflineBackup(tournaments: Tournament[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OFFLINE_BACKUP_KEY, JSON.stringify(tournaments));
  } catch {
    // ignore
  }
}

/**
 * Synchronous tournament getter.
 * Returns the active in-memory list or offline fallback.
 */
export function getTournaments(): Tournament[] {
  if (_memoryTournaments !== null) {
    return _memoryTournaments;
  }
  const fallback = readOfflineBackup();
  _memoryTournaments = fallback;
  return fallback;
}

/**
 * Save tournaments to memory and offline cache, and notify components.
 */
export function saveTournaments(tournaments: Tournament[]): void {
  _memoryTournaments = tournaments;
  writeOfflineBackup(tournaments);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("dv_tournaments_updated"));
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
 * Create and add a new tournament directly to the database.
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

  // Persist directly to Supabase
  dbSaveTournament(newTournament)
    .then((ok) => {
      if (!ok) {
        console.warn("[Database] Tournament creation queued, verify cloud permissions.");
      }
    })
    .catch((err) => {
      console.warn("[Database] Cloud save notice:", err);
    });

  return newTournament;
}

/**
 * Update an existing tournament directly in the database.
 */
export function updateTournament(slug: string, updates: Partial<Tournament>): Tournament | undefined {
  const current = getTournaments();
  const index = current.findIndex((t) => t.slug === slug);
  if (index === -1) return undefined;

  const oldSlug = current[index]!.slug;
  const updatedItem: Tournament = {
    ...current[index]!,
    ...updates,
    teamsCount: updates.categories
      ? updates.categories.reduce((acc, c) => acc + (c.teams?.length || 0), 0)
      : current[index]!.teamsCount,
  };

  current[index] = updatedItem;
  saveTournaments([...current]);

  // If slug was changed, delete the old slug record from Supabase
  if (updates.slug && updates.slug !== oldSlug) {
    dbDeleteTournament(oldSlug).catch(() => {});
  }

  // Persist directly to Supabase
  dbSaveTournament(updatedItem).catch((err) => {
    console.warn("[Database] Cloud update notice:", err);
  });

  return updatedItem;
}

/**
 * Delete a tournament permanently directly from Supabase and active dispatch/match stores.
 */
export function deleteTournament(slug: string): boolean {
  const cleanSlug = slug.trim();
  if (!cleanSlug) return false;

  // 1. Clean up associated matches, queues, and court station locks
  purgeMatchesForTournament(cleanSlug);
  purgeQueueForTournament(cleanSlug);

  // 2. Remove from active memory list and dispatch sync event
  const current = getTournaments();
  const filtered = current.filter((t) => t.slug !== cleanSlug);
  saveTournaments(filtered);

  // 3. Immediately delete from Supabase database
  dbDeleteTournament(cleanSlug)
    .then((ok) => {
      if (!ok) {
        console.warn("[Database] Cloud deletion notice for", cleanSlug);
      }
    })
    .catch((err) => {
      console.warn("[Database] Failed to delete tournament from cloud:", err);
    });

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
 * All added teams are confirmed in the roster with paid status by default.
 */
export function addTeamToCategory(tournamentSlug: string, categoryId: string, team: Team): Tournament | undefined {
  const current = getTournaments();
  const tournament = current.find((t) => t.slug === tournamentSlug);
  if (!tournament) return undefined;

  const normalizedTeam: Team = {
    ...team,
    paid: team.paid ?? true,
    paymentStatus: team.paymentStatus ?? "Verified",
  };

  const categories = tournament.categories.map((c) => {
    if (c.id === categoryId) {
      const teams = [...c.teams.filter((t) => t.id !== team.id), normalizedTeam];
      return { ...c, teams };
    }
    return c;
  });

  return updateTournament(tournamentSlug, { categories });
}

/**
 * Add a team registration directly into category teams (legacy pending route now adds directly).
 */
export function addPendingRegistration(tournamentSlug: string, categoryId: string, team: Team): Tournament | undefined {
  return addTeamToCategory(tournamentSlug, categoryId, team);
}

/**
 * Approve a pending registration (retained for backward compatibility).
 */
export function approvePendingRegistration(tournamentSlug: string, categoryId: string, teamId: string): Tournament | undefined {
  const current = getTournaments();
  const tournament = current.find((t) => t.slug === tournamentSlug);
  if (!tournament) return undefined;

  const categories = tournament.categories.map((c) => {
    if (c.id === categoryId) {
      const teams = c.teams.map((t) =>
        t.id === teamId ? { ...t, paid: true, paymentStatus: "Verified" as const } : t
      );
      return { ...c, teams };
    }
    return c;
  });

  return updateTournament(tournamentSlug, { categories });
}

/**
 * Reject / decline a team registration.
 */
export function rejectPendingRegistration(tournamentSlug: string, categoryId: string, teamId: string): Tournament | undefined {
  return removeTeamFromCategory(tournamentSlug, categoryId, teamId);
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
    console.warn("[Database] Failed to delete team:", err);
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
  purgeMatchesForCategory(tournamentSlug, categoryId, true);

  // Delete drawn groups and teams from Supabase
  dbDeleteDrawnGroups(tournamentSlug, categoryId).catch(() => {});
  dbDeleteAllTeamsInCategory(tournamentSlug, categoryId).catch((err) => {
    console.warn("[Database] Failed to delete category teams:", err);
  });

  return bulkSetTeamsInCategory(tournamentSlug, categoryId, []);
}

/**
 * React hook to access and synchronize tournament state.
 * Uses database-first architecture and real-time updates as long as internet is available.
 */
export function useTournamentStore() {
  const [tournaments, setTournaments] = useState<Tournament[]>(() => getTournaments());
  const [isLoading, setIsLoading] = useState(!_isInitialFetchDone);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const syncFromCloud = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return;
    }
    if (_isSyncing) {
      _hasQueuedSync = true;
      return;
    }
    _isSyncing = true;
    try {
      const cloudTournaments = await dbGetTournaments();
      // If cloud fetch failed (query error, rate limit, abort), retain active memory & storage!
      if (cloudTournaments === null) {
        return;
      }
      // If cloud returned empty array, but we currently have tournaments in memory,
      // do not wipe active memory state due to a transient cloud read or blip!
      if (cloudTournaments.length === 0 && _memoryTournaments && _memoryTournaments.length > 0) {
        return;
      }

      _memoryTournaments = cloudTournaments;
      writeOfflineBackup(cloudTournaments);
      setTournaments(cloudTournaments);
      setLastSyncedAt(new Date());
      _isInitialFetchDone = true;
    } catch (err) {
      console.warn("[TournamentStore] Sync failed, maintaining active memory state:", err);
    } finally {
      _isSyncing = false;
      setIsLoading(false);
      if (_hasQueuedSync) {
        _hasQueuedSync = false;
        setTimeout(() => syncFromCloud(), 150);
      }
    }
  }, []);

  const debouncedSync = useCallback(() => {
    if (_syncDebounceTimer) {
      clearTimeout(_syncDebounceTimer);
    }
    _syncDebounceTimer = setTimeout(() => {
      syncFromCloud();
    }, 300);
  }, [syncFromCloud]);

  const refresh = useCallback(() => {
    setTournaments(getTournaments());
    syncFromCloud();
  }, [syncFromCloud]);

  useEffect(() => {
    let mounted = true;

    // Track online / offline status
    const handleOnline = () => {
      setIsOnline(true);
      debouncedSync();
    };
    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Initial fetch from database
    syncFromCloud().then(() => {
      if (mounted) setIsLoading(false);
    });

    // Re-sync when tab visibility is restored
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        debouncedSync();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    // Supabase channel explicitly listening to tournament, category, and team changes
    // (debounced so rapid multi-table updates don't cause thundering-herd refetches)
    let directTourneyChannel: ReturnType<typeof supabase.channel> | null = null;
    try {
      directTourneyChannel = supabase
        .channel(`tourney-realtime-${Date.now()}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "tournaments" }, () => {
          if (mounted) debouncedSync();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "categories" }, () => {
          if (mounted) debouncedSync();
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "teams" }, () => {
          if (mounted) debouncedSync();
        })
        .subscribe();
    } catch {
      // ignore
    }

    // Listen for same-window updates
    const handleLocalUpdate = () => {
      setTournaments(getTournaments());
    };
    window.addEventListener("dv_tournaments_updated", handleLocalUpdate);

    return () => {
      mounted = false;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("dv_tournaments_updated", handleLocalUpdate);

      if (_syncDebounceTimer) {
        clearTimeout(_syncDebounceTimer);
      }
      if (directTourneyChannel) {
        try {
          supabase.removeChannel(directTourneyChannel);
        } catch {
          // ignore
        }
      }
    };
  }, [syncFromCloud, debouncedSync]);

  return {
    tournaments,
    isLoading,
    isOnline,
    lastSyncedAt,
    refresh,
    syncFromCloud,
    addTournament,
    updateTournament,
    deleteTournament,
    addCategoryToTournament,
    addTeamToCategory,
  };
}
