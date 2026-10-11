const CACHE_TTL_S = 5;               // short: most-hit read path, stale ≤ 5s is acceptable
const UPSTREAM_TIMEOUT_MS = 2000;    // never let a slow service hang the dashboard

// Allow `npm test` to run as a fast smoke test without starting a server.
if (process.argv.includes("--test")) {
  require("express");
  require("ioredis");
  console.log("Dashboard service smoke test passed.");
  process.exit(0);
}

const express = require("express");
const Redis = require("ioredis");
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");
const { setupMetrics } = require("./metrics");

const PORT = 3000;
const AUTH_URL = process.env.AUTH_URL || "http://auth-service:3000";
const STUDENT_URL = process.env.STUDENT_URL || "http://student-service:3000";

const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379", {
  maxRetriesPerRequest: 3,
});

const app = express();
setupMetrics(app, "dashboard-service");

// ── Upstream calls ─────────────────────────────────────────────

// Node's built-in fetch keeps connections alive between calls, so each
// dashboard request doesn't pay for a new TCP handshake per upstream.
function callService(url, authorization) {
  return fetch(url, {
    headers: { authorization },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

// Returns the verified user, null if the token is invalid, or throws if Auth
// itself is unreachable.
async function verifyToken(authorization) {
  const res = await callService(`${AUTH_URL}/auth/verify`, authorization);
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`auth-service responded ${res.status}`);
  return (await res.json()).user;
}

// Fetches one Student Service resource. 404 is a normal "no data yet" answer;
// anything else unexpected is reported so the payload can be marked degraded.
async function fetchStudent(path, authorization) {
  try {
    const res = await callService(`${STUDENT_URL}${path}`, authorization);
    if (res.status === 404) return { data: null };
    if (!res.ok) return { failed: true };
    return { data: await res.json() };
  } catch {
    return { failed: true };
  }
}

async function buildPayload(user, authorization) {
  const degraded = new Set();
  const base = {
    role: user.role,
    user,
    generatedAt: new Date().toISOString(),
  };

  if (user.role === "student") {
    const [profile, enrolment] = await Promise.all([
      fetchStudent(`/student/profile/${user.id}`, authorization),
      fetchStudent(`/student/enrolment/${user.id}`, authorization),
    ]);
    if (profile.failed || enrolment.failed) degraded.add("student-service");
    return {
      ...base,
      dashboard: "student",
      profile: profile.data || null,
      enrolments: enrolment.data ? enrolment.data.enrolments : [],
      degraded: [...degraded],
    };
  }

  // Lecturer/admin: minimal staff view for now (Admin/Institution Service is
  // a post-deadline item). The name comes from their profile if they have one.
  const profile = await fetchStudent(`/student/profile/${user.id}`, authorization);
  if (profile.failed) degraded.add("student-service");
  return {
    ...base,
    dashboard: "staff",
    name: profile.data ? profile.data.fullName : null,
    degraded: [...degraded],
  };
}

// ── Swagger / OpenAPI ──────────────────────────────────────────

const openapiSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Student Portal — Dashboard/BFF Service",
      version: "1.0.0",
      description:
        "Backend-for-Frontend: validates the token with the Auth Service, gathers data from the Student Service and returns one payload shaped by the user's role. Owns no database; caches composed payloads in Redis.",
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    },
  },
  apis: [__filename],
});
app.get("/dashboard/docs.json", (req, res) => res.json(openapiSpec));
app.use("/dashboard/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

// ── Endpoints ──────────────────────────────────────────────────

/**
 * @openapi
 * /dashboard/health:
 *   get:
 *     summary: Liveness check covering Redis and reachability of Auth and Student
 *     responses:
 *       200: { description: All dependencies reachable }
 *       503: { description: A dependency is down }
 */
app.get("/dashboard/health", async (req, res) => {
  const probe = (url) =>
    fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }).then((r) => (r.ok ? "ok" : "down"), () => "down");
  const [redisOk, auth, student] = await Promise.all([
    redis.ping().then(() => "ok", () => "down"),
    probe(`${AUTH_URL}/auth/health`),
    probe(`${STUDENT_URL}/student/health`),
  ]);
  const checks = { redis: redisOk, "auth-service": auth, "student-service": student };
  const healthy = Object.values(checks).every((v) => v === "ok");
  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", service: "dashboard-service", checks });
});

/**
 * @openapi
 * /dashboard/home:
 *   get:
 *     summary: Everything the home screen needs, in one call, shaped by role
 *     description: >
 *       Validates the token via the Auth Service, then (for a student) fetches
 *       profile and enrolments from the Student Service in parallel. Lecturers
 *       and admins get a minimal staff payload. Results are cached in Redis for
 *       5 seconds per user; the X-Cache header shows HIT or MISS. If the Student
 *       Service is unavailable the response still succeeds, lists it under
 *       `degraded`, and is not cached.
 *     security: [ { bearerAuth: [] } ]
 *     responses:
 *       200:
 *         description: Dashboard payload
 *         headers:
 *           X-Cache: { schema: { type: string, enum: [HIT, MISS] } }
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 role: { type: string, enum: [student, lecturer, admin] }
 *                 dashboard: { type: string, enum: [student, staff] }
 *                 user: { type: object }
 *                 profile: { type: object, nullable: true, description: student only }
 *                 enrolments: { type: array, items: { type: object }, description: student only }
 *                 name: { type: string, nullable: true, description: staff only }
 *                 degraded: { type: array, items: { type: string } }
 *                 generatedAt: { type: string, format: date-time }
 *       401: { description: Missing, expired or invalid token }
 *       503: { description: Auth Service unreachable }
 */
app.get("/dashboard/home", async (req, res) => {
  const authorization = req.get("authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing access token" });
  }

  let user;
  try {
    user = await verifyToken(authorization);
  } catch (err) {
    console.error("token verification failed:", err.message);
    return res.status(503).json({ error: "authentication service unavailable" });
  }
  if (!user) return res.status(401).json({ error: "invalid or expired access token" });

  // Token is validated first, so a cached payload is only ever served to a
  // caller holding a currently valid token for that user.
  const cacheKey = `dash:${user.id}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    res.set("X-Cache", "HIT").type("application/json").send(cached);
    return;
  }

  const payload = await buildPayload(user, authorization);
  if (payload.degraded.length === 0) {
    await redis.set(cacheKey, JSON.stringify(payload), "EX", CACHE_TTL_S).catch(() => {});
  }
  res.set("X-Cache", "MISS").json(payload);
});

// ── Startup ────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`dashboard-service listening on :${PORT}`);
});
process.on("SIGTERM", () => {
  server.close(async () => {
    await redis.quit().catch(() => {});
    process.exit(0);
  });
});
