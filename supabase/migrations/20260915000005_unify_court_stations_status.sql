-- Dink Valley - Unify Court Stations Status Constraint
-- Migration: 20260915000005_unify_court_stations_status.sql

-- Drop existing strict check constraint that only allowed ('idle', 'in-match', 'warmup', 'maintenance')
ALTER TABLE public.court_stations 
  DROP CONSTRAINT IF EXISTS court_stations_status_check;

-- Add unified check constraint that supports both Postgres and TypeScript conventions
ALTER TABLE public.court_stations 
  ADD CONSTRAINT court_stations_status_check 
  CHECK (status IN ('idle', 'available', 'in-match', 'live', 'warmup', 'maintenance'));
