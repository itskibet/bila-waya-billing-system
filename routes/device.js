const express = require("express");
const { execFile } = require("child_process");
const { config } = require("../config/env");
const { lookupMacByIp } = require("../config/mikrotik");
const { normalizeMac, isValidIPv4 } = require("../utils/validators");
const { cleanIp } = require("../utils/security");

const router = express.Router();

// Reads the server's ARP table. Only useful when this server sits on the same LAN as the
// customers; enable with ENABLE_ARP_LOOKUP=true. Uses execFile (no shell) with a validated IP.
function arpLookup(ip) {
  return new Promise((resolve) => {
    if (!isValidIPv4(ip)) return resolve(null);
    const args = process.platform === "win32" ? ["-a", ip] : ["-an", ip];
    execFile("arp", args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      const match = String(stdout).match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
      resolve(match ? normalizeMac(match[0]) : null);
    });
  });
}

// Finds the customer's device MAC. In order:
//  1. ?mac=  passed by the MikroTik hotspot login page (the normal setup, see hotspot/login.html)
//  2. ?ip=   looked up in the router's hotspot host table over the RouterOS API
//  3. ARP lookup of the request IP, if ENABLE_ARP_LOOKUP=true
router.get("/device/info", async (req, res) => {
  try {
    const requestIp = cleanIp(req.ip);
    const hintedIp = isValidIPv4(req.query.ip) ? req.query.ip : null;

    let mac = normalizeMac(req.query.mac);
    if (!mac && hintedIp) mac = normalizeMac(await lookupMacByIp(hintedIp));
    if (!mac && config.enableArpLookup) mac = await arpLookup(requestIp);

    if (!mac) {
      return res.status(404).json({
        success: false,
        error: "Could not detect your device. Reconnect to the WiFi and open the portal again.",
      });
    }

    return res.json({
      success: true,
      data: { macAddress: mac, ipAddress: hintedIp || requestIp, deviceId: mac },
    });
  } catch (error) {
    console.error("/device/info error:", error);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
