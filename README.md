# Bila Waya Billing System

*Bila waya* is Swahili for "without wires". This is a WiFi billing system for hotspots in Kenya: customers connect to your WiFi, pick a package, pay with **M-Pesa STK Push**, and the system unlocks their device on your **MikroTik** router for exactly the time they paid for, then locks it again.

Built with Node.js + Express, Prisma + MySQL, and a Next.js portal and admin dashboard.

## How it works

```
Customer joins WiFi ──► MikroTik shows hotspot/login.html
        │                      (redirects to the portal with ?mac=…&ip=…)
        ▼
Portal (Next.js): customer picks a package, enters phone number
        │  POST /api/payments/initiate
        ▼
Backend: validates MAC + phone + price, saves a pending payment, sends STK Push
        │
        ▼
Customer enters M-Pesa PIN ──► Safaricom calls POST /mpesa/callback/<secret>
        │
        ▼
Backend: checks secret + amount, adds a bypass binding for the MAC on the router,
         records the user, marks the payment completed
        │
        ▼
Every minute: a sweeper removes access when the paid time ends
              and retries any payment that was paid but could not be activated
```

### What the server enforces
- **Prices come from the server** (`config/packages.js`). The browser only sends a price; anything that is not exactly a package price is refused, and the duration always comes from the package.
- **Callbacks are authenticated.** Safaricom does not sign callbacks, so the callback URL contains a secret (`MPESA_CALLBACK_SECRET`). A request without it gets a 404. The paid amount must match the payment, and a repeated callback cannot activate twice. Optionally restrict by IP too (`MPESA_CALLBACK_ALLOWED_IPS`).
- **Access expires.** Each payment has an end time. Buying again while you still have time stacks on top. Expired devices are removed from the router automatically.
- **Paid but router down?** The payment is kept as `provision_failed` and retried every sweep until it works. Nothing is lost.
- **No prompt spam.** One pending prompt per phone number at a time, and 3 per minute per number.
- Admin login with bcrypt + JWT (8h), login rate-limited, no default admin account.

## Quick start

You need Node.js 18+, MySQL, a Safaricom Daraja app, and a MikroTik router running a hotspot.

```bash
git clone https://github.com/itskibet/bila-waya-billing-system.git
cd bila-waya-billing-system
npm install

cp env.template .env       # then fill it in (see below)
npm run db:push            # creates the tables
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' npm run admin:create
npm start                  # backend on :5000
```

Frontend:

```bash
cd frontend
npm install
echo "NEXT_PUBLIC_API_URL=http://localhost:5000" > .env.local
npm run dev                # portal on :3000, admin at /admin
```

With `MIKROTIK_ENABLED=false` (the default) no router is contacted, so you can try the whole flow with the Daraja sandbox first.

### Configuration

All settings live in `.env` (see `env.template` for comments).

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | MySQL connection string |
| `JWT_SECRET` | 32+ random characters |
| `MPESA_ENV` | `sandbox` or `production` |
| `MPESA_CONSUMER_KEY` / `_SECRET` / `MPESA_SHORTCODE` / `MPESA_PASSKEY` | Daraja credentials |
| `MPESA_CALLBACK_BASE_URL` | Public HTTPS address of this backend |
| `MPESA_CALLBACK_SECRET` | 16+ random characters, part of the callback path |
| `MIKROTIK_ENABLED`, `MIKROTIK_HOST`, `_USER`, `_PASSWORD`, `_PORT` | Router API access |
| `FRONTEND_ORIGIN` | Portal address (CORS) |
| `SWEEP_INTERVAL_SECONDS` | How often expiry is enforced (default 60) |

The server refuses to start if something required is missing.

### Packages

Edit `config/packages.js` (price, duration, label). The portal's package list is in `frontend/app/page.tsx`; keep the prices in sync.

## MikroTik setup

1. **API user for the billing server** (restrict it to the server's IP):
   ```
   /user group add name=billing policy=api,read,write
   /user add name=billing group=billing password=CHANGE_ME address=<billing-server-ip>
   /ip service set api address=<billing-server-ip> disabled=no
   ```
   The API on port 8728 is not encrypted. Keep it on a private network or VPN tunnel (for example WireGuard) rather than the open internet.
2. **Hotspot login page:** upload `hotspot/login.html` to the router's `hotspot/` folder and set `PORTAL_URL` inside it. It sends customers to the portal with their MAC address.
3. **Walled garden** so customers can reach the portal and API before paying:
   ```
   /ip hotspot walled-garden add dst-host=portal.yourdomain.com
   /ip hotspot walled-garden add dst-host=api.yourdomain.com
   ```
4. Put the same values in `.env` and set `MIKROTIK_ENABLED=true`.

Everything the system adds on the router is commented `BilaWaya …`, and it only ever removes entries with that prefix, so your own bindings are never touched.

If the backend runs on a VPS and your router has no public IP (CGNAT), connect them with a VPN tunnel and point `MIKROTIK_HOST` at the router's tunnel address.

## Admin dashboard

Open `/admin` on the portal and sign in. You can see revenue and users, search transactions (including payments flagged **Paid, not activated** or **Needs review**), block/unblock/disconnect/delete users, see connected devices, and disconnect everyone. Support messages from the portal's contact form are stored and listed too.

## Development

```bash
npm test         # unit tests + route tests (fake database, no network)
npm run check    # syntax-check every backend file
```

## Known limitations

- **Speed limits are labels only.** The 2–5 Mbps shown on packages is not enforced. Apply limits on the router (for example a queue or hotspot profile) if you need them.
- **Refunds and receipts** in the dashboard are not implemented (Safaricom's Reversal API needs separate setup).
- Access is granted per MAC address, so a customer who changes their device MAC would need to pay again, and a spoofed MAC can borrow someone else's paid time. Per-user hotspot accounts are a possible future upgrade.
- The portal's About and Support pages contain placeholder marketing text. Replace it with your own.

## Credits and license

Started from [Frost-bit-star/mpesa-based-wifi-billing](https://github.com/Frost-bit-star/mpesa-based-wifi-billing) (MIT), then substantially reworked. Released under the [MIT License](LICENSE), which keeps the original copyright notice.
