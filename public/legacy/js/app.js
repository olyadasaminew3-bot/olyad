/* ============================================================
   PoultryHealth Pro — Application Logic
   ============================================================ */

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

/* ============================================================
   Toast notifications
   ============================================================ */
const toastStack = document.createElement('div');
toastStack.className = 'toast-stack';
document.body.appendChild(toastStack);

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'fa-circle-check'
               : type === 'error' ? 'fa-circle-xmark'
               : 'fa-triangle-exclamation';
    toast.innerHTML = `<i class="fas ${icon}"></i><span>${message}</span>`;
    toastStack.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('out');
        setTimeout(() => toast.remove(), 380);
    }, 3400);
}

/* ============================================================
   Preloader
   ============================================================ */
window.addEventListener('load', () => {
    setTimeout(() => $('#preloader')?.classList.add('hidden'), 450);
});
// Failsafe: never block the page more than 3s
setTimeout(() => $('#preloader')?.classList.add('hidden'), 3000);

/* ============================================================
   Navbar: scroll state, hamburger, scroll-spy
   ============================================================ */
const navbar = $('#navbar');
const hamburger = $('#hamburger');
const navLinks = $('#navLinks');

function onScrollNav() {
    navbar.classList.toggle('scrolled', window.scrollY > 60);
    $('#backToTop')?.classList.toggle('visible', window.scrollY > 600);
}
window.addEventListener('scroll', onScrollNav, { passive: true });
onScrollNav();

hamburger.addEventListener('click', () => {
    hamburger.classList.toggle('open');
    navLinks.classList.toggle('open');
});

$$('a', navLinks).forEach(a => a.addEventListener('click', () => {
    hamburger.classList.remove('open');
    navLinks.classList.remove('open');
}));

// Scroll-spy: highlight nav link of the section in view
const spySections = $$('section[id]');
const navMap = {};
$$('#navLinks a').forEach(a => {
    const id = a.getAttribute('href').replace('#', '');
    navMap[id] = a;
});
const spyObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            $$('#navLinks a').forEach(a => a.classList.remove('active'));
            navMap[entry.target.id]?.classList.add('active');
        }
    });
}, { rootMargin: '-38% 0px -55% 0px' });
spySections.forEach(s => spyObserver.observe(s));

/* ============================================================
   Alert banner
   ============================================================ */
$('#alertClose')?.addEventListener('click', () => {
    $('#alertBanner').classList.add('dismissed');
});

/* ============================================================
   Scroll-reveal animations
   ============================================================ */
$$('.section-header, .stat-card, .chart-card, .tip-card, .flock-card, .contact-card, .feed-calculator, .feed-guide, .symptom-panel, .result-panel, .diseases-reference')
    .forEach(el => el.classList.add('reveal'));
const revealObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            revealObserver.unobserve(entry.target);
        }
    });
}, { threshold: 0.12 });
$$('.reveal').forEach(el => revealObserver.observe(el));

/* ============================================================
   Modals (generic open/close)
   ============================================================ */
function openModal(id) {
    $(`#${id}`)?.classList.add('open');
    document.body.style.overflow = 'hidden';
}
function closeModal(modal) {
    modal.classList.remove('open');
    if (!$('.modal.open')) document.body.style.overflow = '';
}
$$('.modal').forEach(modal => {
    modal.addEventListener('click', e => {
        if (e.target === modal || e.target.closest('.modal-close')) closeModal(modal);
    });
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $$('.modal.open').forEach(closeModal);
});

$('#addFlockBtn')?.addEventListener('click', () => openModal('addFlockModal'));
$('#addFlockCard')?.addEventListener('click', () => openModal('addFlockModal'));
$('#emergencyBtn')?.addEventListener('click', () => openModal('emergencyModal'));

/* ============================================================
   Dashboard charts (Chart.js)
   ============================================================ */
if (window.Chart) {
    Chart.defaults.font.family = "'Poppins', sans-serif";
    Chart.defaults.color = '#67766a';
}

function seededSeries(n, seed, base, jitter) {
    // Deterministic pseudo-random series so the demo data is stable
    const out = [];
    let s = seed;
    for (let i = 0; i < n; i++) {
        s = (s * 9301 + 49297) % 233280;
        out.push(Math.round(base + (s / 233280 - 0.5) * 2 * jitter));
    }
    return out;
}

function buildTrendData(days) {
    const labels = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }
    return {
        labels,
        healthy: seededSeries(days, days * 7 + 3, 845, 14),
        sick: seededSeries(days, days * 13 + 11, 6, 4).map(v => Math.max(0, v)),
    };
}

let trendChart = null;
function initTrendChart() {
    const canvas = $('#healthTrendChart');
    if (!canvas || !window.Chart) return;
    const ctx = canvas.getContext('2d');
    const gradHealthy = ctx.createLinearGradient(0, 0, 0, 280);
    gradHealthy.addColorStop(0, 'rgba(47, 158, 68, 0.28)');
    gradHealthy.addColorStop(1, 'rgba(47, 158, 68, 0.01)');
    const gradSick = ctx.createLinearGradient(0, 0, 0, 280);
    gradSick.addColorStop(0, 'rgba(224, 49, 49, 0.20)');
    gradSick.addColorStop(1, 'rgba(224, 49, 49, 0.01)');

    const data = buildTrendData(30);
    trendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.labels,
            datasets: [
                {
                    label: 'Healthy birds',
                    data: data.healthy,
                    borderColor: '#2f9e44',
                    backgroundColor: gradHealthy,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    borderWidth: 2.5,
                    yAxisID: 'y',
                },
                {
                    label: 'Sick birds',
                    data: data.sick,
                    borderColor: '#e03131',
                    backgroundColor: gradSick,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    borderWidth: 2.5,
                    yAxisID: 'y1',
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    labels: { usePointStyle: true, pointStyle: 'circle', boxHeight: 7 },
                },
                tooltip: {
                    backgroundColor: '#12341c',
                    padding: 12,
                    cornerRadius: 10,
                },
            },
            scales: {
                x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
                y: {
                    position: 'left',
                    grid: { color: 'rgba(47,158,68,0.08)' },
                    title: { display: true, text: 'Healthy' },
                },
                y1: {
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    title: { display: true, text: 'Sick' },
                    min: 0,
                    suggestedMax: 20,
                },
            },
        },
    });
}

$('#chartFilter')?.addEventListener('change', e => {
    const days = parseInt(e.target.value.replace(/\D/g, ''), 10) || 30;
    if (!trendChart) return;
    const data = buildTrendData(days);
    trendChart.data.labels = data.labels;
    trendChart.data.datasets[0].data = data.healthy;
    trendChart.data.datasets[1].data = data.sick;
    trendChart.update();
    $('.chart-card.large .card-header h3').innerHTML =
        `<i class="fas fa-chart-area"></i> Health Trend (Last ${days} Days)`;
});

function initDistChart() {
    const canvas = $('#flockDistChart');
    if (!canvas || !window.Chart) return;
    new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['Healthy (847)', 'Under Observation (23)', 'Sick / Infected (5)'],
            datasets: [{
                data: [847, 23, 5],
                backgroundColor: ['#2f9e44', '#f59e0b', '#e03131'],
                borderWidth: 3,
                borderColor: '#ffffff',
                hoverOffset: 10,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '62%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { usePointStyle: true, pointStyle: 'circle', boxHeight: 7, padding: 14, font: { size: 11.5 } },
                },
                tooltip: { backgroundColor: '#12341c', padding: 12, cornerRadius: 10 },
            },
        },
    });
}

initTrendChart();
initDistChart();

/* ============================================================
   Environment gauges
   ============================================================ */
const GAUGE_CIRC = 2 * Math.PI * 40; // r = 40
const gaugeObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const gauge = entry.target;
        const value = parseFloat(gauge.dataset.value) || 0;
        const max = parseFloat(gauge.dataset.max) || 100;
        const fill = gauge.querySelector('.gauge-fill');
        if (fill) {
            fill.style.strokeDashoffset = GAUGE_CIRC * (1 - Math.min(value / max, 1));
        }
        gaugeObserver.unobserve(gauge);
    });
}, { threshold: 0.4 });
$$('.env-gauge').forEach(g => gaugeObserver.observe(g));

/* ============================================================
   Disease Symptom Checker
   ============================================================ */
const SYMPTOM_LABELS = {
    sneezing: 'Sneezing / Coughing',
    nasal_discharge: 'Nasal Discharge',
    breathing_difficulty: 'Difficulty Breathing',
    gasping: 'Gasping / Wheezing',
    swollen_sinus: 'Swollen Sinuses',
    diarrhea: 'Diarrhea',
    bloody_droppings: 'Bloody Droppings',
    loss_appetite: 'Loss of Appetite',
    green_droppings: 'Green/Yellow Droppings',
    swollen_head: 'Swollen Head/Wattles',
    pale_comb: 'Pale/Blue Comb',
    ruffled_feathers: 'Ruffled Feathers',
    lameness: 'Lameness / Leg Issues',
    skin_lesions: 'Skin Lesions / Scabs',
    lethargy: 'Lethargy / Depression',
    drop_egg: 'Drop in Egg Production',
    sudden_death: 'Sudden Death',
    twisted_neck: 'Twisted Neck / Paralysis',
};

const DISEASE_DB = [
    {
        id: 'newcastle',
        name: 'Newcastle Disease (ND)',
        severity: 'high',
        symptoms: ['sneezing', 'gasping', 'breathing_difficulty', 'green_droppings', 'diarrhea', 'twisted_neck', 'drop_egg', 'sudden_death', 'lethargy'],
        prevention: 'Vaccinate at Day 7 (B1) and Day 21 (LaSota) plus boosters. Enforce strict biosecurity.',
        treatment: 'No specific cure. Supportive care: multivitamins & electrolytes in water; antibiotics only for secondary bacterial infections.',
        action: 'Highly contagious — isolate sick birds and vaccinate the rest of the flock immediately.',
    },
    {
        id: 'gumboro',
        name: 'Infectious Bursal Disease (Gumboro)',
        severity: 'high',
        symptoms: ['diarrhea', 'lethargy', 'ruffled_feathers', 'loss_appetite', 'sudden_death', 'lameness'],
        prevention: 'Vaccinate at Day 14 and Day 28. Time vaccination around maternal antibody levels.',
        treatment: 'No specific cure. Provide electrolytes and vitamins, ensure hydration, keep the house warm and dry.',
        action: 'Immunosuppressive — surviving birds become vulnerable to other infections. Boost biosecurity.',
    },
    {
        id: 'coccidiosis',
        name: 'Coccidiosis',
        severity: 'medium',
        symptoms: ['bloody_droppings', 'diarrhea', 'loss_appetite', 'ruffled_feathers', 'lethargy', 'pale_comb'],
        prevention: 'Use coccidiostats in feed, keep litter dry, avoid overcrowding and wet spots near drinkers.',
        treatment: 'Amprolium (Corid) in drinking water for 5-7 days. Sulfa drugs as an alternative. Supplement with vitamin K and A.',
        action: 'Remove wet litter immediately and treat the whole house via water medication.',
    },
    {
        id: 'crd',
        name: 'Chronic Respiratory Disease (Mycoplasma)',
        severity: 'medium',
        symptoms: ['sneezing', 'nasal_discharge', 'swollen_sinus', 'gasping', 'loss_appetite', 'drop_egg', 'lethargy'],
        prevention: 'Good ventilation, low stocking density, dust & ammonia control, source MG-free chicks.',
        treatment: 'Tylosin, Tilmicosin or Enrofloxacin in water/feed for 5 days. Improve ventilation immediately.',
        action: 'Reduce ammonia and dust; check litter moisture and ventilation fans today.',
    },
    {
        id: 'avian_influenza',
        name: 'Avian Influenza (Bird Flu)',
        severity: 'high',
        symptoms: ['swollen_head', 'pale_comb', 'lethargy', 'drop_egg', 'sudden_death', 'sneezing', 'nasal_discharge', 'ruffled_feathers', 'breathing_difficulty'],
        prevention: 'Strict biosecurity, keep wild birds away from feed and water, report suspected cases to authorities.',
        treatment: 'No treatment. This is a notifiable disease — contact your veterinary authority immediately.',
        action: 'EMERGENCY: restrict all farm movement, isolate birds, and call the emergency vet line now.',
    },
    {
        id: 'fowl_pox',
        name: 'Fowl Pox',
        severity: 'low',
        symptoms: ['skin_lesions', 'swollen_head', 'loss_appetite', 'drop_egg', 'lethargy'],
        prevention: 'Vaccination (wing-web stab), mosquito control, prevent skin wounds and pecking.',
        treatment: 'No specific treatment. Apply iodine/gentian violet on lesions; antibiotics for secondary infections. Usually self-limiting in 3-4 weeks.',
        action: 'Control mosquitoes and apply topical antiseptic to visible scabs.',
    },
    {
        id: 'fowl_cholera',
        name: 'Fowl Cholera (Pasteurellosis)',
        severity: 'high',
        symptoms: ['pale_comb', 'green_droppings', 'diarrhea', 'loss_appetite', 'sudden_death', 'ruffled_feathers', 'swollen_head'],
        prevention: 'Vaccination in endemic areas, rodent control, sanitation between flocks.',
        treatment: 'Sulfa drugs or tetracyclines per vet direction. Chronic cases may need culling.',
        action: 'Collect dead birds for lab diagnosis — peracute deaths need confirmation before mass treatment.',
    },
    {
        id: 'coryza',
        name: 'Infectious Coryza',
        severity: 'medium',
        symptoms: ['swollen_head', 'nasal_discharge', 'sneezing', 'drop_egg', 'lethargy', 'loss_appetite'],
        prevention: 'Vaccination, all-in/all-out management, good ventilation, avoid mixing ages.',
        treatment: 'Sulfonamides (e.g., sulfadimethoxine) or trimethoprim-sulfa in water for 5-7 days.',
        action: 'Facial swelling with foul-smelling discharge is typical — start medication early.',
    },
    {
        id: 'mareks',
        name: "Marek's Disease",
        severity: 'high',
        symptoms: ['lameness', 'twisted_neck', 'ruffled_feathers', 'lethargy', 'pale_comb'],
        prevention: 'Day-1 hatchery vaccination is essential. Keep the brooding area clean; the virus persists in dander.',
        treatment: 'No treatment. Affected birds should be culled; vaccinate future batches at the hatchery.',
        action: 'Confirm with a vet — paralysis in young birds strongly suggests Marek\u2019s.',
    },
    {
        id: 'necrotic_enteritis',
        name: 'Necrotic Enteritis',
        severity: 'medium',
        symptoms: ['diarrhea', 'bloody_droppings', 'loss_appetite', 'lethargy', 'ruffled_feathers', 'sudden_death'],
        prevention: 'Control coccidiosis (predisposing factor), avoid fish-meal excess, keep litter dry.',
        treatment: 'Amoxicillin or bacitracin in water/feed per vet advice; probiotics to restore gut flora.',
        action: 'Often follows coccidiosis — check litter condition and treat for both if unsure.',
    },
];

// Toggle .selected styling on symptom labels
$$('.symptom-input').forEach(input => {
    input.addEventListener('change', () => {
        input.closest('.symptom-checkbox').classList.toggle('selected', input.checked);
    });
});

function diagnose() {
    const selected = $$('.symptom-input:checked').map(i => i.value);
    const panel = $('#resultPanel');

    if (selected.length === 0) {
        showToast('Please select at least one symptom first.', 'warning');
        return;
    }

    const matches = DISEASE_DB.map(d => {
        const matched = d.symptoms.filter(s => selected.includes(s));
        // Score: coverage of selected symptoms (60%) + disease fit (40%)
        const coverage = matched.length / selected.length;
        const fit = matched.length / d.symptoms.length;
        const score = coverage * 0.6 + fit * 0.4;
        return { ...d, matched, confidence: Math.round(score * 100) };
    })
    .filter(d => d.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length || b.confidence - a.confidence)
    .slice(0, 4);

    if (matches.length === 0) {
        panel.innerHTML = `
            <div class="no-match">
                <i class="fas fa-circle-check"></i>
                <h3>No strong match found</h3>
                <p>The selected symptoms don't clearly point to a common disease. Keep monitoring and consult a vet if conditions worsen.</p>
                <button class="btn btn-outline btn-small emergency-cta" onclick="openEmergencyModal()">
                    <i class="fas fa-phone"></i> Ask a Vet Instead
                </button>
            </div>`;
        return;
    }

    const top = matches[0];
    const emergencyBtn = top.severity === 'high'
        ? `<button class="btn btn-danger emergency-cta" onclick="openEmergencyModal()">
               <i class="fas fa-phone-volume"></i> High severity detected — Open Emergency Guide
           </button>`
        : '';

    panel.innerHTML = `
        <div class="diagnosis-summary">
            <span><i class="fas fa-stethoscope"></i>&nbsp; ${selected.length} symptom${selected.length > 1 ? 's' : ''} analyzed — ${matches.length} possible disease${matches.length > 1 ? 's' : ''} found</span>
        </div>
        ${matches.map((d, i) => `
            <div class="disease-result ${i === 0 ? 'top-match' : ''}">
                <div class="result-top">
                    <h4>${d.name}</h4>
                    ${i === 0 ? '<span class="match-tag">Top Match</span>' : ''}
                </div>
                <span class="severity-badge ${d.severity}">
                    ${d.severity === 'high' ? 'High Severity' : d.severity === 'medium' ? 'Medium Severity' : 'Low Severity'}
                </span>
                <div class="confidence-row">
                    <div class="confidence-track">
                        <div class="confidence-fill ${d.severity === 'high' && d.confidence >= 60 ? 'high-risk' : ''}"
                             data-width="${d.confidence}"></div>
                    </div>
                    <span class="confidence-label">${d.confidence}%</span>
                </div>
                <div class="result-section">
                    <h5>Matched symptoms</h5>
                    <p>${d.matched.map(s => SYMPTOM_LABELS[s]).join(' · ')}</p>
                </div>
                <div class="result-section">
                    <h5>Recommended action</h5>
                    <p>${d.action}</p>
                </div>
                <div class="result-section">
                    <h5>Prevention</h5>
                    <p>${d.prevention}</p>
                </div>
                <div class="result-section">
                    <h5>Treatment</h5>
                    <p>${d.treatment}</p>
                </div>
            </div>
        `).join('')}
        ${emergencyBtn}
        <p style="font-size:11.5px;color:var(--muted);margin-top:6px;">
            ⚕️ This tool provides guidance only and is not a substitute for professional veterinary diagnosis.
        </p>`;

    // Animate confidence bars after paint
    requestAnimationFrame(() => {
        $$('.confidence-fill', panel).forEach(el => {
            el.style.width = el.dataset.width + '%';
        });
    });
}
window.openEmergencyModal = () => openModal('emergencyModal');

$('#diagnoseBtn')?.addEventListener('click', diagnose);

/* ============================================================
   Vaccination schedule
   ============================================================ */
const EXTRA_VACCINES = {
    layer: [
        { name: "Marek's Disease Vaccine", day: 'Day 1', route: 'SC Injection', status: 'completed', date: 'Given: Jan 10, 2025' },
        { name: 'Newcastle + IB (B1/H120)', day: 'Day 7', route: 'Eye Drop', status: 'completed', date: 'Given: Jan 17, 2025' },
        { name: 'Infectious Bursal Disease (IBD)', day: 'Day 14', route: 'Drinking Water', status: 'upcoming', date: 'Due in 3 days' },
        { name: 'Newcastle Booster (LaSota)', day: 'Day 21', route: 'Drinking Water', status: 'pending', date: 'Due: Feb 8, 2025' },
        { name: 'Fowl Pox (Wing-Web)', day: 'Week 6', route: 'Wing-Web Stab', status: 'pending', date: 'Due: Feb 22, 2025' },
        { name: 'Newcastle + IB Booster (Pre-Lay)', day: 'Week 16', route: 'Injection', status: 'pending', date: 'Due: May 3, 2025' },
    ],
    breeder: [
        { name: "Marek's Disease (HVT)", day: 'Day 1', route: 'SC Injection', status: 'completed', date: 'Given: Jan 12, 2025' },
        { name: 'Newcastle + IB (B1/H120)', day: 'Day 7', route: 'Eye Drop', status: 'completed', date: 'Given: Jan 19, 2025' },
        { name: 'Infectious Bursal Disease (IBD)', day: 'Day 14', route: 'Drinking Water', status: 'upcoming', date: 'Due in 3 days' },
        { name: 'Newcastle Booster (LaSota)', day: 'Day 21', route: 'Drinking Water', status: 'pending', date: 'Due: Feb 8, 2025' },
        { name: 'Fowl Pox + ILT (Pre-Lay)', day: 'Week 12-16', route: 'Wing-Web / Eye Drop', status: 'pending', date: 'Due: Apr 12, 2025' },
        { name: 'ND + IB + EDS Killed Vaccine', day: 'Week 18', route: 'Injection', status: 'pending', date: 'Due: May 17, 2025' },
    ],
};

const timeline = $('#vaccinationTimeline');

function timelineItemHTML({ name, day, route, status, date }, type) {
    const icons = { completed: 'fa-check', upcoming: 'fa-clock', pending: 'fa-hourglass-half' };
    const badges = { completed: 'Completed', upcoming: 'Due in 3 days', pending: 'Pending' };
    const dateLabel = status === 'completed' ? 'Given' : 'Due';
    const doneBtn = status !== 'completed'
        ? `<button class="btn btn-small btn-primary mark-done-btn"><i class="fas fa-check"></i> Mark as Done</button>`
        : '';
    return `
        <div class="timeline-item" data-type="${type}">
            <div class="timeline-marker ${status}"><i class="fas ${icons[status]}"></i></div>
            <div class="timeline-content">
                <div class="timeline-header">
                    <h4>${name}</h4>
                    <span class="badge ${status}">${badges[status]}</span>
                </div>
                <p><strong>${day}</strong> - ${route.toLowerCase()}</p>
                <div class="timeline-meta">
                    <span><i class="fas fa-calendar"></i> ${dateLabel}: ${date.replace(/^(Given|Due):\s*/, '')}</span>
                    <span><i class="fas fa-syringe"></i> Route: ${route}</span>
                </div>
                ${doneBtn}
            </div>
        </div>`;
}

// Inject layer & breeder schedules
Object.entries(EXTRA_VACCINES).forEach(([type, items]) => {
    timeline.insertAdjacentHTML('beforeend',
        items.map(item => timelineItemHTML(item, type)).join(''));
});

// Bird type filter
$$('.bird-type-filter .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        $$('.bird-type-filter .filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const type = btn.dataset.type;
        $$('.timeline-item', timeline).forEach(item => {
            item.classList.toggle('hidden-type', item.dataset.type !== type);
        });
    });
});

// Mark as done (event delegation — works for injected items too)
timeline.addEventListener('click', e => {
    const btn = e.target.closest('.mark-done-btn');
    if (!btn) return;
    const item = btn.closest('.timeline-item');
    const marker = item.querySelector('.timeline-marker');
    marker.className = 'timeline-marker completed';
    marker.innerHTML = '<i class="fas fa-check"></i>';
    const badge = item.querySelector('.badge');
    badge.className = 'badge completed';
    badge.textContent = 'Completed';
    const dateSpan = item.querySelector('.timeline-meta span');
    if (dateSpan) {
        const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        dateSpan.innerHTML = `<i class="fas fa-calendar"></i> Given: ${today}`;
    }
    btn.remove();
    const name = item.querySelector('h4').textContent;
    showToast(`Vaccination recorded: ${name}`);
});

/* ---------- Add vaccination modal (built dynamically) ---------- */
const addVaccineModal = document.createElement('div');
addVaccineModal.className = 'modal';
addVaccineModal.id = 'addVaccineModal';
addVaccineModal.innerHTML = `
    <div class="modal-content">
        <div class="modal-header">
            <h3><i class="fas fa-syringe"></i> Add Vaccination</h3>
            <button class="modal-close">&times;</button>
        </div>
        <form id="addVaccineForm">
            <div class="form-group">
                <label>Vaccine Name</label>
                <input type="text" id="vaccineName" placeholder="e.g., Newcastle Booster" required>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Timing</label>
                    <input type="text" id="vaccineDay" placeholder="e.g., Day 21 or Week 6" required>
                </div>
                <div class="form-group">
                    <label>Due Date</label>
                    <input type="date" id="vaccineDate" required>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Route</label>
                    <select id="vaccineRoute">
                        <option>Drinking Water</option>
                        <option>Eye Drop</option>
                        <option>SC Injection</option>
                        <option>IM Injection</option>
                        <option>Wing-Web Stab</option>
                        <option>Spray</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Bird Type</label>
                    <select id="vaccineType">
                        <option value="broiler">Broiler</option>
                        <option value="layer">Layer</option>
                        <option value="breeder">Breeder</option>
                    </select>
                </div>
            </div>
            <button type="submit" class="btn btn-primary btn-full">
                <i class="fas fa-plus"></i> Add to Schedule
            </button>
        </form>
    </div>`;
document.body.appendChild(addVaccineModal);

$('#addVaccineBtn')?.addEventListener('click', () => {
    const active = $('.bird-type-filter .filter-btn.active')?.dataset.type || 'broiler';
    $('#vaccineType').value = active;
    openModal('addVaccineModal');
});

$('#addVaccineForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#vaccineName').value.trim();
    const day = $('#vaccineDay').value.trim();
    const route = $('#vaccineRoute').value;
    const type = $('#vaccineType').value;
    const date = new Date($('#vaccineDate').value + 'T00:00:00');
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    timeline.insertAdjacentHTML('beforeend',
        timelineItemHTML({ name, day, route, status: 'pending', date: dateStr }, type));

    // Apply the current filter visibility
    const active = $('.bird-type-filter .filter-btn.active')?.dataset.type || 'broiler';
    $$('.timeline-item', timeline).forEach(item => {
        item.classList.toggle('hidden-type', item.dataset.type !== active);
    });

    closeModal(addVaccineModal);
    e.target.reset();
    showToast(`Vaccination "${name}" added to the ${type} schedule.`);
});

/* ============================================================
   Flock Manager
   ============================================================ */
$('#flockSearch')?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    $$('#flockGrid .flock-card').forEach(card => {
        if (card.id === 'addFlockCard') return;
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(q) ? '' : 'none';
    });
});

$('#newFlockForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target;
    const [name, typeSel, breed, count, placement, house] = $$('input, select', form).map(el => el.value);

    const type = typeSel.toLowerCase();
    const icon = type === 'broiler' ? '🐔' : type === 'layer' ? '🥚' : '🐣';
    const placed = new Date(placement + 'T00:00:00');
    const ageDays = Math.max(0, Math.floor((Date.now() - placed.getTime()) / 86400000));

    const isLayer = type !== 'broiler';
    const ageLabel = isLayer ? `${Math.max(1, Math.round(ageDays / 7))} weeks` : `${ageDays} days`;
    const target = isLayer ? 80 * 7 : 42;
    const progress = Math.min(100, Math.round((ageDays / target) * 100));
    const progressLabel = isLayer
        ? `Week ${Math.max(1, Math.round(ageDays / 7))} of 80`
        : `Day ${ageDays} of 42`;

    const card = document.createElement('div');
    card.className = 'flock-card';
    card.innerHTML = `
        <div class="flock-card-header">
            <div class="flock-icon ${type}">${icon}</div>
            <div class="flock-status healthy">Healthy</div>
        </div>
        <h3>${name}</h3>
        <div class="flock-details">
            <div class="detail-row"><span>Breed:</span><strong>${breed}</strong></div>
            <div class="detail-row"><span>Count:</span><strong>${Number(count).toLocaleString()} birds</strong></div>
            <div class="detail-row"><span>Age:</span><strong>${ageLabel}</strong></div>
            <div class="detail-row"><span>House:</span><strong>${house || '—'}</strong></div>
            <div class="detail-row"><span>Mortality:</span><strong class="text-green">0.0%</strong></div>
        </div>
        <div class="flock-progress">
            <label>${isLayer ? 'Laying Cycle' : 'Growth Progress'}</label>
            <div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>
            <span>${progressLabel}</span>
        </div>
        <div class="flock-actions">
            <button class="btn btn-small btn-outline"><i class="fas fa-edit"></i> Edit</button>
            <button class="btn btn-small btn-outline"><i class="fas fa-notes-medical"></i> Health Log</button>
        </div>`;
    card.classList.add('reveal', 'visible');

    $('#flockGrid').insertBefore(card, $('#addFlockCard'));
    closeModal('addFlockModal');
    form.reset();
    showToast(`Flock "${name}" registered successfully.`);
    $('#flock').scrollIntoView({ behavior: 'smooth' });
});

// Placeholder actions on flock cards (edit / health log)
$('#flockGrid')?.addEventListener('click', e => {
    const btn = e.target.closest('.flock-actions .btn');
    if (!btn) return;
    const action = btn.textContent.trim();
    showToast(`${action} feature is coming soon — records are saved locally in this demo.`, 'warning');
});

/* ============================================================
   Feed calculator
   ============================================================ */
function feedPerBirdGrams(type, age) {
    if (type === 'broiler') {            // age in days
        if (age <= 14) return 15 + 3.5 * age;          // ~18g → 64g
        if (age <= 28) return 64 + 5.2 * (age - 14);   // 64g → 137g
        return Math.min(220, 137 + 4.5 * (age - 28));  // 137g → 200g+
    }
    if (type === 'layer') {              // age in weeks
        if (age <= 6) return 10 + 3.2 * age;
        if (age <= 18) return 29 + 3.4 * (age - 6);
        return 115;                                      // laying phase
    }
    // chick: age in weeks, 0-4
    return Math.min(50, 12 + 9 * age);
}

function calculateFeed() {
    const type = $('#feedBirdType').value;
    const count = Math.max(1, parseInt($('#feedBirdCount').value, 10) || 1);
    const age = Math.max(1, parseInt($('#feedBirdAge').value, 10) || 1);

    const perBird = feedPerBirdGrams(type, age);       // grams
    const dailyKg = (perBird * count) / 1000;
    const weeklyKg = dailyKg * 7;
    const water = dailyKg * 1.8;                       // liters

    const fmt = v => v >= 100 ? `${Math.round(v)} kg` : `${v.toFixed(1)} kg`;
    $('#dailyFeed').textContent = fmt(dailyKg);
    $('#weeklyFeed').textContent = fmt(weeklyKg);
    $('#feedPerBird').textContent = perBird >= 100 ? `${Math.round(perBird)}g` : `${perBird.toFixed(0)}g`;
    $('#waterReq').textContent = `${Math.round(water)} liters`;
}

$('#feedForm')?.addEventListener('submit', e => {
    e.preventDefault();
    calculateFeed();
    showToast('Feed requirement calculated.');
});
calculateFeed(); // initialize with default values

/* Feed phase accordion */
$$('.feed-phase .phase-header').forEach(header => {
    header.addEventListener('click', () => {
        const phase = header.closest('.feed-phase');
        const wasActive = phase.classList.contains('active');
        $$('.feed-phase').forEach(p => p.classList.remove('active'));
        if (!wasActive) phase.classList.add('active');
    });
});

/* ============================================================
   Disease reference accordion
   ============================================================ */
$$('.accordion-header').forEach(header => {
    header.addEventListener('click', () => {
        const item = header.closest('.accordion-item');
        const wasOpen = item.classList.contains('open');
        $$('.accordion-item').forEach(i => i.classList.remove('open'));
        if (!wasOpen) item.classList.add('open');
    });
});

/* ============================================================
   Contact form + newsletter
   ============================================================ */
$('#contactForm')?.addEventListener('submit', e => {
    e.preventDefault();
    showToast('Query submitted! A vet expert will contact you within 2 hours.');
    e.target.reset();
});

$('.newsletter-form')?.addEventListener('submit', e => e.preventDefault());
$('.newsletter-form button')?.addEventListener('click', () => {
    const input = $('.newsletter-form input');
    if (!input.value || !input.value.includes('@')) {
        showToast('Please enter a valid email address.', 'error');
        return;
    }
    input.value = '';
    showToast('Subscribed! Weekly poultry health tips are on the way. 🐔');
});

/* Contact card buttons (demo) */
$$('.contact-card .btn').forEach(btn => {
    btn.addEventListener('click', () => {
        showToast(`"${btn.textContent.trim()}" is a demo action in this preview.`, 'warning');
    });
});

/* ============================================================
   Back to top
   ============================================================ */
$('#backToTop')?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
});
