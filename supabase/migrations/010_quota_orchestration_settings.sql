-- Per-stage daily outreach quotas.
-- These settings keep new outreach and each follow-up stage from starving each other.

INSERT INTO settings (key, value, description) VALUES
  ('daily_followup1_limit', '20', 'Maximum first follow-up emails to send per day'),
  ('daily_followup2_limit', '10', 'Maximum second follow-up emails to send per day'),
  ('daily_followup3_limit', '5', 'Maximum final follow-up emails to send per day')
ON CONFLICT (key) DO NOTHING;

DELETE FROM settings WHERE key = 'daily_new_outreach_limit';

ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_type_check;
ALTER TABLE emails ADD CONSTRAINT emails_type_check CHECK (
  type IN ('initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3')
);

ALTER TABLE follow_ups DROP CONSTRAINT IF EXISTS follow_ups_follow_up_number_check;
ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_follow_up_number_check CHECK (
  follow_up_number IN (1, 2, 3)
);
