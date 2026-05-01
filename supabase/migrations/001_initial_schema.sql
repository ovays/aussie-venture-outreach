-- Aussie Venture Outreach System — Initial Schema
-- Run this in your Supabase SQL editor

-- Table: categories
CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  halal_filter BOOLEAN DEFAULT false,
  cities TEXT DEFAULT 'all' CHECK (cities IN ('sydney_only', 'all', 'custom')),
  custom_cities TEXT[],
  content_type TEXT DEFAULT 'remote' CHECK (content_type IN ('visit', 'remote', 'both')),
  pitch_template TEXT,
  dm_template TEXT,
  search_keywords TEXT[],
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Table: leads
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  category_id UUID REFERENCES categories(id),
  category_name TEXT NOT NULL,
  halal BOOLEAN DEFAULT false,
  address TEXT,
  suburb TEXT,
  city TEXT NOT NULL,
  state TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  instagram_handle TEXT,
  facebook_url TEXT,
  google_rating DECIMAL(2,1),
  google_reviews_count INTEGER,
  description TEXT,
  services TEXT,
  outreach_channel TEXT DEFAULT 'email' CHECK (outreach_channel IN ('email', 'instagram', 'facebook')),
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'researched', 'email_ready', 'contacted', 'replied', 'negotiating', 'closed', 'dead')),
  deal_value DECIMAL(10,2),
  deal_type TEXT CHECK (deal_type IN ('visit_content', 'remote_sponsored', 'remote_content')),
  content_created BOOLEAN DEFAULT false,
  payment_received BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Table: emails
CREATE TABLE emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('initial_pitch', 'follow_up_1', 'follow_up_2')),
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT NOT NULL,
  resend_id TEXT,
  status TEXT DEFAULT 'pending_send' CHECK (status IN ('pending_send', 'sent', 'failed', 'bounced')),
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Table: dm_queue
CREATE TABLE dm_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'facebook')),
  handle TEXT NOT NULL,
  profile_url TEXT,
  message_text TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped')),
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ
);

-- Table: follow_ups
CREATE TABLE follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  follow_up_number INTEGER NOT NULL CHECK (follow_up_number IN (1, 2)),
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  email_id UUID REFERENCES emails(id),
  status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Table: deals
CREATE TABLE deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  deal_value DECIMAL(10,2) NOT NULL,
  deal_type TEXT NOT NULL CHECK (deal_type IN ('visit_content', 'remote_sponsored', 'remote_content')),
  content_created BOOLEAN DEFAULT false,
  content_created_at TIMESTAMPTZ,
  payment_received BOOLEAN DEFAULT false,
  payment_received_at TIMESTAMPTZ,
  notes TEXT,
  closed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Table: activity_log
CREATE TABLE activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Table: settings
CREATE TABLE settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Default settings
INSERT INTO settings (key, value, description) VALUES
  ('daily_lead_limit', '50', 'Maximum new leads to find per day'),
  ('daily_email_limit', '50', 'Maximum emails to send per day'),
  ('follow_up_1_days', '7', 'Days before sending first follow-up'),
  ('follow_up_2_days', '14', 'Days before sending second follow-up'),
  ('dead_lead_days', '21', 'Days before marking lead as dead'),
  ('digest_email', 'hello@aussieventure.com', 'Email address for daily digest'),
  ('active_cities', 'Sydney', 'Comma separated list of active cities'),
  ('system_active', 'true', 'Master on/off switch for the entire system');

-- Seed default categories
INSERT INTO categories (name, halal_filter, cities, content_type, search_keywords, status) VALUES
  ('Halal Restaurants', true, 'sydney_only', 'visit', ARRAY['halal restaurant {suburb} Sydney'], 'active'),
  ('Halal Cafes', true, 'sydney_only', 'visit', ARRAY['halal cafe {suburb} Sydney'], 'active'),
  ('Halal Bakeries / Dessert Shops', true, 'sydney_only', 'visit', ARRAY['halal bakery {suburb} Sydney'], 'active'),
  ('Nail Salons', false, 'all', 'remote', ARRAY['nail salon {suburb} {city}'], 'active'),
  ('Hair Salons', false, 'all', 'remote', ARRAY['hair salon {suburb} {city}'], 'active'),
  ('Beauty / Lash Studios', false, 'all', 'remote', ARRAY['beauty studio {suburb} {city}', 'lash studio {suburb} {city}'], 'active'),
  ('Spas / Massage Studios', false, 'all', 'remote', ARRAY['day spa {suburb} {city}'], 'active'),
  ('Travel Agents', false, 'all', 'remote', ARRAY['travel agent {suburb} {city}'], 'active'),
  ('Tour Operators', false, 'all', 'remote', ARRAY['tour operator {suburb} {city}'], 'active'),
  ('Hotels / Resorts', false, 'all', 'remote', ARRAY['hotel {suburb} {city}'], 'active');

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
CREATE TRIGGER update_leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_settings_updated_at BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Policies: authenticated users can do everything (single-user admin system)
CREATE POLICY "Authenticated users have full access" ON leads FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users have full access" ON categories FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users have full access" ON emails FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users have full access" ON dm_queue FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users have full access" ON follow_ups FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users have full access" ON deals FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users have full access" ON activity_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users have full access" ON settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Service role can bypass RLS (for agents running server-side)
CREATE POLICY "Service role bypass" ON leads FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON categories FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON emails FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON dm_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON follow_ups FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON deals FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON activity_log FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON settings FOR ALL TO service_role USING (true) WITH CHECK (true);
