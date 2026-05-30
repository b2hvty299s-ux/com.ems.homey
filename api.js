'use strict';

/**
 * Root API for settings pages.
 * Homey SDK3: settings pages communicate via GET/POST to these endpoints.
 * Called as: Homey.api('GET', '/getState', {}) etc.
 */
module.exports = {

  async getDevices({ homey }) {
    // Route through homey.app so getDevices() runs in the App's context,
    // which has full homey.devices access (api.js handlers are more restricted).
    try {
      return await homey.app.getDeviceList();
    } catch (err) {
      homey.app.error('[EMS] getDevices API error:', err.message);
      return [];
    }
  },

  async getActuals({ homey }) {
    const now  = new Date();
    // Use local date to match _recordActuals
    const year = now.getFullYear();
    const mon  = String(now.getMonth() + 1).padStart(2, '0');
    const day  = String(now.getDate()).padStart(2, '0');
    const date = `${year}${mon}${day}`;

    // 144 slots: 24 hours × 6 ten-minute slots
    const result = [];
    for (let h = 0; h < 24; h++) {
      for (let s = 0; s < 6; s++) {
        const d = homey.settings.get(`actuals_${date}_${h}_${s}`);
        if (!d || d.n === 0) {
          result.push(null);
        } else {
          result.push({ pvW: d.pvW, gridW: d.gridW, batW: d.batW, evW: d.evW });
        }
      }
    }
    return result; // 144 elements
  },

  async getState({ homey }) {
    return homey.app.ems.getPublicState();
  },

  async getPlan({ homey }) {
    return homey.app.ems.planningEngine
      ? homey.app.ems.planningEngine.getCurrentPlan()
      : null;
  },

  async saveConfig({ homey, body }) {
    await homey.app.ems.applyConfig(body.config);
    return { ok: true };
  },

  async planTrip({ homey, body }) {
    const { departureTime, targetSoc } = body;
    await homey.app.ems.tripPlanner.setTrip(departureTime, targetSoc);
    await homey.app.ems.planningEngine.recalculate('trip_update');
    return { ok: true };
  },

  async recalculate({ homey }) {
    await homey.app.ems.planningEngine.recalculate('manual');
    return { ok: true };
  },

  async reloadConfig({ homey }) {
    try {
      const device = homey.app.getEmsControllerDevice();
      if (device) await device._startEms();
      else homey.app.log('[EMS] reloadConfig: no device found yet');
      return { ok: true };
    } catch (err) {
      homey.app.error('[EMS] reloadConfig error:', err.message);
      return { ok: false, error: err.message };
    }
  },

  async testWeather({ homey }) {
    // Direct fetch — bypasses cache AND fallback so we see the real error/response
    const lat = homey.app.ems?.openMeteo?.lat ?? homey.geolocation.getLatitude()  ?? 52.3;
    const lon = homey.app.ems?.openMeteo?.lon ?? homey.geolocation.getLongitude() ?? 4.9;

    const params = new URLSearchParams({
      latitude:  lat,
      longitude: lon,
      hourly:    'shortwave_radiation,temperature_2m,cloud_cover',
      daily:     'temperature_2m_max,shortwave_radiation_sum',
      forecast_days: 3,
      timezone:  'Europe/Amsterdam',
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params}`;

    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      if (!res.ok) return { ok: false, status: res.status, body: text.slice(0, 300) };

      const data  = JSON.parse(text);
      const times = data.hourly?.time ?? [];

      // Summarize per day
      const summarize = (dateStr) => {
        const hours = times
          .map((t, i) => ({ t, rad: data.hourly.shortwave_radiation[i] }))
          .filter(x => x.t.startsWith(dateStr) && x.rad > 0)
          .map(x => `${x.t.slice(11,16)}: ${x.rad.toFixed(0)} W/m²`);
        const allRad = times
          .map((t, i) => t.startsWith(dateStr) ? (data.hourly.shortwave_radiation[i] ?? 0) : 0);
        return {
          totalRadKwh: +(allRad.reduce((s, v) => s + v, 0) / 1000).toFixed(2),
          solarHours:  hours,
        };
      };

      const today    = new Date().toISOString().slice(0, 10);
      const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10); })();

      return {
        ok:       true,
        location: { lat, lon },
        url:      url.slice(0, 120) + '...',
        daily:    data.daily,
        today:    summarize(today),
        tomorrow: summarize(tomorrow),
      };
    } catch (e) {
      return { ok: false, error: e.message, url };
    }
  },

  async testWallConnector({ homey, body }) {
    const { ip } = body;
    try {
      const res = await fetch(`http://${ip}/api/1/vitals`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const EVSE = {
        1: 'opstarten', 2: 'geen EV', 4: 'verbonden, idle',
        6: 'aan het laden', 7: 'laden (gereduceerd)', 8: 'fout',
        9: 'laden klaar', 11: 'verbinden',
      };
      return { ok: true, connected: data.vehicle_connected, evseState: EVSE[data.evse_state] ?? `state ${data.evse_state}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

};
