const express = require("express");
const prisma = require("../config/prismaClient");
const { stkPush } = require("../config/mpesa");
const { findByPrice } = require("../config/packages");
const { normalizePhone, normalizeMac } = require("../utils/validators");
const { newTransactionId } = require("../utils/security");

const router = express.Router();

// Customers only ever see pending / completed / failed.
const publicStatus = (status) => (status === "completed" || status === "failed" ? status : "pending");

// Start a payment: validates everything server-side, saves a pending payment, sends the STK Push.
router.post("/payments/initiate", async (req, res) => {
  try {
    const { phone, amount, macAddress } = req.body || {};

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ success: false, error: "Invalid phone number. Use 07XXXXXXXX or 01XXXXXXXX." });
    }
    const mac = normalizeMac(macAddress);
    if (!mac) {
      return res.status(400).json({
        success: false,
        error: "Your device could not be identified. Reconnect to the WiFi and open the portal again.",
      });
    }
    // The price decides the package. Anything that is not an exact package price is refused.
    const pkg = findByPrice(amount);
    if (!pkg) {
      return res.status(400).json({ success: false, error: "Invalid package selected" });
    }

    const blocked = await prisma.user.findFirst({
      where: { status: "blocked", OR: [{ phone: normalizedPhone }, { macAddress: mac }] },
      select: { id: true },
    });
    if (blocked) {
      return res.status(403).json({ success: false, error: "This account has been blocked. Please contact support." });
    }

    // Do not let anyone spam a phone with prompts.
    const recentPending = await prisma.payment.count({
      where: { phone: normalizedPhone, status: "pending", timePurchased: { gt: new Date(Date.now() - 90 * 1000) } },
    });
    if (recentPending > 0) {
      return res.status(429).json({
        success: false,
        error: "A payment prompt was just sent to this number. Please complete it or wait a minute.",
      });
    }

    const transactionId = newTransactionId();
    const payment = await prisma.payment.create({
      data: {
        phone: normalizedPhone,
        amount: pkg.price,
        packageKey: pkg.key,
        durationMinutes: pkg.durationMinutes,
        transactionId,
        macAddress: mac,
        status: "pending",
      },
    });

    const mpesa = await stkPush(normalizedPhone, pkg.price, transactionId);
    if (!mpesa || !mpesa.CheckoutRequestID) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "failed" } });
      return res.status(502).json({ success: false, error: "Could not send the M-Pesa prompt. Please try again." });
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: { checkoutRequestId: mpesa.CheckoutRequestID },
    });

    return res.json({
      success: true,
      data: { transactionId, mpesaRef: mpesa.CheckoutRequestID, status: "pending", expiresAt: null },
      message: "STK Push sent! Enter your M-Pesa PIN on your phone.",
    });
  } catch (error) {
    console.error("/payments/initiate error:", error);
    return res.status(500).json({ success: false, error: "Failed to initiate payment" });
  }
});

// The portal polls this while the customer enters their PIN.
router.get("/payments/status/:transactionId", async (req, res) => {
  try {
    const payment = await prisma.payment.findUnique({
      where: { transactionId: req.params.transactionId },
      select: { status: true, mpesaReceipt: true, checkoutRequestId: true, expiresAt: true },
    });
    if (!payment) {
      return res.status(404).json({ success: false, error: "Payment not found" });
    }
    return res.json({
      success: true,
      data: {
        status: publicStatus(payment.status),
        mpesaRef: payment.mpesaReceipt || payment.checkoutRequestId,
        expiresAt: payment.expiresAt,
      },
    });
  } catch (error) {
    console.error("/payments/status error:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch payment status" });
  }
});

module.exports = router;
