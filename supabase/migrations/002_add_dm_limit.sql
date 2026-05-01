-- Add daily DM limit setting
INSERT INTO settings (key, value, description)
VALUES ('daily_dm_limit', '10', 'Maximum DMs to queue per day (Instagram + Facebook)')
ON CONFLICT (key) DO NOTHING;
