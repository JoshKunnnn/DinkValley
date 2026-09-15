-- Dink Valley - Add entry_fee to categories table for division-specific pricing
-- Migration: 20260915000003_category_entry_fee.sql

ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS entry_fee TEXT;
