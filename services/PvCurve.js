'use strict';

/**
 * PvCurve
 * ───────
 * Generates an expected solar production curve for a given day.
 *
 * Primary method (preferred):
 *   generateCurveFromForecast(forecast, peakKwTotal)
 *   Uses Open-Meteo hourly shortwave_radiation (W/m²) directly.
 *   Formula: expectedKw = (radiationW / 1000) × peakKw × SYSTEM_EFFICIENCY
 *   — no orientation or tilt needed; radiation data already reflects actual sky conditions.
 *
 * Fallback method (no internet):
 *   generateCurveFallback(date, cloudFactor)
 *   Simple sine curve between calculated sunrise and sunset.
 *
 * Config (via init):
 *   peakKwTotal  — total installed peak power in kWp (sum of all strings)
 *   lat, lon     — location for fallback sunrise/sunset calculation
 */

const SYSTEM_EFFICIENCY = 0.80; // inverter + wiring + temperature losses
const STC_IRRADIANCE    = 1000; // W/m² at Standard Test Conditions

class PvCurve {

  constructor(app) {
    this.app        = app;
    this.peakKw     = 0;
    this.lat        = 52.3;
    this.lon        = 4.9;
  }

  /**
   * @param {{ peakKwTotal: number, lat: number, lon: number }} config
   */
  init(config) {
    // Support both old pvStrings array and new flat peakKwTotal
    if (config.pvStrings && config.pvStrings.length > 0) {
      this.peakKw = config.pvStrings.reduce((s, str) => s + (str.peakKw || 0), 0);
    } else {
      this.peakKw = config.peakKwTotal ?? config.pvPeakKw ?? 5.0;
    }
    this.lat = config.lat ?? 52.3;
    this.lon = config.lon ?? 4.9;
    this.app.log(`[PvCurve] ${this.peakKw} kWp, location: ${this.lat}, ${this.lon}`);
  }

  // ─── Primary: radiation-based curve ──────────────────────────────────────

  /**
   * Generate a 24-entry production curve using Open-Meteo radiation data.
   *
   * @param {object} forecast  — result of OpenMeteoService.getForecast()
   * @param {'today'|'tomorrow'} day
   * @returns {Array<{hour: number, expectedKw: number}>}
   */
  generateCurveFromForecast(forecast, day = 'tomorrow') {
    const dayData = forecast[day];
    if (!dayData || !dayData.hourly || dayData.hourly.length === 0) {
      return this.generateCurveFallback(day === 'tomorrow' ? this._tomorrow() : new Date());
    }

    const result = [];
    for (let h = 0; h < 24; h++) {
      const entry = dayData.hourly.find(e => e.hour === h);
      const radiationW = entry ? (entry.radiationW ?? 0) : 0;
      const expectedKw = (radiationW / STC_IRRADIANCE) * this.peakKw * SYSTEM_EFFICIENCY;
      result.push({ hour: h, expectedKw: Math.max(0, +expectedKw.toFixed(3)) });
    }
    return result;
  }

  /**
   * Total expected kWh for the day using forecast data.
   */
  getDailyTotalFromForecast(forecast, day = 'tomorrow') {
    return this.generateCurveFromForecast(forecast, day)
      .reduce((sum, h) => sum + h.expectedKw, 0);
  }

  // ─── Fallback: sine-curve between sunrise and sunset ─────────────────────

  /**
   * Generate a 24-entry production curve from a simple parabola.
   * Used when Open-Meteo is unavailable.
   *
   * @param {Date}   date
   * @param {number} cloudFactor  0 (full cloud) – 1 (clear sky)
   * @returns {Array<{hour: number, expectedKw: number}>}
   */
  generateCurveFallback(date = new Date(), cloudFactor = 0.7) {
    const { sunriseH, sunsetH, solarNoonH } = this._getSunTimes(date);
    const result = [];
    for (let h = 0; h < 24; h++) {
      const expectedKw = this._sineKw(h, sunriseH, sunsetH) * cloudFactor;
      result.push({ hour: h, expectedKw: Math.max(0, +expectedKw.toFixed(3)) });
    }
    return result;
  }

  getDailyTotal(date = new Date(), cloudFactor = 0.7) {
    return this.generateCurveFallback(date, cloudFactor)
      .reduce((sum, h) => sum + h.expectedKw, 0);
  }

  // ─── Sun times ────────────────────────────────────────────────────────────

  getSunTimes(date = new Date()) {
    return this._getSunTimes(date);
  }

  _getSunTimes(date) {
    const dayOfYear = this._getDayOfYear(date);
    const lat       = this.lat * (Math.PI / 180);

    const decl    = 23.45 * Math.sin((360 / 365) * (dayOfYear - 81) * (Math.PI / 180));
    const declRad = decl * (Math.PI / 180);

    const cosH     = -Math.tan(lat) * Math.tan(declRad);
    const hourAngle = Math.acos(Math.max(-1, Math.min(1, cosH))) * (180 / Math.PI);

    const tzOffset  = this._getTimezoneOffsetH(date);
    const lonOffset = this.lon / 15;
    const solarNoonH = 12 - lonOffset + tzOffset;
    const halfDayH   = hourAngle / 15;

    return {
      sunriseH:  solarNoonH - halfDayH,
      sunsetH:   solarNoonH + halfDayH,
      solarNoonH,
    };
  }

  _sineKw(h, sunriseH, sunsetH) {
    if (h < sunriseH || h > sunsetH) return 0;
    const span = sunsetH - sunriseH;
    if (span <= 0) return 0;
    const progress = (h - sunriseH) / span;
    return this.peakKw * SYSTEM_EFFICIENCY * Math.sin(Math.PI * progress);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _tomorrow() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  }

  _getDayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date - start) / (1000 * 60 * 60 * 24));
  }

  _getTimezoneOffsetH(date) {
    const month = date.getMonth() + 1;
    if (month > 3 && month < 10) return 2;
    if (month === 3) return date.getDate() >= this._lastSundayOfMonth(date.getFullYear(), 3) ? 2 : 1;
    if (month === 10) return date.getDate() < this._lastSundayOfMonth(date.getFullYear(), 10) ? 2 : 1;
    return 1;
  }

  _lastSundayOfMonth(year, month) {
    const d = new Date(year, month, 0);
    return d.getDate() - d.getDay();
  }

}

module.exports = PvCurve;
