const express = require("express");
const prisma = require("../config/prismaClient");
const { config } = require("../config/env");
const { activatePayment } = require("../services/access");
const { safeEqual, cleanIp } = require("../utils/security");

const router = express.Router();

// Safaricom does not sign callbacks, so the callback URL itself carries a secret
// (MPESA_CALLBACK_SECRET). Requests without it get a plain 404, and the amount in the
// callback must match what we asked for, so a forged request cannot grant access.
router.post("/mpesa/callback/:secret", async (req, res) => {
  if (!safeEqual(req.params.secret, config.mpesa.callbackSecret)) {
    return res.status(404).json({ success: false, error: "Route not found" });
  }

  const allowed = config.mpesa.callbackAllowedIps;
  if (allowed.length && !allowed.includes(cleanIp(req.ip))) {
    console.warn(`Callback rejected from ${cleanIp(req.ip)}: not in MPESA_CALLBACK_ALLOWED_IPS`);
    return res.status(403).json({ success: false, error: "Forbidden" });
  }

  const callback = req.body && req.body.Body && req.body.Body.stkCallback;
  const checkoutId = callback && callback.CheckoutRequestID;
  if (!callback || !checkoutId) {
    return res.status(400).json({ success: false, error: "Invalid callback payload" });
  }

  const accept = () => res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const payment = await prisma.payment.findUnique({ where: { checkoutRequestId: String(checkoutId) } });
    if (!payment) {
      console.warn(`Callback for unknown CheckoutRequestID ${checkoutId}`);
      return accept();
    }

    if (Number(callback.ResultCode) !== 0) {
      await prisma.payment.updateMany({ where: { id: payment.id, status: "pending" }, data: { status: "failed" } });
      return accept();
    }

    const items = (callback.CallbackMetadata && callback.CallbackMetadata.Item) || [];
    const read = (name) => (items.find((i) => i.Name === name) || {}).Value;
    const paidAmount = Number(read("Amount"));
    const receipt = read("MpesaReceiptNumber");

    if (paidAmount !== payment.amount) {
      console.error(`Amount mismatch on ${payment.transactionId}: expected ${payment.amount}, got ${paidAmount}`);
      await prisma.payment.updateMany({
        where: { id: payment.id, status: { in: ["pending", "failed"] } },
        data: { status: "needs_review", mpesaReceipt: receipt ? String(receipt) : null },
      });
      return accept();
    }

    // Claim the payment so a repeated callback cannot activate it twice.
    // A payment we had given up on ("failed") is still honoured if the money did arrive.
    const claimed = await prisma.payment.updateMany({
      where: { id: payment.id, status: { in: ["pending", "failed"] } },
      data: { status: "processing", mpesaReceipt: receipt ? String(receipt) : null },
    });
    if (claimed.count === 0) return accept();

    const result = await activatePayment(payment.id);
    if (!result.success) {
      console.error(`Activation failed for ${payment.transactionId}: ${result.message} (will retry)`);
    }
    return accept();
  } catch (error) {
    console.error("Callback error:", error);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

module.exports = router;
