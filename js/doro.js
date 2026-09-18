/* Doro Smart Poultry — auth, farm profile, plans (ETB), PLC + QR */

const DORO_KEY = 'doro_smart_v1';

function doroLoad() {
  try { return JSON.parse(localStorage.getItem(DORO_KEY)) || { users: [], session: null }; }
  catch { return { users: [], session: null }; }
}
function doroSave(db) { localStorage.setItem(DORO_KEY, JSON.stringify(db)); }

function currentUser() {
  const db = doroLoad();
  if (!db.session) return null;
  return db.users.find(u => u.email === db.session) || null;
}

function hashPass(p) {
  let h = 0;
  for (let i = 0; i < p.length; i++) h = ((h << 5) - h) + p.charCodeAt(i) | 0;
  return String(h);
}

function showApp(user) {
  $('#authGate')?.classList.add('hidden');
  document.body.classList.remove('app-locked');
  renderUserChip(user);
  renderFarmBanner(user);
  renderPlc(user);
  renderPlans(user);
}

function hideApp() {
  $('#authGate')?.classList.remove('hidden');
  document.body.classList.add('app-locked');
}

function renderUserChip(user) {
  const el = $('#userChip');
  if (!el) return;
  el.innerHTML = `<i class="fas fa-user-circle"></i>
    <span>${user.email}</span>
    <span class="badge-plan ${user.plan === 'paid' ? 'paid' : ''}">${user.plan === 'paid' ? 'PAID' : 'FREE'}</span>
    <button type="button" id="logoutBtn" title="Sign out"><i class="fas fa-sign-out-alt"></i></button>`;
  $('#logoutBtn')?.addEventListener('click', () => {
    const db = doroLoad();
    db.session = null;
    doroSave(db);
    hideApp();
    showToast('Signed out.');
  });
}

function renderFarmBanner(user) {
  const b = $('#farmBanner');
  if (!b) return;
  const f = user.farm || {};
  b.innerHTML = `
    <div>
      <strong>${f.name || 'Your farm'}</strong>
      · ${f.region || 'Ethiopia'} · ${f.birds || 0} birds · ${f.house || 'House 1'}
    </div>
    <div>Doro Smart · <a href="https://dorosmart.com" style="color:#fff;text-decoration:underline">dorosmart.com</a></div>`;
}

function renderPlans(user) {
  const paid = user.plan === 'paid';
  $$('.upgrade-cta').forEach(btn => {
    btn.textContent = paid ? 'You are on Paid' : 'Upgrade — 1,499 ETB / mo';
    btn.disabled = paid;
  });
  $$('.paid-only').forEach(el => {
    el.classList.toggle('is-locked', !paid);
  });
}

function plcState(user) {
  user.plc = user.plc || {
    feed: 72, water: 81, temp: 27.4, humidity: 64,
    feederOn: true, drinkerOn: true, heaterOn: false, fanOn: true, lightsOn: true
  };
  return user.plc;
}

function persistUser(user) {
  const db = doroLoad();
  const i = db.users.findIndex(u => u.email === user.email);
  if (i >= 0) db.users[i] = user;
  doroSave(db);
}

function renderPlc(user) {
  const p = plcState(user);
  const paid = user.plan === 'paid';
  const box = $('#plcMetrics');
  if (box) {
    box.innerHTML = `
      <div class="plc-metric"><div class="v">${p.feed}%</div><div class="l">Feed silo</div></div>
      <div class="plc-metric"><div class="v">${p.water}%</div><div class="l">Water tank</div></div>
      <div class="plc-metric"><div class="v">${p.temp}°C</div><div class="l">House temperature</div></div>
      <div class="plc-metric"><div class="v">${p.humidity}%</div><div class="l">Humidity</div></div>`;
  }
  const ctr = $('#plcControls');
  if (ctr) {
    const mk = (key, label, on) =>
      `<button class="${on ? 'on' : 'off'}" data-k="${key}" ${paid ? '' : 'disabled'}>${label}: ${on ? 'ON' : 'OFF'}</button>`;
    ctr.innerHTML =
      mk('feederOn', 'Feeder', p.feederOn) +
      mk('drinkerOn', 'Drinkers', p.drinkerOn) +
      mk('heaterOn', 'Heater', p.heaterOn) +
      mk('fanOn', 'Fans', p.fanOn) +
      mk('lightsOn', 'Lights', p.lightsOn);
    if (!paid) {
      ctr.insertAdjacentHTML('beforeend', '<p class="lock-note">Paid plan required for live PLC control. Free users can view telemetry only.</p>');
    }
    ctr.querySelectorAll('button[data-k]').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.k;
        p[k] = !p[k];
        persistUser(user);
        renderPlc(user);
        showToast(`${btn.textContent.split(':')[0]} ${p[k] ? 'started' : 'stopped'}.`);
      });
    });
  }
  const qr = $('#plcQr');
  if (qr) {
    const payload = encodeURIComponent(`https://dorosmart.com/plc?farm=${encodeURIComponent(user.farm?.name || 'farm')}&id=${encodeURIComponent(user.email)}`);
    qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${payload}`;
  }
  const token = $('#plcToken');
  if (token) token.textContent = 'PLC-' + hashPass(user.email + (user.farm?.name || '')).replace('-', 'P');
}

function switchAuthTab(tab) {
  $$('.auth-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#loginForm')?.classList.toggle('hidden', tab !== 'login');
  $('#signupForm')?.classList.toggle('hidden', tab !== 'signup');
}

document.addEventListener('DOMContentLoaded', () => {
  $$('.auth-tabs button').forEach(b => b.addEventListener('click', () => switchAuthTab(b.dataset.tab)));

  $('#loginForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim().toLowerCase();
    const pass = $('#loginPass').value;
    const db = doroLoad();
    const user = db.users.find(u => u.email === email && u.pass === hashPass(pass));
    if (!user) { showToast('Wrong email or password.', 'error'); return; }
    db.session = email;
    doroSave(db);
    showApp(user);
    showToast('Welcome back to Doro Smart.');
  });

  $('#signupForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const email = $('#signupEmail').value.trim().toLowerCase();
    const pass = $('#signupPass').value;
    if (pass.length < 6) { showToast('Password must be at least 6 characters.', 'warning'); return; }
    const db = doroLoad();
    if (db.users.some(u => u.email === email)) { showToast('Account already exists. Please log in.', 'warning'); return; }
    const user = {
      email, pass: hashPass(pass), plan: 'free',
      farm: {
        name: $('#farmName').value.trim(),
        region: $('#farmRegion').value.trim(),
        birds: Number($('#farmBirds').value) || 0,
        house: $('#farmHouse').value.trim(),
        type: $('#farmType').value
      }
    };
    db.users.push(user);
    db.session = email;
    doroSave(db);
    showApp(user);
    showToast('Account created. You are on the Free plan.');
  });

  $('#payCbeBtn')?.addEventListener('click', () => {
    showToast('Transfer 1,499 ETB to CBE 1000707418757 then tap Confirm payment.');
  });
  $('#payTeleBtn')?.addEventListener('click', () => {
    showToast('Send 1,499 ETB via Telebirr to +251904743453 then tap Confirm payment.');
  });
  $('#confirmPayBtn')?.addEventListener('click', () => {
    const user = currentUser();
    if (!user) return;
    const ref = $('#payRef')?.value.trim();
    if (!ref) { showToast('Enter your CBE or Telebirr reference.', 'warning'); return; }
    user.plan = 'paid';
    user.payRef = ref;
    persistUser(user);
    const db = doroLoad();
    db.session = user.email;
    doroSave(db);
    showApp(user);
    showToast('Payment recorded. Paid features unlocked. Thank you!');
  });

  $('#dispenseFeed')?.addEventListener('click', () => {
    const user = currentUser();
    if (!user) return;
    if (user.plan !== 'paid') { showToast('Upgrade to Paid to command the PLC feeder.', 'warning'); return; }
    const p = plcState(user);
    p.feed = Math.min(100, p.feed + 8);
    persistUser(user); renderPlc(user);
    showToast('Feeder pulse sent — silo +8%.');
  });
  $('#refillWater')?.addEventListener('click', () => {
    const user = currentUser();
    if (!user) return;
    if (user.plan !== 'paid') { showToast('Upgrade to Paid to command drinkers.', 'warning'); return; }
    const p = plcState(user);
    p.water = Math.min(100, p.water + 10);
    persistUser(user); renderPlc(user);
    showToast('Water line opened — tank +10%.');
  });

  const user = currentUser();
  if (user) showApp(user);
  else hideApp();
});

setInterval(() => {
  const user = currentUser();
  if (!user) return;
  const p = plcState(user);
  p.temp = Math.round((p.temp + (Math.random() - 0.48) * 0.4) * 10) / 10;
  p.humidity = Math.min(90, Math.max(40, Math.round(p.humidity + (Math.random() - 0.5) * 2)));
  if (p.feederOn) p.feed = Math.max(12, p.feed - 0.2);
  if (p.drinkerOn) p.water = Math.max(15, p.water - 0.15);
  persistUser(user);
  if ($('#plc')?.getBoundingClientRect().top < innerHeight) renderPlc(user);
}, 4000);
