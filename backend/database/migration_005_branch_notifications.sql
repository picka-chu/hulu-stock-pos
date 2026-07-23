-- ============================================================
-- Migration 005: Branch-filtered Notifications
-- Run this in Supabase SQL Editor AFTER migration_004
-- ============================================================

-- Add branch_id column to notifications
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE SET NULL;

-- Index for fast branch filtering
CREATE INDEX IF NOT EXISTS idx_notifications_branch
    ON notifications(branch_id)
    WHERE branch_id IS NOT NULL;

-- branch_id = NULL means it's a global/admin-only notification (no branch filter)
-- branch_id = <uuid> means only users of that branch + admins should see it
