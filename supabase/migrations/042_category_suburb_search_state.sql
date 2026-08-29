-- Sparse Finder search state scoped to a category/suburb pair. Priority remains
-- configuration in category_suburb_priorities; this table stores runtime state
-- only. Rows are created on demand by Finder, so there is deliberately no
-- seed or backfill.

CREATE TABLE public.category_suburb_search_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  city_suburb_id UUID NOT NULL REFERENCES public.city_suburbs(id) ON DELETE CASCADE,
  last_searched_at TIMESTAMPTZ,
  exhausted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT category_suburb_search_state_category_suburb_unique
    UNIQUE (category_id, city_suburb_id)
);

-- The unique constraint is the category-first composite lookup index used to
-- fetch all state for categories in a Finder run. This reverse index supports
-- suburb-scoped filtering and efficient city_suburbs foreign-key deletes.
CREATE INDEX category_suburb_search_state_city_suburb_idx
  ON public.category_suburb_search_state (city_suburb_id);

CREATE TRIGGER update_category_suburb_search_state_updated_at
  BEFORE UPDATE ON public.category_suburb_search_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.category_suburb_search_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read" ON public.category_suburb_search_state
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage" ON public.category_suburb_search_state
  FOR ALL TO authenticated
  USING (public.is_active_admin())
  WITH CHECK (public.is_active_admin());
CREATE POLICY "Service role can manage" ON public.category_suburb_search_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.category_suburb_search_state FROM anon;
GRANT SELECT ON public.category_suburb_search_state TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.category_suburb_search_state TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.category_suburb_search_state TO service_role;

