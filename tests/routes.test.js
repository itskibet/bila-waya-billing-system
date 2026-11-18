// Exercises the real payment + callback routes against an in-memory fake database,
// with Safaricom stubbed out. No MySQL, network or router needed.
process.env.JWT_SECRET = "x".repeat(40);
process.env.DATABASE_URL = "mysql://fake";
process.env.MPESA_CONSUMER_KEY = "k";
process.env.MPESA_CONSUMER_SECRET = "s";
process.env.MPESA_SHORTCODE = "174379";
process.env.MPESA_PASSKEY = "p";
process.env.MPESA_CALLBACK_BASE_URL = "https://api.example.com";
process.env.MPESA_CALLBACK_SECRET = "correct-horse-battery-staple";
process.env.MIKROTIK_ENABLED = "false";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

// ---- fake prisma ----
const db = { payments: [], users: [], nextId: 1 };
const matches = (row, where = {}) =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return cond.some((w) => matches(row, w));
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(row[key]);
      if ("gt" in cond) return row[key] != null && row[key] > cond.gt;
      if ("lt" in cond) return row[key] != null && row[key] < cond.lt;
      if ("lte" in cond) return row[key] != null && row[key] <= cond.lte;
    }
    return row[key] === cond;
  });
const applyData = (row, data) => {
  for (const [k, v] of Object.entries(data)) {
    row[k] = v && typeof v === "object" && "increment" in v ? (row[k] || 0) + v.increment : v;
  }
  return row;
};
const fake = {
  payment: {
    create: async ({ data }) => {
      const row = { id: db.nextId++, checkoutRequestId: null, mpesaReceipt: null, expiresAt: null, revokedAt: null, userId: null, timePurchased: new Date(), ...data };
      db.payments.push(row);
      return row;
    },
    findUnique: async ({ where }) => db.payments.find((p) => matches(p, where)) || null,
    findFirst: async ({ where }) => db.payments.find((p) => matches(p, where)) || null,
    count: async ({ where }) => db.payments.filter((p) => matches(p, where)).length,
    update: async ({ where, data }) => applyData(db.payments.find((p) => matches(p, where)), data),
    updateMany: async ({ where, data }) => {
      const rows = db.payments.filter((p) => matches(p, where));
      rows.forEach((r) => applyData(r, data));
      return { count: rows.length };
    },
  },
  user: {
    findUnique: async ({ where }) => db.users.find((u) => matches(u, where)) || null,
    findFirst: async ({ where }) => db.users.find((u) => matches(u, where)) || null,
    upsert: async ({ where, create, update }) => {
      const found = db.users.find((u) => matches(u, where));
      if (found) return applyData(found, update);
      const row = { id: db.nextId++, ...create };
      db.users.push(row);
      return row;
    },
  },
  $transaction: async (fn) => fn(fake),
};
const inject = (rel, exports) => {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
inject("../config/prismaClient", fake);
inject("../config/mpesa", {
  stkPush: async () => ({ CheckoutRequestID: "ws_CO_TEST_1", ResponseCode: "0" }),
});

const paymentRoutes = require("../routes/payments");
const callbackRoutes = require("../routes/mpesaCallback");

let server;
let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", paymentRoutes);
  app.use("/", callbackRoutes);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => {
  db.payments.length = 0;
  db.users.length = 0;
});

const post = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const callbackBody = (checkoutId, { code = 0, amount = 30 } = {}) => ({
  Body: {
    stkCallback: {
      CheckoutRequestID: checkoutId,
      ResultCode: code,
      CallbackMetadata:
        code === 0
          ? { Item: [{ Name: "Amount", Value: amount }, { Name: "MpesaReceiptNumber", Value: "TEST123ABC" }] }
          : undefined,
    },
  },
});

const MAC = "aa:bb:cc:dd:ee:ff";

async function startPayment(amount = 30, phone = "0712345678") {
  const res = await post("/api/payments/initiate", { phone, amount, macAddress: MAC });
  return { res, body: await res.json() };
}

test("initiate refuses amounts that are not an exact package price", async () => {
  for (const amount of [1, 0, 25, "abc", -30]) {
    const { res } = await startPayment(amount);
    assert.equal(res.status, 400, `amount ${amount}`);
  }
  assert.equal(db.payments.length, 0);
});

test("initiate refuses a missing or invalid MAC", async () => {
  const res = await post("/api/payments/initiate", { phone: "0712345678", amount: 30, macAddress: "MAC_NOT_FOUND" });
  assert.equal(res.status, 400);
});

test("initiate creates a pending payment priced by the server", async () => {
  const { res, body } = await startPayment(30);
  assert.equal(res.status, 200);
  assert.equal(body.data.status, "pending");
  const p = db.payments[0];
  assert.equal(p.amount, 30);
  assert.equal(p.durationMinutes, 1440);
  assert.equal(p.macAddress, "AA:BB:CC:DD:EE:FF");
  assert.equal(p.phone, "254712345678");
  assert.equal(p.checkoutRequestId, "ws_CO_TEST_1");
});

test("a second prompt to the same phone within 90s is refused", async () => {
  await startPayment(30);
  const { res } = await startPayment(30);
  assert.equal(res.status, 429);
});

test("callback with the wrong secret is rejected and grants nothing", async () => {
  await startPayment(30);
  const res = await post("/mpesa/callback/not-the-secret", callbackBody("ws_CO_TEST_1"));
  assert.equal(res.status, 404);
  assert.equal(db.payments[0].status, "pending");
  assert.equal(db.users.length, 0);
});

test("a genuine callback activates the payment and creates the user", async () => {
  await startPayment(30);
  const res = await post(`/mpesa/callback/${process.env.MPESA_CALLBACK_SECRET}`, callbackBody("ws_CO_TEST_1"));
  assert.equal(res.status, 200);
  const p = db.payments[0];
  assert.equal(p.status, "completed");
  assert.equal(p.mpesaReceipt, "TEST123ABC");
  const hours = (p.expiresAt - Date.now()) / 3600000;
  assert.ok(hours > 23.9 && hours <= 24, `expires in ${hours}h`);
  assert.equal(db.users.length, 1);
  assert.equal(db.users[0].status, "active");
  assert.equal(db.users[0].totalSpent, 30);
});

test("the access length comes from the package, not the callback", async () => {
  await startPayment(10);
  await post(`/mpesa/callback/${process.env.MPESA_CALLBACK_SECRET}`, callbackBody("ws_CO_TEST_1", { amount: 10 }));
  const hours = (db.payments[0].expiresAt - Date.now()) / 3600000;
  assert.ok(hours > 0.9 && hours <= 1, `expires in ${hours}h`);
});

test("a callback whose amount differs from the payment is flagged, not activated", async () => {
  await startPayment(30);
  await post(`/mpesa/callback/${process.env.MPESA_CALLBACK_SECRET}`, callbackBody("ws_CO_TEST_1", { amount: 1 }));
  assert.equal(db.payments[0].status, "needs_review");
  assert.equal(db.users.length, 0);
});

test("a replayed callback does not activate twice", async () => {
  await startPayment(30);
  const url = `/mpesa/callback/${process.env.MPESA_CALLBACK_SECRET}`;
  await post(url, callbackBody("ws_CO_TEST_1"));
  await post(url, callbackBody("ws_CO_TEST_1"));
  assert.equal(db.users[0].sessionsCount, 1);
  assert.equal(db.users[0].totalSpent, 30);
});

test("a cancelled payment is marked failed", async () => {
  await startPayment(30);
  await post(`/mpesa/callback/${process.env.MPESA_CALLBACK_SECRET}`, callbackBody("ws_CO_TEST_1", { code: 1032 }));
  assert.equal(db.payments[0].status, "failed");
  assert.equal(db.users.length, 0);
});

test("buying again while time remains stacks on top of the current expiry", async () => {
  await startPayment(30);
  const url = `/mpesa/callback/${process.env.MPESA_CALLBACK_SECRET}`;
  await post(url, callbackBody("ws_CO_TEST_1"));
  const firstExpiry = db.payments[0].expiresAt;
  db.payments[0].timePurchased = new Date(Date.now() - 5 * 60 * 1000); // get past the 90s spam guard

  const second = await post("/api/payments/initiate", { phone: "0712345678", amount: 10, macAddress: MAC });
  assert.equal(second.status, 200);
  db.payments[1].checkoutRequestId = "ws_CO_TEST_2";
  await post(url, callbackBody("ws_CO_TEST_2", { amount: 10 }));
  assert.equal(db.payments[1].status, "completed");
  assert.equal(db.payments[1].expiresAt.getTime(), firstExpiry.getTime() + 60 * 60 * 1000);
  assert.equal(db.users[0].sessionsCount, 2);
});
