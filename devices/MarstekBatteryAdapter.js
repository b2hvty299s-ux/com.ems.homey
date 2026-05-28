'use strict';

/**
 * MarstekBattery adapter
 * ──────────────────────
 * Controls Marstek home battery systems via the Marstek Homey app.
 *
 * Marstek systems (B2500, etc.) connect via WiFi/Bluetooth.
 * The Homey app typically exposes:
 *   measure_battery              — SoC in %
 *   measure_power                — current power W (+ charge, - discharge)
 *   onoff                        — enable/disable system
 *   marstek_charge_power         — set charge power (W) if supported
 *   marstek_discharge_power      — set discharge power (W) if supported
 *
 * Configuration supports:
 *   - Single 3-phase battery
 *   - Multiple batteries (one per phase)
 *   - Mixed configurations
 *
 * Each battery entry in config:
 *   { id, phase (1|2|3|'all'), capacityKwh, maxChargeW, maxDischargeW }
 */
class MarstekBatteryAdapter {

  constructor(app) {
    this.app      = app;
    this.homey    = app.homey;
    this.batteries = []; // array of battery config objects
    this._socThresholdFired = {}; // track threshold events
  }

  init(batteryConfigs) {
    this.batteries = batteryConfigs || [];
    this.app.log(`[Marstek] Initialised with ${this.batteries.length} battery unit(s)`);
    this.batteries.forEach(b =>
      this.app.log(`  → ${b.id} | phase ${b.phase} | ${b.capacityKwh} kWh | max charge ${b.maxChargeW}W`));
  }

  // ─── Readings ─────────────────────────────────────────────────────────────

  /**
   * Returns aggregated battery state across all units.
   */
  async getState() {
    if (this.batteries.length === 0) {
      return { soc: 50, powerW: 0, totalCapacityKwh: 0, availableKwh: 0, units: [] };
    }

    const units   = [];
    let totalCap  = 0;
    let socSum    = 0;
    let totalPow  = 0;

    for (const bat of this.batteries) {
      try {
        const device = await this.app.getDevice(bat.id);
        const caps   = device.capabilitiesObj;

        const soc   = caps?.measure_battery?.value ?? 50;
        const power = caps?.measure_power?.value   ?? 0;

        units.push({ id: bat.id, phase: bat.phase, soc, powerW: power, capacityKwh: bat.capacityKwh });
        totalCap += bat.capacityKwh;
        socSum   += soc;
        totalPow += power;
      } catch (err) {
        this.app.error(`[Marstek] getState error for ${bat.id}:`, err.message);
        units.push({ id: bat.id, phase: bat.phase, soc: 50, powerW: 0, capacityKwh: bat.capacityKwh });
        totalCap += bat.capacityKwh;
        socSum   += 50;
      }
    }

    const avgSoc       = socSum / this.batteries.length;
    const availableKwh = totalCap * (avgSoc / 100);

    // Check SoC thresholds for Flow triggers
    this._checkSocThresholds(avgSoc);

    return { soc: avgSoc, powerW: totalPow, totalCapacityKwh: totalCap, availableKwh, units };
  }

  /**
   * Returns total max charge power available across all units (W).
   */
  getTotalMaxChargeW() {
    return this.batteries.reduce((sum, b) => sum + (b.maxChargeW || 2500), 0);
  }

  /**
   * Returns total max discharge power available across all units (W).
   */
  getTotalMaxDischargeW() {
    return this.batteries.reduce((sum, b) => sum + (b.maxDischargeW || 2500), 0);
  }

  // ─── Control ──────────────────────────────────────────────────────────────

  /**
   * Set charging state across all batteries.
   * @param {boolean} enabled
   * @param {number}  targetW  — total desired charge power (distributed evenly)
   */
  async setCharging(enabled, targetW = null) {
    this.app.log(`[Marstek] setCharging(${enabled}, ${targetW}W)`);

    const perUnitW = targetW && this.batteries.length > 0
      ? Math.round(targetW / this.batteries.length)
      : null;

    for (const bat of this.batteries) {
      await this._setUnitCharging(bat, enabled, perUnitW);
    }
  }

  /**
   * Set discharging state across all batteries.
   * @param {boolean} enabled
   * @param {number}  targetW  — total desired discharge power
   */
  async setDischarging(enabled, targetW = null) {
    this.app.log(`[Marstek] setDischarging(${enabled}, ${targetW}W)`);

    const perUnitW = targetW && this.batteries.length > 0
      ? Math.round(targetW / this.batteries.length)
      : null;

    for (const bat of this.batteries) {
      await this._setUnitDischarging(bat, enabled, perUnitW);
    }
  }

  // ─── Per-unit control ─────────────────────────────────────────────────────

  async _setUnitCharging(bat, enabled, targetW) {
    try {
      const device = await this.homey.devices.getDevice({ id: bat.id });
      const caps   = device.capabilities;

      // Try Marstek-specific capability first
      if (caps.includes('marstek_charge_enabled')) {
        await device.setCapabilityValue('marstek_charge_enabled', enabled);
      } else if (caps.includes('onoff')) {
        await device.setCapabilityValue('onoff', enabled);
      }

      // Set charge power if supported and enabled
      if (enabled && targetW && caps.includes('marstek_charge_power')) {
        const clamped = Math.min(targetW, bat.maxChargeW || 2500);
        await device.setCapabilityValue('marstek_charge_power', clamped);
      }
    } catch (err) {
      this.app.error(`[Marstek] _setUnitCharging error for ${bat.id}:`, err.message);
      // Emit fallback event so a Homey Flow can take over
      this.homey.emit('ems:batteryFallback', { id: bat.id, action: 'charge', enabled, targetW });
    }
  }

  async _setUnitDischarging(bat, enabled, targetW) {
    try {
      const device = await this.homey.devices.getDevice({ id: bat.id });
      const caps   = device.capabilities;

      if (caps.includes('marstek_discharge_enabled')) {
        await device.setCapabilityValue('marstek_discharge_enabled', enabled);
      }

      if (enabled && targetW && caps.includes('marstek_discharge_power')) {
        const clamped = Math.min(targetW, bat.maxDischargeW || 2500);
        await device.setCapabilityValue('marstek_discharge_power', clamped);
      }
    } catch (err) {
      this.app.error(`[Marstek] _setUnitDischarging error for ${bat.id}:`, err.message);
      this.homey.emit('ems:batteryFallback', { id: bat.id, action: 'discharge', enabled, targetW });
    }
  }

  // ─── SoC threshold detection → Flow triggers ──────────────────────────────

  _checkSocThresholds(soc) {
    const minSoc = this.homey.settings.get('battery_min_soc') ?? 20;

    // Below minimum — fire once, reset when back above
    if (soc < minSoc && !this._socThresholdFired.min) {
      this._socThresholdFired.min = true;
      this.homey.emit('ems:batteryBelowMinimum', { soc });
    } else if (soc >= minSoc + 5) {
      this._socThresholdFired.min = false; // reset with hysteresis
    }
  }

}

module.exports = MarstekBatteryAdapter;
