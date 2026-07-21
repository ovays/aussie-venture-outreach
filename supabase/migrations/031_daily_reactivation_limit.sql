-- Daily reactivation send limit — independent of daily_initial_outreach_limit.
-- Caps how many reactivation emails agents/reactivation.ts sends per day; excess
-- eligible leads are left untouched (still status='contacted', reactivation_sent_at
-- NULL) and picked up again on the next scheduled run.
INSERT INTO settings (key, value, description) VALUES
  ('daily_reactivation_limit', '10', 'Maximum reactivation emails to send per day')
ON CONFLICT (key) DO NOTHING;
