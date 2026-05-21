-- Add use_priority_suburbs flag to categories.
-- When true, the finder agent sorts suburbs by priority DESC before searching
-- so high-priority suburbs (e.g. Lakemba, Bankstown) are searched first for that category.

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS use_priority_suburbs BOOLEAN NOT NULL DEFAULT false;
