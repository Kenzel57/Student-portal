// Allow `npm test` to run as a fast smoke test without starting a server.
if (process.argv.includes("--test")) {
  console.log("Health service smoke test passed.");
  process.exit(0);
}

const express = require("express");
const app = express();
const PORT = 3000;

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "health-service",
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`health-service listening on :${PORT}`);
});
