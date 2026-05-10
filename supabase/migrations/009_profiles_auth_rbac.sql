-- Multi-user auth and RBAC foundation for the internal operations platform.

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profiles_role_idx ON profiles(role);
CREATE INDEX IF NOT EXISTS profiles_is_active_idx ON profiles(is_active);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "Admins can read all profiles" ON profiles;
CREATE POLICY "Admins can read all profiles"
  ON profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'admin'
        AND p.is_active = true
    )
  );

DROP POLICY IF EXISTS "Service role manages profiles" ON profiles;
CREATE POLICY "Service role manages profiles"
  ON profiles FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER AS $$
DECLARE
  admin_email TEXT := current_setting('app.admin_email', true);
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, is_active)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    NEW.raw_user_meta_data ->> 'full_name',
    CASE
      WHEN admin_email IS NOT NULL AND lower(NEW.email) = lower(admin_email) THEN 'admin'
      ELSE 'member'
    END,
    true
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(EXCLUDED.full_name, profiles.full_name);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
