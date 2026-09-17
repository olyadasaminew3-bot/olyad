/* ============================================================================
   Receipt / bill — printable A4 + 80mm thermal friendly.
   Opened by staff (session) or by the guest (order token).
   ========================================================================== */
'use strict';

(() => {
  const { $, esc, money, api, clockTime, toast } = HSS;
  const params = new URLSearchParams(location.search);
  const orderId = params.get('o') || params.get('id') || '';
  const token = params.get('t') || '';
  let data = null;

  async function load() {
    if (!orderId) return fail('No order given', 'Add ?o=ORD-1001 to the link, or print from the cashier screen.');
    try {
      data = await api(`/api/orders/${encodeURIComponent(orderId)}/receipt${token ? '?token=' + encodeURIComponent(token) : ''}`,
        { auth: !token });
      HSS.setSettings({ currency: data.hotel.currency });
      render();
    } catch (err) {
      fail(err.status === 401 ? 'Sign in required' : 'Receipt unavailable',
        err.status === 401 ? 'Sign in to the staff console to reprint this bill, or open the receipt from the guest tracking page.' : err.message);
    }
  }

  function fail(title, msg) {
    $('#page').innerHTML = `<div class="panel panel-pad" style="max-width:420px;margin:0 auto">
      <h2>${esc(title)}</h2><p class="muted">${esc(msg)}</p>
      <div class="row"><a class="btn" href="/staff.html">Staff sign-in</a><a class="btn btn-ghost" href="/menu.html">Menu</a></div>
    </div>`;
  }

  function paymentBlock(o, h) {
    const p = o.payment;
    const rows = [];
    rows.push(`<div><span>Method</span><strong>${esc(o.paymentMethodLabel || p.method || '—')}</strong></div>`);
    if (p.reference) rows.push(`<div><span>Reference</span><span>${esc(p.reference)}</span></div>`);
    if (p.method === 'cash' && p.tender) {
      rows.push(`<div><span>Cash received</span><span>${money(p.tender)}</span></div>`);
      rows.push(`<div><span>Change</span><span>${money(p.change || 0)}</span></div>`);
    }
    rows.push(`<div><span>Status</span><strong>${p.status === 'paid' ? 'PAID' : 'OUTSTANDING'}</strong></div>`);
    if (p.paidAt) rows.push(`<div><span>Paid at</span><span>${clockTime(p.paidAt)}</span></div>`);
    if (p.byStaff) rows.push(`<div><span>Settled by</span><span>${esc(p.byStaff)}</span></div>`);
    return rows.join('');
  }

  function render() {
    const { order: o, hotel: h } = data;
    const tt = o.totals;
    const paid = o.payment.status === 'paid';
    document.title = `Receipt ${o.id} · ${h.restaurantName}`;
    const trackUrl = `${location.origin}/track.html?t=${encodeURIComponent(o.token)}`;

    $('#page').innerHTML = `
      <div class="receipt-paper" id="paper">
        <div class="r-hotel">
          <h1>${esc(h.hotelName)}</h1>
          <div class="r-rest">${esc(h.restaurantName)}</div>
          <div class="r-addr">${esc(h.address)}<br>${esc(h.phone)}${h.email ? ' · ' + esc(h.email) : ''}</div>
        </div>

        <div class="r-sep solid"></div>
        <div style="text-align:center;font-weight:700;letter-spacing:.16em;font-size:12px;font-family:var(--sans)">
          ${paid ? 'TAX INVOICE / RECEIPT' : 'BILL — NOT YET PAID'}
        </div>
        <div class="r-sep"></div>

        <div class="r-meta">
          <div><span>Receipt no.</span><strong>${esc(o.id)}</strong></div>
          <div><span>Table</span><span>${esc(o.tableLabel)}${o.zone ? ' · ' + esc(o.zone) : ''}</span></div>
          ${o.guestName ? `<div><span>Guest</span><span>${esc(o.guestName)}</span></div>` : ''}
          <div><span>Guests</span><span>${o.guests || '—'}</span></div>
          <div><span>Round</span><span>${o.round}</span></div>
          <div><span>Opened</span><span>${clockTime(o.createdAt)} · ${new Date(o.createdAt).toLocaleDateString()}</span></div>
          ${o.servedAt ? `<div><span>Served</span><span>${clockTime(o.servedAt)}</span></div>` : ''}
          <div><span>Served by</span><span>${esc(o.staff.waiter || '—')}</span></div>
          <div><span>Cashier</span><span>${esc(o.staff.cashier || '—')}</span></div>
          <div><span>Printed</span><span>${clockTime(data.issuedAt)}</span></div>
        </div>

        <div class="r-sep"></div>

        <table>
          <tbody>
            ${o.items.map((it) => `
              <tr>
                <td>${it.qty}× ${esc(it.name)}${it.notes ? `<br><small style="color:#6b7280">↳ ${esc(it.notes)}</small>` : ''}</td>
                <td class="r-right">${money(it.price * it.qty)}</td>
              </tr>`).join('')}
          </tbody>
        </table>

        <div class="r-sep"></div>
        <table>
          <tbody>
            <tr><td>Subtotal</td><td class="r-right">${money(tt.subtotal)}</td></tr>
            ${tt.discount ? `<tr><td>Discount (${o.discountPct}%)</td><td class="r-right">−${money(tt.discount)}</td></tr>` : ''}
            ${tt.service ? `<tr><td>${esc(h.serviceLabel)} (${h.servicePct}%)</td><td class="r-right">${money(tt.service)}</td></tr>` : ''}
            ${tt.tax ? `<tr><td>${esc(h.taxLabel)} (${h.taxPct}%)</td><td class="r-right">${money(tt.tax)}</td></tr>` : ''}
          </tbody>
        </table>
        <div class="r-total"><span>TOTAL</span><span>${money(tt.total)}</span></div>

        <div class="r-paid ${paid ? '' : 'unpaid'}">${paid ? 'PAID' : 'UNPAID'}</div>

        <div class="r-sep"></div>
        <div class="r-pay">
          <strong style="font-family:var(--sans);font-size:12px;letter-spacing:.08em">PAYMENT</strong>
          <div style="margin-top:5px">${paymentBlock(o, h)}</div>
        </div>

        ${o.notes ? `<div class="r-sep"></div><div style="font-size:12px"><strong>Notes:</strong> ${esc(o.notes)}</div>` : ''}

        <div class="r-qr">
          <img src="/api/qr.svg?text=${encodeURIComponent(trackUrl)}&scale=5" alt="QR code linking to this order">
          <div style="font-size:11.5px;color:#4b5563;font-family:var(--sans)">
            Scan to follow this order, re-order the same dishes or forward the receipt to your room.
          </div>
        </div>

        <div class="r-sep"></div>
        <div class="r-thanks">
          Thank you for dining with us at ${esc(h.hotelName)}.<br>
          ${esc(h.phone)} · ${esc(h.email)}
        </div>
      </div>

      <div class="receipt-actions no-print">
        <button class="btn btn-primary" id="printBtn">🖨 Print / Save as PDF</button>
        ${paid ? '' : '<a class="btn" href="/staff.html">Take payment</a>'}
        <a class="btn btn-ghost" href="${o.token ? '/track.html?t=' + encodeURIComponent(o.token) : '/staff.html'}">← Back</a>
      </div>

      <p class="tiny center no-print" style="color:#5c6675;margin-top:14px">
        Printing tip: set your browser scale to 100% and margins to “none” for 80&nbsp;mm thermal paper.
      </p>`;

    const btn = $('#printBtn');
    if (btn) btn.addEventListener('click', () => window.print());
    if (params.get('print') === '1') setTimeout(() => window.print(), 400);
  }

  load();
})();
