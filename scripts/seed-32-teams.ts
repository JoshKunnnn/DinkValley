/**
 * Dink Valley - 32 Teams Seed Script
 *
 * Populates 32 realistic, verified pickleball doubles teams into a tournament category.
 *
 * Usage:
 *   npx tsx scripts/seed-32-teams.ts
 *   npx tsx scripts/seed-32-teams.ts --slug santiago-pickleball-open-2026 --category open-champ
 *   npx tsx scripts/seed-32-teams.ts --clear
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { generate32Teams } from "../src/lib/team-generator.js";

// Load .env manually if not already in process.env
function loadEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Parse CLI flags
function parseArgs() {
  const args = process.argv.slice(2);
  const flags: { slug?: string; category?: string; clear?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--slug" && args[i + 1]) {
      flags.slug = args[++i];
    } else if (arg === "--category" && args[i + 1]) {
      flags.category = args[++i];
    } else if (arg === "--clear") {
      flags.clear = true;
    }
  }

  return flags;
}

async function main() {
  const flags = parseArgs();
  console.log("=== Dink Valley: 32-Team Auto-Population Script ===");
  console.log("Connecting to Supabase at:", SUPABASE_URL);

  // 1. Find or create tournament
  let tournamentId: string | null = null;
  let tournamentSlug = flags.slug;

  if (tournamentSlug) {
    const { data: tourney, error } = await supabase
      .from("tournaments")
      .select("id, slug, name")
      .eq("slug", tournamentSlug)
      .maybeSingle();

    if (error) {
      console.error("Error querying tournament by slug:", error.message);
      process.exit(1);
    }

    if (tourney) {
      tournamentId = tourney.id;
      console.log(`Found tournament: "${tourney.name}" (${tourney.slug})`);
    }
  }

  if (!tournamentId) {
    // Get first tournament or create default
    const { data: list } = await supabase
      .from("tournaments")
      .select("id, slug, name")
      .order("created_at", { ascending: false })
      .limit(1);

    if (list && list.length > 0 && !flags.slug) {
      tournamentId = list[0]!.id;
      tournamentSlug = list[0]!.slug;
      console.log(`Using active tournament: "${list[0]!.name}" (${list[0]!.slug})`);
    } else {
      // Create new tournament
      tournamentSlug = tournamentSlug || "santiago-pickleball-open-2026";
      console.log(`Creating default tournament: "${tournamentSlug}"...`);

      const { data: createdTourney, error: createErr } = await supabase
        .from("tournaments")
        .upsert(
          {
            name: "Santiago Pickleball Open 2026",
            slug: tournamentSlug,
            tagline: "Premier Valley Championship",
            status: "Registration open",
            date: "October 24 - 26, 2026",
            venue: "Santiago City Sports Complex",
            city: "Santiago City",
            entry_fee: "PHP 1,500 per team",
            format: "Round robin pools of 4, top teams advance to playoffs",
            rules: [
              "Standard side-out scoring to 11, win by 2.",
              "Facility constraint: strictly 4 courts active at a time.",
              "Players must report courtside within 5 minutes of dispatch call.",
            ],
            schedule: [
              { time: "7:00 AM", title: "Check-in", detail: "Player briefing and court assignments" },
              { time: "8:00 AM", title: "Pool Play Matches begin", detail: "Courts 1-4" },
              { time: "2:00 PM", title: "Playoff Brackets", detail: "Quarterfinals to Finals" },
            ],
          },
          { onConflict: "slug" }
        )
        .select("id")
        .single();

      if (createErr || !createdTourney) {
        console.error("Failed to create tournament:", createErr?.message);
        process.exit(1);
      }

      tournamentId = createdTourney.id;
    }
  }

  // 2. Find or create category
  let categoryId: string | null = null;
  let categorySlug = flags.category;

  if (categorySlug) {
    const { data: cat } = await supabase
      .from("categories")
      .select("id, category_slug, label")
      .eq("tournament_id", tournamentId)
      .eq("category_slug", categorySlug)
      .maybeSingle();

    if (cat) {
      categoryId = cat.id;
      console.log(`Found category: "${cat.label}" (${cat.category_slug})`);
    }
  }

  if (!categoryId) {
    const { data: categories } = await supabase
      .from("categories")
      .select("id, category_slug, label")
      .eq("tournament_id", tournamentId)
      .limit(1);

    if (categories && categories.length > 0 && !flags.category) {
      categoryId = categories[0]!.id;
      categorySlug = categories[0]!.category_slug;
      console.log(`Using active category: "${categories[0]!.label}" (${categories[0]!.category_slug})`);
    } else {
      categorySlug = categorySlug || "open-champ";
      console.log(`Creating default category "${categorySlug}"...`);

      const { data: createdCat, error: catErr } = await supabase
        .from("categories")
        .upsert(
          {
            tournament_id: tournamentId,
            category_slug: categorySlug,
            label: "Open Championship",
            level: "Open",
            division: "Open",
            entry_fee: "PHP 1,500 per team",
          },
          { onConflict: "tournament_id,category_slug" }
        )
        .select("id")
        .single();

      if (catErr || !createdCat) {
        console.error("Failed to create category:", catErr?.message);
        process.exit(1);
      }

      categoryId = createdCat.id;
    }
  }

  // 3. Clear existing teams if requested
  if (flags.clear) {
    console.log(`Clearing existing teams in category ${categorySlug}...`);
    const { error: delErr } = await supabase
      .from("teams")
      .delete()
      .eq("tournament_id", tournamentId)
      .eq("category_id", categoryId);

    if (delErr) {
      console.warn("Warning clearing teams:", delErr.message);
    } else {
      console.log("Existing teams cleared.");
    }
  }

  // 4. Generate 32 teams
  console.log("Generating 32 verified pickleball doubles teams...");
  const generated = generate32Teams({ verifiedOnly: true });

  const rowsToInsert = generated.map((t) => ({
    tournament_id: tournamentId!,
    category_id: categoryId!,
    name: t.name,
    players: t.players,
    club: t.club,
    paid: t.paid,
    payment_ref: t.paymentRef,
    payment_status: t.paymentStatus,
    payment_proof_url: t.paymentProofUrl,
  }));

  const { data: inserted, error: insertErr } = await supabase
    .from("teams")
    .insert(rowsToInsert)
    .select("id, name, players, club, payment_status");

  if (insertErr) {
    console.error("Error inserting teams:", insertErr.message);
    process.exit(1);
  }

  console.log(`Successfully populated ${inserted?.length || 32} teams!`);
  console.log("\nSummary of Generated Teams:");
  console.table(
    (inserted || []).slice(0, 8).map((t, idx) => ({
      Index: idx + 1,
      Name: t.name,
      Players: Array.isArray(t.players) ? t.players.join(" & ") : t.players,
      Club: t.club,
      Status: t.payment_status,
    }))
  );
  console.log(`... and ${(inserted?.length || 32) - 8} more teams (Total 32 teams).`);
  console.log("\nYou can now open http://localhost:8080/admin to see the roster and draw 8 brackets of 4 teams!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
