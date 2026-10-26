-- Migration: 20261025000000_tournament_brackets_and_match_integrity.sql
-- Description: Creates authoritative tournament_brackets table, adds bracket columns to matches,
-- and enforces category relational integrity to prevent cross-category leakage and ghost duplicates.

-- 1. Create tournament_brackets table
CREATE TABLE IF NOT EXISTS public.tournament_brackets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
    bracket_letter VARCHAR(2) NOT NULL,
    stage_type VARCHAR(20) NOT NULL DEFAULT 'pool', -- 'pool' or 'playoff'
    name VARCHAR(100) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'in_progress',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    CONSTRAINT unique_category_bracket UNIQUE(category_id, bracket_letter, stage_type)
);

-- 2. Add relational columns to matches
ALTER TABLE public.matches 
    ADD COLUMN IF NOT EXISTS bracket_id UUID REFERENCES public.tournament_brackets(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS bracket_letter VARCHAR(2);

-- 3. Composite index on matches for fast category and stage lookups
CREATE INDEX IF NOT EXISTS idx_matches_category_stage 
    ON public.matches (category_id, stage);

CREATE INDEX IF NOT EXISTS idx_matches_tournament_category 
    ON public.matches (tournament_id, category_id);
