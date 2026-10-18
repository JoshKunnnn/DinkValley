-- Dink Valley - Security Lockdown
-- Migration: 20261015000000_security_lockdown.sql
--
-- Replaces the "allow everything" RLS policies with least-privilege rules:
--   * Everyone (anon) can READ tournaments, categories, teams, matches, court stations.
--   * Only signed-in ADMINS can create/delete tournaments and manage categories/teams.
--   * Signed-in STAFF (admin + umpire) can score matches, update court stations and
--     update tournament metadata (dispatch queue is stored in tournaments.rules).
--   * Public team registration goes through the validated `register_team` RPC
--     (always inserted as unpaid / Pending).
--   * Roles live in public.profiles, linked 1:1 to auth.users, and can only be
--     granted by redeeming a server-side access code or by an admin.
--
-- After applying, bootstrap your first admin (see README "Security setup").

-- ─────────────────────────────────────────────────────────────
-- 1. Profiles: re-link to auth.users
-- ─────────────────────────────────────────────────────────────

-- Preserve any legacy (mock) profile rows that are not tied to a real auth user,
-- then remove them from the live table so the FK can be restored.
CREATE TABLE IF NOT EXISTS public.profiles_legacy_backup AS
  SELECT * FROM public.profiles WHERE false;

INSERT INTO public.profiles_legacy_backup
  SELECT p.* FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);

DELETE FROM public.profiles p
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);

-- Backup table is never exposed through the API.
ALTER TABLE public.profiles_legacy_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profiles_legacy_backup FROM anon, authenticated;

ALTER TABLE public.profiles ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- Backfill a spectator profile for any existing auth users without one.
INSERT INTO public.profiles (id, email, name, role)
  SELECT u.id, lower(u.email), u.raw_user_meta_data->>'name', 'spectator'
  FROM auth.users u
  WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 2. Access codes (server-side, admin-managed, single-use)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.access_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE CHECK (code = upper(code) AND length(code) >= 8 AND code ~ '^[A-Z0-9-]+$'),
    role TEXT NOT NULL CHECK (role IN ('admin', 'umpire')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
    created_by_name TEXT,
    used_at TIMESTAMPTZ,
    used_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    used_by_email TEXT
);

ALTER TABLE public.access_codes ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────
-- 3. Role helper functions (SECURITY DEFINER avoids RLS recursion)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT coalesce((SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid()), false)
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT coalesce((SELECT role IN ('admin', 'umpire') FROM public.profiles WHERE id = auth.uid()), false)
$$;

-- ─────────────────────────────────────────────────────────────
-- 4. New-user trigger: create profile + atomically redeem access code
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_code    TEXT := upper(trim(coalesce(NEW.raw_user_meta_data->>'access_code', '')));
  v_name    TEXT := nullif(trim(coalesce(NEW.raw_user_meta_data->>'name', '')), '');
  v_role    TEXT := 'spectator';
  v_code_id UUID;
BEGIN
  IF v_code <> '' THEN
    SELECT id, role INTO v_code_id, v_role
      FROM public.access_codes
      WHERE code = v_code AND used_at IS NULL
      FOR UPDATE;

    IF v_code_id IS NULL THEN
      -- Aborts the sign-up; the client surfaces a friendly message.
      RAISE EXCEPTION 'INVALID_ACCESS_CODE';
    END IF;

    UPDATE public.access_codes
      SET used_at = now(), used_by = NEW.id, used_by_email = lower(NEW.email)
      WHERE id = v_code_id;
  END IF;

  INSERT INTO public.profiles (id, email, name, role)
  VALUES (NEW.id, lower(NEW.email), v_name, v_role);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 5. Public RPCs
-- ─────────────────────────────────────────────────────────────

-- Pre-flight check used by the registration form (returns the code's role or NULL).
CREATE OR REPLACE FUNCTION public.check_access_code(p_code TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT role FROM public.access_codes
  WHERE code = upper(trim(p_code)) AND used_at IS NULL
$$;

-- Validated public team registration. Always inserts as unpaid / Pending.
CREATE OR REPLACE FUNCTION public.register_team(
  p_tournament_slug   TEXT,
  p_category_slug     TEXT,
  p_team_name         TEXT,
  p_players           TEXT[],
  p_club              TEXT DEFAULT NULL,
  p_payment_ref       TEXT DEFAULT NULL,
  p_payment_proof_url TEXT DEFAULT NULL,
  p_team_id           UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tournament_id UUID;
  v_category_id   UUID;
  v_verified      INTEGER;
  v_team_id       UUID;
  v_name          TEXT := trim(coalesce(p_team_name, ''));
BEGIN
  SELECT id INTO v_tournament_id FROM public.tournaments WHERE slug = p_tournament_slug;
  IF v_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Tournament not found.';
  END IF;

  SELECT id INTO v_category_id
    FROM public.categories
    WHERE tournament_id = v_tournament_id
      AND (category_slug = p_category_slug OR id::text = p_category_slug)
    LIMIT 1;
  IF v_category_id IS NULL THEN
    RAISE EXCEPTION 'Division not found.';
  END IF;

  IF length(v_name) = 0 OR length(v_name) > 80 THEN
    RAISE EXCEPTION 'Team name must be between 1 and 80 characters.';
  END IF;

  IF p_players IS NULL OR coalesce(array_length(p_players, 1), 0) <> 2
     OR EXISTS (SELECT 1 FROM unnest(p_players) AS pl WHERE length(trim(coalesce(pl, ''))) = 0 OR length(pl) > 80) THEN
    RAISE EXCEPTION 'Exactly two player names (max 80 characters each) are required.';
  END IF;

  IF p_club IS NOT NULL AND length(p_club) > 120 THEN
    RAISE EXCEPTION 'Club name is too long.';
  END IF;

  IF p_payment_ref IS NOT NULL AND length(p_payment_ref) > 120 THEN
    RAISE EXCEPTION 'Payment reference is too long.';
  END IF;

  IF p_payment_proof_url IS NOT NULL AND (
       length(p_payment_proof_url) > 3000000
       OR p_payment_proof_url !~ '^data:image/(png|jpe?g|webp);base64,'
     ) THEN
    RAISE EXCEPTION 'Receipt must be a PNG, JPG or WebP image under ~2MB.';
  END IF;

  SELECT count(*) INTO v_verified
    FROM public.teams
    WHERE category_id = v_category_id AND (paid = true OR payment_status = 'Verified');
  IF v_verified >= 32 THEN
    RAISE EXCEPTION 'This division is full (32/32 teams).';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.teams
    WHERE category_id = v_category_id AND lower(trim(name)) = lower(v_name)
  ) THEN
    RAISE EXCEPTION 'A team named "%" is already registered (or pending) in this division.', v_name;
  END IF;

  INSERT INTO public.teams (
    id, tournament_id, category_id, name, players, club,
    paid, payment_status, payment_ref, payment_proof_url
  )
  VALUES (
    coalesce(p_team_id, gen_random_uuid()), v_tournament_id, v_category_id, v_name,
    ARRAY[trim(p_players[1]), trim(p_players[2])], nullif(trim(coalesce(p_club, '')), ''),
    false, 'Pending', nullif(trim(coalesce(p_payment_ref, '')), ''), p_payment_proof_url
  )
  RETURNING id INTO v_team_id;

  RETURN v_team_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_access_code(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_team(TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 6. Reset ALL existing policies on app tables, then recreate
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('tournaments', 'categories', 'teams', 'matches', 'court_stations', 'profiles', 'access_codes')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

ALTER TABLE public.tournaments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.court_stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles       ENABLE ROW LEVEL SECURITY;

-- Tournaments: public read · admin create/delete · staff update (dispatch queue lives in rules)
CREATE POLICY "tournaments_public_read"  ON public.tournaments FOR SELECT USING (true);
CREATE POLICY "tournaments_admin_insert" ON public.tournaments FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "tournaments_staff_update" ON public.tournaments FOR UPDATE TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());
CREATE POLICY "tournaments_admin_delete" ON public.tournaments FOR DELETE TO authenticated USING (public.is_admin());

-- Categories: public read · admin write
CREATE POLICY "categories_public_read" ON public.categories FOR SELECT USING (true);
CREATE POLICY "categories_admin_write" ON public.categories FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Teams: public read · admin write (public sign-ups go through register_team RPC)
CREATE POLICY "teams_public_read" ON public.teams FOR SELECT USING (true);
CREATE POLICY "teams_admin_write" ON public.teams FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Matches: public read · staff write
CREATE POLICY "matches_public_read" ON public.matches FOR SELECT USING (true);
CREATE POLICY "matches_staff_write" ON public.matches FOR ALL TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());

-- Court stations: public read · staff write
CREATE POLICY "court_stations_public_read" ON public.court_stations FOR SELECT USING (true);
CREATE POLICY "court_stations_staff_write" ON public.court_stations FOR ALL TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());

-- Profiles: users read their own; admins read/update/delete all. Inserts only via trigger.
CREATE POLICY "profiles_read_own_or_admin" ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid() OR public.is_admin());
CREATE POLICY "profiles_admin_update"      ON public.profiles FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "profiles_admin_delete"      ON public.profiles FOR DELETE TO authenticated USING (public.is_admin());

-- Access codes: admins only
CREATE POLICY "access_codes_admin_all" ON public.access_codes FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ─────────────────────────────────────────────────────────────
-- 7. Defense in depth: anon role never writes tables directly
-- ─────────────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.tournaments, public.categories, public.teams, public.matches,
  public.court_stations, public.profiles, public.access_codes
FROM anon;

REVOKE ALL ON public.access_codes FROM anon;
