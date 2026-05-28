'use strict';

let _Homey = null;
let refreshInterval = null;

async function refresh() {
  if (!_Homey) return;
  try {
    const [state, plan] = await Promise.all([
      _Homey.api('GET', '/getState', {}),
      _Homey.api('GET', '/getPlan', {}),
    ]);
    renderState(state);
    renderPlan(plan);
  } catch (e) {
    console.error('Dashboard refresh error', e);
  }
}

function renderState(s) {
  if (!s || !s.ready) return;

  const badge = document.getElementById('modeBadge');
  const modeLabels = {
    auto: 'Auto', battery_charge: '🔴 Laden', solar_surplus: '🟡 Overschot',
    battery_discharge: '🟢 Ontladen', grid_import: '🔵 Netimport', idle: '⏸ Inactief',
  };
  badge.textContent = modeLabels[s.mode] || s.mode;
  badge.className   = `mode-badge mode-${s.mode}`;

  setEl('pvW',   fmtW(s.pvW));
  setEl('pvKwh', `vandaag ${(s.pvKwhToday ?? 0).toFixed(1)} kWh`);

  const soc = s.batSoc ?? 0;
  setEl('batSoc',   `${soc.toFixed(0)}%`);
  setEl('batPower', `${s.batPowerW > 0 ? '↑ laden' : s.batPowerW < 0 ? '↓ ontladen' : '–'} ${Math.abs(s.batPowerW ?? 0).toFixed(0)}W`);
  const arc = document.getElementById('socArc');
  if (arc) arc.setAttribute('stroke-dasharray', `${soc} ${100 - soc}`);

  const gw = s.gridW ?? 0;
  setEl('gridW',   fmtW(Math.abs(gw)));
  setEl('gridDir', gw > 50 ? '↓ importeren' : gw < -50 ? '↑ terugleveren' : 'Balans');

  if (s.evCharging) {
    setEl('evStatus', '⚡ Aan het laden');
    setEl('evDetail', `${fmtW(s.evPowerW ?? 0)} · sessie ${(s.evSessionKwh ?? 0).toFixed(1)} kWh`);
  } else if (s.evConnected) {
    setEl('evStatus', '🔌 Aangesloten');
    setEl('evDetail', s.evSoc ? `${s.evSoc.toFixed(0)}% SoC` : 'Wacht op zon');
  } else {
    setEl('evStatus', '– Niet aangesloten');
    setEl('evDetail', '');
  }
  setEl('evCurrentA', s.evCurrentA > 0 ? `${s.evCurrentA}A` : '–');
  setEl('evSource',   s.evSource === 'wall_connector' ? '📡 Wall Connector' : '☁️ Tesla app');

  const hpLabels = { heating: '🔥 Verwarmen', cooling: '❄️ Koelen' };
  setEl('hpMode',   hpLabels[s.hpMode] || s.hpMode || '–');
  setEl('hpOffset', `offset: ${s.hpOffset >= 0 ? '+' : ''}${(s.hpOffset ?? 0).toFixed(1)}°C`);

  if (s.activeTrip) {
    const dep = new Date(s.activeTrip.departureTime);
    document.getElementById('activeTripInfo').textContent =
      `🗓 Actieve rit: ${dep.toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' })} @ ${s.activeTrip.targetSoc}%`;
  }

  setEl('lastUpdate', `Bijgewerkt: ${new Date().toLocaleTimeString('nl-NL')}`);
}

function renderPlan(plan) {
  if (!plan) {
    document.getElementById('planSummary').textContent = 'Geen plan beschikbaar — herbereken om te starten.';
    return;
  }
  const s   = plan.summary;
  const now = new Date().getHours();
  const feasIcon = s.prio1Feasible ? '✅' : '⚠️';
  document.getElementById('planSummary').innerHTML =
    `${feasIcon} PV: <b>${s.totalPvKwh} kWh</b> · Verbruik: <b>${s.totalConsumptionKwh} kWh</b> · ` +
    `Net: <b>${s.netKwh > 0 ? '+' : ''}${s.netKwh} kWh</b>` +
    (s.hasCheapHours ? ' · 💰 Goedkope uren' : '') +
    (s.evNeededKwh > 0 ? ` · 🚗 EV: ${s.evNeededKwh} kWh` : '');

  const tbody = document.getElementById('planTableBody');
  tbody.innerHTML = '';
  for (const h of plan.schedule) {
    const tr = document.createElement('tr');
    if (h.hour === now) tr.className = 'current';
    const batSymbol = { charge:'↑', discharge:'↓', grid_charge:'⚡', idle:'–' }[h.batAction] || '–';
    const batColor  = { charge:'blue', discharge:'green', grid_charge:'orange' }[h.batAction] || 'grey';
    const priceStr  = h.priceEur !== null
      ? `€${h.priceEur.toFixed(3)}${h.isCheap ? ' 💚' : h.isExpensive ? ' 🔴' : ''}`
      : '–';
    tr.innerHTML = `
      <td>${String(h.hour).padStart(2,'0')}:00</td>
      <td>${h.pvKwh > 0 ? `${(h.pvKwh*1000).toFixed(0)}Wh` : '–'}</td>
      <td>${(h.consumKwh*1000).toFixed(0)}Wh</td>
      <td><span class="plan-dot dot-${batColor}"></span> ${batSymbol} ${Math.abs(h.batDeltaKwh*1000).toFixed(0)}Wh → ${h.batSocPct}%</td>
      <td>${h.evCharging ? '⚡' : '–'}</td>
      <td>${priceStr}</td>`;
    tbody.appendChild(tr);
  }
}

async function planTrip() {
  const time = document.getElementById('tripTime').value;
  const soc  = parseInt(document.getElementById('tripSoc').value);
  if (!time || !soc) { alert('Vul vertrektijd en gewenste SoC in'); return; }
  try {
    await _Homey.api('POST', '/planTrip', { departureTime: time, targetSoc: soc });
    await refresh();
  } catch (e) { alert('Fout: ' + e.message); }
}

async function recalculate() {
  try {
    await _Homey.api('POST', '/recalculate', {});
    await refresh();
  } catch (e) { alert('Fout: ' + e.message); }
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function fmtW(w) {
  if (w === undefined || w === null) return '–';
  return w >= 1000 ? `${(w/1000).toFixed(2)} kW` : `${Math.round(w)} W`;
}
