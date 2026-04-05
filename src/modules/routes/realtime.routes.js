const express = require("express");
const router = express.Router();

const driverLocationRoutes = require("../drivers/driver.location.routes");
const offerRoutes = require("../dispatch/offer.routes");
const dispatchQueueRoutes = require("../dispatch/dispatch.queue.routes");

// Driver GPS
router.use("/drivers", driverLocationRoutes);

// Dispatch offers + accept/decline
router.use("/dispatch", offerRoutes);

// Dispatch queue enqueue
router.use("/dispatch", dispatchQueueRoutes);

module.exports = router;
