const express = require("express");
const { admin, db } = require("../../shared/firestore");
const router = express.Router();

router.get("/ping", (_, res) => {
  res.json({ ok: true, module: "deliveries" });
});

module.exports = router;

