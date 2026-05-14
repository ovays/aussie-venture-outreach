-- Expand search keyword diversity across key categories to reduce query exhaustion
-- and improve lead discovery surface area.

-- Halal Restaurants (supersedes 013 — adds ethnic cuisine variations + halal-specific styles)
UPDATE categories
SET search_keywords = ARRAY[
  'halal restaurant {suburb}',
  'halal food {suburb}',
  'halal cafe {suburb}',
  'halal takeaway {suburb}',
  'halal dining {suburb}',
  'halal grill {suburb}',
  'halal burger {suburb}',
  'halal charcoal chicken {suburb}',
  'middle eastern restaurant {suburb}',
  'lebanese restaurant {suburb}',
  'turkish restaurant {suburb}',
  'pakistani restaurant {suburb}',
  'afghan restaurant {suburb}',
  'persian restaurant {suburb}',
  'arabic restaurant {suburb}',
  'indian halal restaurant {suburb}',
  'bangladeshi restaurant {suburb}',
  'indonesian halal restaurant {suburb}',
  'malaysian halal restaurant {suburb}',
  'halal fried chicken {suburb}'
]
WHERE name = 'Halal Restaurants';

-- Travel Agents
UPDATE categories
SET search_keywords = ARRAY[
  'travel agency {suburb}',
  'travel agent {suburb}',
  'holiday packages {suburb}',
  'cruise travel {suburb}',
  'international travel {suburb}',
  'flight booking {suburb}',
  'umrah travel {suburb}',
  'hajj travel {suburb}',
  'tour packages {suburb}'
]
WHERE name = 'Travel Agents';

-- Tour Operators
UPDATE categories
SET search_keywords = ARRAY[
  'tour operator {suburb}',
  'sydney tours {suburb}',
  'private tours {suburb}',
  'day tours {suburb}',
  'sightseeing tours {suburb}',
  'blue mountains tours {suburb}',
  'hunter valley tours {suburb}',
  'adventure tours {suburb}'
]
WHERE name = 'Tour Operators';

-- Halal Cafes (cafe and drink-focused discovery terms)
UPDATE categories
SET search_keywords = ARRAY[
  'halal cafe {suburb}',
  'coffee shop {suburb}',
  'bakery cafe {suburb}',
  'milkshake bar {suburb}',
  'acai bowl {suburb}',
  'bubble tea {suburb}',
  'halal brunch {suburb}'
]
WHERE name = 'Halal Cafes';

-- Halal Bakeries / Dessert Shops (dessert-focused discovery terms)
UPDATE categories
SET search_keywords = ARRAY[
  'halal bakery {suburb}',
  'dessert cafe {suburb}',
  'dessert bar {suburb}',
  'waffles {suburb}',
  'gelato {suburb}',
  'crepes {suburb}',
  'churros {suburb}',
  'halal sweets {suburb}'
]
WHERE name = 'Halal Bakeries / Dessert Shops';
