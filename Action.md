# Action Log — Student Portal Pipeline

A running record of every change made to this project: what was done, why, and how it was verified. Newest entries at the bottom.

**Format per entry:** Goal · Actions · Result · Why it matters (defense notes)

---

## Background: work done before this log started (2026-09-25)

### Problem
The Traefik API gateway (`portal-gateway`) could not route requests. `docker compose logs gateway` repeated:
```
ERR Failed to retrieve information of the docker client and server host error="Error response from daemon: " providerName=docker
```
And `curl http://localhost/health` returned `404 page not found`.

### Attempt 1: run Traefik as root (did not work)
- **Action:** Added `user: root` to the `gateway` service in `docker-compose.yml`, then ran `docker compose down` and `docker compose up -d --build`.
- **Result:** Same errors. `/health` was still a 404.
- **Why it failed:** The `traefik` image already runs as root. Also, `.env` sets `DOCKER_ENDPOINT=tcp://host.docker.internal:2375`, so Traefik talks to Docker over TCP and never uses the socket mount. File permissions weren't the problem.

### Diagnosis
- `docker version` showed **Docker Engine 29.8.0**, which accepts API **1.40 or newer**.
- `curl http://localhost:2375/version` worked, so the TCP endpoint was reachable.
- `curl http://localhost:2375/v1.24/version` returned empty fields. The engine rejects API 1.24.
- Traefik before v3.6 queries Docker with the old API 1.24. The engine rejects that and sends back an empty error, which is exactly the `"Error response from daemon: "` in the log.

### Fix: upgrade Traefik
- **Action:** In `docker-compose.yml`, changed `image: traefik:v3.1` to `image: traefik:v3.6` and removed `user: root`. Ran `docker compose up -d`, which recreated only the gateway container.
- **Result:**
  - `docker compose logs gateway`: no errors.
  - `curl http://localhost/health` returns `200 OK` with
    `{"status":"ok","service":"health-service","timestamp":"..."}`
  - The Traefik API (`http://localhost:8080/api/http/routers`) shows router `health@docker` enabled, and its backend server is `UP`.
- **Defense notes:**
  - **Gateway pattern:** clients call one entry point (port 80), and Traefik routes by path (`/health` goes to health-service:3000).
  - **Service discovery:** Traefik builds routes from Docker labels (`traefik.enable=true`, `traefik.http.routers.health.rule=PathPrefix(`/health`)`), so you don't edit a gateway config file when adding services.
  - **Lesson:** a pinned image version can break when the host platform (Docker Engine) moves ahead. Diagnose from evidence (API version probe) rather than guessing (running as root).

### How to verify the pipeline yourself
```powershell
docker compose ps                         # all containers running
docker compose logs gateway               # no "Error response from daemon"
curl.exe http://localhost/health          # JSON with "status":"ok"
```
Dashboard: http://localhost:8080/dashboard/ → HTTP → Routers → `health@docker`

---

## Log

<!-- New entries go below this line, one per action. -->

### 2026-09-25 — Project review before coding
- **Goal:** Understand the full project before writing service code.
- **Actions:** Read `student-portal-project-plan.pdf` (5 pages) and `student-portal-complete-build-guide.pdf` (12 pages) in full. Also read the files on disk: `docker-compose.yml`, `init-db/01-schemas.sql`, `README1.md`, `services/health-service/*` and `.github/workflows/ci.yml`.
- **Result:** Summarized the architecture and the seven core services, and flagged gaps:
  - The tier system (Core / Stretch / Post-deadline) is defined in `student-portal-services-and-plan.pdf`, which isn't in the project folder.
  - The schedule is behind: Part 0 is done, but the guide expected Parts 1–3 to be finished by 25 Sep.
- **Defense notes:** The build order (Auth first, then load-test each service alone before adding the next) is itself a risk-management decision from the plan's risk register.

### 2026-09-25 — Reviewed services-and-plan document (tiers, risks, cut-list)
- **Goal:** Take the service tiers into account before building anything.
- **Actions:** Read `student-portal-services-and-plan.pdf` (9 pages) in full.
- **Result:** Scope rule agreed with the user: **finish all 7 original services first**. Extra (Stretch) services only if the 1,000-user load test passes with time to spare.
  - **Core:** Gateway, Auth, Student, Dashboard/BFF, Transcript, Past Papers, Notification (minimal), plus Prometheus + Grafana and Swagger docs (both promoted to Core).
  - **Stretch:** Timetable (cheapest), Course & Enrolment (most impressive), Announcements, Audit Service, centralised logging (Loki).
  - **Post-deadline:** Fees & Payments (MoMo / Orange Money sandbox), Admin/Institution (multi-tenant), Search (Meilisearch), Reporting/Analytics. These go in the report as a roadmap.
  - **Never cut:** PgBouncer, the 1,000-user load test and its evidence, the backup demo video.
- **Defense notes (tiering):** Tiering shows scope judgement. Examiners credit a candidate who knows what was deliberately deferred, and why, over one who half-built everything.

### 2026-09-25 — Fixed PgBouncer (found while starting Auth)
- **Problem:** PgBouncer had never been used by a real service; the health service has no database. Checking its generated config showed two defects:
  1. It listened on **5432**, but `docker-compose.yml` and every `DATABASE_URL` use **6432**.
  2. It used `auth_type = md5` with only `portal_admin` in its password list, while Postgres 16 requires **SCRAM**. `auth_svc` could not log in through it.
- **Fix** (`docker-compose.yml`, pgbouncer): added `LISTEN_PORT: 6432` and `AUTH_TYPE: scram-sha-256`. PgBouncer's database entry already has `auth_user=portal_admin`, so with SCRAM it looks up any service role's password in Postgres. No per-role password file is needed.
- **Verified:** `psql -h pgbouncer -p 6432 -U auth_svc` returns `auth_svc` and has CREATE rights on the `auth` schema.
- **Defense notes:** Verify infrastructure with a real client before relying on it. This would otherwise have surfaced as "Auth can't connect" and cost debugging time later.

### 2026-09-25 — Built the Auth Service (Guide Part 1)
- **Files created:**
  - `services/auth-service/package.json`: express, bcrypt, jsonwebtoken, pg, ioredis, swagger-jsdoc, swagger-ui-express.
  - `services/auth-service/Dockerfile`: health-service's Dockerfile with one change: `COPY *.js .` (the code is split into two files).
  - `services/auth-service/db.js`: connection pool to PgBouncer (max 10 per replica). Creates `auth.users` and `auth.refresh_tokens` on startup under an advisory lock, so parallel replicas don't race. Retries while the database starts.
  - `services/auth-service/index.js`: the endpoints, JWT, Redis sessions and Swagger comments.
  - `loadtests/auth-login.js`: k6 script (register test user → login loop with 1 s think time → JSON results).
- **Files changed:**
  - `docker-compose.yml`: new `auth-service` block with Traefik labels for `PathPrefix(/auth)`. No `container_name`, so it can be scaled.
  - `.github/workflows/ci.yml`: `auth-service` added to the matrix.
  - `.env.example`: `JWT_SECRET`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`.
- **Endpoints:** `POST /auth/register`, `/login`, `/refresh`, `/logout`, `/password-reset/request`, `/password-reset/confirm`, plus `GET /auth/health` and Swagger at `/auth/docs`.
- **Key design decisions (defense notes):**
  - **Role in the JWT and the login body:** `role` is a claim in the signed access token and is also in `user.role`. The frontend routes students and staff to different dashboards, and other services trust the signed claim. No extra service is needed.
  - **Stateless access tokens (15 min):** services verify the signature locally, so authenticated requests never hit the database. This is what lets reads scale.
  - **Refresh tokens:**
    - Random 256-bit values, single-use, rotated on every refresh.
    - Redis holds the active sessions (`rt:<sha256>`, with a TTL). `GETDEL` claims a token atomically, so a replayed or stolen token fails.
    - Postgres `auth.refresh_tokens` is the durable record for auditing.
    - Only SHA-256 hashes are stored. That's safe for high-entropy random tokens; passwords need bcrypt because they are guessable.
  - **Passwords:** bcrypt cost 10. The 72-byte limit is enforced, because bcrypt silently truncates longer input.
  - **No account enumeration:** unknown emails still run a bcrypt compare against a dummy hash. The same 401 message comes back either way, and reset requests always return 202.
  - **Privilege escalation blocked:** only `student` can self-register. Lecturer and admin accounts need an admin's token. The first admin comes from environment variables.
  - **Schema isolation enforced by the database:** the service connects as `auth_svc`, which only has rights on the `auth` schema.
- **Manual tests through the gateway (all passed):**

  | Test | Result |
  |---|---|
  | Register student | 201 |
  | Duplicate email | 409 |
  | Self-register as lecturer | 403 |
  | Student login | 200, `role: student` in body and JWT |
  | Admin creates lecturer, lecturer login | 201, then `role: lecturer` |
  | Wrong password / unknown email | 401 with the same message |
  | Refresh | new token pair; replaying the old one gives 401 |
  | Logout | 204; refreshing afterwards gives 401 |
  | Password reset | 202 for known and unknown emails; confirm 200; reusing the token 400; old password 401, new one 200 |
  | Swagger | `/auth/docs` returns 200, with all 7 paths documented |

### 2026-09-25 — Auth login load test, Phase 1 baseline
- **Setup:** k6 v2.3.0 in Docker → `host.docker.internal/auth/login` (through Traefik). One auth-service replica. Ramp 15 s, hold 30 s, ramp down 5 s. 1 s think time.
  - **Caveat:** k6 ran on the same laptop as the system, so this is a local baseline only. Phase 4 must run k6 from a separate machine.
- **Results** (`loadtests/results/auth-login-100vu.json`, `auth-login-500vu.json`):

  | VUs | Throughput | Error rate | p50 | p95 | p99 |
  |---|---|---|---|---|---|
  | 100 | 42.7 req/s | 0.00% | 1010 ms | 1163 ms | 1278 ms |
  | 500 | 46.8 req/s | 0.04% | 9068 ms | 9234 ms | 9265 ms |

- **Bottleneck found:** throughput stays flat at about 45–50 logins/s no matter how many users there are. Latency grows as requests queue.
  - Measured one bcrypt compare at **74 ms**.
  - Node runs bcrypt on libuv's thread pool, which has **4 threads** by default: 4 × (1000 / 74) ≈ **54 logins/s maximum**. That matches the measured ceiling.
  - Postgres and PgBouncer are not the limit.
- **Defense notes:** Password hashing is deliberately expensive. It's a security control, so the fix is to add capacity, not weaken the hash. Options: raise `UV_THREADPOOL_SIZE`, and scale auth-service horizontally (`--scale auth-service=N`, guide 4.4). Traefik load-balances new replicas automatically. Waiting for the user's review before applying either.

### 2026-09-25 — Enabled the PgBouncer admin console
- **Goal:** Be able to inspect PgBouncer live (for debugging and the defense demo).
- **Action:** Added `ADMIN_USERS: ${POSTGRES_USER:-portal_admin}` to the pgbouncer service in `docker-compose.yml`, then recreated the container. Before this change, only the non-existent user `postgres` could open the console ("FATAL: not allowed").
- **Result:** `SHOW POOLS` / `SHOW STATS` work. The auth-service reconnected automatically after the PgBouncer restart (`/auth/health` → 200).
- **How to view:**
  `docker exec -e PGPASSWORD=changeme portal-postgres psql -h pgbouncer -p 6432 -U portal_admin -d pgbouncer -c "SHOW POOLS;"`
- **Defense notes:** `SHOW POOLS` shows multiplexing. `cl_*` columns are client connections from the services; `sv_*` columns are real Postgres connections. Under load, many client connections share a few server connections, which is why Postgres doesn't run out of connections at 1,000 users.

### 2026-09-25 — Added pgAdmin (browser-based database viewer)
- **Goal:** View the Postgres database from a browser without installing anything locally.
- **Actions:**
  - Added a `pgadmin` service to `docker-compose.yml`:
    - Image `dpage/pgadmin4`, exposed on `5050` (container port 80), on `portal-net`.
    - Login from `PGADMIN_DEFAULT_EMAIL` / `PGADMIN_DEFAULT_PASSWORD` in `.env`, with dev defaults `admin@example.com` / `changeme`.
    - A `pgadmin-data` volume, so saved server connections survive restarts.
  - Documented both variables in `.env.example`.
- **Result:** `http://localhost:5050` returns 200. From inside the pgAdmin container, `postgres` resolves and port 5432 is reachable.
- **Connection inside pgAdmin:** host `postgres`, port `5432`, database `student_portal`, user `portal_admin`, password `changeme`.
- **Defense notes:**
  - Inside Docker, containers find each other by **service name** on the shared network (Docker's internal DNS). That's why the host is `postgres`, not `localhost`: to pgAdmin, `localhost` means its own container.
  - pgAdmin connects directly to Postgres, not through PgBouncer. It's a single admin tool, not application traffic, and pooling is for the services under load.
  - pgAdmin is local-dev only. It must not be exposed on the Oracle Cloud deployment.

### 2026-09-26 — Auth load test: thresholds, 3 replicas, re-run (before/after)
- **Goal:** Get a real pass/fail verdict from k6, and fix the ~47 logins/s ceiling found in the baseline.
- **Changes:**
  - `loadtests/auth-login.js`:
    - Added thresholds: `http_req_failed rate<0.01` and `http_req_duration p(95)<1000` ms. k6 now prints PASS/FAIL and exits non-zero on failure.
    - The setup registration's `409` (test user already exists) is marked as expected. It had been counted as the one "error" in the baseline runs.
    - Results filenames take an optional `TAG`.
  - Renamed the baseline results to `auth-login-100vu-1replica.json` and `auth-login-500vu-1replica.json`, and kept them as "before" evidence.
  - `docker-compose.yml`, auth-service:
    - `deploy.replicas: ${AUTH_REPLICAS:-3}`
    - `UV_THREADPOOL_SIZE: ${AUTH_THREADPOOL_SIZE:-4}`
    - **Why the thread count wasn't raised:** 3 replicas × 4 threads = 12 = the Docker VM's CPU count. More threads than cores only adds contention for CPU-bound bcrypt.
- **Verified:**
  - The 3 replicas started concurrently without conflict: tables created once, still exactly 1 admin. That's the advisory lock and `ON CONFLICT DO NOTHING` working.
  - Traefik shows 3 auth backends, all UP.
  - `/health`, `/auth/health` and pgAdmin still return 200.
- **Results** (same laptop; k6 in Docker):

  | Run | Throughput | Errors | p50 | p95 | p99 | p95 < 1 s |
  |---|---|---|---|---|---|---|
  | 100 VUs, 1 replica (before) | 42.7/s | 0% | 1010 ms | 1163 ms | 1278 ms | FAIL |
  | **100 VUs, 3 replicas** | 65.3/s | 0% | 216 ms | **301 ms** | 345 ms | **PASS** |
  | 500 VUs, 1 replica (before) | 46.8/s | 0% | 9068 ms | 9234 ms | 9265 ms | FAIL |
  | **500 VUs, 3 replicas** | 86.9/s | 0% | 4065 ms | **4823 ms** | 5073 ms | **FAIL** |

- **Why 500 still fails:** CPU sampled mid-test showed each replica at ~360% (≈ 3.6 CPUs each, ~10.8 of 12 total). Postgres was at ~20%, PgBouncer ~8%, Redis ~3%. **The machine itself is saturated by bcrypt.**
  - This test has every VU log in once per second, which demands ~500 logins/s.
  - At ~74 ms of CPU per bcrypt check, that needs roughly 37 CPUs. No setting on a 12-CPU laptop can meet it.
  - The Oracle Always Free instance has only 4 OCPUs, so it will do worse on this particular test.
- **Defense notes:**
  - Horizontal scaling cut 100-user p95 by 74% and nearly doubled login throughput. That is a measured before/after.
  - The remaining limit is deliberate: bcrypt is a security control. Lowering its cost to pass a test would weaken password storage.
  - The 500-VU login-every-second workload is unrealistic. Real users log in once per session and then use their JWT, which costs no bcrypt and no database hit.
  - ~87 logins/s ≈ 313,000 logins/hour, far more than a 3,000-student institution needs.
  - The whole-system test (Part 4) should model realistic journeys: log in once, then authenticated requests with think time.

### 2026-09-26 — Built Part 2: Student Service, Dashboard/BFF, Prometheus + Grafana
- **Files created:**
  - `services/student-service/`: `package.json`, `Dockerfile`, `db.js`, `metrics.js`, `index.js`.
  - `services/dashboard-service/`: `package.json`, `Dockerfile`, `metrics.js`, `index.js`.
  - `services/auth-service/metrics.js`.
  - `monitoring/prometheus.yml`.
  - `monitoring/grafana/provisioning/{datasources,dashboards}/*.yml` and `monitoring/grafana/dashboards/student-portal.json`.
  - `loadtests/portal-flow.js`.
- **Files changed:**
  - `services/auth-service/index.js`: added `GET /auth/verify` and metrics.
  - `services/auth-service/package.json`: added `prom-client`.
  - `docker-compose.yml`: added `student-service`, `dashboard-service`, `prometheus`, `grafana`.
  - `.github/workflows/ci.yml`: both new services added to the matrix.
  - `.env.example`: Grafana login.
- **Student Service:**
  - Tables `student.profiles` (user_id = Auth user id, name, student number, contact details, `enrolment_status`, `institution_id`) and `student.enrolments` (programme, department, year of study, academic year, status, `institution_id`; FK to `profiles`).
  - Endpoints:
    - `GET /student/profile/:id`
    - `PUT /student/profile/:id` (partial update; creates the profile if missing)
    - `GET /student/enrolment/:id`
    - **Added** admin-only `POST /student/enrolment/:id`. Otherwise enrolments could only be created with raw SQL.
  - Plus `/student/health`, `/student/docs`, `/metrics`.
  - Access control:
    - Students can read and edit only their own records. Lecturers and admins can read any; only admins can write enrolments, `studentNumber` or `enrolmentStatus`.
    - **Every query is scoped by the token's `institution_id`.**
  - JWTs are verified locally with the shared secret: no network hop per request.
- **Dashboard/BFF** (`GET /dashboard/home`):
  - Validates the token via `auth-service/auth/verify`, then checks the Redis cache `dash:<userId>` (5 s TTL; `X-Cache` HIT/MISS header).
  - **Student role:** fetches profile and enrolments from Student in parallel, forwarding the user's own token.
  - **Lecturer/admin:** minimal staff payload (`role`, `name`).
  - **Graceful degradation:** if Student fails, it still returns 200 with `degraded: ["student-service"]` and doesn't cache that payload. Auth being down gives 503.
  - Upstream timeout is 2 s.
- **Monitoring:**
  - Each service exposes `/metrics` (prom-client): a request-duration histogram labelled by route *pattern* (bounded label cardinality), plus Node process metrics. `/metrics` is not routed by Traefik.
  - Prometheus scrapes every 5 s using Docker DNS discovery, so it finds each replica automatically.
  - Grafana is **provisioned from files**: the Prometheus data source and a "Student Portal — Live" dashboard (req/s, p95, 5xx rate, CPU per replica, p95 per route, event-loop lag). It's at `http://localhost:3001/d/student-portal-live`.
- **Functional tests through the gateway (all passed):**
  - Carol (student) creates her profile (201). She can't set her own `enrolmentStatus` (403). Admin sets her student number (200). Carol can't add an enrolment (403); admin can (201).
  - No token → 401. Reading another student's profile → 403. Bad id → 400. A lecturer can read Carol's profile (200).
  - Dashboard as Carol: `dashboard: "student"` with profile and enrolment; first call `X-Cache: MISS`, second `HIT`.
  - Dashboard as Bob (lecturer): `dashboard: "staff"`, `name: null` (Bob has no profile).
  - Invalid or missing token → 401.
  - With Student stopped: 200 with `profile: null`, `degraded: ["student-service"]`. It recovers once Student restarts.
  - **Bug found and fixed:** `profile` was missing from the JSON (undefined) instead of `null` when Student was down.
  - Prometheus: all 5 service replicas are UP. Grafana health is ok, and Grafana queried Prometheus successfully through its data source.

### 2026-09-26 — Combined load test (Auth + Student + Dashboard), 100 → 500 → 750 VUs
- **Test design:** realistic sessions.
  - 750 distinct students, each with a profile and an enrolment.
  - Each VU logs in once (re-login every 30 iterations), then loops `GET /dashboard/home` + `GET /student/enrolment/:id` with a 1 s think time.
  - k6 on the same laptop.
- **Replicas:** auth 3, student 1, dashboard 1.
- **Results** (`loadtests/results/portal-flow.json`): 69,060 requests (266.6/s); HTTP error rate 0.02% (13 enrolment timeouts at 60 s).

  | Endpoint | p50 | p95 | p99 | Threshold |
  |---|---|---|---|---|
  | login | 121 ms | 175 ms | 217 ms | PASS (<1 s) |
  | dashboard | 283 ms | 2368 ms | 2721 ms | FAIL (<500 ms) |
  | enrolment | 571 ms | 4289 ms | 19351 ms | FAIL (<500 ms) |

  - Checks: 90.77%. **9,169 of 32,689 dashboard responses (28%) came back degraded** (`profile: null`). Student calls exceeded the Dashboard's 2 s upstream timeout. The dashboard never returned an error, so degradation worked, but the data was missing.
  - Cache hit rate: 49.2%.
- **Timeline from Prometheus** (the same queries as the Grafana panels):
  - Up to 100 VUs: all p95s under 25 ms.
  - From about 500 VUs onward:
    - **student-service CPU pinned at 1.02 cores**, its event-loop lag at 150–250 ms, and p95 around 950–1600 ms.
    - dashboard-service CPU climbed to 0.9–1.0 cores, and its p95 to about 2.3 s.
    - auth-service stayed healthy: p95 mostly under 10 ms, CPU ≤ 2.4 of the 3 replicas' capacity.
  - Postgres and PgBouncer CPU were negligible.
- **Bottleneck:** Node.js runs JavaScript on one thread, so **one replica can use at most ~1 CPU core**.
  - Student (1 replica) saturated first. Dashboard (1 replica) was next, its CPU also near 1 core as it fans out 2–3 upstream calls per miss.
  - This is the guide's Part 4.3 case: "one service's containers max out CPU → under-replicated service → scale it."
- **Proposed fix (awaiting review):** raise the replica counts (e.g. `STUDENT_REPLICAS=3`, `DASHBOARD_REPLICAS=3`) and re-run.
- **Defense notes:**
  - Grafana/Prometheus pinpointed the bottleneck within minutes (CPU flat at 1.0 core, rising event-loop lag). The database was not the problem, which is exactly why monitoring was promoted to Core.
  - Graceful degradation kept the dashboard up (0 dashboard errors) even while its dependency was overloaded.

### 2026-09-26 — Completed guide 2.4 part 1: React frontend (login + role-based dashboards)
- **Why:** The Part 2 build had skipped 2.4's frontend, so the exit criterion ("logging in through the browser shows a populated dashboard") was not met.
- **Files created** (`services/frontend/`):
  - `package.json`: React 19, Vite 7. `npm test` = production build, so CI catches compile errors.
  - `Dockerfile`: two stages. Node builds static files; nginx serves them. The final image has no Node and no source.
  - `nginx.conf`: SPA fallback. Hashed `/assets/` cached for a year; `index.html` is `no-cache`.
  - `.dockerignore`, `index.html`, `vite.config.js` (the dev server proxies the API paths to the gateway).
  - `src/api.js`: all backend calls and token handling.
    - The access token is kept in memory; the refresh token in `sessionStorage`.
    - On 401 it refreshes once and retries. Concurrent refreshes share one call, because refresh tokens are single-use.
  - `src/App.jsx`: **role-based routing** from `user.role` in the login response. Students get the student dashboard; lecturers and admins get the staff dashboard. Screens are chosen by state, not URL, because `/student` and `/dashboard` are API paths.
  - `src/Login.jsx`, `src/Dashboards.jsx`: profile + enrolment view, staff view, a Reload button showing Redis `X-Cache` HIT/MISS, and a banner when the payload is degraded.
  - `src/styles.css`, `src/main.jsx`.
- **Files changed:**
  - `docker-compose.yml`: `frontend` service, Traefik `PathPrefix(/)` with **priority 1**, so the API routes (priority 19–24) still win.
  - `ci.yml`: `frontend` added to the matrix.
- **Verified:**
  - `/` serves the app (200, `no-cache`); JS and CSS assets 200; unknown paths fall back to `index.html`.
  - The bundle calls `/auth/login`, `/auth/refresh`, `/auth/logout`, `/dashboard/home`.
  - `/health`, `/auth/health`, `/student/health`, `/dashboard/health` still reach their services.
- **Not verified by me:** clicking through in a real browser (I have no browser access). **The user must log in once at http://localhost to confirm the exit criterion.**
- **Defense notes:**
  - The frontend is just another container behind the same gateway: one origin, so no CORS.
  - The UI routes by the role in the login response, but *security* is enforced by the backend from the signed JWT. A user who tampers with the UI still gets 403 from the APIs.
  - Token storage trade-off: `sessionStorage` is exposed to XSS. An httpOnly cookie is the post-deadline hardening.

### 2026-09-26 — Scaled Student + Dashboard to 3 replicas; re-ran the combined load test
- **Change:** `docker-compose.yml` defaults `STUDENT_REPLICAS` and `DASHBOARD_REPLICAS` changed from 1 to 3. The first combined run was renamed to `loadtests/results/portal-flow-1replica.json`.
- **Verified:** Traefik shows 3 UP backends each for auth, student and dashboard. Prometheus scrapes all 9 replicas.
- **Results, same test** (100 → 500 → 750 VUs, same laptop):

  | Metric | 1 replica (before) | 3 replicas | 3 replicas (repeat) |
  |---|---|---|---|
  | Requests (avg rate) | 69,060 (266.6/s) | 105,196 (446.5/s) | 102,451 (429.4/s) |
  | Peak throughput (Prometheus) | ~680 req/s | ~1,150 req/s | — |
  | HTTP error rate | 0.02% | **0.00%** | 0.03% |
  | Checks passed | 90.77% | **99.91%** | 99.50% |
  | Degraded dashboards | 9,169 (28%) | ~0.1% | ~0.5% |
  | Dashboard cache hit rate | 49.2% | 70.4% | 69.2% |
  | Login p95 | 175 ms | 1,381 ms | 1,235 ms |
  | Dashboard p95 | 2,368 ms | 1,534 ms | 1,619 ms |
  | Enrolment p95 / p99 / max | 4,289 / 19,351 / 59,996 ms | 1,239 / 1,432 / 3,567 ms | 1,282 / 1,632 / 8,859 ms |
  | Thresholds (p95 < 0.5–1 s) | FAIL | FAIL | FAIL |

  - Results files: `portal-flow-3replicas.json`, `portal-flow-3replicas-cpucheck.json`.
- **Timeline** (Prometheus, 3-replica run):
  - All p95s under 45 ms up to the 100-VU plateau and into the ramp.
  - p95 climbs past ~250 ms at ~500 VUs, and holds at ~2 s (dashboard) / ~1.9 s (student) at 750 VUs.
- **Diagnosis:** `docker stats` at the 750-VU plateau showed the service replicas at 0.7–1.2 cores each.
  - Traefik 0.7, k6 0.6, Postgres 0.3, RabbitMQ 0.3, Redis 0.1.
  - **Total ≈ 10.2 of the 12 CPUs** Docker has, before counting WSL/Windows overhead.
  - Student event-loop lag reached 200–370 ms even though no single replica was pinned at 1.0 core: processes were waiting for CPU. **The host is saturated.** More replicas can't help, because there are no spare cores.
  - (My guess that k6 was the main consumer was wrong: it used only ~0.6 cores.)
  - Login p95 got worse than in the 1-replica run because bcrypt now competes with the other services for CPU.
- **Where the CPU goes:**
  - Auth's 3 replicas used ~2.5 cores, mostly answering `/auth/verify` for every dashboard request. That's an HTTP hop that only checks a signature.
  - Dashboard/BFF verifying the JWT locally (as Student already does) would remove that whole hop. It's a trade-off against the guide's "validate via Auth" design; proposed, not applied.
- **Defense notes:**
  - Horizontal scaling fixed the functional failure: degraded dashboards 28% → ~0.1%, timeouts gone, throughput +70%. Monitoring then showed the next limit is hardware, not code or database.
  - Load generator and system on one laptop is the guide's warned-against setup (4.1). The Part 4 evidence must come from a separate load-generator machine.

### 2026-09-28 — Built the Transcript Service (guide Part 3.1)
- **Checked first:** WeasyPrint 66.0 installs from Alpine's repository (`apk add weasyprint font-dejavu`) on `node:20-alpine` and renders a valid PDF. The service stays on the same Node base as the others and shells out to the `weasyprint` CLI.
- **Files created** (`services/transcript-service/`):
  - `package.json`: adds `amqplib`.
  - `Dockerfile`: standard, plus `apk add weasyprint font-dejavu`.
  - `metrics.js`.
  - `db.js`: tables `transcript.grades` and `transcript.gpa_snapshots` (guide 3.1).
    - `grades` = student_id, course_code, course_title, credits, grade (DB CHECK on the letters), semester, institution_id, posted_by, posted_at.
    - `UNIQUE (institution, student, course, semester)`.
  - `events.js`: RabbitMQ publisher. Topic exchange `portal.events`; durable queue `notification.events` bound to `grade.posted`; confirm channel; persistent messages; reconnects on demand.
  - `index.js`.
- **Files changed:**
  - `docker-compose.yml`: `transcript-service`.
    - `DATABASE_URL` via PgBouncer 6432 as `transcript_svc`.
    - `AMQP_URL` built from `.env` `RABBITMQ_USER` / `RABBITMQ_PASSWORD`.
    - Waits for RabbitMQ's healthcheck.
  - `monitoring/prometheus.yml`: scrape job.
  - `ci.yml`: matrix.
- **Endpoints:**
  - `POST /transcript/grades`: lecturer/admin only.
  - `GET /transcript/:studentId/pdf`: student = own only; staff = any in their institution.
  - **Added** `GET /transcript/:studentId` (JSON), for the guide 3.4 transcript view.
  - Plus `/transcript/health` (DB + RabbitMQ) and `/transcript/docs`.
- **Key design decisions (defense notes):**
  - **LMD 4.0 grade scale** (A 4.0, B+ 3.5, B 3.0, C+ 2.5, C 2.0, D+ 1.5, D 1.0, F 0).
    - Credit-weighted GPA = Σ(points × credits) / Σ credits.
    - One JS constant also generates the SQL, so the two can't disagree.
    - `credits` and `course_title` were added beyond the spec: there's no GPA without credit weights.
  - **Grade + GPA snapshot commit in one transaction.** `grade.posted` is published only after the commit, so there's never an event for an unsaved grade.
    - If RabbitMQ is down, the grade is saved and the response says `published: false`.
    - A transactional outbox (guaranteed delivery) is the documented post-deadline improvement.
  - **Grades are immutable** (409 on a duplicate course/semester), and each records `posted_by`. That's the audit-trail answer to "how do you stop a lecturer silently altering a grade?"
  - **Why the service declares the queue:** an exchange with no bound queue drops messages. Declaring the durable `notification.events` queue now keeps events until the Notification Service consumes them (asserting a queue is idempotent).
  - **PDF safety:** every value is HTML-escaped before rendering. WeasyPrint fetches URLs in the HTML, so unescaped input could make the server request internal URLs (SSRF). The test proved an injected `<img src=http://auth-service…>` rendered as plain text.
  - **Render cap:** at most 2 concurrent WeasyPrint processes per replica (semaphore), so a burst of downloads can't starve the service.
  - **Name lookup:** the student's name and number come from the Student Service with the caller's token. If that fails, the PDF is still produced (graceful degradation).
- **Tests through the gateway (all passed):**
  - Bob (lecturer) posted grades for Carol; each returned 201 with the running semester GPA (4.00 → 3.79 → 3.25) and `event.published: true`.
  - Rejections: duplicate → 409; student posting → 403; grade `A+` → 400.
  - Carol's own PDF: 200, `application/pdf`, `%PDF-1.7`, 14 KB, ~1.1 s, filename `transcript-ICTU2026001.pdf`. Lecturer → 200. Carol → Alice's PDF 403. No token 401.
  - PDF contents verified: name and student number from Student Service; Sem 1 GPA 3.25; Sem 2 3.17; cumulative 3.22 (hand-checked).
  - **Accented text:** "Réseaux et Sécurité" first appeared garbled. Cause: Git Bash `curl` on Windows sent Windows-1252 bytes, stored as U+FFFD. A UTF-8 client stores and renders "Français académique — Rédaction" correctly, so it's not a service bug.
  - **Test-data cleanup:** deleted Carol's garbled NET302 row and the SEC101 injection-test row with SQL, then re-posted NET302 correctly (this recomputed the Sem 2 snapshot).
  - **RabbitMQ:** queue `notification.events` holds 7 ready, persistent messages, 0 consumers; exchange `portal.events` published-in = 7.
    - A peeked message (requeued, not consumed) has routing key `grade.posted`, delivery_mode 2, and **eventId `4efa8194…`, identical to the first POST's response**.
    - The 7 include the two events for the deleted test rows (deletions via SQL publish nothing). The Notification Service will see those too.
  - Swagger `/transcript/docs` returns 200 (4 paths). Prometheus target up. Other services and the frontend still return 200.

### 2026-09-28 — Frontend: Transcript view + PDF download (guide 3.4, transcript part)
- **Files:**
  - `services/frontend/src/api.js`: added `getTranscript(studentId)` and `downloadTranscriptPdf(studentId)`, plus a small shared `errorFrom()` helper.
  - New `services/frontend/src/Transcript.jsx`.
  - `App.jsx`: student tabs "My Dashboard" / "Transcript".
  - `styles.css`: tabs, numeric columns, GPA footer, summary figures.
- **Behaviour:**
  - The Transcript tab shows cumulative GPA, total credits and the semester count, then one table per semester (code, course, credits, grade, points) with the semester GPA.
  - Empty state when there are no grades.
  - **Download PDF** fetches `/transcript/:id/pdf` *with the Bearer token*, turns the response into a temporary object URL and downloads it under the server's filename (`transcript-ICTU2026001.pdf`).
  - Staff have no transcript tab yet (no student-lookup screen).
- **Verified:**
  - Vite build OK (33 modules). The new bundle contains the transcript calls and UI strings.
  - The exact calls the page makes, as Carol: `GET /transcript/:id` 200 (2 semesters, cumulative 3.22, 16 credits); `GET /transcript/:id/pdf` 200 `application/pdf`, correct filename, `%PDF-1.7`.
  - The same PDF URL without a token gives 401. That's why the page can't use a plain link.
- **Not verified by me:** clicking in a real browser (no browser access). The user should check it at http://localhost as Carol.
- **Defense notes:**
  - Browsers don't attach Bearer tokens to plain links or `<a download>`. Authenticated downloads need fetch-with-header, then a Blob/object URL.
  - The alternative (a short-lived signed download URL) is a valid post-deadline option.

### 2026-09-29 — Fixed the Postgres healthcheck log spam
- **Problem:** `pg_isready -U portal_admin` with no `-d` probes a database named after the user (`portal_admin`), which doesn't exist. Postgres logged `FATAL: database "portal_admin" does not exist` on every 5 s check: 23 times in 2 minutes before the fix.
- **Fix** (`docker-compose.yml`, postgres healthcheck): `pg_isready -U ${POSTGRES_USER:-portal_admin} -d ${POSTGRES_DB:-student_portal}`. Applied with `docker compose up -d --build`, which recreated the postgres container. Data is kept in the `postgres-data` volume.
- **Verified:**
  - The running container's healthcheck is now `pg_isready -U portal_admin -d student_portal`.
  - **0 FATAL lines** in the first 26 s after restart (~5 checks); all recent health checks exit 0.
  - auth, student and transcript `/health` all report `database: ok`. They reconnected through PgBouncer after the restart with no manual action.
- **Defense notes:**
  - A healthcheck that "passes" can still hide a misconfiguration. `pg_isready` reported ready because the server was up, while every probe generated a FATAL in the log. Noisy logs bury real errors, so clean logs are part of operability.
  - The services recovering on their own after a database restart is a small resilience demonstration.

### 2026-09-29 — Built the Past Papers Service + MinIO (guide 3.2) and the Past Papers page (guide 3.4)
- **MinIO:**
  - Added per spec (command, env, ports 9000/9001, `minio-data` volume).
  - **The image `minio/minio` no longer exists on Docker Hub** ("repository does not exist"; MinIO stopped publishing community images in late 2025). `quay.io/minio/minio` returns 401; `bitnami/minio` is gone.
  - Switched to **`cgr.dev/chainguard/minio:latest`**, Chainguard's build of the same AGPL MinIO server (RELEASE.2026-09-22). Probed first: accepts the same command, formats the volume as a non-root user, `/minio/health/live` 200.
  - `.env.example` documents `MINIO_USER` / `MINIO_PASSWORD`.
- **Files created** (`services/pastpapers-service/`):
  - `package.json`: adds `multer` and `minio`.
  - `Dockerfile`, `metrics.js`.
  - `db.js`: `pastpapers.papers` with the spec columns + `original_filename`, `size_bytes`, **`download_count`**, and **`search_vector` tsvector GENERATED ALWAYS … STORED** over course/semester/year/tags, with a GIN index.
    - `array_to_string` is STABLE, so it's wrapped in an IMMUTABLE `pastpapers.tags_to_text()`; generated columns require immutable functions.
    - Uses the `simple` text-search config: no English stemming, so course codes and French terms stay intact.
  - `events.js`: same confirm-channel publisher; binds `notification.events` to `pastpaper.uploaded`.
  - `storage.js`: MinIO client. Creates the private `pastpapers` bucket at startup (with retries); `putObject` / streaming `getObject` / `removeObject`.
  - `index.js`.
- **Files changed:** `docker-compose.yml` (`pastpapers-service`, `minio`, `minio-data`), `monitoring/prometheus.yml`, `ci.yml`, `.env.example`.
- **Endpoints:** `POST /pastpapers/upload`, `GET /pastpapers/search`, `GET /pastpapers/list`, `GET /pastpapers/:id/download`, plus `/pastpapers/health` (DB + MinIO + RabbitMQ) and `/pastpapers/docs`.
- **Design decisions (defense notes):**
  - **Upload is lecturer/admin only.** The auth and role checks run *before* multer buffers the body. Everyone logged in can search and download.
  - **PDF-only, by content:** the first bytes must be `%PDF-`, not the filename or claimed type. Max 20 MB, enforced by multer (413).
  - **Storage ordering + compensation:** MinIO put, then DB insert; if the insert fails, the object is deleted. No orphaned files.
  - **Server-generated object keys** `<institution>/<uuid>.pdf`: user input never becomes a storage path.
  - **Search:** `q` and `course` are tokenised to letters/digits (Unicode, so accents work), prefix-matched (`swe:* & mid:*`) and passed as a bind parameter. No tsquery-operator or SQL injection.
    - Exact filters: year, semester (case-insensitive), tag (`tags @> ARRAY[...]`). Ranked by `ts_rank`, then year.
    - At least one criterion is required; `/list` is the unfiltered view.
  - **Downloads are streamed** from MinIO (no whole file in memory) and increment `download_count`. The count means download *requests*.
  - **Tenant scoping:** every query is filtered by the token's `institution_id`. The bucket is private, so files are only reachable through the service.
  - `pastpaper.uploaded` is published after the insert, like grade.posted. `published:false` if RabbitMQ is down.
- **Frontend** (`services/frontend/src/`):
  - `api.js`: `authFetch` accepts method/body. Added `listPapers`, `searchPapers`, `uploadPaper` (multipart; the browser sets the boundary), `downloadPaper`; a shared `downloadFile()` helper is used by transcript and papers.
  - New `PastPapers.jsx`:
    - Search bar (text, year, semester dropdown, tag) + "Show all"; the full list by default.
    - Results table with tag chips, download count, size, date and a Download button; the count updates locally after a download.
    - **Upload form for staff only** (file, course, year, semester dropdown Semester 1 / Semester 2 / Resit, comma-separated tags).
  - `App.jsx`: students get tabs My Dashboard / Transcript / **Past Papers**; staff get Staff Dashboard / **Past Papers**.
  - `styles.css`: search bar, chips, secondary/small buttons, selects, upload grid.
  - Item 7 (transcript view/download) was already built on 2026-09-28; left as is.
- **Tests through the gateway** (test PDFs generated with WeasyPrint; scripts in the session scratchpad):
  - **Uploads:** 4 papers (SWE301 2024 S1 midterm/architecture; SWE301 2023 S2 final/architecture; MAT201 2024 S1 final/statistics; NET302 2025 Resit resit/réseaux). All 201, `event.published: true`. Course uppercased; tags lowercased and de-duplicated.
  - **Rejections:** student upload 403; text file named `.pdf` 400 ("only PDF files are accepted"); missing course 400; no token 401.
  - **Bug found and fixed:** searches with *only* exact filters (tag / semester / year) returned 500, `error: ORDER BY position 0 is not in select list`.
    - Cause: the code emitted `ORDER BY 0 DESC` when there was no text query, and Postgres reads a bare integer in ORDER BY as a column position.
    - Fix: add the relevance sort only for text searches.
  - **After the fix, all 13 search cases pass:** q=swe → 2; swe+2024 → 1; tag=final → 2; semester=resit → 1; 2024+Semester 1 → 2; year=2023 → 1; final+2024 → 1; q=arch → 2; q=mid → 1; q=réseaux → 1; course=mat → 1; q=zzz → 0; `swe' OR 1=1 --` → 0.
  - **List:** total 4.
  - **Download:** 200 `application/pdf`, filename `SWE301-2024-Semester-1.pdf`, **bytes identical to the uploaded file (sha256)**, **download_count 0 → 1 → 2**. Unknown id 404; no token 401.
  - **Storage consistency:** MinIO bucket holds exactly 4 objects = 4 DB rows (rejected uploads stored nothing).
  - **RabbitMQ:** `notification.events` went 7 → **11 persistent messages** (+4 `pastpaper.uploaded`). A peeked NET302 event (requeued) carries the full metadata.
    - Note: the management API's queue counters refresh every few seconds, so an immediate re-read showed a stale 7.
  - Swagger `/pastpapers/docs` 200; MinIO console :9001 200; Prometheus target up; all 5 service `/health` 200.
  - Frontend build OK (34 modules); the bundle contains the upload/search/list/download calls and UI.
- **Not verified by me:** clicking through the pages in a real browser (no browser access). The user should check search, upload (as Bob) and download (as Carol) at http://localhost.
