import { supabase } from "@/integrations/supabase/client";
import type { Tournament, Category, Team } from "@/data/tournaments";
import type { LiveMatch, LiveScore } from "@/lib/match-store";

/**
 * Fetch all tournaments from Supabase, including categories and teams.
 */
export async function dbGetTournaments(): Promise<Tournament[]> {
  try {
    const { data: dbTournaments, error } = await supabase
      .from("tournaments")
      .select(`
        *,
        categories (
          *,
          teams (*)
        )
      `)
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("[Supabase] Failed to fetch tournaments, using fallback:", error.message);
      return [];
    }

    if (!dbTournaments || dbTournaments.length === 0) {
      return [];
    }

    return dbTournaments.map((t) => {
      const categories: Category[] = (t.categories || []).map((c: any) => {
        const teams: Team[] = (c.teams || []).map((tm: any) => ({
          id: tm.id,
          name: tm.name,
          players: Array.isArray(tm.players) ? tm.players : [],
          club: tm.club || undefined,
          paid: Boolean(tm.paid),
          paymentProofUrl: tm.payment_proof_url || undefined,
          paymentRef: tm.payment_ref || undefined,
          paymentStatus: (tm.payment_status as Team["paymentStatus"]) || "Pending",
        }));

        return {
          id: c.category_slug || c.id,
          label: c.label,
          level: c.level as Category["level"],
          division: c.division as Category["division"],
          fee: c.entry_fee || undefined,
          teams,
          pools: [],
          standings: [],
          playoffs: [],
        };
      });

      const parsedRules: string[] = Array.isArray(t.rules) ? (t.rules as string[]) : [];
      const parsedSchedule = Array.isArray(t.schedule)
        ? (t.schedule as { time: string; title: string; detail: string }[])
        : [];

      return {
        slug: t.slug,
        name: t.name,
        tagline: t.tagline || "",
        status: (t.status as Tournament["status"]) || "Registration open",
        date: t.date || "TBD",
        venue: t.venue || "Santiago City",
        city: t.city || "Santiago City",
        entryFee: t.entry_fee || undefined,
        format: t.format || "Round robin pools, top 4 advance to playoffs",
        teamsCount: categories.reduce((acc, c) => acc + c.teams.length, 0),
        categories,
        schedule: parsedSchedule,
        rules: parsedRules,
      };
    });
  } catch (err) {
    console.warn("[Supabase] Unexpected error fetching tournaments:", err);
    return [];
  }
}

/**
 * Insert or update a tournament in Supabase.
 */
export async function dbSaveTournament(t: Tournament): Promise<boolean> {
  try {
    // 1. Upsert tournament header
    const { data: tourneyRow, error: tErr } = await supabase
      .from("tournaments")
      .upsert(
        {
          slug: t.slug,
          name: t.name,
          tagline: t.tagline,
          status: t.status,
          date: t.date,
          venue: t.venue,
          city: t.city,
          entry_fee: t.entryFee || null,
          format: t.format,
          rules: t.rules,
          schedule: t.schedule,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "slug" }
      )
      .select("id")
      .single();

    if (tErr || !tourneyRow) {
      console.error("[Supabase] Error saving tournament:", tErr);
      return false;
    }

    const tournamentId = tourneyRow.id;

    // 2. Upsert categories
    for (const cat of t.categories) {
      const { data: catRow, error: cErr } = await supabase
        .from("categories")
        .upsert(
          {
            tournament_id: tournamentId,
            category_slug: cat.id,
            label: cat.label,
            level: cat.level,
            division: cat.division,
            entry_fee: cat.fee || null,
          },
          { onConflict: "tournament_id,category_slug" }
        )
        .select("id")
        .single();

      if (cErr || !catRow) {
        console.error("[Supabase] Error saving category:", cErr);
        continue;
      }

      // 3. Sync teams: remove previous teams for this category and insert current roster
      await supabase.from("teams").delete().eq("category_id", catRow.id);

      if (cat.teams && cat.teams.length > 0) {
        const isUuid = (id?: string) =>
          id ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) : false;

        const teamsToInsert = cat.teams.map((tm) => ({
          ...(isUuid(tm.id) ? { id: tm.id } : {}),
          tournament_id: tournamentId,
          category_id: catRow.id,
          name: tm.name,
          players: Array.isArray(tm.players) ? tm.players : [],
          club: tm.club || null,
          paid: Boolean(tm.paid),
          payment_proof_url: tm.paymentProofUrl || null,
          payment_ref: tm.paymentRef || null,
          payment_status: tm.paymentStatus || "Pending",
        }));

        const { error: teamErr } = await supabase.from("teams").insert(teamsToInsert);

        if (teamErr) {
          console.error("[Supabase] Error saving teams:", teamErr);
        }
      }
    }

    return true;
  } catch (err) {
    console.error("[Supabase] Unexpected error saving tournament:", err);
    return false;
  }
}

/**
 * Delete a tournament from Supabase by slug.
 */
export async function dbDeleteTournament(slug: string): Promise<boolean> {
  try {
    const { error } = await supabase.from("tournaments").delete().eq("slug", slug);
    if (error) {
      console.error("[Supabase] Error deleting tournament:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[Supabase] Unexpected error deleting tournament:", err);
    return false;
  }
}

/**
 * Delete all teams belonging to a specific category from Supabase.
 */
export async function dbDeleteAllTeamsInCategory(
  tournamentSlug: string,
  categorySlug: string
): Promise<boolean> {
  try {
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id")
      .eq("slug", tournamentSlug)
      .maybeSingle();

    if (!tourney) return false;

    const { data: cat } = await supabase
      .from("categories")
      .select("id")
      .eq("tournament_id", tourney.id)
      .eq("category_slug", categorySlug)
      .maybeSingle();

    if (!cat) return false;

    const { error } = await supabase.from("teams").delete().eq("category_id", cat.id);
    if (error) {
      console.error("[Supabase] Error deleting teams from category:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[Supabase] Unexpected error deleting category teams:", err);
    return false;
  }
}

/**
 * Delete an individual team from Supabase by its ID.
 */
export async function dbDeleteTeam(teamId: string): Promise<boolean> {
  try {
    const { error } = await supabase.from("teams").delete().eq("id", teamId);
    if (error) {
      console.warn("[Supabase] Error deleting team:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Supabase] Unexpected error deleting team:", err);
    return false;
  }
}

/**
 * Delete all non-final matches for a specific category from Supabase.
 */
export async function dbDeleteMatchesForCategory(
  tournamentSlug: string,
  categoryId: string
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("matches")
      .delete()
      .eq("tournament_slug", tournamentSlug)
      .eq("category_id", categoryId)
      .neq("status", "final");
    if (error) {
      console.warn("[Supabase] Error deleting category matches:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Supabase] Unexpected error deleting category matches:", err);
    return false;
  }
}

/**
 * Fetch matches from Supabase.
 * If tournamentSlug is provided, filters by tournament; otherwise returns all active matches.
 */
export async function dbGetMatches(tournamentSlug?: string): Promise<LiveMatch[]> {
  try {
    let query = supabase.from("matches").select("*");

    if (tournamentSlug) {
      const { data: tourney } = await supabase
        .from("tournaments")
        .select("id")
        .eq("slug", tournamentSlug)
        .maybeSingle();

      if (tourney?.id) {
        query = query.or(`tournament_id.eq.${tourney.id},tournament_slug.eq.${tournamentSlug}`);
      } else {
        query = query.eq("tournament_slug", tournamentSlug);
      }
    }

    const { data: dbMatches, error } = await query.order("created_at", { ascending: true });

    if (error || !dbMatches) return [];

    return dbMatches.map((m) => {
      const score: LiveScore = {
        teamAScore: m.team_a_score,
        teamBScore: m.team_b_score,
        servingTeam: (m.serving_team as "A" | "B") || "A",
        serverNumber: (m.server_number as 1 | 2) || 1,
        rallies: Array.isArray(m.rallies) ? (m.rallies as any) : [],
      };

      return {
        id: m.id,
        court: m.court,
        teamAName: m.team_a_name,
        teamAPlayers: m.team_a_players || [],
        teamBName: m.team_b_name,
        teamBPlayers: m.team_b_players || [],
        status: m.status as LiveMatch["status"],
        score,
        winnerTeam: m.winner_team || undefined,
        startedAt: m.started_at ? new Date(m.started_at).getTime() : undefined,
        endedAt: m.ended_at ? new Date(m.ended_at).getTime() : undefined,
        officiatedBy: m.officiated_by || undefined,
        tournamentSlug: m.tournament_slug || tournamentSlug || undefined,
        categoryId: m.category_id || undefined,
        stage: m.stage || undefined,
      };
    });
  } catch (err) {
    console.warn("[Supabase] Failed to fetch matches:", err);
    return [];
  }
}

/**
 * Save or update match state in Supabase.
 */
export async function dbSaveMatch(
  match: LiveMatch,
  tournamentSlug?: string
): Promise<boolean> {
  try {
    const slug = match.tournamentSlug || tournamentSlug;
    let tourneyId: string | null = null;

    if (slug) {
      const { data: tourney } = await supabase
        .from("tournaments")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();
      if (tourney) {
        tourneyId = tourney.id;
      }
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const catId = match.categoryId && isUuid.test(match.categoryId) ? match.categoryId : null;

    const { error } = await supabase.from("matches").upsert({
      id: match.id,
      tournament_id: tourneyId,
      tournament_slug: slug || null,
      category_id: catId,
      stage: match.stage || "Pool Play",
      court: match.court,
      team_a_name: match.teamAName,
      team_a_players: match.teamAPlayers,
      team_b_name: match.teamBName,
      team_b_players: match.teamBPlayers,
      status: match.status,
      team_a_score: match.score.teamAScore,
      team_b_score: match.score.teamBScore,
      serving_team: match.score.servingTeam,
      server_number: match.score.serverNumber,
      rallies: match.score.rallies as any,
      winner_team: match.winnerTeam || null,
      started_at: match.startedAt ? new Date(match.startedAt).toISOString() : null,
      ended_at: match.endedAt ? new Date(match.endedAt).toISOString() : null,
      officiated_by: match.officiatedBy || null,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error("[Supabase] Error saving match:", error);
      return false;
    }

    return true;
  } catch (err) {
    console.error("[Supabase] Error saving match:", err);
    return false;
  }
}

/**
 * Delete a single match from Supabase.
 */
export async function dbDeleteMatch(matchId: string): Promise<boolean> {
  try {
    const { error } = await supabase.from("matches").delete().eq("id", matchId);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Delete all matches from Supabase.
 */
export async function dbClearAllMatches(): Promise<boolean> {
  try {
    const { error } = await supabase.from("matches").delete().neq("id", "");
    return !error;
  } catch {
    return false;
  }
}

/**
 * Fetch court station statuses (Courts 1–4).
 */
export async function dbGetCourtStations(): Promise<Record<string, any>> {
  try {
    const { data, error } = await supabase.from("court_stations").select("*");
    if (error || !data) return {};

    const map: Record<string, any> = {};
    for (const station of data) {
      // Map DB status to UI status: 'in-match' -> 'live', 'idle' -> 'available'
      let uiStatus: "available" | "warmup" | "live" | "maintenance" = "available";
      if (station.status === "in-match" || station.status === "live") {
        uiStatus = "live";
      } else if (station.status === "warmup") {
        uiStatus = "warmup";
      } else if (station.status === "maintenance") {
        uiStatus = "maintenance";
      } else {
        uiStatus = "available";
      }

      map[station.court_name] = {
        court: station.court_name,
        currentMatchId: station.current_match_id,
        onDeckMatchId: station.on_deck_match_id,
        assignedUmpire: station.assigned_umpire,
        dispatchedAt: station.dispatched_at ? new Date(station.dispatched_at).getTime() : null,
        maintenanceNote: station.maintenance_note,
        status: uiStatus,
      };
    }
    return map;
  } catch (err) {
    console.warn("[Supabase] Error fetching court stations:", err);
    return {};
  }
}

/**
 * Update court station in Supabase.
 */
export async function dbUpdateCourtStation(
  courtName: string,
  updates: {
    status?: string;
    currentMatchId?: string | null;
    onDeckMatchId?: string | null;
    assignedUmpire?: string | null;
    dispatchedAt?: number | null;
    maintenanceNote?: string | null;
  }
): Promise<void> {
  try {
    // Map UI status to DB status to satisfy database constraint CHECK (status IN ('idle', 'in-match', 'warmup', 'maintenance'))
    let dbStatus: string | undefined = undefined;
    if (updates.status !== undefined) {
      if (updates.status === "live") {
        dbStatus = "in-match";
      } else if (updates.status === "available") {
        dbStatus = "idle";
      } else {
        dbStatus = updates.status;
      }
    }

    await supabase
      .from("court_stations")
      .update({
        ...(dbStatus !== undefined ? { status: dbStatus } : {}),
        ...(updates.currentMatchId !== undefined ? { current_match_id: updates.currentMatchId } : {}),
        ...(updates.onDeckMatchId !== undefined ? { on_deck_match_id: updates.onDeckMatchId } : {}),
        ...(updates.assignedUmpire !== undefined ? { assigned_umpire: updates.assignedUmpire } : {}),
        ...(updates.dispatchedAt !== undefined
          ? { dispatched_at: updates.dispatchedAt ? new Date(updates.dispatchedAt).toISOString() : null }
          : {}),
        ...(updates.maintenanceNote !== undefined ? { maintenance_note: updates.maintenanceNote } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("court_name", courtName);
  } catch (err) {
    console.warn("[Supabase] Failed to update court station:", err);
  }
}

/**
 * Subscribe to realtime match and court updates.
 *
 * Each call creates a channel with a unique name so React strict-mode
 * re-mounts and HMR don't collide with an already-subscribed channel.
 */
let _liveChannelCounter = 0;

export function dbSubscribeToLive(
  onMatchChange: () => void,
  onCourtChange: () => void
) {
  _liveChannelCounter += 1;
  const channelName = `dink-valley-live-sync-${_liveChannelCounter}-${Date.now()}`;

  let channel: ReturnType<typeof supabase.channel> | null = null;

  try {
    channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "matches" },
        () => {
          onMatchChange();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "court_stations" },
        () => {
          onCourtChange();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tournaments" },
        () => {
          onMatchChange();
        }
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR") {
          console.warn("[Supabase Realtime] Channel error on", channelName);
        }
      });
  } catch (err) {
    console.warn("[Supabase Realtime] Failed to create channel:", err);
  }

  return () => {
    if (channel) {
      try {
        supabase.removeChannel(channel);
      } catch {
        // already removed
      }
    }
  };
}

/**
 * Register a user profile in Supabase.
 */
export async function dbRegisterProfile(profile: {
  email: string;
  name: string;
  role: "admin" | "umpire";
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.from("profiles").upsert(
      {
        id: crypto.randomUUID(),
        email: profile.email.toLowerCase().trim(),
        name: profile.name.trim(),
        role: profile.role,
      },
      { onConflict: "email" }
    );
    if (error) {
      console.warn("[Supabase] Error saving profile:", error);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || "Failed to register profile" };
  }
}

/**
 * Fetch all profiles.
 */
export async function dbGetProfiles(): Promise<any[]> {
  try {
    const { data, error } = await supabase.from("profiles").select("*");
    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}
