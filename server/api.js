'use strict';
/**
 * Public API.
 *
 *   Guest (QR menu)   place order, follow it, ask for the bill
 *   Cashier           accept / reject, take payment, print bill
 *   Chef              cook & bump items, order ready
 *   Waiter            serve, settle
 *   Manager           everything + menu, tables, staff, reports
 */

const crypto = require('crypto');
const db = require('./db');
const bus = require('./bus');

/* --------------------------------------------------------------- sessions */

const sessions = new Map(); // token -> {staffId, role, name, expiresAt}
const SESSION_MS = 12 * 3600 * 1000;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function login(pin) {
  const staff = db.data.staff.find((s) => s.active !== false && safeEqual(s.pin, pin));
  if (!staff) return null;
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { staffId: staff.id, role: staff.role, name: staff.name, expiresAt: Date.now() + SESSION_MS });
  return { token, staff: { id: staff.id, name: staff.name, role: staff.role } };
}

function sessionFrom(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return Object.assign({ token }, s);
}

function logout(token) {
  sessions.delete(token);
}

/* --------------------------------------------------------------- errors */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => {
  throw new HttpError(400, msg);
};

/* ---------------------------------------------------------------- helpers */

function publicSettings() {
  const s = db.settings;
  return {
    hotelName: s.hotelName,
    restaurantName: s.restaurantName,
    address: s.address,
    phone: s.phone,
    email: s.email,
    currency: s.currency,
    taxLabel: s.taxLabel,
    taxPct: s.taxPct,
    serviceLabel: s.serviceLabel,
    servicePct: s.servicePct,
    payMethods: (s.payMethods || []).filter((m) => m.enabled !== false),
    demoMode: !!s.demoMode,
    requireCashierApproval: !!s.requireCashierApproval
  };
}

function availableMenu() {
  return {
    categories: db.data.categories.slice().sort((a, b) => a.sort - b.sort),
    items: db.data.menu.filter((i) => i.available !== false)
  };
}

function tableFor(id) {
  return db.data.tables.find((t) => t.id === id) || null;
}

/** Where do QR codes point? Prefer the configured base URL, else the request host. */
function originFor(req) {
  if (db.settings.baseUrl) return db.settings.baseUrl.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:4173';
  return `${proto}://${host}`;
}

function normaliseItems(raw) {
  if (!Array.isArray(raw) || !raw.length) bad('Add at least one item to the order.');
  if (raw.length > 60) bad('That is too many lines for a single order.');
  const items = [];
  for (const line of raw) {
    const menuItem = db.data.menu.find((m) => m.id === line.itemId);
    if (!menuItem) bad(`Unknown menu item: ${line.itemId}`);
    if (menuItem.available === false) bad(`${menuItem.name} is sold out right now.`);
    const qty = Math.round(Number(line.qty) || 0);
    if (qty < 1 || qty > 40) bad(`Quantity for ${menuItem.name} must be between 1 and 40.`);
    items.push({ itemId: menuItem.id, name: menuItem.name, price: menuItem.price, qty, notes: line.notes || '' });
  }
  return items;
}

/* ------------------------------------------------------- order transitions */

function syncItemRollup(order) {
  const statuses = order.items.map((i) => i.status);
  if (!statuses.length) return order.status;
  if (statuses.every((s) => s === 'served')) {
    return 'served';
  }
  if (statuses.every((s) => s === 'ready' || s === 'served')) {
    return 'ready';
  }
  if (statuses.some((s) => s === 'cooking' || s === 'ready')) {
    return 'preparing';
  }
  return 'in_kitchen';
}

function acceptOrReject(order, body, staff) {
  if (order.status !== 'awaiting_cashier') bad(`Order ${order.id} was already handled (${order.status}).`);
  const action = body.action;
  if (action === 'reject') {
    order.status = 'rejected';
    order.closedAt = db.nowISO();
    order.staff.cashier = staff.name;
    db.addTimeline(order, 'rejected', staff.name, body.reason ? `Rejected · ${body.reason}` : 'Rejected by cashier');
    db.recalc(order);
    return order;
  }
  if (action !== 'accept') bad('action must be accept or reject');

  const timing = body.payment && body.payment.timing === 'now' ? 'now' : 'later';
  const method = body.payment && body.payment.method ? String(body.payment.method) : null;
  const methods = db.settings.payMethods || [];
  if (timing === 'now' && !method) bad('Choose a payment method to take payment now.');
  if (method && !methods.some((m) => m.id === method && m.enabled !== false)) bad('Unknown payment method.');

  order.discountPct = Math.min(100, Math.max(0, Number(body.discountPct) || 0));
  if (body.notes !== undefined) order.notes = String(body.notes).slice(0, 200);
  order.status = 'in_kitchen';
  order.acceptedAt = db.nowISO();
  order.staff.cashier = staff.name;
  order.payment.timing = timing;
  if (timing === 'now') {
    order.payment.method = method;
    order.payment.reference = String((body.payment && body.payment.reference) || '').slice(0, 40);
    order.payment.status = 'paid';
    order.payment.paidAt = db.nowISO();
    order.payment.byStaff = staff.name;
    if (method === 'cash') {
      const tender = Math.round(Number(body.payment.tender) || 0);
      order.payment.tender = tender || null;
      order.payment.change = tender ? Math.max(0, tender - db.computeTotals(order).total) : 0;
    }
    db.addTimeline(order, 'in_kitchen', staff.name, `Accepted · paid by ${db.methodLabel(method)}`);
  } else {
    order.payment.method = method;
    db.addTimeline(order, 'in_kitchen', staff.name, `Accepted · bill to follow (${method ? 'preferred: ' + db.methodLabel(method) : 'method open'})`);
  }
  db.recalc(order);
  return order;
}

function takePayment(order, body, staff) {
  // validate everything first so a rejected attempt never leaves the bill half-paid
  if (['rejected', 'cancelled'].includes(order.status)) bad('This order was cancelled — payment cannot be taken.');
  if (order.payment.status === 'paid') bad('This bill is already settled.');
  const method = String(body.method || '');
  const methods = db.settings.payMethods || [];
  const m = methods.find((x) => x.id === method && x.enabled !== false);
  if (!m) bad('Choose a valid payment method.');
  const reference = String(body.reference || '').slice(0, 40);
  if (m.needsReference && !reference) bad(`${m.label} needs a transaction reference.`);

  let tender = null;
  let change = 0;
  if (method === 'cash') {
    const t = Math.round(Number(body.tender) || 0);
    const total = db.computeTotals(order).total;
    if (t && t < total) bad('Cash received is less than the bill total.');
    tender = t || null;
    change = t ? t - total : 0;
  }

  order.payment.method = method;
  order.payment.status = 'paid';
  order.payment.paidAt = db.nowISO();
  order.payment.byStaff = staff.name;
  order.payment.reference = reference;
  order.payment.tender = tender;
  order.payment.change = change;
  db.addTimeline(order, order.status, staff.name, `Paid by ${m.label}${reference ? ' · ref ' + reference : ''}`);

  // A paid bill that has already been served is closed and ready for the receipt.
  if (order.status === 'served') {
    order.status = 'completed';
    order.closedAt = db.nowISO();
    db.addTimeline(order, 'completed', staff.name, 'Bill settled · receipt issued');
  }
  db.recalc(order);
  return order;
}

function kitchenAction(order, body, staff) {
  const action = body.action;
  const isKitchenOrder = ['in_kitchen', 'preparing', 'ready'].includes(order.status);
  if (!isKitchenOrder) bad('This order is not in the kitchen queue.');
  if (action === 'start') {
    order.items.forEach((i) => {
      if (i.status === 'queued') i.status = 'cooking';
    });
    order.status = 'preparing';
    order.kitchenStartAt = order.kitchenStartAt || db.nowISO();
    order.staff.chef = staff.name;
    db.addTimeline(order, 'preparing', staff.name, 'Cooking started');
  } else if (action === 'ready') {
    order.items.forEach((i) => {
      if (i.status !== 'served') i.status = 'ready';
    });
    order.status = 'ready';
    order.readyAt = db.nowISO();
    order.staff.chef = staff.name;
    db.addTimeline(order, 'ready', staff.name, 'All items ready — pass to the floor');
  } else if (action === 'recall') {
    order.items.forEach((i) => {
      if (i.status !== 'served') i.status = 'queued';
    });
    order.status = 'in_kitchen';
    order.readyAt = null;
    db.addTimeline(order, 'in_kitchen', staff.name, 'Order recalled to the kitchen');
  } else {
    bad('Unknown kitchen action');
  }
  db.recalc(order);
  return order;
}

function setItemStatus(order, itemId, status, staff, scope) {
  const item = order.items.find((i) => i.id === itemId);
  if (!item) bad('That item is not part of this order.');
  if (scope === 'kitchen') {
    if (!['in_kitchen', 'preparing', 'ready'].includes(order.status)) bad('Order is not in the kitchen queue.');
    if (!['queued', 'cooking', 'ready'].includes(status)) bad('Kitchen items can be queued, cooking or ready.');
    item.status = status;
    if (status === 'cooking') {
      order.kitchenStartAt = order.kitchenStartAt || db.nowISO();
      order.staff.chef = staff.name;
    }
    order.status = syncItemRollup(order);
    if (order.status === 'ready' && !order.readyAt) {
      order.readyAt = db.nowISO();
      db.addTimeline(order, 'ready', staff.name, 'All items ready');
    }
  } else if (scope === 'serve') {
    if (!['ready', 'served', 'preparing', 'in_kitchen'].includes(order.status)) bad('Order cannot be served yet.');
    item.status = 'served';
    order.status = syncItemRollup(order);
    if (order.status === 'served') {
      order.servedAt = db.nowISO();
      order.staff.waiter = staff.name;
      db.addTimeline(order, 'served', staff.name, 'Served to table');
      if (order.payment.status === 'paid') {
        order.status = 'completed';
        order.closedAt = db.nowISO();
        db.addTimeline(order, 'completed', 'System', 'Bill already paid · receipt issued');
      }
    }
  } else {
    bad('Unknown scope');
  }
  db.recalc(order);
  return order;
}

function serveOrder(order, body, staff) {
  if (!['ready', 'preparing', 'in_kitchen'].includes(order.status)) bad('This order is not waiting to be served.');
  const only = Array.isArray(body.items) && body.items.length ? body.items : null;
  order.items.forEach((i) => {
    if (!only || only.includes(i.id)) {
      if (i.status !== 'served') i.status = 'served';
    }
  });
  if (order.items.every((i) => i.status === 'served')) {
    order.status = 'served';
    order.servedAt = db.nowISO();
    order.staff.waiter = staff.name;
    db.addTimeline(order, 'served', staff.name, 'Served to table');
    if (order.payment.status === 'paid') {
      order.status = 'completed';
      order.closedAt = db.nowISO();
      db.addTimeline(order, 'completed', 'System', 'Bill already paid · receipt issued');
    }
  } else {
    order.status = syncItemRollup(order);
    db.addTimeline(order, order.status, staff.name, 'Partially served');
  }
  db.recalc(order);
  return order;
}

/* ---------------------------------------------------------------- reports */

function inRange(order, range) {
  const t = new Date(order.createdAt).getTime();
  if (range === 'today') return t >= db.startOfToday().getTime();
  if (range === '7d') return t >= db.startOfToday().getTime() - 6 * 86400000;
  if (range === '30d') return t >= db.startOfToday().getTime() - 29 * 86400000;
  return true;
}

function reportFor(range = 'today') {
  const all = db.orders.concat(db.data.history || []);
  const paid = all.filter((o) => inRange(o, range) && o.payment && o.payment.status === 'paid');
  const byMethod = {};
  for (const m of db.settings.payMethods || []) byMethod[m.id] = { count: 0, amount: 0 };
  let revenue = 0;
  for (const o of paid) {
    const total = (o.totals && o.totals.total) || 0;
    revenue += total;
    const key = o.payment.method || 'other';
    if (!byMethod[key]) byMethod[key] = { count: 0, amount: 0 };
    byMethod[key].count += 1;
    byMethod[key].amount += total;
  }
  const topMap = new Map();
  for (const o of paid) {
    for (const it of o.items) {
      const row = topMap.get(it.name) || { name: it.name, qty: 0, amount: 0 };
      row.qty += it.qty;
      row.amount += it.price * it.qty;
      topMap.set(it.name, row);
    }
  }
  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, amount: 0 }));
  for (const o of paid) {
    const h = new Date(o.createdAt).getHours();
    hourly[h].orders += 1;
    hourly[h].amount += (o.totals && o.totals.total) || 0;
  }
  const ordersInRange = all.filter((o) => inRange(o, range));
  return {
    range,
    generatedAt: db.nowISO(),
    currency: db.settings.currency,
    orders: ordersInRange.length,
    paidOrders: paid.length,
    revenue,
    avgTicket: paid.length ? Math.round(revenue / paid.length) : 0,
    byMethod,
    byStatus: db.OPEN_STATUSES.concat(['completed', 'rejected', 'cancelled']).reduce((acc, s) => {
      acc[s] = ordersInRange.filter((o) => o.status === s).length;
      return acc;
    }, {}),
    topItems: Array.from(topMap.values()).sort((a, b) => b.qty - a.qty).slice(0, 12),
    hourly
  };
}

function tableStatuses() {
  const out = {};
  for (const t of db.data.tables) out[t.id] = { id: t.id, label: t.label, zone: t.zone, seats: t.seats, open: 0, unpaid: 0, status: 'free', since: null };
  for (const o of db.activeOrders()) {
    const row = out[o.tableId];
    if (!row) continue;
    row.open += 1;
    if (o.payment.status !== 'paid') row.unpaid += (o.totals && o.totals.total) || 0;
    if (!row.since || new Date(o.createdAt) < new Date(row.since)) row.since = o.createdAt;
    const rank = { awaiting_cashier: 1, in_kitchen: 2, preparing: 3, ready: 4, served: 5 };
    if (rank[o.status] >= rank[row.status] || row.status === 'free') row.status = o.status;
  }
  return Object.values(out);
}

function snapshotFor(staff, req) {
  const role = staff.role;
  const scoped = role === 'chef'
    ? db.orders.filter((o) => ['in_kitchen', 'preparing', 'ready', 'awaiting_cashier'].includes(o.status))
    : role === 'waiter'
      ? db.orders.filter((o) => db.OPEN_STATUSES.includes(o.status) || new Date(o.closedAt || 0).getTime() > Date.now() - 3600000)
      : db.orders.slice(0, 200);

  const today = reportFor('today');
  return {
    serverTime: db.nowISO(),
    origin: originFor(req),
    staff: { id: staff.staffId, name: staff.name, role: staff.role },
    // only managers may see the roster (it contains sign-in PINs)
    staffList: role === 'manager' ? db.data.staff : undefined,
    settings: Object.assign({}, db.settings, { payMethods: (db.settings.payMethods || []).filter((m) => m.enabled !== false) }),
    categories: db.data.categories.slice().sort((a, b) => a.sort - b.sort),
    menu: db.data.menu,
    tables: tableStatuses(),
    orders: scoped.map(db.staffOrder),
    stats: {
      open: db.activeOrders().length,
      awaitingCashier: db.orders.filter((o) => o.status === 'awaiting_cashier').length,
      inKitchen: db.orders.filter((o) => ['in_kitchen', 'preparing'].includes(o.status)).length,
      ready: db.orders.filter((o) => o.status === 'ready').length,
      served: db.orders.filter((o) => o.status === 'served').length,
      unpaid: db.activeOrders().filter((o) => o.payment.status !== 'paid').reduce((s, o) => s + (o.totals.total || 0), 0),
      today
    }
  };
}

function receiptFor(order) {
  const s = db.settings;
  return {
    order: db.staffOrder(order),
    hotel: {
      hotelName: s.hotelName,
      restaurantName: s.restaurantName,
      address: s.address,
      phone: s.phone,
      email: s.email,
      currency: s.currency,
      taxLabel: s.taxLabel,
      taxPct: s.taxPct,
      serviceLabel: s.serviceLabel,
      servicePct: s.servicePct
    },
    methodLabel: db.methodLabel(order.payment.method),
    issuedAt: db.nowISO()
  };
}

/* ------------------------------------------------------------------ routes */

const routes = [];
const route = (method, path, opts, handler) => routes.push({ method, path, opts, handler });

const AUTH = { auth: true };                        // any logged-in staff member
const role = (...roles) => ({ roles });

/* --- system --------------------------------------------------------------- */

route('GET', '/api/health', {}, () => ({
  ok: true,
  time: db.nowISO(),
  orders: db.orders.length,
  open: db.activeOrders().length,
  guests: bus.count()
}));

route('GET', '/api/bootstrap', {}, (ctx) => ({
  settings: publicSettings(),
  menu: availableMenu(),
  tables: db.data.tables.filter((t) => t.active !== false).map((t) => ({ id: t.id, label: t.label, zone: t.zone, seats: t.seats })),
  origin: originFor(ctx.req),
  serverTime: db.nowISO()
}));

route('GET', '/api/qr.svg', {}, (ctx) => {
  const text = String(ctx.query.get('text') || '').slice(0, 900);
  if (!text) bad('text is required');
  const scale = Math.min(24, Math.max(2, Number(ctx.query.get('scale')) || 6));
  return { __svg: require('./qr').svg(text, { scale }) };
});

/* --- guest ---------------------------------------------------------------- */

route('POST', '/api/orders', { throttle: true }, (ctx) => {
  const b = ctx.body || {};
  const table = tableFor(b.tableId);
  if (!table) bad('Unknown table — please rescan the QR code on your table.');
  if (table.active === false) bad('This table is not accepting orders right now.');
  const items = normaliseItems(b.items);
  const order = db.createOrder({
    tableId: table.id,
    items,
    guestName: b.guestName,
    guests: b.guests,
    notes: b.notes
  });
  db.persist();
  bus.broadcast('order', order.id, 'guest');
  return { order: db.publicOrder(order, { includeToken: true }) };
});

route('GET', '/api/public/order/:token', {}, (ctx) => {
  const order = db.findOrder(ctx.params.token);
  if (!order || order.token !== ctx.params.token) throw new HttpError(404, 'Order not found.');
  return { order: db.publicOrder(order), serverTime: db.nowISO() };
});

route('POST', '/api/public/order/:token/flag', {}, (ctx) => {
  const order = db.findOrder(ctx.params.token);
  if (!order || order.token !== ctx.params.token) throw new HttpError(404, 'Order not found.');
  const kind = (ctx.body && ctx.body.kind) || '';
  if (!['bill', 'waiter'].includes(kind)) bad('kind must be bill or waiter');
  const by = order.guestName || 'Guest';
  if (kind === 'bill') {
    order.flags.billRequested = true;
    db.addTimeline(order, order.status, by, 'Guest asked for the bill');
  } else {
    order.flags.waiterCalled = true;
    db.addTimeline(order, order.status, by, 'Guest called the waiter');
  }
  db.recalc(order);
  db.persist();
  bus.broadcast('order', order.id, 'guest');
  return { ok: true, order: db.publicOrder(order) };
});

/* --- auth ----------------------------------------------------------------- */

route('POST', '/api/auth/login', {}, (ctx) => {
  const pin = String((ctx.body && ctx.body.pin) || '').trim();
  if (!/^\d{4,6}$/.test(pin)) bad('Enter your 4-digit staff PIN.');
  const session = login(pin);
  if (!session) throw new HttpError(401, 'That PIN was not recognised.');
  return session;
});

route('POST', '/api/auth/logout', AUTH, (ctx) => {
  logout(ctx.staff.token);
  return { ok: true };
});

route('GET', '/api/auth/me', AUTH, (ctx) => ({ staff: { id: ctx.staff.staffId, name: ctx.staff.name, role: ctx.staff.role } }));

route('GET', '/api/auth/staff-list', {}, () => ({
  // public hints so the login screen can show who is on shift (no PINs)
  staff: db.data.staff.filter((s) => s.active !== false).map((s) => ({ id: s.id, name: s.name, role: s.role }))
}));

/* --- staff snapshot / SSE ------------------------------------------------- */

route('GET', '/api/snapshot', AUTH, (ctx) => snapshotFor(ctx.staff, ctx.req));

route('GET', '/api/events', {}, (ctx) => {
  const res = ctx.res;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`retry: 3000\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'hello', at: db.nowISO() })}\n\n`);
  const unsubscribe = bus.subscribe(res);
  ctx.req.on('close', unsubscribe);
  ctx.req.on('error', unsubscribe);
  return { __handled: true };
});

/* --- orders: staff actions ------------------------------------------------ */

route('POST', '/api/orders/:id/decision', role('cashier', 'manager'), (ctx) => {
  const order = db.findOrder(ctx.params.id);
  if (!order) throw new HttpError(404, 'Order not found.');
  acceptOrReject(order, ctx.body || {}, ctx.staff);
  db.persist();
  bus.broadcast('order', order.id, ctx.staff.name);
  return { order: db.staffOrder(order) };
});

route('PATCH', '/api/orders/:id', role('cashier', 'manager', 'waiter'), (ctx) => {
  const order = db.findOrder(ctx.params.id);
  if (!order) throw new HttpError(404, 'Order not found.');
  const b = ctx.body || {};
  if (b.discountPct !== undefined) {
    if (['completed', 'rejected', 'cancelled'].includes(order.status)) bad('This order is closed.');
    order.discountPct = Math.min(100, Math.max(0, Number(b.discountPct) || 0));
    db.addTimeline(order, order.status, ctx.staff.name, `Discount set to ${order.discountPct}%`);
  }
  if (b.notes !== undefined) order.notes = String(b.notes).slice(0, 200);
  if (b.guestName !== undefined) order.guestName = String(b.guestName).slice(0, 40);
  db.recalc(order);
  db.persist();
  bus.broadcast('order', order.id, ctx.staff.name);
  return { order: db.staffOrder(order) };
});

route('PATCH', '/api/orders/:id/items', role('cashier', 'manager'), (ctx) => {
  const order = db.findOrder(ctx.params.id);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (order.status !== 'awaiting_cashier') bad('Items can only be changed before the order is accepted.');
  const lines = (ctx.body && ctx.body.items) || [];
  for (const line of lines) {
    const item = order.items.find((i) => i.id === line.id);
    if (!item) continue;
    const qty = Math.round(Number(line.qty));
    if (Number.isNaN(qty)) continue;
    if (qty <= 0) {
      order.items = order.items.filter((i) => i.id !== item.id);
      db.addTimeline(order, order.status, ctx.staff.name, `Removed ${item.name}`);
    } else {
      if (qty !== item.qty) db.addTimeline(order, order.status, ctx.staff.name, `${item.name} ×${item.qty} → ×${qty}`);
      item.qty = Math.min(40, qty);
    }
  }
  if (!order.items.length) bad('An order cannot be empty — reject it instead.');
  db.recalc(order);
  db.persist();
  bus.broadcast('order', order.id, ctx.staff.name);
  return { order: db.staffOrder(order) };
});

route('POST', '/api/orders/:id/kitchen', role('chef', 'manager'), (ctx) => {
  const order = db.findOrder(ctx.params.id);
  if (!order) throw new HttpError(404, 'Order not found.');
  kitchenAction(order, ctx.body || {}, ctx.staff);
  db.persist();
  bus.broadcast('order', order.id, ctx.staff.name);
  return { order: db.staffOrder(order) };
});

route('POST', '/api/orders/:id/items/:itemId/kitchen', role('chef', 'manager'), (ctx) => {
  const order = db.findOrder(ctx.params.id);
  if (!order) throw new HttpError(404, 'Order not found.');
  const status = (ctx.body && ctx.body.status) || 'ready';
  setItemStatus(order, ctx.params.itemId, status, ctx.staff, 'kitchen');
  db.persist();
  bus.broadcast('order', order.id, ctx.staff.name);
  return { order: db.staffOrder(order) };
});

route('POST', '/api/orders/:id/serve', role('waiter', 'manager'), (ctx) => {
  const order = db.findOrder(ctx.params.id);
  if (!order) throw new HttpError(404, 'Order not found.');
  serveOrder(order, ctx.body || {}, ctx.staff);
  db.persist();
  bus.broadcast('order', order.id, ctx.staff.name);
  return { order: db.staffOrder(order) };
});

route('POST', '/api/orders/:id/items/:itemId/serve', role('waiter', 'manager'), (ctx) => {
  const order = db.findOrder(ctx.params.id);
  if (!order) throw new HttpError(404, 'Order not found.');
  setItemStatus(order, ctx.params.itemId, 'served', ctx.staff, 'serve');
  db.persist();
  bus.broadcast('order', order.id, ctx.staff.name);
  return { order: db.staffOrder(order) };
});

route('POST', '/api/orders/:id/payment', role('cashier', 'waiter', 'manager'), (ctx) => {
  const order = db.findOrder(ctx.params.id);
  if (!order) throw new HttpError(404, 'Order not found.');
  takePayment(order, ctx.body || {}, ctx.staff);
  db.persist();
  bus.broadcast('order', order.id, ctx.staff.name);
  return { order: db.staffOrder(order), receipt: receiptFor(order) };
});

route('POST', '/api/orders/:id/cancel', role('manager'), (ctx) => {
  const order = db.findOrder(ctx.params.id);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (['completed', 'rejected', 'cancelled'].includes(order.status)) bad('This order is already closed.');
  order.status = 'cancelled';
  order.closedAt = db.nowISO();
  db.addTimeline(order, 'cancelled', ctx.staff.name, (ctx.body && ctx.body.reason) || 'Cancelled by manager');
  db.recalc(order);
  db.persist();
  bus.broadcast('order', order.id, ctx.staff.name);
  return { order: db.staffOrder(order) };
});

route('GET', '/api/orders/:id/receipt', {}, (ctx) => {
  const order = db.findOrder(ctx.params.id);
  if (!order) throw new HttpError(404, 'Order not found.');
  const token = ctx.query.get('token');
  const authorised = ctx.staff || (token && order.token === token);
  if (!authorised) throw new HttpError(401, 'Sign in or open the receipt from your order tracking page.');
  return receiptFor(order);
});

route('GET', '/api/orders', AUTH, (ctx) => {
  const status = ctx.query.get('status');
  const list = status ? db.orders.filter((o) => o.status === status) : db.orders;
  return { orders: list.map(db.staffOrder) };
});

/* --- tables --------------------------------------------------------------- */

route('GET', '/api/tables', AUTH, () => ({ tables: db.data.tables, statuses: tableStatuses() }));

route('POST', '/api/tables', role('manager'), (ctx) => {
  const b = ctx.body || {};
  const label = String(b.label || '').trim();
  if (!label) bad('Give the table a label.');
  const base = 'T' + String(db.data.tables.length + 1).padStart(2, '0');
  const id = String(b.id || base).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8) || base;
  if (db.data.tables.some((t) => t.id === id)) bad('That table id already exists.');
  const table = { id, label, seats: Math.max(1, Math.min(40, Number(b.seats) || 2)), zone: String(b.zone || 'Indoor').slice(0, 30), active: true };
  db.data.tables.push(table);
  db.persist();
  bus.broadcast('tables');
  return { table };
});

route('PATCH', '/api/tables/:id', role('manager'), (ctx) => {
  const t = tableFor(ctx.params.id);
  if (!t) throw new HttpError(404, 'Table not found.');
  const b = ctx.body || {};
  if (b.label !== undefined) t.label = String(b.label).slice(0, 40);
  if (b.seats !== undefined) t.seats = Math.max(1, Math.min(40, Number(b.seats) || t.seats));
  if (b.zone !== undefined) t.zone = String(b.zone).slice(0, 30);
  if (b.active !== undefined) t.active = !!b.active;
  db.persist();
  bus.broadcast('tables');
  return { table: t };
});

route('DELETE', '/api/tables/:id', role('manager'), (ctx) => {
  const idx = db.data.tables.findIndex((t) => t.id === ctx.params.id);
  if (idx < 0) throw new HttpError(404, 'Table not found.');
  db.data.tables.splice(idx, 1);
  db.persist();
  bus.broadcast('tables');
  return { ok: true };
});

/* --- menu ----------------------------------------------------------------- */

route('GET', '/api/menu', {}, () => availableMenu());

route('POST', '/api/menu/items', role('manager'), (ctx) => {
  const b = ctx.body || {};
  const name = String(b.name || '').trim();
  if (!name) bad('The dish needs a name.');
  const cat = db.data.categories.find((c) => c.id === b.categoryId) || db.data.categories[0];
  const item = {
    id: 'M' + db.rid(5).toUpperCase(),
    name,
    price: Math.max(0, Math.round(Number(b.price) || 0)),
    categoryId: cat.id,
    prepMinutes: Math.max(1, Math.min(120, Number(b.prepMinutes) || 10)),
    description: String(b.description || '').slice(0, 160),
    tags: Array.isArray(b.tags) ? b.tags.slice(0, 4) : [],
    available: b.available !== false
  };
  db.data.menu.push(item);
  db.persist();
  bus.broadcast('menu');
  return { item };
});

route('PATCH', '/api/menu/items/:id', role('manager', 'chef', 'cashier'), (ctx) => {
  const item = db.data.menu.find((m) => m.id === ctx.params.id);
  if (!item) throw new HttpError(404, 'Menu item not found.');
  const b = ctx.body || {};
  // chefs and cashiers may only flip availability (86 an item)
  if (ctx.staff.role === 'manager') {
    if (b.name !== undefined) item.name = String(b.name).slice(0, 60);
    if (b.price !== undefined) item.price = Math.max(0, Math.round(Number(b.price) || 0));
    if (b.categoryId !== undefined) item.categoryId = String(b.categoryId);
    if (b.prepMinutes !== undefined) item.prepMinutes = Math.max(1, Math.min(120, Number(b.prepMinutes) || 10));
    if (b.description !== undefined) item.description = String(b.description).slice(0, 160);
    if (b.tags !== undefined) item.tags = Array.isArray(b.tags) ? b.tags.slice(0, 4) : [];
  }
  if (b.available !== undefined) item.available = !!b.available;
  db.persist();
  bus.broadcast('menu', item.id);
  return { item };
});

route('DELETE', '/api/menu/items/:id', role('manager'), (ctx) => {
  const idx = db.data.menu.findIndex((m) => m.id === ctx.params.id);
  if (idx < 0) throw new HttpError(404, 'Menu item not found.');
  db.data.menu.splice(idx, 1);
  db.persist();
  bus.broadcast('menu');
  return { ok: true };
});

route('POST', '/api/menu/categories', role('manager'), (ctx) => {
  const name = String((ctx.body && ctx.body.name) || '').trim();
  if (!name) bad('Give the category a name.');
  const cat = { id: 'cat-' + db.rid(5), name, sort: db.data.categories.length + 1, icon: String((ctx.body && ctx.body.icon) || '🍽️').slice(0, 4) };
  db.data.categories.push(cat);
  db.persist();
  bus.broadcast('menu');
  return { category: cat };
});

/* --- staff ---------------------------------------------------------------- */

route('GET', '/api/staff', role('manager'), () => ({ staff: db.data.staff }));

route('POST', '/api/staff', role('manager'), (ctx) => {
  const b = ctx.body || {};
  const name = String(b.name || '').trim();
  const pin = String(b.pin || '').trim();
  const roles = ['manager', 'cashier', 'chef', 'waiter'];
  if (!name) bad('Enter the staff name.');
  if (!/^\d{4,6}$/.test(pin)) bad('PIN must be 4–6 digits.');
  if (!roles.includes(b.role)) bad('Pick a role: manager, cashier, chef or waiter.');
  if (db.data.staff.some((s) => s.pin === pin)) bad('That PIN is already in use.');
  const staff = { id: 'ST-' + db.rid(4).toUpperCase(), name, role: b.role, pin, active: true };
  db.data.staff.push(staff);
  db.persist();
  bus.broadcast('staff');
  return { staff };
});

route('PATCH', '/api/staff/:id', role('manager'), (ctx) => {
  const s = db.data.staff.find((x) => x.id === ctx.params.id);
  if (!s) throw new HttpError(404, 'Staff member not found.');
  const b = ctx.body || {};
  if (b.name !== undefined) s.name = String(b.name).slice(0, 40);
  if (b.role !== undefined && ['manager', 'cashier', 'chef', 'waiter'].includes(b.role)) s.role = b.role;
  if (b.active !== undefined) s.active = !!b.active;
  if (b.pin !== undefined) {
    const pin = String(b.pin).trim();
    if (!/^\d{4,6}$/.test(pin)) bad('PIN must be 4–6 digits.');
    if (db.data.staff.some((x) => x.id !== s.id && x.pin === pin)) bad('That PIN is already in use.');
    s.pin = pin;
  }
  db.persist();
  bus.broadcast('staff');
  return { staff: s };
});

route('DELETE', '/api/staff/:id', role('manager'), (ctx) => {
  const managers = db.data.staff.filter((s) => s.role === 'manager' && s.active !== false);
  const s = db.data.staff.find((x) => x.id === ctx.params.id);
  if (!s) throw new HttpError(404, 'Staff member not found.');
  if (s.role === 'manager' && managers.length <= 1) bad('Keep at least one active manager.');
  db.data.staff = db.data.staff.filter((x) => x.id !== s.id);
  db.persist();
  bus.broadcast('staff');
  return { ok: true };
});

/* --- settings & admin ----------------------------------------------------- */

route('GET', '/api/settings', role('manager'), () => ({ settings: db.settings }));

route('PATCH', '/api/settings', role('manager'), (ctx) => {
  const b = ctx.body || {};
  const s = db.settings;
  const strings = ['hotelName', 'restaurantName', 'address', 'phone', 'email', 'taxLabel', 'serviceLabel', 'baseUrl'];
  for (const k of strings) if (b[k] !== undefined) s[k] = String(b[k]).slice(0, 120);
  for (const k of ['taxPct', 'servicePct']) {
    if (b[k] !== undefined) s[k] = Math.max(0, Math.min(60, Number(b[k]) || 0));
  }
  if (b.currency) {
    s.currency = {
      code: String(b.currency.code || s.currency.code).slice(0, 6).toUpperCase(),
      symbol: String(b.currency.symbol || s.currency.symbol).slice(0, 4),
      decimals: [0, 2, 3].includes(Number(b.currency.decimals)) ? Number(b.currency.decimals) : s.currency.decimals,
      position: b.currency.position === 'after' ? 'after' : 'before'
    };
  }
  for (const k of ['requireCashierApproval', 'demoMode', 'autoPrintOnPayment']) {
    if (b[k] !== undefined) s[k] = !!b[k];
  }
  if (Array.isArray(b.payMethods)) {
    s.payMethods = b.payMethods
      .filter((m) => m && m.id)
      .map((m) => ({
        id: String(m.id).slice(0, 20),
        label: String(m.label || m.id).slice(0, 30),
        detail: String(m.detail || '').slice(0, 80),
        enabled: m.enabled !== false,
        needsReference: !!m.needsReference
      }));
  }
  db.persist();
  bus.broadcast('settings');
  return { settings: s };
});

route('GET', '/api/reports/summary', role('manager', 'cashier'), (ctx) => reportFor(ctx.query.get('range') || 'today'));

route('POST', '/api/admin/reset', role('manager'), () => {
  db.reset();
  bus.broadcast('reset');
  return { ok: true };
});

/* Simulated guest so the whole flow can be demoed from one screen. */
route('POST', '/api/demo/order', {}, (ctx) => {
  if (!db.settings.demoMode && !ctx.staff) throw new HttpError(403, 'Demo mode is switched off.');
  const available = db.data.menu.filter((m) => m.available !== false && m.categoryId !== 'cat-hot');
  const pick = () => available[Math.floor(Math.random() * available.length)];
  const lines = new Map();
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const item = pick();
    lines.set(item.id, (lines.get(item.id) || 0) + (Math.random() < 0.3 ? 2 : 1));
  }
  const tables = db.data.tables.filter((t) => t.active !== false && !t.zone.startsWith('Room'));
  const table = tables[Math.floor(Math.random() * tables.length)];
  const first = ['Amina', 'Daniel', 'Grace', 'Hassan', 'Leila', 'Noah', 'Sofia', 'Tariq'];
  const order = db.createOrder({
    tableId: table.id,
    items: Array.from(lines).map(([id, qty]) => {
      const m = db.data.menu.find((x) => x.id === id);
      return { itemId: m.id, name: m.name, price: m.price, qty };
    }),
    guestName: first[Math.floor(Math.random() * first.length)],
    guests: Math.max(1, Math.min(table.seats, 1 + Math.floor(Math.random() * table.seats)))
  });
  db.persist();
  bus.broadcast('order', order.id, 'demo');
  return { order: db.publicOrder(order), table: table.label };
});

module.exports = { routes, HttpError, sessionFrom, publicSettings, receiptFor, snapshotFor, reportFor, originFor };
