/* ============================================================================
   Guest app — the page a QR code on the table opens.
   Browse the menu, build a cart, send the order to the cashier, then follow it.
   ========================================================================== */
'use strict';

(() => {
  const { $, esc, money, toast, api, session, on, TABLE_KEY } = HSS;

  const state = {
    settings: {},
    categories: [],
    items: [],
    tables: [],
    tableId: new URLSearchParams(location.search).get('table') || localStorage.getItem(TABLE_KEY) || '',
    activeCat: 'all',
    search: '',
    cart: new Map(),          // itemId -> { qty, notes }
    lastOrder: null           // { token, id } of the newest order sent from this device
  };

  /* --------------------------------------------------------------- helpers */

  const table = () => state.tables.find((t) => t.id === state.tableId) || null;

  function cartLines() {
    const lines = [];
    for (const [itemId, line] of state.cart) {
      const item = state.items.find((m) => m.id === itemId);
      if (!item || !line.qty) continue;
      lines.push({ item, qty: line.qty, notes: line.notes || '' });
    }
    return lines;
  }

  function totals(lines) {
    const subtotal = lines.reduce((s, l) => s + l.item.price * l.qty, 0);
    const service = Math.round((subtotal * (Number(state.settings.servicePct) || 0)) / 100);
    const tax = Math.round(((subtotal + service) * (Number(state.settings.taxPct) || 0)) / 100);
    return { subtotal, service, tax, total: subtotal + service + tax };
  }

  function savedOrderToken() {
    try { return localStorage.getItem('hss.order.' + state.tableId) || ''; } catch { return ''; }
  }

  /* ------------------------------------------------------------------- data */

  async function boot() {
    try {
      const data = await api('/api/bootstrap');
      state.settings = data.settings;
      state.categories = data.menu.categories;
      state.items = data.menu.items;
      state.tables = data.tables;
      HSS.setSettings(data.settings);

      $('#heroHotel').textContent = data.settings.hotelName;
      $('#heroRest').textContent = data.settings.restaurantName;
      $('#heroMark').textContent = (data.settings.hotelName || 'H')
        .split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
      document.title = `${data.settings.restaurantName} · Menu`;

      if (!state.tableId && state.tables.length) state.tableId = state.tables[0].id;
      if (!table()) return openTablePicker();

      localStorage.setItem(TABLE_KEY, state.tableId);
      renderChrome();
      renderMenu();
      checkExistingOrder();

      // availability changes (an item got 86'd) — keep the guest list honest
      HSS.live((ev) => {
        if (ev.entity === 'menu' || ev.entity === 'settings') boot(false);
      });
    } catch (err) {
      $('#menuHost').innerHTML = `<div class="panel panel-pad"><h3>Could not load the menu</h3><p class="muted">${esc(err.message)}</p>
        <button class="btn btn-primary" onclick="location.reload()">Try again</button></div>`;
    }
  }

  function openTablePicker() {
    const host = $('#tablePicker');
    host.innerHTML = state.tables.map((t) => `
      <button class="table-tile" data-act="pick-table" data-id="${esc(t.id)}" type="button">
        <span class="t-name">${esc(t.label)}</span>
        <span class="t-zone">${esc(t.zone || '')} · ${t.seats} seats</span>
        <span class="t-status">Tap to select</span>
      </button>`).join('') || '<div class="empty">No tables configured yet.</div>';
    $('#tableSheet').hidden = false;
  }

  /* --------------------------------------------------------------- chrome */

  function renderChrome() {
    const t = table();
    $('#tableChip').innerHTML = `📍 ${esc(t ? t.label : state.tableId)}${t && t.zone ? ' · ' + esc(t.zone) : ''}`;
  }

  function renderCats() {
    const cats = [{ id: 'all', name: 'All dishes', icon: '✨' }].concat(state.categories);
    $('#catBar').innerHTML = cats.map((c) => `
      <button class="cat-pill ${state.activeCat === c.id ? 'active' : ''}" data-act="cat" data-id="${esc(c.id)}" type="button">
        <span>${esc(c.icon || '🍽️')}</span>${esc(c.name)}
      </button>`).join('');
  }

  function filtered() {
    const q = state.search.trim().toLowerCase();
    return state.items.filter((it) => {
      if (state.activeCat !== 'all' && it.categoryId !== state.activeCat) return false;
      if (!q) return true;
      return (it.name + ' ' + (it.description || '')).toLowerCase().includes(q);
    });
  }

  function renderMenu() {
    renderCats();
    const items = filtered();
    const host = $('#menuHost');
    if (!items.length) {
      host.innerHTML = `<div class="empty"><span class="icon">🔍</span>Nothing matches “${esc(state.search)}”.</div>`;
    } else {
      const byCat = new Map();
      for (const it of items) {
        if (!byCat.has(it.categoryId)) byCat.set(it.categoryId, []);
        byCat.get(it.categoryId).push(it);
      }
      host.innerHTML = Array.from(byCat).map(([catId, list]) => {
        const cat = state.categories.find((c) => c.id === catId) || { name: 'Menu', icon: '🍽️' };
        return `
          <section style="margin-bottom:26px">
            <h2 style="margin:0 0 10px;font-size:1.05rem;color:var(--dim);text-transform:uppercase;letter-spacing:.06em">
              ${esc(cat.icon || '')} ${esc(cat.name)}
            </h2>
            <div class="menu-grid">
              ${list.map(dishCard).join('')}
            </div>
          </section>`;
      }).join('');
    }
    renderCartBar();
  }

  function dishCard(item) {
    const line = state.cart.get(item.id);
    const qty = line ? line.qty : 0;
    const tags = (item.tags || []).map((t) => {
      const label = { veg: '🌱 Veg', spicy: '🌶 Spicy', 'chefs-pick': '⭐ Chef’s pick' }[t] || t;
      const tone = t === 'spicy' ? 'warn' : t === 'veg' ? 'good' : 'accent';
      return `<span class="badge ${tone}">${esc(label)}</span>`;
    }).join(' ');
    const unavailable = item.available === false;
    return `
      <article class="panel dish">
        <h3>${esc(item.name)}</h3>
        <div class="desc">${esc(item.description || '')}</div>
        <div class="tags">${tags}<span class="badge muted">⏱ ${item.prepMinutes || 10} min</span></div>
        <div class="dish-foot">
          <span class="price">${money(item.price)}</span>
          <span class="spacer"></span>
          ${unavailable
            ? '<span class="badge bad">Sold out</span>'
            : qty
              ? `<div class="stepper">
                   <button data-act="dec" data-id="${item.id}" type="button" aria-label="Remove one">−</button>
                   <span class="qty">${qty}</span>
                   <button data-act="inc" data-id="${item.id}" type="button" aria-label="Add one">+</button>
                 </div>`
              : `<button class="btn btn-sm btn-primary" data-act="inc" data-id="${item.id}" type="button">+ Add</button>`}
        </div>
      </article>`;
  }

  function renderCartBar() {
    const lines = cartLines();
    const count = lines.reduce((s, l) => s + l.qty, 0);
    $('#cartBar').hidden = count === 0;
    $('#cartCount').textContent = count === 1 ? '1 item' : count + ' items';
    $('#cartTotal').textContent = money(totals(lines).total);
    const chip = $('#myOrderChip');
    if (savedOrderToken()) {
      chip.hidden = false;
      chip.onclick = () => { location.href = '/track.html?t=' + savedOrderToken(); };
      $('#billBtn').hidden = false;
      $('#waiterBtn').hidden = false;
    }
  }

  /* ------------------------------------------------------------------ cart */

  function setQty(itemId, delta) {
    const item = state.items.find((m) => m.id === itemId);
    const line = state.cart.get(itemId) || { qty: 0, notes: '' };
    line.qty = Math.max(0, Math.min(40, line.qty + delta));
    if (line.qty === 0) state.cart.delete(itemId);
    else state.cart.set(itemId, line);
    if (delta > 0 && line.qty === 1) toast(`${item.name} added`, 'ok', 1400);
    renderMenu();
    if (!$('#cartSheet').hidden) renderCart();
  }

  function renderCart() {
    const lines = cartLines();
    const host = $('#cartLines');
    const t = table();
    $('#sheetTable').innerHTML = `Ordering for <strong>${esc(t ? t.label : state.tableId)}</strong>${t && t.zone ? ' · ' + esc(t.zone) : ''}`;

    if (!lines.length) {
      host.innerHTML = '<div class="empty"><span class="icon">🛒</span>Your basket is empty — add a dish to get started.</div>';
      $('#billPreview').innerHTML = '';
      $('#sendOrder').disabled = true;
      return;
    }
    $('#sendOrder').disabled = false;

    host.innerHTML = lines.map(({ item, qty, notes }) => `
      <div class="item-line" style="padding:9px 0">
        <div style="flex:1;min-width:0">
          <div class="item-name">${esc(item.name)}</div>
          <div class="tiny muted">${money(item.price)} each</div>
          <input class="input" style="margin-top:6px;font-size:13px;padding:6px 9px"
                 placeholder="Note (e.g. no onions)" maxlength="120"
                 value="${esc(notes)}" data-act="line-note" data-id="${item.id}">
        </div>
        <div style="text-align:right">
          <div class="stepper">
            <button data-act="dec" data-id="${item.id}" type="button">−</button>
            <span class="qty">${qty}</span>
            <button data-act="inc" data-id="${item.id}" type="button">+</button>
          </div>
          <div class="mono" style="margin-top:6px">${money(item.price * qty)}</div>
        </div>
      </div>`).join('');

    const tt = totals(lines);
    const s = state.settings;
    $('#billPreview').innerHTML = `
      <div class="bill-line"><span>Subtotal</span><span class="v">${money(tt.subtotal)}</span></div>
      ${tt.service ? `<div class="bill-line dim"><span>${esc(s.serviceLabel || 'Service charge')} (${s.servicePct}%)</span><span class="v">${money(tt.service)}</span></div>` : ''}
      ${tt.tax ? `<div class="bill-line dim"><span>${esc(s.taxLabel || 'Tax')} (${s.taxPct}%)</span><span class="v">${money(tt.tax)}</span></div>` : ''}
      <div class="bill-line total"><span>Total due</span><span class="v">${money(tt.total)}</span></div>`;
  }

  async function sendOrder() {
    const lines = cartLines();
    if (!lines.length) return;
    const btn = $('#sendOrder');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await api('/api/orders', {
        method: 'POST',
        body: {
          tableId: state.tableId,
          guestName: $('#guestName').value.trim(),
          guests: Number($('#guestCount').value) || 0,
          notes: $('#orderNotes').value.trim(),
          items: lines.map((l) => ({ itemId: l.item.id, qty: l.qty, notes: l.notes }))
        }
      });
      localStorage.setItem('hss.order.' + state.tableId, res.order.token);
      localStorage.setItem('hss.lastOrder', JSON.stringify({ id: res.order.id, token: res.order.token }));
      state.cart.clear();
      toast('Order sent to the cashier', 'ok');
      location.href = '/track.html?t=' + encodeURIComponent(res.order.token) + '&new=1';
    } catch (err) {
      toast(err.message, 'err', 5000);
      btn.disabled = false;
      btn.textContent = 'Send order to the cashier →';
    }
  }

  async function checkExistingOrder() {
    const token = savedOrderToken();
    if (!token) return;
    try {
      const { order } = await api('/api/public/order/' + encodeURIComponent(token));
      state.lastOrder = order;
      if (['awaiting_cashier', 'in_kitchen', 'preparing', 'ready', 'served'].includes(order.status)) {
        state.round = order.round;
        const chip = $('#roundChip');
        chip.hidden = false;
        chip.textContent = `🧾 Round ${order.round} in progress · ${order.id}`;
      }
    } catch {
      localStorage.removeItem('hss.order.' + state.tableId);
    }
  }

  /* ---------------------------------------------------------------- events */

  on(document, 'click', '[data-act]', (el) => {
    const act = el.dataset.act;
    if (act === 'inc') setQty(el.dataset.id, 1);
    if (act === 'dec') setQty(el.dataset.id, -1);
    if (act === 'cat') { state.activeCat = el.dataset.id; renderMenu(); }
    if (act === 'pick-table') {
      state.tableId = el.dataset.id;
      localStorage.setItem(TABLE_KEY, state.tableId);
      $('#tableSheet').hidden = true;
      renderChrome();
      renderMenu();
      checkExistingOrder();
      toast('Table ' + state.tableId + ' selected', 'ok');
    }
  });

  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderMenu();
  });

  async function flag(kind) {
    const token = savedOrderToken();
    if (!token) return toast('Place an order first — then you can call us.', 'warn');
    try {
      await api('/api/public/order/' + encodeURIComponent(token) + '/flag', { method: 'POST', body: { kind } });
      toast(kind === 'bill' ? 'Your waiter is bringing the bill' : 'A waiter is on the way', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  $('#billBtn').addEventListener('click', () => flag('bill'));
  $('#waiterBtn').addEventListener('click', () => flag('waiter'));

  on(document, 'input', '[data-act="line-note"]', (el) => {
    const line = state.cart.get(el.dataset.id);
    if (line) line.notes = el.value;
  });

  on(document, 'click', '[data-close-sheet]', () => {
    $('#cartSheet').hidden = true;
    renderMenu();
  });

  $('#openCart').addEventListener('click', () => {
    $('#cartSheet').hidden = false;
    renderCart();
  });

  $('#sendOrder').addEventListener('click', sendOrder);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#cartSheet').hidden) {
      $('#cartSheet').hidden = true;
      renderMenu();
    }
  });

  boot();
})();
