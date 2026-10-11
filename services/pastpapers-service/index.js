const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const STAFF_ROLES = ["lecturer", "admin"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TAGS = 10;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const SEARCH_LIMIT = 100;

// Lowercase letters/digits only (accented letters included): search terms
// can never carry tsquery operators, whatever the user types.
const searchTokens = (text) => String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// "Midterm, exam ,midterm" -> ["midterm", "exam"]
function parseTags(raw) {
  if (raw === undefined || raw === "") return [];
  const tags = String(raw)
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(tags)];
}

const isPdf = (buffer) => buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";

// Allow `npm test` to run as a fast smoke test without starting a server.
if (process.argv.includes("--test")) {
  if (searchTokens("SWE-301 'Réseaux' & | !").join(" ") !== "swe 301 réseaux") throw new Error("searchTokens failed");
  if (parseTags("Midterm, exam ,midterm").join(",") !== "midterm,exam") throw new Error("parseTags failed");
  if (!isPdf(Buffer.from("%PDF-1.7")) || isPdf(Buffer.from("MZ\x90\x00"))) throw new Error("isPdf failed");
  console.log("Past papers service smoke test passed.");
  process.exit(0);
}

const express = require("express");
const multer = require("multer");
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");
const { pool, migrateWithRetry } = require("./db");
const storage = require("./storage");
const events = require("./events");
const { setupMetrics } = require("./metrics");

const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("JWT_SECRET is not set — refusing to start.");
  process.exit(1);
}

const app = express();
setupMetrics(app, "pastpapers-service");

// File kept in memory with a hard size cap; multer aborts oversized uploads.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 },
}).single("file");

// ── Helpers ────────────────────────────────────────────────────

const badRequest = (res, message) => res.status(400).json({ error: message });
const route = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Verified locally with the shared secret, like the other services.
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

function requireStaff(req, res, next) {
  if (!STAFF_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: "only lecturers and admins can upload past papers" });
  }
  next();
}

function paperJson(row) {
  return {
    id: row.id,
    course: row.course,
    year: row.year,
    semester: row.semester,
    tags: row.tags,
    originalFilename: row.original_filename,
    sizeBytes: row.size_bytes,
    downloadCount: row.download_count,
    uploaderId: row.uploader_id,
    uploadedAt: row.uploaded_at,
  };
}

const PAPER_COLUMNS = `id, course, year, semester, tags, original_filename, size_bytes,
                       download_count, uploader_id, uploaded_at`;

// ── Swagger / OpenAPI ──────────────────────────────────────────

/**
 * @openapi
 * components:
 *   securitySchemes:
 *     bearerAuth: { type: http, scheme: bearer, bearerFormat: JWT }
 *   schemas:
 *     Paper:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         course: { type: string, example: SWE301 }
 *         year: { type: integer, example: 2024 }
 *         semester: { type: string, example: Semester 1 }
 *         tags: { type: array, items: { type: string }, example: [midterm, architecture] }
 *         originalFilename: { type: string, nullable: true }
 *         sizeBytes: { type: integer }
 *         downloadCount: { type: integer }
 *         uploaderId: { type: string, format: uuid }
 *         uploadedAt: { type: string, format: date-time }
 */
const openapiSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Student Portal — Past Papers Service",
      version: "1.0.0",
      description:
        "Upload, search, list and download past exam papers. Files live in MinIO (private bucket); metadata and a full-text search vector live in Postgres. Uploads publish a pastpaper.uploaded event to RabbitMQ.",
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [__filename],
});
app.get("/pastpapers/docs.json", (req, res) => res.json(openapiSpec));
app.use("/pastpapers/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

// ── Endpoints ──────────────────────────────────────────────────

/**
 * @openapi
 * /pastpapers/health:
 *   get:
 *     summary: Liveness check covering Postgres (via PgBouncer), MinIO and RabbitMQ
 *     security: []
 *     responses:
 *       200: { description: All dependencies reachable }
 *       503: { description: A dependency is down }
 */
app.get("/pastpapers/health", async (req, res) => {
  const [database, minio, rabbitmq] = await Promise.all([
    pool.query("SELECT 1").then(() => "ok", () => "down"),
    storage.isReachable().then((ok) => (ok ? "ok" : "down")),
    events.isConnected().then((ok) => (ok ? "ok" : "down")),
  ]);
  const checks = { database, minio, rabbitmq };
  const healthy = Object.values(checks).every((v) => v === "ok");
  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", service: "pastpapers-service", checks });
});

/**
 * @openapi
 * /pastpapers/upload:
 *   post:
 *     summary: Upload a past paper (lecturer or admin only)
 *     description: >
 *       Stores the PDF in MinIO, records its metadata in Postgres and publishes a
 *       `pastpaper.uploaded` event. PDF only (checked by the file's content, not
 *       its name), max 20 MB. If the metadata insert fails, the stored file is
 *       deleted so no orphaned objects are left behind.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, course, year, semester]
 *             properties:
 *               file: { type: string, format: binary }
 *               course: { type: string, example: SWE301 }
 *               year: { type: integer, example: 2024 }
 *               semester: { type: string, example: Semester 1 }
 *               tags: { type: string, description: "Comma-separated, e.g. 'midterm, architecture'" }
 *     responses:
 *       201:
 *         description: Uploaded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 paper: { $ref: '#/components/schemas/Paper' }
 *                 event:
 *                   type: object
 *                   properties:
 *                     type: { type: string, example: pastpaper.uploaded }
 *                     eventId: { type: string, format: uuid }
 *                     published: { type: boolean }
 *       400: { description: Invalid fields or not a PDF }
 *       401: { description: Missing or invalid token }
 *       403: { description: Caller is not a lecturer or admin }
 *       413: { description: File larger than 20 MB }
 */
// Auth and role checks run before multer, so unauthorised callers can't make
// the server buffer a 20 MB body first.
app.post("/pastpapers/upload", requireAuth, requireStaff, upload, route(async (req, res) => {
  if (!req.file) return badRequest(res, "a PDF file is required in the 'file' field");
  if (!isPdf(req.file.buffer)) return badRequest(res, "only PDF files are accepted");
  const course = String(req.body.course || "").trim().toUpperCase();
  const semester = String(req.body.semester || "").trim();
  const year = Number(req.body.year);
  const tags = parseTags(req.body.tags);
  const maxYear = new Date().getFullYear() + 1;
  if (!course || course.length > 100) return badRequest(res, "course is required (max 100 characters)");
  if (!Number.isInteger(year) || year < 1990 || year > maxYear) return badRequest(res, `year must be between 1990 and ${maxYear}`);
  if (!semester || semester.length > 40) return badRequest(res, "semester is required (max 40 characters)");
  if (tags.length > MAX_TAGS) return badRequest(res, `at most ${MAX_TAGS} tags`);
  if (tags.some((t) => t.length > 30)) return badRequest(res, "each tag must be at most 30 characters");

  const institutionId = req.user.institution_id;
  // Server-generated key: user input never becomes a storage path.
  const objectKey = `${institutionId}/${crypto.randomUUID()}.pdf`;
  await storage.putPdf(objectKey, req.file.buffer);

  let row;
  try {
    const { rows } = await pool.query(
      `INSERT INTO pastpapers.papers
         (institution_id, course, year, semester, tags, uploader_id, minio_object_key, original_filename, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${PAPER_COLUMNS}`,
      [institutionId, course, year, semester, tags, req.user.sub, objectKey,
       req.file.originalname.slice(0, 200), req.file.size]
    );
    row = rows[0];
  } catch (err) {
    // Compensate: don't leave a file in MinIO with no metadata pointing at it.
    await storage.remove(objectKey).catch((e) => console.error(`orphan cleanup failed for ${objectKey}: ${e.message}`));
    throw err;
  }

  const event = {
    eventId: crypto.randomUUID(),
    type: "pastpaper.uploaded",
    occurredAt: new Date().toISOString(),
    institutionId,
    paperId: row.id,
    course: row.course,
    year: row.year,
    semester: row.semester,
    tags: row.tags,
    uploadedBy: req.user.sub,
    // Lets the Notification Service email the uploader without a database.
    uploaderEmail: req.user.email || null,
  };
  let published = true;
  try {
    await events.publish("pastpaper.uploaded", event);
  } catch (err) {
    published = false;
    console.error(`pastpaper.uploaded publish failed for paper ${row.id}: ${err.message}`);
  }

  res.status(201).json({
    paper: paperJson(row),
    event: { type: "pastpaper.uploaded", eventId: event.eventId, published },
  });
}));

/**
 * @openapi
 * /pastpapers/search:
 *   get:
 *     summary: Full-text search over course, year, semester and tags
 *     description: >
 *       `q` is matched against the Postgres tsvector with prefix matching, so
 *       "swe" finds SWE301 and "mid" finds the tag "midterm". The other filters
 *       narrow the results exactly. At least one parameter is required; use
 *       /pastpapers/list for everything. Ranked by relevance, then newest year.
 *     parameters:
 *       - { name: q, in: query, schema: { type: string }, description: "Free text, e.g. 'swe midterm'" }
 *       - { name: course, in: query, schema: { type: string }, description: "Course code or part of it" }
 *       - { name: year, in: query, schema: { type: integer } }
 *       - { name: semester, in: query, schema: { type: string }, description: "Exact, case-insensitive" }
 *       - { name: tag, in: query, schema: { type: string }, description: "Exact tag" }
 *     responses:
 *       200:
 *         description: Matching papers (max 100)
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { count: { type: integer }, papers: { type: array, items: { $ref: '#/components/schemas/Paper' } } } }
 *       400: { description: No search criteria given, or invalid year }
 *       401: { description: Missing or invalid token }
 */
app.get("/pastpapers/search", requireAuth, route(async (req, res) => {
  const { q, course, year, semester, tag } = req.query;
  const tokens = [...searchTokens(q), ...searchTokens(course)];
  const params = [req.user.institution_id];
  const where = ["institution_id = $1"];
  // Relevance ordering only applies to text searches. (A constant like
  // "ORDER BY 0" would be read by Postgres as "sort by column number 0".)
  const orderBy = ["year DESC", "uploaded_at DESC"];

  if (tokens.length) {
    params.push(tokens.map((t) => `${t}:*`).join(" & "));
    where.push(`search_vector @@ to_tsquery('simple', $${params.length})`);
    orderBy.unshift(`ts_rank(search_vector, to_tsquery('simple', $${params.length})) DESC`);
  }
  if (year !== undefined && year !== "") {
    const y = Number(year);
    if (!Number.isInteger(y)) return badRequest(res, "year must be an integer");
    params.push(y);
    where.push(`year = $${params.length}`);
  }
  if (semester) {
    params.push(String(semester).trim());
    where.push(`lower(semester) = lower($${params.length})`);
  }
  if (tag) {
    params.push(String(tag).trim().toLowerCase());
    where.push(`tags @> ARRAY[$${params.length}]::text[]`);
  }
  if (where.length === 1) {
    return badRequest(res, "give at least one of q, course, year, semester or tag (use /pastpapers/list for everything)");
  }

  const { rows } = await pool.query(
    `SELECT ${PAPER_COLUMNS} FROM pastpapers.papers
     WHERE ${where.join(" AND ")}
     ORDER BY ${orderBy.join(", ")}
     LIMIT ${SEARCH_LIMIT}`,
    params
  );
  res.json({ count: rows.length, papers: rows.map(paperJson) });
}));

/**
 * @openapi
 * /pastpapers/list:
 *   get:
 *     summary: List all past papers (newest first), paginated
 *     parameters:
 *       - { name: limit, in: query, schema: { type: integer, default: 50, maximum: 200 } }
 *       - { name: offset, in: query, schema: { type: integer, default: 0 } }
 *     responses:
 *       200:
 *         description: Papers
 *         content:
 *           application/json:
 *             schema: { type: object, properties: { total: { type: integer }, papers: { type: array, items: { $ref: '#/components/schemas/Paper' } } } }
 *       401: { description: Missing or invalid token }
 */
app.get("/pastpapers/list", requireAuth, route(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || LIST_DEFAULT, 1), LIST_MAX);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const [list, total] = await Promise.all([
    pool.query(
      `SELECT ${PAPER_COLUMNS} FROM pastpapers.papers
       WHERE institution_id = $1
       ORDER BY uploaded_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.institution_id, limit, offset]
    ),
    pool.query("SELECT count(*)::int AS n FROM pastpapers.papers WHERE institution_id = $1", [req.user.institution_id]),
  ]);
  res.json({ total: total.rows[0].n, limit, offset, papers: list.rows.map(paperJson) });
}));

/**
 * @openapi
 * /pastpapers/{id}/download:
 *   get:
 *     summary: Download a past paper (streams the PDF from MinIO)
 *     description: Increments the paper's download count.
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: The PDF
 *         content: { application/pdf: { schema: { type: string, format: binary } } }
 *       400: { description: id is not a UUID }
 *       401: { description: Missing or invalid token }
 *       404: { description: No such paper in your institution }
 */
app.get("/pastpapers/:id/download", requireAuth, route(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return badRequest(res, "id must be a UUID");
  const { rows } = await pool.query(
    `UPDATE pastpapers.papers SET download_count = download_count + 1
     WHERE id = $1 AND institution_id = $2
     RETURNING minio_object_key, course, year, semester, size_bytes`,
    [req.params.id, req.user.institution_id]
  );
  const paper = rows[0];
  if (!paper) return res.status(404).json({ error: "past paper not found" });

  const stream = await storage.getStream(paper.minio_object_key);
  const filename = `${paper.course}-${paper.year}-${paper.semester}`.replace(/[^A-Za-z0-9_-]+/g, "-") + ".pdf";
  res
    .set("Content-Type", "application/pdf")
    .set("Content-Length", String(paper.size_bytes))
    .set("Content-Disposition", `attachment; filename="${filename}"`);
  stream.on("error", (err) => {
    console.error(`stream failed for ${paper.minio_object_key}: ${err.message}`);
    res.destroy(err);
  });
  stream.pipe(res);
}));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "file too large (max 20 MB)" });
    return badRequest(res, `upload error: ${err.message}`);
  }
  if (err.code === "NoSuchKey") return res.status(404).json({ error: "file missing from storage" });
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: "internal server error" });
});

// ── Startup ────────────────────────────────────────────────────

async function start() {
  await migrateWithRetry();
  await storage.ensureBucketWithRetry();
  await events.isConnected().then((ok) =>
    console.log(ok ? "RabbitMQ connected; exchange and queue declared" : "RabbitMQ not reachable yet; will retry on publish")
  );
  const server = app.listen(PORT, () => {
    console.log(`pastpapers-service listening on :${PORT} (bucket "${storage.BUCKET}")`);
  });
  process.on("SIGTERM", () => {
    server.close(async () => {
      await Promise.allSettled([pool.end(), events.close()]);
      process.exit(0);
    });
  });
}

start().catch((err) => {
  console.error("pastpapers-service failed to start:", err);
  process.exit(1);
});
