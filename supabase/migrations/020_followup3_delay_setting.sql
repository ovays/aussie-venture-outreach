-- Add follow_up_3_days setting (independent FU3 delay, separate from dead_lead_days)
INSERT INTO settings (key, value, description)
VALUES ('follow_up_3_days', '21', 'Days before sending third follow-up')
ON CONFLICT (key) DO NOTHING;
