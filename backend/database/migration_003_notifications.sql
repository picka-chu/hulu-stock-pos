-- Migration 003: Create notifications table
-- Run this in Supabase SQL Editor if notifications table doesn't exist yet

CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    notification_type VARCHAR(50) NOT NULL DEFAULT 'system_alert',
    is_read BOOLEAN DEFAULT false,
    related_id UUID,
    link VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_org     ON notifications(organization_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user    ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read    ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

-- Enable RLS + allow service role full access
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notifications_service_all" ON notifications;
CREATE POLICY "notifications_service_all" ON notifications
    USING (true) WITH CHECK (true);

-- IMPORTANT: Enable Supabase Realtime for this table
-- Run in Supabase Dashboard > Database > Replication > Tables
-- OR run this:
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;

SELECT 'notifications table ready' as status;
