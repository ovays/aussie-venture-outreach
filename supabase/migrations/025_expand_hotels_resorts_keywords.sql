-- Expand Hotels / Resorts search keywords to cover the full range of accommodation
-- types relevant to regional and city destinations (hotels, resorts, B&Bs, glamping,
-- farm stays, holiday parks, retreats, etc.).
UPDATE categories
SET search_keywords = ARRAY[
  'hotel {suburb}',
  'accommodation {suburb}',
  'resort {suburb}',
  'holiday accommodation {suburb}',
  'boutique hotel {suburb}',
  'luxury accommodation {suburb}',
  'cabin {suburb}',
  'glamping {suburb}',
  'farm stay {suburb}',
  'retreat {suburb}',
  'holiday park {suburb}',
  'lodge {suburb}',
  'villa accommodation {suburb}',
  'motel {suburb}'
]
WHERE name = 'Hotels / Resorts';
