const express = require("express");
const router = express.Router();

const {
  getState,
  saveState
} = require("../controllers/stateController");

// GET: Retrieve application state
router.get("/", getState);

// PUT: Save application state
router.put("/", saveState);

module.exports = router;