// k6 load test — Auth Service login through the gateway (Phase 1 baseline).
//
// Run (from the project root; k6 runs in Docker, results land in loadtests/results/):
//   docker run --rm -e VUS=100 -e BASE_URL=http://host.docker.internal \
//     -v "${PWD}/loadtests:/scripts" grafana/k6 run /scripts/auth-login.js
//
// Each virtual user logs in, checks the role comes back, then "thinks" for 1s,
// approximating a real student rather than an unthrottled request flood.
import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost";
const VUS = Number(__ENV.VUS || 100);
// Optional label added to the results filename, e.g. TAG=3replicas.
const TAG = __ENV.TAG ? `-${__ENV.TAG}` : "";
const EMAIL = "k6-student@loadtest.local";
const PASSWORD = "k6-loadtest-pw";
const JSON_HEADERS = { headers: { "Content-Type": "application/json" } };

export const options = {
  stages: [
    { duration: "15s", target: VUS }, // ramp up
    { duration: "30s", target: VUS }, // hold at target
    { duration: "5s", target: 0 },    // ramp down
  ],
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  // Pass/fail criteria: k6 exits non-zero if either is breached.
  thresholds: {
    http_req_failed: ["rate<0.01"],       // under 1% errors
    http_req_duration: ["p(95)<1000"],    // 95% of logins under 1 second
  },
};

export function setup() {
  const res = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    // 409 = test user already exists from a previous run; not an error.
    { ...JSON_HEADERS, responseCallback: http.expectedStatuses(201, 409) }
  );
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(`setup: could not register test user (HTTP ${res.status}): ${res.body}`);
  }
}

export default function () {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    JSON_HEADERS
  );
  check(res, {
    "status is 200": (r) => r.status === 200,
    "role is student": (r) => r.status === 200 && r.json("user.role") === "student",
  });
  sleep(1);
}

export function handleSummary(data) {
  const d = data.metrics.http_req_duration.values;
  const ms = (v) => `${v.toFixed(0)} ms`;
  const verdict = (metric) =>
    Object.entries(data.metrics[metric].thresholds || {})
      .map(([rule, t]) => `${rule} ${t.ok ? "PASS" : "FAIL"}`)
      .join(", ");
  const lines = [
    `Auth login @ ${VUS} VUs${TAG}`,
    `  requests:    ${data.metrics.http_reqs.values.count} (${data.metrics.http_reqs.values.rate.toFixed(1)}/s)`,
    `  error rate:  ${(data.metrics.http_req_failed.values.rate * 100).toFixed(2)}%`,
    `  checks ok:   ${(data.metrics.checks.values.rate * 100).toFixed(2)}%`,
    `  latency:     p50 ${ms(d.med)} | p95 ${ms(d["p(95)"])} | p99 ${ms(d["p(99)"])} | max ${ms(d.max)}`,
    `  thresholds:  ${verdict("http_req_failed")}; ${verdict("http_req_duration")}`,
  ];
  return {
    stdout: lines.join("\n") + "\n",
    [`/scripts/results/auth-login-${VUS}vu${TAG}.json`]: JSON.stringify(data, null, 2),
  };
}
