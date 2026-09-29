const crypto = require("crypto");
const { spawn } = require("child_process");
const jwt = require("jsonwebtoken");

// LMD 4.0 grade scale. Single source of truth: also used to build the SQL
// that computes GPA snapshots, so JS and SQL can never disagree.
const GRADE_POINTS = { A: 4.0, "B+": 3.5, B: 3.0, "C+": 2.5, C: 2.0, "D+": 1.5, D: 1.0, F: 0.0 };
const STAFF_ROLES = ["lecturer", "admin"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONCURRENT_RENDERS = 2;   // WeasyPrint is CPU-heavy; cap it per replica
const RENDER_TIMEOUT_MS = 20000;
const UPSTREAM_TIMEOUT_MS = 2000;

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Credit-weighted GPA: sum(points x credits) / sum(credits).
function weightedGpa(rows) {
  const credits = rows.reduce((sum, r) => sum + r.credits, 0);
  if (!credits) return { gpa: null, credits: 0 };
  const points = rows.reduce((sum, r) => sum + r.points * r.credits, 0);
  return { gpa: Math.round((points / credits) * 100) / 100, credits };
}

// Allow `npm test` to run as a fast smoke test without starting a server.
if (process.argv.includes("--test")) {
  const { gpa } = weightedGpa([{ points: 4, credits: 3 }, { points: 3, credits: 2 }]);
  if (gpa !== 3.6) throw new Error(`GPA calc wrong: ${gpa}`);
  if (escapeHtml('<img src="x">') !== "&lt;img src=&quot;x&quot;&gt;") throw new Error("escapeHtml failed");
  console.log("Transcript service smoke test passed.");
  process.exit(0);
}

const express = require("express");
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");
const { pool, migrateWithRetry } = require("./db");
const events = require("./events");
const { setupMetrics } = require("./metrics");

const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const STUDENT_URL = process.env.STUDENT_URL || "http://student-service:3000";
const INSTITUTION_NAME = process.env.INSTITUTION_NAME || "ICT University, Yaoundé";
if (!JWT_SECRET) {
  console.error("JWT_SECRET is not set — refusing to start.");
  process.exit(1);
}

const app = express();
setupMetrics(app, "transcript-service");
app.use(express.json({ limit: "10kb" }));

// ── Helpers ────────────────────────────────────────────────────

const badRequest = (res, message) => res.status(400).json({ error: message });
const forbidden = (res, message) => res.status(403).json({ error: message });
const route = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Verified locally with the shared secret, like the Student Service.
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

function validStudentId(req, res, next) {
  if (!UUID_RE.test(req.params.studentId)) return badRequest(res, "studentId must be a UUID");
  next();
}

const canRead = (user, studentId) => user.sub === studentId || STAFF_ROLES.includes(user.role);

const POINTS_SQL = `CASE grade ${Object.entries(GRADE_POINTS)
  .map(([g, p]) => `WHEN '${g}' THEN ${p}`)
  .join(" ")} END`;

// Recomputes the cached GPA for one student/semester inside the caller's
// transaction, so the grade and its GPA snapshot commit together.
async function recomputeSnapshot(client, institutionId, studentId, semester) {
  const { rows } = await client.query(
    `INSERT INTO transcript.gpa_snapshots (institution_id, student_id, semester, gpa, credits, computed_at)
     SELECT $1, $2, $3,
            ROUND(SUM((${POINTS_SQL}) * credits)::numeric / SUM(credits), 2),
            SUM(credits), now()
     FROM transcript.grades
     WHERE institution_id = $1 AND student_id = $2 AND semester = $3
     ON CONFLICT (institution_id, student_id, semester)
     DO UPDATE SET gpa = EXCLUDED.gpa, credits = EXCLUDED.credits, computed_at = now()
     RETURNING gpa, credits`,
    [institutionId, studentId, semester]
  );
  return { gpa: Number(rows[0].gpa), credits: rows[0].credits };
}

// Grades grouped by semester, with each semester's snapshot GPA and the
// credit-weighted cumulative GPA.
async function loadTranscript(institutionId, studentId) {
  const [grades, snapshots] = await Promise.all([
    pool.query(
      `SELECT course_code, course_title, credits, grade, semester
       FROM transcript.grades
       WHERE institution_id = $1 AND student_id = $2
       ORDER BY semester, course_code`,
      [institutionId, studentId]
    ),
    pool.query(
      `SELECT semester, gpa, credits FROM transcript.gpa_snapshots
       WHERE institution_id = $1 AND student_id = $2`,
      [institutionId, studentId]
    ),
  ]);
  const snapshotBySemester = new Map(snapshots.rows.map((s) => [s.semester, s]));
  const semesters = [];
  for (const g of grades.rows) {
    let current = semesters[semesters.length - 1];
    if (!current || current.semester !== g.semester) {
      const snap = snapshotBySemester.get(g.semester);
      current = {
        semester: g.semester,
        gpa: snap ? Number(snap.gpa) : null,
        credits: snap ? snap.credits : 0,
        courses: [],
      };
      semesters.push(current);
    }
    current.courses.push({
      courseCode: g.course_code,
      courseTitle: g.course_title,
      credits: g.credits,
      grade: g.grade,
      points: GRADE_POINTS[g.grade],
    });
  }
  const cumulative = weightedGpa(
    semesters.filter((s) => s.gpa !== null).map((s) => ({ points: s.gpa, credits: s.credits }))
  );
  return { studentId, semesters, cumulativeGpa: cumulative.gpa, totalCredits: cumulative.credits };
}

// Name/student number for the PDF header. Optional: if the Student Service
// is unavailable the transcript is still produced, identified by id only.
async function fetchProfile(studentId, authorization) {
  try {
    const res = await fetch(`${STUDENT_URL}/student/profile/${studentId}`, {
      headers: { authorization },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ── PDF rendering (WeasyPrint) ─────────────────────────────────

// Simple semaphore: at most MAX_CONCURRENT_RENDERS WeasyPrint processes per
// replica; extra requests wait for a slot. A freed slot is handed directly
// to the next waiter so the limit can't be overshot.
let activeRenders = 0;
const renderQueue = [];
async function withRenderSlot(fn) {
  if (activeRenders < MAX_CONCURRENT_RENDERS) activeRenders++;
  else await new Promise((resolve) => renderQueue.push(resolve));
  try {
    return await fn();
  } finally {
    const next = renderQueue.shift();
    if (next) next();
    else activeRenders--;
  }
}

// Pipes HTML into `weasyprint - -` and resolves with the PDF bytes.
function renderPdf(html) {
  return new Promise((resolve, reject) => {
    const proc = spawn("weasyprint", ["--quiet", "-", "-"]);
    const chunks = [];
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), RENDER_TIMEOUT_MS);
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`weasyprint exited ${code}: ${stderr.slice(0, 500)}`));
    });
    proc.stdin.end(html);
  });
}

// Every interpolated value goes through escapeHtml: data can never become
// markup, so it can't inject tags or make WeasyPrint fetch URLs.
function transcriptHtml(transcript, profile) {
  const e = escapeHtml;
  const fmt = (gpa) => (gpa === null ? "—" : gpa.toFixed(2));
  const semesterBlocks = transcript.semesters.length
    ? transcript.semesters.map((s) => `
      <h3>${e(s.semester)}</h3>
      <table>
        <thead><tr><th>Code</th><th>Course</th><th class="num">Credits</th><th class="num">Grade</th><th class="num">Points</th></tr></thead>
        <tbody>
          ${s.courses.map((c) => `
          <tr><td>${e(c.courseCode)}</td><td>${e(c.courseTitle || "")}</td>
              <td class="num">${e(c.credits)}</td><td class="num">${e(c.grade)}</td>
              <td class="num">${e(c.points.toFixed(1))}</td></tr>`).join("")}
        </tbody>
        <tfoot><tr><td colspan="2">Semester GPA</td><td class="num">${e(s.credits)}</td><td></td><td class="num">${e(fmt(s.gpa))}</td></tr></tfoot>
      </table>`).join("")
    : `<p class="muted">No grades have been recorded yet.</p>`;

  const scale = Object.entries(GRADE_POINTS).map(([g, p]) => `${e(g)} = ${p.toFixed(1)}`).join(" · ");

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm 16mm; @bottom-center { content: "Page " counter(page) " of " counter(pages); font-size: 8pt; color: #666; } }
  body { font-family: "DejaVu Sans", sans-serif; font-size: 9.5pt; color: #111; }
  h1 { font-size: 15pt; margin: 0; } h2 { font-size: 11pt; font-weight: normal; margin: 2pt 0 12pt; color: #444; }
  h3 { font-size: 10.5pt; margin: 14pt 0 4pt; }
  .meta td { padding: 1pt 12pt 1pt 0; border: none; } .meta td:first-child { color: #555; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 3pt 4pt; border-bottom: 0.5pt solid #ccc; }
  th { background: #f0f2f5; } tfoot td { font-weight: bold; border-top: 0.8pt solid #333; }
  .num { text-align: right; } .muted { color: #666; }
  .summary { margin-top: 16pt; padding: 6pt 8pt; border: 0.8pt solid #333; }
  .footer { margin-top: 18pt; font-size: 8pt; color: #666; }
</style></head><body>
  <h1>${e(INSTITUTION_NAME)}</h1>
  <h2>Academic Transcript</h2>
  <table class="meta">
    <tr><td>Student name</td><td>${e(profile?.fullName || "(profile unavailable)")}</td></tr>
    <tr><td>Student number</td><td>${e(profile?.studentNumber || "—")}</td></tr>
    <tr><td>Student ID</td><td>${e(transcript.studentId)}</td></tr>
    <tr><td>Issued</td><td>${e(new Date().toISOString().slice(0, 10))}</td></tr>
  </table>
  ${semesterBlocks}
  <div class="summary">
    Cumulative GPA: <strong>${e(fmt(transcript.cumulativeGpa))}</strong> ·
    Total credits: <strong>${e(transcript.totalCredits)}</strong>
  </div>
  <p class="footer">Grade scale: ${scale}. GPA is credit-weighted. Computer-generated by the Student Portal; not valid without institutional verification.</p>
</body></html>`;
}

// ── Swagger / OpenAPI ──────────────────────────────────────────

/**
 * @openapi
 * components:
 *   securitySchemes:
 *     bearerAuth: { type: http, scheme: bearer, bearerFormat: JWT }
 *   schemas:
 *     Grade:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         studentId: { type: string, format: uuid }
 *         courseCode: { type: string, example: SWE301 }
 *         courseTitle: { type: string, nullable: true, example: Software Architecture }
 *         credits: { type: integer, example: 4 }
 *         grade: { type: string, enum: [A, B+, B, C+, C, D+, D, F] }
 *         semester: { type: string, example: "2026/2027 Semester 1" }
 *         postedBy: { type: string, format: uuid }
 *         postedAt: { type: string, format: date-time }
 */
const openapiSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Student Portal — Transcript Service",
      version: "1.0.0",
      description:
        "Grades, credit-weighted GPA (LMD 4.0 scale) and PDF transcripts (WeasyPrint). Posting a grade publishes a grade.posted event to RabbitMQ (exchange portal.events).",
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [__filename],
});
app.get("/transcript/docs.json", (req, res) => res.json(openapiSpec));
app.use("/transcript/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

// ── Endpoints ──────────────────────────────────────────────────

/**
 * @openapi
 * /transcript/health:
 *   get:
 *     summary: Liveness check covering Postgres (via PgBouncer) and RabbitMQ
 *     security: []
 *     responses:
 *       200: { description: All dependencies reachable }
 *       503: { description: A dependency is down }
 */
app.get("/transcript/health", async (req, res) => {
  const [database, rabbitmq] = await Promise.all([
    pool.query("SELECT 1").then(() => "ok", () => "down"),
    events.isConnected().then((ok) => (ok ? "ok" : "down")),
  ]);
  const healthy = database === "ok" && rabbitmq === "ok";
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    service: "transcript-service",
    checks: { database, rabbitmq },
  });
});

/**
 * @openapi
 * /transcript/grades:
 *   post:
 *     summary: Post a grade (lecturer or admin only)
 *     description: >
 *       Saves the grade and recomputes that semester's GPA snapshot in one
 *       transaction, then publishes a `grade.posted` event to RabbitMQ
 *       (exchange `portal.events`). Grades are immutable: posting the same
 *       student/course/semester again returns 409. If RabbitMQ is unavailable
 *       the grade is still saved and `event.published` is false.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId, courseCode, credits, grade, semester]
 *             properties:
 *               studentId: { type: string, format: uuid, description: "The student's user id (JWT sub)" }
 *               courseCode: { type: string, example: SWE301 }
 *               courseTitle: { type: string, example: Software Architecture }
 *               credits: { type: integer, minimum: 1, maximum: 30, example: 4 }
 *               grade: { type: string, enum: [A, B+, B, C+, C, D+, D, F] }
 *               semester: { type: string, example: "2026/2027 Semester 1" }
 *     responses:
 *       201:
 *         description: Grade saved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 grade: { $ref: '#/components/schemas/Grade' }
 *                 semesterGpa: { type: number, example: 3.45 }
 *                 event:
 *                   type: object
 *                   properties:
 *                     type: { type: string, example: grade.posted }
 *                     eventId: { type: string, format: uuid }
 *                     published: { type: boolean }
 *       400: { description: Invalid input }
 *       401: { description: Missing or invalid token }
 *       403: { description: Caller is not a lecturer or admin }
 *       409: { description: A grade already exists for this student, course and semester }
 */
app.post("/transcript/grades", requireAuth, route(async (req, res) => {
  if (!STAFF_ROLES.includes(req.user.role)) return forbidden(res, "only lecturers and admins can post grades");
  const { studentId, courseCode, courseTitle = null, credits, grade, semester } = req.body || {};
  if (typeof studentId !== "string" || !UUID_RE.test(studentId)) return badRequest(res, "studentId must be a UUID");
  if (typeof courseCode !== "string" || !courseCode.trim()) return badRequest(res, "courseCode is required");
  if (courseTitle !== null && typeof courseTitle !== "string") return badRequest(res, "courseTitle must be a string");
  if (!Number.isInteger(credits) || credits < 1 || credits > 30) return badRequest(res, "credits must be an integer from 1 to 30");
  if (!(grade in GRADE_POINTS)) return badRequest(res, `grade must be one of: ${Object.keys(GRADE_POINTS).join(", ")}`);
  if (typeof semester !== "string" || !semester.trim()) return badRequest(res, "semester is required");

  const institutionId = req.user.institution_id;
  const client = await pool.connect();
  let saved;
  let snapshot;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO transcript.grades
         (institution_id, student_id, course_code, course_title, credits, grade, semester, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [institutionId, studentId, courseCode.trim().toUpperCase(), courseTitle, credits, grade, semester.trim(), req.user.sub]
    );
    saved = rows[0];
    snapshot = await recomputeSnapshot(client, institutionId, studentId, saved.semester);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") {
      return res.status(409).json({ error: "a grade already exists for this student, course and semester" });
    }
    throw err;
  } finally {
    client.release();
  }

  // Published only after the commit, so no event is ever sent for a grade
  // that wasn't saved. (A transactional outbox would also guarantee the
  // reverse — no saved grade without an event — and is on the roadmap.)
  const event = {
    eventId: crypto.randomUUID(),
    type: "grade.posted",
    occurredAt: new Date().toISOString(),
    institutionId,
    gradeId: saved.id,
    studentId,
    courseCode: saved.course_code,
    courseTitle: saved.course_title,
    grade: saved.grade,
    semester: saved.semester,
    semesterGpa: snapshot.gpa,
    postedBy: req.user.sub,
  };
  let published = true;
  try {
    await events.publish("grade.posted", event);
  } catch (err) {
    published = false;
    console.error(`grade.posted publish failed for grade ${saved.id}: ${err.message}`);
  }

  res.status(201).json({
    grade: {
      id: saved.id,
      studentId: saved.student_id,
      courseCode: saved.course_code,
      courseTitle: saved.course_title,
      credits: saved.credits,
      grade: saved.grade,
      semester: saved.semester,
      postedBy: saved.posted_by,
      postedAt: saved.posted_at,
    },
    semesterGpa: snapshot.gpa,
    event: { type: "grade.posted", eventId: event.eventId, published },
  });
}));

/**
 * @openapi
 * /transcript/{studentId}/pdf:
 *   get:
 *     summary: Download the student's transcript as a PDF (WeasyPrint)
 *     description: >
 *       Students may download only their own transcript; lecturers and admins
 *       may download any within their institution. The student's name comes
 *       from the Student Service; if it is unavailable the PDF is still produced.
 *     parameters:
 *       - { name: studentId, in: path, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: PDF transcript
 *         content: { application/pdf: { schema: { type: string, format: binary } } }
 *       401: { description: Missing or invalid token }
 *       403: { description: Not allowed to view this transcript }
 */
app.get("/transcript/:studentId/pdf", requireAuth, validStudentId, route(async (req, res) => {
  if (!canRead(req.user, req.params.studentId)) return forbidden(res, "you may only view your own transcript");
  const [transcript, profile] = await Promise.all([
    loadTranscript(req.user.institution_id, req.params.studentId),
    fetchProfile(req.params.studentId, req.get("authorization")),
  ]);
  const pdf = await withRenderSlot(() => renderPdf(transcriptHtml(transcript, profile)));
  const fileId = (profile?.studentNumber || req.params.studentId).replace(/[^A-Za-z0-9_-]/g, "");
  res
    .set("Content-Type", "application/pdf")
    .set("Content-Disposition", `attachment; filename="transcript-${fileId}.pdf"`)
    .send(pdf);
}));

/**
 * @openapi
 * /transcript/{studentId}:
 *   get:
 *     summary: The student's transcript as JSON (grades by semester, GPA)
 *     description: Same access rules as the PDF. Used by the frontend's transcript view.
 *     parameters:
 *       - { name: studentId, in: path, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Transcript
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 studentId: { type: string, format: uuid }
 *                 semesters: { type: array, items: { type: object } }
 *                 cumulativeGpa: { type: number, nullable: true }
 *                 totalCredits: { type: integer }
 *       401: { description: Missing or invalid token }
 *       403: { description: Not allowed }
 */
app.get("/transcript/:studentId", requireAuth, validStudentId, route(async (req, res) => {
  if (!canRead(req.user, req.params.studentId)) return forbidden(res, "you may only view your own transcript");
  res.json(await loadTranscript(req.user.institution_id, req.params.studentId));
}));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return badRequest(res, "request body must be valid JSON");
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

// ── Startup ────────────────────────────────────────────────────

async function start() {
  await migrateWithRetry();
  // Declare the exchange/queue at startup so they're visible in RabbitMQ
  // before the first grade; not fatal — publish() reconnects on demand.
  await events.isConnected().then((ok) =>
    console.log(ok ? "RabbitMQ connected; exchange and queue declared" : "RabbitMQ not reachable yet; will retry on publish")
  );
  const server = app.listen(PORT, () => {
    console.log(`transcript-service listening on :${PORT}`);
  });
  process.on("SIGTERM", () => {
    server.close(async () => {
      await Promise.allSettled([pool.end(), events.close()]);
      process.exit(0);
    });
  });
}

start().catch((err) => {
  console.error("transcript-service failed to start:", err);
  process.exit(1);
});
