'use strict';

/**
 * ConsumptionLearner
 * ──────────────────
 * Learns hourly household consumption patterns from historical data.
 * Uses a rolling 30-day average per hour per day-of-week.
 *
 * Data sources (in order of preference):
 *   1. HomeWizard P1 Insights history (via Homey Insights API)
 *   2. Recorded readings from EMS itself (fallback)
 *
 * Storage: Homey settings as JSON (lightweight, no external DB needed)
 */

const DEFAULT_KWH = 0.3; // 300W per hour as safe default

class ConsumptionLearner {

  constructor(app) {
    this.app    = app;
    this.homey  = app.homey;
    this._data  = {}; // { "dow_hour": { sum, count, avg } }
    this._buffer = []; // recent readings before bucketing
  }

  async init(config) {
    this._gridMeterId = config.gridMeterId;
    this._pvMeterIds  = config.pvMeterIds || [];

    // Load stored patterns
    this._loadPatterns();

    // Try to bootstrap from HomeWizard history if we have a device
    if (this._gridMeterId && Object.keys(this._data).length < 100) {
      await this._bootstrapFromHistory();
    }

    this.app.log(`[Learner] Initialised with ${Object.keys(this._data).length} hour-slots`);
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  /**
   * Returns expected consumption per hour for a given day of week.
   * @param {number} dayOfWeek  0=Sun, 1=Mon ... 6=Sat
   * @returns {Array<{hour: number, expectedKwh: number}>}
   */
  async getExpectedHourly(dayOfWeek) {
    const result = [];
    for (let h = 0; h < 24; h++) {
      const key  = `${dayOfWeek}_${h}`;
      const slot = this._data[key];
      result.push({
        hour:        h,
        expectedKwh: slot ? +slot.avg.toFixed(3) : DEFAULT_KWH,
      });
    }
    return result;
  }

  /**
   * Returns expected total kWh for a full day.
   */
  async getDailyExpected(dayOfWeek) {
    const hourly = await this.getExpectedHourly(dayOfWeek);
    return hourly.reduce((s, h) => s + h.expectedKwh, 0);
  }

  // ─── Recording ────────────────────────────────────────────────────────────

  /**
   * Record a live consumption reading (W) — called every minute by EmsManager.
   * Converted to kWh (1/60 hour) and averaged into the right slot.
   */
  async recordReading(powerW) {
    const now    = new Date();
    const dow    = now.getDay();
    const hour   = now.getHours();
    const kwhMin = (powerW / 1000) / 60; // kWh per minute

    this._buffer.push({ dow, hour, kwhMin, time: now.getTime() });

    // Flush buffer into patterns every full hour
    if (this._buffer.length >= 60) {
      this._flushBuffer();
    }
  }

  _flushBuffer() {
    // Group buffer by dow+hour slot
    const slots = {};
    for (const r of this._buffer) {
      const key = `${r.dow}_${r.hour}`;
      if (!slots[key]) slots[key] = 0;
      slots[key] += r.kwhMin;
    }

    // Update rolling averages
    for (const [key, kwhHour] of Object.entries(slots)) {
      if (!this._data[key]) this._data[key] = { sum: 0, count: 0, avg: DEFAULT_KWH };
      const d = this._data[key];
      // Exponential moving average (weight recent data more)
      d.avg   = d.count === 0 ? kwhHour : d.avg * 0.9 + kwhHour * 0.1;
      d.sum  += kwhHour;
      d.count++;
    }

    this._buffer = [];
    this._persistPatterns();
  }

  // ─── Bootstrap from HomeWizard history ────────────────────────────────────

  async _bootstrapFromHistory() {
    try {
      this.app.log('[Learner] Bootstrapping from HomeWizard Insights...');
      const insights = this.homey.insights;
      const log      = await insights.getLog({
        uri: `homey:device:${this._gridMeterId}`,
        id:  'measure_power',
      });

      const entries = log.entries || [];
      const cutoff  = Date.now() - 30 * 24 * 60 * 60 * 1000;

      let count = 0;
      for (const entry of entries) {
        const t = new Date(entry.t);
        if (t.getTime() < cutoff) continue;

        const dow  = t.getDay();
        const hour = t.getHours();
        const key  = `${dow}_${hour}`;
        const kwhMin = (Math.max(0, entry.v) / 1000) / 60;

        if (!this._data[key]) this._data[key] = { sum: 0, count: 0, avg: DEFAULT_KWH };
        const d = this._data[key];
        d.sum   += kwhMin;
        d.count += 1;
        d.avg    = d.sum / d.count;
        count++;
      }

      this._persistPatterns();
      this.app.log(`[Learner] Bootstrapped from ${count} readings`);
    } catch (err) {
      this.app.error('[Learner] Bootstrap error:', err.message);
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  _loadPatterns() {
    try {
      const raw = this.homey.settings.get('consumption_patterns');
      this._data = raw ? JSON.parse(raw) : {};
    } catch (_) { this._data = {}; }
  }

  _persistPatterns() {
    try {
      this.homey.settings.set('consumption_patterns', JSON.stringify(this._data));
    } catch (err) {
      this.app.error('[Learner] persist error:', err.message);
    }
  }

}

module.exports = ConsumptionLearner;
