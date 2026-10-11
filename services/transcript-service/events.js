const amqp = require("amqplib");

// Topic exchange shared by every service that publishes domain events.
const EXCHANGE = "portal.events";
// Durable queue the Notification Service will consume. Declared here too so
// grade.posted events are kept (not dropped) before that service exists;
// asserting a queue is idempotent, so both services can declare it.
const NOTIFICATION_QUEUE = "notification.events";
const CONNECT_TIMEOUT_MS = 3000;

let channelPromise = null;

async function connect() {
  const conn = await amqp.connect(process.env.AMQP_URL, { timeout: CONNECT_TIMEOUT_MS });
  conn.on("error", (err) => console.error("RabbitMQ connection error:", err.message));
  // Forget the channel so the next publish reconnects.
  conn.on("close", () => {
    channelPromise = null;
  });

  // A confirm channel lets publish() wait until the broker has the message.
  const channel = await conn.createConfirmChannel();
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  await channel.assertQueue(NOTIFICATION_QUEUE, { durable: true });
  await channel.bindQueue(NOTIFICATION_QUEUE, EXCHANGE, "grade.posted");
  return channel;
}

function getChannel() {
  if (!channelPromise) {
    channelPromise = connect().catch((err) => {
      channelPromise = null;
      throw err;
    });
  }
  return channelPromise;
}

// Publishes a persistent JSON event; resolves once RabbitMQ confirms it.
async function publish(routingKey, payload) {
  const channel = await getChannel();
  const body = Buffer.from(JSON.stringify(payload));
  await new Promise((resolve, reject) => {
    channel.publish(
      EXCHANGE,
      routingKey,
      body,
      {
        persistent: true,
        contentType: "application/json",
        type: routingKey,
        messageId: payload.eventId,
        timestamp: Math.floor(Date.now() / 1000),
      },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function isConnected() {
  try {
    await getChannel();
    return true;
  } catch {
    return false;
  }
}

async function close() {
  if (!channelPromise) return;
  const channel = await channelPromise.catch(() => null);
  if (channel) await channel.connection.close().catch(() => {});
}

module.exports = { publish, isConnected, close, EXCHANGE, NOTIFICATION_QUEUE };
