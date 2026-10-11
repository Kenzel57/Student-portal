// k6 load test — Auth + Student + Dashboard together (guide Part 2.4).
//
// Models real sessions rather than a login flood: each virtual user is a
// different student who logs in once, then repeatedly loads the dashboard and
// their enrolment with ~1s think time, re-logging in every SESSION_ITERS
// iterations. Ramps 100 -> 500 -> 750 VUs.
//
// Run (from the project root; results land in loadtests/results/):
//   docker run --rm -e BASE_URL=http://host.docker.internal \
//     -v "${PWD}/loadtests:/scripts" grafana/k6 run /scripts/portal-flow.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost";
const TAG = __ENV.TAG ? `-${__ENV.TAG}` : "";
const MAX_VUS = 750;
const SESSION_ITERS = 30;
const PASSWORD = "k6-portal-pw";
const ADMIN = { email: __ENV.ADMIN_EMAIL || "admin@portal.local", password: __ENV.ADMIN_PASSWORD || "admin_dev_pw" };
const JSON_HEADERS = { "Content-Type": "application/json" };

const cacheHit = new Rate("dashboard_cache_hit");

export const options = {
  setupTimeout: "5m",
  stages: [
    { duration: "30s", target: 100 },
    { duration: "30s", target: 100 },
    { duration: "30s", target: 500 },
    { duration: "30s", target: 500 },
    { duration: "30s", target: 750 },
    { duration: "60s", target: 750 },
    { duration: "15s", target: 0 },
  ],
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
    "http_req_duration{name:login}": ["p(95)<1000"],
    "http_req_duration{name:dashboard}": ["p(95)<500"],
    "http_req_duration{name:enrolment}": ["p(95)<500"],
  },
};

const emailFor = (n) => `k6-portal-${n}@loadtest.local`;

// Creates MAX_VUS students, each with a profile and one enrolment. Existing
// accounts (409 from a previous run) are reused as they are.
export function setup() {
  const adminRes = http.post(`${BASE_URL}/auth/login`, JSON.stringify(ADMIN), { headers: JSON_HEADERS });
  if (adminRes.status !== 200) throw new Error(`setup: admin login failed (HTTP ${adminRes.status})`);
  const adminAuth = { ...JSON_HEADERS, Authorization: `Bearer ${adminRes.json("accessToken")}` };
  const expected = { responseCallback: http.expectedStatuses(201, 409) };

  const BATCH = 50;
  for (let start = 1; start <= MAX_VUS; start += BATCH) {
    const numbers = [];
    for (let n = start; n < start + BATCH && n <= MAX_VUS; n++) numbers.push(n);

    const registered = http.batch(numbers.map((n) => ({
      method: "POST",
      url: `${BASE_URL}/auth/register`,
      body: JSON.stringify({ email: emailFor(n), password: PASSWORD }),
      params: { headers: JSON_HEADERS, tags: { name: "setup" }, ...expected },
    })));

    const created = registered
      .map((res, i) => ({ res, n: numbers[i] }))
      .filter(({ res }) => res.status === 201)
      .map(({ res, n }) => ({ id: res.json("user.id"), n }));
    if (created.length === 0) continue;

    http.batch(created.map(({ id, n }) => ({
      method: "PUT",
      url: `${BASE_URL}/student/profile/${id}`,
      body: JSON.stringify({ fullName: `Load Test Student ${n}`, studentNumber: `K6-${String(n).padStart(4, "0")}` }),
      params: { headers: adminAuth, tags: { name: "setup" } },
    })));
    http.batch(created.map(({ id }) => ({
      method: "POST",
      url: `${BASE_URL}/student/enrolment/${id}`,
      body: JSON.stringify({ programme: "BSc Software Engineering", department: "Computer Science", yearOfStudy: 2, academicYear: "2026/2027" }),
      params: { headers: adminAuth, tags: { name: "setup" } },
    })));
  }
}

// Per-VU session state (each VU is its own JS runtime).
let session = null;
let iterationsInSession = 0;

function login() {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: emailFor(((__VU - 1) % MAX_VUS) + 1), password: PASSWORD }),
    { headers: JSON_HEADERS, tags: { name: "login" } }
  );
  const ok = check(res, { "login 200 + role student": (r) => r.status === 200 && r.json("user.role") === "student" });
  session = ok ? { token: res.json("accessToken"), id: res.json("user.id") } : null;
  iterationsInSession = 0;
}

export default function () {
  if (!session || iterationsInSession >= SESSION_ITERS) login();
  if (!session) {
    sleep(1);
    return;
  }
  iterationsInSession++;
  const auth = { headers: { Authorization: `Bearer ${session.token}` } };

  const dash = http.get(`${BASE_URL}/dashboard/home`, { ...auth, tags: { name: "dashboard" } });
  check(dash, {
    "dashboard 200": (r) => r.status === 200,
    "dashboard is student-shaped": (r) => r.status === 200 && r.json("dashboard") === "student" && r.json("profile") !== null,
  });
  if (dash.status === 200) cacheHit.add(dash.headers["X-Cache"] === "HIT");

  const enrol = http.get(`${BASE_URL}/student/enrolment/${session.id}`, { ...auth, tags: { name: "enrolment" } });
  check(enrol, { "enrolment 200": (r) => r.status === 200 });

  sleep(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const ms = (v) => `${v.toFixed(0)} ms`;
  const row = (label, key) => {
    const v = m[key] && m[key].values;
    if (!v) return `  ${label.padEnd(10)} (no data)`;
    const verdict = Object.values(m[key].thresholds || {}).every((t) => t.ok) ? "PASS" : "FAIL";
    return `  ${label.padEnd(10)} p50 ${ms(v.med).padStart(7)} | p95 ${ms(v["p(95)"]).padStart(7)} | p99 ${ms(v["p(99)"]).padStart(7)} | max ${ms(v.max).padStart(7)}  ${verdict}`;
  };
  const lines = [
    `Portal flow (Auth + Student + Dashboard), up to ${MAX_VUS} VUs${TAG}`,
    `  requests:   ${m.http_reqs.values.count} (${m.http_reqs.values.rate.toFixed(1)}/s)`,
    `  error rate: ${(m.http_req_failed.values.rate * 100).toFixed(2)}%  ${m.http_req_failed.thresholds["rate<0.01"].ok ? "PASS" : "FAIL"}`,
    `  checks ok:  ${(m.checks.values.rate * 100).toFixed(2)}%`,
    `  dashboard cache hit rate: ${m.dashboard_cache_hit ? (m.dashboard_cache_hit.values.rate * 100).toFixed(1) + "%" : "n/a"}`,
    row("overall", "http_req_duration"),
    row("login", "http_req_duration{name:login}"),
    row("dashboard", "http_req_duration{name:dashboard}"),
    row("enrolment", "http_req_duration{name:enrolment}"),
  ];
  return {
    stdout: lines.join("\n") + "\n",
    [`/scripts/results/portal-flow${TAG}.json`]: JSON.stringify(data, null, 2),
  };
}
