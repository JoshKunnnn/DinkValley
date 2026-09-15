-- Dink Valley - Enable flexible profiles registration
-- Migration: 20260915000002_flexible_profiles.sql

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;
ALTER TABLE public.profiles ALTER COLUMN id SET DEFAULT gen_random_uuid();

DROP POLICY IF EXISTS "Users can edit own profile" ON public.profiles;
DROP POLICY IF EXISTS "Public read profiles" ON public.profiles;
CREATE POLICY "Allow all access to profiles" ON public.profiles FOR ALL USING (true) WITH CHECK (true);
