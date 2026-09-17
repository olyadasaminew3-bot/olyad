/* ============================================================================
   Administration — menu, tables & QR codes, staff, settings, reports.
   Managers can change everything; other staff may view tables/QR codes.
   ========================================================================== */
'use strict';

(() => {
  const { $, $$, esc, money, toMinor, clockTime, toast, api, session, on, modal, closeModal, badge } = HSS;

  const state = { snap: null, tab: 'menu', report: null, range: 'today' };
  const isManager = () => (session.staff || {}).role === 'manager';

  const TABS = [
    { id: 'menu', label: '🍽 Menu', render: renderMenuTab },
    { id: 'qr', label: '📱 Tables & QR codes', render: renderQrTab },
    { id: 'staff', label: '👥 Staff & PINs', render: renderStaffTab },
    { id: 'settings', label: '⚙️ Settings', render: renderSettingsTab },
    { id: 'reports', label: '📈 Reports', render: renderReportsTab }
  ];

  /* ------------------------------------------------------------------ boot */

  async function boot() {
    if (!session.token || !session.staff) {
      $('#gate').hidden = false;
      return;
    }
    $('#adminView').hidden = false;
    const staff = session.staff;
    $('#whoChip').innerHTML = `👤 ${esc(staff.name)} · <strong>${esc(staff.role)}</strong>`;
    state.tab = (location.hash || '#menu').slice(1);
    if (!TABS.some((t) => t.id === state.tab)) state.tab = 'menu';
    renderTabs();
    await refresh();
    HSS.live((ev) => {
      if (['menu', 'tables', 'settings', 'staff'].includes(ev.entity)) refresh();
    });
    window.addEventListener('hashchange', () => {
      const t = location.hash.slice(1);
      if (TABS.some((x) => x.id === t) && t !== state.tab) {
        state.tab = t;
        renderTabs();
        render();
      }
    });
  }

  async function refresh() {
    try {
      state.snap = await api('/api/snapshot', { auth: true });
      HSS.setSettings(state.snap.settings);
      $('#brandHotel').textContent = state.snap.settings.hotelName;
      $('#brandMark').textContent = state.snap.settings.hotelName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
      if (state.tab === 'reports') state.report = await api('/api/reports/summary?range=' + state.range, { auth: true });
      render();
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        $('#gate').hidden = false;
        $('#adminView').hidden = true;
      } else toast(err.message, 'err');
    }
  }

  function renderTabs() {
    $('#tabs').innerHTML = TABS.map((t) => `<button class="tab ${state.tab === t.id ? 'active' : ''}" data-tab="${t.id}" type="button">${t.label}</button>`).join('');
  }

  function render() {
    const tab = TABS.find((t) => t.id === state.tab) || TABS[0];
    $('#view').innerHTML = tab.render();
    if (state.tab === 'qr') renderPrintSheet();
  }

  on(document, 'click', '[data-tab]', (el) => {
    state.tab = el.dataset.tab;
    location.hash = state.tab;
    renderTabs();
    if (state.tab === 'reports') { loadReport(); return; }
    render();
  });

  async function loadReport() {
    try {
      state.report = await api('/api/reports/summary?range=' + state.range, { auth: true });
      render();
    } catch (err) { toast(err.message, 'err'); }
  }

  const guard = () => {
    if (!isManager()) { toast('Only a manager can change that', 'err'); return false; }
    return true;
  };

  /* ================================================================== menu */

  function renderMenuTab() {
    const cats = state.snap.categories;
    const items = state.snap.menu;
    return `
      <div class="stack">
        <div class="grid grid-4">
          <div class="kpi"><div class="k-label">Dishes</div><div class="k-value">${items.length}</div><div class="k-sub">on the guest menu</div></div>
          <div class="kpi"><div class="k-label">Sold out</div><div class="k-value">${items.filter((i) => i.available === false).length}</div><div class="k-sub">hidden from guests</div></div>
          <div class="kpi"><div class="k-label">Categories</div><div class="k-value">${cats.length}</div><div class="k-sub">menu sections</div></div>
          <div class="kpi"><div class="k-label">Average price</div><div class="k-value">${items.length ? money(Math.round(items.reduce((s, i) => s + i.price, 0) / items.length)) : money(0)}</div><div class="k-sub">per dish</div></div>
        </div>

        <section class="panel">
          <div class="panel-head">
            <h3>Menu</h3>
            <span class="spacer"></span>
            <input class="input" id="menuSearch" placeholder="🔍 Filter dishes…" style="max-width:240px">
            ${isManager() ? '<button class="btn btn-primary btn-sm" data-act="new-item">＋ New dish</button>' : ''}
            ${isManager() ? '<button class="btn btn-sm" data-act="new-cat">＋ Category</button>' : ''}
          </div>
          <div class="panel-body flush">
            <table class="data" id="menuTable">
              <thead><tr><th>Dish</th><th>Category</th><th class="num">Price</th><th class="num">Prep</th><th>Available</th><th></th></tr></thead>
              <tbody>
                ${cats.map((c) => {
                  const list = items.filter((i) => i.categoryId === c.id);
                  if (!list.length) return '';
                  return `<tr><td colspan="6" style="background:var(--panel-2);font-weight:650;color:var(--dim)">${esc(c.icon || '')} ${esc(c.name)}</td></tr>` +
                    list.map((i) => menuRow(i)).join('');
                }).join('')}
              </tbody>
            </table>
          </div>
        </section>
      </div>`;
  }

  function menuRow(i) {
    return `<tr data-item="${esc(i.id)}" data-search="${esc((i.name + ' ' + (i.description || '')).toLowerCase())}">
      <td>
        <div style="font-weight:580">${esc(i.name)}</div>
        <div class="tiny muted truncate" style="max-width:420px">${esc(i.description || '')}</div>
      </td>
      <td class="tiny">${esc((state.snap.categories.find((c) => c.id === i.categoryId) || {}).name || '—')}</td>
      <td class="num mono">${money(i.price)}</td>
      <td class="num tiny">${i.prepMinutes}′</td>
      <td>
        <label class="switch" title="Sold out items disappear from the guest menu">
          <input type="checkbox" data-act="toggle-available" data-id="${esc(i.id)}" ${i.available === false ? '' : 'checked'}>
          <span class="tiny">${i.available === false ? 'sold out' : 'on menu'}</span>
        </label>
      </td>
      <td class="right nowrap">
        ${isManager() ? `<button class="btn btn-sm btn-ghost" data-act="edit-item" data-id="${esc(i.id)}">✎ Edit</button>
        <button class="btn btn-sm btn-ghost" data-act="del-item" data-id="${esc(i.id)}">🗑</button>` : ''}
      </td>
    </tr>`;
  }

  on(document, 'input', '#menuSearch', (el) => {
    const q = el.value.trim().toLowerCase();
    $$('#menuTable tbody tr[data-item]').forEach((tr) => {
      tr.style.display = !q || (tr.dataset.search || '').includes(q) ? '' : 'none';
    });
  });

  function openItemModal(item) {
    const cats = state.snap.categories;
    const d = state.snap.settings.currency.decimals ?? 2;
    modal(`
      <h2>${item ? 'Edit dish' : 'New dish'}</h2>
      <div class="stack-sm" style="margin-top:12px">
        <div class="field"><label>Name</label><input class="input" id="f_name" value="${esc(item ? item.name : '')}" maxlength="60"></div>
        <div class="field"><label>Description</label><textarea class="textarea" id="f_desc" maxlength="160">${esc(item ? item.description : '')}</textarea></div>
        <div class="grid grid-2">
          <div class="field"><label>Price (${esc(state.snap.settings.currency.code)})</label>
            <input class="input" id="f_price" type="number" step="${d === 0 ? 1 : '0.01'}" min="0" value="${(((item ? item.price : 0) / Math.pow(10, d))).toFixed(d)}"></div>
          <div class="field"><label>Prep minutes</label><input class="input" id="f_prep" type="number" min="1" max="120" value="${item ? item.prepMinutes : 10}"></div>
        </div>
        <div class="field"><label>Category</label>
          <select class="select" id="f_cat">${cats.map((c) => `<option value="${esc(c.id)}" ${item && item.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Tags (comma separated: veg, spicy, chefs-pick)</label>
          <input class="input" id="f_tags" value="${esc((item && item.tags ? item.tags : []).join(', '))}"></div>
        <label class="switch"><input type="checkbox" id="f_avail" ${!item || item.available !== false ? 'checked' : ''}><span>Available on the guest menu</span></label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Cancel</button>
        <button class="btn btn-primary" id="saveItem">${item ? 'Save changes' : 'Create dish'}</button>
      </div>`, {
      onMount(host) {
        $('#saveItem', host).addEventListener('click', async () => {
          const body = {
            name: $('#f_name', host).value.trim(),
            description: $('#f_desc', host).value.trim(),
            price: toMinor($('#f_price', host).value, d),
            prepMinutes: Number($('#f_prep', host).value) || 10,
            categoryId: $('#f_cat', host).value,
            tags: $('#f_tags', host).value.split(',').map((s) => s.trim()).filter(Boolean),
            available: $('#f_avail', host).checked
          };
          if (!body.name) return toast('Give the dish a name', 'warn');
          try {
            if (item) await api('/api/menu/items/' + item.id, { method: 'PATCH', auth: true, body });
            else await api('/api/menu/items', { method: 'POST', auth: true, body });
            closeModal();
            toast(item ? 'Dish updated' : 'Dish created', 'ok');
            refresh();
          } catch (err) { toast(err.message, 'err'); }
        });
      }
    });
  }

  function openCategoryModal() {
    modal(`
      <h2>New category</h2>
      <div class="field" style="margin:12px 0"><label>Name</label><input class="input" id="c_name" placeholder="e.g. Breakfast"></div>
      <div class="field"><label>Icon (emoji)</label><input class="input" id="c_icon" value="🍽️" maxlength="4"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Cancel</button>
        <button class="btn btn-primary" id="saveCat">Create category</button>
      </div>`, {
      onMount(host) {
        $('#saveCat', host).addEventListener('click', async () => {
          try {
            await api('/api/menu/categories', { method: 'POST', auth: true, body: { name: $('#c_name', host).value.trim(), icon: $('#c_icon', host).value } });
            closeModal();
            toast('Category created', 'ok');
            refresh();
          } catch (err) { toast(err.message, 'err'); }
        });
      }
    });
  }

  /* ==================================================================== QR */

  function menuUrlFor(tableId) {
    const base = state.snap.origin || location.origin;
    return `${base}/menu.html?table=${encodeURIComponent(tableId)}`;
  }

  function renderQrTab() {
    const tables = state.snap.tables.slice().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const zones = Array.from(new Set(tables.map((t) => t.zone || 'Other')));
    return `
      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <h3>Table QR codes</h3>
            <span class="sub">Print these and place one on every table — scanning opens that table's menu</span>
            <span class="spacer"></span>
            <button class="btn btn-sm" data-act="print-qr">🖨 Print all</button>
            ${isManager() ? '<button class="btn btn-primary btn-sm" data-act="new-table">＋ New table</button>' : ''}
          </div>
          <div class="panel-body">
            <div class="row" style="margin-bottom:12px">
              <span class="chip dim">Guest link base: ${esc(state.snap.origin || location.origin)}</span>
              ${isManager() ? '<button class="btn btn-sm btn-ghost" data-act="edit-base">Change base URL</button>' : ''}
            </div>
            ${zones.map((zone) => `
              <h3 style="margin:14px 0 8px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;font-size:12.5px">${esc(zone)}</h3>
              <div class="qr-grid">
                ${tables.filter((t) => (t.zone || 'Other') === zone).map((t) => qrCard(t)).join('')}
              </div>`).join('')}
          </div>
        </section>

        ${isManager() ? `
        <section class="panel">
          <div class="panel-head"><h3>Tables</h3></div>
          <div class="panel-body flush">
            <table class="data">
              <thead><tr><th>ID</th><th>Label</th><th>Zone</th><th class="num">Seats</th><th>Status now</th><th></th></tr></thead>
              <tbody>${tables.map((t) => {
                const s = (state.snap.tables.find((x) => x.id === t.id) || {});
                return `<tr>
                  <td class="mono">${esc(t.id)}</td>
                  <td>${esc(t.label)}</td>
                  <td>${esc(t.zone)}</td>
                  <td class="num">${t.seats}</td>
                  <td>${badge(s.status === 'free' ? 'free' : s.status, s.status === 'free' ? 'muted' : 'accent')}</td>
                  <td class="right nowrap">
                    <button class="btn btn-sm btn-ghost" data-act="edit-table" data-id="${esc(t.id)}">✎</button>
                    <button class="btn btn-sm btn-ghost" data-act="del-table" data-id="${esc(t.id)}">🗑</button>
                  </td></tr>`;
              }).join('')}</tbody>
            </table>
          </div>
        </section>` : ''}
      </div>`;
  }

  function qrCard(t) {
    const url = menuUrlFor(t.id);
    const qr = `/api/qr.svg?text=${encodeURIComponent(url)}&scale=6`;
    return `<div class="qr-card">
      <img src="${qr}" alt="QR code for ${esc(t.label)}" loading="lazy">
      <div>
        <div class="q-label">${esc(t.label)}</div>
        <div class="q-zone">${esc(t.zone || '')} · ${t.seats} seats</div>
      </div>
      <div class="q-hint">Scan to open the menu &amp; order</div>
      <div class="qr-download no-print">
        <a class="btn btn-sm" href="${qr}" download="qr-${esc(t.id)}.svg">⬇ SVG</a>
        <button class="btn btn-sm btn-ghost" data-act="copy-link" data-url="${esc(url)}">🔗 Link</button>
      </div>
    </div>`;
  }

  function renderPrintSheet() {
    const host = $('#printSheet');
    if (!host || !state.snap) return;
    host.innerHTML = state.snap.tables.map((t) => `
      <div class="qr-card">
        <img src="/api/qr.svg?text=${encodeURIComponent(menuUrlFor(t.id))}&scale=6" alt="">
        <div><div class="q-label">${esc(state.snap.settings.hotelName)} — ${esc(t.label)}</div>
        <div class="q-zone">${esc(t.zone || '')}</div></div>
        <div class="q-hint">Point your camera at the code → open the menu → order.<br>Your order goes straight to the cashier &amp; kitchen.</div>
      </div>`).join('');
  }

  function openTableModal(table) {
    modal(`
      <h2>${table ? 'Edit table' : 'New table'}</h2>
      <div class="stack-sm" style="margin-top:12px">
        ${table ? '' : '<div class="field"><label>Table ID (printed on the QR link)</label><input class="input" id="t_id" placeholder="T13" maxlength="8"></div>'}
        <div class="field"><label>Label</label><input class="input" id="t_label" value="${esc(table ? table.label : '')}" placeholder="Table 13"></div>
        <div class="grid grid-2">
          <div class="field"><label>Zone</label><input class="input" id="t_zone" value="${esc(table ? table.zone : 'Terrace')}"></div>
          <div class="field"><label>Seats</label><input class="input" id="t_seats" type="number" min="1" max="40" value="${table ? table.seats : 2}"></div>
        </div>
        ${table ? `<label class="switch"><input type="checkbox" id="t_active" ${table.active === false ? '' : 'checked'}><span>Accepting orders</span></label>` : ''}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Cancel</button>
        <button class="btn btn-primary" id="saveTable">${table ? 'Save' : 'Create table'}</button>
      </div>`, {
      onMount(host) {
        $('#saveTable', host).addEventListener('click', async () => {
          const body = {
            label: $('#t_label', host).value.trim(),
            zone: $('#t_zone', host).value.trim(),
            seats: Number($('#t_seats', host).value) || 2
          };
          if (!body.label) return toast('Give the table a label', 'warn');
          try {
            if (table) {
              body.active = $('#t_active', host).checked;
              await api('/api/tables/' + table.id, { method: 'PATCH', auth: true, body });
            } else {
              body.id = $('#t_id', host).value.trim();
              await api('/api/tables', { method: 'POST', auth: true, body });
            }
            closeModal();
            toast('Table saved', 'ok');
            refresh();
          } catch (err) { toast(err.message, 'err'); }
        });
      }
    });
  }

  function openBaseUrlModal() {
    modal(`
      <h2>Guest link base URL</h2>
      <p class="tiny muted">QR codes must point to an address guests' phones can reach. Leave empty to use the address this server is opened on (<span class="mono">${esc(location.origin)}</span>).</p>
      <div class="field" style="margin:12px 0"><label>Base URL</label>
        <input class="input" id="b_url" placeholder="https://terrace.azurebay.example" value="${esc(state.snap.settings.baseUrl || '')}"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Cancel</button>
        <button class="btn btn-primary" id="saveBase">Save</button>
      </div>`, {
      onMount(host) {
        $('#saveBase', host).addEventListener('click', async () => {
          try {
            await api('/api/settings', { method: 'PATCH', auth: true, body: { baseUrl: $('#b_url', host).value.trim() } });
            closeModal();
            toast('Base URL saved — QR codes updated', 'ok');
            refresh();
          } catch (err) { toast(err.message, 'err'); }
        });
      }
    });
  }

  /* ================================================================= staff */

  function renderStaffTab() {
    if (!isManager()) {
      return `<section class="panel panel-pad">
        <h2>Staff &amp; PINs</h2>
        <p class="muted">The roster and sign-in PINs are visible to managers only.</p>
        <p class="tiny muted">Ask a manager if you need a PIN reset — they can do it from this screen.</p>
      </section>`;
    }
    const staff = state.snap.staffList || [];
    const roles = ['manager', 'cashier', 'chef', 'waiter'];
    return `
      <div class="stack">
        <div class="grid grid-4">
          ${roles.map((r) => `<div class="kpi"><div class="k-label">${r}s</div><div class="k-value">${staff.filter((s) => s.role === r).length}</div><div class="k-sub">${staff.filter((s) => s.role === r && s.active !== false).length} active</div></div>`).join('')}
        </div>
        <section class="panel">
          <div class="panel-head">
            <h3>Staff &amp; sign-in PINs</h3>
            <span class="sub">PINs are used on the staff console keypad</span>
            <span class="spacer"></span>
            ${isManager() ? '<button class="btn btn-primary btn-sm" data-act="new-staff">＋ Add staff</button>' : ''}
          </div>
          <div class="panel-body flush">
            <table class="data">
              <thead><tr><th>Name</th><th>Role</th><th>PIN</th><th>Status</th><th></th></tr></thead>
              <tbody>${staff.map((s) => `<tr>
                <td style="font-weight:580">${esc(s.name)}</td>
                <td>${badge(s.role, s.role === 'manager' ? 'accent' : s.role === 'cashier' ? 'info' : s.role === 'chef' ? 'warn' : 'good')}</td>
                <td class="mono" data-pin-cell="${esc(s.id)}">${isManager() ? '••••' : '••••'}<button class="btn btn-sm btn-ghost" data-act="reveal-pin" data-id="${esc(s.id)}">👁</button></td>
                <td>${s.active === false ? badge('inactive', 'bad') : badge('on shift', 'good')}</td>
                <td class="right nowrap">
                  ${isManager() ? `<button class="btn btn-sm btn-ghost" data-act="edit-staff" data-id="${esc(s.id)}">✎ Edit</button>
                  <button class="btn btn-sm btn-ghost" data-act="del-staff" data-id="${esc(s.id)}">🗑</button>` : ''}
                </td></tr>`).join('')}</tbody>
            </table>
          </div>
        </section>
        <section class="panel panel-pad">
          <h3>How the shifts work</h3>
          <p class="tiny muted" style="margin:6px 0 0">
            Cashier approves orders &amp; takes payment · Kitchen cooks and bumps tickets ·
            Waiter serves and can settle bills · Manager sees everything plus this admin area.
            Guests never see these PINs — they only ever get the menu and their own order.
          </p>
        </section>
      </div>`;
  }

  function openStaffModal(member) {
    const roles = [['manager', 'Manager — full control'], ['cashier', 'Cashier — orders & payment'], ['chef', 'Kitchen — tickets'], ['waiter', 'Waiter — serve & settle']];
    modal(`
      <h2>${member ? 'Edit ' + esc(member.name) : 'Add staff'}</h2>
      <div class="stack-sm" style="margin-top:12px">
        <div class="field"><label>Name</label><input class="input" id="s_name" value="${esc(member ? member.name : '')}" maxlength="40"></div>
        <div class="field"><label>Role</label><select class="select" id="s_role">
          ${roles.map(([v, l]) => `<option value="${v}" ${member && member.role === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
        <div class="field"><label>PIN (4–6 digits)</label><input class="input" id="s_pin" inputmode="numeric" maxlength="6" value="${member ? esc(member.pin) : ''}"></div>
        ${member ? `<label class="switch"><input type="checkbox" id="s_active" ${member.active === false ? '' : 'checked'}><span>Active (can sign in)</span></label>` : ''}
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-close>Cancel</button>
        <button class="btn btn-primary" id="saveStaff">${member ? 'Save' : 'Add staff'}</button>
      </div>`, {
      onMount(host) {
        $('#saveStaff', host).addEventListener('click', async () => {
          const body = { name: $('#s_name', host).value.trim(), role: $('#s_role', host).value, pin: $('#s_pin', host).value.trim() };
          if (member) body.active = $('#s_active', host).checked;
          try {
            if (member) await api('/api/staff/' + member.id, { method: 'PATCH', auth: true, body });
            else await api('/api/staff', { method: 'POST', auth: true, body });
            closeModal();
            toast('Saved', 'ok');
            refresh();
          } catch (err) { toast(err.message, 'err'); }
        });
      }
    });
  }

  /* =============================================================== settings */

  function renderSettingsTab() {
    const s = state.snap.settings;
    const readonly = !isManager();
    const dis = readonly ? 'disabled' : '';
    const d = s.currency.decimals ?? 2;
    return `
      <div class="stack">
        ${readonly ? '<div class="panel panel-pad"><strong>Read-only:</strong> <span class="muted">only a manager can change settings.</span></div>' : ''}
        <div class="grid grid-2" style="align-items:start">
          <section class="panel">
            <div class="panel-head"><h3>Property</h3></div>
            <div class="panel-body stack-sm">
              <div class="field"><label>Hotel name</label><input class="input" id="set_hotel" value="${esc(s.hotelName)}" ${dis}></div>
              <div class="field"><label>Restaurant / outlet</label><input class="input" id="set_rest" value="${esc(s.restaurantName)}" ${dis}></div>
              <div class="field"><label>Address</label><input class="input" id="set_addr" value="${esc(s.address)}" ${dis}></div>
              <div class="grid grid-2">
                <div class="field"><label>Phone</label><input class="input" id="set_phone" value="${esc(s.phone)}" ${dis}></div>
                <div class="field"><label>Email</label><input class="input" id="set_email" value="${esc(s.email)}" ${dis}></div>
              </div>
              <div class="field"><label>Public base URL for QR codes (optional)</label><input class="input" id="set_base" value="${esc(s.baseUrl || '')}" placeholder="${esc(location.origin)}" ${dis}></div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>Money</h3></div>
            <div class="panel-body stack-sm">
              <div class="grid grid-2">
                <div class="field"><label>Currency symbol</label><input class="input" id="set_sym" value="${esc(s.currency.symbol)}" maxlength="4" ${dis}></div>
                <div class="field"><label>Currency code</label><input class="input" id="set_code" value="${esc(s.currency.code)}" maxlength="6" ${dis}></div>
              </div>
              <div class="grid grid-2">
                <div class="field"><label>Decimals</label><select class="select" id="set_dec" ${dis}>
                  <option value="0" ${d === 0 ? 'selected' : ''}>0 — whole units (RWF, JPY…)</option>
                  <option value="2" ${d === 2 ? 'selected' : ''}>2 — cents (USD, EUR…)</option>
                  <option value="3" ${d === 3 ? 'selected' : ''}>3 — fils (KWD, BHD…)</option>
                </select></div>
                <div class="field"><label>Symbol position</label><select class="select" id="set_pos" ${dis}>
                  <option value="before" ${s.currency.position === 'before' ? 'selected' : ''}>Before: $10.00</option>
                  <option value="after" ${s.currency.position === 'after' ? 'selected' : ''}>After: 10.00 €</option>
                </select></div>
              </div>
              <div class="grid grid-2">
                <div class="field"><label>Service charge label</label><input class="input" id="set_slabel" value="${esc(s.serviceLabel)}" ${dis}></div>
                <div class="field"><label>Service charge %</label><input class="input" id="set_spct" type="number" min="0" max="60" step="0.5" value="${s.servicePct}" ${dis}></div>
              </div>
              <div class="grid grid-2">
                <div class="field"><label>Tax label</label><input class="input" id="set_tlabel" value="${esc(s.taxLabel)}" ${dis}></div>
                <div class="field"><label>Tax %</label><input class="input" id="set_tpct" type="number" min="0" max="60" step="0.5" value="${s.taxPct}" ${dis}></div>
              </div>
            </div>
          </section>
        </div>

        <section class="panel">
          <div class="panel-head"><h3>Payment methods</h3><span class="sub">shown to staff when settling a bill</span></div>
          <div class="panel-body">
            <table class="data">
              <thead><tr><th>Method</th><th>Description</th><th>Needs reference</th><th>Enabled</th></tr></thead>
              <tbody>
                ${(s.payMethods || []).map((m) => `<tr data-method-row="${esc(m.id)}">
                  <td><input class="input" data-mfield="label" value="${esc(m.label)}" ${dis}></td>
                  <td><input class="input" data-mfield="detail" value="${esc(m.detail || '')}" ${dis}></td>
                  <td><label class="switch"><input type="checkbox" data-mfield="needsReference" ${m.needsReference ? 'checked' : ''} ${dis}><span>required</span></label></td>
                  <td><label class="switch"><input type="checkbox" data-mfield="enabled" ${m.enabled !== false ? 'checked' : ''} ${dis}><span>${m.enabled !== false ? 'on' : 'off'}</span></label></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>Operations</h3></div>
          <div class="panel-body stack-sm">
            <label class="switch"><input type="checkbox" id="set_approve" ${s.requireCashierApproval ? 'checked' : ''} ${dis}>
              <span>Cashier must approve every order before the kitchen sees it <span class="tiny muted">(recommended)</span></span></label>
            <label class="switch"><input type="checkbox" id="set_autoprint" ${s.autoPrintOnPayment ? 'checked' : ''} ${dis}>
              <span>Automatically open the receipt when a bill is settled</span></label>
            <label class="switch"><input type="checkbox" id="set_demo" ${s.demoMode ? 'checked' : ''} ${dis}>
              <span>Demo mode — allows “simulate a guest order” and shows demo PINs on the login screen</span></label>
          </div>
          ${isManager() ? `<div class="panel-foot row">
            <button class="btn btn-primary" data-act="save-settings">💾 Save settings</button>
            <span class="spacer"></span>
            <button class="btn btn-bad" data-act="reset-demo">♻ Reset demo data</button>
          </div>` : ''}
        </section>
      </div>`;
  }

  async function saveSettings() {
    if (!guard()) return;
    const methods = $$('[data-method-row]').map((row) => ({
      id: row.dataset.methodRow,
      label: row.querySelector('[data-mfield="label"]').value.trim(),
      detail: row.querySelector('[data-mfield="detail"]').value.trim(),
      enabled: row.querySelector('[data-mfield="enabled"]').checked,
      needsReference: row.querySelector('[data-mfield="needsReference"]').checked
    }));
    const body = {
      hotelName: $('#set_hotel').value,
      restaurantName: $('#set_rest').value,
      address: $('#set_addr').value,
      phone: $('#set_phone').value,
      email: $('#set_email').value,
      baseUrl: $('#set_base').value.trim(),
      currency: { symbol: $('#set_sym').value, code: $('#set_code').value, decimals: Number($('#set_dec').value), position: $('#set_pos').value },
      serviceLabel: $('#set_slabel').value,
      servicePct: Number($('#set_spct').value) || 0,
      taxLabel: $('#set_tlabel').value,
      taxPct: Number($('#set_tpct').value) || 0,
      requireCashierApproval: $('#set_approve').checked,
      autoPrintOnPayment: $('#set_autoprint').checked,
      demoMode: $('#set_demo').checked,
      payMethods: methods
    };
    try {
      await api('/api/settings', { method: 'PATCH', auth: true, body });
      toast('Settings saved', 'ok');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ================================================================ reports */

  function renderReportsTab() {
    const r = state.report;
    const ranges = [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time']];
    if (!r) {
      return `<div class="stack"><div class="seg" id="rangeSeg">${ranges.map(([v, l]) => `<button data-range="${v}" class="${state.range === v ? 'active' : ''}" type="button">${l}</button>`).join('')}</div>
      <div class="panel empty">Loading report…</div></div>`;
    }
    const maxHour = Math.max(1, ...r.hourly.map((h) => h.amount));
    const methodRows = Object.entries(r.byMethod).map(([id, row]) => {
      const m = (state.snap.settings.payMethods || []).find((x) => x.id === id);
      const pct = r.revenue ? Math.round((row.amount / r.revenue) * 100) : 0;
      return `<div class="bar-row" style="margin-bottom:9px">
        <span class="truncate">${esc(m ? m.label : id)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <span class="right mono">${money(row.amount)}<br><span class="tiny muted">${row.count}×</span></span>
      </div>`;
    }).join('');

    return `
      <div class="stack">
        <div class="row">
          <div class="seg" id="rangeSeg">${ranges.map(([v, l]) => `<button data-range="${v}" class="${state.range === v ? 'active' : ''}" type="button">${l}</button>`).join('')}</div>
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" data-act="print-report">🖨 Print</button>
        </div>

        <div class="grid grid-4">
          <div class="kpi good"><div class="k-label">Revenue</div><div class="k-value">${money(r.revenue)}</div><div class="k-sub">${r.paidOrders} paid orders</div></div>
          <div class="kpi"><div class="k-label">Orders</div><div class="k-value">${r.orders}</div><div class="k-sub">placed in range</div></div>
          <div class="kpi"><div class="k-label">Average ticket</div><div class="k-value">${money(r.avgTicket)}</div><div class="k-sub">per paid order</div></div>
          <div class="kpi accent"><div class="k-label">Open now</div><div class="k-value">${state.snap.stats.open}</div><div class="k-sub">${money(state.snap.stats.unpaid)} unpaid</div></div>
        </div>

        <div class="grid grid-2" style="align-items:start">
          <section class="panel">
            <div class="panel-head"><h3>Revenue by payment method</h3></div>
            <div class="panel-body">${methodRows || '<div class="empty">No payments in this range.</div>'}</div>
          </section>
          <section class="panel">
            <div class="panel-head"><h3>Best sellers</h3></div>
            <div class="panel-body flush">
              ${r.topItems.length ? `<table class="data"><thead><tr><th>Dish</th><th class="num">Sold</th><th class="num">Revenue</th></tr></thead>
                <tbody>${r.topItems.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${t.qty}</td><td class="num mono">${money(t.amount)}</td></tr>`).join('')}</tbody></table>`
                : '<div class="empty">Nothing sold yet in this range.</div>'}
            </div>
          </section>
        </div>

        <section class="panel">
          <div class="panel-head"><h3>Revenue by hour</h3><span class="sub">when guests spend</span></div>
          <div class="panel-body">
            <div style="display:grid;grid-template-columns:repeat(24,1fr);gap:4px;align-items:end;height:140px">
              ${r.hourly.map((h) => `<div title="${h.hour}:00 · ${money(h.amount)} · ${h.orders} orders"
                style="height:${Math.max(2, Math.round((h.amount / maxHour) * 130))}px;background:var(--accent);opacity:${h.amount ? 0.9 : 0.15};border-radius:4px 4px 0 0"></div>`).join('')}
            </div>
            <div style="display:grid;grid-template-columns:repeat(24,1fr);gap:4px;margin-top:6px" class="tiny muted">
              ${r.hourly.map((h) => `<span style="text-align:center">${h.hour % 3 === 0 ? h.hour : ''}</span>`).join('')}
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>Orders in range</h3></div>
          <div class="panel-body flush">
            <table class="data">
              <thead><tr><th>Order</th><th>Table</th><th>Placed</th><th>Status</th><th>Payment</th><th class="num">Total</th><th></th></tr></thead>
              <tbody>
                ${state.snap.orders.filter((o) => o.status !== 'completed').slice(0, 40).map((o) => `<tr>
                  <td class="mono">${esc(o.id)}</td><td>${esc(o.tableLabel)}</td>
                  <td>${clockTime(o.createdAt)}</td>
                  <td>${badge(HSS.status(o.status).short, HSS.status(o.status).tone)}</td>
                  <td>${badge(o.payment.status === 'paid' ? (o.paymentMethodLabel || 'paid') : 'unpaid', o.payment.status === 'paid' ? 'good' : 'warn')}</td>
                  <td class="num mono">${money(o.totals.total)}</td>
                  <td class="right"><button class="btn btn-sm btn-ghost" data-act="print-receipt" data-id="${esc(o.id)}">🖨</button></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </section>
      </div>`;
  }

  on(document, 'click', '[data-range]', (el) => {
    state.range = el.dataset.range;
    loadReport();
  });

  /* ================================================================ actions */

  on(document, 'click', '[data-act]', async (el) => {
    const act = el.dataset.act;
    const id = el.dataset.id;
    const item = state.snap && state.snap.menu.find((m) => m.id === id);
    const table = state.snap && state.snap.tables.find((t) => t.id === id);
    const member = state.snap && (state.snap.staffList || []).find((s) => s.id === id);

    try {
      if (act === 'new-item') return guard() && openItemModal(null);
      if (act === 'edit-item') return guard() && openItemModal(item);
      if (act === 'new-cat') return guard() && openCategoryModal();
      if (act === 'new-table') return guard() && openTableModal(null);
      if (act === 'edit-table') return guard() && openTableModal(table);
      if (act === 'edit-base') return guard() && openBaseUrlModal();
      if (act === 'new-staff') return guard() && openStaffModal(null);
      if (act === 'edit-staff') return guard() && openStaffModal(member);
      if (act === 'save-settings') return saveSettings();
      if (act === 'print-qr') return window.print();
      if (act === 'print-report') return window.print();
      if (act === 'print-receipt') return window.open(`/receipt.html?o=${encodeURIComponent(id)}`, '_blank');
      if (act === 'copy-link') return copyLink(el.dataset.url);
      if (act === 'reveal-pin') {
        if (!guard()) return;
        const s = (state.snap.staffList || []).find((x) => x.id === id);
        const cell = document.querySelector(`[data-pin-cell="${id}"]`);
        if (cell && s) cell.innerHTML = `<span class="mono">${esc(s.pin)}</span>`;
        return;
      }
      if (act === 'del-item') {
        if (!guard() || !confirm(`Delete “${item ? item.name : id}” from the menu?`)) return;
        await api('/api/menu/items/' + id, { method: 'DELETE', auth: true });
        toast('Dish deleted', 'warn');
        return refresh();
      }
      if (act === 'del-table') {
        if (!guard() || !confirm(`Delete table ${id}? Its QR code will stop working.`)) return;
        await api('/api/tables/' + id, { method: 'DELETE', auth: true });
        toast('Table deleted', 'warn');
        return refresh();
      }
      if (act === 'del-staff') {
        if (!guard() || !confirm(`Remove ${member ? member.name : id} from the staff list?`)) return;
        await api('/api/staff/' + id, { method: 'DELETE', auth: true });
        toast('Staff removed', 'warn');
        return refresh();
      }
      if (act === 'reset-demo') {
        if (!guard() || !confirm('Reset all orders, menu edits and settings back to the demo data? This cannot be undone.')) return;
        await api('/api/admin/reset', { method: 'POST', auth: true });
        toast('Demo data reset', 'warn');
        return refresh();
      }
    } catch (err) {
      toast(err.message, 'err', 5000);
    }
  });

  on(document, 'change', '[data-act="toggle-available"]', async (el) => {
    try {
      await api('/api/menu/items/' + el.dataset.id, { method: 'PATCH', auth: true, body: { available: el.checked } });
      toast(el.checked ? 'Back on the menu' : 'Marked sold out', el.checked ? 'ok' : 'warn');
    } catch (err) {
      el.checked = !el.checked;
      toast(err.message, 'err');
    }
  });

  async function copyLink(url) {
    try {
      await navigator.clipboard.writeText(url);
      toast('Guest link copied', 'ok');
    } catch {
      modal(`<h2>Guest link</h2><p class="tiny muted">Copy this link or share it with the table.</p>
        <input class="input" style="margin-top:10px" value="${esc(url)}" onclick="this.select()">`);
    }
  }

  boot();
})();
