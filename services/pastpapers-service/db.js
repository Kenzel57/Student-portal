const { Pool } = require("pg");

// DATABASE_URL points at PgBouncer (pgbouncer:6432), never Postgres directly.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
});

// search_vector is a stored generated column: Postgres keeps it in sync with
// course/semester/year/tags on every write, and the GIN index makes
// full-text search fast. The 'simple' config lowercases words without
// English stemming, so course codes (swe301) and French terms stay intact.
//
// tags_to_text() exists because array_to_string() is marked STABLE and
// generated columns only accept IMMUTABLE functions; joining a text[] into
// text is genuinely immutable, so the wrapper is safe.
const SCHEMA_SQL = `
  CREATE OR REPLACE FUNCTION pastpapers.tags_to_text(text[])
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT array_to_string($1, ' ') $$;

  CREATE TABLE IF NOT EXISTS pastpapers.papers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id    UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    course            TEXT NOT NULL,
    year              SMALLINT NOT NULL CHECK (year BETWEEN 1990 AND 2100),
    semester          TEXT NOT NULL,
    tags              TEXT[] NOT NULL DEFAULT '{}',
    uploader_id       UUID NOT NULL,
    minio_object_key  TEXT NOT NULL UNIQUE,
    original_filename TEXT,
    size_bytes        INTEGER NOT NULL,
    download_count    INTEGER NOT NULL DEFAULT 0,
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    search_vector     TSVECTOR GENERATED ALWAYS AS (
      to_tsvector('simple',
        course || ' ' || semester || ' ' || year::text || ' ' || pastpapers.tags_to_text(tags))
    ) STORED
  );

  CREATE INDEX IF NOT EXISTS papers_search_idx ON pastpapers.papers USING GIN (search_vector);
  CREATE INDEX IF NOT EXISTS papers_institution_idx ON pastpapers.papers (institution_id, uploaded_at DESC);
`;

// Arbitrary constant (distinct per service) so replicas serialise migration.
const MIGRATION_LOCK_ID = 7204;

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
