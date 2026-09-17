'use strict';
/**
 * Tiny JSON-file datastore.
 *
 * One Node process owns the file, so we keep everything in memory and write an
 * atomic snapshot (tmp file + rename) after every mutation, debounced so a burst
 * of changes costs a single write.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const seed = require('./seed');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const OPEN_STATUSES = ['awaiting_cashier', 'in_kitchen', 'preparing', 'ready', 'served'];
const ITEM_STATUSES = ['queued', 'cooking', 'ready', 'served'];

let db = null;
let saveTimer = null;

/* ------------------------------------------------------------------ utils */

const rid = (n = 8) => crypto.randomBytes(16).toString('hex').slice(0, n);
const nowISO = () => new Date().toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));
const isOpen = (o) => OPEN_STATUSES.includes(o.status);

function startOfToday(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/* ------------------------------------------------------------------- init */

function freshDB() {
  return {
    version: 1,
    createdAt: nowISO(),
    settings: clone(seed.SETTINGS),
    staff: clone(seed.STAFF),
    tables: clone(seed.TABLES),
    categories: clone(seed.CATEGORIES),
    menu: seed.menuItems(),
    orders: [],
    counters: { orderSeq: 1000, historySeeded: true },
    history: []
  };
}

function nextOrderId() {
  db.counters.orderSeq += 1;
  return 'ORD-' + db.counters.orderSeq;
}

/** Build a paid historical order so the reports screen is not empty on day one. */
function historyOrder({ minutesAgo, tableId, method, itemIndexes, staffName }) {
  const settings = db.settings;
  const items = itemIndexes.map(([idx, qty]) => {
    const item = db.menu[idx % db.menu.length];
    return {
      id: rid(6),
      itemId: item.id,
      name: item.name,
      price: item.price,
      qty,
      notes: '',
      status: 'served'
    };
  });
  const created = new Date(Date.now() - minutesAgo * 60000);
  const table = db.tables.find((t) => t.id === tableId) || db.tables[0];
  const order = {
    id: nextOrderId(),
    token: rid(10),
    tableId: table.id,
    tableLabel: table.label,
    zone: table.zone,
    guests: 2,
    guestName: '',
    round: 1,
    source: 'qr',
    items,
    notes: '',
    status: 'completed',
    createdAt: created.toISOString(),
    updatedAt: created.toISOString(),
    acceptedAt: created.toISOString(),
    servedAt: created.toISOString(),
    closedAt: created.toISOString(),
    kitchenStartAt: created.toISOString(),
    readyAt: created.toISOString(),
    discountPct: 0,
    payment: {
      method,
      status: 'paid',
      tender: null,
      change: 0,
      reference: method === 'cash' ? '' : 'REF-' + rid(6).toUpperCase(),
      paidAt: created.toISOString(),
      byStaff: staffName
    },
    staff: { cashier: 'Daniel O.', chef: 'Marco S.', waiter: 'Yasmine A.' },
    flags: { billRequested: false, waiterCalled: false },
    timeline: [
      { at: created.toISOString(), status: 'awaiting_cashier', by: 'Guest', note: 'Order placed from QR menu' },
      { at: created.toISOString(), status: 'in_kitchen', by: 'Daniel O.', note: `Accepted · ${method}` },
      { at: created.toISOString(), status: 'preparing', by: 'Marco S.', note: 'Cooking started' },
      { at: created.toISOString(), status: 'ready', by: 'Marco S.', note: 'All items ready' },
      { at: created.toISOString(), status: 'served', by: 'Yasmine A.', note: 'Served to table' },
      { at: created.toISOString(), status: 'completed', by: 'Daniel O.', note: 'Bill settled' }
    ]
  };
  order.totals = computeTotals(order, settings);
  return order;
}

function seedHistory() {
  const cfg = [
    { minutesAgo: 320, tableId: 'T03', method: 'cash', itemIndexes: [[35, 3], [18, 2], [23, 2]], staffName: 'Daniel O.' },
    { minutesAgo: 260, tableId: 'T08', method: 'card', itemIndexes: [[9, 1], [37, 2], [29, 2]], staffName: 'Daniel O.' },
    { minutesAgo: 180, tableId: 'T05', method: 'mobile', itemIndexes: [[14, 2], [16, 1], [32, 1], [33, 2]], staffName: 'Daniel O.' },
    { minutesAgo: 95, tableId: 'T10', method: 'card', itemIndexes: [[0, 2], [22, 3], [27, 3], [36, 4]], staffName: 'Daniel O.' },
    { minutesAgo: 42, tableId: 'R01', method: 'room', itemIndexes: [[7, 1], [19, 1], [34, 1]], staffName: 'Daniel O.' }
  ];
  return cfg.map(historyOrder);
}

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // light migration guard so an older file never crashes the server
      const f = freshDB();
      for (const k of Object.keys(f)) if (db[k] === undefined) db[k] = f[k];
      db.settings = Object.assign({}, f.settings, db.settings || {});
      return false;
    }
  } catch (err) {
    console.error('[db] could not read', DB_FILE, err.message, '— starting fresh');
  }
  db = freshDB();
  db.history = seedHistory();
  persistNow();
  return true;
}

function reset() {
  db = freshDB();
  db.history = seedHistory();
  persistNow();
}

function persistNow() {
  if (!db) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[db] write failed:', err.message);
  }
}

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 120);
  if (saveTimer.unref) saveTimer.unref();
}

/* ------------------------------------------------------------------ money */

function roundMinor(v) {
  return Math.round(Number(v) || 0);
}

/**
 * subtotal → discount → service charge → tax → total, all in minor units.
 */
function computeTotals(order, settings = db.settings) {
  const subtotal = (order.items || []).reduce((s, it) => s + it.price * it.qty, 0);
  const discount = roundMinor((subtotal * (Number(order.discountPct) || 0)) / 100);
  const base = subtotal - discount;
  const service = roundMinor((base * (Number(settings.servicePct) || 0)) / 100);
  const tax = roundMinor(((base + service) * (Number(settings.taxPct) || 0)) / 100);
  return {
    subtotal,
    discount,
    service,
    tax,
    total: base + service + tax
  };
}

function recalc(order) {
  order.subtotal = order.items.reduce((s, it) => s + it.price * it.qty, 0);
  order.totals = computeTotals(order);
  order.updatedAt = nowISO();
  return order;
}

/* ------------------------------------------------------------------ orders */

function addTimeline(order, status, by, note) {
  order.timeline = order.timeline || [];
  order.timeline.push({ at: nowISO(), status, by: by || 'System', note: note || '' });
}

/** Which round of ordering is this table on? (drinks later in the meal = round 2) */
function roundForTable(tableId) {
  const since = Date.now() - 6 * 3600 * 1000;
  const count = db.orders.filter(
    (o) => o.tableId === tableId && new Date(o.createdAt).getTime() > since
  ).length;
  return count + 1;
}

function createOrder({ tableId, items, guestName = '', guests = 0, notes = '' }) {
  const table = db.tables.find((t) => t.id === tableId);
  const settings = db.settings;
  const order = {
    id: nextOrderId(),
    token: rid(10),
    tableId: table ? table.id : String(tableId || '—'),
    tableLabel: table ? table.label : String(tableId || 'Take-away'),
    zone: table ? table.zone : '',
    guests: Number(guests) || (table ? table.seats : 0),
    guestName: String(guestName || '').slice(0, 40),
    round: roundForTable(tableId),
    source: 'qr',
    items: items.map((it) => ({
      id: rid(6),
      itemId: it.itemId,
      name: it.name,
      price: it.price,
      qty: it.qty,
      notes: String(it.notes || '').slice(0, 120),
      status: 'queued',
      at: nowISO()
    })),
    notes: String(notes || '').slice(0, 200),
    status: settings.requireCashierApproval ? 'awaiting_cashier' : 'in_kitchen',
    createdAt: nowISO(),
    updatedAt: nowISO(),
    acceptedAt: settings.requireCashierApproval ? null : nowISO(),
    kitchenStartAt: null,
    readyAt: null,
    servedAt: null,
    closedAt: null,
    discountPct: 0,
    payment: {
      method: settings.requireCashierApproval ? null : 'cash',
      status: 'unpaid',
      tender: null,
      change: 0,
      reference: '',
      paidAt: null,
      byStaff: ''
    },
    staff: { cashier: '', chef: '', waiter: '' },
    flags: { billRequested: false, waiterCalled: false },
    timeline: []
  };
  addTimeline(order, 'awaiting_cashier', guestName || 'Guest', `Order placed · ${order.items.length} item(s)`);
  recalc(order);
  db.orders.unshift(order);
  return order;
}

function findOrder(idOrToken) {
  if (!idOrToken) return null;
  const q = String(idOrToken).toLowerCase();
  return db.orders.find((o) => o.id.toLowerCase() === q || o.token === q) || null;
}

function activeOrders() {
  return db.orders.filter(isOpen);
}

/* ------------------------------------------------------------- projections */

/** Public (guest-facing) view: no staff internals, no PINs, no other tables. */
function publicOrder(order, { includeToken = true } = {}) {
  const s = db.settings;
  return {
    id: order.id,
    token: includeToken ? order.token : undefined,
    tableId: order.tableId,
    tableLabel: order.tableLabel,
    round: order.round,
    guestName: order.guestName,
    guests: order.guests,
    items: order.items.map((it) => ({
      id: it.id,
      name: it.name,
      qty: it.qty,
      price: it.price,
      notes: it.notes,
      status: it.status
    })),
    notes: order.notes,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    servedAt: order.servedAt,
    discountPct: order.discountPct,
    totals: order.totals,
    payment: {
      method: order.payment.method,
      methodLabel: methodLabel(order.payment.method),
      status: order.payment.status,
      paidAt: order.payment.paidAt,
      reference: order.payment.reference
    },
    flags: order.flags,
    timeline: order.timeline,
    hotel: {
      hotelName: s.hotelName,
      restaurantName: s.restaurantName,
      address: s.address,
      phone: s.phone,
      currency: s.currency,
      taxLabel: s.taxLabel,
      taxPct: s.taxPct,
      serviceLabel: s.serviceLabel,
      servicePct: s.servicePct
    }
  };
}

function methodLabel(id) {
  const m = (db.settings.payMethods || []).find((x) => x.id === id);
  return m ? m.label : id || '—';
}

/** Everything the staff screens need. */
function staffOrder(order) {
  return Object.assign({}, order, { paymentMethodLabel: methodLabel(order.payment.method) });
}

function menuPayload() {
  return {
    categories: db.categories.slice().sort((a, b) => a.sort - b.sort),
    items: db.menu
  };
}

/* ---------------------------------------------------------------- exports */

module.exports = {
  load,
  reset,
  persist,
  persistNow,
  get data() {
    return db;
  },
  get settings() {
    return db.settings;
  },
  get orders() {
    return db.orders;
  },
  OPEN_STATUSES,
  ITEM_STATUSES,
  rid,
  nowISO,
  clone,
  isOpen,
  startOfToday,
  computeTotals,
  recalc,
  addTimeline,
  createOrder,
  findOrder,
  activeOrders,
  publicOrder,
  staffOrder,
  menuPayload,
  methodLabel,
  nextOrderId
};
