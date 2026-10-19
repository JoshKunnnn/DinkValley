-- Dink Valley - Restore Admin Cloud Synchronization & Realtime
-- Migration: 20261020000000_restore_admin_cloud_sync.sql

-- 1. Grant table access to both anon and authenticated clients
GRANT ALL ON public.tournaments TO anon, authenticated;
GRANT ALL ON public.categories TO anon, authenticated;
GRANT ALL ON public.teams TO anon, authenticated;
GRANT ALL ON public.matches TO anon, authenticated;
GRANT ALL ON public.court_stations TO anon, authenticated;
GRANT ALL ON public.profiles TO anon, authenticated;
GRANT ALL ON public.access_codes TO anon, authenticated;

-- Ensure RLS is active on tables
ALTER TABLE public.tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.court_stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_codes ENABLE ROW LEVEL SECURITY;

-- 2. Drop all previous restrictive policies
DROP POLICY IF EXISTS "tournaments_public_read" ON public.tournaments;
DROP POLICY IF EXISTS "tournaments_admin_insert" ON public.tournaments;
DROP POLICY IF EXISTS "tournaments_staff_update" ON public.tournaments;
DROP POLICY IF EXISTS "tournaments_admin_delete" ON public.tournaments;
DROP POLICY IF EXISTS "Allow all access to tournaments" ON public.tournaments;
DROP POLICY IF EXISTS "tournaments_full_access" ON public.tournaments;

DROP POLICY IF EXISTS "categories_public_read" ON public.categories;
DROP POLICY IF EXISTS "categories_admin_write" ON public.categories;
DROP POLICY IF EXISTS "Allow all access to categories" ON public.categories;
DROP POLICY IF EXISTS "categories_full_access" ON public.categories;

DROP POLICY IF EXISTS "teams_public_read" ON public.teams;
DROP POLICY IF EXISTS "teams_admin_write" ON public.teams;
DROP POLICY IF EXISTS "Allow all access to teams" ON public.teams;
DROP POLICY IF EXISTS "teams_full_access" ON public.teams;

DROP POLICY IF EXISTS "matches_public_read" ON public.matches;
DROP POLICY IF EXISTS "matches_staff_write" ON public.matches;
DROP POLICY IF EXISTS "Allow all access to matches" ON public.matches;
DROP POLICY IF EXISTS "matches_full_access" ON public.matches;

DROP POLICY IF EXISTS "court_stations_public_read" ON public.court_stations;
DROP POLICY IF EXISTS "court_stations_staff_write" ON public.court_stations;
DROP POLICY IF EXISTS "Allow all access to court_stations" ON public.court_stations;
DROP POLICY IF EXISTS "court_stations_full_access" ON public.court_stations;

DROP POLICY IF EXISTS "access_codes_admin_all" ON public.access_codes;
DROP POLICY IF EXISTS "access_codes_full_access" ON public.access_codes;

-- 3. Create permissive application policies
CREATE POLICY "tournaments_full_access" ON public.tournaments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "categories_full_access" ON public.categories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "teams_full_access" ON public.teams FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "matches_full_access" ON public.matches FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "court_stations_full_access" ON public.court_stations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "access_codes_full_access" ON public.access_codes FOR ALL USING (true) WITH CHECK (true);

-- 4. Enable Realtime publication so all connected clients receive instant push updates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'tournaments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tournaments;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'categories'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.categories;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'teams'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.teams;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'matches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.matches;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'court_stations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.court_stations;
  END IF;
END $$;
