-- Increase daily Outscraper spend limit from $1.00 to $2.00 and update description.
-- The $1.00 default was too low; test runs can consume ~$0.39 leaving only $0.61 headroom.
UPDATE settings
SET
  value       = '2.00',
  description = 'Maximum Outscraper spend per day in USD. Pipeline stops when reached. Normal daily cost is ~$0.50. Set to $2.00 for safety margin.'
WHERE key = 'daily_outscraper_limit';
