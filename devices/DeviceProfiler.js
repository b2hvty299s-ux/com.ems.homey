'use strict';

/**
 * DeviceProfiler
 * ──────────────
 * Given a Homey device ID, inspects its capabilities and returns
 * a structured profile describing exactly what the EMS can do with it.
 *
 * This is called during setup wizard when the user selects a device.
 * The profile is stored in config and used by all device adapters.
 */

// Known driver URIs for specific adapters
const DRIVER_MAP = {
  'homey:app:com.marstek':           'marstek_battery',
  'homey:app:com.growatt':           'growatt_inverter',
  'homey:app:nl.homewizard.energy':  'homewizard',
  'homey:app:com.easee':             'easee_ev',
  'homey:app:com.zaptec':            'zaptec_ev',
  'homey:app:com.tesla':             'tesla_ev',
  'homey:app:com.tado':              'tado_thermostat',
  'homey:app:com.nest':              'nest_thermostat',
  'homey:app:com.honeywell':         'honeywell_thermostat',
};

// Capability sets we look for per role
const CAPABILITY_SETS = {
  pv_production: {
    required:  ['measure_power'],
    optional:  ['meter_power', 'meter_power.produced', 'measure_voltage'],
  },
  battery: {
    required:  ['measure_battery'],
    optional:  ['measure_power', 'onoff', 'battery_charging_enabled',
                'battery_discharging_enabled', 'dim'],
  },
  ev_charger: {
    required:  ['onoff'],
    optional:  ['measure_power', 'ev_target_current', 'meter_power',
                'measure_current', 'ev_status'],
  },
  thermostat: {
    required:  ['target_temperature'],
    optional:  ['measure_temperature', 'onoff', 'thermostat_mode',
                'measure_humidity'],
  },
  grid_meter: {
    required:  ['measure_power'],
    optional:  ['measure_power.import', 'measure_power.export',
                'meter_power', 'measure_voltage', 'measure_current'],
  },
  dump_load: {
    required:  ['onoff'],
    optional:  ['measure_power', 'meter_power', 'dim'],
  },
  pool_pump: {
    required:  ['onoff'],
    optional:  ['measure_power', 'timer'],
  },
};

class DeviceProfiler {

  constructor(app) {
    this.app   = app;
    this.homey = app.homey;
  }

  /**
   * Probe a device and return its full capability profile.
   * @param {string} deviceId
   * @returns {object} profile
   */
  async probe(deviceId) {
    const device = await this.app.getDevice(deviceId);

    const caps      = device.capabilities || [];
    const driverUri = device.driverUri || '';
    const knownType = this._detectKnownDriver(driverUri);

    const profile = {
      id:        deviceId,
      name:      device.name,
      driverUri,
      knownType,
      capabilities: caps,

      // What roles this device can fulfil
      roles: this._detectRoles(caps),

      // Per role: what exactly is possible
      canRead:                caps.includes('measure_power'),
      canReadSoc:             caps.includes('measure_battery'),
      canReadTemperature:     caps.includes('measure_temperature'),
      canControlOnOff:        caps.includes('onoff'),
      canControlCharging:     caps.includes('battery_charging_enabled'),
      canControlDischarging:  caps.includes('battery_discharging_enabled'),
      canSetCurrent:          caps.includes('ev_target_current'),
      canSetTemperature:      caps.includes('target_temperature'),
      canSetDim:              caps.includes('dim'),
      canReadThermostatMode:  caps.includes('thermostat_mode'),
      hasEnergyMeter:         caps.includes('meter_power') ||
                              caps.includes('meter_power.produced'),

      // Phase info (set by user during wizard, not auto-detected)
      phase: null,

      // Fallback: if direct control not possible, suggest a Flow
      needsFlowFallback: this._needsFlowFallback(caps, knownType),
      flowFallbackReason: this._flowFallbackReason(caps, knownType),
    };

    return profile;
  }

  /**
   * Detect which roles a device can fulfil based on capabilities.
   * Returns array of possible roles for the wizard to present.
   */
  _detectRoles(caps) {
    const roles = [];
    for (const [role, set] of Object.entries(CAPABILITY_SETS)) {
      const hasAll = set.required.every(c => caps.includes(c));
      if (hasAll) roles.push(role);
    }
    return roles;
  }

  _detectKnownDriver(driverUri) {
    for (const [prefix, type] of Object.entries(DRIVER_MAP)) {
      if (driverUri.startsWith(prefix)) return type;
    }
    return 'generic';
  }

  _needsFlowFallback(caps, knownType) {
    // Growatt offline: can't control, only read
    if (knownType === 'growatt_inverter') return true;
    // No direct battery control
    if (!caps.includes('battery_charging_enabled') &&
        !caps.includes('onoff') &&
         caps.includes('measure_battery')) return true;
    return false;
  }

  _flowFallbackReason(caps, knownType) {
    if (knownType === 'growatt_inverter') {
      return 'Growatt inverter is read-only in offline mode. Use HomeWizard kWh meter for production measurement.';
    }
    if (!caps.includes('battery_charging_enabled') &&
         caps.includes('measure_battery')) {
      return 'Battery has no direct charge control capability. Create a Homey Flow to handle charge commands.';
    }
    return null;
  }

}

module.exports = DeviceProfiler;
