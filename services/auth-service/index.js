const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const BCRYPT_COST = 10;
const ACCESS_TOKEN_TTL_S = 15 * 60;            // 15 minutes
const REFRESH_TOKEN_TTL_S = 7 * 24 * 60 * 60;  // 7 days
const RESET_TOKEN_TTL_S = 15 * 60;             // 15 minutes
const ROLES = ["student", "lecturer", "admin"];

// Allow `npm test` to run as a fast smoke test without starting a server:
// proves the native bcrypt module loads and hashing/signing round-trip.
if (process.argv.includes("--test")) {
  const hash = bcrypt.hashSync("smoke-test-pw", 4);
  if (!bcrypt.compareSync("smoke-test-pw", hash)) throw new Error("bcrypt round-trip failed");
  const token = jwt.sign({ sub: "u1", role: "student" }, "test-secret", { expiresIn: 60 });
  if (jwt.verify(token, "test-secret").role !== "student") throw new Error("JWT round-trip failed");
  console.log("Auth service smoke test passed.");
  process.exit(0);
}

const express = require("express");
const Redis = require("ioredis");
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");
const { pool, migrateWithRetry } = require("./db");
const { setupMetrics } = require("./metrics");

const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("JWT_SECRET is not set — refusing to start.");
  process.exit(1);
}

const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379", {
  maxRetriesPerRequest: 3,
});

const app = express();
setupMetrics(app, "auth-service");
app.use(express.json({ limit: "10kb" }));

// ── Helpers ────────────────────────────────────────────────────

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Compared against when the email doesn't exist, so a failed login takes the
// same time whether or not the account exists (prevents user enumeration).
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", BCRYPT_COST);

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// bcrypt only uses the first 72 bytes of a password; reject longer ones
// instead of silently truncating them.
function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    return "password must be at least 8 characters";
  }
  if (Buffer.byteLength(password, "utf8") > 72) {
    return "password must be at most 72 bytes";
  }
  return null;
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    institutionId: row.institution_id,
  };
}

function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      email: user.email,
      institution_id: user.institution_id,
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_S, issuer: "student-portal-auth" }
  );
}

// Returns the decoded claims of a valid Bearer token, or null.
function readBearer(req) {
  const header = req.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  try {
    return jwt.verify(header.slice(7), JWT_SECRET, { issuer: "student-portal-auth" });
  } catch {
    return null;
  }
}

// Issues an access token plus a fresh single-use refresh token.
// Redis holds the live session (fast, expires on its own); Postgres keeps a
// durable record of every refresh token for auditing and revocation.
async function issueTokens(user) {
  const refreshToken = randomToken();
  const tokenHash = sha256(refreshToken);
  const session = JSON.stringify({
    id: user.id,
    email: user.email,
    role: user.role,
    institution_id: user.institution_id,
  });

  await pool.query(
    `INSERT INTO auth.refresh_tokens (institution_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [user.institution_id, user.id, tokenHash, REFRESH_TOKEN_TTL_S]
  );
  await redis
    .multi()
    .set(`rt:${tokenHash}`, session, "EX", REFRESH_TOKEN_TTL_S)
    .sadd(`user_rts:${user.id}`, tokenHash)
    .expire(`user_rts:${user.id}`, REFRESH_TOKEN_TTL_S)
    .exec();

  return {
    accessToken: signAccessToken(user),
    refreshToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_TTL_S,
    user: publicUser(user),
  };
}

// Ends every session a user has (used after a password reset).
async function revokeAllSessions(userId) {
  const hashes = await redis.smembers(`user_rts:${userId}`);
  const multi = redis.multi().del(`user_rts:${userId}`);
  hashes.forEach((h) => multi.del(`rt:${h}`));
  await multi.exec();
  await pool.query(
    "UPDATE auth.refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false",
    [userId]
  );
}

// Wraps async handlers so a thrown error reaches the error middleware.
const route = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ── Swagger / OpenAPI ──────────────────────────────────────────

/**
 * @openapi
 * components:
 *   securitySchemes:
 *     bearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         email: { type: string, format: email }
 *         role: { type: string, enum: [student, lecturer, admin] }
 *         institutionId: { type: string, format: uuid }
 *     AuthResponse:
 *       type: object
 *       properties:
 *         accessToken: { type: string, description: "JWT; claims include sub, role, email, institution_id" }
 *         refreshToken: { type: string, description: "Opaque, single-use; rotated on every refresh" }
 *         tokenType: { type: string, example: Bearer }
 *         expiresIn: { type: integer, example: 900, description: "Access token lifetime in seconds" }
 *         user: { $ref: '#/components/schemas/User' }
 *     Error:
 *       type: object
 *       properties:
 *         error: { type: string }
 */
const openapiSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Student Portal — Auth Service",
      version: "1.0.0",
      description: "Registration, login, JWT issuing/refresh, logout and password reset.",
    },
  },
  apis: [__filename],
});
app.get("/auth/docs.json", (req, res) => res.json(openapiSpec));
app.use("/auth/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

// ── Endpoints ──────────────────────────────────────────────────

/**
 * @openapi
 * /auth/health:
 *   get:
 *     summary: Liveness check covering Postgres (via PgBouncer) and Redis
 *     responses:
 *       200: { description: Both dependencies reachable }
 *       503: { description: A dependency is down }
 */
app.get("/auth/health", async (req, res) => {
  const checks = { database: "ok", redis: "ok" };
  await pool.query("SELECT 1").catch(() => (checks.database = "down"));
  await redis.ping().catch(() => (checks.redis = "down"));
  const healthy = checks.database === "ok" && checks.redis === "ok";
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: "auth-service",
    checks,
  });
});

/**
 * @openapi
 * /auth/verify:
 *   get:
 *     summary: Validate an access token and return who it belongs to
 *     description: >
 *       Used by other services (e.g. Dashboard/BFF) to check a token. Pure
 *       signature/expiry check — no database access, so it stays fast under load.
 *     security: [ { bearerAuth: [] } ]
 *     responses:
 *       200:
 *         description: Token is valid
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { valid: { type: boolean }, user: { $ref: '#/components/schemas/User' } } }
 *       401: { description: Missing, expired or invalid token }
 */
app.get("/auth/verify", (req, res) => {
  const claims = readBearer(req);
  if (!claims) return res.status(401).json({ valid: false, error: "invalid or expired access token" });
  res.json({
    valid: true,
    user: {
      id: claims.sub,
      email: claims.email,
      role: claims.role,
      institutionId: claims.institution_id,
    },
  });
});

/**
 * @openapi
 * /auth/register:
 *   post:
 *     summary: Create a user account
 *     description: >
 *       Anyone may self-register as a **student**. Creating a lecturer or admin
 *       requires an admin's access token in the Authorization header.
 *     security: [ {}, { bearerAuth: [] } ]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8, description: "8 characters to 72 bytes" }
 *               role: { type: string, enum: [student, lecturer, admin], default: student }
 *     responses:
 *       201:
 *         description: User created
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { user: { $ref: '#/components/schemas/User' } } }
 *       400: { description: Invalid input, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       403: { description: Non-admin tried to create a lecturer/admin }
 *       409: { description: Email already registered }
 */
app.post("/auth/register", route(async (req, res) => {
  const { email, password, role = "student" } = req.body || {};
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return badRequest(res, "a valid email is required");
  }
  const passwordError = validatePassword(password);
  if (passwordError) return badRequest(res, passwordError);
  if (!ROLES.includes(role)) {
    return badRequest(res, `role must be one of: ${ROLES.join(", ")}`);
  }
  if (role !== "student" && readBearer(req)?.role !== "admin") {
    return res.status(403).json({ error: "only an admin can create lecturer or admin accounts" });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  try {
    const { rows } = await pool.query(
      `INSERT INTO auth.users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, email, role, institution_id`,
      [email.trim().toLowerCase(), passwordHash, role]
    );
    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "email already registered" });
    }
    throw err;
  }
}));

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Log in and receive an access token + refresh token
 *     description: >
 *       The user's role is returned both in the response body (`user.role`) and
 *       in the access token's claims, so the frontend can route students to the
 *       student dashboard and lecturers/admins to the staff dashboard.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Logged in
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AuthResponse' } } }
 *       400: { description: Missing email or password }
 *       401: { description: Invalid email or password }
 */
app.post("/auth/login", route(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return badRequest(res, "email and password are required");
  }

  const { rows } = await pool.query(
    `SELECT id, email, password_hash, role, institution_id
     FROM auth.users WHERE email = $1`,
    [email.trim().toLowerCase()]
  );
  const user = rows[0];
  const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    return res.status(401).json({ error: "invalid email or password" });
  }

  res.json(await issueTokens(user));
}));

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     summary: Exchange a refresh token for a new access token
 *     description: >
 *       Refresh tokens are single-use. The presented token is consumed and a new
 *       one is returned (rotation), so a replayed stolen token is rejected.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: New token pair
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AuthResponse' } } }
 *       401: { description: Token invalid, expired, revoked or already used }
 */
app.post("/auth/refresh", route(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (typeof refreshToken !== "string") return badRequest(res, "refreshToken is required");

  const tokenHash = sha256(refreshToken);
  // GETDEL atomically claims the token: two concurrent refreshes with the
  // same token cannot both succeed.
  const session = await redis.getdel(`rt:${tokenHash}`);
  if (!session) {
    return res.status(401).json({ error: "invalid or expired refresh token" });
  }
  const user = JSON.parse(session);
  await redis.srem(`user_rts:${user.id}`, tokenHash);
  await pool.query(
    "UPDATE auth.refresh_tokens SET revoked = true WHERE token_hash = $1",
    [tokenHash]
  );

  res.json(await issueTokens(user));
}));

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Revoke a refresh token (end the session)
 *     description: Idempotent — always returns 204, even for an unknown token.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       204: { description: Logged out }
 *       400: { description: refreshToken missing }
 */
app.post("/auth/logout", route(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (typeof refreshToken !== "string") return badRequest(res, "refreshToken is required");

  const tokenHash = sha256(refreshToken);
  const session = await redis.getdel(`rt:${tokenHash}`);
  if (session) await redis.srem(`user_rts:${JSON.parse(session).id}`, tokenHash);
  await pool.query(
    "UPDATE auth.refresh_tokens SET revoked = true WHERE token_hash = $1",
    [tokenHash]
  );
  res.status(204).end();
}));

/**
 * @openapi
 * /auth/password-reset/request:
 *   post:
 *     summary: Request a password reset token
 *     description: >
 *       Always returns 202 with the same message, whether or not the email
 *       exists, so the endpoint cannot be used to discover accounts. Until the
 *       Notification Service exists, the token is written to the service log.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       202: { description: Request accepted }
 */
app.post("/auth/password-reset/request", route(async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== "string") return badRequest(res, "email is required");

  const { rows } = await pool.query(
    "SELECT id FROM auth.users WHERE email = $1",
    [email.trim().toLowerCase()]
  );
  if (rows[0]) {
    const resetToken = randomToken();
    await redis.set(`pwreset:${sha256(resetToken)}`, rows[0].id, "EX", RESET_TOKEN_TTL_S);
    // DEV ONLY: stands in for the email the Notification Service will send.
    console.log(`[password-reset] token for ${email.trim().toLowerCase()}: ${resetToken}`);
  }
  res.status(202).json({ message: "if that email is registered, a reset link has been sent" });
}));

/**
 * @openapi
 * /auth/password-reset/confirm:
 *   post:
 *     summary: Set a new password using a reset token
 *     description: The token is single-use. All of the user's sessions are revoked.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, newPassword]
 *             properties:
 *               token: { type: string }
 *               newPassword: { type: string, minLength: 8 }
 *     responses:
 *       200: { description: Password changed }
 *       400: { description: Invalid/expired token or weak password }
 */
app.post("/auth/password-reset/confirm", route(async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (typeof token !== "string") return badRequest(res, "token is required");
  const passwordError = validatePassword(newPassword);
  if (passwordError) return badRequest(res, passwordError);

  const userId = await redis.getdel(`pwreset:${sha256(token)}`);
  if (!userId) return badRequest(res, "invalid or expired reset token");

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await pool.query("UPDATE auth.users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
  await revokeAllSessions(userId);
  res.json({ message: "password updated; please log in again" });
}));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return badRequest(res, "request body must be valid JSON");
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

// ── Startup ────────────────────────────────────────────────────

// Creates the first admin from env vars so lecturer/admin accounts can be
// created without allowing anyone to self-register as admin.
async function bootstrapAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return;
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const { rowCount } = await pool.query(
    `INSERT INTO auth.users (email, password_hash, role)
     VALUES ($1, $2, 'admin') ON CONFLICT (email) DO NOTHING`,
    [email.trim().toLowerCase(), passwordHash]
  );
  if (rowCount) console.log(`Bootstrap admin created: ${email}`);
}

async function start() {
  await migrateWithRetry();
  await bootstrapAdmin();
  const server = app.listen(PORT, () => {
    console.log(`auth-service listening on :${PORT}`);
  });

  // Finish in-flight requests before exiting when Docker stops/scales us.
  process.on("SIGTERM", () => {
    server.close(async () => {
      await Promise.allSettled([pool.end(), redis.quit()]);
      process.exit(0);
    });
  });
}

start().catch((err) => {
  console.error("auth-service failed to start:", err);
  process.exit(1);
});
