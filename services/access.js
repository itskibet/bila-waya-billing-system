const prisma = require("../config/prismaClient");
const { whitelistMAC, revokeMAC } = require("../config/mikrotik");
const { config } = require("../config/env");

const MINUTE = 60 * 1000;
let sweeping = false;

// Turns a paid payment into working internet access:
// 1) works out when it ends (stacking on top of any time the device still has),
// 2) opens the router for that MAC, 3) records the user and marks the payment completed.
// Safe to call again for the same payment (router changes are idempotent).
async function activatePayment(paymentId) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return { success: false, message: "Payment not found" };

  const now = new Date();
  const running = await prisma.payment.findFirst({
    where: { macAddress: payment.macAddress, status: "completed", revokedAt: null, expiresAt: { gt: now } },
    orderBy: { expiresAt: "desc" },
    select: { expiresAt: true },
  });
  const start = running && running.expiresAt > now ? running.expiresAt : now;
  const expiresAt = new Date(start.getTime() + payment.durationMinutes * MINUTE);

  const router = await whitelistMAC(payment.macAddress, `${payment.packageKey} until ${expiresAt.toISOString()}`);
  if (!router.success) {
    // Customer has paid but the router refused: keep the money record and retry from the sweeper.
    await prisma.payment.update({ where: { id: paymentId }, data: { status: "provision_failed" } });
    return { success: false, message: router.message };
  }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { phone: payment.phone } });
    const user = await tx.user.upsert({
      where: { phone: payment.phone },
      create: {
        phone: payment.phone,
        macAddress: payment.macAddress,
        status: "active",
        currentPackage: payment.packageKey,
        expiresAt,
        totalSpent: payment.amount,
        sessionsCount: 1,
        lastSeen: now,
      },
      update: {
        macAddress: payment.macAddress,
        status: existing && existing.status === "blocked" ? "blocked" : "active",
        currentPackage: payment.packageKey,
        expiresAt,
        totalSpent: { increment: payment.amount },
        sessionsCount: { increment: 1 },
        lastSeen: now,
      },
    });
    await tx.payment.update({
      where: { id: paymentId },
      data: { status: "completed", expiresAt, revokedAt: null, userId: user.id },
    });
  });

  return { success: true, expiresAt };
}

// Runs every SWEEP_INTERVAL_SECONDS:
//  - retries payments that were paid but could not be activated on the router,
//  - gives up on STK prompts nobody answered,
//  - removes access for devices whose paid time has ended.
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = new Date();

    const stuck = await prisma.payment.findMany({
      where: {
        OR: [
          { status: "provision_failed" },
          { status: "processing", timePurchased: { lt: new Date(now.getTime() - 15 * MINUTE) } },
        ],
      },
      select: { id: true },
      take: 50,
    });
    for (const p of stuck) {
      try {
        await activatePayment(p.id);
      } catch (error) {
        console.error(`Retry activation failed for payment ${p.id}:`, error.message);
      }
    }

    await prisma.payment.updateMany({
      where: { status: "pending", timePurchased: { lt: new Date(now.getTime() - 30 * MINUTE) } },
      data: { status: "failed" },
    });

    const ended = await prisma.payment.findMany({
      where: { status: "completed", revokedAt: null, expiresAt: { lte: now } },
      select: { id: true, macAddress: true },
    });
    const byMac = new Map();
    for (const p of ended) {
      if (!byMac.has(p.macAddress)) byMac.set(p.macAddress, []);
      byMac.get(p.macAddress).push(p.id);
    }

    for (const [mac, ids] of byMac) {
      const stillPaid = await prisma.payment.findFirst({
        where: { macAddress: mac, status: "completed", revokedAt: null, expiresAt: { gt: now } },
        select: { id: true },
      });
      if (!stillPaid) {
        const result = await revokeMAC(mac);
        if (!result.success) continue; // router unreachable: try again next sweep
        await prisma.user.updateMany({ where: { macAddress: mac, status: "active" }, data: { status: "expired" } });
      }
      await prisma.payment.updateMany({ where: { id: { in: ids } }, data: { revokedAt: now } });
    }
  } catch (error) {
    console.error("Sweep error:", error);
  } finally {
    sweeping = false;
  }
}

function startSweeper() {
  sweep();
  return setInterval(sweep, config.sweepIntervalMs);
}

module.exports = { activatePayment, sweep, startSweeper };
