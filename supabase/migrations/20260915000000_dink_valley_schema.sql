-- Dink Valley Pickleball Club - PostgreSQL Schema
-- Migration: 20260915000000_dink_valley_schema.sql

-- 1. Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Tournaments Table
CREATE TABLE IF NOT EXISTS public.tournaments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    tagline TEXT,
    status TEXT NOT NULL DEFAULT 'Registration open' CHECK (status IN ('Registration open', 'Live', 'Completed')),
    date TEXT,
    venue TEXT DEFAULT 'Santiago City',
    city TEXT DEFAULT 'Santiago City',
    entry_fee TEXT DEFAULT 'PHP 900 per player',
    format TEXT DEFAULT 'Round robin pools, top 4 advance to playoffs',
    rules JSONB DEFAULT '["Games to 11, win by 2. Playoff finals to 15.", "Facility constraint: strictly 4 courts active at a time. Other matches wait in Queue.", "Players must report courtside within 5 minutes of dispatch call."]'::jsonb,
    schedule JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Categories (Divisions) Table
CREATE TABLE IF NOT EXISTS public.categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    category_slug TEXT NOT NULL,
    label TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('Beginners', 'Novice', 'Intermediate', 'Advance', 'Open')),
    division TEXT NOT NULL CHECK (division IN ('Men''s', 'Women''s', 'Mixed', 'Open')),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(tournament_id, category_slug)
);

-- 4. Teams Table
CREATE TABLE IF NOT EXISTS public.teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    players TEXT[] NOT NULL DEFAULT '{}',
    club TEXT,
    paid BOOLEAN DEFAULT false,
    payment_proof_url TEXT,
    payment_ref TEXT,
    payment_status TEXT DEFAULT 'Pending' CHECK (payment_status IN ('Verified', 'Pending', 'Unpaid')),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Matches Table (Pool Matches, Live Scores, Playoffs)
CREATE TABLE IF NOT EXISTS public.matches (
    id TEXT PRIMARY KEY,
    tournament_id UUID NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
    stage TEXT NOT NULL DEFAULT 'Pool Play',
    match_type TEXT NOT NULL DEFAULT 'pool' CHECK (match_type IN ('pool', 'playoff', 'exhibition')),
    court TEXT NOT NULL DEFAULT 'Queue' CHECK (court IN ('Court 1', 'Court 2', 'Court 3', 'Court 4', 'Queue')),
    team_a_id UUID REFERENCES public.teams(id) ON DELETE SET NULL,
    team_a_name TEXT NOT NULL,
    team_a_players TEXT[] DEFAULT '{}',
    team_b_id UUID REFERENCES public.teams(id) ON DELETE SET NULL,
    team_b_name TEXT NOT NULL,
    team_b_players TEXT[] DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'final')),
    team_a_score INTEGER NOT NULL DEFAULT 0,
    team_b_score INTEGER NOT NULL DEFAULT 0,
    serving_team TEXT NOT NULL DEFAULT 'A' CHECK (serving_team IN ('A', 'B')),
    server_number INTEGER NOT NULL DEFAULT 1 CHECK (server_number IN (1, 2)),
    rallies JSONB DEFAULT '[]'::jsonb,
    winner_team TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    officiated_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 6. Dedicated 4-Court Facility Stations Table
CREATE TABLE IF NOT EXISTS public.court_stations (
    court_name TEXT PRIMARY KEY CHECK (court_name IN ('Court 1', 'Court 2', 'Court 3', 'Court 4')),
    tournament_id UUID REFERENCES public.tournaments(id) ON DELETE SET NULL,
    current_match_id TEXT,
    on_deck_match_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'in-match', 'warmup', 'maintenance')),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed fixed facility stations 1 to 4
INSERT INTO public.court_stations (court_name, status)
VALUES
    ('Court 1', 'idle'),
    ('Court 2', 'idle'),
    ('Court 3', 'idle'),
    ('Court 4', 'idle')
ON CONFLICT (court_name) DO NOTHING;

-- 7. User Profiles & Roles Table
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT UNIQUE,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'spectator' CHECK (role IN ('admin', 'umpire', 'spectator')),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_tournaments_slug ON public.tournaments(slug);
CREATE INDEX IF NOT EXISTS idx_categories_tournament ON public.categories(tournament_id);
CREATE INDEX IF NOT EXISTS idx_teams_tournament ON public.teams(tournament_id);
CREATE INDEX IF NOT EXISTS idx_teams_category ON public.teams(category_id);
CREATE INDEX IF NOT EXISTS idx_matches_tournament ON public.matches(tournament_id);
CREATE INDEX IF NOT EXISTS idx_matches_category ON public.matches(category_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON public.matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_court ON public.matches(court);

-- 9. Row Level Security (RLS)
ALTER TABLE public.tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.court_stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Public Read Policies (Anyone can view tournaments, brackets, and live scores)
CREATE POLICY "Public read tournaments" ON public.tournaments FOR SELECT USING (true);
CREATE POLICY "Public read categories" ON public.categories FOR SELECT USING (true);
CREATE POLICY "Public read teams" ON public.teams FOR SELECT USING (true);
CREATE POLICY "Public read matches" ON public.matches FOR SELECT USING (true);
CREATE POLICY "Public read court_stations" ON public.court_stations FOR SELECT USING (true);
CREATE POLICY "Public read profiles" ON public.profiles FOR SELECT USING (true);

-- Authenticated Full Access Policies (Admins & match officials)
CREATE POLICY "Authenticated full access tournaments" ON public.tournaments FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access categories" ON public.categories FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access teams" ON public.teams FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access matches" ON public.matches FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated full access court_stations" ON public.court_stations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Users can edit own profile" ON public.profiles FOR ALL TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Anon Insert Policy for Team Registration
CREATE POLICY "Anon insert teams" ON public.teams FOR INSERT TO anon WITH CHECK (true);

-- 10. Enable Supabase Realtime for instant spectator updates
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'matches'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.matches;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'court_stations'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.court_stations;
    END IF;
END $$;
