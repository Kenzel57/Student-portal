const { Pool } = require("pg");

// DATABASE_URL points at PgBouncer (pgbouncer:6432), never Postgres directly.
// Each replica holds at most 10 connections to PgBouncer; PgBouncer multiplexes
// all replicas of all services onto its own small pool of real Postgres
// connections (DEFAULT_POOL_SIZE in docker-compose.yml).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
});

// Every table is schema-qualified (auth.*) because auth_svc's default
// search_path does not include the auth schema.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS auth.users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    email          TEXT UNIQUE NOT NULL,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('student','lecturer','admin')),
    created_at     TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    user_id        UUID REFERENCES auth.users(id),
    token_hash     TEXT NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL,
    revoked        BOOLEAN DEFAULT false
  );

  CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_idx
    ON auth.refresh_tokens (token_hash);
  CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx
    ON auth.refresh_tokens (user_id);
`;

// Arbitrary constant so concurrent replicas serialise the migration.
const MIGRATION_LOCK_ID = 7201;

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

// PgBouncer/Postgres may still be starting when this container starts, so
// retry instead of crashing on the first failed connection.
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
