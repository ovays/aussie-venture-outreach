-- Authenticated users may read AI configuration for the read-only settings UI,
-- but only active admins may write it directly. API writes remain protected by
-- the same role check and use the service-role client.

CREATE OR REPLACE FUNCTION public.is_active_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND is_active = true
  );
$$;

REVOKE ALL ON FUNCTION public.is_active_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_active_admin() TO authenticated, service_role;

DROP POLICY IF EXISTS "Authenticated users have full access" ON ai_providers;
DROP POLICY IF EXISTS "Authenticated users have full access" ON ai_models;
DROP POLICY IF EXISTS "Authenticated users have full access" ON ai_workflow_configurations;

CREATE POLICY "Authenticated users can read" ON ai_providers
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read" ON ai_models
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can read" ON ai_workflow_configurations
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage" ON ai_providers
  FOR ALL TO authenticated
  USING (public.is_active_admin())
  WITH CHECK (public.is_active_admin());
CREATE POLICY "Admins can manage" ON ai_models
  FOR ALL TO authenticated
  USING (public.is_active_admin())
  WITH CHECK (public.is_active_admin());
CREATE POLICY "Admins can manage" ON ai_workflow_configurations
  FOR ALL TO authenticated
  USING (public.is_active_admin())
  WITH CHECK (public.is_active_admin());
