-- Disposable-test-only Supabase platform stubs.
-- This file is not a V2 migration and must never be applied to a Supabase project.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')
$$;
