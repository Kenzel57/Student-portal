const { Pool } = require("pg");

// DATABASE_URL points at PgBouncer (pgbouncer:6432), never Postgres directly.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
});

// profiles.user_id is the Auth Service's user id (the JWT "sub"). There is no
// foreign key to auth.users on purpose: each service owns its own schema and
// student_svc cannot even see the auth schema.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS student.profiles (
    user_id          UUID PRIMARY KEY,
    institution_id   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    full_name        TEXT NOT NULL,
    student_number   TEXT,
    contact_email    TEXT,
    phone            TEXT,
    address          TEXT,
    enrolment_status TEXT NOT NULL DEFAULT 'active'
                     CHECK (enrolment_status IN ('active','suspended','graduated','withdrawn')),
    created_at       TIMESTAMPTZ DEFAULT now(),
    updated_at       TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS student.enrolments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES student.profiles(user_id),
    institution_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    programme      TEXT NOT NULL,
    department     TEXT NOT NULL,
    year_of_study  SMALLINT NOT NULL CHECK (year_of_study BETWEEN 1 AND 7),
    academic_year  TEXT,
    status         TEXT NOT NULL DEFAULT 'enrolled'
                   CHECK (status IN ('enrolled','deferred','completed','withdrawn')),
    created_at     TIMESTAMPTZ DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS enrolments_user_id_idx ON student.enrolments (user_id);
`;

// Arbitrary constant (different from Auth's) so this service's replicas
// serialise their own migration.
const MIGRATION_LOCK_ID = 7202;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(SCHEMA_SQL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function migrateWithRetry(attempts = 30, delayMs = 2000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await migrate();
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`Database not ready (attempt ${i}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { pool, migrateWithRetry };
