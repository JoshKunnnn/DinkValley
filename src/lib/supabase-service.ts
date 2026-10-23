import { supabase } from "@/integrations/supabase/client";
import type { Tournament, Category, Team } from "@/data/tournaments";
import type { LiveMatch, LiveScore } from "@/lib/match-store";
import { generateUUID } from "@/lib/utils";

// Global in-memory caches populated directly from Supabase
const _drawnGroupsCache = new Map<string, any[]>();
const _mainDrawCache = new Map<string, any[]>();
let _dispatchQueueCache: any[] = [];

export function clearDrawnGroupsCache(tournamentSlug: string, categoryId?: string): void {
  if (!tournamentSlug) return;
  if (!categoryId) {
    for (const key of _drawnGroupsCache.keys()) {
      if (key.startsWith(`${tournamentSlug}_`)) {
        _drawnGroupsCache.delete(key);
      }
    }
    return;
  }
  const cleanCat = categoryId.trim().toLowerCase();
  for (const key of _drawnGroupsCache.keys()) {
    if (key.startsWith(`${tournamentSlug}_`)) {
      const storedCat = key.substring(`${tournamentSlug}_`.length).trim().toLowerCase();
      if (storedCat === cleanCat) {
        _drawnGroupsCache.delete(key);
      }
    }
  }
}

export function clearMainDrawCache(tournamentSlug: string, categoryId?: string): void {
  if (!tournamentSlug) return;
  if (!categoryId) {
    for (const key of _mainDrawCache.keys()) {
      if (key.startsWith(`${tournamentSlug}_`)) {
        _mainDrawCache.delete(key);
      }
    }
    return;
  }
  const cleanCat = categoryId.trim().toLowerCase();
  for (const key of _mainDrawCache.keys()) {
    if (key.startsWith(`${tournamentSlug}_`)) {
      const storedCat = key.substring(`${tournamentSlug}_`.length).trim().toLowerCase();
      if (storedCat === cleanCat) {
        _mainDrawCache.delete(key);
      }
    }
  }
}

// Tombstone tracking to prevent asynchronous cloud reads from resurrecting draws that are currently being reset
const _pendingResetDraws = new Set<string>();

export function markDrawAsReset(tournamentSlug: string, categoryId: string): void {
  if (!tournamentSlug || !categoryId) return;
  const key = `${tournamentSlug}_${categoryId.trim().toLowerCase()}`;
  _pendingResetDraws.add(key);
  clearDrawnGroupsCache(tournamentSlug, categoryId);
}

export function clearDrawResetMark(tournamentSlug: string, categoryId: string): void {
  if (!tournamentSlug || !categoryId) return;
  const key = `${tournamentSlug}_${categoryId.trim().toLowerCase()}`;
  _pendingResetDraws.delete(key);
}

export function isDrawResetMarked(tournamentSlug: string, categoryId: string): boolean {
  if (!tournamentSlug || !categoryId) return false;
  const key = `${tournamentSlug}_${categoryId.trim().toLowerCase()}`;
  return _pendingResetDraws.has(key);
}

export function getCachedDrawnGroups(tournamentSlug: string, categoryId: string): any[] | null {
  if (!tournamentSlug || !categoryId) return null;
  if (isDrawResetMarked(tournamentSlug, categoryId)) return null;

  // 1. Direct match
  const direct = _drawnGroupsCache.get(`${tournamentSlug}_${categoryId}`);
  if (direct && Array.isArray(direct) && direct.length > 0) {
    return direct;
  }

  // 2. Exact case-insensitive match on category ID (prevent cross-category fuzzy bleeding)
  const cleanCat = categoryId.trim().toLowerCase();
  for (const [key, val] of _drawnGroupsCache.entries()) {
    if (key.startsWith(`${tournamentSlug}_`)) {
      const storedCat = key.substring(`${tournamentSlug}_`.length).trim().toLowerCase();
      if (storedCat === cleanCat) {
        if (Array.isArray(val) && val.length > 0) {
          return val;
        }
      }
    }
  }

  return null;
}

export async function dbGetDrawnGroups(tournamentSlug: string, categoryId: string): Promise<any[] | null> {
  if (isDrawResetMarked(tournamentSlug, categoryId)) return null;
  const cached = getCachedDrawnGroups(tournamentSlug, categoryId);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  try {
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .eq("slug", tournamentSlug)
      .maybeSingle();

    if (tourney?.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)) {
      const meta = tourney.rules as any;
      if (meta.drawnGroups && typeof meta.drawnGroups === "object") {
        for (const [catId, grps] of Object.entries(meta.drawnGroups)) {
          if (!isDrawResetMarked(tournamentSlug, catId)) {
            _drawnGroupsCache.set(`${tournamentSlug}_${catId}`, grps as any);
          }
        }
        return getCachedDrawnGroups(tournamentSlug, categoryId);
      }
    }
  } catch (err) {
    console.warn("[Supabase] Failed to fetch drawn groups:", err);
  }

  return null;
}

export function getCachedMainDraw(tournamentSlug: string, categoryId: string): any[] | null {
  return _mainDrawCache.get(`${tournamentSlug}_${categoryId}`) || null;
}

export function getCachedDispatchQueue(): any[] {
  return _dispatchQueueCache;
}

/**
 * Fetch all tournaments from Supabase, including categories and teams.
 */
export async function dbGetTournaments(): Promise<Tournament[] | null> {
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
      console.warn("[Supabase] Failed to fetch tournaments, retaining active memory state:", error.message);
      return null;
    }

    if (!dbTournaments) {
      return [];
    }

    return dbTournaments.map((t) => {
      let parsedRules: string[] = [];
      let metaObj: any = null;

      if (Array.isArray(t.rules)) {
        parsedRules = t.rules as string[];
      } else if (t.rules && typeof t.rules === "object") {
        metaObj = t.rules as any;
        parsedRules = Array.isArray(metaObj.rules) ? metaObj.rules : [];
        if (metaObj.drawnGroups && typeof metaObj.drawnGroups === "object") {
          for (const [catId, groups] of Object.entries(metaObj.drawnGroups)) {
            if (!isDrawResetMarked(t.slug, catId)) {
              _drawnGroupsCache.set(`${t.slug}_${catId}`, groups as any);
            }
          }
        }
        if (metaObj.mainDraw && typeof metaObj.mainDraw === "object") {
          for (const [catId, draw] of Object.entries(metaObj.mainDraw)) {
            _mainDrawCache.set(`${t.slug}_${catId}`, draw as any);
          }
        }
        if (Array.isArray(metaObj.dispatchQueue)) {
          _dispatchQueueCache = metaObj.dispatchQueue;
        }
        if (Array.isArray(metaObj.categorySequence) && typeof window !== "undefined") {
          try {
            localStorage.setItem(
              `dv_category_sequence_${t.slug}`,
              JSON.stringify(metaObj.categorySequence)
            );
          } catch {}
        }
        if (typeof metaObj.activeWaveId === "string" && metaObj.activeWaveId && typeof window !== "undefined") {
          try {
            localStorage.setItem(`dv_active_wave_${t.slug}`, metaObj.activeWaveId);
          } catch {}
        }
      }

      const categories: Category[] = (t.categories || []).map((c: any) => {
        let teams: Team[] = (c.teams || []).map((tm: any) => ({
          id: tm.id,
          name: tm.name,
          players: Array.isArray(tm.players) ? tm.players : [],
          club: tm.club || undefined,
          paid: Boolean(tm.paid),
          paymentProofUrl: tm.payment_proof_url || undefined,
          paymentRef: tm.payment_ref || undefined,
          paymentStatus: (tm.payment_status as Team["paymentStatus"]) || "Pending",
        }));

        // If category teams is empty, recover teams from drawn groups if present
        if (teams.length === 0 && metaObj?.drawnGroups && typeof metaObj.drawnGroups === "object") {
          const catKey = c.category_slug || c.id;
          const grps =
            metaObj.drawnGroups[catKey] ||
            metaObj.drawnGroups[c.id] ||
            metaObj.drawnGroups[c.category_slug];

          if (Array.isArray(grps)) {
            const seen = new Set<string>();
            grps.forEach((g: any) => {
              g.slots?.forEach((s: any) => {
                if (s.team && !seen.has(s.team.name)) {
                  seen.add(s.team.name);
                  teams.push(s.team);
                }
              });
            });

            // Asynchronously sync recovered teams to Supabase teams table in background
            if (teams.length > 0 && c.id) {
              const isUuid = (id?: string) =>
                id ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) : false;

              const teamsToInsert = teams.map((tm) => ({
                ...(isUuid(tm.id) ? { id: tm.id } : {}),
                tournament_id: t.id,
                category_id: c.id,
                name: tm.name,
                players: tm.players || [],
                club: tm.club || null,
                paid: Boolean(tm.paid ?? true),
                payment_proof_url: tm.paymentProofUrl || null,
                payment_ref: tm.paymentRef || null,
                payment_status: tm.paymentStatus || "Verified",
              }));

              Promise.resolve(
                supabase.from("teams").insert(teamsToInsert)
              ).catch(() => {});
            }
          }
        }

        const allTeams = teams.map((tm) => ({
          ...tm,
          paid: tm.paid ?? true,
          paymentStatus: (tm.paymentStatus as Team["paymentStatus"]) || "Verified",
        }));

        const savedMaxEntries =
          c.max_entries ||
          c.max_teams ||
          metaObj?.categoryMeta?.[c.category_slug || c.id]?.maxEntries ||
          metaObj?.categoryMeta?.[c.id]?.maxEntries ||
          16;

        return {
          id: c.category_slug || c.id,
          label: c.label,
          level: c.level as Category["level"],
          division: c.division as Category["division"],
          fee: c.entry_fee || undefined,
          maxEntries: Number(savedMaxEntries) || 16,
          teams: allTeams,
          pendingTeams: [],
          pools: [],
          standings: [],
          playoffs: [],
        };
      });

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
    // Preserve existing metadata in rules if present
    const { data: existingTourney } = await supabase
      .from("tournaments")
      .select("rules")
      .eq("slug", t.slug)
      .maybeSingle();

    const categoryMeta: Record<string, { maxEntries: number }> = {};
    (t.categories || []).forEach((cat) => {
      categoryMeta[cat.id] = { maxEntries: cat.maxEntries || 16 };
    });

    let rulesToSave: any = t.rules;
    if (existingTourney?.rules && typeof existingTourney.rules === "object" && !Array.isArray(existingTourney.rules)) {
      rulesToSave = {
        ...(existingTourney.rules as any),
        rules: Array.isArray(t.rules) ? t.rules : (existingTourney.rules as any).rules || [],
        categoryMeta: {
          ...((existingTourney.rules as any).categoryMeta || {}),
          ...categoryMeta,
        },
      };
    } else {
      rulesToSave = {
        rules: Array.isArray(t.rules) ? t.rules : [],
        categoryMeta,
      };
    }

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
          rules: rulesToSave,
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

    // 2. Clean up any categories that were deleted/removed
    const { data: existingCats } = await supabase
      .from("categories")
      .select("id, category_slug")
      .eq("tournament_id", tournamentId);

    if (existingCats && existingCats.length > 0) {
      const activeSlugsSet = new Set(t.categories.map((c) => c.id));
      const toDeleteIds = existingCats
        .filter((ec) => !activeSlugsSet.has(ec.category_slug))
        .map((ec) => ec.id);
      if (toDeleteIds.length > 0) {
        await supabase.from("teams").delete().in("category_id", toDeleteIds);
        await supabase.from("categories").delete().in("id", toDeleteIds);
      }
    }

    // 3. Upsert categories
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

      const allCategoryTeams = (cat.teams || []).map((tm) => ({
        ...tm,
        paid: tm.paid ?? true,
        paymentStatus: tm.paymentStatus || "Verified",
      }));

      if (allCategoryTeams.length > 0) {
        const isUuid = (id?: string) =>
          id ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) : false;

        const teamsToInsert = allCategoryTeams.map((tm) => ({
          ...(isUuid(tm.id) ? { id: tm.id } : {}),
          tournament_id: tournamentId,
          category_id: catRow.id,
          name: tm.name,
          players: Array.isArray(tm.players) ? tm.players : [],
          club: tm.club || null,
          paid: Boolean(tm.paid),
          payment_proof_url: tm.paymentProofUrl || null,
          payment_ref: tm.paymentRef || null,
          payment_status: tm.paymentStatus || "Verified",
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
    const cleanSlug = slug.trim();
    if (!cleanSlug) return false;

    // 1. Locate tournament ID
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id")
      .eq("slug", cleanSlug)
      .maybeSingle();

    if (!tourney) {
      // Attempt direct delete by slug as fallback
      await supabase.from("tournaments").delete().eq("slug", cleanSlug);
      return true;
    }

    const tourneyId = tourney.id;

    // 2. Release any court stations referencing this tournament to prevent FK constraints
    await supabase
      .from("court_stations")
      .update({
        tournament_id: null,
        current_match_id: null,
        on_deck_match_id: null,
        status: "idle",
      })
      .eq("tournament_id", tourneyId);

    // 3. Clear matches, teams, categories
    await supabase.from("matches").delete().eq("tournament_id", tourneyId);
    await supabase.from("teams").delete().eq("tournament_id", tourneyId);
    await supabase.from("categories").delete().eq("tournament_id", tourneyId);

    // 4. Delete the tournament row
    const { error } = await supabase.from("tournaments").delete().eq("id", tourneyId);
    if (error) {
      console.warn("[Supabase] Notice on cloud tournament deletion:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Supabase] Unexpected notice deleting tournament from cloud:", err);
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
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let targetCatUuid = isUuid.test(categoryId) ? categoryId : null;

    if (!targetCatUuid) {
      const { data: catRow } = await supabase
        .from("categories")
        .select("id")
        .eq("category_slug", categoryId)
        .maybeSingle();
      if (catRow?.id) {
        targetCatUuid = catRow.id;
      }
    }

    let query = supabase.from("matches").delete().neq("status", "final");
    if (tournamentSlug) {
      query = query.eq("tournament_slug", tournamentSlug);
    }
    if (targetCatUuid) {
      query = query.eq("category_id", targetCatUuid);
    }

    const { error } = await query;
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

const _inFlightMatchFetches = new Map<string, Promise<LiveMatch[]>>();

/**
 * Fetch matches from Supabase.
 * If tournamentSlug is provided, filters by tournament; otherwise returns all active matches.
 * Concurrent requests for the same tournament are coalesced to prevent socket/connection overload.
 */
export async function dbGetMatches(tournamentSlug?: string): Promise<LiveMatch[]> {
  const cacheKey = tournamentSlug || "__all__";
  if (_inFlightMatchFetches.has(cacheKey)) {
    return _inFlightMatchFetches.get(cacheKey)!;
  }

  const fetchPromise = (async () => {
    try {
      let query = supabase.from("matches").select("*");

      if (tournamentSlug) {
        const { data: tourney } = await supabase
          .from("tournaments")
          .select("id")
          .eq("slug", tournamentSlug)
          .maybeSingle();

        if (tourney?.id) {
          query = query.or(
            `tournament_id.eq.${tourney.id},tournament_slug.eq.${tournamentSlug},court.eq.Court 1,court.eq.Court 2,court.eq.Court 3,court.eq.Court 4`
          );
        } else {
          query = query.or(
            `tournament_slug.eq.${tournamentSlug},court.eq.Court 1,court.eq.Court 2,court.eq.Court 3,court.eq.Court 4`
          );
        }
      }

      const { data: dbMatches, error } = await query.order("created_at", { ascending: true });

      if (error || !dbMatches) return [];

      const mapped: LiveMatch[] = dbMatches.map((m) => {
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

      // Strict Deduplication:
      // A tournament bracket stage must have at most 1 authoritative match record per pair.
      // If historical seeds left ghost 0-0 "scheduled" duplicates, authoritative records (final/live/scored) win,
      // and duplicate ghost records are dropped and pruned from the database.
      const byPair = new Map<string, LiveMatch>();
      const zombieIdsToDelete: string[] = [];

      for (const m of mapped) {
        if (!m.teamAName || !m.teamBName) {
          byPair.set(m.id, m);
          continue;
        }
        const pair = [m.teamAName.trim().toLowerCase(), m.teamBName.trim().toLowerCase()].sort().join("::");
        const bracket = (m.stage || "").match(/(?:bracket|pool)\s*([a-z])/i)?.[1]?.toLowerCase() || "pool";
        const key = `${m.tournamentSlug || "event"}::${m.categoryId || "division"}::${bracket}::${pair}`;

        if (!byPair.has(key)) {
          byPair.set(key, m);
        } else {
          const prev = byPair.get(key)!;
          const prevScore = (prev.score?.teamAScore ?? 0) + (prev.score?.teamBScore ?? 0);
          const currScore = (m.score?.teamAScore ?? 0) + (m.score?.teamBScore ?? 0);

          const currWins =
            (m.status === "final" && prev.status !== "final") ||
            (m.status === "live" && prev.status === "scheduled") ||
            (currScore > prevScore) ||
            (m.court && m.court !== "Queue" && (!prev.court || prev.court === "Queue"));

          if (currWins) {
            byPair.set(key, m);
            if (prev.status === "scheduled" && prevScore === 0) {
              zombieIdsToDelete.push(prev.id);
            }
          } else {
            if (m.status === "scheduled" && currScore === 0) {
              zombieIdsToDelete.push(m.id);
            }
          }
        }
      }

      // Background purge of detected zombie duplicate records from Supabase
      if (zombieIdsToDelete.length > 0) {
        (async () => {
          for (const zid of zombieIdsToDelete) {
            try {
              await supabase.from("matches").delete().eq("id", zid);
            } catch {}
          }
        })().catch(() => {});
      }

      return Array.from(byPair.values());
    } catch (err) {
      console.warn("[Supabase] Failed to fetch matches:", err);
      return [];
    } finally {
      _inFlightMatchFetches.delete(cacheKey);
    }
  })();

  _inFlightMatchFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}

const _tourneyIdBySlug = new Map<string, string>();
const _lastSavedMatchHash = new Map<string, string>();
const _inFlightMatchSaves = new Map<string, Promise<boolean>>();

function getMatchFingerprint(m: LiveMatch, slug?: string): string {
  return `${m.id}|${slug || m.tournamentSlug || ""}|${m.categoryId || ""}|${m.court || ""}|${m.status}|${m.score?.teamAScore}|${m.score?.teamBScore}|${m.score?.servingTeam}|${m.score?.serverNumber}|${m.winnerTeam || ""}|${m.startedAt || 0}|${m.endedAt || 0}|${m.officiatedBy || ""}`;
}

function formatMatchRow(match: LiveMatch, tourneyId: string | null, slug: string | null) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const catId = match.categoryId && isUuid.test(match.categoryId) ? match.categoryId : null;

  return {
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
  };
}

/**
 * Save multiple matches in a single batched Supabase upsert request
 * to prevent socket pool exhaustion (ERR_INSUFFICIENT_RESOURCES).
 */
export async function dbSaveMatchesBatch(
  matches: LiveMatch[],
  tournamentSlug?: string
): Promise<boolean> {
  if (!matches || matches.length === 0) return true;

  const dirtyMatches = matches.filter((m) => {
    const slug = m.tournamentSlug || tournamentSlug;
    const fp = getMatchFingerprint(m, slug);
    return _lastSavedMatchHash.get(m.id) !== fp;
  });

  if (dirtyMatches.length === 0) return true;

  try {
    const slug = dirtyMatches[0]?.tournamentSlug || tournamentSlug;
    let tourneyId: string | null = null;
    if (slug) {
      if (_tourneyIdBySlug.has(slug)) {
        tourneyId = _tourneyIdBySlug.get(slug)!;
      } else {
        const { data: tourney } = await supabase
          .from("tournaments")
          .select("id")
          .eq("slug", slug)
          .maybeSingle();
        if (tourney) {
          tourneyId = tourney.id;
          _tourneyIdBySlug.set(slug, tourney.id);
        }
      }
    }

    const CHUNK_SIZE = 40;
    for (let i = 0; i < dirtyMatches.length; i += CHUNK_SIZE) {
      const chunk = dirtyMatches.slice(i, i + CHUNK_SIZE);
      const rows = chunk.map((m) => formatMatchRow(m, tourneyId, m.tournamentSlug || slug || null));
      const { error } = await supabase.from("matches").upsert(rows);
      if (error) {
        console.warn("[Supabase] Error batch saving matches:", error.message);
        return false;
      }
      for (const m of chunk) {
        _lastSavedMatchHash.set(m.id, getMatchFingerprint(m, m.tournamentSlug || slug));
      }
    }

    return true;
  } catch (err) {
    console.warn("[Supabase] Unexpected error batch saving matches:", err);
    return false;
  }
}

const OFFLINE_JOURNAL_KEY = "dv_offline_score_journal";

export type OfflineScoreEntry = {
  match: LiveMatch;
  tournamentSlug?: string | undefined;
  queuedAt: number;
};

export function getOfflineScoreJournal(): Record<string, OfflineScoreEntry> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(OFFLINE_JOURNAL_KEY) : null;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveOfflineScoreJournal(journal: Record<string, OfflineScoreEntry>): void {
  try {
    if (typeof localStorage !== "undefined") {
      if (Object.keys(journal).length === 0) {
        localStorage.removeItem(OFFLINE_JOURNAL_KEY);
      } else {
        localStorage.setItem(OFFLINE_JOURNAL_KEY, JSON.stringify(journal));
      }
    }
  } catch {}
}

export async function flushOfflineScoreJournal(): Promise<number> {
  const journal = getOfflineScoreJournal();
  const entries = Object.values(journal);
  if (entries.length === 0) return 0;

  let flushedCount = 0;
  for (const entry of entries) {
    try {
      const ok = await dbSaveMatch(entry.match, entry.tournamentSlug);
      if (ok) {
        delete journal[entry.match.id];
        flushedCount++;
      }
    } catch {
      // still offline, retain entry
    }
  }
  saveOfflineScoreJournal(journal);
  return flushedCount;
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    flushOfflineScoreJournal().catch(() => {});
  });
}

const _pendingMatchSaves = new Map<string, { match: LiveMatch; tournamentSlug?: string | undefined }>();

export async function dbSaveMatch(
  match: LiveMatch,
  tournamentSlug?: string
): Promise<boolean> {
  const slug = match.tournamentSlug || tournamentSlug;
  const fp = getMatchFingerprint(match, slug);

  if (_lastSavedMatchHash.get(match.id) === fp && !_pendingMatchSaves.has(match.id)) {
    return true;
  }

  // If already saving this match, queue the latest version so it executes immediately after
  if (_inFlightMatchSaves.has(match.id)) {
    _pendingMatchSaves.set(match.id, { match, tournamentSlug });
    return _inFlightMatchSaves.get(match.id)!;
  }

  const savePromise = (async () => {
    try {
      let tourneyId: string | null = null;

      if (slug) {
        if (_tourneyIdBySlug.has(slug)) {
          tourneyId = _tourneyIdBySlug.get(slug)!;
        } else {
          const { data: tourney } = await supabase
            .from("tournaments")
            .select("id")
            .eq("slug", slug)
            .maybeSingle();
          if (tourney) {
            tourneyId = tourney.id;
            _tourneyIdBySlug.set(slug, tourney.id);
          }
        }
      }

      const row = formatMatchRow(match, tourneyId, slug || null);
      const { error } = await supabase.from("matches").upsert(row);

      if (error) {
        console.warn("[Supabase] Error saving match:", error.message);
        const journal = getOfflineScoreJournal();
        journal[match.id] = { match, tournamentSlug: slug, queuedAt: Date.now() };
        saveOfflineScoreJournal(journal);
        return false;
      }

      // Success: clean from offline journal if queued
      const journal = getOfflineScoreJournal();
      if (journal[match.id]) {
        delete journal[match.id];
        saveOfflineScoreJournal(journal);
      }

      _lastSavedMatchHash.set(match.id, fp);
      recordScoreSyncEvent({
        timestamp: Date.now(),
        court: match.court || null,
        matchId: match.id,
        teams: `${match.teamAName} vs ${match.teamBName}`,
        scoreA: match.score.teamAScore,
        scoreB: match.score.teamBScore,
        serverNumber: match.score.serverNumber,
        servingTeam: match.score.servingTeam,
        source: "local_save",
        status: match.status,
        officiatedBy: match.officiatedBy || null,
      });
      return true;
    } catch (err) {
      console.warn("[Supabase] Error saving match:", err);
      const journal = getOfflineScoreJournal();
      journal[match.id] = { match, tournamentSlug: slug, queuedAt: Date.now() };
      saveOfflineScoreJournal(journal);
      return false;
    } finally {
      _inFlightMatchSaves.delete(match.id);
      // If a subsequent update arrived while this save was in flight, dispatch it now
      if (_pendingMatchSaves.has(match.id)) {
        const next = _pendingMatchSaves.get(match.id)!;
        _pendingMatchSaves.delete(match.id);
        dbSaveMatch(next.match, next.tournamentSlug).catch(() => {});
      }
    }
  })();

  _inFlightMatchSaves.set(match.id, savePromise);
  return savePromise;
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

let _inFlightCourtStationsFetch: Promise<Record<string, any>> | null = null;

/**
 * Fetch court station statuses (Courts 1–4).
 * Coalesces concurrent calls to prevent redundant socket/network load.
 */
export async function dbGetCourtStations(): Promise<Record<string, any>> {
  if (_inFlightCourtStationsFetch) {
    return _inFlightCourtStationsFetch;
  }

  _inFlightCourtStationsFetch = (async () => {
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
    } finally {
      _inFlightCourtStationsFetch = null;
    }
  })();

  return _inFlightCourtStationsFetch;
}

// Tracks when THIS device last wrote each court station, so hydration can protect
// in-flight local writes without resurrecting stale state from other devices.
const _stationWriteAt = new Map<string, number>();
const _stationWriteFingerprint = new Map<string, { fp: string; at: number }>();

export function getStationLocalWriteAt(courtName: string): number {
  return _stationWriteAt.get(courtName) ?? 0;
}

/** Marks a station as locally written now (used when the cloud push is intentionally deferred). */
export function markStationLocalWrite(courtName: string): void {
  _stationWriteAt.set(courtName, Date.now());
}

/**
 * Retrieves raw court stations directly from Supabase without UI status translation.
 */
export async function dbGetRawCourtStations(): Promise<any[]> {
  try {
    const { data, error } = await supabase.from("court_stations").select("*").order("court_name");
    if (error || !data) return [];
    return data;
  } catch (err) {
    console.warn("[Supabase] Error fetching raw court stations:", err);
    return [];
  }
}

export type ScoreSyncEvent = {
  id: string;
  timestamp: number;
  court?: string | null;
  matchId: string;
  teams: string;
  scoreA: number;
  scoreB: number;
  serverNumber: number;
  servingTeam: string;
  source: "realtime" | "local_save" | "poll" | "offline_flush";
  status: string;
  officiatedBy?: string | null;
  latencyMs?: number;
};

const _recentScoreSyncEvents: ScoreSyncEvent[] = [];
const _scoreSyncListeners = new Set<(evt: ScoreSyncEvent) => void>();

export function recordScoreSyncEvent(evt: Omit<ScoreSyncEvent, "id">): void {
  const full: ScoreSyncEvent = {
    ...evt,
    id: `sync-evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
  };
  _recentScoreSyncEvents.unshift(full);
  if (_recentScoreSyncEvents.length > 50) {
    _recentScoreSyncEvents.pop();
  }
  for (const listener of _scoreSyncListeners) {
    try {
      listener(full);
    } catch {}
  }
}

export function getRecentScoreSyncEvents(): ScoreSyncEvent[] {
  return [..._recentScoreSyncEvents];
}

export function subscribeScoreSyncEvents(cb: (evt: ScoreSyncEvent) => void): () => void {
  _scoreSyncListeners.add(cb);
  return () => {
    _scoreSyncListeners.delete(cb);
  };
}

export async function measureScoreSyncLatency(): Promise<{ latencyMs: number; ok: boolean; error?: string | undefined }> {
  const start = performance.now();
  try {
    const { error } = await supabase.from("tournaments").select("id").limit(1);
    const end = performance.now();
    return {
      latencyMs: Math.max(1, Math.round(end - start)),
      ok: !error,
      error: error?.message,
    };
  } catch (err: any) {
    return {
      latencyMs: -1,
      ok: false,
      error: err?.message || "Network error",
    };
  }
}

/**
 * Returns current sync, subscription, and in-flight queue metrics for diagnostics.
 */
export function getDispatchSyncTelemetry(): {
  activeSubscribers: number;
  sharedChannelConnected: boolean;
  inFlightMatchSavesCount: number;
  pendingMatchSavesCount: number;
  inFlightCourtStationsFetchActive: boolean;
  offlineJournalCount: number;
} {
  return {
    activeSubscribers: _subscribers.size,
    sharedChannelConnected: Boolean(_sharedChannel),
    inFlightMatchSavesCount: _inFlightMatchSaves.size,
    pendingMatchSavesCount: _pendingMatchSaves.size,
    inFlightCourtStationsFetchActive: Boolean(_inFlightCourtStationsFetch),
    offlineJournalCount: Object.keys(getOfflineScoreJournal()).length,
  };
}

/**
 * Update court station in Supabase.
 * Identical repeat writes within 15s are skipped (e.g. umpire re-asserting "live" on every point),
 * which prevents a realtime broadcast storm to every connected device.
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
  const fp = JSON.stringify(updates);
  const prev = _stationWriteFingerprint.get(courtName);
  const now = Date.now();
  if (prev && prev.fp === fp && now - prev.at < 1500) {
    return;
  }
  _stationWriteFingerprint.set(courtName, { fp, at: now });
  _stationWriteAt.set(courtName, now);

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

    const { error } = await supabase
      .from("court_stations")
      .upsert({
        court_name: courtName,
        ...(dbStatus !== undefined ? { status: dbStatus } : {}),
        ...(updates.currentMatchId !== undefined ? { current_match_id: updates.currentMatchId } : {}),
        ...(updates.onDeckMatchId !== undefined ? { on_deck_match_id: updates.onDeckMatchId } : {}),
        ...(updates.assignedUmpire !== undefined ? { assigned_umpire: updates.assignedUmpire } : {}),
        ...(updates.dispatchedAt !== undefined
          ? { dispatched_at: updates.dispatchedAt ? new Date(updates.dispatchedAt).toISOString() : null }
          : {}),
        ...(updates.maintenanceNote !== undefined ? { maintenance_note: updates.maintenanceNote } : {}),
        updated_at: new Date().toISOString(),
      }, { onConflict: "court_name" });

    if (error) {
      // Allow an immediate retry on the next call
      _stationWriteFingerprint.delete(courtName);
      console.warn("[Supabase] Court station update rejected:", error.message);
    }
  } catch (err) {
    _stationWriteFingerprint.delete(courtName);
    console.warn("[Supabase] Failed to update court station:", err);
  }
}

type LiveSubscriber = {
  id: number;
  onMatchChange: () => void;
  onCourtChange: () => void;
};

let _subscriberSeq = 0;
const _subscribers = new Map<number, LiveSubscriber>();
let _sharedChannel: ReturnType<typeof supabase.channel> | null = null;
let _matchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let _courtDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function notifyMatchListeners() {
  if (_matchDebounceTimer) clearTimeout(_matchDebounceTimer);
  _matchDebounceTimer = setTimeout(() => {
    _matchDebounceTimer = null;
    for (const sub of _subscribers.values()) {
      try {
        sub.onMatchChange();
      } catch (e) {
        console.warn("[Realtime] Error in match listener:", e);
      }
    }
  }, 120);
}

function notifyCourtListeners() {
  if (_courtDebounceTimer) clearTimeout(_courtDebounceTimer);
  _courtDebounceTimer = setTimeout(() => {
    _courtDebounceTimer = null;
    for (const sub of _subscribers.values()) {
      try {
        sub.onCourtChange();
      } catch (e) {
        console.warn("[Realtime] Error in court listener:", e);
      }
    }
  }, 120);
}

function ensureSharedLiveChannel() {
  if (_sharedChannel) return;
  const channelName = "dink-valley-live-pubsub";

  try {
    _sharedChannel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "matches" },
        (payload: any) => {
          if (payload?.new) {
            const row = payload.new;
            recordScoreSyncEvent({
              timestamp: Date.now(),
              court: row.court || null,
              matchId: row.id,
              teams: `${row.team_a_name || "Team A"} vs ${row.team_b_name || "Team B"}`,
              scoreA: row.team_a_score ?? 0,
              scoreB: row.team_b_score ?? 0,
              serverNumber: row.server_number ?? 1,
              servingTeam: row.serving_team ?? "A",
              source: "realtime",
              status: row.status || "live",
              officiatedBy: row.officiated_by || null,
            });
          }
          notifyMatchListeners();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "court_stations" },
        () => {
          notifyCourtListeners();
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tournaments" },
        () => {
          notifyMatchListeners();
        }
      )
      .on(
        "broadcast",
        { event: "dv_match_dispatched" },
        (payload: any) => {
          if (payload?.payload && typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("dv_remote_match_dispatched", { detail: payload.payload })
            );
          }
        }
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR") {
          console.warn("[Supabase Realtime] Channel error on", channelName);
        }
      });
  } catch (err) {
    console.warn("[Supabase Realtime] Failed to create shared channel:", err);
  }
}

/**
 * Broadcasts an instantaneous dispatch alert to all connected devices via Supabase Realtime channel.
 */
export function broadcastDispatchAlert(detail: {
  court: string;
  matchId: string;
  teamAName: string;
  teamBName: string;
  stage?: string | undefined;
  umpire?: string | undefined;
  match?: any;
}): void {
  ensureSharedLiveChannel();
  if (_sharedChannel) {
    _sharedChannel
      .send({
        type: "broadcast",
        event: "dv_match_dispatched",
        payload: detail,
      })
      .catch((err) => {
        console.warn("[Realtime] Failed to broadcast dispatch event:", err);
      });
  }
}

/**
 * Subscribe to realtime match and court updates.
 *
 * Uses a single shared Supabase channel multiplexed across all components with 120ms
 * debouncing to prevent socket pool exhaustion and duplicate network storms.
 */
export function dbSubscribeToLive(
  onMatchChange: () => void,
  onCourtChange: () => void
): () => void {
  const id = ++_subscriberSeq;
  _subscribers.set(id, { id, onMatchChange, onCourtChange });

  ensureSharedLiveChannel();

  return () => {
    _subscribers.delete(id);
    if (_subscribers.size === 0 && _sharedChannel) {
      try {
        supabase.removeChannel(_sharedChannel);
      } catch {}
      _sharedChannel = null;
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
        id: generateUUID(),
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

/**
 * Save drawn bracket groups directly to Supabase.
 */
export async function dbSaveDrawnGroups(
  tournamentSlug: string,
  categoryId: string,
  groups: any[]
): Promise<boolean> {
  try {
    _drawnGroupsCache.set(`${tournamentSlug}_${categoryId}`, groups);

    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .eq("slug", tournamentSlug)
      .maybeSingle();

    if (!tourney) return false;

    // Lookup category row to sync under both UUID and category_slug
    let catSlug = categoryId;
    let catUuid = categoryId;
    if (tourney.id) {
      const { data: catRow } = await supabase
        .from("categories")
        .select("id, category_slug")
        .eq("tournament_id", tourney.id)
        .or(`id.eq.${categoryId},category_slug.eq.${categoryId}`)
        .maybeSingle();

      if (catRow) {
        catUuid = catRow.id;
        catSlug = catRow.category_slug;
      }
    }

    _drawnGroupsCache.set(`${tournamentSlug}_${catSlug}`, groups);
    _drawnGroupsCache.set(`${tournamentSlug}_${catUuid}`, groups);

    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("dv_drawn_groups_updated"));
    }

    const existing =
      tourney.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)
        ? (tourney.rules as any)
        : { rules: Array.isArray(tourney.rules) ? tourney.rules : [] };

    const drawnGroups = {
      ...(existing.drawnGroups || {}),
      [categoryId]: groups,
      [catSlug]: groups,
      [catUuid]: groups,
    };
    const updatedMeta = { ...existing, drawnGroups };

    const { error } = await supabase
      .from("tournaments")
      .update({ rules: updatedMeta, updated_at: new Date().toISOString() })
      .eq("slug", tournamentSlug);

    return !error;
  } catch (err) {
    console.warn("[Supabase] Failed to save drawn groups:", err);
    return false;
  }
}

/**
 * Delete drawn bracket groups for a category from Supabase.
 */
export async function dbDeleteDrawnGroups(
  tournamentSlug: string,
  categoryId: string
): Promise<boolean> {
  // Synchronously mark reset tombstone immediately to prevent background sync from resurrecting stale data
  markDrawAsReset(tournamentSlug, categoryId);
  clearDrawnGroupsCache(tournamentSlug, categoryId);

  try {
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .eq("slug", tournamentSlug)
      .maybeSingle();

    if (!tourney) {
      setTimeout(() => clearDrawResetMark(tournamentSlug, categoryId), 2000);
      return false;
    }

    let catSlug = categoryId;
    let catUuid = categoryId;
    if (tourney.id) {
      const { data: catRow } = await supabase
        .from("categories")
        .select("id, category_slug")
        .eq("tournament_id", tourney.id)
        .or(`id.eq.${categoryId},category_slug.eq.${categoryId}`)
        .maybeSingle();

      if (catRow) {
        catUuid = catRow.id;
        catSlug = catRow.category_slug;
      }
    }

    markDrawAsReset(tournamentSlug, catSlug);
    markDrawAsReset(tournamentSlug, catUuid);
    clearDrawnGroupsCache(tournamentSlug, catSlug);
    clearDrawnGroupsCache(tournamentSlug, catUuid);

    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("dv_drawn_groups_updated"));
    }

    if (tourney.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)) {
      const existing = tourney.rules as any;
      const drawnGroups = { ...(existing.drawnGroups || {}) };
      delete drawnGroups[categoryId];
      delete drawnGroups[catSlug];
      delete drawnGroups[catUuid];
      const updatedMeta = { ...existing, drawnGroups };

      const { error } = await supabase
        .from("tournaments")
        .update({ rules: updatedMeta, updated_at: new Date().toISOString() })
        .eq("slug", tournamentSlug);

      setTimeout(() => {
        clearDrawResetMark(tournamentSlug, categoryId);
        clearDrawResetMark(tournamentSlug, catSlug);
        clearDrawResetMark(tournamentSlug, catUuid);
      }, 2000);

      return !error;
    }

    setTimeout(() => {
      clearDrawResetMark(tournamentSlug, categoryId);
      clearDrawResetMark(tournamentSlug, catSlug);
      clearDrawResetMark(tournamentSlug, catUuid);
    }, 2000);

    return true;
  } catch (err) {
    console.warn("[Supabase] Failed to delete drawn groups:", err);
    setTimeout(() => clearDrawResetMark(tournamentSlug, categoryId), 2000);
    return false;
  }
}

/**
 * Save playoff main draw knockout matches directly to Supabase.
 */
export async function dbSaveMainDraw(
  tournamentSlug: string,
  categoryId: string,
  matches: any[]
): Promise<boolean> {
  try {
    _mainDrawCache.set(`${tournamentSlug}_${categoryId}`, matches);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("dv_main_draw_updated"));
    }

    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .eq("slug", tournamentSlug)
      .maybeSingle();

    if (!tourney) return false;

    const existing =
      tourney.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)
        ? (tourney.rules as any)
        : { rules: Array.isArray(tourney.rules) ? tourney.rules : [] };

    const mainDraw = { ...(existing.mainDraw || {}), [categoryId]: matches };
    const updatedMeta = { ...existing, mainDraw };

    const { error } = await supabase
      .from("tournaments")
      .update({ rules: updatedMeta, updated_at: new Date().toISOString() })
      .eq("slug", tournamentSlug);

    return !error;
  } catch (err) {
    console.warn("[Supabase] Failed to save main draw:", err);
    return false;
  }
}

/**
 * Delete playoff main draw for a category from Supabase.
 */
export async function dbDeleteMainDraw(
  tournamentSlug: string,
  categoryId: string
): Promise<boolean> {
  // Synchronously wipe in-memory cache immediately
  clearMainDrawCache(tournamentSlug, categoryId);

  try {
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .eq("slug", tournamentSlug)
      .maybeSingle();

    if (!tourney) return false;

    let catSlug = categoryId;
    let catUuid = categoryId;
    if (tourney.id) {
      const { data: catRow } = await supabase
        .from("categories")
        .select("id, category_slug")
        .eq("tournament_id", tourney.id)
        .or(`id.eq.${categoryId},category_slug.eq.${categoryId}`)
        .maybeSingle();

      if (catRow) {
        catUuid = catRow.id;
        catSlug = catRow.category_slug;
      }
    }

    clearMainDrawCache(tournamentSlug, catSlug);
    clearMainDrawCache(tournamentSlug, catUuid);

    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("dv_main_draw_updated"));
    }

    if (tourney.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)) {
      const existing = tourney.rules as any;
      const mainDraw = { ...(existing.mainDraw || {}) };
      delete mainDraw[categoryId];
      delete mainDraw[catSlug];
      delete mainDraw[catUuid];
      const updatedMeta = { ...existing, mainDraw };

      const { error } = await supabase
        .from("tournaments")
        .update({ rules: updatedMeta, updated_at: new Date().toISOString() })
        .eq("slug", tournamentSlug);

      return !error;
    }
    return true;
  } catch (err) {
    console.warn("[Supabase] Failed to delete main draw:", err);
    return false;
  }
}

/**
 * Save dispatch queue directly to Supabase.
 */
export async function dbSaveDispatchQueue(
  queue: any[],
  tournamentSlug?: string
): Promise<boolean> {
  try {
    _dispatchQueueCache = queue;
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("dv_dispatch_queue_updated"));
    }

    const slug = tournamentSlug || "dink-valley-tournament";
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .eq("slug", slug)
      .maybeSingle();

    if (!tourney) return false;

    const existing =
      tourney.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)
        ? (tourney.rules as any)
        : { rules: Array.isArray(tourney.rules) ? tourney.rules : [] };

    const updatedMeta = { ...existing, dispatchQueue: queue };

    const { error } = await supabase
      .from("tournaments")
      .update({ rules: updatedMeta, updated_at: new Date().toISOString() })
      .eq("slug", slug);

    return !error;
  } catch (err) {
    console.warn("[Supabase] Failed to save dispatch queue:", err);
    return false;
  }
}

/**
 * Delete dispatch queue items from Supabase.
 */
export async function dbDeleteDispatchQueue(
  tournamentSlug?: string,
  categoryId?: string
): Promise<boolean> {
  try {
    if (categoryId) {
      _dispatchQueueCache = _dispatchQueueCache.filter((item) => item.categoryId !== categoryId);
    } else {
      _dispatchQueueCache = [];
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("dv_dispatch_queue_updated"));
    }

    const slug = tournamentSlug || "dink-valley-tournament";
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .eq("slug", slug)
      .maybeSingle();

    if (!tourney) return false;

    if (tourney.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)) {
      const existing = tourney.rules as any;
      const currentQueue = Array.isArray(existing.dispatchQueue) ? existing.dispatchQueue : [];
      const filteredQueue = categoryId
        ? currentQueue.filter((item: any) => item.categoryId !== categoryId)
        : [];
      const updatedMeta = { ...existing, dispatchQueue: filteredQueue };

      const { error } = await supabase
        .from("tournaments")
        .update({ rules: updatedMeta, updated_at: new Date().toISOString() })
        .eq("slug", slug);

      return !error;
    }
    return true;
  } catch (err) {
    console.warn("[Supabase] Failed to delete dispatch queue:", err);
    return false;
  }
}

/**
 * Save category sequence and active wave arrangement to Supabase.
 */
export async function dbSaveCategoryArrangement(
  tournamentSlug: string,
  sequence?: string[],
  activeWaveId?: string
): Promise<boolean> {
  try {
    const slug = tournamentSlug || "dink-valley-tournament";
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .eq("slug", slug)
      .maybeSingle();

    if (!tourney) return false;

    const existing =
      tourney.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)
        ? (tourney.rules as any)
        : { rules: Array.isArray(tourney.rules) ? tourney.rules : [] };

    const updatedMeta = {
      ...existing,
      ...(sequence ? { categorySequence: sequence } : {}),
      ...(activeWaveId ? { activeWaveId } : {}),
    };

    const { error } = await supabase
      .from("tournaments")
      .update({ rules: updatedMeta, updated_at: new Date().toISOString() })
      .eq("slug", slug);

    return !error;
  } catch (err) {
    console.warn("[Supabase] Failed to save category arrangement:", err);
    return false;
  }
}

/**
 * Register a team publicly via the secure server-side RPC.
 * Respects RLS and validations (32 team cap, no duplicate names, Pending status).
 */
export async function dbRegisterTeam(params: {
  tournamentSlug: string;
  categorySlug: string;
  team: Team;
}): Promise<{ success: boolean; teamId?: string; error?: string }> {
  try {
    const isUuid = (id?: string) =>
      id ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) : false;

    const { data, error } = await supabase.rpc("register_team", {
      p_tournament_slug: params.tournamentSlug,
      p_category_slug: params.categorySlug,
      p_team_name: params.team.name,
      p_players: params.team.players,
      p_club: params.team.club || null,
      p_payment_ref: params.team.paymentRef || null,
      p_payment_proof_url: params.team.paymentProofUrl || null,
      p_team_id: isUuid(params.team.id) ? params.team.id : null,
    });

    if (error) {
      console.warn("[Supabase] Failed to register team via RPC:", error.message);
      return { success: false, error: error.message };
    }

    return { success: true, teamId: data };
  } catch (err: any) {
    console.warn("[Supabase] Unexpected error registering team:", err);
    return { success: false, error: err?.message || "Failed to submit registration" };
  }
}

/**
 * Check if an access code is valid and unused on the server.
 * Returns the assigned role ('admin' | 'umpire') or null.
 */
export async function dbCheckAccessCode(code: string): Promise<"admin" | "umpire" | null> {
  try {
    const clean = code.trim().toUpperCase();
    if (!clean) return null;
    const { data, error } = await supabase.rpc("check_access_code", {
      p_code: clean,
    });
    if (error || !data) return null;
    return data === "admin" || data === "umpire" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Fetch all access codes (admin only).
 */
export async function dbGetAccessCodes(): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from("access_codes")
      .select("*")
      .order("created_at", { ascending: false });
    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}

/**
 * Create a new access code in Supabase (admin only).
 */
export async function dbCreateAccessCode(
  code: string,
  role: "admin" | "umpire",
  createdByName: string = "Admin Director"
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.from("access_codes").insert({
      code: code.trim().toUpperCase(),
      role,
      created_by_name: createdByName,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || "Failed to create code" };
  }
}

/**
 * Revoke/delete an access code from Supabase (admin only).
 */
export async function dbRevokeAccessCode(id: string): Promise<boolean> {
  try {
    const { error } = await supabase.from("access_codes").delete().eq("id", id);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Cloud Staff User Representation
 */
export type CloudStaffUser = {
  name: string;
  email: string;
  password?: string | undefined;
  passwordHash?: string | undefined;
  role: "admin" | "umpire";
  accessCode?: string | undefined;
  certifiedAt?: string | undefined;
  status?: "active" | "deactivated" | undefined;
};

/**
 * Fetch all registered staff accounts from Supabase cloud.
 * Queries both tournaments.rules.staffAccounts and access_codes (used_by_email).
 */
export async function dbGetCloudStaffAccounts(): Promise<CloudStaffUser[]> {
  try {
    const cloudStaffMap: Record<string, CloudStaffUser> = {};

    // 1. Fetch from tournaments rules staffAccounts
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("rules")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (tourney?.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)) {
      const map = (tourney.rules as any).staffAccounts;
      if (map && typeof map === "object" && !Array.isArray(map)) {
        Object.entries(map).forEach(([k, v]) => {
          cloudStaffMap[k.toLowerCase()] = v as CloudStaffUser;
        });
      }
    }

    // 2. Fetch from access_codes where used_by_email is recorded (accounts registered on other devices)
    try {
      const { data: usedCodes } = await supabase
        .from("access_codes")
        .select("code, role, used_at, used_by_email, used_by")
        .not("used_by_email", "is", null);

      if (usedCodes && usedCodes.length > 0) {
        usedCodes.forEach((ac) => {
          if (!ac.used_by_email) return;
          const emailKey = ac.used_by_email.toLowerCase();
          if (!cloudStaffMap[emailKey]) {
            const rawPart = emailKey.split("@")[0] || "official";
            const formattedName = rawPart
              .split(/[\._\-]/)
              .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
              .join(" ");

            cloudStaffMap[emailKey] = {
              name: formattedName || (ac.role === "admin" ? "Tournament Director" : "Match Official"),
              email: emailKey,
              role: ac.role === "admin" ? "admin" : "umpire",
              accessCode: ac.code,
              certifiedAt: ac.used_at ? ac.used_at.split("T")[0] : undefined,
              status: "active",
            };
          } else {
            const existing = cloudStaffMap[emailKey]!;
            if (!existing.accessCode && ac.code) existing.accessCode = ac.code;
            if (!existing.certifiedAt && ac.used_at) existing.certifiedAt = ac.used_at.split("T")[0];
          }
        });
      }
    } catch (err) {
      console.warn("[Supabase] Notice querying access_codes in dbGetCloudStaffAccounts:", err);
    }

    return Object.values(cloudStaffMap);
  } catch (err) {
    console.warn("[Supabase] Failed to fetch cloud staff accounts:", err);
    return [];
  }
}

/**
 * Save or update a registered staff account in Supabase cloud.
 */
export async function dbSaveCloudStaffAccount(user: CloudStaffUser): Promise<boolean> {
  try {
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!tourney) return false;

    const existingRules =
      tourney.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)
        ? (tourney.rules as any)
        : { rules: [] };

    const currentStaffMap = existingRules.staffAccounts || {};
    const updatedStaffMap = {
      ...currentStaffMap,
      [user.email.toLowerCase()]: {
        ...(currentStaffMap[user.email.toLowerCase()] || {}),
        ...user,
        email: user.email.toLowerCase(),
      },
    };

    const updatedRules = {
      ...existingRules,
      staffAccounts: updatedStaffMap,
    };

    const { error } = await supabase
      .from("tournaments")
      .update({ rules: updatedRules, updated_at: new Date().toISOString() })
      .eq("id", tourney.id);

    if (error) {
      console.warn("[Supabase] Error saving staff account to cloud:", error.message);
      return false;
    }

    // Also mark access code as used in access_codes table if applicable
    if (user.accessCode) {
      try {
        await supabase
          .from("access_codes")
          .update({
            used_at: new Date().toISOString(),
            used_by_email: user.email.toLowerCase(),
          })
          .eq("code", user.accessCode.trim().toUpperCase());
      } catch {
        // ignore
      }
    }

    return true;
  } catch (err) {
    console.warn("[Supabase] Unexpected error saving cloud staff account:", err);
    return false;
  }
}

/**
 * Update a specific staff account in Supabase cloud.
 */
export async function dbUpdateCloudStaffAccount(
  email: string,
  updates: Partial<CloudStaffUser>
): Promise<boolean> {
  try {
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!tourney) return false;

    const existingRules =
      tourney.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)
        ? (tourney.rules as any)
        : { rules: [] };

    const currentStaffMap = existingRules.staffAccounts || {};
    const emailKey = email.toLowerCase();
    const existing = currentStaffMap[emailKey] || {};

    const updatedStaffMap = {
      ...currentStaffMap,
      [emailKey]: {
        ...existing,
        ...updates,
        email: emailKey,
      },
    };

    const updatedRules = {
      ...existingRules,
      staffAccounts: updatedStaffMap,
    };

    const { error } = await supabase
      .from("tournaments")
      .update({ rules: updatedRules, updated_at: new Date().toISOString() })
      .eq("id", tourney.id);

    if (error) {
      console.warn("[Supabase] Error updating cloud staff account:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Supabase] Unexpected error updating cloud staff account:", err);
    return false;
  }
}

/**
 * Delete a registered staff account from Supabase cloud.
 */
export async function dbDeleteCloudStaffAccount(email: string): Promise<boolean> {
  try {
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!tourney) return false;

    const existingRules =
      tourney.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)
        ? (tourney.rules as any)
        : { rules: [] };

    const currentStaffMap = { ...(existingRules.staffAccounts || {}) };
    delete currentStaffMap[email.toLowerCase()];

    const updatedRules = {
      ...existingRules,
      staffAccounts: currentStaffMap,
    };

    const { error } = await supabase
      .from("tournaments")
      .update({ rules: updatedRules, updated_at: new Date().toISOString() })
      .eq("id", tourney.id);

    if (error) {
      console.warn("[Supabase] Error deleting staff account from cloud:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Supabase] Unexpected error deleting cloud staff account:", err);
    return false;
  }
}

/**
 * Two-way merge of local staff accounts and Supabase cloud staff accounts.
 * Also scans access_codes for accounts registered on other machines.
 */
export async function dbSyncCloudStaffAccounts(localUsers: CloudStaffUser[]): Promise<CloudStaffUser[]> {
  try {
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, rules")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!tourney) return localUsers;

    const existingRules =
      tourney.rules && typeof tourney.rules === "object" && !Array.isArray(tourney.rules)
        ? (tourney.rules as any)
        : { rules: [] };

    const cloudStaffMap: Record<string, CloudStaffUser> = {
      ...(existingRules.staffAccounts || {}),
    };

    let needsCloudUpdate = false;

    // 1. Scan access_codes table to discover accounts registered on other PCs
    try {
      const { data: usedCodes } = await supabase
        .from("access_codes")
        .select("code, role, used_at, used_by_email, used_by")
        .not("used_by_email", "is", null);

      if (usedCodes && usedCodes.length > 0) {
        usedCodes.forEach((ac) => {
          if (!ac.used_by_email) return;
          const emailKey = ac.used_by_email.toLowerCase();
          if (!cloudStaffMap[emailKey]) {
            const rawPart = emailKey.split("@")[0] || "official";
            const formattedName = rawPart
              .split(/[\._\-]/)
              .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
              .join(" ");

            cloudStaffMap[emailKey] = {
              name: formattedName || (ac.role === "admin" ? "Tournament Director" : "Match Official"),
              email: emailKey,
              role: ac.role === "admin" ? "admin" : "umpire",
              accessCode: ac.code,
              certifiedAt: ac.used_at ? ac.used_at.split("T")[0] : undefined,
              status: "active",
            };
            needsCloudUpdate = true;
          } else {
            const existing = cloudStaffMap[emailKey]!;
            if (!existing.accessCode && ac.code) {
              existing.accessCode = ac.code;
              needsCloudUpdate = true;
            }
            if (!existing.certifiedAt && ac.used_at) {
              existing.certifiedAt = ac.used_at.split("T")[0];
              needsCloudUpdate = true;
            }
          }
        });
      }
    } catch (err) {
      console.warn("[Supabase] Notice scanning access_codes during sync:", err);
    }

    // 2. Check if any local users are not in cloud
    for (const u of localUsers) {
      const emailKey = u.email.toLowerCase();
      if (!cloudStaffMap[emailKey]) {
        cloudStaffMap[emailKey] = {
          ...u,
          status: u.status || "active",
          email: emailKey,
        };
        needsCloudUpdate = true;
      } else {
        if (u.status && !cloudStaffMap[emailKey].status) {
          cloudStaffMap[emailKey].status = u.status;
          needsCloudUpdate = true;
        }
        if (u.password && !cloudStaffMap[emailKey].password) {
          cloudStaffMap[emailKey].password = u.password;
          needsCloudUpdate = true;
        }
      }
    }

    // 3. Persist back to tournament rules if new accounts were discovered
    if (needsCloudUpdate) {
      const updatedRules = {
        ...existingRules,
        staffAccounts: cloudStaffMap,
      };

      try {
        await supabase
          .from("tournaments")
          .update({ rules: updatedRules, updated_at: new Date().toISOString() })
          .eq("id", tourney.id);
      } catch {
        // ignore
      }
    }

    return Object.values(cloudStaffMap);
  } catch (err) {
    console.warn("[Supabase] Failed to sync staff accounts:", err);
    return localUsers;
  }
}



