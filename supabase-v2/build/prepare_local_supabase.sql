-- Local Supabase platform preparation only; not a ReachAgent migration.
-- Supabase local grants broad public-schema defaults to its API roles before
-- project migrations run. The verified V2 baseline assumes a clean platform
-- ACL, so remove those platform defaults before applying the one baseline.

REVOKE USAGE ON SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;

-- Match the verified database-wide default-ACL posture without altering any
-- existing Supabase platform object grants. These revoke only privileges that
-- hypothetical future objects would otherwise inherit.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA graphql_public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA supabase_functions REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;

-- The CLI image preinstalls these in a fresh database, while the verified V2
-- catalog intentionally excludes them. PostgreSQL provides gen_random_uuid()
-- natively, so neither extension is required by ReachAgent V2.
DROP EXTENSION IF EXISTS pgcrypto;
DROP EXTENSION IF EXISTS "uuid-ossp";
