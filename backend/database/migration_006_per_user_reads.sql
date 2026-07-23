-- ============================================================
-- Migration 006: Per-User Notification Read Tracking
-- Run this in Supabase SQL Editor AFTER migration_005
-- ============================================================
-- Replaces the single is_read flag (which affects ALL users)
-- with a per-user read table. Each user gets their own read state.
-- The is_read column stays for backward compat but is no longer used
-- for broadcast notifications — only for targeted (user_id IS NOT NULL).
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_reads (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at         TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notif_reads_user
    ON notification_reads(user_id);

CREATE INDEX IF NOT EXISTS idx_notif_reads_notif
    ON notification_reads(notification_id);

ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notif_reads_all ON notification_reads;
CREATE POLICY notif_reads_all
    ON notification_reads FOR ALL
    USING (TRUE)
    WITH CHECK (TRUE);
