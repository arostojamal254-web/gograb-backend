const http = require("http");
const url = require("url");
const WebSocket = require("ws");
const redis = require("../shared/redis");

function inboxKey(driverId) {
  return `offer:driver:${String(driverId)}:inbox`;
}

const PORT = Number(process.env.WS_PORT || 8090);

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("WS Gateway OK\n");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", async (ws, req) => {
  const q = url.parse(req.url, true).query || {};
  const driverId = String(q.driverId || "").trim();

  if (!driverId) {
    ws.send(JSON.stringify({ type: "ERROR", error: "driverId required in querystring" }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ type: "CONNECTED", driverId }));

  console.log(`[ws] connected driverId=${driverId}`);

  let closed = false;
  ws.on("close", () => {
    closed = true;
    console.log(`[ws] closed driverId=${driverId}`);
  });

  ws.on("error", (e) => {
    console.log(`[ws] error driverId=${driverId}:`, e?.message || e);
  });

  // Main loop: BRPOP blocks until an orderId arrives in driver's inbox
  // NOTE: this uses your existing Redis list offers: offer:driver:<id>:inbox
  const key = inboxKey(driverId);

  while (!closed) {
    try {
      // BRPOP key timeoutSeconds
      // timeout 0 = block forever
      const resp = await redis.call("BRPOP", key, "0");
      if (!resp || resp.length < 2) continue;

      const orderId = String(resp[1] || "");
      if (!orderId) continue;

      // Push offer to driver
      const msg = {
        type: "RIDE_OFFER",
        orderId,
        receivedAt: new Date().toISOString(),
      };

      ws.send(JSON.stringify(msg));
      console.log(`[ws] offer pushed driverId=${driverId} orderId=${orderId}`);
    } catch (e) {
      // If redis hiccups, wait a bit then retry
      console.log(`[ws] loop error driverId=${driverId}:`, e?.message || e);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[ws] gateway listening ws://localhost:${PORT}/?driverId=DRIVER_123`);
});
