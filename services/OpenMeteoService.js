'use strict';

/**
 * OpenMeteo service
 * ─────────────────
 * Fetches weather forecast and solar irradiance from Open-Meteo.
 * Free, no API key required, GDPR compliant.
 *
 * Endpoints used:
 *   forecast API: api.open-meteo.com/v1/forecast
 *
 * Data retrieved:
 *   - Hourly cloud cover (%) → convert to cloud factor (0-1)
 *   - Hourly shortwave radiation (W/m²) → direct solar irradiance
 *   - Hourly temperature_2m → for heating/cooling mode decision
 *   - Daily temperature_2m_min / temperature_2m_max
 *   - Hourly precipitation_probability
 */

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

class OpenMeteoService {

  constructor(app) {
    this.app    = app;
    this.homey  = app.homey;
    this.lat    = 52.3;
    this.lon    = 4.9;
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL  = 60 * 60 * 1000; // 1 hour
  }

  init(config) {
    this.lat = config.lat ?? 52.3;
    this.lon = config.lon ?? 4.9;
    this.app.log(`[OpenMeteo] Location: ${this.lat}, ${this.lon}`);
  }

  // ─── Main fetch ───────────────────────────────────────────────────────────

  /**
   * Fetch forecast for the next 2 days.
   * Cached for 1 hour to avoid hammering the API.
   */
  async getForecast() {
    const now = Date.now();
    if (this._cache && (now - this._cacheTime) < this._cacheTTL) {
      return this._cache;
    }

    const params = new URLSearchParams({
      latitude:  this.lat,
      longitude: this.lon,
      hourly: [
        'temperature_2m',
        'cloud_cover',
        'shortwave_radiation',
        'precipitation_probability',
        'wind_speed_10m',
      ].join(','),
      daily: [
        'temperature_2m_max',
        'temperature_2m_min',
        'sunrise',
        'sunset',
        'shortwave_radiation_sum',
      ].join(','),
      forecast_days: 3,
      timezone: 'Europe/Amsterdam',
    });

    const url = `${OPEN_METEO_URL}?${params}`;
    this.app.log(`[OpenMeteo] Fetching forecast...`);

    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const parsed = this._parse(data);
      this._cache     = parsed;
      this._cacheTime = now;
      this.app.log(`[OpenMeteo] Forecast fetched. Tomorrow: max ${parsed.tomorrow.dayMax}°C, cloud ${parsed.tomorrow.avgCloudPct}%`);
      return parsed;
    } catch (err) {
      this.app.error('[OpenMeteo] Fetch error:', err.message);
      // Return a pessimistic fallback if fetch fails
      return this._fallback();
    }
  }

  // ─── Convenience methods ──────────────────────────────────────────────────

  /**
   * Returns cloud factor (0 = full cloud, 1 = clear sky) for a given hour tomorrow.
   */
  async getCloudFactor(hourOfDay) {
    const forecast = await this.getForecast();
    const entry    = forecast.tomorrow.hourly.find(h => h.hour === hourOfDay);
    if (!entry) return 0.5;
    return 1 - (entry.cloudCoverPct / 100);
  }

  /**
   * Returns expected PV cloud factor for the whole day (weighted average).
   */
  async getDayCloudFactor(date = 'tomorrow') {
    const forecast = await this.getForecast();
    const day      = date === 'tomorrow' ? forecast.tomorrow : forecast.today;
    // Weight by solar hours (6:00-20:00)
    const solarHours = day.hourly.filter(h => h.hour >= 6 && h.hour <= 20);
    if (solarHours.length === 0) return 0.5;
    const avgCloud = solarHours.reduce((s, h) => s + h.cloudCoverPct, 0) / solarHours.length;
    return +(1 - avgCloud / 100).toFixed(2);
  }

  /**
   * Returns night minimum temperature for tonight (for heating/cooling mode).
   */
  async getNightMinTemp() {
    const forecast = await this.getForecast();
    return forecast.tonight.nightMin;
  }

  /**
   * Returns tomorrow's max temperature.
   */
  async getTomorrowMaxTemp() {
    const forecast = await this.getForecast();
    return forecast.tomorrow.dayMax;
  }

  /**
   * Returns hourly solar radiation for tomorrow (W/m²).
   */
  async getTomorrowRadiation() {
    const forecast = await this.getForecast();
    return forecast.tomorrow.hourly.map(h => ({ hour: h.hour, radiationW: h.radiationW }));
  }

  // ─── Parsing ──────────────────────────────────────────────────────────────

  _parse(data) {
    const hourly = data.hourly;
    const daily  = data.daily;

    if (!hourly || !hourly.time || !Array.isArray(hourly.time)) {
      this.app.error('[OpenMeteo] Invalid response structure:', JSON.stringify(data).slice(0, 200));
      throw new Error('Invalid Open-Meteo response — missing hourly.time');
    }

    const rad = hourly.shortwave_radiation;
    if (!rad) {
      this.app.error('[OpenMeteo] Missing shortwave_radiation in response');
      throw new Error('Missing shortwave_radiation');
    }

    // Map hourly arrays to objects
    // Use string slicing for hour (avoids timezone issues with new Date())
    const hourlyData = hourly.time.map((t, i) => ({
      time:           t,
      hour:           parseInt(t.slice(11, 13), 10),  // "2026-05-30T14:00" → 14
      date:           t.substring(0, 10),
      tempC:          hourly.temperature_2m?.[i] ?? 12,
      cloudCoverPct:  hourly.cloud_cover?.[i]      ?? 50,
      radiationW:     rad[i]                        ?? 0,
      precipProb:     hourly.precipitation_probability?.[i] ?? 20,
    }));

    const todayStr    = this._todayStr();
    const tomorrowStr = this._tomorrowStr();
    const tonightStr  = todayStr; // tonight = today's night hours

    const todayH    = hourlyData.filter(h => h.date === todayStr);
    const tomorrowH = hourlyData.filter(h => h.date === tomorrowStr);

    // Daily summary
    const todayIdx    = daily.time.indexOf(todayStr);
    const tomorrowIdx = daily.time.indexOf(tomorrowStr);

    // Night min = min of tonight 22:00-06:00 (today evening + tomorrow morning)
    const nightHours = [
      ...hourlyData.filter(h => h.date === todayStr    && h.hour >= 22),
      ...hourlyData.filter(h => h.date === tomorrowStr && h.hour <= 6),
    ];
    const nightMin = nightHours.length > 0
      ? Math.min(...nightHours.map(h => h.tempC))
      : 10;

    return {
      today: {
        hourly:        todayH,
        dayMax:        daily.temperature_2m_max[todayIdx]    ?? 15,
        dayMin:        daily.temperature_2m_min[todayIdx]    ?? 8,
        radiationSum:  daily.shortwave_radiation_sum[todayIdx] ?? 5,
        avgCloudPct:   this._avg(todayH.map(h => h.cloudCoverPct)),
      },
      tomorrow: {
        hourly:        tomorrowH,
        dayMax:        daily.temperature_2m_max[tomorrowIdx]    ?? 15,
        dayMin:        daily.temperature_2m_min[tomorrowIdx]    ?? 8,
        radiationSum:  daily.shortwave_radiation_sum[tomorrowIdx] ?? 5,
        avgCloudPct:   this._avg(tomorrowH.map(h => h.cloudCoverPct)),
      },
      tonight: { nightMin },
    };
  }

  _fallback() {
    const hourly = Array.from({ length: 24 }, (_, h) => ({
      hour: h, cloudCoverPct: 50, radiationW: 0, tempC: 12, precipProb: 20,
    }));
    return {
      today:    { hourly, dayMax: 15, dayMin: 8, radiationSum: 5, avgCloudPct: 50 },
      tomorrow: { hourly, dayMax: 15, dayMin: 8, radiationSum: 5, avgCloudPct: 50 },
      tonight:  { nightMin: 10 },
    };
  }

  _todayStr()    { return new Date().toISOString().substring(0, 10); }
  _tomorrowStr() {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return d.toISOString().substring(0, 10);
  }
  _avg(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((s, v) => s + (v ?? 0), 0) / arr.length;
  }

}

module.exports = OpenMeteoService;
