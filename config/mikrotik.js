const { RouterOSAPI } = require("node-routeros");
const { config } = require("./env");

// Everything this system adds to the router is tagged with this prefix in the comment field,
// so we only ever remove bindings we created (never ones you added by hand).
const TAG = "BilaWaya";

const enabled = () =>
  config.mikrotik.enabled && config.mikrotik.host && config.mikrotik.user && config.mikrotik.password;

async function withRouter(fn) {
  const conn = new RouterOSAPI({
    host: config.mikrotik.host,
    user: config.mikrotik.user,
    password: config.mikrotik.password,
    port: config.mikrotik.port,
    timeout: 8, // seconds
  });
  await conn.connect();
  try {
    return await fn(conn);
  } finally {
    try {
      await conn.close();
    } catch (_) {
      /* ignore close errors */
    }
  }
}

const fail = (label, error) => {
  console.error(`MikroTik ${label} error:`, error);
  return { success: false, message: (error && error.message) || String(error) };
};

async function removeOurBindings(conn, mac) {
  const bindings = await conn.write(["/ip/hotspot/ip-binding/print", `?mac-address=${mac}`]);
  for (const b of bindings || []) {
    if (b[".id"] && String(b.comment || "").startsWith(TAG)) {
      await conn.write(["/ip/hotspot/ip-binding/remove", `=.id=${b[".id"]}`]);
    }
  }
}

async function kick(conn, mac) {
  const query = mac ? [`?mac-address=${mac}`] : [];
  for (const menu of ["active", "host"]) {
    const rows = await conn.write([`/ip/hotspot/${menu}/print`, ...query]);
    for (const r of rows || []) {
      if (r[".id"]) await conn.write([`/ip/hotspot/${menu}/remove`, `=.id=${r[".id"]}`]);
    }
  }
}

// Gives a device internet access (bypasses the hotspot login). Safe to call repeatedly.
async function whitelistMAC(mac, label) {
  if (!mac) return { success: false, message: "No MAC provided" };
  if (!enabled()) return { success: true, message: `Dev mode: whitelisted ${mac} (${label})` };
  try {
    await withRouter(async (conn) => {
      await removeOurBindings(conn, mac);
      await conn.write([
        "/ip/hotspot/ip-binding/add",
        `=mac-address=${mac}`,
        "=type=bypassed",
        `=comment=${TAG} ${label}`,
      ]);
    });
    return { success: true, message: `Whitelisted ${mac} (${label})` };
  } catch (error) {
    return fail("whitelist", error);
  }
}

// Removes a device's paid access and kicks it off the network.
async function revokeMAC(mac) {
  if (!mac) return { success: false, message: "No MAC provided" };
  if (!enabled()) return { success: true, message: `Dev mode: revoked ${mac}` };
  try {
    await withRouter(async (conn) => {
      await removeOurBindings(conn, mac);
      await kick(conn, mac);
    });
    return { success: true, message: `Revoked ${mac}` };
  } catch (error) {
    return fail("revoke", error);
  }
}

// Drops a device's current connection without removing its paid access.
async function disconnectByMac(mac) {
  if (!enabled()) return { success: true, message: `Dev mode: disconnected ${mac}` };
  try {
    await withRouter((conn) => kick(conn, mac));
    return { success: true, message: `Disconnected ${mac}` };
  } catch (error) {
    return fail("disconnect", error);
  }
}

async function disconnectAllUsers() {
  if (!enabled()) return { success: true, message: "Dev mode: disconnected all users" };
  try {
    await withRouter((conn) => kick(conn, null));
    return { success: true, message: "Disconnected all devices" };
  } catch (error) {
    return fail("disconnect all", error);
  }
}

async function getActiveDevices() {
  if (!enabled()) return { success: true, data: [] };
  try {
    const hosts = await withRouter((conn) => conn.write(["/ip/hotspot/host/print"]));
    const data = (hosts || []).map((h) => ({
      macAddress: h["mac-address"],
      ipAddress: h.address,
      user: h.user || null,
      uptime: h.uptime,
      bypassed: h.bypassed === "true",
      authorized: h.authorized === "true",
    }));
    return { success: true, data };
  } catch (error) {
    return { success: false, error: fail("get devices", error).message };
  }
}

async function getStatus() {
  if (!enabled()) return { success: true, data: { status: "dev", uptime: 0, connectedUsers: 0 } };
  const devices = await getActiveDevices();
  if (!devices.success) return devices;
  const connected = devices.data.filter((d) => d.bypassed || d.authorized).length;
  return { success: true, data: { status: "ok", uptime: 0, connectedUsers: connected } };
}

// Asks the router which MAC a hotspot client IP belongs to. Works even when this server
// is not on the same LAN as the customers, as long as it can reach the router's API.
async function lookupMacByIp(ip) {
  if (!enabled()) return null;
  try {
    const hosts = await withRouter((conn) => conn.write(["/ip/hotspot/host/print", `?address=${ip}`]));
    return (hosts && hosts[0] && hosts[0]["mac-address"]) || null;
  } catch (error) {
    fail("lookup mac", error);
    return null;
  }
}

module.exports = {
  whitelistMAC,
  revokeMAC,
  disconnectByMac,
  disconnectAllUsers,
  getActiveDevices,
  getStatus,
  lookupMacByIp,
  isEnabled: enabled,
};
