const WebSocket = require("ws");

const driverId = process.argv[2] || "DRIVER_123";
const port = process.argv[3] || "8090";

const ws = new WebSocket(`ws://localhost:${port}/?driverId=${encodeURIComponent(driverId)}`);

ws.on("open", () => console.log("WS OPEN", { driverId }));
ws.on("message", (data) => console.log("WS MSG:", data.toString()));
ws.on("close", () => console.log("WS CLOSED"));
ws.on("error", (e) => console.log("WS ERROR:", e?.message || e));
