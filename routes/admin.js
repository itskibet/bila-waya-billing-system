const express = require("express");
const prisma = require("../config/prismaClient");
const authMiddleware = require("../middleware/authMiddleware");
const { supportLimiter } = require("../middleware/rateLimit");
const { PACKAGES } = require("../config/packages");
const {
  whitelistMAC,
  revokeMAC,
  disconnectByMac,
  disconnectAllUsers,
  getActiveDevices,
  getStatus,
} = require("../config/mikrotik");

const router = express.Router();

const packageLabel = (key) => (PACKAGES.find((p) => p.key === key) || {}).label || key || "";

function paging(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
  return { page, limit, skip: (page - 1) * limit };
}

const toTransaction = (p) => ({
  id: p.transactionId,
  phone: p.phone,
  amount: p.amount,
  package: packageLabel(p.packageKey),
  status: p.status,
  timestamp: p.timePurchased,
  mpesaRef: p.mpesaReceipt || p.checkoutRequestId || "",
  mpesaReceipt: p.mpesaReceipt || undefined,
});

// ---------- Dashboard ----------

router.get("/admin/summary", authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const completed = { status: "completed" };

    const [totalUsers, activeUsers, blockedUsers, revenue, todayRevenue, doneCount, failedCount, pending, attention] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { status: "active", expiresAt: { gt: now } } }),
        prisma.user.count({ where: { status: "blocked" } }),
        prisma.payment.aggregate({ where: completed, _sum: { amount: true } }),
        prisma.payment.aggregate({ where: { ...completed, timePurchased: { gte: startOfDay } }, _sum: { amount: true } }),
        prisma.payment.count({ where: completed }),
        prisma.payment.count({ where: { status: "failed" } }),
        prisma.payment.count({ where: { status: "pending" } }),
        prisma.payment.count({ where: { status: { in: ["processing", "provision_failed", "needs_review"] } } }),
      ]);

    const finished = doneCount + failedCount;
    return res.json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        blockedUsers,
        totalRevenue: revenue._sum.amount || 0,
        todayRevenue: todayRevenue._sum.amount || 0,
        successRate: finished ? Math.round((doneCount / finished) * 100) : 0,
        pendingPayments: pending,
        needsAttention: attention,
      },
    });
  } catch (error) {
    console.error("/admin/summary error:", error);
    return res.status(500).json({ success: false, error: "Failed to load summary" });
  }
});

router.get("/admin/payments", authMiddleware, async (req, res) => {
  try {
    const payments = await prisma.payment.findMany({ orderBy: { timePurchased: "desc" }, take: 200 });
    return res.json({ success: true, data: payments.map(toTransaction) });
  } catch (error) {
    console.error("/admin/payments error:", error);
    return res.status(500).json({ success: false, error: "Failed to load payments" });
  }
});

// ---------- Users ----------

router.get("/users", authMiddleware, async (req, res) => {
  try {
    const { search = "", status = "all" } = req.query;
    const { page, limit, skip } = paging(req.query);
    const where = {};
    if (search) where.phone = { contains: String(search) };
    if (status !== "all") where.status = String(status);

    const [users, total] = await Promise.all([
      prisma.user.findMany({ where, skip, take: limit, orderBy: { id: "desc" } }),
      prisma.user.count({ where }),
    ]);
    return res.json({
      success: true,
      data: { users, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    console.error("/users error:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch users" });
  }
});

async function findUser(req, res) {
  const id = parseInt(req.params.id, 10);
  const user = Number.isInteger(id) ? await prisma.user.findUnique({ where: { id } }) : null;
  if (!user) res.status(404).json({ success: false, error: "User not found" });
  return user;
}

router.get("/users/:id", authMiddleware, async (req, res) => {
  try {
    const user = await findUser(req, res);
    if (!user) return;
    const payments = await prisma.payment.findMany({
      where: { userId: user.id },
      orderBy: { timePurchased: "desc" },
      take: 100,
    });
    return res.json({ success: true, data: { ...user, transactions: payments.map(toTransaction) } });
  } catch (error) {
    console.error("/users/:id error:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch user" });
  }
});

// Blocking removes the device from the router and stops the number paying again.
router.post("/users/:id/block", authMiddleware, async (req, res) => {
  try {
    const user = await findUser(req, res);
    if (!user) return;
    const router_ = await revokeMAC(user.macAddress);
    if (!router_.success) {
      return res.status(502).json({ success: false, error: `Router update failed: ${router_.message}` });
    }
    await prisma.user.update({ where: { id: user.id }, data: { status: "blocked" } });
    return res.json({ success: true });
  } catch (error) {
    console.error("block error:", error);
    return res.status(500).json({ success: false, error: "Failed to block user" });
  }
});

// Unblocking restores access if the user still has paid time left.
router.post("/users/:id/unblock", authMiddleware, async (req, res) => {
  try {
    const user = await findUser(req, res);
    if (!user) return;
    const hasTimeLeft = user.expiresAt && user.expiresAt > new Date();
    if (hasTimeLeft) {
      const router_ = await whitelistMAC(user.macAddress, `restored until ${user.expiresAt.toISOString()}`);
      if (!router_.success) {
        return res.status(502).json({ success: false, error: `Router update failed: ${router_.message}` });
      }
    }
    await prisma.user.update({ where: { id: user.id }, data: { status: hasTimeLeft ? "active" : "expired" } });
    return res.json({ success: true });
  } catch (error) {
    console.error("unblock error:", error);
    return res.status(500).json({ success: false, error: "Failed to unblock user" });
  }
});

// Drops the device's current connection; it keeps any paid time and can reconnect.
router.post("/users/:id/disconnect", authMiddleware, async (req, res) => {
  try {
    const user = await findUser(req, res);
    if (!user) return;
    const result = await disconnectByMac(user.macAddress);
    return res.json({ success: result.success, message: result.message });
  } catch (error) {
    console.error("disconnect error:", error);
    return res.status(500).json({ success: false, error: "Failed to disconnect user" });
  }
});

router.delete("/users/:id", authMiddleware, async (req, res) => {
  try {
    const user = await findUser(req, res);
    if (!user) return;
    const router_ = await revokeMAC(user.macAddress);
    if (!router_.success) {
      return res.status(502).json({ success: false, error: `Router update failed: ${router_.message}` });
    }
    // Payment records are kept for accounting; they just lose the link to the user.
    await prisma.$transaction([
      prisma.payment.updateMany({ where: { userId: user.id }, data: { userId: null } }),
      prisma.user.delete({ where: { id: user.id } }),
    ]);
    return res.json({ success: true });
  } catch (error) {
    console.error("delete user error:", error);
    return res.status(500).json({ success: false, error: "Failed to delete user" });
  }
});

// ---------- Transactions ----------

router.get("/transactions", authMiddleware, async (req, res) => {
  try {
    const { search = "", status = "all", startDate = null, endDate = null } = req.query;
    const { page, limit, skip } = paging(req.query);

    const where = {};
    if (status !== "all") where.status = String(status);
    if (startDate || endDate) {
      where.timePurchased = {};
      if (startDate) where.timePurchased.gte = new Date(String(startDate));
      if (endDate) where.timePurchased.lte = new Date(String(endDate));
    }
    if (search) {
      const q = String(search);
      where.OR = [
        { phone: { contains: q } },
        { transactionId: { contains: q } },
        { mpesaReceipt: { contains: q } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.payment.findMany({ where, skip, take: limit, orderBy: { timePurchased: "desc" } }),
      prisma.payment.count({ where }),
    ]);
    return res.json({
      success: true,
      data: {
        transactions: rows.map(toTransaction),
        total,
        page,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error("/transactions error:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch transactions" });
  }
});

// Refunds go through Safaricom's Reversal API, which needs extra credentials. Not built yet.
router.post("/transactions/:transactionId/refund", authMiddleware, (req, res) =>
  res.status(501).json({ success: false, error: "Refunds are not implemented yet" })
);

router.get("/transactions/:transactionId/receipt", authMiddleware, (req, res) =>
  res.status(501).json({ success: false, error: "Receipts are not implemented yet" })
);

// ---------- Support ----------

router.post("/support/contact", supportLimiter, async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body || {};
    if (typeof message !== "string" || message.trim().length < 5) {
      return res.status(400).json({ success: false, error: "Please enter a message" });
    }
    const clip = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
    await prisma.supportRequest.create({
      data: {
        name: clip(name, 100),
        email: clip(email, 150),
        phone: clip(phone, 20) || "",
        subject: clip(subject, 150),
        message: message.trim().slice(0, 2000),
      },
    });
    return res.json({ success: true });
  } catch (error) {
    console.error("/support/contact error:", error);
    return res.status(500).json({ success: false, error: "Failed to send message" });
  }
});

router.get("/support/requests", authMiddleware, async (req, res) => {
  try {
    const { page, limit, skip } = paging(req.query);
    const where = req.query.status ? { status: String(req.query.status) } : {};
    const [requests, total] = await Promise.all([
      prisma.supportRequest.findMany({ where, skip, take: limit, orderBy: { createdAt: "desc" } }),
      prisma.supportRequest.count({ where }),
    ]);
    return res.json({
      success: true,
      data: { requests, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    console.error("/support/requests error:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch requests" });
  }
});

// ---------- Network (MikroTik) ----------

router.get("/network/devices", authMiddleware, async (req, res) => {
  const resp = await getActiveDevices();
  if (!resp.success) return res.status(502).json({ success: false, error: resp.error });
  return res.json({ success: true, data: resp.data });
});

router.post("/network/disconnect-all", authMiddleware, async (req, res) => {
  const resp = await disconnectAllUsers();
  return res.status(resp.success ? 200 : 502).json({ success: resp.success, message: resp.message });
});

router.get("/network/status", authMiddleware, async (req, res) => {
  const resp = await getStatus();
  if (!resp.success) return res.status(502).json({ success: false, error: resp.error });
  return res.json({ success: true, data: resp.data });
});

module.exports = router;
