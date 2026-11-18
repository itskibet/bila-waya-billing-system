const rateLimit = require("express-rate-limit");
const { normalizePhone } = require("../utils/validators");

// Customers on one hotspot usually share a single public IP, so these limits are deliberately
// generous per IP, and payment limiting is keyed on the phone number instead.

// Admin login: 5 failed attempts per 15 minutes per IP (successful logins are not counted)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, error: "Too many login attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Payment prompts: 3 per minute per phone number (falls back to IP if the number is invalid)
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  keyGenerator: (req) => normalizePhone(req.body && req.body.phone) || req.ip,
  message: { success: false, error: "Too many payment requests, please try again in a minute." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
});

// The portal polls payment status every few seconds, so it gets its own roomy limit
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: { success: false, error: "Too many requests, please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Contact form: stops someone filling the support inbox
const supportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { success: false, error: "Too many messages, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Everything else under /api (the payment status poll is excluded, it has its own limiter)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  skip: (req) => req.path.startsWith("/payments/status"),
  message: { success: false, error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { authLimiter, paymentLimiter, statusLimiter, supportLimiter, apiLimiter };
