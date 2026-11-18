const { config, validate } = require("./config/env");

const problems = validate();
if (problems.length) {
  console.error("Cannot start Bila Waya Billing System:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  console.error("\nCopy env.template to .env and fill it in.");
  process.exit(1);
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const prisma = require("./config/prismaClient");
const { isEnabled: routerEnabled } = require("./config/mikrotik");
const { startSweeper } = require("./services/access");
const { authLimiter, paymentLimiter, statusLimiter, apiLimiter } = require("./middleware/rateLimit");

const authRoutes = require("./routes/auth");
const adminRoutes = require("./routes/admin");
const deviceRoutes = require("./routes/device");
const paymentRoutes = require("./routes/payments");
const mpesaCallback = require("./routes/mpesaCallback");

const app = express();

// Needed so req.ip is the real client when running behind nginx / a load balancer
app.set("trust proxy", Number(process.env.TRUST_PROXY || 1));

app.use(helmet());
app.use(
  cors({
    origin: config.frontendOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "100kb" }));

// Rate limits
app.use("/auth/admin/login", authLimiter);
app.post("/api/payments/initiate", paymentLimiter);
app.get("/api/payments/status/:transactionId", statusLimiter);
app.use("/api", apiLimiter);

// Routes
app.use("/auth", authRoutes);
app.use("/api", paymentRoutes);
app.use("/api", deviceRoutes);
app.use("/api", adminRoutes);
app.use("/", mpesaCallback);

app.get("/", (req, res) => res.send("Bila Waya Billing System backend is running"));
app.get("/api/health", (req, res) => res.json({ success: true, status: "ok" }));

app.use((req, res) => res.status(404).json({ success: false, error: "Route not found" }));

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    error: config.nodeEnv === "production" ? "Internal server error" : err.message,
  });
});

const server = app.listen(config.port, () => {
  console.log(`Bila Waya Billing System running on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv} | M-Pesa: ${config.mpesa.env} | CORS origin: ${config.frontendOrigin}`);
  console.log(
    routerEnabled()
      ? `MikroTik: enabled (${config.mikrotik.host}:${config.mikrotik.port})`
      : "MikroTik: DISABLED (dev mode, no router changes are made)"
  );
});

const sweeper = startSweeper();

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  clearInterval(sweeper);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
