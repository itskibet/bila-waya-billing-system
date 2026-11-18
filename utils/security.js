const crypto = require("crypto");

// Constant-time string comparison (does not leak how many leading characters matched).
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Strips the IPv6-mapped prefix so "::ffff:196.201.214.200" matches "196.201.214.200".
function cleanIp(ip) {
  return String(ip || "").replace(/^::ffff:/, "");
}

function newTransactionId() {
  return `BW${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

module.exports = { safeEqual, cleanIp, newTransactionId };
