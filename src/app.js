const { admin, db } = require("../../shared/firestore");
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const ordersRoutes     = require("./modules/orders/orders.routes");
const deliveriesRoutes = require("./modules/deliveries/delivery.routes");
const driversRoutes    = require("./modules/drivers/driver.routes");
const dispatchRoutes   = require("./modules/dispatch/dispatch.routes");
const batchingRoutes   = require("./modules/batching/batching.routes");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));

app.use("/api/orders", ordersRoutes);
app.use("/api/deliveries", deliveriesRoutes);
app.use("/api/drivers", driversRoutes);
app.use("/api/dispatch", dispatchRoutes);
app.use("/api/batching", batchingRoutes);

module.exports = app;

