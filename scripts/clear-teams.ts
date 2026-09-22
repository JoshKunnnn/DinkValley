/**
 * Dink Valley - Clear All Teams & Players Script
 *
 * Deletes all teams from a specific tournament category (or all categories) in Supabase.
 *
 * Usage:
 *   npx tsx scripts/clear-teams.ts
 *   npx tsx scripts/clear-teams.ts --slug santiago-pickleball-open-2026 --category open-champ
 *   npx tsx scripts/clear-teams.ts --all-categories
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

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

function parseArgs() {
  const args = process.argv.slice(2);
  const flags: { slug?: string; category?: string; allCategories?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--slug" && args[i + 1]) {
      flags.slug = args[++i];
    } else if (arg === "--category" && args[i + 1]) {
      flags.category = args[++i];
    } else if (arg === "--all-categories") {
      flags.allCategories = true;
    }
  }

  return flags;
}

async function main() {
  const flags = parseArgs();
  console.log("=== Dink Valley: Delete All Teams & Players Script ===");

  // 1. Resolve Tournament
  let tournamentId: string | null = null;
  let tournamentSlug = flags.slug;

  if (tournamentSlug) {
    const { data: tourney } = await supabase
      .from("tournaments")
      .select("id, slug, name")
      .eq("slug", tournamentSlug)
      .maybeSingle();

    if (tourney) {
      tournamentId = tourney.id;
      console.log(`Targeting tournament: "${tourney.name}" (${tourney.slug})`);
    }
  }

  if (!tournamentId) {
    const { data: list } = await supabase
      .from("tournaments")
      .select("id, slug, name")
      .order("created_at", { ascending: false })
      .limit(1);

    if (list && list.length > 0) {
      tournamentId = list[0]!.id;
      tournamentSlug = list[0]!.slug;
      console.log(`Using active tournament: "${list[0]!.name}" (${list[0]!.slug})`);
    } else {
      console.log("No tournaments found to clear.");
      return;
    }
  }

  // 2. Clear teams
  if (flags.allCategories) {
    console.log("Deleting teams across all categories for tournament:", tournamentSlug);
    const { error, count } = await supabase
      .from("teams")
      .delete()
      .eq("tournament_id", tournamentId);

    if (error) {
      console.error("Error deleting teams:", error.message);
      process.exit(1);
    }
    console.log("Successfully deleted all teams across all categories.");
  } else {
    // Resolve specific category
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
        console.log(`Targeting category: "${cat.label}" (${cat.category_slug})`);
      }
    }

    if (!categoryId) {
      const { data: cats } = await supabase
        .from("categories")
        .select("id, category_slug, label")
        .eq("tournament_id", tournamentId)
        .limit(1);

      if (cats && cats.length > 0) {
        categoryId = cats[0]!.id;
        categorySlug = cats[0]!.category_slug;
        console.log(`Using active category: "${cats[0]!.label}" (${cats[0]!.category_slug})`);
      }
    }

    if (categoryId) {
      const { error } = await supabase
        .from("teams")
        .delete()
        .eq("tournament_id", tournamentId)
        .eq("category_id", categoryId);

      if (error) {
        console.error("Error deleting teams:", error.message);
        process.exit(1);
      }
      console.log(`Successfully deleted all teams in category: "${categorySlug}".`);
    } else {
      console.log("No categories found to clear.");
    }
  }

  console.log("All matching teams have been cleared from Supabase.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
