require("dotenv").config();

const bool = (value, fallback = false) =>
  value === undefined ? fallback : String(value).toLowerCase() === "true";

const list = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 5000),
  frontendOrigin:
    process.env.FRONTEND_ORIGIN || process.env.NEXT_PUBLIC_APP_ORIGIN || "http://localhost:3000",
  jwtSecret: process.env.JWT_SECRET,

  mpesa: {
    env: process.env.MPESA_ENV || "sandbox", // "sandbox" | "production"
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE,
    passkey: process.env.MPESA_PASSKEY,
    // Public base URL of this backend, e.g. https://api.example.com
    callbackBaseUrl: (process.env.MPESA_CALLBACK_BASE_URL || "").replace(/\/+$/, ""),
    // Random secret that becomes part of the callback path. Safaricom does not sign callbacks,
    // so this is what stops anyone else from posting fake "payment successful" requests.
    callbackSecret: process.env.MPESA_CALLBACK_SECRET,
    // Optional extra layer: only accept callbacks from these IPs (comma separated)
    callbackAllowedIps: list(process.env.MPESA_CALLBACK_ALLOWED_IPS),
  },

  mikrotik: {
    enabled: bool(process.env.MIKROTIK_ENABLED, false),
    host: process.env.MIKROTIK_HOST,
    user: process.env.MIKROTIK_USER,
    password: process.env.MIKROTIK_PASSWORD,
    port: Number(process.env.MIKROTIK_PORT || 8728),
  },

  // How often to remove expired customers from the router and retry failed activations
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_SECONDS || 60) * 1000,
  // Allow server-side ARP lookup of a device MAC (only works when the server is on the hotspot LAN)
  enableArpLookup: bool(process.env.ENABLE_ARP_LOOKUP, false),
};

function validate() {
  const problems = [];
  const required = {
    JWT_SECRET: config.jwtSecret,
    DATABASE_URL: process.env.DATABASE_URL,
    MPESA_CONSUMER_KEY: config.mpesa.consumerKey,
    MPESA_CONSUMER_SECRET: config.mpesa.consumerSecret,
    MPESA_SHORTCODE: config.mpesa.shortcode,
    MPESA_PASSKEY: config.mpesa.passkey,
    MPESA_CALLBACK_BASE_URL: config.mpesa.callbackBaseUrl,
    MPESA_CALLBACK_SECRET: config.mpesa.callbackSecret,
  };
  for (const [name, value] of Object.entries(required)) {
    if (!value) problems.push(`Missing environment variable: ${name}`);
  }
  if (config.jwtSecret && config.jwtSecret.length < 32) {
    problems.push("JWT_SECRET must be at least 32 characters");
  }
  if (config.mpesa.callbackSecret && config.mpesa.callbackSecret.length < 16) {
    problems.push("MPESA_CALLBACK_SECRET must be at least 16 characters");
  }
  if (config.mikrotik.enabled) {
    for (const name of ["MIKROTIK_HOST", "MIKROTIK_USER", "MIKROTIK_PASSWORD"]) {
      if (!process.env[name]) problems.push(`Missing environment variable: ${name} (MIKROTIK_ENABLED=true)`);
    }
  }
  return problems;
}

module.exports = { config, validate };
