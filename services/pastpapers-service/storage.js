const Minio = require("minio");

// Private bucket: files are only reachable through this service, which
// enforces authentication and tenant scoping on every download.
const BUCKET = process.env.MINIO_BUCKET || "pastpapers";

const client = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || "minio",
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});

async function ensureBucket() {
  if (!(await client.bucketExists(BUCKET))) await client.makeBucket(BUCKET);
}

// MinIO may still be starting when this container starts.
async function ensureBucketWithRetry(attempts = 30, delayMs = 2000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await ensureBucket();
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`MinIO not ready (attempt ${i}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const putPdf = (key, buffer) =>
  client.putObject(BUCKET, key, buffer, buffer.length, { "Content-Type": "application/pdf" });

// Returns a readable stream, so downloads are piped straight through
// without loading the whole file into memory.
const getStream = (key) => client.getObject(BUCKET, key);

const remove = (key) => client.removeObject(BUCKET, key);

async function isReachable() {
  try {
    await client.bucketExists(BUCKET);
    return true;
  } catch {
    return false;
  }
}

module.exports = { ensureBucketWithRetry, putPdf, getStream, remove, isReachable, BUCKET };
