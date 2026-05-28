'use strict';

/* ═══════════════════════════════════════════════════════════
   EMS Setup Wizard — JavaScript
   ═══════════════════════════════════════════════════════════ */

const TOTAL_STEPS = 9;
let currentStep   = 1;
let allDevices    = [];

// Config object built up across wizard steps
const config = {
  installName:    '',
  lat: 52.3, lon: 4.9,
  phases: 3, maxAmps: 25,
  contractType:   'fixed',
  priceImport:    0.30,
  priceExport:    0.09,
  dayAheadProvider: 'entso-e',
  dayAheadApiKey:   '',
  zeroExport:     false,
  pvStrings:      [],
  pvMeterIds:     [],
  gridMeterId:    null,
  batteries:      [],
  batMinSoc:      20,
  batTargetSoc:   90,
  hasEv:          false,
  ev:             null,
  thermostats:    [],
  thermostatSettings: {},
  hasPool:        false,
  pool:           null,
  dumpLoadIds:    [],
  surplusThreshold: 300,
  setupComplete:  false,
};


function _injectEvProfileWidget() {
  const el = document.getElementById('evProfileSection');
  if (!el) return;
  el.innerHTML = `
    <style>
      .profile-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:14px}
      .profile-card{border:2px solid var(--border,#e0e0e0);border-radius:10px;padding:10px 8px;cursor:pointer;text-align:center;transition:all .15s;background:#fff}
      .profile-card:hover{border-color:#aaa}
      .profile-card.active{border-color:#1a73e8;background:#e8f0fe}
      .profile-card .p-icon{font-size:20px;margin-bottom:3px}
      .profile-card .p-label{font-size:12px;font-weight:600}
      .profile-card .p-desc{font-size:10px;color:#5f6368;margin-top:2px}
      .ev-panel{background:#fff;border:1px solid #e0e0e0;border-radius:10px;padding:14px;margin-bottom:10px}
      .curr-row{display:flex;align-items:center;gap:12px;margin-top:8px}
      .curr-big{font-size:32px;font-weight:700;color:#1a73e8;min-width:52px;text-align:right}
      .curr-wrap{flex:1}
      input[type=range]{width:100%;accent-color:#1a73e8}
    </style>
    <div class="profile-cards" id="modeCards">
      <div class="profile-card" data-mode="solar_only"     onclick="selectMode('solar_only')"><div class="p-icon">☀️</div><div class="p-label">Alleen zon</div><div class="p-desc">Stopt bij geen overschot</div></div>
      <div class="profile-card" data-mode="solar_and_grid" onclick="selectMode('solar_and_grid')"><div class="p-icon">☀️🔌</div><div class="p-label">Zon + net</div><div class="p-desc">Valt terug op net bij rit</div></div>
      <div class="profile-card" data-mode="fixed"          onclick="selectMode('fixed')"><div class="p-icon">📌</div><div class="p-label">Vast</div><div class="p-desc">Altijd vaste stroom</div></div>
      <div class="profile-card" data-mode="fast_charge"    onclick="selectMode('fast_charge')"><div class="p-icon">⚡</div><div class="p-label">Snel laden</div><div class="p-desc">Maximaal vermogen</div></div>
      <div class="profile-card" data-mode="off"            onclick="selectMode('off')"><div class="p-icon">🚫</div><div class="p-label">Uit</div><div class="p-desc">EMS laadt niet</div></div>
    </div>
    <div id="fixedCurrentPanel" class="ev-panel" style="display:none">
      <label style="font-weight:600">Vaste laadstroom</label>
      <div class="curr-row">
        <div><div class="curr-big" id="fixedCurrentVal">8</div><div style="font-size:12px;color:#5f6368">A</div></div>
        <div class="curr-wrap">
          <input type="range" id="fixedCurrentSlider" min="6" max="32" step="1" value="8" oninput="updateFixedCurrent(this.value)"/>
          <div style="font-size:11px;color:#5f6368" id="fixedCurrentWatt">≈ 5520W op 3 fasen</div>
        </div>
      </div>
      <p style="font-size:11px;color:#5f6368;margin-top:8px">💡 Vaste stroom maakt de dagplanning nauwkeuriger.</p>
    </div>
    <div id="solarBoundsPanel" class="ev-panel" style="display:none">
      <label style="font-weight:600;margin-bottom:8px;display:block">Zon-volgend grenzen</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="font-size:13px">Maximum stroom (A)</label>
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
            <input type="range" id="maxCurrentSlider" min="6" max="32" step="1" value="16" oninput="updateBound('max',this.value)" style="flex:1;accent-color:#1a73e8"/>
            <span id="maxCurrentVal" style="font-size:16px;font-weight:700;min-width:32px">16A</span>
          </div>
          <div style="font-size:11px;color:#5f6368" id="maxCurrentWatt">≈ 11040W</div>
        </div>
        <div>
          <label style="font-size:13px">Minimum stroom (A)</label>
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
            <input type="range" id="minCurrentSlider" min="6" max="16" step="1" value="6" oninput="updateBound('min',this.value)" style="flex:1;accent-color:#34a853"/>
            <span id="minCurrentVal" style="font-size:16px;font-weight:700;min-width:32px">6A</span>
          </div>
          <div style="font-size:11px;color:#5f6368" id="minCurrentWatt">≈ 4140W</div>
        </div>
      </div>
    </div>
    <div id="profileSummary" style="font-size:12px;color:#5f6368;margin-top:8px;padding:10px;background:#f8f9fa;border-radius:8px"></div>
  `;
}

let _evProfileMode = 'solar_only';
let _evPhases = 3;

function initEvProfile(phases, settings) {
  _evPhases = phases || 3;
  if (settings) {
    document.getElementById('fixedCurrentSlider').value = settings.fixedCurrentA || 8;
    document.getElementById('maxCurrentSlider').value   = settings.maxCurrentA   || 16;
    document.getElementById('minCurrentSlider').value   = settings.minCurrentA   || 6;
    updateFixedCurrent(settings.fixedCurrentA || 8);
    updateBound('max', settings.maxCurrentA || 16);
    updateBound('min', settings.minCurrentA || 6);
    selectMode(settings.mode || 'solar_only', false);
  } else {
    selectMode('solar_only', false);
  }
}

function selectMode(mode, save = true) {
  document.querySelectorAll('.profile-card').forEach(c =>
    c.classList.toggle('active', c.dataset.mode === mode));
  const isFixed = mode === 'fixed';
  const isSolar = mode === 'solar_only' || mode === 'solar_and_grid';
  const fp = document.getElementById('fixedCurrentPanel');
  const sp = document.getElementById('solarBoundsPanel');
  if (fp) fp.style.display = isFixed ? 'block' : 'none';
  if (sp) sp.style.display = isSolar ? 'block' : 'none';
  if (save) _evProfileMode = mode;
  _updateProfileSummary(mode);
}

function updateFixedCurrent(val) {
  val = parseInt(val);
  const v = document.getElementById('fixedCurrentVal');
  const w = document.getElementById('fixedCurrentWatt');
  if (v) v.textContent = val;
  if (w) w.textContent = `≈ ${Math.round(val * 230 * _evPhases)}W op ${_evPhases} fase${_evPhases > 1 ? 'n' : ''}`;
  _updateProfileSummary(_evProfileMode);
}

function updateBound(type, val) {
  val = parseInt(val);
  const vEl = document.getElementById(`${type}CurrentVal`);
  const wEl = document.getElementById(`${type}CurrentWatt`);
  if (vEl) vEl.textContent = `${val}A`;
  if (wEl) wEl.textContent = `≈ ${Math.round(val * 230 * _evPhases)}W`;
  _updateProfileSummary(_evProfileMode);
}

function _updateProfileSummary(mode) {
  const el = document.getElementById('profileSummary');
  if (!el) return;
  const fixed = parseInt(document.getElementById('fixedCurrentSlider')?.value || 8);
  const maxA  = parseInt(document.getElementById('maxCurrentSlider')?.value   || 16);
  const minA  = parseInt(document.getElementById('minCurrentSlider')?.value   || 6);
  const toW   = a => Math.round(a * 230 * _evPhases);
  const msgs  = {
    solar_only:    `☀️ Laadt tussen ${toW(minA)}W en ${toW(maxA)}W bij zonne-overschot.`,
    solar_and_grid:`☀️🔌 Volgt zon (${toW(minA)}–${toW(maxA)}W). Bij rit-deadline: bijladen van net.`,
    fixed:         `📌 Laadt altijd met ${fixed}A (${toW(fixed)}W) — ook zonder zon.`,
    fast_charge:   `⚡ Laadt zo snel mogelijk met max ${maxA}A (${toW(maxA)}W).`,
    off:           `🚫 EMS laadt de Tesla niet. Handmatig laden is nog mogelijk.`,
  };
  el.textContent = msgs[mode] || '';
}

function getEvProfileSettings() {
  return {
    mode:          _evProfileMode,
    fixedCurrentA: parseInt(document.getElementById('fixedCurrentSlider')?.value || 8),
    maxCurrentA:   parseInt(document.getElementById('maxCurrentSlider')?.value   || 16),
    minCurrentA:   parseInt(document.getElementById('minCurrentSlider')?.value   || 6),
  };
}

// ─── Navigation ─────────────────────────────────────────────

function next() {
  collectStep(currentStep);
  if (currentStep < TOTAL_STEPS) {
    currentStep++;
    showStep(currentStep);
  }
}

function prev() {
  if (currentStep > 1) {
    currentStep--;
    showStep(currentStep);
  }
}

function showStep(n) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`step${n}`).classList.add('active');
  updateProgress(n);
  if (n === 3) {
    loadDeviceList('p1MeterList', 'grid_meter', false);
    loadDeviceList('pvMeterList', 'pv_production', true);
  }
  // step 4 (Solar strings) needs no device loading
  if (n === 5) loadBatteryDevices();
  if (n === 6) {
    loadDeviceList('evChargerList', 'ev_charger', false);
    // Inject charge profile widget inline (fetch doesn't work in Homey settings sandbox)
    if (!document.getElementById('modeCards')) {
      _injectEvProfileWidget();
      const phases = parseInt(document.getElementById('evPhases')?.value || 3);
      initEvProfile(phases, null);
    }
  }
  if (n === 7) { loadDeviceList('thermostatList', 'thermostat', true); loadDeviceList('poolList', 'onoff', false); }
  if (n === 8) loadDeviceList('dumpLoadList', 'dump_load', true);
  if (n === 9) renderSummary();
  window.scrollTo(0, 0);
}

function updateProgress(n) {
  const wrap  = document.getElementById('progressSteps');
  const label = document.getElementById('progressLabel');
  wrap.innerHTML = '';
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const dot = document.createElement('div');
    dot.className = 'step-dot' + (i < n ? ' done' : i === n ? ' active' : '');
    wrap.appendChild(dot);
  }
  const labels = ['', 'Welkom', 'Locatie & Net', 'Meters', 'Zonnepanelen', 'Batterij',
                  'Laadpaal', 'Warmtepomp', 'Prioriteiten', 'Opslaan'];
  label.textContent = `Stap ${n} van ${TOTAL_STEPS} — ${labels[n]}`;
}

// ─── Collect step data ───────────────────────────────────────

function collectStep(n) {
  const g = id => document.getElementById(id);
  switch (n) {
    case 1:
      config.installName = g('installName')?.value || 'Home EMS';
      break;
    case 2:
      config.lat           = parseFloat(g('lat').value);
      config.lon           = parseFloat(g('lon').value);
      config.phases        = parseInt(g('phases').value);
      config.maxAmps       = parseInt(g('maxAmps').value);
      config.contractType  = g('contractType').value;
      config.priceImport   = parseFloat(g('priceImport').value);
      config.priceExport   = parseFloat(g('priceExport').value);
      config.dayAheadProvider = g('dayAheadProvider')?.value;
      config.dayAheadApiKey   = g('dayAheadApiKey')?.value;
      config.zeroExport    = g('zeroExport')?.checked;
      break;
    case 3:
      config.gridMeterId = getSelectedDevices('p1MeterList')[0] || null;
      config.pvMeterIds  = getSelectedDevices('pvMeterList');
      break;
    case 4:
      config.pvStrings = collectPvStrings();
      break;
    case 5:
      config.batteries    = collectBatteryUnits();
      config.batMinSoc    = parseInt(g('batMinSoc').value);
      config.batTargetSoc = parseInt(g('batTargetSoc').value);
      break;
    case 6:
      config.hasEv = g('hasEv')?.checked;
      if (config.hasEv) {
        config.wallConnectorIp = g('wallConnectorIp')?.value?.trim() || null;
        const profile = typeof getEvProfileSettings === 'function' ? getEvProfileSettings() : {};
        config.ev = {
          deviceId:       getSelectedDevices('evChargerList')[0] || null,
          capacityKwh:    parseFloat(g('evCapacity').value),
          defaultSoc:     parseInt(g('evDefaultSoc').value),
          phases:         parseInt(g('evPhases').value),
          maxAmps:        parseInt(g('evMaxAmps').value),
          homeWeekday:    g('evHomeWeekday').value,
          homeWeekend:    g('evHomeWeekend').checked,
          // Charge profile
          chargeMode:     profile.mode           ?? 'solar_only',
          fixedCurrentA:  profile.fixedCurrentA  ?? 8,
          maxCurrentA:    profile.maxCurrentA    ?? parseInt(g('evMaxAmps').value),
          minCurrentA:    profile.minCurrentA    ?? 6,
        };
      }
      break;
    case 7:
      config.thermostats = collectThermostats();
      config.thermostatSettings = {
        offsetStep:             parseFloat(g('tpOffsetStep')?.value || 0.5),
        maxOffset:              parseFloat(g('tpMaxOffset')?.value  || 2.0),
        heatingNightThreshold:  parseInt(g('tpNightThreshold')?.value || 10),
        heatingDayThreshold:    parseInt(g('tpDayThreshold')?.value   || 17),
      };
      config.hasPool = g('hasPool')?.checked;
      if (config.hasPool) {
        config.pool = {
          deviceIds: getSelectedDevices('poolList'),
          minHoursPerDay: parseInt(g('poolMinHours')?.value || 4),
        };
      }
      break;
    case 8:
      config.dumpLoadIds     = getSelectedDevices('dumpLoadList');
      config.surplusThreshold = parseInt(g('surplusThreshold').value);
      break;
  }
}

// ─── Device loading ──────────────────────────────────────────


function loadDeviceList(containerId, role, multiSelect) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Filter devices that can fulfil the role
  const filtered = allDevices.filter(d => {
    if (role === 'pv_production') return d.capabilities.includes('measure_power');
    if (role === 'grid_meter')    return d.capabilities.includes('measure_power');
    if (role === 'ev_charger')    return d.capabilities.includes('onoff') &&
                                         (d.driverUri?.includes('easee') ||
                                          d.driverUri?.includes('zaptec') ||
                                          d.capabilities.includes('ev_target_current'));
    if (role === 'thermostat')    return d.capabilities.includes('target_temperature');
    if (role === 'dump_load')     return d.capabilities.includes('onoff');
    return d.capabilities.includes('onoff');
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:14px">Geen geschikte apparaten gevonden</div>';
    return;
  }

  container.innerHTML = '';
  for (const dev of filtered) {
    const item = document.createElement('div');
    item.className  = 'device-item';
    item.dataset.id = dev.id;
    item.innerHTML  = `
      <div class="check"></div>
      <div>
        <div class="device-name">${dev.name}</div>
        <div class="device-driver">${dev.driverUri?.split(':').pop() || ''}</div>
      </div>`;
    item.addEventListener('click', () => {
      if (!multiSelect) {
        container.querySelectorAll('.device-item').forEach(i => i.classList.remove('selected'));
      }
      item.classList.toggle('selected');
    });
    container.appendChild(item);
  }
}

function getSelectedDevices(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} .device-item.selected`))
    .map(el => el.dataset.id);
}

// ─── PV String management ────────────────────────────────────

let pvStringCount = 0;

function addPvString() {
  pvStringCount++;
  const id  = `pvStr${pvStringCount}`;
  const div = document.createElement('div');
  div.className = 'card';
  div.id        = id;
  div.innerHTML = `
    <button class="remove-btn" onclick="document.getElementById('${id}').remove()">×</button>
    <h2>STRING ${pvStringCount}</h2>
    <div class="row-2">
      <div>
        <label>Piek vermogen (kWp)</label>
        <input type="number" id="${id}_peak" value="3.5" min="0.5" max="50" step="0.1" />
      </div>
      <div>
        <label>Oriëntatie</label>
        <select id="${id}_orientation">
          <option value="E">Oost</option>
          <option value="SE">Zuidoost</option>
          <option value="S" selected>Zuid</option>
          <option value="SW">Zuidwest</option>
          <option value="W">West</option>
        </select>
      </div>
    </div>
    <div class="row-2" style="margin-top:10px">
      <div>
        <label>Dakhelling (°)</label>
        <input type="number" id="${id}_tilt" value="35" min="0" max="90" />
      </div>
      <div>
        <label>Op fase</label>
        <select id="${id}_phase">
          <option value="1">Fase 1</option>
          <option value="2">Fase 2</option>
          <option value="3">Fase 3</option>
          <option value="all">Alle fasen</option>
        </select>
      </div>
    </div>`;
  document.getElementById('pvStrings').appendChild(div);
}

function collectPvStrings() {
  const strings = [];
  for (let i = 1; i <= pvStringCount; i++) {
    const id = `pvStr${i}`;
    if (!document.getElementById(id)) continue;
    strings.push({
      peakKw:      parseFloat(document.getElementById(`${id}_peak`).value),
      orientation: document.getElementById(`${id}_orientation`).value,
      tiltDeg:     parseInt(document.getElementById(`${id}_tilt`).value),
      phase:       document.getElementById(`${id}_phase`).value,
    });
  }
  return strings;
}

// ─── Battery unit management ─────────────────────────────────

let batUnitCount = 0;

function loadBatteryDevices() {
  loadDeviceList('p1MeterList', 'grid_meter', false);
}

function addBatteryUnit() {
  batUnitCount++;
  const id  = `batUnit${batUnitCount}`;
  const div = document.createElement('div');
  div.className = 'card';
  div.id        = id;

  // Filter battery-capable devices — include anything with a battery SoC or measure_power
  // that looks like a battery (broad filter to handle different Homey app capability names)
  const batDevices = allDevices.filter(d =>
    d.capabilities.includes('measure_battery') ||
    d.capabilities.includes('measure_power') && (
      d.driverUri?.toLowerCase().includes('marstek') ||
      d.driverUri?.toLowerCase().includes('batt') ||
      d.driverUri?.toLowerCase().includes('energy_storage')
    )
  );
  const options    = batDevices.map(d => `<option value="${d.id}">${d.name}</option>`).join('');

  div.innerHTML = `
    <button class="remove-btn" onclick="document.getElementById('${id}').remove()">×</button>
    <h2>BATTERIJ UNIT ${batUnitCount}</h2>
    <label>Apparaat</label>
    <select id="${id}_device">${options || '<option value="">Geen batterij gevonden</option>'}</select>
    <div class="row-2" style="margin-top:10px">
      <div>
        <label>Capaciteit (kWh)</label>
        <input type="number" id="${id}_cap" value="5" min="1" max="100" step="0.1" />
      </div>
      <div>
        <label>Op fase</label>
        <select id="${id}_phase">
          <option value="1">Fase 1</option>
          <option value="2">Fase 2</option>
          <option value="3">Fase 3</option>
          <option value="all">Alle fasen</option>
        </select>
      </div>
    </div>
    <div class="row-2" style="margin-top:10px">
      <div>
        <label>Max laadvermogen (W)</label>
        <input type="number" id="${id}_chargeW" value="2500" min="500" max="20000" step="100" />
      </div>
      <div>
        <label>Max ontlaadvermogen (W)</label>
        <input type="number" id="${id}_dischargeW" value="2500" min="500" max="20000" step="100" />
      </div>
    </div>`;
  document.getElementById('batteryUnits').appendChild(div);
}

function collectBatteryUnits() {
  const units = [];
  for (let i = 1; i <= batUnitCount; i++) {
    const id = `batUnit${i}`;
    if (!document.getElementById(id)) continue;
    const deviceId = document.getElementById(`${id}_device`).value;
    if (!deviceId) continue; // skip units without a selected device
    units.push({
      id:            deviceId,
      phase:         document.getElementById(`${id}_phase`).value,
      capacityKwh:   parseFloat(document.getElementById(`${id}_cap`).value),
      maxChargeW:    parseInt(document.getElementById(`${id}_chargeW`).value),
      maxDischargeW: parseInt(document.getElementById(`${id}_dischargeW`).value),
    });
  }
  return units;
}

// ─── Thermostat collection ───────────────────────────────────

function collectThermostats() {
  return getSelectedDevices('thermostatList').map(id => {
    const dev      = allDevices.find(d => d.id === id);
    const baseTemp = parseFloat(
      document.getElementById(`baseTemp_${id}`)?.value || 20
    );
    return { id, name: dev?.name || id, room: dev?.name || id, baseTemp };
  });
}

// ─── Toggle helpers ──────────────────────────────────────────

function toggleDynamic() {
  const isDynamic = document.getElementById('contractType').value === 'dynamic';
  document.getElementById('fixedFields').style.display   = isDynamic ? 'none' : 'block';
  document.getElementById('dynamicFields').style.display = isDynamic ? 'block' : 'none';
}

function toggleEv() {
  document.getElementById('evFields').style.display =
    document.getElementById('hasEv').checked ? 'block' : 'none';
}

function togglePool() {
  document.getElementById('poolFields').style.display =
    document.getElementById('hasPool').checked ? 'block' : 'none';
}

function getLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    document.getElementById('lat').value = pos.coords.latitude.toFixed(4);
    document.getElementById('lon').value = pos.coords.longitude.toFixed(4);
  });
}

// ─── Summary ─────────────────────────────────────────────────

function renderSummary() {
  collectStep(8); // collect last step before rendering
  const c   = config;
  const div = document.getElementById('configSummary');
  div.innerHTML = `
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 0;color:var(--muted);width:50%">Installatie</td><td>${c.installName}</td></tr>
      <tr><td style="padding:6px 0;color:var(--muted)">Locatie</td><td>${c.lat}, ${c.lon}</td></tr>
      <tr><td style="padding:6px 0;color:var(--muted)">Fasen</td><td>${c.phases}-fase, max ${c.maxAmps}A</td></tr>
      <tr><td style="padding:6px 0;color:var(--muted)">Contract</td><td>${c.contractType}</td></tr>
      <tr><td style="padding:6px 0;color:var(--muted)">PV strings</td><td>${c.pvStrings.length} string(s), ${c.pvStrings.reduce((s,p)=>s+p.peakKw,0).toFixed(1)} kWp totaal</td></tr>
      <tr><td style="padding:6px 0;color:var(--muted)">PV meters</td><td>${c.pvMeterIds.length} meter(s)</td></tr>
      <tr><td style="padding:6px 0;color:var(--muted)">Netmeter (P1)</td><td>${c.gridMeterId ? '✅ Gekoppeld' : '⚠️ Niet ingesteld'}</td></tr>
      <tr><td style="padding:6px 0;color:var(--muted)">Batterij units</td><td>${c.batteries.length} unit(s), ${c.batteries.reduce((s,b)=>s+b.capacityKwh,0).toFixed(1)} kWh totaal</td></tr>
      <tr><td style="padding:6px 0;color:var(--muted)">EV laadpaal</td><td>${c.hasEv ? `✅ ${c.ev?.capacityKwh} kWh` : 'Nee'}</td></tr>
      <tr><td style="padding:6px 0;color:var(--muted)">Thermostaten</td><td>${c.thermostats.length} ruimte(s)</td></tr>
      <tr><td style="padding:6px 0;color:var(--muted)">Zwembad</td><td>${c.hasPool ? '✅ Ja' : 'Nee'}</td></tr>
      <tr><td style="padding:6px 0;color:var(--muted)">Dumplast</td><td>${c.dumpLoadIds.length} apparaat/apparaten</td></tr>
    </table>`;
}

// ─── Save ─────────────────────────────────────────────────────


// ─── Init ─────────────────────────────────────────────────────

let _Homey = null;

async function initWizard(Homey) {
  _Homey = Homey;
  await fetchDevices();
  updateProgress(1);
  addPvString();
  addBatteryUnit();
}

async function fetchDevices() {
  try {
    allDevices = await _Homey.api('GET', '/getDevices', {});
  } catch (e) {
    console.error('Could not load devices', e);
    allDevices = [];
  }
}

async function saveConfig() {
  config.setupComplete = true;
  const statusEl = document.getElementById('saveStatus');
  statusEl.className  = 'status-msg show';
  statusEl.textContent = '⏳ Opslaan...';
  try {
    await _Homey.api('POST', '/saveConfig', { config });
    statusEl.className  = 'status-msg show success';
    statusEl.textContent = '✅ Configuratie opgeslagen! EMS start nu op.';
  } catch (e) {
    statusEl.className  = 'status-msg show error';
    statusEl.textContent = '❌ Fout bij opslaan: ' + e.message;
  }
}

async function testWallConnector() {
  const ip     = document.getElementById('wallConnectorIp')?.value?.trim();
  const result = document.getElementById('wcTestResult');
  if (!ip) { result.textContent = '⚠️ Vul eerst een IP-adres in'; return; }
  result.textContent = '⏳ Verbinding testen...';
  result.style.color = '#5f6368';
  try {
    const data = await _Homey.api('POST', '/testWallConnector', { ip });
    if (data.ok) {
      result.style.color = '#1e7e34';
      result.textContent = `✅ Verbonden! ${data.connected ? 'Auto aangesloten' : 'Geen auto'} · ${data.evseState}`;
    } else {
      throw new Error(data.error || 'Onbekende fout');
    }
  } catch (e) {
    result.style.color = '#c5221f';
    result.textContent = `❌ Kan Wall Connector niet bereiken: ${e.message}`;
  }
}
