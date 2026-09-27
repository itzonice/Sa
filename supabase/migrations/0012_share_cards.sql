CREATE TABLE share_cards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL, -- 'session' or 'streak'
    payload JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE share_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own share cards" ON share_cards
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create share cards" ON share_cards
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Share cards are public for anonymous users" ON share_cards
  FOR SELECT USING (TRUE);