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
