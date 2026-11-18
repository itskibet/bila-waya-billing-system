const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePhone, normalizeMac, isValidIPv4 } = require("../utils/validators");
const { safeEqual, cleanIp } = require("../utils/security");
const { findByPrice } = require("../config/packages");

test("normalizePhone accepts common Kenyan formats", () => {
  assert.equal(normalizePhone("0712345678"), "254712345678");
  assert.equal(normalizePhone("0112345678"), "254112345678");
  assert.equal(normalizePhone("+254712345678"), "254712345678");
  assert.equal(normalizePhone("254 712 345 678"), "254712345678");
});

test("normalizePhone rejects bad input", () => {
  for (const bad of ["", "12345", "0812345678", "25471234567", "+2547123456789", null, undefined, 712345678]) {
    assert.equal(normalizePhone(bad), null, String(bad));
  }
});

test("normalizeMac normalises and rejects", () => {
  assert.equal(normalizeMac("aa-bb-cc-dd-ee-ff"), "AA:BB:CC:DD:EE:FF");
  assert.equal(normalizeMac("AABBCCDDEEFF"), "AA:BB:CC:DD:EE:FF");
  assert.equal(normalizeMac("MAC_NOT_FOUND"), null);
  assert.equal(normalizeMac("AA:BB:CC:DD:EE"), null);
  assert.equal(normalizeMac("AA:BB:CC:DD:EE:GG; rm -rf /"), null);
  assert.equal(normalizeMac(undefined), null);
});

test("isValidIPv4", () => {
  assert.equal(isValidIPv4("192.168.88.254"), true);
  assert.equal(isValidIPv4("256.1.1.1"), false);
  assert.equal(isValidIPv4("1.1.1.1; ls"), false);
});

test("packages are matched by exact price only", () => {
  assert.equal(findByPrice(10).key, "1hr");
  assert.equal(findByPrice("30").key, "24hr");
  assert.equal(findByPrice(1), null);
  assert.equal(findByPrice(0), null);
  assert.equal(findByPrice("abc"), null);
});

test("safeEqual and cleanIp", () => {
  assert.equal(safeEqual("secret-123", "secret-123"), true);
  assert.equal(safeEqual("secret-123", "secret-124"), false);
  assert.equal(safeEqual("short", "a-much-longer-value"), false);
  assert.equal(cleanIp("::ffff:196.201.214.200"), "196.201.214.200");
});
