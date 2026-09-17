/* ============================================================================
   Guest order tracking — live status of one order, bill, waiter call.
   ========================================================================== */
'use strict';

(() => {
  const { $, esc, money, toast, api, status, ITEM_STATUS, PAY, clockTime, elapsed, on } = HSS;

  const token = new URLSearchParams(location.search).get('t') || '';
  const isNew = new URLSearchParams(location.search).has('new');
  let order = null;
  let currencyReady = false;

  const STEPS = [
    { key: 'awaiting_cashier', label: 'Placed' },
    { key: 'in_kitchen', label: 'Cashier' },
    { key: 'preparing', label: 'Cooking' },
    { key: 'ready', label: 'Ready' },
    { key: 'served', label: 'Served' },
    { key: 'completed', label: 'Paid' }
  ];

  async function load({ quiet = false } = {}) {
    if (!token) {
      $('#host').innerHTML = `<div class="panel panel-pad"><h2>No order selected</h2>
        <p class="muted">Open this page from the QR menu after sending an order, or scan the QR code on your table again.</p>
        <a class="btn btn-primary" href="/menu.html">Open the menu</a></div>`;
      return;
    }
    try {
      const data = await api('/api/public/order/' + encodeURIComponent(token));
      const first = !order;
      order = data.order;
      if (!currencyReady) {
        HSS.setSettings({ currency: order.hotel.currency });
        currencyReady = true;
      }
      render();
      if (first && isNew) HSS.ping('order');
      if (order.payment.status === 'paid' && (!state_prevPaid)) HSS.ping('ready');
      state_prevPaid = order.payment.status === 'paid';
    } catch (err) {
      if (!quiet) {
        $('#host').innerHTML = `<div class="panel panel-pad"><h2>Order not found</h2><p class="muted">${esc(err.message)}</p>
          <a class="btn btn-primary" href="/menu.html">Back to the menu</a></div>`;
      }
    }
  }
  let state_prevPaid = false;

  function render() {
    const s = status(order.status);
    const tt = order.totals;
    const currentStep = order.status === 'completed' ? 6 : Math.max(1, s.step);

    $('#hotelName').textContent = order.hotel.hotelName;
    $('#restName').textContent = order.hotel.restaurantName;
    $('#mark').textContent = order.hotel.hotelName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    document.title = `${order.id} · ${order.hotel.restaurantName}`;

    const paid = order.payment.status === 'paid';
    $('#host').innerHTML = `
      <section class="panel track-hero" style="margin-top:16px">
        <div class="icon">${s.icon}</div>
        <h1>${esc(s.label)}</h1>
        <p class="muted" style="margin:0">Order <span class="mono">${esc(order.id)}</span> · ${esc(order.tableLabel)} · placed ${clockTime(order.createdAt)} (${elapsed(order.createdAt)} ago)</p>
        ${order.status === 'rejected' ? `<p class="chip bad" style="margin-top:10px">Please speak to our team — this order was not accepted.</p>` : ''}
        ${order.flags.billRequested ? '<p class="chip warn" style="margin-top:10px">💳 Bill requested — your waiter is coming</p>' : ''}
        ${order.flags.waiterCalled ? '<p class="chip warn" style="margin-top:10px">🖐 Waiter called</p>' : ''}
      </section>

      <section class="panel panel-pad" style="margin-top:14px">
        <div class="progress-steps">
          ${STEPS.map((st, i) => `<div class="step ${i + 1 === currentStep ? 'current' : i + 1 < currentStep ? 'done' : ''}">${esc(st.label)}</div>`).join('')}
        </div>
      </section>

      <div class="grid grid-2" style="margin-top:14px;align-items:start">
        <section class="panel">
          <div class="panel-head"><h3>Your dishes</h3><span class="spacer"></span>
            ${order.round > 1 ? `<span class="badge muted">Round ${order.round}</span>` : ''}
          </div>
          <div class="panel-body">
            ${order.items.map((it) => {
              const m = ITEM_STATUS[it.status] || { label: it.status, tone: 'muted' };
              return `<div class="item-line">
                <span class="item-qty">${it.qty}×</span>
                <div style="flex:1;min-width:0">
                  <div class="item-name ${it.status === 'served' ? 'item-served' : ''}">${esc(it.name)}</div>
                  ${it.notes ? `<div class="item-note">✎ ${esc(it.notes)}</div>` : ''}
                </div>
                <div class="item-right">
                  <div>${money(it.price * it.qty)}</div>
                  <span class="badge ${m.tone}">${esc(m.label)}</span>
                </div>
              </div>`;
            }).join('')}
            ${order.notes ? `<p class="tiny muted" style="margin-top:10px">Note to kitchen: ${esc(order.notes)}</p>` : ''}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>Bill</h3><span class="spacer"></span>
            <span class="badge ${paid ? 'good' : 'warn'}">${paid ? 'Paid' : 'Not paid yet'}</span>
          </div>
          <div class="panel-body">
            <div class="bill-line"><span>Subtotal</span><span class="v">${money(tt.subtotal)}</span></div>
            ${tt.discount ? `<div class="bill-line"><span>Discount (${order.discountPct}%)</span><span class="v">− ${money(tt.discount)}</span></div>` : ''}
            ${tt.service ? `<div class="bill-line dim"><span>${esc(order.hotel.serviceLabel)} (${order.hotel.servicePct}%)</span><span class="v">${money(tt.service)}</span></div>` : ''}
            ${tt.tax ? `<div class="bill-line dim"><span>${esc(order.hotel.taxLabel)} (${order.hotel.taxPct}%)</span><span class="v">${money(tt.tax)}</span></div>` : ''}
            <div class="bill-line total"><span>Total</span><span class="v">${money(tt.total)}</span></div>

            <div class="divider"></div>
            <div class="tiny muted" style="margin-bottom:8px">Payment</div>
            ${paid
              ? `<p style="margin:0"><strong>${esc(order.payment.methodLabel || order.payment.method)}</strong> · paid ${clockTime(order.payment.paidAt)}${order.payment.reference ? ' · ref ' + esc(order.payment.reference) : ''}</p>`
              : '<p class="muted" style="margin:0">Pay your waiter or at the cashier: cash, card, mobile money, or charge it to your room.</p>'}
          </div>
          <div class="panel-foot row">
            ${paid
              ? `<a class="btn btn-good" href="/receipt.html?o=${encodeURIComponent(order.id)}&t=${encodeURIComponent(token)}">🧾 View receipt</a>`
              : '<button class="btn btn-primary" data-act="bill">💳 Ask for the bill</button>'}
            <button class="btn" data-act="waiter">🖐 Call the waiter</button>
          </div>
        </section>
      </div>

      <section class="panel" style="margin-top:14px">
        <div class="panel-head"><h3>What is happening</h3></div>
        <div class="panel-body timeline">
          ${order.timeline.slice().reverse().map((t) => `
            <div class="tl-row">
              <span class="tl-time">${clockTime(t.at)}</span>
              <span class="tl-dot"></span>
              <span><strong>${esc((HSS.status(t.status) || {}).short || t.status)}</strong>
                <span class="muted">— ${esc(t.note || t.by)}</span></span>
            </div>`).join('')}
        </div>
      </section>

      <div class="row" style="margin-top:16px;justify-content:center">
        <a class="btn btn-lg btn-primary" href="/menu.html">➕ Order something else</a>
      </div>
      <p class="tiny muted center" style="margin-top:14px">
        ${esc(order.hotel.restaurantName)} · ${esc(order.hotel.address)} · ${esc(order.hotel.phone)}
      </p>`;
  }

  on(document, 'click', '[data-act]', async (el) => {
    const kind = el.dataset.act === 'bill' ? 'bill' : 'waiter';
    try {
      await api('/api/public/order/' + encodeURIComponent(token) + '/flag', { method: 'POST', body: { kind } });
      toast(kind === 'bill' ? 'Your waiter is bringing the bill' : 'A waiter is on the way', 'ok');
      load({ quiet: true });
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // live updates: any order change re-checks this order (cheap, always current)
  HSS.live((ev) => {
    if (ev.entity === 'order') load({ quiet: true });
    if (ev.entity === 'settings') load({ quiet: true });
  }, (state) => {
    const dot = $('#liveDot');
    dot.className = 'dot ' + (state === 'live' ? 'live' : state === 'poll' ? 'warn' : 'bad');
    $('#liveChip').lastChild.textContent = state === 'live' ? ' live' : state === 'poll' ? ' updating' : ' reconnecting…';
  });

  setInterval(() => load({ quiet: true }), 20000);
  load();
})();
