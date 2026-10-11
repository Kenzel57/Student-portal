const { Pool } = require("pg");

// DATABASE_URL points at PgBouncer (pgbouncer:6432), never Postgres directly.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
});

// student_id is the Auth Service's user id (the JWT "sub"); no cross-schema
// foreign key, by design. Grades are immutable once posted (unique per
// student/course/semester) — corrections belong to a future Audit Service.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS transcript.grades (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    student_id     UUID NOT NULL,
    course_code    TEXT NOT NULL,
    course_title   TEXT,
    credits        SMALLINT NOT NULL CHECK (credits BETWEEN 1 AND 30),
    grade          TEXT NOT NULL CHECK (grade IN ('A','B+','B','C+','C','D+','D','F')),
    semester       TEXT NOT NULL,
    posted_by      UUID NOT NULL,
    posted_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE (institution_id, student_id, course_code, semester)
  );

  CREATE INDEX IF NOT EXISTS grades_student_idx
    ON transcript.grades (institution_id, student_id);

  -- Cached GPA per student per semester, recomputed whenever a grade is posted.
  CREATE TABLE IF NOT EXISTS transcript.gpa_snapshots (
    institution_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    student_id     UUID NOT NULL,
    semester       TEXT NOT NULL,
    gpa            NUMERIC(3,2) NOT NULL,
    credits        INTEGER NOT NULL,
    computed_at    TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (institution_id, student_id, semester)
  );
`;

// Arbitrary constant (distinct per service) so replicas serialise migration.
const MIGRATION_LOCK_ID = 7203;

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
