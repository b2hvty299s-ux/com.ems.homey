'use strict';

/**
 * HomeWizard adapter
 * ──────────────────
 * Reads data from HomeWizard Energy devices via the Homey app
 * (nl.homewizard.energy) which exposes standard Homey capabilities.
 *
 * Supported devices:
 *   P1 Meter    → net import/export per fase, gas
 *   kWh Meter   → PV productie (op Growatt output)
 *   Energy Socket → schakelbare last met meting
 *
 * Capabilities exposed by HomeWizard Homey app:
 *   measure_power             — actueel vermogen (W), + = import, - = export
 *   measure_power.phase_1/2/3 — per fase (W)
 *   meter_power               — cumulatief (kWh)
 *   meter_power.peak          — dal/piek (kWh)
 *   measure_voltage.phase_1/2/3
 *   measure_current.phase_1/2/3
 *   meter_gas                 — gasverbruik (m³)
 *
 * Historical data:
 *   HomeWizard stores 1-minute interval data locally.
 *   We access this via the Homey Insights API which logs all capability
 *   values over time — no direct HomeWizard API call needed.
 */
class HomeWizardAdapter {

  constructor(app) {
    this.app    = app;
    this.homey  = app.homey;
    this._p1Id  = null;   // device ID of P1 meter
    this._kwhIds = [];    // device IDs of kWh meters (PV)
  }

  init(config) {
    this._p1Id   = config.gridMeterId   || null;
    this._kwhIds = config.pvMeterIds    || [];
    this.app.log(`[HomeWizard] P1: ${this._p1Id}, kWh meters: ${this._kwhIds.length}`);
  }

  // ─── Net meting (P1) ──────────────────────────────────────────────────────

  /**
   * Returns current net power per phase in Watts.
   * Positive = importing from grid, negative = exporting to grid.
   */
  async getGridPower() {
    if (!this._p1Id) return { total: 0, phases: [0, 0, 0] };

    try {
      const device = await this.app.getDevice(this._p1Id);
      const caps   = device.capabilitiesObj;

      const total = caps?.measure_power?.value ?? 0;

      // Log all capability keys once (for debugging phase names)
      if (!this._p1CapsLogged) {
        this._p1CapsLogged = true;
        this.app.log('[HomeWizard] P1 meter capabilities:', Object.keys(caps || {}).join(', '));
      }

      // Try per-phase — HomeWizard may use phase_1/2/3 or l1/l2/l3 or t1/t2/t3
      let phases = null;
      const PHASE_KEYS = [
        ['measure_power.phase_1', 'measure_power.phase_2', 'measure_power.phase_3'],
        ['measure_power.l1',      'measure_power.l2',      'measure_power.l3'     ],
        ['measure_power.t1',      'measure_power.t2',      'measure_power.t3'     ],
      ];
      for (const [k1, k2, k3] of PHASE_KEYS) {
        const p1 = caps?.[k1]?.value ?? null;
        if (p1 !== null) {
          phases = [p1, caps?.[k2]?.value ?? 0, caps?.[k3]?.value ?? 0];
          break;
        }
      }
      if (!phases) phases = [total, 0, 0]; // single phase or no per-phase data

      return { total, phases };
    } catch (err) {
      this.app.error('[HomeWizard] getGridPower error:', err.message);
      return { total: 0, phases: [0, 0, 0] };
    }
  }

  /**
   * Returns current net voltage per phase (V).
   */
  async getGridVoltage() {
    if (!this._p1Id) return [230, 230, 230];
    try {
      const device = await this.app.getDevice(this._p1Id);
      const caps   = device.capabilitiesObj;
      return [
        caps?.['measure_voltage.phase_1']?.value ?? 230,
        caps?.['measure_voltage.phase_2']?.value ?? 230,
        caps?.['measure_voltage.phase_3']?.value ?? 230,
      ];
    } catch (_) { return [230, 230, 230]; }
  }

  /**
   * Returns today's cumulative import and export in kWh.
   */
  async getGridTodayKwh() {
    if (!this._p1Id) return { imported: 0, exported: 0 };
    try {
      const device = await this.app.getDevice(this._p1Id);
      const caps   = device.capabilitiesObj;
      return {
        imported: caps?.['meter_power']?.value      ?? 0,
        exported: caps?.['meter_power.returned']?.value ?? 0,
      };
    } catch (_) { return { imported: 0, exported: 0 }; }
  }

  // ─── PV meting (kWh meters op omvormer output) ────────────────────────────

  /**
   * Returns current PV production: total (W) and per-phase breakdown.
   * Per-phase is only available when the PV meter exposes measure_power.phase_1/2/3.
   */
  async getPvPower() {
    if (this._kwhIds.length === 0) return { total: 0, phases: [0, 0, 0], hasPhaseData: false };

    let totalW       = 0;
    const phases     = [0, 0, 0];
    let hasPhaseData = false;

    for (const id of this._kwhIds) {
      try {
        const device = await this.app.getDevice(id);
        const caps   = device.capabilitiesObj;

        // Log all capability keys once (for debugging phase names)
        if (!this._pvCapsLogged) {
          this._pvCapsLogged = true;
          this.app.log('[HomeWizard] PV meter capabilities:', Object.keys(caps || {}).join(', '));
        }

        const power = caps?.measure_power?.value ?? 0;
        totalW += Math.max(0, power);

        // Try per-phase — HomeWizard may use phase_1/2/3 or l1/l2/l3 or t1/t2/t3
        const PHASE_KEYS = [
          ['measure_power.phase_1', 'measure_power.phase_2', 'measure_power.phase_3'],
          ['measure_power.l1',      'measure_power.l2',      'measure_power.l3'     ],
          ['measure_power.t1',      'measure_power.t2',      'measure_power.t3'     ],
        ];

        for (const [k1, k2, k3] of PHASE_KEYS) {
          const p1 = caps?.[k1]?.value ?? null;
          const p2 = caps?.[k2]?.value ?? null;
          const p3 = caps?.[k3]?.value ?? null;
          if (p1 !== null || p2 !== null || p3 !== null) {
            if (p1 !== null) phases[0] += Math.abs(p1);
            if (p2 !== null) phases[1] += Math.abs(p2);
            if (p3 !== null) phases[2] += Math.abs(p3);
            hasPhaseData = true;
            break; // found a working set, stop trying
          }
        }
      } catch (err) {
        this.app.error(`[HomeWizard] getPvPower error for ${id}:`, err.message);
      }
    }

    return { total: totalW, phases, hasPhaseData };
  }

  /**
   * Returns today's total PV production in kWh.
   */
  async getPvTodayKwh() {
    if (this._kwhIds.length === 0) return 0;

    let totalKwh = 0;
    for (const id of this._kwhIds) {
      try {
        const device = await this.app.getDevice(id);
        const kwh = device.capabilitiesObj?.['meter_power']?.value
                 ?? device.capabilitiesObj?.['meter_power.produced']?.value
                 ?? 0;
        totalKwh += kwh;
      } catch (_) {}
    }
    return totalKwh;
  }

  // ─── Historische data via Homey Insights ──────────────────────────────────

  /**
   * Returns hourly average power (W) for the past N days.
   * Used by ConsumptionLearner to build usage patterns.
   *
   * @param {string} deviceId
   * @param {string} capability  e.g. 'measure_power'
   * @param {number} days        how many days back (max 90)
   * @returns {Array<{hour: number, dayOfWeek: number, avgW: number}>}
   */
  async getHourlyHistory(deviceId, capability = 'measure_power', days = 30) {
    try {
      const insights = this.homey.insights;
      const log      = await insights.getLog({ uri: `homey:device:${deviceId}`, id: capability });

      const now    = Date.now();
      const cutoff = now - (days * 24 * 60 * 60 * 1000);

      // entries: [{ t: ISO string, v: number }]
      const entries = (log.entries || []).filter(e => new Date(e.t).getTime() > cutoff);

      // Bucket into hour + dayOfWeek slots
      const buckets = {}; // key = "dow_hour"
      for (const entry of entries) {
        const d   = new Date(entry.t);
        const key = `${d.getDay()}_${d.getHours()}`;
        if (!buckets[key]) buckets[key] = { sum: 0, count: 0, hour: d.getHours(), dayOfWeek: d.getDay() };
        buckets[key].sum   += entry.v;
        buckets[key].count += 1;
      }

      return Object.values(buckets).map(b => ({
        dayOfWeek: b.dayOfWeek,
        hour:      b.hour,
        avgW:      b.count > 0 ? b.sum / b.count : 0,
      }));
    } catch (err) {
      this.app.error('[HomeWizard] getHourlyHistory error:', err.message);
      return [];
    }
  }

}

module.exports = HomeWizardAdapter;
