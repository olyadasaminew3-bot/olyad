/* Landing page: live health + floor preview + demo order button. */
'use strict';

(() => {
  const { $, esc, money, toast, api, status } = HSS;

  async function load() {
    try {
      const [boot, health] = await Promise.all([api('/api/bootstrap'), api('/api/health')]);
      HSS.setSettings(boot.settings);
      $('#hotelName').textContent = boot.settings.hotelName;
      $('#restName').textContent = `${boot.settings.restaurantName} · ${location.host}`;
      $('#mark').textContent = boot.settings.hotelName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
      $('#healthChip').textContent = `${health.open} open order(s) · ${health.guests} live screen(s)`;
    } catch (err) {
      $('#healthChip').textContent = 'server offline';
      toast(err.message, 'err');
      return;
    }
  }

  async function floor() {
    // the landing page is public, so it only shows aggregate stats
    try {
      const boot = await api('/api/bootstrap');
      $('#floorSub').textContent = `${boot.tables.length} tables · ${boot.menu.items.length} dishes`;
      $('#floorBody').innerHTML = `
        <div class="grid grid-3">
          ${boot.tables.slice(0, 12).map((t) => `
            <a class="table-tile" href="/menu.html?table=${encodeURIComponent(t.id)}" style="text-decoration:none">
              <span class="t-name">${esc(t.label)}</span>
              <span class="t-zone">${esc(t.zone || '')} · ${t.seats} seats</span>
              <span class="t-status">Open menu →</span>
            </a>`).join('')}
        </div>
        <p class="tiny muted" style="margin-top:10px">Tap a table to open the exact page its QR code points to.</p>`;
    } catch (err) {
      $('#floorBody').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  $('#demoOrder').addEventListener('click', async () => {
    try {
      const res = await api('/api/demo/order', { method: 'POST', body: {} });
      toast(`Order ${res.order.id} created at ${res.table} — approve it in the staff console`, 'ok', 5000);
      load();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  load();
  floor();
  setInterval(load, 15000);
})();
