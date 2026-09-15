-- Dink Valley - Enable full access for both anon and authenticated users
-- Migration: 20260915000001_enable_app_access.sql

-- 1. Tournaments
DROP POLICY IF EXISTS "Authenticated full access tournaments" ON public.tournaments;
DROP POLICY IF EXISTS "Public read tournaments" ON public.tournaments;
CREATE POLICY "Allow all access to tournaments" ON public.tournaments FOR ALL USING (true) WITH CHECK (true);

-- 2. Categories
DROP POLICY IF EXISTS "Authenticated full access categories" ON public.categories;
DROP POLICY IF EXISTS "Public read categories" ON public.categories;
CREATE POLICY "Allow all access to categories" ON public.categories FOR ALL USING (true) WITH CHECK (true);

-- 3. Teams
DROP POLICY IF EXISTS "Authenticated full access teams" ON public.teams;
DROP POLICY IF EXISTS "Anon insert teams" ON public.teams;
DROP POLICY IF EXISTS "Public read teams" ON public.teams;
CREATE POLICY "Allow all access to teams" ON public.teams FOR ALL USING (true) WITH CHECK (true);

-- 4. Matches
DROP POLICY IF EXISTS "Authenticated full access matches" ON public.matches;
DROP POLICY IF EXISTS "Public read matches" ON public.matches;
CREATE POLICY "Allow all access to matches" ON public.matches FOR ALL USING (true) WITH CHECK (true);

-- 5. Court Stations
DROP POLICY IF EXISTS "Authenticated full access court_stations" ON public.court_stations;
DROP POLICY IF EXISTS "Public read court_stations" ON public.court_stations;
CREATE POLICY "Allow all access to court_stations" ON public.court_stations FOR ALL USING (true) WITH CHECK (true);
