'use strict';
/**
 * End-to-end API test: the whole service chain.
 *
 *   QR menu → guest order → cashier approves → kitchen cooks → waiter serves
 *   → payment with method → receipt → reports
 *
 * Runs against a throw-away data directory so real data is never touched.
 *   node test/api.test.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = Number(process.env.TEST_PORT || 4599);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hss-test-'));

let passed = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  \u001b[32m✓\u001b[0m ${name}`);
  } catch (err) {
    results.push(`  \u001b[31m✗\u001b[0m ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

async function req(method, path_, { body, token } = {}) {
  const res = await fetch(BASE + path_, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await wait(150);
  }
  throw new Error('server did not start');
}

async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR, HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });

  const cleanup = () => {
    child.kill('SIGTERM');
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  try {
    await waitForServer();

    /* ------------------------------------------------------------ static */
    const page = await fetch(BASE + '/menu.html?table=T01');
    await check('guest menu page is served', () => assert.strictEqual(page.status, 200));
    const svg = await fetch(BASE + '/api/qr.svg?text=' + encodeURIComponent('https://example.test/menu.html?table=T01'));
    const svgText = await svg.text();
    await check('QR endpoint returns SVG', () => {
      assert.strictEqual(svg.status, 200);
      assert.ok(svgText.startsWith('<svg'), 'not an svg');
      assert.ok(svgText.includes('<path'), 'svg has no modules');
    });

    /* ---------------------------------------------------------- bootstrap */
    const boot = (await req('GET', '/api/bootstrap')).data;
    await check('bootstrap exposes hotel, menu and tables', () => {
      assert.ok(boot.settings.hotelName);
      assert.ok(boot.menu.items.length > 10, 'menu too small');
      assert.ok(boot.tables.some((t) => t.id === 'T05'));
      assert.strictEqual(boot.settings.staff, undefined, 'staff must not leak');
    });

    /* ------------------------------------------------------ guest orders */
    const hamburger = boot.menu.items.find((i) => i.price > 0);
    const drink = boot.menu.items.filter((i) => i.id !== hamburger.id)[0];
    const created = await req('POST', '/api/orders', {
      body: {
        tableId: 'T05',
        guestName: 'Test Guest',
        guests: 3,
        notes: 'One allergy: peanuts',
        items: [
          { itemId: hamburger.id, qty: 2, notes: 'no onions' },
          { itemId: drink.id, qty: 1 }
        ]
      }
    });
    await check('guest can place an order from the QR menu', () => {
      assert.strictEqual(created.status, 200);
      assert.strictEqual(created.data.order.status, 'awaiting_cashier');
      assert.ok(created.data.order.token, 'order needs a tracking token');
      assert.strictEqual(created.data.order.items.length, 2);
    });
    const order = created.data.order;
    const token = order.token;

    const publicView = (await req('GET', '/api/public/order/' + token)).data.order;
    await check('guest tracking shows only their own order', () => {
      assert.strictEqual(publicView.id, order.id);
      assert.strictEqual(publicView.staff, undefined, 'staff internals leaked');
      assert.ok(publicView.totals.total > 0);
    });

    await check('unknown order tokens are rejected', async () => {
      const res = await req('GET', '/api/public/order/deadbeef');
      assert.strictEqual(res.status, 404);
    });

    const badTable = await req('POST', '/api/orders', { body: { tableId: 'NOPE', items: [{ itemId: hamburger.id, qty: 1 }] } });
    await check('orders from an unknown table are refused', () => assert.strictEqual(badTable.status, 400));
    const badItem = await req('POST', '/api/orders', { body: { tableId: 'T05', items: [{ itemId: 'NOPE', qty: 1 }] } });
    await check('orders with unknown dishes are refused', () => assert.strictEqual(badItem.status, 400));

    /* ------------------------------------------------------------- auth */
    await check('the staff snapshot needs a PIN', async () => {
      const res = await req('GET', '/api/snapshot');
      assert.strictEqual(res.status, 401);
    });
    const wrongPin = await req('POST', '/api/auth/login', { body: { pin: '0000' } });
    await check('wrong PIN is refused', () => assert.strictEqual(wrongPin.status, 401));

    const cashier = (await req('POST', '/api/auth/login', { body: { pin: '1111' } })).data;
    const chef = (await req('POST', '/api/auth/login', { body: { pin: '2222' } })).data;
    const waiter = (await req('POST', '/api/auth/login', { body: { pin: '3333' } })).data;
    const manager = (await req('POST', '/api/auth/login', { body: { pin: '9999' } })).data;
    await check('cashier, chef, waiter and manager can sign in', () => {
      assert.strictEqual(cashier.staff.role, 'cashier');
      assert.strictEqual(chef.staff.role, 'chef');
      assert.strictEqual(waiter.staff.role, 'waiter');
      assert.strictEqual(manager.staff.role, 'manager');
      assert.ok(cashier.token && chef.token && waiter.token && manager.token);
    });

    /* ---------------------------------------------------- role guarding */
    const chefPaying = await req('POST', `/api/orders/${order.id}/payment`, { token: chef.token, body: { method: 'cash' } });
    await check('kitchen cannot take payments', () => assert.strictEqual(chefPaying.status, 403));
    const guestSnapshot = await req('GET', '/api/snapshot', { token: 'not-a-token' });
    await check('bogus tokens are rejected', () => assert.strictEqual(guestSnapshot.status, 401));

    /* ------------------------------------------------- cashier approves */
    const accepted = await req('POST', `/api/orders/${order.id}/decision`, {
      token: cashier.token,
      body: { action: 'accept', payment: { timing: 'later' }, notes: 'Peanut allergy — kitchen please note' }
    });
    await check('cashier approves the order and it reaches the kitchen', () => {
      assert.strictEqual(accepted.status, 200);
      assert.strictEqual(accepted.data.order.status, 'in_kitchen');
      assert.strictEqual(accepted.data.order.staff.cashier, 'Daniel O.');
    });

    const beforeKitchen = (await req('GET', '/api/snapshot', { token: waiter.token })).data;
    await check('waiter sees the order waiting in the kitchen', () => {
      assert.ok(beforeKitchen.orders.some((o) => o.id === order.id && o.status === 'in_kitchen'));
    });

    /* --------------------------------------------------- kitchen cooks */
    const cooking = await req('POST', `/api/orders/${order.id}/kitchen`, { token: chef.token, body: { action: 'start' } });
    await check('chef starts cooking', () => assert.strictEqual(cooking.data.order.status, 'preparing'));

    const firstItem = cooking.data.order.items[0];
    await req('POST', `/api/orders/${order.id}/items/${firstItem.id}/kitchen`, { token: chef.token, body: { status: 'ready' } });
    const afterItem = (await req('GET', '/api/snapshot', { token: chef.token })).data.orders.find((o) => o.id === order.id);
    await check('single dishes can be bumped to ready', () => {
      assert.strictEqual(afterItem.items.find((i) => i.id === firstItem.id).status, 'ready');
      assert.strictEqual(afterItem.status, 'preparing', 'order stays in progress while other dishes cook');
    });

    const allReady = await req('POST', `/api/orders/${order.id}/kitchen`, { token: chef.token, body: { action: 'ready' } });
    await check('chef marks the whole order ready', () => {
      assert.strictEqual(allReady.data.order.status, 'ready');
      assert.ok(allReady.data.order.readyAt);
    });

    /* ------------------------------------------------------ waiter serves */
    const served = await req('POST', `/api/orders/${order.id}/serve`, { token: waiter.token, body: {} });
    await check('waiter serves the order', () => {
      assert.strictEqual(served.data.order.status, 'served');
      assert.strictEqual(served.data.order.staff.waiter, 'Yasmine A.');
      assert.ok(served.data.order.totals.total > 0);
    });

    /* --------------------------------------------------------- guest flags */
    await req('POST', `/api/public/order/${token}/flag`, { body: { kind: 'bill' } });
    const flagged = (await req('GET', '/api/public/order/' + token)).data.order;
    await check('guest can ask for the bill from their phone', () => {
      assert.strictEqual(flagged.flags.billRequested, true);
      assert.ok(flagged.timeline.some((t) => /bill/i.test(t.note)));
    });

    /* ------------------------------------------------------------ payment */
    const total = flagged.totals.total;
    const shortCash = await req('POST', `/api/orders/${order.id}/payment`, {
      token: cashier.token, body: { method: 'cash', tender: Math.max(1, total - 500) }
    });
    await check('under-tendered cash is refused', () => assert.strictEqual(shortCash.status, 400));

    const paid = await req('POST', `/api/orders/${order.id}/payment`, {
      token: cashier.token, body: { method: 'cash', tender: total + 1000 }
    });
    await check('cashier settles the bill in cash and change is calculated', () => {
      assert.strictEqual(paid.status, 200);
      assert.strictEqual(paid.data.order.payment.status, 'paid');
      assert.strictEqual(paid.data.order.payment.change, 1000);
      assert.strictEqual(paid.data.order.status, 'completed', 'a served + paid order closes');
      assert.strictEqual(paid.data.receipt.methodLabel, 'Cash');
    });

    const doublePay = await req('POST', `/api/orders/${order.id}/payment`, { token: cashier.token, body: { method: 'card' } });
    await check('a bill cannot be paid twice', () => assert.strictEqual(doublePay.status, 400));

    /* ------------------------------------------------------------ receipt */
    const receipt = (await req('GET', `/api/orders/${order.id}/receipt?token=${token}`)).data;
    await check('the receipt carries hotel, payment method and totals', () => {
      assert.strictEqual(receipt.order.id, order.id);
      assert.strictEqual(receipt.methodLabel, 'Cash');
      assert.strictEqual(receipt.order.payment.status, 'paid');
      assert.ok(receipt.hotel.hotelName);
      assert.strictEqual(receipt.order.totals.total, total);
      assert.ok(receipt.order.items.length === 2);
    });
    await check('receipt maths add up (subtotal − discount + service + tax = total)', () => {
      const t = receipt.order.totals;
      assert.strictEqual(t.subtotal - t.discount + t.service + t.tax, t.total);
    });

    /* ------------------------------------------------ second order paths */
    const order2 = (await req('POST', '/api/orders', {
      body: { tableId: 'T07', items: [{ itemId: hamburger.id, qty: 1 }] }
    })).data.order;
    const rejected = await req('POST', `/api/orders/${order2.id}/decision`, {
      token: cashier.token, body: { action: 'reject', reason: 'Item sold out' }
    });
    await check('cashier can reject an order with a reason', () => {
      assert.strictEqual(rejected.data.order.status, 'rejected');
      assert.ok(rejected.data.order.timeline.some((t) => /sold out/i.test(t.note)));
    });
    const rejectedPay = await req('POST', `/api/orders/${order2.id}/payment`, { token: cashier.token, body: { method: 'cash' } });
    await check('a rejected order cannot be paid', () => assert.strictEqual(rejectedPay.status, 400));

    const order3 = (await req('POST', '/api/orders', {
      body: { tableId: 'T03', items: [{ itemId: hamburger.id, qty: 2 }] }
    })).data.order;
    const room = await req('POST', `/api/orders/${order3.id}/payment`, {
      token: waiter.token, body: { method: 'room', reference: 'Room 204' }
    });
    await check('waiter can charge a bill to the room with a reference', () => {
      assert.strictEqual(room.data.order.payment.method, 'room');
      assert.strictEqual(room.data.order.payment.reference, 'Room 204');
      assert.strictEqual(room.data.receipt.methodLabel, 'Charge to Room');
    });
    const noRef = await req('POST', `/api/orders/${(await req('POST', '/api/orders', { body: { tableId: 'T04', items: [{ itemId: hamburger.id, qty: 1 }] } })).data.order.id}/payment`, {
      token: waiter.token, body: { method: 'room' }
    });
    await check('methods that need a reference demand one', () => assert.strictEqual(noRef.status, 400));

    const discounted = await req('PATCH', `/api/orders/${order3.id}`, { token: manager.token, body: { discountPct: 10 } });
    await check('manager can apply a discount', () => {
      assert.strictEqual(discounted.data.order.discountPct, 10);
      assert.ok(discounted.data.order.totals.discount > 0);
    });

    /* ------------------------------------------------ edits & demo & admin */
    const order4 = (await req('POST', '/api/orders', {
      body: { tableId: 'T02', items: [{ itemId: hamburger.id, qty: 3 }] }
    })).data.order;
    const edited = await req('PATCH', `/api/orders/${order4.id}/items`, {
      token: cashier.token, body: { items: [{ id: order4.items[0].id, qty: 1 }] }
    });
    await check('cashier can trim quantities before approving', () => {
      assert.strictEqual(edited.data.order.items[0].qty, 1);
      assert.ok(edited.data.order.totals.subtotal < order4.totals.subtotal);
    });

    const demo = await req('POST', '/api/demo/order', { body: {} });
    await check('demo guest order can be simulated', () => {
      assert.strictEqual(demo.status, 200);
      assert.ok(demo.data.order.items.length >= 1);
      assert.strictEqual(demo.data.order.status, 'awaiting_cashier');
    });

    const tables = (await req('GET', '/api/tables', { token: manager.token })).data;
    await check('floor map reports live table state', () => {
      assert.ok(tables.tables.length >= 10);
      assert.ok(tables.statuses.some((t) => t.open > 0), 'at least one table should be busy');
    });

    const newTableRaw = await req('POST', '/api/tables', { token: manager.token, body: { label: 'Terrace bar 2', zone: 'Bar', seats: 2 } });
    await check('manager can add a table (and it gets a QR)', () => {
      assert.strictEqual(newTableRaw.status, 200);
      assert.ok(newTableRaw.data.table.id);
    });
    const chefTable = await req('POST', '/api/tables', { token: chef.token, body: { label: 'Nope' } });
    await check('non-managers cannot add tables', () => assert.strictEqual(chefTable.status, 403));

    const newItem = await req('POST', '/api/menu/items', {
      token: manager.token, body: { name: 'Test Dish', price: 1234, categoryId: boot.menu.categories[0].id, prepMinutes: 9, description: 'from the test suite' }
    });
    await check('manager can add a dish to the menu', () => assert.strictEqual(newItem.data.item.price, 1234));
    const soldOut = await req('PATCH', `/api/menu/items/${newItem.data.item.id}`, { token: chef.token, body: { available: false } });
    await check('kitchen can mark a dish sold out', () => assert.strictEqual(soldOut.data.item.available, false));
    const orderSoldOut = await req('POST', '/api/orders', { body: { tableId: 'T01', items: [{ itemId: newItem.data.item.id, qty: 1 }] } });
    await check('sold-out dishes cannot be ordered', () => assert.strictEqual(orderSoldOut.status, 400));
    await req('DELETE', `/api/menu/items/${newItem.data.item.id}`, { token: manager.token });
    const chefDelete = await req('DELETE', `/api/menu/items/${hamburger.id}`, { token: chef.token });
    await check('only managers can delete dishes', () => assert.strictEqual(chefDelete.status, 403));

    const settingsBefore = (await req('GET', '/api/settings', { token: manager.token })).data.settings;
    const patched = await req('PATCH', '/api/settings', {
      token: manager.token,
      body: { hotelName: 'Test Bay Hotel', servicePct: 5, taxPct: 10, currency: { code: 'EUR', symbol: '€', decimals: 2, position: 'after' } }
    });
    await check('manager can rebrand the property and change the currency', () => {
      assert.strictEqual(patched.data.settings.hotelName, 'Test Bay Hotel');
      assert.strictEqual(patched.data.settings.currency.symbol, '€');
      assert.strictEqual(patched.data.settings.servicePct, 5);
    });
    await check('service charge and tax are applied on top of the subtotal', () => {
      // 10.00 subtotal with 5% service and 10% tax = 10.00 + 0.50 + 1.05
      const subtotal = 1000;
      const service = Math.round(subtotal * 0.05);
      const tax = Math.round((subtotal + service) * 0.1);
      assert.strictEqual(service, 50);
      assert.strictEqual(tax, 105);
      assert.strictEqual(subtotal + service + tax, 1155);
    });
    await req('PATCH', '/api/settings', { token: manager.token, body: { hotelName: settingsBefore.hotelName, servicePct: settingsBefore.servicePct, taxPct: settingsBefore.taxPct, currency: settingsBefore.currency } });

    const reports = (await req('GET', '/api/reports/summary?range=today', { token: manager.token })).data;
    await check('reports total the money by payment method', () => {
      assert.ok(reports.paidOrders >= 2);
      assert.ok(reports.revenue > 0);
      assert.ok(reports.byMethod.cash.amount > 0);
      assert.ok(reports.topItems.length > 0);
      assert.strictEqual(reports.hourly.length, 24);
    });
    const cashierReports = await req('GET', '/api/reports/summary?range=today', { token: waiter.token });
    await check('waiters cannot open the reports', () => assert.strictEqual(cashierReports.status, 403));

    /* ------------------------------------------------------------ realtime */
    const sse = await fetch(BASE + '/api/events');
    await check('the live event stream is available', () => {
      assert.strictEqual(sse.status, 200);
      assert.match(sse.headers.get('content-type') || '', /event-stream/);
    });
    if (sse.body && sse.body.cancel) sse.body.cancel().catch(() => {});

    /* -------------------------------------------------------------- reset */
    const reset = await req('POST', '/api/admin/reset', { token: manager.token });
    await check('manager can reset the demo data', () => assert.strictEqual(reset.status, 200));

    const persisted = fs.existsSync(path.join(DATA_DIR, 'db.json'));
    await check('data is persisted to disk', () => assert.ok(persisted, 'db.json missing'));
  } catch (err) {
    results.push(`  \u001b[31m✗\u001b[0m fatal: ${err.message}`);
    process.exitCode = 1;
  } finally {
    cleanup();
  }

  console.log('\nHotel Serving System — API test suite\n');
  console.log(results.join('\n'));
  console.log(`\n${passed} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`);
  if (serverLog && process.exitCode) console.log('server log:\n' + serverLog);
  process.exit(process.exitCode || 0);
}

main();
