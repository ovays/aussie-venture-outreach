-- Expand search keyword diversity for Halal Restaurants to reduce Google Maps exhaustion
-- and improve lead discovery across suburbs.
UPDATE categories
SET search_keywords = ARRAY[
  'halal restaurant {suburb}',
  'halal food {suburb}',
  'halal cafe {suburb}',
  'halal takeaway {suburb}',
  'middle eastern restaurant {suburb}',
  'lebanese restaurant {suburb}',
  'turkish restaurant {suburb}',
  'pakistani restaurant {suburb}',
  'indian halal restaurant {suburb}',
  'arabic restaurant {suburb}',
  'afghan restaurant {suburb}',
  'persian restaurant {suburb}',
  'charcoal chicken {suburb}',
  'halal burger {suburb}',
  'halal grill {suburb}'
]
WHERE name = 'Halal Restaurants';
