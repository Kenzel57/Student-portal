-- Runs automatically on first Postgres container start.
-- Implements Option A from the project plan: one Postgres instance,
-- one schema per service, each service connects only to its own schema.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS student;
CREATE SCHEMA IF NOT EXISTS transcript;
CREATE SCHEMA IF NOT EXISTS pastpapers;

-- Service-scoped roles (create real passwords per environment — these are
-- local-dev placeholders, never reuse them outside your machine).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'auth_svc') THEN
    CREATE ROLE auth_svc LOGIN PASSWORD 'auth_dev_pw';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'student_svc') THEN
    CREATE ROLE student_svc LOGIN PASSWORD 'student_dev_pw';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'transcript_svc') THEN
    CREATE ROLE transcript_svc LOGIN PASSWORD 'transcript_dev_pw';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pastpapers_svc') THEN
    CREATE ROLE pastpapers_svc LOGIN PASSWORD 'pastpapers_dev_pw';
  END IF;
END
$$;

GRANT ALL ON SCHEMA auth TO auth_svc;
GRANT ALL ON SCHEMA student TO student_svc;
GRANT ALL ON SCHEMA transcript TO transcript_svc;
GRANT ALL ON SCHEMA pastpapers TO pastpapers_svc;

-- institution_id is added to every core table from day one (per the SaaS
-- note in the plan) so a second institution never requires a migration.
-- Example on the first real table you create:
--   institution_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
