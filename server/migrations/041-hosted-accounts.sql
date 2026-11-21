-- A hosted guest can become a real account: the Supabase Auth user it is linked to.
-- A linked user keeps a real email, so the idle-guest sweep (GUEST_DOMAIN emails only) never removes it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_id uuid UNIQUE;
