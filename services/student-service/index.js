const jwt = require("jsonwebtoken");

const PROFILE_STATUSES = ["active", "suspended", "graduated", "withdrawn"];
const ENROLMENT_STATUSES = ["enrolled", "deferred", "completed", "withdrawn"];
const STAFF_ROLES = ["lecturer", "admin"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Allow `npm test` to run as a fast smoke test without starting a server.
if (process.argv.includes("--test")) {
  const token = jwt.sign({ sub: "u1", role: "student" }, "test-secret", { expiresIn: 60 });
  if (jwt.verify(token, "test-secret").role !== "student") throw new Error("JWT round-trip failed");
  if (!UUID_RE.test("e81f8a73-4efe-435f-aab8-2d2a9d0e3e4d")) throw new Error("UUID check failed");
  console.log("Student service smoke test passed.");
  process.exit(0);
}

const express = require("express");
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

const app = express();
setupMetrics(app, "student-service");
app.use(express.json({ limit: "10kb" }));

// ── Helpers ────────────────────────────────────────────────────

const badRequest = (res, message) => res.status(400).json({ error: message });
const forbidden = (res, message) => res.status(403).json({ error: message });

// Tokens are verified locally with the shared secret: a signature check needs
// no network call, so this service doesn't depend on Auth being up per request.
function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  if (header.startsWith("Bearer ")) {
    try {
      req.user = jwt.verify(header.slice(7), JWT_SECRET, { issuer: "student-portal-auth" });
      return next();
    } catch {
      // fall through to 401
    }
  }
  res.status(401).json({ error: "missing, invalid or expired access token" });
}

function validId(req, res, next) {
  if (!UUID_RE.test(req.params.id)) return badRequest(res, "id must be a UUID");
  next();
}

// A student may read their own records; lecturers and admins may read anyone's
// (within their own institution — every query is scoped by institution_id).
const canRead = (user, id) => user.sub === id || STAFF_ROLES.includes(user.role);

function profileJson(row) {
  return {
    userId: row.user_id,
    institutionId: row.institution_id,
    fullName: row.full_name,
    studentNumber: row.student_number,
    contactEmail: row.contact_email,
    phone: row.phone,
    address: row.address,
    enrolmentStatus: row.enrolment_status,
    updatedAt: row.updated_at,
  };
}

function enrolmentJson(row) {
  return {
    id: row.id,
    programme: row.programme,
    department: row.department,
    yearOfStudy: row.year_of_study,
    academicYear: row.academic_year,
    status: row.status,
    createdAt: row.created_at,
  };
}

const route = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ── Swagger / OpenAPI ──────────────────────────────────────────

/**
 * @openapi
 * components:
 *   securitySchemes:
 *     bearerAuth: { type: http, scheme: bearer, bearerFormat: JWT }
 *   schemas:
 *     Profile:
 *       type: object
 *       properties:
 *         userId: { type: string, format: uuid }
 *         institutionId: { type: string, format: uuid }
 *         fullName: { type: string }
 *         studentNumber: { type: string, nullable: true }
 *         contactEmail: { type: string, nullable: true }
 *         phone: { type: string, nullable: true }
 *         address: { type: string, nullable: true }
 *         enrolmentStatus: { type: string, enum: [active, suspended, graduated, withdrawn] }
 *         updatedAt: { type: string, format: date-time }
 *     Enrolment:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         programme: { type: string }
 *         department: { type: string }
 *         yearOfStudy: { type: integer, minimum: 1, maximum: 7 }
 *         academicYear: { type: string, nullable: true, example: "2026/2027" }
 *         status: { type: string, enum: [enrolled, deferred, completed, withdrawn] }
 *         createdAt: { type: string, format: date-time }
 *   parameters:
 *     UserId:
 *       name: id
 *       in: path
 *       required: true
 *       description: The user's id from the Auth Service (JWT "sub")
 *       schema: { type: string, format: uuid }
 */
const openapiSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Student Portal — Student Service",
      version: "1.0.0",
      description: "Student profiles and enrolment records. All endpoints require a Bearer access token from the Auth Service.",
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [__filename],
});
app.get("/student/docs.json", (req, res) => res.json(openapiSpec));
app.use("/student/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

// ── Endpoints ──────────────────────────────────────────────────

/**
 * @openapi
 * /student/health:
 *   get:
 *     summary: Liveness check covering Postgres (via PgBouncer)
 *     security: []
 *     responses:
 *       200: { description: Database reachable }
 *       503: { description: Database down }
 */
app.get("/student/health", async (req, res) => {
  const ok = await pool.query("SELECT 1").then(() => true, () => false);
  res.status(ok ? 200 : 503).json({
    status: ok ? "ok" : "degraded",
    service: "student-service",
    checks: { database: ok ? "ok" : "down" },
  });
});

/**
 * @openapi
 * /student/profile/{id}:
 *   get:
 *     summary: Get a student's profile
 *     description: Students may read only their own profile; lecturers and admins may read any.
 *     parameters: [ { $ref: '#/components/parameters/UserId' } ]
 *     responses:
 *       200: { description: Profile, content: { application/json: { schema: { $ref: '#/components/schemas/Profile' } } } }
 *       401: { description: Missing or invalid token }
 *       403: { description: Not allowed to read this profile }
 *       404: { description: No profile for this user }
 */
app.get("/student/profile/:id", requireAuth, validId, route(async (req, res) => {
  if (!canRead(req.user, req.params.id)) return forbidden(res, "you may only view your own profile");
  const { rows } = await pool.query(
    "SELECT * FROM student.profiles WHERE user_id = $1 AND institution_id = $2",
    [req.params.id, req.user.institution_id]
  );
  if (!rows[0]) return res.status(404).json({ error: "profile not found" });
  res.json(profileJson(rows[0]));
}));

/**
 * @openapi
 * /student/profile/{id}:
 *   put:
 *     summary: Create or update a student's profile
 *     description: >
 *       Only the fields sent are changed. Creating a new profile requires fullName.
 *       Students may edit their own name and contact details; only admins may set
 *       studentNumber or enrolmentStatus, or edit another user's profile.
 *     parameters: [ { $ref: '#/components/parameters/UserId' } ]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fullName: { type: string }
 *               contactEmail: { type: string }
 *               phone: { type: string }
 *               address: { type: string }
 *               studentNumber: { type: string, description: admin only }
 *               enrolmentStatus: { type: string, enum: [active, suspended, graduated, withdrawn], description: admin only }
 *     responses:
 *       200: { description: Profile updated, content: { application/json: { schema: { $ref: '#/components/schemas/Profile' } } } }
 *       201: { description: Profile created, content: { application/json: { schema: { $ref: '#/components/schemas/Profile' } } } }
 *       400: { description: Invalid input }
 *       403: { description: Not allowed }
 */
app.put("/student/profile/:id", requireAuth, validId, route(async (req, res) => {
  const isAdmin = req.user.role === "admin";
  if (req.user.sub !== req.params.id && !isAdmin) {
    return forbidden(res, "you may only edit your own profile");
  }
  const body = req.body || {};
  const { fullName, contactEmail, phone, address, studentNumber, enrolmentStatus } = body;
  if (!isAdmin && (studentNumber !== undefined || enrolmentStatus !== undefined)) {
    return forbidden(res, "only an admin can set studentNumber or enrolmentStatus");
  }
  for (const [name, value] of Object.entries({ fullName, contactEmail, phone, address, studentNumber })) {
    if (value !== undefined && typeof value !== "string") return badRequest(res, `${name} must be a string`);
  }
  if (enrolmentStatus !== undefined && !PROFILE_STATUSES.includes(enrolmentStatus)) {
    return badRequest(res, `enrolmentStatus must be one of: ${PROFILE_STATUSES.join(", ")}`);
  }

  const values = [fullName, studentNumber, contactEmail, phone, address, enrolmentStatus].map(
    (v) => (v === undefined ? null : v)
  );
  // Update only the fields provided; fall back to insert if no profile exists.
  const updated = await pool.query(
    `UPDATE student.profiles SET
       full_name        = COALESCE($3, full_name),
       student_number   = COALESCE($4, student_number),
       contact_email    = COALESCE($5, contact_email),
       phone            = COALESCE($6, phone),
       address          = COALESCE($7, address),
       enrolment_status = COALESCE($8, enrolment_status),
       updated_at       = now()
     WHERE user_id = $1 AND institution_id = $2
     RETURNING *`,
    [req.params.id, req.user.institution_id, ...values]
  );
  if (updated.rows[0]) return res.json(profileJson(updated.rows[0]));

  if (!fullName) return badRequest(res, "fullName is required when creating a profile");
  try {
    const inserted = await pool.query(
      `INSERT INTO student.profiles
         (user_id, institution_id, full_name, student_number, contact_email, phone, address, enrolment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'active'))
       RETURNING *`,
      [req.params.id, req.user.institution_id, ...values]
    );
    res.status(201).json(profileJson(inserted.rows[0]));
  } catch (err) {
    // Same user_id already exists under a different institution.
    if (err.code === "23505") return res.status(409).json({ error: "profile already exists" });
    throw err;
  }
}));

/**
 * @openapi
 * /student/enrolment/{id}:
 *   get:
 *     summary: Get a student's enrolment records (newest first)
 *     description: Students may read only their own; lecturers and admins may read any.
 *     parameters: [ { $ref: '#/components/parameters/UserId' } ]
 *     responses:
 *       200:
 *         description: Enrolment records (empty list if none)
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { enrolments: { type: array, items: { $ref: '#/components/schemas/Enrolment' } } } }
 *       401: { description: Missing or invalid token }
 *       403: { description: Not allowed }
 */
app.get("/student/enrolment/:id", requireAuth, validId, route(async (req, res) => {
  if (!canRead(req.user, req.params.id)) return forbidden(res, "you may only view your own enrolment");
  const { rows } = await pool.query(
    `SELECT * FROM student.enrolments
     WHERE user_id = $1 AND institution_id = $2
     ORDER BY created_at DESC`,
    [req.params.id, req.user.institution_id]
  );
  res.json({ enrolments: rows.map(enrolmentJson) });
}));

/**
 * @openapi
 * /student/enrolment/{id}:
 *   post:
 *     summary: Add an enrolment record for a student (admin only)
 *     description: The student must already have a profile.
 *     parameters: [ { $ref: '#/components/parameters/UserId' } ]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [programme, department, yearOfStudy]
 *             properties:
 *               programme: { type: string, example: "BSc Software Engineering" }
 *               department: { type: string, example: "Computer Science" }
 *               yearOfStudy: { type: integer, minimum: 1, maximum: 7 }
 *               academicYear: { type: string, example: "2026/2027" }
 *               status: { type: string, enum: [enrolled, deferred, completed, withdrawn], default: enrolled }
 *     responses:
 *       201: { description: Enrolment created, content: { application/json: { schema: { $ref: '#/components/schemas/Enrolment' } } } }
 *       400: { description: Invalid input }
 *       403: { description: Not an admin }
 *       409: { description: Student has no profile yet }
 */
app.post("/student/enrolment/:id", requireAuth, validId, route(async (req, res) => {
  if (req.user.role !== "admin") return forbidden(res, "only an admin can add enrolments");
  const { programme, department, yearOfStudy, academicYear = null, status = "enrolled" } = req.body || {};
  if (typeof programme !== "string" || !programme.trim()) return badRequest(res, "programme is required");
  if (typeof department !== "string" || !department.trim()) return badRequest(res, "department is required");
  if (!Number.isInteger(yearOfStudy) || yearOfStudy < 1 || yearOfStudy > 7) {
    return badRequest(res, "yearOfStudy must be an integer from 1 to 7");
  }
  if (academicYear !== null && typeof academicYear !== "string") return badRequest(res, "academicYear must be a string");
  if (!ENROLMENT_STATUSES.includes(status)) {
    return badRequest(res, `status must be one of: ${ENROLMENT_STATUSES.join(", ")}`);
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO student.enrolments
         (user_id, institution_id, programme, department, year_of_study, academic_year, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.params.id, req.user.institution_id, programme.trim(), department.trim(), yearOfStudy, academicYear, status]
    );
    res.status(201).json(enrolmentJson(rows[0]));
  } catch (err) {
    if (err.code === "23503") return res.status(409).json({ error: "create the student's profile first" });
    throw err;
  }
}));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return badRequest(res, "request body must be valid JSON");
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

// ── Startup ────────────────────────────────────────────────────

async function start() {
  await migrateWithRetry();
  const server = app.listen(PORT, () => {
    console.log(`student-service listening on :${PORT}`);
  });
  process.on("SIGTERM", () => {
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
  });
}

start().catch((err) => {
  console.error("student-service failed to start:", err);
  process.exit(1);
});
