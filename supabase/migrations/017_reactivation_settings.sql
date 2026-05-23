-- Reactivation: DB field, settings, and email type.
-- Adds reactivation_sent_at to leads, settings keys, and 'reactivation' to the emails type constraint.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS reactivation_sent_at TIMESTAMPTZ NULL;

-- Extend emails type constraint to include 'reactivation'
ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_type_check;
ALTER TABLE emails ADD CONSTRAINT emails_type_check CHECK (
  type IN ('initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation')
);

INSERT INTO settings (key, value, description) VALUES
  ('reactivation_enabled', 'true', 'Enable reactivation emails — send a follow-up to dead leads after a delay'),
  ('reactivation_delay_days', '60', 'Days after a lead is marked dead before sending a reactivation email'),
  ('dead_after_reactivation_days', '14', 'Days of no reply after reactivation before marking lead as dead again')
ON CONFLICT (key) DO NOTHING;
