// The only source of truth for what can be bought. The server never trusts a price,
// package or duration sent by the browser: it looks the package up here.
const PACKAGES = [
  { key: "1hr", label: "1 Hour", price: 10, durationMinutes: 60, speed: "2 Mbps" },
  { key: "4hr", label: "4 Hours", price: 15, durationMinutes: 240, speed: "3 Mbps" },
  { key: "12hr", label: "12 Hours", price: 20, durationMinutes: 720, speed: "4 Mbps" },
  { key: "24hr", label: "24 Hours", price: 30, durationMinutes: 1440, speed: "5 Mbps" },
];

const findByPrice = (amount) => PACKAGES.find((p) => p.price === Number(amount)) || null;
const findByKey = (key) => PACKAGES.find((p) => p.key === key) || null;

module.exports = { PACKAGES, findByPrice, findByKey };
