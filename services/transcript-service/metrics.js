const client = require("prom-client");

// Adds Prometheus metrics to an Express app:
//  - default Node process metrics (CPU, memory, event-loop lag)
//  - http_request_duration_seconds histogram per method/route/status
//  - GET /metrics for Prometheus to scrape (not routed by Traefik, so it is
//    only reachable inside portal-net)
// Call before registering routes so every request is timed.
function setupMetrics(app, serviceName) {
  const register = new client.Registry();
  register.setDefaultLabels({ service: serviceName });
  client.collectDefaultMetrics({ register });

  const httpDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
  });

  app.use((req, res, next) => {
    if (req.path === "/metrics") return next();
    const end = httpDuration.startTimer();
    res.on("finish", () => {
      // Label by route pattern (/student/profile/:id), never the raw URL,
      // so each student id doesn't create a new time series.
      const route = req.route ? req.baseUrl + req.route.path : "other";
      end({ method: req.method, route, status_code: res.statusCode });
    });
    next();
  });

  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });
}

module.exports = { setupMetrics };
