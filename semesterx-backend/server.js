require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");

const connectDB = require("./config/db");
const stateRoutes = require("./routes/stateRoutes");

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(cors({
  origin: process.env.CLIENT_URL || true
}));

// Execution Challenge API: isolated module (own body parser, own auth, own collection).
// A load failure here must never take the academic API down, so it is contained.
try {
  app.use("/api/challenge", require("./routes/challengeRoutes"));
} catch (error) {
  console.error("Execution Challenge routes failed to load:", error.message);
  app.use("/api/challenge", (req, res) => res.status(503).json({ success: false, message: "Execution Challenge is unavailable." }));
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// API routes
// API routes
app.use("/api/state", async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error("Database connection error:", error.message);

    res.status(500).json({
      success: false,
      message: "Database connection failed."
    });
  }
}, stateRoutes);

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await connectDB();

    res.status(200).json({
      success: true,
      message: "SemesterX API is running!",
      database: "Connected"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Database connection failed"
    });
  }
});

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// Local development
if (require.main === module) {
  const PORT = process.env.PORT || 5000;

  connectDB()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`SemesterX running at http://localhost:${PORT}`);
      });
    })
    .catch((error) => {
      console.error("Server startup failed:", error.message);
      process.exit(1);
    });
}

// Vercel serverless export
module.exports = app;