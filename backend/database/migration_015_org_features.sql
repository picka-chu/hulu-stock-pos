-- =====================================================
-- Migration 015: Per-organisation feature flags
-- Run this in Supabase SQL editor
-- =====================================================

-- Add features column to organizations table
-- Stores granular feature permissions as a JSON object
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{
    "branches":          true,
    "multi_user":        true,
    "ai_scan":           true,
    "fast_scan":         true,
    "smart_scan":        true,
    "reports":           true,
    "expenses":          true,
    "suppliers":         true,
    "export":            true,
    "push_notifications":true,
    "phone_camera":      true,
    "max_branches":      0,
    "max_users":         0
  }'::jsonb;

-- Add notes column for superadmin internal notes per org
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';

-- Backfill: make sure existing rows have the full default object
UPDATE organizations
SET features = '{
    "branches":          true,
    "multi_user":        true,
    "ai_scan":           true,
    "fast_scan":         true,
    "smart_scan":        true,
    "reports":           true,
    "expenses":          true,
    "suppliers":         true,
    "export":            true,
    "push_notifications":true,
    "phone_camera":      true,
    "max_branches":      0,
    "max_users":         0
  }'::jsonb
WHERE features IS NULL OR features = '{}'::jsonb;
