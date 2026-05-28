'use strict';

/**
 * ThermostatAdapter
 * ─────────────────
 * Controls room thermostats connected to heat pump / airco units.
 *
 * Key behaviours:
 *  - Respects manual OFF: if user turned a thermostat off, never touch it
 *  - Tracks whether EMS or user made the last change
 *  - Applies temperature offset based on solar surplus
 *  - Handles heating vs cooling mode with correct offset direction:
 *      Heating + surplus → setpoint UP   (store more heat)
 *      Cooling + surplus → setpoint DOWN (store more cold)
 *  - Seasonal mode switch based on night/day temperature forecast
 *    (calculated once per day at 05:00, not real-time)
 *
 * Config per thermostat:
 *  { id, name, room, baseTemp, offsetStep, maxOffset, capabilities: [...] }
 */
class ThermostatAdapter {

  constructor(app) {
    this.app        = app;
    this.homey      = app.homey;
    this.thermostats = [];
    this._mode       = 'heating'; // 'heating' | 'cooling' — same for all units (outdoor temp based)
    this._userOffMap = {};        // id → true if user manually turned off
    this._lastSetBy  = {};        // id → 'ems' | 'user'
    this._activeOffset = 0;       // current applied offset (+ or -)
  }

  init(config) {
    this.thermostats    = config.thermostats  || [];
    this._heatingNightThreshold = config.heatingNightThreshold ?? 10; // °C
    this._heatingDayThreshold   = config.heatingDayThreshold   ?? 17; // °C
    this._offsetStep    = config.offsetStep   ?? 0.5;  // °C per surplus level
    this._maxOffset     = config.maxOffset    ?? 2.0;  // °C max total offset

    this.app.log(`[Thermostat] ${this.thermostats.length} thermostat(s) configured`);

    // Listen for capability changes to detect user overrides
    this._watchUserChanges();
  }

  // ─── Mode switching (called once per day by PlanningEngine) ───────────────

  /**
   * Determine heating/cooling mode based on forecast temperatures.
   * @param {number} forecastNightMin  — lowest temp tonight (°C)
   * @param {number} forecastDayMax    — highest temp tomorrow (°C)
   * @returns {string} 'heating' | 'cooling'
   */
  evaluateMode(forecastNightMin, forecastDayMax) {
    const shouldCool = forecastNightMin > this._heatingNightThreshold
                    && forecastDayMax   > this._heatingDayThreshold;

    const newMode = shouldCool ? 'cooling' : 'heating';

    if (newMode !== this._mode) {
      this.app.log(`[Thermostat] Mode switch: ${this._mode} → ${newMode} (night: ${forecastNightMin}°C, day: ${forecastDayMax}°C)`);
      this._mode = newMode;
      this.homey.emit('ems:heatpumpModeChanged', newMode);
    }

    return newMode;
  }

  getMode() { return this._mode; }

  // ─── Offset control (called by EmsManager each tick) ──────────────────────

  /**
   * Apply temperature offset based on current energy state.
   * @param {'surplus' | 'normal' | 'deficit'} energyState
   */
  async applyOffset(energyState) {
    if (this.thermostats.length === 0) return;

    // Check for user overrides via polling (replaces device.on() events)
    await this._checkUserOverrides();

    let targetOffset = 0;
    if (energyState === 'surplus') {
      targetOffset = this._offsetStep;
    } else if (energyState === 'deficit') {
      targetOffset = -this._offsetStep;
    }

    // Clamp to max offset
    targetOffset = Math.max(-this._maxOffset, Math.min(this._maxOffset, targetOffset));

    // No change needed
    if (targetOffset === this._activeOffset) return;

    this._activeOffset = targetOffset;

    for (const t of this.thermostats) {
      await this._applyToThermostat(t, targetOffset);
    }
  }

  /**
   * Restore all thermostats to their base temperatures.
   * Called when EMS goes to idle or is disabled.
   */
  async restoreAll() {
    this._activeOffset = 0;
    for (const t of this.thermostats) {
      if (this._userOffMap[t.id]) continue;
      await this._setTemp(t, t.baseTemp, 'ems_restore');
    }
  }

  // ─── Per-thermostat logic ─────────────────────────────────────────────────

  async _applyToThermostat(t, offset) {
    // Never touch a thermostat the user turned off
    if (this._userOffMap[t.id]) {
      this.app.log(`[Thermostat] Skipping ${t.name ?? t.id} — user turned off`);
      return;
    }

    // Guard: baseTemp must be a valid number — skip rather than send NaN
    if (typeof t.baseTemp !== 'number' || isNaN(t.baseTemp)) {
      this.app.log(`[Thermostat] ${t.name ?? t.id}: no baseTemp yet — skipping tick`);
      return;
    }

    // Direction depends on heating vs cooling mode
    // Heating + surplus: raise setpoint (use more heat = store thermal energy)
    // Cooling + surplus: lower setpoint (use more cooling = store cold)
    const directedOffset = this._mode === 'cooling' ? -offset : offset;
    const newTemp        = +(t.baseTemp + directedOffset).toFixed(1);

    await this._setTemp(t, newTemp, 'ems');
  }

  async _setTemp(t, temp, setBy = 'ems') {
    try {
      const device = await this.app.getDevice(t.id);
      this._lastSetBy[t.id] = setBy;
      await device.setCapabilityValue('target_temperature', temp);
      this.app.log(`[Thermostat] ${t.name}: setpoint → ${temp}°C (${setBy}, mode: ${this._mode})`);
    } catch (err) {
      this.app.error(`[Thermostat] setTemp error for ${t.name}:`, err.message);
    }
  }

  // ─── User override detection ──────────────────────────────────────────────

  /**
   * Poll thermostat state each tick to detect user overrides.
   * Called from applyOffset() so we stay in sync without event subscriptions
   * (homey-api REST devices don't support device.on() event listeners).
   */
  async _checkUserOverrides() {
    for (const t of this.thermostats) {
      try {
        const device = await this.app.getDevice(t.id);
        const caps   = device.capabilitiesObj;

        // If onoff capability is present and off → user turned it off
        const isOff = caps?.onoff?.value === false;
        if (isOff && !this._userOffMap[t.id] && this._lastSetBy[t.id] !== 'ems') {
          this._userOffMap[t.id] = true;
          this.app.log(`[Thermostat] ${t.name} is off — EMS will not touch it`);
        } else if (!isOff && this._userOffMap[t.id]) {
          this._userOffMap[t.id] = false;
          this.app.log(`[Thermostat] ${t.name} turned back on — EMS resuming control`);
        }

        // Sync baseTemp from device on first tick or after user adjustment
        if (this._lastSetBy[t.id] !== 'ems' && caps?.target_temperature?.value != null) {
          const currentTemp = caps.target_temperature.value;
          // First-time init (baseTemp not yet set or is the fallback default)
          if (typeof t.baseTemp !== 'number' || isNaN(t.baseTemp)) {
            t.baseTemp = currentTemp;
            this.app.log(`[Thermostat] ${t.name ?? t.id}: baseTemp initialised from device → ${currentTemp}°C`);
          } else if (Math.abs(currentTemp - t.baseTemp) > 0.4) {
            this.app.log(`[Thermostat] ${t.name ?? t.id}: base temp updated by user to ${currentTemp}°C`);
            t.baseTemp = currentTemp;
            this._persistBaseTemp(t.id, currentTemp);
          }
        }

        this._lastSetBy[t.id] = null;
      } catch (err) {
        // Non-fatal — just skip this thermostat this tick
      }
    }
  }

  _watchUserChanges() {
    // No-op: user override detection is handled via polling in _checkUserOverrides(),
    // called from applyOffset(). homey-api REST devices don't support device.on().
  }

  _persistBaseTemp(id, temp) {
    const key   = `thermostat_base_${id}`;
    this.homey.settings.set(key, temp);
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  getStatus() {
    return {
      mode:          this._mode,
      activeOffset:  this._activeOffset,
      thermostats:   this.thermostats.map(t => ({
        id:        t.id,
        name:      t.name,
        room:      t.room,
        baseTemp:  t.baseTemp,
        userOff:   this._userOffMap[t.id] || false,
      })),
    };
  }

}

module.exports = ThermostatAdapter;
