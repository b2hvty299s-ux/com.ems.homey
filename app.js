'use strict';

const Homey                        = require('homey');
const { HomeyAPIV3Local }          = require('homey-api');
const EmsManager                   = require('./managers/EmsManager');
const FlowManager                  = require('./managers/FlowManager');
const NotificationManager          = require('./managers/NotificationManager');

class EmsApp extends Homey.App {

  // ─── EMS Controller device registry ──────────────────────────────────────
  // device.js calls setEmsControllerDevice(this) on onInit so EmsManager can
  // push state updates without going through homey.drivers.getDriver().

  setEmsControllerDevice(device) {
    this._emsDevice = device;
  }

  getEmsControllerDevice() {
    return this._emsDevice || null;
  }

  // ─── Device access via HomeyAPIV3Local ────────────────────────────────────
  // In Homey SDK3, this.homey.devices is NOT available in App/Driver context.
  // Use HomeyAPIV3Local.createAppAPI() to get a live device with capability values.

  async getDevice(id) {
    if (!this._homeyApi) {
      this._homeyApi = await HomeyAPIV3Local.createAppAPI({ homey: this.homey });
    }
    return this._homeyApi.devices.getDevice({ id });
  }

  // Called by api.js — runs in App context so this.homey has full device access.
  // Uses getDevicesByCapability() which returns cross-app devices (unlike getDevices()
  // which is scoped to this app only in SDK3).
  async getDeviceList() {
    // In Homey SDK3, this.homey.devices is NOT accessible from App/Driver context
    // outside of pair/repair sessions. HomeyAPIV3Local.createAppAPI is the correct
    // SDK3 way to enumerate all installed devices across all apps.
    try {
      const api     = await HomeyAPIV3Local.createAppAPI({ homey: this.homey });
      const devMap  = await api.devices.getDevices();
      const list    = Object.values(devMap || {})
        .map(d => ({
          id:           d.id,
          name:         d.name         || '?',
          driverUri:    d.driverUri    || '',
          capabilities: Array.isArray(d.capabilities)
            ? d.capabilities
            : Object.keys(d.capabilities || {}),
        }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      this.log('[EMS] getDeviceList: returning', list.length, 'devices');
      return list;
    } catch (err) {
      this.error('[EMS] getDeviceList error:', err.message);
      return [];
    }
  }

  async onInit() {
    this.log('═══════════════════════════════════');
    this.log('  Home EMS starting up...');
    this.log('═══════════════════════════════════');

    // Core managers
    this.notifications = new NotificationManager(this);
    this.ems           = new EmsManager(this);
    this.flows         = new FlowManager(this);

    await this.ems.init();
    await this.flows.init();

    this.log('  Home EMS ready.');
    this.log('═══════════════════════════════════');
  }

  async onUninit() {
    if (this.ems) await this.ems.destroy();
    this.log('Home EMS stopped.');
  }

  // ─── Settings API (called from settings pages via Homey.api()) ────────────

  async onApi(method, args) {
    switch (method) {

      // Setup wizard — get all Homey devices for selection
      case 'getDevices': {
        return await this.getDeviceList();
      }

      // Setup wizard — probe a device and return capability profile
      case 'probeDevice': {
        const { id } = args;
        return this.ems.deviceProfiler.probe(id);
      }

      // Setup wizard — save full configuration
      case 'saveConfig': {
        await this.ems.applyConfig(args.config);
        return { ok: true };
      }

      // Dashboard — get current EMS state
      case 'getState': {
        return this.ems.getPublicState();
      }

      // Dashboard — get today's plan
      case 'getPlan': {
        return this.ems.planningEngine
          ? this.ems.planningEngine.getCurrentPlan()
          : null;
      }

      // Trip planning
      case 'planTrip': {
        const { departureTime, targetSoc } = args;
        await this.ems.tripPlanner.setTrip(departureTime, targetSoc);
        await this.ems.planningEngine.recalculate('trip_update');
        return { ok: true };
      }

      // Test Wall Connector connection
      case 'testWallConnector': {
        const { ip } = args;
        try {
          const res  = await fetch(`http://${ip}/api/1/vitals`, {
            signal: AbortSignal.timeout(4000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const EVSE = { 1:'opstarten', 2:'geen EV', 4:'verbonden, idle', 6:'aan het laden', 7:'laden (gereduceerd)', 8:'fout', 9:'laden klaar', 11:'verbinden' };
          return { ok: true, connected: data.vehicle_connected, evseState: EVSE[data.evse_state] ?? `state ${data.evse_state}` };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }

      // Force recalculate
      case 'recalculate': {
        await this.ems.planningEngine.recalculate('manual');
        return { ok: true };
      }

      default:
        throw new Error(`Unknown API method: ${method}`);
    }
  }

}

module.exports = EmsApp;
