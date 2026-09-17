/* ============================================================================
   Staff console — cashier, kitchen, waiter and manager screens.
   One page, role-aware tabs, live refresh over SSE.
   ========================================================================== */
'use strict';

(() => {
  const {
    $, $$, esc, money, toMinor, clockTime, elapsed, secondsSince, toast, api, session,
    status, ITEM_STATUS, on, modal, closeModal, live, ping, badge
  } = HSS;

  const state = {
    snap: null,
    tab: null,
    pin: '',
    role: 'cashier',
    lastSeenOrderIds: new Set(),
    firstLoad: true,
    busy: false
  };

  /* =========================================================== login screen */

  const KNOWN_PINS = { cashier: '1111', chef: '2222', waiter: '3333', manager: '9999' };

  function renderPinDots() {
    $('#pinDots').innerHTML = [0, 1, 2, 3].map((i) => `<span class="pin-dot ${i < state.pin.length ? 'filled' : ''}"></span>`).join('');
  }

  function renderKeypad() {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
    $('#keypad').innerHTML = keys.map((k) => {
      if (k === 'clear') return '<button class="ghost" data-key="clear" type="button">Clear</button>';
      if (k === 'back') return '<button class="ghost" data-key="back" type="button">⌫</button>';
      return `<button data-key="${k}" type="button">${k}</button>`;
    }).join('');
  }

  function pressKey(k) {
    if (k === 'clear') state.pin = '';
    else if (k === 'back') state.pin = state.pin.slice(0, -1);
    else if (state.pin.length < 6) state.pin += k;
    renderPinDots();
    if (state.pin.length >= 4) $('#pinHint').textContent = 'Press sign in';
  }

  async function doLogin() {
    const pin = state.pin;
    if (pin.length < 4) return toast('Enter your 4-digit PIN', 'warn');
    try {
      const res = await api('/api/auth/login', { method: 'POST', body: { pin } });
      session.save(res.token, res.staff);
      state.pin = '';
      toast(`Welcome, ${res.staff.name}`, 'ok');
      startConsole();
    } catch (err) {
      state.pin = '';
      renderPinDots();
      toast(err.message, 'err');
      $('#pinHint').textContent = 'Try again — check with the manager if you forgot your PIN';
    }
  }

  async function initLogin() {
    $('#loginView').hidden = false;
    renderPinDots();
    renderKeypad();
    try {
      const boot = await api('/api/bootstrap');
      HSS.setSettings(boot.settings);
      $('#loginHotel').textContent = boot.settings.hotelName;
      $('#loginMark').textContent = boot.settings.hotelName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
      if (boot.settings.demoMode) {
        const box = $('#demoPins');
        box.hidden = false;
        box.innerHTML = 'Demo PINs — ' + Object.entries(KNOWN_PINS)
          .map(([r, p]) => `<button class="chip" data-demo-pin="${p}" type="button" style="cursor:pointer">${r}: ${p}</button>`)
          .join(' ');
      }
    } catch { /* offline — the PIN pad still works once the server is back */ }
  }

  on(document, 'click', '[data-key]', (el) => pressKey(el.dataset.key));
  on(document, 'click', '[data-demo-pin]', (el) => {
    state.pin = el.dataset.demoPin;
    renderPinDots();
    $('#pinHint').textContent = 'Press sign in';
  });
  $('#loginBtn').addEventListener('click', doLogin);
  document.addEventListener('keydown', (e) => {
    if ($('#consoleView').hidden) {
      if (/^[0-9]$/.test(e.key)) pressKey(e.key);
      else if (e.key === 'Backspace') pressKey('back');
      else if (e.key === 'Enter') doLogin();
    }
  });

  /* ============================================================ console boot */

  const TABS = {
    cashier: [
      { id: 'orders', label: '🧾 Orders', render: renderCashierOrders },
      { id: 'floor', label: '🍽 Floor map', render: renderFloor },
      { id: 'money', label: '💳 Settle & receipts', render: renderMoney }
    ],
    chef: [
      { id: 'kitchen', label: '🔥 Kitchen board', render: renderKitchenBoard },
      { id: 'tickets', label: '🎫 All tickets', render: renderKitchenTickets }
    ],
    waiter: [
      { id: 'serve', label: '🛎 Ready to serve', render: renderServe },
      { id: 'floor', label: '🍽 My tables', render: renderFloor },
      { id: 'money', label: '💳 Bills', render: renderMoney }
    ],
    manager: [
      { id: 'overview', label: '📊 Overview', render: renderOverview },
      { id: 'orders', label: '🧾 Orders', render: renderCashierOrders },
      { id: 'kitchen', label: '🔥 Kitchen', render: renderKitchenBoard },
      { id: 'floor', label: '🍽 Floor', render: renderFloor },
      { id: 'money', label: '💳 Money', render: renderMoney }
    ]
  };

  function role() { return (session.staff && session.staff.role) || 'cashier'; }

  function startConsole() {
    $('#loginView').hidden = true;
    $('#consoleView').hidden = false;
    const staff = session.staff;
    $('#whoChip').innerHTML = `👤 ${esc(staff.name)} · <strong>${esc(staff.role)}</strong>`;
    if (staff.role === 'manager') $('#adminLink').hidden = false;
    state.tab = TABS[staff.role] ? TABS[staff.role][0].id : 'orders';
    renderTabs();
    refresh();
    live(onChange, onLiveState);
    setInterval(() => { if (state.snap && !state.busy) renderCurrent(); }, 20000);
  }

  function renderTabs() {
    const tabs = TABS[role()] || TABS.cashier;
    $('#tabs').innerHTML = tabs.map((t) => `<button class="tab ${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}" type="button">${t.label}</button>`).join('');
  }

  on(document, 'click', '[data-tab]', (el) => {
    state.tab = el.dataset.tab;
    renderTabs();
    renderCurrent();
  });

  async function refresh() {
    try {
      const snap = await api('/api/snapshot', { auth: true });
      applySnapshot(snap);
    } catch (err) {
      if (err.status === 401) {
        session.clear();
        location.reload();
      } else {
        toast(err.message, 'err');
      }
    }
  }

  function applySnapshot(snap) {
    const prevOpen = state.snap ? new Set(state.snap.orders.filter((o) => o.status !== 'completed').map((o) => o.id)) : null;
    state.snap = snap;
    HSS.setSettings(snap.settings);
    $('#brandHotel').textContent = snap.settings.hotelName;
    $('#brandSub').textContent = `${snap.settings.restaurantName} · ${(session.staff || {}).name || ''}`;
    $('#brandMark').textContent = snap.settings.hotelName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    $('#demoBtn').hidden = !snap.settings.demoMode;

    if (!state.firstLoad && prevOpen) {
      const fresh = snap.orders.filter((o) => o.status === 'awaiting_cashier' && !prevOpen.has(o.id));
      if (fresh.length && role() !== 'guest') {
        ping('order');
        toast(`New order ${fresh[0].id} from ${fresh[0].tableLabel}`, 'ok', 5000);
        if ('vibrate' in navigator) navigator.vibrate?.(120);
      }
      const readyNow = snap.orders.filter((o) => o.status === 'ready' && !prevOpen.has(o.id));
      if (readyNow.length && role() === 'waiter') {
        ping('ready');
        toast(`${readyNow[0].id} is ready to serve`, 'warn', 5000);
      }
      const billAsked = snap.orders.filter((o) => o.flags.billRequested && o.payment.status !== 'paid');
      if (billAsked.length && (role() === 'waiter' || role() === 'cashier')) {
        // one gentle nudge per refresh cycle
        if (!state.billNudged || state.billNudged !== billAsked.map((o) => o.id).join(',')) {
          state.billNudged = billAsked.map((o) => o.id).join(',');
          ping('bill');
          toast(`${billAsked.length} bill request(s) waiting`, 'warn', 4200);
        }
      }
    }
    state.firstLoad = false;
    renderCurrent();
  }

  function onChange(ev) {
    if (ev.entity === 'order' || ev.entity === 'menu' || ev.entity === 'tables' || ev.entity === 'settings') refresh();
  }

  function onLiveState(s) {
    const dot = $('#liveDot');
    if (!dot) return;
    dot.className = 'dot ' + (s === 'live' ? 'live' : s === 'poll' ? 'warn' : 'bad');
    $('#liveChip').lastChild.textContent = s === 'live' ? ' live' : s === 'poll' ? ' polling' : ' reconnecting…';
  }

  function renderCurrent() {
    if (!state.snap) return;
    const tabs = TABS[role()] || TABS.cashier;
    const tab = tabs.find((t) => t.id === state.tab) || tabs[0];
    const y = window.scrollY;
    $('#view').innerHTML = tab.render();
    window.scrollTo(0, y);
  }

  /* ================================================================ helpers */

  const openOrders = () => (state.snap ? state.snap.orders.filter((o) => ['awaiting_cashier', 'in_kitchen', 'preparing', 'ready', 'served'].includes(o.status)) : []);
  const debt = (o) => o.totals.total;

  function orderCard(o, actions) {
    const s = status(o.status);
    const unpaid = o.payment.status !== 'paid';
    const lines = o.items.map((it) => {
      const m = ITEM_STATUS[it.status] || { tone: 'muted' };
      const done = o.status === 'awaiting_cashier' ? false : it.status === 'served';
      return `<div class="item-line">
        <span class="item-qty">${it.qty}×</span>
        <div style="flex:1;min-width:0">
          <div class="item-name ${done ? 'item-served' : ''}">${esc(it.name)}</div>
          ${it.notes ? `<div class="item-note">✎ ${esc(it.notes)}</div>` : ''}
        </div>
        <div class="item-right">
          <div>${money(it.price * it.qty)}</div>
          ${o.status !== 'awaiting_cashier' ? `<span class="badge ${m.tone}">${esc((ITEM_STATUS[it.status] || {}).label || it.status)}</span>` : ''}
        </div>
      </div>`;
    }).join('');

    return `
      <article class="order-card st-${o.status}" data-order="${esc(o.id)}">
        <div class="order-head">
          <span class="id">${esc(o.id)}</span>
          ${badge(o.tableLabel, 'accent')}
          ${o.round > 1 ? badge('Round ' + o.round, 'muted') : ''}
          <span class="spacer"></span>
          ${badge(s.short, s.tone)}
          ${unpaid ? badge(money(debt(o)) + ' due', 'warn') : badge(money(o.totals.total) + ' paid', 'good')}
        </div>
        <div class="order-body">
          <div class="tiny muted" style="margin-bottom:6px">
            ${o.guestName ? esc(o.guestName) + ' · ' : ''}${o.guests || '—'} guests ·
            placed ${clockTime(o.createdAt)} · waiting <strong>${elapsed(o.createdAt)}</strong>
            ${o.flags.billRequested ? ' · <span class="chip warn" style="font-size:11px">💳 bill requested</span>' : ''}
            ${o.flags.waiterCalled ? ' · <span class="chip warn" style="font-size:11px">🖐 waiter called</span>' : ''}
          </div>
          ${lines}
          ${o.notes ? `<div class="tiny" style="margin-top:8px;color:var(--warn)">📝 ${esc(o.notes)}</div>` : ''}
          ${o.discountPct ? `<div class="tiny" style="margin-top:6px">Discount ${o.discountPct}% → ${money(o.totals.discount)} off</div>` : ''}
        </div>
        ${actions ? `<div class="order-foot">${actions}</div>` : ''}
      </article>`;
  }

  function kpi(label, value, sub, tone = '') {
    return `<div class="kpi ${tone}"><div class="k-label">${esc(label)}</div><div class="k-value">${value}</div><div class="k-sub">${sub || ''}</div></div>`;
  }

  function emptyBox(icon, text) {
    return `<div class="panel empty"><span class="icon">${icon}</span>${esc(text)}</div>`;
  }

  function openReceipt(id, autoPrint) {
    const url = `/receipt.html?o=${encodeURIComponent(id)}${autoPrint ? '&print=1' : ''}`;
    const w = window.open(url, '_blank');
    if (!w) location.href = url;
  }

  /* ============================================================= cashier UX */

  function renderCashierOrders() {
    const orders = state.snap.orders;
    const incoming = orders.filter((o) => o.status === 'awaiting_cashier');
    const live = orders.filter((o) => ['in_kitchen', 'preparing', 'ready', 'served'].includes(o.status));
    const closed = orders.filter((o) => ['completed', 'rejected', 'cancelled'].includes(o.status)).slice(0, 12);

    return `
      <div class="stack">
        <div class="grid grid-4">
          ${kpi('Waiting for approval', incoming.length, incoming.length ? 'Action needed now' : 'All clear', incoming.length ? 'warn' : '')}
          ${kpi('In progress', live.length, 'Kitchen → floor')}
          ${kpi('Unpaid bills', money(state.snap.stats.unpaid), 'across open tables', 'accent')}
          ${kpi('Today', money(state.snap.stats.today.revenue), state.snap.stats.today.paidOrders + ' settled orders', 'good')}
        </div>

        <section class="panel">
          <div class="panel-head">
            <h3>Incoming orders</h3>
            <span class="sub">guest → cashier</span>
            <span class="spacer"></span>
            ${incoming.length ? badge(incoming.length + ' waiting', 'warn', 'lg') : badge('none waiting', 'muted')}
          </div>
          <div class="panel-body">
            ${incoming.length
              ? `<div class="grid grid-2">${incoming.map((o) => orderCard(o, cashierActions(o))).join('')}</div>`
              : '<div class="empty"><span class="icon">✅</span>Nothing waiting — every order has been handled.</div>'}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>Orders being served</h3><span class="spacer"></span><span class="sub">${live.length} open</span></div>
          <div class="panel-body">
            ${live.length
              ? `<div class="grid grid-2">${live.map((o) => orderCard(o, cashierActions(o))).join('')}</div>`
              : '<div class="empty"><span class="icon">🍽️</span>No active orders on the floor.</div>'}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>Recently closed</h3></div>
          <div class="panel-body flush">
            ${closed.length ? `<table class="data">
              <thead><tr><th>Order</th><th>Table</th><th>Closed</th><th>Payment</th><th class="num">Total</th><th></th></tr></thead>
              <tbody>${closed.map((o) => `
                <tr>
                  <td class="mono">${esc(o.id)}</td>
                  <td>${esc(o.tableLabel)}</td>
                  <td>${clockTime(o.closedAt || o.updatedAt)}</td>
                  <td>${o.status === 'completed'
                    ? badge(o.paymentMethodLabel || '—', 'good')
                    : badge(status(o.status).short, 'bad')}</td>
                  <td class="num">${money(o.totals.total)}</td>
                  <td class="right"><button class="btn btn-sm btn-ghost" data-act="print" data-id="${esc(o.id)}">🖨 Receipt</button></td>
                </tr>`).join('')}</tbody></table>`
              : '<div class="empty">No closed orders yet today.</div>'}
          </div>
        </section>
      </div>`;
  }

  function cashierActions(o) {
    if (o.status === 'awaiting_cashier') {
      return `<button class="btn btn-primary" data-act="accept" data-id="${esc(o.id)}">✅ Approve → kitchen</button>
              <button class="btn btn-good" data-act="pay" data-id="${esc(o.id)}">💳 Take payment</button>
              <button class="btn btn-ghost" data-act="edit" data-id="${esc(o.id)}">✎ Edit</button>
              <button class="btn btn-bad" data-act="reject" data-id="${esc(o.id)}">⛔ Reject</button>`;
    }
    if (o.payment.status !== 'paid') {
      return `<button class="btn btn-good" data-act="pay" data-id="${esc(o.id)}">💳 Take payment · ${money(debt(o))}</button>
              <button class="btn btn-ghost" data-act="discount" data-id="${esc(o.id)}">% Discount</button>
              <button class="btn btn-ghost" data-act="print" data-id="${esc(o.id)}">🖨 Pro-forma bill</button>`;
    }
    return `<button class="btn btn-ghost" data-act="print" data-id="${esc(o.id)}">🖨 Receipt</button>
            <button class="btn btn-ghost" data-act="detail" data-id="${esc(o.id)}">👁 Details</button>`;
  }

  /* ============================================================== kitchen UX */

  function kitchenCard(o, mode) {
    const wait = elapsed(o.kitchenStartAt || o.acceptedAt || o.createdAt);
    const mins = Math.round(secondsSince(o.kitchenStartAt || o.acceptedAt || o.createdAt) / 60);
    const urgent = mins >= 20 ? 'bad' : mins >= 12 ? 'warn' : '';
    return `
      <article class="order-card st-${o.status}" data-order="${esc(o.id)}" style="margin-bottom:10px">
        <div class="order-head">
          <span class="id">${esc(o.id)}</span>
          ${badge(o.tableLabel, 'accent')}
          ${o.round > 1 ? badge('R' + o.round, 'muted') : ''}
          <span class="spacer"></span>
          ${badge(wait + (urgent === 'bad' ? ' 🔥' : ''), urgent || 'muted')}
        </div>
        <div class="order-body">
          ${o.items.map((it) => `
            <div class="item-line">
              <span class="item-qty">${it.qty}×</span>
              <div style="flex:1;min-width:0">
                <div class="item-name ${it.status === 'served' ? 'item-served' : ''}">${esc(it.name)}</div>
                ${it.notes ? `<div class="item-note">✎ ${esc(it.notes)}</div>` : ''}
              </div>
              <div class="item-right">
                ${it.status === 'queued' ? `<button class="btn btn-sm" data-act="item-cook" data-id="${esc(o.id)}" data-item="${esc(it.id)}">Start</button>` : ''}
                ${it.status === 'cooking' ? `<button class="btn btn-sm btn-primary" data-act="item-ready" data-id="${esc(o.id)}" data-item="${esc(it.id)}">Ready</button>` : ''}
                ${it.status === 'ready' ? badge('Ready', 'good') : ''}
                ${it.status === 'served' ? badge('Served', 'muted') : ''}
              </div>
            </div>`).join('')}
          ${o.notes ? `<div class="tiny" style="margin-top:8px;color:var(--warn)">📝 ${esc(o.notes)}</div>` : ''}
        </div>
        <div class="order-foot">
          ${mode === 'queued' ? `<button class="btn btn-primary" data-act="cook-start" data-id="${esc(o.id)}">🔥 Start cooking</button>` : ''}
          ${mode === 'cooking' ? `<button class="btn btn-good" data-act="cook-ready" data-id="${esc(o.id)}">🔔 All ready</button>
                                 <button class="btn btn-ghost" data-act="cook-recall" data-id="${esc(o.id)}">↩ Recall</button>` : ''}
          ${mode === 'ready' ? `<button class="btn btn-ghost" data-act="cook-recall" data-id="${esc(o.id)}">↩ Back to cooking</button>
                               <span class="chip good">waiting for a waiter</span>` : ''}
        </div>
      </article>`;
  }

  function renderKitchenBoard() {
    const orders = state.snap.orders.filter((o) => ['in_kitchen', 'preparing', 'ready'].includes(o.status));
    const queued = orders.filter((o) => o.status === 'in_kitchen');
    const cooking = orders.filter((o) => o.status === 'preparing');
    const ready = orders.filter((o) => o.status === 'ready');
    return `
      <div class="row" style="margin-bottom:12px">
        <span class="chip dim">Board refreshes live</span>
        <span class="chip warn">${queued.length} waiting</span>
        <span class="chip accent">${cooking.length} cooking</span>
        <span class="chip good">${ready.length} ready</span>
      </div>
      <div class="kanban">
        <div class="kan-col">
          <h3>🕐 To start <span class="count">${queued.length}</span></h3>
          ${queued.map((o) => kitchenCard(o, 'queued')).join('') || '<div class="empty tiny">Nothing waiting</div>'}
        </div>
        <div class="kan-col">
          <h3>🔥 Cooking <span class="count">${cooking.length}</span></h3>
          ${cooking.map((o) => kitchenCard(o, 'cooking')).join('') || '<div class="empty tiny">Nothing on the stove</div>'}
        </div>
        <div class="kan-col">
          <h3>🔔 Ready to serve <span class="count">${ready.length}</span></h3>
          ${ready.map((o) => kitchenCard(o, 'ready')).join('') || '<div class="empty tiny">Nothing waiting for the floor</div>'}
        </div>
      </div>`;
  }

  function renderKitchenTickets() {
    const orders = state.snap.orders.filter((o) => ['in_kitchen', 'preparing', 'ready'].includes(o.status));
    if (!orders.length) return emptyBox('🍳', 'No kitchen tickets right now.');
    return `<div class="grid grid-2">${orders.map((o) => kitchenCard(o, o.status === 'in_kitchen' ? 'queued' : o.status === 'preparing' ? 'cooking' : 'ready')).join('')}</div>`;
  }

  /* =============================================================== waiter UX */

  function renderServe() {
    const ready = state.snap.orders.filter((o) => o.status === 'ready');
    const cooking = state.snap.orders.filter((o) => ['in_kitchen', 'preparing'].includes(o.status));
    const served = state.snap.orders.filter((o) => o.status === 'served');
    return `
      <div class="stack">
        <div class="grid grid-4">
          ${kpi('Ready to serve', ready.length, ready.length ? 'Pick these up now' : 'Nothing on the pass', ready.length ? 'good' : '')}
          ${kpi('Cooking', cooking.length, 'kitchen working')}
          ${kpi('My open tables', openOrders().length, 'orders on the floor')}
          ${kpi('Bills to settle', money(state.snap.stats.unpaid), 'unpaid total', 'accent')}
        </div>

        <section class="panel">
          <div class="panel-head"><h3>🔔 On the pass — serve these</h3><span class="spacer"></span>${ready.length ? badge(ready.length + ' orders', 'good', 'lg') : badge('clear', 'muted')}</div>
          <div class="panel-body">
            ${ready.length
              ? `<div class="grid grid-2">${ready.map((o) => orderCard(o, serveActions(o))).join('')}</div>`
              : '<div class="empty"><span class="icon">🛎️</span>Nothing ready yet — watch this space.</div>'}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>In the kitchen</h3><span class="spacer"></span><span class="sub">${cooking.length}</span></div>
          <div class="panel-body">
            ${cooking.length ? `<div class="grid grid-2">${cooking.map((o) => orderCard(o, `<button class="btn btn-ghost" data-act="detail" data-id="${esc(o.id)}">👁 Details</button>`)).join('')}</div>`
              : '<div class="empty">Kitchen is clear.</div>'}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>Served — bills outstanding</h3></div>
          <div class="panel-body">
            ${served.length ? `<div class="grid grid-2">${served.map((o) => orderCard(o, serveActions(o))).join('')}</div>`
              : '<div class="empty">No served tables waiting to pay.</div>'}
          </div>
        </section>
      </div>`;
  }

  function serveActions(o) {
    if (o.status === 'ready') {
      return `<button class="btn btn-good" data-act="serve" data-id="${esc(o.id)}">✅ Serve everything</button>
              <button class="btn btn-ghost" data-act="detail" data-id="${esc(o.id)}">👁 Items</button>
              ${o.payment.status !== 'paid' ? `<button class="btn btn-ghost" data-act="pay" data-id="${esc(o.id)}">💳 Settle</button>` : ''}`;
    }
    if (o.payment.status !== 'paid') {
      return `<button class="btn btn-good" data-act="pay" data-id="${esc(o.id)}">💳 Settle ${money(debt(o))}</button>
              <button class="btn btn-ghost" data-act="print" data-id="${esc(o.id)}">🖨 Bill</button>
              <button class="btn btn-ghost" data-act="detail" data-id="${esc(o.id)}">👁 Details</button>`;
    }
    return `<button class="btn btn-ghost" data-act="print" data-id="${esc(o.id)}">🖨 Receipt</button>`;
  }

  /* ================================================================ floor UX */

  function renderFloor() {
    const tables = state.snap.tables.slice().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const zones = Array.from(new Set(tables.map((t) => t.zone || 'Other')));
    const busy = tables.filter((t) => t.status !== 'free').length;
    return `
      <div class="stack">
        <div class="grid grid-4">
          ${kpi('Tables', tables.length, zones.length + ' zones')}
          ${kpi('Occupied', busy, tables.length - busy + ' free')}
          ${kpi('Open orders', state.snap.stats.open, 'on the floor')}
          ${kpi('Unpaid', money(state.snap.stats.unpaid), 'open bills', 'accent')}
        </div>
        ${zones.map((zone) => `
          <section class="panel">
            <div class="panel-head"><h3>${esc(zone)}</h3><span class="spacer"></span>
              <span class="sub">${tables.filter((t) => (t.zone || 'Other') === zone && t.status !== 'free').length} busy</span></div>
            <div class="panel-body">
              <div class="floor-grid">
                ${tables.filter((t) => (t.zone || 'Other') === zone).map((t) => {
                  const s = t.status === 'free' ? null : status(t.status);
                  return `<button class="table-tile st-${t.status}" data-act="table" data-id="${esc(t.id)}" type="button">
                    <span class="t-name">${esc(t.label)}</span>
                    <span class="t-zone">${t.seats} seats${t.open ? ' · ' + t.open + ' order(s)' : ''}</span>
                    <span class="t-status">${s ? esc(s.short) : 'Free'}</span>
                    ${t.unpaid ? `<span class="tiny" style="color:var(--warn)">${money(t.unpaid)} due</span>` : ''}
                  </button>`;
                }).join('')}
              </div>
            </div>
          </section>`).join('')}
      </div>`;
  }

  /* =============================================================== money tab */

  function renderMoney() {
    const unpaid = state.snap.orders.filter((o) => ['in_kitchen', 'preparing', 'ready', 'served'].includes(o.status) && o.payment.status !== 'paid');
    const paidToday = state.snap.orders.filter((o) => o.payment.status === 'paid');
    const today = state.snap.stats.today;
    const methods = state.snap.settings.payMethods || [];
    return `
      <div class="stack">
        <div class="grid grid-4">
          ${kpi('Unpaid open bills', money(state.snap.stats.unpaid), unpaid.length + ' bills', 'warn')}
          ${kpi('Today revenue', money(today.revenue), today.paidOrders + ' paid orders', 'good')}
          ${kpi('Average ticket', money(today.avgTicket), 'per paid order')}
          ${kpi('Live orders', state.snap.stats.open, 'on the floor')}
        </div>

        <div class="grid grid-2" style="align-items:start">
          <section class="panel">
            <div class="panel-head"><h3>Bills to settle</h3><span class="spacer"></span>${unpaid.length ? badge(unpaid.length + ' open', 'warn', 'lg') : badge('all settled', 'good')}</div>
            <div class="panel-body flush">
              ${unpaid.length ? `<table class="data">
                <thead><tr><th>Order</th><th>Table</th><th>Status</th><th class="num">Total</th><th></th></tr></thead>
                <tbody>${unpaid.map((o) => `<tr>
                  <td class="mono">${esc(o.id)}</td>
                  <td>${esc(o.tableLabel)}</td>
                  <td>${badge(status(o.status).short, status(o.status).tone)}</td>
                  <td class="num"><strong>${money(o.totals.total)}</strong></td>
                  <td class="right"><button class="btn btn-sm btn-good" data-act="pay" data-id="${esc(o.id)}">💳 Take payment</button></td>
                </tr>`).join('')}</tbody></table>` : '<div class="empty"><span class="icon">🎉</span>Every open bill is settled.</div>'}
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>Today by payment method</h3></div>
            <div class="panel-body">
              ${methods.map((m) => {
                const row = (today.byMethod || {})[m.id] || { count: 0, amount: 0 };
                const pct = today.revenue ? Math.round((row.amount / today.revenue) * 100) : 0;
                return `<div class="bar-row" style="margin-bottom:9px">
                  <span class="truncate">${esc(m.label)}</span>
                  <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
                  <span class="right mono">${money(row.amount)}<br><span class="tiny muted">${row.count}×</span></span>
                </div>`;
              }).join('')}
              <div class="divider"></div>
              <div class="row">
                <a class="btn btn-sm" href="/admin.html#reports">📈 Full reports</a>
                <button class="btn btn-sm btn-ghost" data-act="print-sheet">🖨 Print QR sheet</button>
              </div>
            </div>
          </section>
        </div>

        <section class="panel">
          <div class="panel-head"><h3>Paid today</h3><span class="spacer"></span><span class="sub">${paidToday.length} receipts</span></div>
          <div class="panel-body flush">
            ${paidToday.length ? `<table class="data">
              <thead><tr><th>Order</th><th>Table</th><th>Paid</th><th>Method</th><th>By</th><th class="num">Total</th><th></th></tr></thead>
              <tbody>${paidToday.map((o) => `<tr>
                <td class="mono">${esc(o.id)}</td>
                <td>${esc(o.tableLabel)}</td>
                <td>${clockTime(o.payment.paidAt)}</td>
                <td>${badge(o.paymentMethodLabel || '—', 'info')}</td>
                <td>${esc(o.payment.byStaff || '—')}</td>
                <td class="num">${money(o.totals.total)}</td>
                <td class="right"><button class="btn btn-sm btn-ghost" data-act="print" data-id="${esc(o.id)}">🖨 Receipt</button></td>
              </tr>`).join('')}</tbody></table>` : '<div class="empty">No payments taken today yet.</div>'}
          </div>
        </section>
      </div>`;
  }

  /* ============================================================== overview */

  function renderOverview() {
    const s = state.snap;
    const waiting = s.orders.filter((o) => o.status === 'awaiting_cashier');
    const readyOrders = s.orders.filter((o) => o.status === 'ready');
    const bills = s.orders.filter((o) => o.flags.billRequested && o.payment.status !== 'paid');
    return `
      <div class="stack">
        <div class="grid grid-4">
          ${kpi('Open orders', s.stats.open, s.stats.inKitchen + ' in kitchen', '')}
          ${kpi('Waiting approval', s.stats.awaitingCashier, waiting.length ? 'cashier action' : 'clear', waiting.length ? 'warn' : '')}
          ${kpi('Ready to serve', s.stats.ready, readyOrders.length ? 'waiters needed' : 'clear', s.stats.ready ? 'good' : '')}
          ${kpi('Today revenue', money(s.stats.today.revenue), s.stats.today.paidOrders + ' settled', 'good')}
        </div>
        ${waiting.length ? `<section class="panel"><div class="panel-head"><h3>⚠️ Needs a cashier</h3></div><div class="panel-body"><div class="grid grid-2">${waiting.map((o) => orderCard(o, cashierActions(o))).join('')}</div></div></section>` : ''}
        ${readyOrders.length ? `<section class="panel"><div class="panel-head"><h3>🔔 Ready to serve</h3></div><div class="panel-body"><div class="grid grid-2">${readyOrders.map((o) => orderCard(o, serveActions(o))).join('')}</div></div></section>` : ''}
        ${bills.length ? `<section class="panel"><div class="panel-head"><h3>💳 Guests waiting for the bill</h3></div><div class="panel-body"><div class="grid grid-2">${bills.map((o) => orderCard(o, cashierActions(o))).join('')}</div></div></section>` : ''}

        <section class="panel">
          <div class="panel-head"><h3>Today at a glance</h3><span class="spacer"></span><a class="btn btn-sm" href="/admin.html#reports">📈 Reports &amp; settings</a></div>
          <div class="panel-body">
            <div class="grid grid-3">
              <div>
                <div class="tiny muted">Orders today</div><div class="mono" style="font-size:20px">${s.stats.today.orders}</div>
                <div class="tiny muted" style="margin-top:8px">Paid orders</div><div class="mono" style="font-size:20px">${s.stats.today.paidOrders}</div>
              </div>
              <div>
                <div class="tiny muted">Revenue</div><div class="mono" style="font-size:20px">${money(s.stats.today.revenue)}</div>
                <div class="tiny muted" style="margin-top:8px">Average ticket</div><div class="mono" style="font-size:20px">${money(s.stats.today.avgTicket)}</div>
              </div>
              <div>
                <div class="tiny muted" style="margin-bottom:6px">By payment method</div>
                ${(s.settings.payMethods || []).map((m) => {
                  const row = (s.stats.today.byMethod || {})[m.id] || { count: 0, amount: 0 };
                  return `<div class="row" style="justify-content:space-between;font-size:13px"><span>${esc(m.label)}</span><span class="mono">${money(row.amount)} · ${row.count}×</span></div>`;
                }).join('')}
              </div>
            </div>
            <div class="divider"></div>
            <div class="row">
              <button class="btn btn-sm" data-act="demo-order">🎲 Simulate a guest order</button>
              <button class="btn btn-sm btn-ghost" data-act="print-sheet">🖨 Print all table QR codes</button>
              <button class="btn btn-sm btn-ghost" data-act="open-menu" >📱 Open guest menu</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>Open orders</h3><span class="spacer"></span><span class="sub">${openOrders().length}</span></div>
          <div class="panel-body">
            ${openOrders().length
              ? `<div class="grid grid-2">${openOrders().map((o) => orderCard(o, role() === 'manager' ? cashierActions(o) : '')).join('')}</div>`
              : '<div class="empty">No open orders right now.</div>'}
          </div>
        </section>
      </div>`;
  }

  /* ================================================================ actions */

  on(document, 'click', '[data-act]', async (el) => {
    const act = el.dataset.act;
    const id = el.dataset.id;
    const order = state.snap ? state.snap.orders.find((o) => o.id === id) : null;
    try {
      if (act === 'accept') return openAcceptModal(order);
      if (act === 'reject') return openRejectModal(order);
      if (act === 'pay') return openPaymentModal(order);
      if (act === 'discount') return openDiscountModal(order);
      if (act === 'print') return openReceipt(order.id, false);
      if (act === 'detail') return openDetailModal(order);
      if (act === 'edit') return openEditModal(order);
      if (act === 'table') return openTableModal(el.dataset.id);
      if (act === 'demo-order') return demoOrder();
      if (act === 'open-menu') return window.open('/menu.html', '_blank');
      if (act === 'print-sheet') return window.open('/admin.html#qr', '_blank');

      state.busy = true;
      el.setAttribute('aria-disabled', 'true');
      if (act === 'serve') {
        await api(`/api/orders/${id}/serve`, { method: 'POST', body: {}, auth: true });
        toast(`${id} served`, 'ok');
      } else if (act === 'cook-start') {
        await api(`/api/orders/${id}/kitchen`, { method: 'POST', body: { action: 'start' }, auth: true });
      } else if (act === 'cook-ready') {
        await api(`/api/orders/${id}/kitchen`, { method: 'POST', body: { action: 'ready' }, auth: true });
        toast(`${id} ready — waiters notified`, 'ok');
      } else if (act === 'cook-recall') {
        await api(`/api/orders/${id}/kitchen`, { method: 'POST', body: { action: 'recall' }, auth: true });
      } else if (act === 'item-cook' || act === 'item-ready') {
        const statusValue = act === 'item-cook' ? 'cooking' : 'ready';
        await api(`/api/orders/${id}/items/${el.dataset.item}/kitchen`, { method: 'POST', body: { status: statusValue }, auth: true });
      }
      await refresh();
    } catch (err) {
      toast(err.message, 'err', 5000);
    } finally {
      state.busy = false;
    }
  });

  /* -------------------------------------------------------------- modals */

  function orderSummary(o) {
    return `<div style="margin:10px 0 14px">
      <div class="row" style="margin-bottom:6px">${badge(o.tableLabel, 'accent')}${o.round > 1 ? badge('Round ' + o.round, 'muted') : ''}${badge(status(o.status).short, status(o.status).tone)}</div>
      ${o.items.map((it) => `<div class="bill-line"><span>${it.qty}× ${esc(it.name)}${it.notes ? ` <span class="item-note">(${esc(it.notes)})</span>` : ''}</span><span class="v">${money(it.price * it.qty)}</span></div>`).join('')}
      <div class="divider"></div>
      <div class="bill-line"><span>Subtotal</span><span class="v">${money(o.totals.subtotal)}</span></div>
      ${o.totals.discount ? `<div class="bill-line"><span>Discount (${o.discountPct}%)</span><span class="v">−${money(o.totals.discount)}</span></div>` : ''}
      ${o.totals.service ? `<div class="bill-line dim"><span>${esc(state.snap.settings.serviceLabel)} (${state.snap.settings.servicePct}%)</span><span class="v">${money(o.totals.service)}</span></div>` : ''}
      ${o.totals.tax ? `<div class="bill-line dim"><span>${esc(state.snap.settings.taxLabel)} (${state.snap.settings.taxPct}%)</span><span class="v">${money(o.totals.tax)}</span></div>` : ''}
      <div class="bill-line total"><span>Total</span><span class="v">${money(o.totals.total)}</span></div>
    </div>`;
  }

  function openAcceptModal(o) {
    const methods = state.snap.settings.payMethods || [];
    modal(`
      <h2>Approve ${esc(o.id)}</h2>
      <p class="tiny muted">${esc(o.tableLabel)} · ${o.items.length} lines · placed ${clockTime(o.createdAt)}</p>
      ${orderSummary(o)}
      <div class="field" style="margin-bottom:10px">
        <label>Payment</label>
        <div class="seg" data-seg="timing">
          <button type="button" class="active" data-timing="later">Bill at the end</button>
          <button type="button" data-timing="now">Take payment now</button>
        </div>
      </div>
      <div class="field" id="methodField" style="margin-bottom:10px">
        <label>Preferred / actual method</label>
        <select class="select" id="payMethod">
          <option value="">Decide later</option>
          ${methods.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field" id="tenderField" hidden style="margin-bottom:10px">
        <label>Cash received</label>
        <input class="input" id="tender" type="number" min="0" step="1" placeholder="${money(o.totals.total, { hideSymbol: true })}">
        <div class="tiny muted" id="changeOut"></div>
      </div>
      <div class="field" style="margin-bottom:6px">
        <label>Note for the kitchen (optional)</label>
        <input class="input" id="acceptNote" maxlength="200" value="${esc(o.notes || '')}">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Cancel</button>
        <button class="btn btn-primary" id="confirmAccept">✅ Approve → kitchen</button>
      </div>`, {
      onMount(host) {
        let timing = 'later';
        const methodSelect = $('#payMethod', host);
        const tenderField = $('#tenderField', host);
        const tender = $('#tender', host);
        const changeOut = $('#changeOut', host);

        function syncTender() {
          const isCash = timing === 'now' && methodSelect.value === 'cash';
          tenderField.hidden = !isCash;
          const received = toMinor(tender.value);
          if (isCash && received) {
            const diff = received - o.totals.total;
            changeOut.innerHTML = diff >= 0
              ? `Change: <strong>${money(diff)}</strong>`
              : `<span style="color:var(--bad)">Short by ${money(-diff)}</span>`;
          } else changeOut.textContent = '';
        }
        on(host, 'click', '[data-timing]', (btn) => {
          timing = btn.dataset.timing;
          $$('[data-timing]', host).forEach((b) => b.classList.toggle('active', b === btn));
          syncTender();
        });
        methodSelect.addEventListener('change', syncTender);
        tender.addEventListener('input', syncTender);

        $('#confirmAccept', host).addEventListener('click', async () => {
          try {
            await api(`/api/orders/${o.id}/decision`, {
              method: 'POST',
              auth: true,
              body: {
                action: 'accept',
                notes: $('#acceptNote', host).value,
                payment: { timing, method: methodSelect.value || undefined, tender: toMinor(tender.value) }
              }
            });
            closeModal();
            toast(`${o.id} sent to the kitchen`, 'ok');
            refresh();
          } catch (err) { toast(err.message, 'err', 5000); }
        });
      }
    });
  }

  function openRejectModal(o) {
    modal(`
      <h2>Reject ${esc(o.id)}</h2>
      <p class="tiny muted">${esc(o.tableLabel)} · ${money(o.totals.total)} — the guest will see this on their tracking page.</p>
      <div class="field" style="margin-top:12px">
        <label>Reason (shown to the guest)</label>
        <select class="select" id="reason">
          <option>Item sold out</option>
          <option>Table closed / bill already settled</option>
          <option>Duplicate order</option>
          <option>Guest left the table</option>
          <option>Other — see cashier</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Keep it</button>
        <button class="btn btn-bad" id="confirmReject">⛔ Reject order</button>
      </div>`, {
      onMount(host) {
        $('#confirmReject', host).addEventListener('click', async () => {
          try {
            await api(`/api/orders/${o.id}/decision`, { method: 'POST', auth: true, body: { action: 'reject', reason: $('#reason', host).value } });
            closeModal();
            toast(`${o.id} rejected`, 'warn');
            refresh();
          } catch (err) { toast(err.message, 'err'); }
        });
      }
    });
  }

  function openPaymentModal(o) {
    const s = state.snap.settings;
    const methods = s.payMethods || [];
    const total = o.totals.total;
    modal(`
      <h2>Take payment · ${money(total)}</h2>
      <p class="tiny muted">${esc(o.id)} · ${esc(o.tableLabel)}${o.payment.status === 'paid' ? ' · already paid' : ''}</p>
      ${orderSummary(o)}
      <div class="field" style="margin-bottom:10px">
        <label>Payment method</label>
        <div class="grid grid-2" id="methodGrid" style="gap:8px">
          ${methods.map((m, i) => `
            <button class="role-card ${i === 0 ? 'active' : ''}" data-method="${esc(m.id)}" data-needs-ref="${m.needsReference ? 1 : 0}" type="button">
              <strong>${esc(m.label)}</strong><span>${esc(m.detail || '')}</span>
            </button>`).join('')}
        </div>
      </div>
      <div id="tenderWrap" hidden class="field" style="margin-bottom:10px">
        <label>Cash received</label>
        <div class="row row-tight" style="margin-bottom:6px">
          <button class="btn btn-sm" data-tender="exact" type="button">Exact ${money(total)}</button>
          <button class="btn btn-sm" data-tender="up" type="button">Round up</button>
          <button class="btn btn-sm" data-tender="+50" type="button">+ 50</button>
          <button class="btn btn-sm" data-tender="+100" type="button">+ 100</button>
        </div>
        <input class="input" id="tender" type="number" min="0" step="1" placeholder="${(total / Math.pow(10, s.currency.decimals || 2)).toFixed(2)}">
        <div class="tiny" id="changeOut" style="min-height:18px"></div>
      </div>
      <div class="field" id="refWrap" hidden style="margin-bottom:10px">
        <label>Reference / room number</label>
        <input class="input" id="reference" maxlength="40" placeholder="e.g. TXN-88213 or room 204">
      </div>
      <div class="field" style="margin-bottom:6px">
        <label>Discount % (manager approval not required under 100%)</label>
        <input class="input" id="payDiscount" type="number" min="0" max="100" step="1" value="${o.discountPct || 0}">
      </div>
      <div class="switch" style="margin-top:8px">
        <input type="checkbox" id="printAfter" checked><label for="printAfter">Open the receipt for printing when done</label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Cancel</button>
        <button class="btn btn-good" id="confirmPay">✅ Confirm payment</button>
      </div>`, {
      onMount(host) {
        let method = methods.length ? methods[0].id : 'cash';
        const tenderWrap = $('#tenderWrap', host);
        const refWrap = $('#refWrap', host);
        const tender = $('#tender', host);
        const changeOut = $('#changeOut', host);

        function sync() {
          const m = methods.find((x) => x.id === method) || {};
          tenderWrap.hidden = method !== 'cash';
          refWrap.hidden = !m.needsReference;
          if (method === 'cash') {
            const received = toMinor(tender.value);
            changeOut.innerHTML = received
              ? (received >= total ? `Change: <strong>${money(received - total)}</strong>` : `<span style="color:var(--bad)">Short by ${money(total - received)}</span>`)
              : '';
          }
        }
        on(host, 'click', '[data-method]', (btn) => {
          method = btn.dataset.method;
          $$('[data-method]', host).forEach((b) => b.classList.toggle('active', b === btn));
          sync();
        });
        on(host, 'click', '[data-tender]', (btn) => {
          const d = s.currency.decimals || 2;
          const major = total / Math.pow(10, d);
          if (btn.dataset.tender === 'exact') tender.value = major.toFixed(d);
          if (btn.dataset.tender === 'up') tender.value = (Math.ceil(major / 5) * 5).toFixed(d);
          if (btn.dataset.tender === '+50') tender.value = (major + 50).toFixed(d);
          if (btn.dataset.tender === '+100') tender.value = (major + 100).toFixed(d);
          sync();
        });
        tender.addEventListener('input', sync);
        sync();

        $('#confirmPay', host).addEventListener('click', async () => {
          const btn = $('#confirmPay', host);
          btn.disabled = true;
          try {
            const discountPct = Number($('#payDiscount', host).value) || 0;
            if (discountPct !== (o.discountPct || 0)) {
              await api(`/api/orders/${o.id}`, { method: 'PATCH', auth: true, body: { discountPct } });
            }
            await api(`/api/orders/${o.id}/payment`, {
              method: 'POST',
              auth: true,
              body: { method, tender: toMinor(tender.value), reference: ($('#reference', host) || {}).value || '' }
            });
            const printAfter = $('#printAfter', host).checked;
            closeModal();
            toast(`${o.id} paid by ${(methods.find((m) => m.id === method) || {}).label}`, 'ok');
            refresh();
            if (printAfter || state.snap.settings.autoPrintOnPayment) openReceipt(o.id, true);
          } catch (err) {
            btn.disabled = false;
            toast(err.message, 'err', 5000);
          }
        });
      }
    }, { className: 'wide' });
  }

  function openDiscountModal(o) {
    modal(`
      <h2>Discount · ${esc(o.id)}</h2>
      <p class="tiny muted">${esc(o.tableLabel)} · subtotal ${money(o.totals.subtotal)}</p>
      <div class="field" style="margin:14px 0">
        <label>Discount percentage</label>
        <input class="input" id="disc" type="number" min="0" max="100" step="1" value="${o.discountPct || 0}">
      </div>
      <div class="row row-tight">
        ${[0, 5, 10, 15, 20].map((p) => `<button class="btn btn-sm" data-quick-disc="${p}" type="button">${p}%</button>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Cancel</button>
        <button class="btn btn-primary" id="saveDisc">Apply discount</button>
      </div>`, {
      onMount(host) {
        on(host, 'click', '[data-quick-disc]', (b) => { $('#disc', host).value = b.dataset.quickDisc; });
        $('#saveDisc', host).addEventListener('click', async () => {
          try {
            await api(`/api/orders/${o.id}`, { method: 'PATCH', auth: true, body: { discountPct: Number($('#disc', host).value) || 0 } });
            closeModal();
            toast('Discount applied', 'ok');
            refresh();
          } catch (err) { toast(err.message, 'err'); }
        });
      }
    });
  }

  function openEditModal(o) {
    const rows = o.items.map((it) => `
      <div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--line-soft)">
        <span>${esc(it.name)}</span>
        <div class="stepper">
          <button data-edit-dec="${esc(it.id)}" type="button">−</button>
          <span class="qty" data-qty="${esc(it.id)}">${it.qty}</span>
          <button data-edit-inc="${esc(it.id)}" type="button">+</button>
        </div>
      </div>`).join('');
    modal(`
      <h2>Edit order · ${esc(o.id)}</h2>
      <p class="tiny muted">Adjust quantities before approving. Set a line to 0 to remove it.</p>
      <div style="margin:12px 0" id="editRows">${rows}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Cancel</button>
        <button class="btn btn-primary" id="saveEdit">Save &amp; approve</button>
      </div>`, {
      onMount(host) {
        const qty = Object.fromEntries(o.items.map((it) => [it.id, it.qty]));
        const redraw = () => {
          for (const [k, v] of Object.entries(qty)) {
            const el = host.querySelector(`[data-qty="${k}"]`);
            if (el) el.textContent = v;
          }
        };
        on(host, 'click', '[data-edit-inc]', (b) => { qty[b.dataset.editInc] = Math.min(40, qty[b.dataset.editInc] + 1); redraw(); });
        on(host, 'click', '[data-edit-dec]', (b) => { qty[b.dataset.editDec] = Math.max(0, qty[b.dataset.editDec] - 1); redraw(); });
        $('#saveEdit', host).addEventListener('click', async () => {
          try {
            const items = Object.entries(qty).map(([id, q]) => ({ id, qty: q }));
            if (!items.some((i) => i.qty > 0)) return toast('Keep at least one item — or reject the order', 'warn');
            await api(`/api/orders/${o.id}/items`, { method: 'PATCH', auth: true, body: { items } });
            await api(`/api/orders/${o.id}/decision`, { method: 'POST', auth: true, body: { action: 'accept', payment: { timing: 'later' } } });
            closeModal();
            toast(`${o.id} approved after edits`, 'ok');
            refresh();
          } catch (err) { toast(err.message, 'err', 5000); }
        });
      }
    });
  }

  function openDetailModal(o) {
    modal(`
      <h2>${esc(o.id)} · ${esc(o.tableLabel)}</h2>
      <div class="row" style="margin:8px 0 12px">
        ${badge(status(o.status).short, status(o.status).tone)}
        ${badge(o.payment.status === 'paid' ? 'Paid · ' + (o.paymentMethodLabel || '') : 'Unpaid', o.payment.status === 'paid' ? 'good' : 'warn')}
        ${badge('waiting ' + elapsed(o.createdAt), 'muted')}
      </div>
      ${orderSummary(o)}
      <div class="divider"></div>
      <div class="timeline">
        ${o.timeline.map((t) => `<div class="tl-row"><span class="tl-time">${clockTime(t.at)}</span><span class="tl-dot"></span>
          <span><strong>${esc(t.status)}</strong> <span class="muted">— ${esc(t.note)} (${esc(t.by)})</span></span></div>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Close</button>
        <button class="btn" id="detailPrint">🖨 Bill</button>
        ${o.payment.status !== 'paid' ? `<button class="btn btn-good" id="detailPay">💳 Take payment</button>` : ''}
      </div>`, {
      onMount(host) {
        $('#detailPrint', host).addEventListener('click', () => openReceipt(o.id, false));
        const payBtn = $('#detailPay', host);
        if (payBtn) payBtn.addEventListener('click', () => { closeModal(); openPaymentModal(o); });
      }
    }, { className: 'wide' });
  }

  function openTableModal(tableId) {
    const t = state.snap.tables.find((x) => x.id === tableId);
    const orders = state.snap.orders.filter((o) => o.tableId === tableId && !['completed', 'rejected', 'cancelled'].includes(o.status));
    const history = state.snap.orders.filter((o) => o.tableId === tableId && ['completed'].includes(o.status)).slice(0, 4);
    modal(`
      <h2>${esc(t ? t.label : tableId)}</h2>
      <p class="tiny muted">${esc(t ? (t.zone || '') : '')} · ${t ? t.seats : '?'} seats · ${orders.length} open order(s)${t && t.unpaid ? ' · ' + money(t.unpaid) + ' unpaid' : ''}</p>
      <div style="margin-top:12px" class="stack-sm">
        ${orders.length ? orders.map((o) => orderCard(o, cashierActions(o))).join('') : '<div class="empty">This table has no open orders.</div>'}
      </div>
      ${history.length ? `<div class="divider"></div><div class="tiny muted">Earlier today</div>
        ${history.map((o) => `<div class="row" style="justify-content:space-between;font-size:13px;padding:3px 0">
          <span class="mono">${esc(o.id)}</span><span>${badge(o.paymentMethodLabel || '—', 'good')}</span><span class="mono">${money(o.totals.total)}</span>
          <button class="btn btn-sm btn-ghost" data-act="print" data-id="${esc(o.id)}">🖨</button></div>`).join('')}` : ''}
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Close</button>
        <a class="btn" href="/menu.html?table=${encodeURIComponent(tableId)}" target="_blank">📱 Open this table's menu</a>
      </div>`, { className: 'wide' });
  }

  async function demoOrder() {
    try {
      const res = await api('/api/demo/order', { method: 'POST', body: {} });
      toast(`Simulated order ${res.order.id} at ${res.table}`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  $('#demoBtn').addEventListener('click', demoOrder);
  $('#refreshBtn').addEventListener('click', () => { refresh(); toast('Refreshed', 'ok', 1200); });
  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', auth: true }); } catch { /* ignore */ }
    session.clear();
    location.reload();
  });

  /* ================================================================== start */

  if (session.token && session.staff) startConsole();
  else initLogin();
})();
