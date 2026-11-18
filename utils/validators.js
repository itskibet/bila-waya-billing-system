// Normalises Kenyan Safaricom numbers to 2547XXXXXXXX / 2541XXXXXXXX.
// Accepts 07XXXXXXXX, 01XXXXXXXX, +254..., 254...
function normalizePhone(input) {
  if (typeof input !== "string") return null;
  let p = input.replace(/[\s-]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (/^0[17]\d{8}$/.test(p)) p = "254" + p.slice(1);
  return /^254[17]\d{8}$/.test(p) ? p : null;
}

// Returns an upper-case, colon separated MAC (AA:BB:CC:DD:EE:FF) or null.
function normalizeMac(input) {
  if (typeof input !== "string") return null;
  const hex = input.trim().replace(/[:-]/g, "").toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex)) return null;
  return hex.match(/.{2}/g).join(":");
}

function isValidIPv4(ip) {
  return (
    typeof ip === "string" &&
    /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(ip)
  );
}

module.exports = { normalizePhone, normalizeMac, isValidIPv4 };
