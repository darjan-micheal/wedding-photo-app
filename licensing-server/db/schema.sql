-- licensing-server/db/schema.sql

-- This schema is future-proofed. Later, we can add a 'payments' table linked to user_id.
CREATE TABLE IF NOT EXISTS license_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL,
    plan TEXT NOT NULL,
    photo_limit INTEGER,
    status TEXT DEFAULT 'unused', -- unused | active | used | expired
    purchased_at TIMESTAMPTZ DEFAULT NOW(),
    activated_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
);

