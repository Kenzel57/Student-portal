const { TEMPLATES, escapeHtml } = require("./templates");

const EXCHANGE = "portal.events";
const QUEUE = process.env.NOTIFICATION_QUEUE || "notification.events";
const FAILED_QUEUE = "notification.failed";
const ROUTING_KEYS = ["grade.posted", "pastpaper.uploaded"];
const RETRY_DELAYS_MS = [1000, 3000, 9000];
const SMTP_RETRY_MS = 60000;
const RECONNECT_MS = 5000;
const DEDUPE_SIZE = 1000;

// Allow `npm test` to run as a fast smoke test without connecting anywhere.
if (process.argv.includes("--test")) {
  const mail = TEMPLATES["grade.posted"]({ courseCode: "SWE301", courseTitle: "<b>x</b>", semester: "S1", studentEmail: "a@b.c" });
  if (mail.to !== "a@b.c" || mail.html.includes("<b>x</b>")) throw new Error("grade template failed");
  if (TEMPLATES["pastpaper.uploaded"]({ course: "MAT201", year: 2024, semester: "S1", tags: [] }).to !== null) throw new Error("paper template failed");
  if (escapeHtml("<") !== "&lt;") throw new Error("escapeHtml failed");
  console.log("Notification service smoke test passed.");
  process.exit(0);
}

const amqp = require("amqplib");
const nodemailer = require("nodemailer");

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
const MAIL_FROM = process.env.MAIL_FROM || `"Student Portal" <${GMAIL_USER}>`;
// Dev safety: when set, every email goes to this inbox instead of the real
// recipient (demo data uses made-up addresses). The intended recipient is
// shown in the subject.
const REDIRECT_TO = process.env.NOTIFICATION_REDIRECT_TO || "";

// Gmail on 587: plain connection upgraded to TLS with STARTTLS (secure: false).
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: GMAIL_USER ? { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } : undefined,
});

// Recently handled eventIds, so a redelivered message doesn't email twice.
// In memory only; a Redis set would survive restarts (post-deadline).
const seen = new Set();
function remember(eventId) {
  if (!eventId) return;
  seen.add(eventId);
  if (seen.size > DEDUPE_SIZE) seen.delete(seen.values().next().value);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poison-message handling: park the message in notification.failed with the
// reason attached, then ack it so it can't block the queue forever.
function deadLetter(channel, msg, reason) {
  console.error(`-> ${FAILED_QUEUE}: ${msg.fields.routingKey} (${reason})`);
  channel.sendToQueue(FAILED_QUEUE, msg.content, {
    persistent: true,
    contentType: msg.properties.contentType,
    messageId: msg.properties.messageId,
    headers: { ...msg.properties.headers, "x-error": String(reason).slice(0, 500), "x-routing-key": msg.fields.routingKey },
  });
  channel.ack(msg);
}

async function handle(channel, msg) {
  const routingKey = msg.fields.routingKey;
  let event;
  try {
    event = JSON.parse(msg.content.toString());
  } catch {
    return deadLetter(channel, msg, "invalid JSON");
  }
  if (event.eventId && seen.has(event.eventId)) {
    console.log(`skip duplicate ${routingKey} ${event.eventId}`);
    return channel.ack(msg);
  }
  const template = TEMPLATES[routingKey];
  if (!template) {
    console.log(`ignore unknown event ${routingKey}`);
    return channel.ack(msg);
  }

  const mail = template(event);
  const to = REDIRECT_TO || mail.to;
  if (!to) {
    console.log(`no recipient for ${routingKey} ${event.eventId}; nothing sent`);
    remember(event.eventId);
    return channel.ack(msg);
  }
  const subject = REDIRECT_TO ? `[for ${mail.to || "no address on file"}] ${mail.subject}` : mail.subject;

  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const info = await transporter.sendMail({ from: MAIL_FROM, to, subject, text: mail.text, html: mail.html });
      console.log(`sent ${routingKey} ${event.eventId} -> ${to}${REDIRECT_TO ? ` (intended: ${mail.to || "none"})` : ""} | ${info.response}`);
      remember(event.eventId);
      return channel.ack(msg);
    } catch (err) {
      lastError = err;
      console.error(`send failed (attempt ${attempt + 1}) for ${routingKey} ${event.eventId}: ${err.message}`);
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  deadLetter(channel, msg, lastError.message);
}

async function consume() {
  const conn = await amqp.connect(process.env.AMQP_URL);
  conn.on("error", (err) => console.error("RabbitMQ connection error:", err.message));
  conn.on("close", () => {
    console.error(`RabbitMQ connection closed; reconnecting in ${RECONNECT_MS / 1000}s`);
    setTimeout(() => consume().catch(onConsumeError), RECONNECT_MS);
  });

  const channel = await conn.createChannel();
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  await channel.assertQueue(QUEUE, { durable: true });
  for (const key of ROUTING_KEYS) await channel.bindQueue(QUEUE, EXCHANGE, key);
  await channel.assertQueue(FAILED_QUEUE, { durable: true });
  // At most 5 unacknowledged messages at once; each is acked only after the
  // email is accepted, so a crash mid-send means redelivery, not loss.
  await channel.prefetch(5);
  await channel.consume(QUEUE, (msg) => {
    if (msg) handle(channel, msg).catch((err) => console.error("handler error:", err));
  });
  console.log(`consuming ${QUEUE} (${ROUTING_KEYS.join(", ")})${REDIRECT_TO ? ` — redirecting all mail to ${REDIRECT_TO}` : ""}`);
}

function onConsumeError(err) {
  console.error(`RabbitMQ not reachable (${err.message}); retrying in ${RECONNECT_MS / 1000}s`);
  setTimeout(() => consume().catch(onConsumeError), RECONNECT_MS);
}

// Don't take messages off the queue until we can actually send email:
// events stay safely queued while SMTP is unconfigured or rejecting us.
async function waitForSmtp() {
  for (;;) {
    if (SMTP_HOST === "smtp.gmail.com" && (!GMAIL_USER || !GMAIL_APP_PASSWORD)) {
      console.error("GMAIL_USER / GMAIL_APP_PASSWORD not set — not consuming; events stay queued.");
    } else {
      try {
        await transporter.verify();
        console.log(`SMTP ready (${SMTP_HOST}${GMAIL_USER ? " as " + GMAIL_USER : ""})`);
        return;
      } catch (err) {
        console.error(`SMTP not ready (${err.message}) — not consuming; events stay queued.`);
      }
    }
    await sleep(SMTP_RETRY_MS);
  }
}

waitForSmtp()
  .then(() => consume())
  .catch(onConsumeError);

process.on("SIGTERM", () => process.exit(0));
