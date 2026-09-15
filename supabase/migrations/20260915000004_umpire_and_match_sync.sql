-- Dink Valley - Umpire & Live Match Sync Enhancements
-- Migration: 20260915000004_umpire_and_match_sync.sql

-- 1. Make tournament_id and category_id nullable on matches so all dispatched and facility matches can persist cleanly
ALTER TABLE public.matches ALTER COLUMN tournament_id DROP NOT NULL;
ALTER TABLE public.matches ALTER COLUMN category_id DROP NOT NULL;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS tournament_slug TEXT;

-- 2. Add umpire assignment and dispatch tracking to court_stations
ALTER TABLE public.court_stations ADD COLUMN IF NOT EXISTS assigned_umpire TEXT;
ALTER TABLE public.court_stations ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE public.court_stations ADD COLUMN IF NOT EXISTS maintenance_note TEXT;
