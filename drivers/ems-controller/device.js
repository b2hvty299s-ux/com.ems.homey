'use strict';

const { Device } = require('homey');

/**
 * EmsControllerDevice
 * ───────────────────
 * Virtual device that:
 *  1. Holds device IDs in its store (set during pair wizard)
 *  2. Reads all configuration from device settings (editable in the settings tab)
 *  3. Initialises EmsManager with the merged config on startup / settings change
 *  4. Shows live status as capability tiles
 */
class EmsControllerDevice extends Device {

  async onInit() {
    this.log('[EmsDevice] Initialised');

    // Register this device so EmsManager can push state updates
    this.homey.app.setEmsControllerDevice(this);

    // Start EMS with the config stored from pairing
    await this._startEms();
  }

  // ─── Start / restart EMS with current device config ───────────────────────

  async _startEms() {
    const config = this._buildConfig();
    this.log('[EmsDevice] Starting EMS — P1:', config.gridMeterId,
             'PV meters:', config.pvMeterIds?.length,
             'battery:', config.batteryId ?? 'none',
             'EV:', config.evDeviceId ?? 'none',
             'HP:', config.heatPumpId ?? 'none');
    await this.homey.app.ems.applyConfig(config);
  }

  /**
   * Assembles the EmsManager config object.
   *
   * Store         — device IDs and flags (set during pair wizard)
   * homey.settings — all behaviour config (set via the app settings page before/after pairing)
   * homey.geolocation — location automatically from Homey's own settings
   */
  _buildConfig() {
    const s = this.homey.settings; // app-level settings (all config lives here)

    // Location: read directly from Homey
    const lat = this.homey.geolocation.getLatitude()  ?? 52.3;
    const lon = this.homey.geolocation.getLongitude() ?? 4.9;

    // Device IDs — now stored in app settings (set via the settings page)
    const gridMeterId  = s.get('gridMeterId')  ?? null;
    const pvMeterIds   = s.get('pvMeterIds')   ?? [];
    const hasBattery   = s.get('hasBattery')   ?? false;
    const batteryId    = s.get('batteryId')    ?? null;
    const hasEv        = s.get('hasEv')        ?? false;
    const evDeviceId   = s.get('evDeviceId')   ?? null;
    const hasEvCharger = s.get('hasEvCharger') ?? false;
    const evChargerId  = s.get('evChargerId')  ?? null;
    const hasHeatPump  = s.get('hasHeatPump')  ?? false;
    const heatPumpId   = s.get('heatPumpId')   ?? null;

    const batteries = hasBattery && batteryId
      ? [{
          id:            batteryId,
          capacityKwh:   s.get('bat_capacity_kwh')    ?? 5.0,
          maxChargeW:    s.get('bat_max_charge_w')    ?? 2500,
          maxDischargeW: s.get('bat_max_discharge_w') ?? 2500,
        }]
      : [];

    const ev = hasEv && evDeviceId
      ? {
          deviceId:    evDeviceId,
          chargerId:   hasEvCharger ? (evChargerId ?? null) : null,
          capacityKwh: s.get('ev_capacity_kwh') ?? 75,
          defaultSoc:  s.get('ev_default_soc')  ?? 80,
        }
      : null;

    const wallConnectorIp = s.get('wallConnectorIp') ?? null;

    // PV peak power — per-fase (3-fase) or single total (1-fase)
    const phases = s.get('phases') ?? 3;
    let pvPeakKw, pvStrings;
    if (phases === 3) {
      const l1 = s.get('pv_peak_kw_l1') ?? 0;
      const l2 = s.get('pv_peak_kw_l2') ?? 0;
      const l3 = s.get('pv_peak_kw_l3') ?? 0;
      pvPeakKw  = (l1 + l2 + l3) || (s.get('pv_peak_kw') ?? 5.0);
      pvStrings = (l1 + l2 + l3 > 0)
        ? [l1, l2, l3].filter(p => p > 0).map(p => ({ peakKw: p }))
        : null;
    } else {
      pvPeakKw  = s.get('pv_peak_kw') ?? 5.0;
      pvStrings = null;
    }

    return {
      lat,
      lon,
      phases,
      maxAmps:          s.get('max_amps')           ?? 25,
      contractType:     s.get('contract_type')      ?? 'fixed',
      priceImport:      s.get('price_import')       ?? 0.30,
      priceExport:      s.get('price_export')       ?? 0.09,
      dayAheadProvider: s.get('day_ahead_provider') ?? 'entso-e',
      dayAheadApiKey:   s.get('day_ahead_api_key')  ?? '',
      gridMeterId,
      pvMeterIds,
      pvPeakKw,
      pvStrings,
      hasBattery,
      batteryId,
      batteries,
      hasEv,
      evDeviceId,
      hasEvCharger,
      evChargerId,
      ev,
      wallConnectorIp,
      hasHeatPump,
      heatPumpId,
      thermostats:      hasHeatPump && heatPumpId
        ? [{ id: heatPumpId, name: 'Warmtepomp', baseTemp: s.get('hp_base_temp') ?? 20 }]
        : [],
      thermostatSettings: { offsetStep: s.get('hp_offset_deg') ?? 1 },
      surplusThreshold: s.get('surplus_threshold') ?? 300,
    };
  }

  // ─── Settings changes (device settings tab — only ems_mode) ───────────────

  async onSettings({ changedKeys, newSettings }) {
    this.log('[EmsDevice] Device settings changed:', changedKeys);
    if (changedKeys.includes('ems_mode')) {
      this.homey.app.ems?.setMode(newSettings.ems_mode);
    }
  }

  async onDeleted() {
    this.log('[EmsDevice] Device deleted');
  }

  // ─── State update (called by EmsManager every tick) ──────────────────────

  async updateState(state, status, mode) {
    try {
      // Totalen
      await this._setCapSafe('measure_power.pv',   Math.round(state.pvW   ?? 0));
      await this._setCapSafe('measure_power.grid',  Math.round(state.gridW ?? 0));
      await this._setCapSafe('measure_battery',     Math.round(state.batSoc ?? 50));
      await this._setCapSafe('measure_power.ev',    Math.round(state.evW   ?? 0));
      await this._setCapSafe('ems_status',          status ?? '—');
      await this._setCapSafe('ems_mode',            mode   ?? 'auto');

      // Per-fase net (altijd beschikbaar via P1 meter)
      const gp = state.gridPhases || [0, 0, 0];
      await this._setCapSafe('measure_power.grid_l1', Math.round(gp[0] ?? 0));
      await this._setCapSafe('measure_power.grid_l2', Math.round(gp[1] ?? 0));
      await this._setCapSafe('measure_power.grid_l3', Math.round(gp[2] ?? 0));

      // Per-fase PV — alleen invullen als de omvormer meter per-fase data levert.
      // Zonder per-fase data blijven de tiles op '-' (null) zodat het niet misleidend is.
      if (state.pvHasPhaseData) {
        const pp = state.pvPhases;
        await this._setCapSafe('measure_power.pv_l1', Math.round(pp[0] ?? 0));
        await this._setCapSafe('measure_power.pv_l2', Math.round(pp[1] ?? 0));
        await this._setCapSafe('measure_power.pv_l3', Math.round(pp[2] ?? 0));
      }
    } catch (err) {
      this.error('[EmsDevice] updateState error:', err.message);
    }
  }

  async _setCapSafe(cap, value) {
    if (this.hasCapability(cap)) {
      await this.setCapabilityValue(cap, value).catch(err =>
        this.error(`[EmsDevice] setCapabilityValue(${cap}) error:`, err.message)
      );
    }
  }

}

module.exports = EmsControllerDevice;
