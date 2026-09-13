# Voucher QR Portal

A small self-hosted portal that turns a pool of normal hotspot vouchers into one reusable QR code.

## What it does

1. Operator signs in.
2. Operator creates a QR campaign for a hotspot such as `http://nexa.spot/login`.
3. Operator pastes voucher codes or uploads TXT/CSV.
4. Portal generates one permanent QR for the campaign.
5. Customer connects to the hotspot Wi-Fi and scans the QR.
6. QR opens the portal briefly, then redirects to the MikroTik hotspot page with a campaign token.
7. `mikrotik-auto.js` asks this portal for one unused voucher using the MikroTik client MAC address.
8. The script fills the existing voucher field and triggers the hotspot's normal voucher activation flow.
9. The same device receives the same assigned voucher if it scans again. Two devices cannot receive the same voucher.

Reloading more vouchers does **not** require a new QR.

## Requirements

- Node.js 20+
- A domain/subdomain pointing to the server, e.g. `voucher.example.com`
- HTTPS recommended
- MikroTik hotspot login page that contains:
  - `#mac2` containing `$(mac)`
  - voucher input `#code`
  - voucher activation button `#voucher-form`
- The portal domain allowed in MikroTik Hotspot Walled Garden

The hotspot package inspected for this project already uses those element IDs.

## Quick start

```bash
git clone https://github.com/telenexus-admin/voucher.git
cd voucher
cp .env.example .env
nano .env
npm install
npm start
```

Example `.env`:

```env
PORT=8080
BASE_URL=https://voucher.example.com
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=use-a-strong-password
JWT_SECRET=use-a-long-random-secret
TRUST_PROXY=1
```

The database is created automatically at `data/voucher.sqlite`.

## Docker

```bash
docker build -t voucher-qr .
docker run -d \
  --name voucher-qr \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  --env-file .env \
  -v voucher-data:/app/data \
  voucher-qr
```

Put Nginx or another reverse proxy in front of port 8080 and terminate HTTPS there.

## MikroTik integration

### 1. Allow the portal before login

Add the portal domain to **IP > Hotspot > Walled Garden** so unauthenticated clients can reach it.

For a portal hosted at:

```text
https://voucher.example.com
```

allow the hostname:

```text
voucher.example.com
```

Both the QR redirect and `/api/v1/claim` must be reachable before hotspot authentication.

### 2. Load the automatic bridge in `login.html`

Add this before `</body>` in the MikroTik hotspot `login.html`:

```html
<script src="https://voucher.example.com/mikrotik-auto.js" defer></script>
```

No voucher codes are stored in `login.html`.

### 3. Create the campaign

In the portal create a campaign with the hotspot login URL, for example:

```text
http://nexa.spot/login
```

The generated QR points to a URL similar to:

```text
https://voucher.example.com/go/<private-campaign-token>
```

After scanning, the portal redirects the phone to:

```text
http://nexa.spot/login?vq=<private-campaign-token>
```

`mikrotik-auto.js` sees the `vq` value, reads `$(mac)` from `#mac2`, claims one voucher from the portal and presses the existing voucher activation button.

## Voucher upload formats

Paste one code per line:

```text
ABC123
ABC124
ABC125
```

TXT and CSV files are also accepted. For a CSV, the first non-empty value on each row is treated as the voucher code.

Duplicate codes in the same campaign are ignored.

## Assignment safety

Voucher allocation is done inside an SQLite immediate transaction. This prevents concurrent scans from assigning the same voucher twice.

There is also a unique campaign/device rule. If the same MikroTik MAC scans again, the portal returns the voucher already assigned to that device instead of consuming another voucher.

## Current MVP scope

Included now:

- Admin authentication
- Campaign creation
- Permanent QR generation
- QR SVG download
- Voucher paste/TXT/CSV upload
- Voucher reload into an existing QR pool
- Available/assigned counters
- Assignment audit table
- Concurrent-safe claim API
- Same-device reuse protection
- Public MikroTik auto-login bridge
- SQLite persistence
- Docker deployment

Recommended next additions:

- Multiple operator accounts / tenants
- Operator-specific campaigns and permissions
- Low-voucher alerts
- Voucher expiry and batch labels
- Claim/release controls for failed activations
- Printable branded QR poster templates
- Campaign analytics and scan history
- Backup/export tools

## Security notes

- Never commit `.env`.
- Change the bootstrap password before deployment.
- Use a strong random `JWT_SECRET`.
- Use HTTPS on the portal domain.
- Treat the printed QR as access to that voucher pool: anyone who can scan/copy the QR can attempt a claim while on the hotspot network.
- The campaign token can be rotated if a printed QR must be invalidated.
