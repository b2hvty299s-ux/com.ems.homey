'use strict';

/**
 * DumpLoadAdapter
 * ───────────────
 * Controls priority 3 (dump load) devices — appliances that should
 * only run when there is surplus energy after prio 1 and 2 are satisfied.
 *
 * Examples: hot water boiler, immersion heater, extra pool heating.
 *
 * Each device needs only onoff. Optionally dim for power control.
 *
 * The PriorityManager calls activate()/deactivate() based on surplus.
 * The adapter tracks state to avoid unnecessary commands.
 */
class DumpLoadAdapter {

  constructor(app) {
    this.app        = app;
    this.homey      = app.homey;
    this._devices   = [];   // [{ id, name, maxW }]
    this._active    = false;
    this._firedOn   = false;
    this._firedOff  = false;
  }

  init(config) {
    this._devices = (config.dumpLoadIds || []).map(id => {
      const dev = { id, name: id, maxW: 2000 };
      return dev;
    });
    this.app.log(`[DumpLoad] ${this._devices.length} device(s) configured`);
  }

  // ─── Control ──────────────────────────────────────────────────────────────

  async activate() {
    if (this._active) return;
    this._active   = true;
    this._firedOff = false;

    this.app.log('[DumpLoad] Activating dump loads');
    for (const dev of this._devices) {
      await this._setDevice(dev.id, true);
    }

    if (!this._firedOn) {
      this._firedOn = true;
      this.homey.emit('ems:dumpLoadActivated');
    }
  }

  async deactivate() {
    if (!this._active) return;
    this._active  = false;
    this._firedOn = false;

    this.app.log('[DumpLoad] Deactivating dump loads');
    for (const dev of this._devices) {
      await this._setDevice(dev.id, false);
    }

    if (!this._firedOff) {
      this._firedOff = true;
      this.homey.emit('ems:dumpLoadDeactivated');
    }
  }

  /** Manual override from Flow action */
  async setOverride(enabled) {
    if (enabled) {
      await this.activate();
    } else {
      await this.deactivate();
    }
  }

  isActive() { return this._active; }

  // ─── Estimated power draw ─────────────────────────────────────────────────

  async getCurrentPowerW() {
    if (!this._active || this._devices.length === 0) return 0;
    let total = 0;
    for (const dev of this._devices) {
      try {
        const device = await this.app.getDevice(dev.id);
        const power  = device.capabilitiesObj?.measure_power?.value ?? dev.maxW;
        total += Math.max(0, power);
      } catch (_) {
        total += dev.maxW; // assume full load if unreadable
      }
    }
    return total;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  async _setDevice(id, on) {
    try {
      const device = await this.app.getDevice(id);
      if (device.capabilities.includes('onoff')) {
        await device.setCapabilityValue('onoff', on);
      }
      this.app.log(`[DumpLoad] ${device.name} → ${on ? 'ON' : 'OFF'}`);
    } catch (err) {
      this.app.error(`[DumpLoad] Error setting ${id}:`, err.message);
    }
  }

}

module.exports = DumpLoadAdapter;
