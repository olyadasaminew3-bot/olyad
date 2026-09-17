# Hotel Serving System — QR ordering for hotels & restaurants

A complete dine-in service chain in one small app:

```
QR code on the table  →  guest menu (no app, no install)  →  order sent
      →  CASHIER approves / edits / prices it
      →  KITCHEN cooks & bumps tickets
      →  WAITER serves
      →  payment (cash · card · mobile money · charge to room)
      →  printed RECEIPT showing the payment method
```

The server is **dependency-free Node** (`node server/server.js` is the whole install), the
data lives in a JSON file, and every screen updates live over Server-Sent Events — no
refresh, no polling loops to babysit.

---

## Quick start

```bash
node server/server.js          # or: npm start      → http://localhost:4173
node --watch server/server.js  # dev, restarts on change
node test/api.test.js          # 46-check end-to-end API test suite
```

Then open:

| Screen | URL | Who uses it |
|---|---|---|
| Landing / live floor | `/` | anyone — links to everything |
| **Guest menu** | `/menu.html?table=T05` | the guest, via the table QR code |
| Order tracking | `/track.html?t=<token>` | the guest, after ordering |
| Receipt / bill | `/receipt.html?o=ORD-1001` | staff printing, or guests with `&t=<token>` |
| **Staff console** | `/staff.html` | cashier · kitchen · waiter · manager |
| Administration | `/admin.html` | menu, prices, tables, QR codes, PINs, reports |
| Table QR sheet | `/admin.html#qr` | print and stick on the tables |

### Demo sign-in PINs (change them in Admin → Staff)

| Role | PIN | What they can do |
|---|---|---|
| Cashier | `1111` | approve/reject orders, edit a bill before accepting, take payment, print receipts |
| Chef | `2222` | kitchen board, start cooking, bump single dishes, mark orders ready, 86 menu items |
| Waiter | `3333` / `3334` | see what's ready, serve items or whole orders, settle bills |
| Manager | `9999` | everything + menu, prices, tables, QR codes, staff PINs, settings, reports |

---

## Try the whole chain in 30 seconds

1. Open `/staff.html` in one tab → sign in as **cashier (1111)**.
2. Open `/menu.html?table=T05` in another tab (that is what the guest's phone shows) and send an order.
3. The order pops up in the cashier queue (with a chime). Approve it → it lands on the kitchen board.
4. Sign in as **chef (2222)**: *Start cooking* → *Ready*.
5. Sign in as **waiter (3333)**: *Serve everything*.
6. Back in the cashier tab: *Take payment* → pick **Cash / Card / Mobile Money / Charge to Room**,
   cash tender calculator included → confirm → the receipt opens, ready to print.
7. The guest's tracking page updates at every step, and they can request the bill or call a waiter from it.

`🎲 Simulate guest order` (top bar, and on the landing page) creates a realistic order so you can
demo the flow from a single screen.

---

## What each role sees

**Guest** (their phone, from the QR code)
- Hotel-branded live menu with categories, search, dish notes, allergens/tags and prep times.
- Basket with per-dish notes, party size, allergy notes, live total (service charge + tax shown).
- Live tracking page: progress rail (Placed → Cashier → Cooking → Ready → Served → Paid),
  per-dish status, running bill, timeline, *ask for the bill*, *call the waiter*, receipt when paid.
- Nothing else — guests never see staff, PINs, other tables or the admin area.

**Cashier**
- Incoming queue with guest name, table, round, notes and elapsed time — approve, edit quantities,
  apply a discount, reject with a reason, or take payment up front.
- "Take payment" dialog: method grid, reference for mobile-money/room charge, cash tender shortcuts
  and automatic change calculation.
- Floor map with live table status, "Settle & receipts" tab with today's revenue per method.

**Kitchen**
- Kanban: *To start → Cooking → Ready to serve*, per-ticket timers that turn amber/red as they age.
- Start cooking, bump individual dishes, mark the whole ticket ready, recall a ticket.
- Mark dishes sold out (86) or back on the menu.

**Waiter**
- *On the pass* list (orders the kitchen marked ready), one-tap serving, settle bills, call-backs
  when a guest asked for the bill or called a waiter.

**Manager**
- Everything above plus `/admin.html`: menu & categories CRUD, sold-out switches, tables & zones,
  printable QR codes per table (SVG download + A4 print sheet), staff & PIN management,
  property/currency/tax/service settings, payment-method configuration, and reports
  (revenue, average ticket, split by payment method, best sellers, revenue per hour, full order list).

---

## How the money works

- Prices are stored in **minor units** (cents) as integers — no floating point drift.
- Bill = `subtotal − discount + service charge + tax`; percentages are configurable
  (defaults: 10% service, 8% VAT).
- Currency, symbol, decimals (0/2/3) and symbol position are configurable — works for `$`, `£`, `€`,
  `KSh`, `RWF`-style whole units, etc.
- Cash payments accept an amount tendered and return the change; short tender is refused.
- Payment methods are data, not code: rename them, require a reference (MoMo transaction code,
  room number), or disable one entirely in Admin → Settings.
- A bill cannot be paid twice, and a rejected/cancelled order can never be paid.
- A served order that gets paid is automatically closed and ready for its receipt.

---

## The QR codes

- Each table has its own URL: `/menu.html?table=T05` — the QR images are generated **on the server**
  as SVG (`/api/qr.svg?text=…`), so nothing is fetched from a third party.
- **Admin → Tables & QR codes** shows a QR card per table with:
  - `⬇ SVG` — download for the design/print team,
  - `🖨 Print all` — a print-optimised sheet (2 codes per row, dashed cut lines),
  - `🔗 Link` — copy the guest link (useful for WhatsApp/hotel chat).
- QR codes embed the URL built from `baseUrl` (Admin → Settings). Leave it empty to use whatever
  address the server is opened on — but for real guests, set it to your LAN/hotel address, e.g.
  `http://192.168.1.50:4173` (Wi-Fi network) or your public HTTPS URL, then reprint the sheet.

---

## Data, storage, deployment

- Everything lives in `data/db.json` (atomic write on change). Point it elsewhere with
  `DATA_DIR=/var/lib/serving-data node server/server.js`.
- Environment: `PORT` (default 4173), `HOST` (default `0.0.0.0`), `DATA_DIR`.
- Works on a hotel LAN: one cheap PC/mini-PC runs the server, tablets on Wi-Fi use the console,
  guests' phones hit the same address from the QR code.
- Reset to the seeded demo data: Admin → Settings → *Reset demo data*
  (or delete `data/db.json` and restart).
- Staff sessions are in-memory bearer tokens with a 12-hour lifetime; PINs are checked in
  constant time. Guests can only ever read their own order through its random token.

### Printer tips

- The receipt is a web page — use your browser's print dialog.
- For 80 mm thermal printers set scale to 100% and margins to **none**;
  the receipt layout is width-limited and monospace-friendly.
- For A4 invoices use default margins; for kitchens, print the QR sheet from `Admin → #qr`.
- `autoPrintOnPayment` (Admin → Settings) automatically opens the receipt after settling a bill.

---

## Project layout

```
server/
  server.js    HTTP server: static files, API router, SSE stream, throttle, error mapping
  api.js       every route: guests, orders lifecycle, tables, menu, staff, settings, reports
  db.js        JSON store, order model, totals maths (minor units), lifecycle helpers
  qr.js        SVG QR renderer (self-contained, server-side)
  qrcode.js    vendored MIT QR encoder (qrcode-generator 2.0.4) — QR Code is a trademark of DENSO WAVE
  bus.js       SSE subscriber bus + heartbeat
  seed.js      hotel identity, 39-dish menu, 14 tables, 5 staff, payment methods
public/
  index.html       landing page with live floor + one-tap demo order
  menu.html        guest QR menu            js/guest.js
  track.html       guest order tracking     js/track.js
  receipt.html     printable bill/receipt   js/receipt.js
  staff.html       cashier/kitchen/waiter/manager console (PIN keypad)   js/staff.js
  admin.html       menu, tables & QR, staff, settings, reports            js/admin.js
  css/app.css      design system (dark staff console, warm guest theme, print styles)
  js/core.js       shared client kit: API client, money/date formatting, toasts, modals, live stream
  legacy/          the previous project that used to live in this repository (kept for reference)
test/
  api.test.js   end-to-end test of the whole chain (spawns a throw-away server + data dir)
```

## API at a glance

```
GET  /api/health                     GET  /api/bootstrap            (public: hotel, menu, tables)
POST /api/orders                     (guest places an order)
GET  /api/public/order/:token        POST /api/public/order/:token/flag   (bill · waiter)
GET  /api/qr.svg?text=…              (SVG QR code)
POST /api/auth/login                 POST /api/auth/logout          GET /api/auth/me
GET  /api/snapshot                   (role-scoped board state, live via /api/events SSE)
POST /api/orders/:id/decision        (accept / reject)              PATCH /api/orders/:id (discount, notes)
PATCH /api/orders/:id/items          (edit before accepting)
POST /api/orders/:id/kitchen         POST /api/orders/:id/items/:itemId/kitchen
POST /api/orders/:id/serve           POST /api/orders/:id/items/:itemId/serve
POST /api/orders/:id/payment         GET  /api/orders/:id/receipt   (staff or ?token=)
GET  /api/tables  POST/PATCH/DELETE /api/tables/:id
GET  /api/menu    POST/PATCH/DELETE /api/menu/items…                POST /api/menu/categories
GET  /api/staff   POST/PATCH/DELETE /api/staff/:id
GET  /api/settings  PATCH /api/settings                             GET /api/reports/summary?range=today|7d|30d|all
POST /api/demo/order                 POST /api/admin/reset
```

---

*The previous project that lived in this repository (a poultry-health dashboard) has been
archived under `public/legacy/` and is no longer the site root. The QR system replaced it.*
