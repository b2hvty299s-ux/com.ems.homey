'use strict';

/**
 * TripPlanner
 * ───────────
 * Manages EV trip planning.
 *
 * A trip is set via:
 *   1. Homey Flow action 'plan_ev_trip' (also used by iPhone Shortcuts)
 *   2. Settings page (manual input)
 *   3. API call from app.js onApi()
 *
 * The trip is stored in settings and used by PlanningEngine to:
 *   - Calculate how much extra kWh the EV needs
 *   - Prioritise EV charging before departure time
 *   - Trigger 'ev_ready_for_departure' Flow when SoC target reached
 *
 * A trip auto-expires 1 hour after the departure time.
 */
class TripPlanner {

  constructor(app) {
    this.app   = app;
    this.homey = app.homey;
    this._trip = null;
    this._readyFired = false;
  }

  init(config) {
    this._evCapacityKwh = config.ev?.capacityKwh ?? 60;
    this._defaultSoc    = config.ev?.defaultSoc  ?? 80;
    this._loadTrip();
    this.app.log('[TripPlanner] Ready');
  }

  // ─── Trip management ──────────────────────────────────────────────────────

  /**
   * Set a new trip.
   * @param {string} departureTime  — ISO string or "HH:MM" for today/tomorrow
   * @param {number} targetSoc      — desired SoC at departure (%)
   */
  async setTrip(departureTime, targetSoc) {
    const departure = this._parseTime(departureTime);

    this._trip = {
      departureTime: departure.toISOString(),
      targetSoc:     Math.max(0, Math.min(100, targetSoc)),
      setAt:         new Date().toISOString(),
    };

    this._readyFired = false;
    this._persistTrip();

    this.app.log(`[TripPlanner] Trip set: depart ${departure.toLocaleTimeString()} at ${targetSoc}% SoC`);

    // Send notification
    await this.app.notifications.send(
      `🚗 EV trip planned: depart at ${departure.toLocaleTimeString()} with ${targetSoc}% charge`,
    );
  }

  /**
   * Cancel the active trip.
   */
  cancelTrip() {
    this._trip = null;
    this._persistTrip();
    this.app.log('[TripPlanner] Trip cancelled');
  }

  /**
   * Returns the active trip, or null if none / expired.
   */
  getActiveTrip() {
    if (!this._trip) return null;

    const departure = new Date(this._trip.departureTime);
    const expiry    = new Date(departure.getTime() + 60 * 60 * 1000); // +1h

    if (new Date() > expiry) {
      this.app.log('[TripPlanner] Trip expired, clearing');
      this.cancelTrip();
      return null;
    }

    return this._trip;
  }

  /**
   * Check if EV is ready for departure — call this from EMS tick.
   * Fires Flow trigger once when SoC target is reached.
   * @param {number} currentSoc
   */
  checkReadiness(currentSoc) {
    const trip = this.getActiveTrip();
    if (!trip || this._readyFired) return;

    if (currentSoc >= trip.targetSoc) {
      this._readyFired = true;
      this.app.log(`[TripPlanner] EV ready for departure at ${currentSoc}%`);
      this.homey.emit('ems:evReadyForDeparture', { soc: currentSoc });
    }
  }

  /**
   * Returns how many kWh are needed to reach target SoC from current SoC.
   * @param {number} currentSoc
   */
  getNeededKwh(currentSoc) {
    const trip = this.getActiveTrip();
    if (!trip) return 0;
    return Math.max(0, this._evCapacityKwh * (trip.targetSoc - currentSoc) / 100);
  }

  /**
   * Returns hours remaining until departure.
   */
  getHoursUntilDeparture() {
    const trip = this.getActiveTrip();
    if (!trip) return null;
    const ms = new Date(trip.departureTime) - new Date();
    return ms / (1000 * 60 * 60);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _parseTime(input) {
    // If it's already an ISO string
    if (input.includes('T') || input.includes('-')) {
      return new Date(input);
    }

    // "HH:MM" format — assume today or tomorrow
    const [hours, minutes] = input.split(':').map(Number);
    const d = new Date();
    d.setSeconds(0, 0);
    d.setHours(hours, minutes || 0);

    // If time has already passed today, assume tomorrow
    if (d < new Date()) d.setDate(d.getDate() + 1);

    return d;
  }

  _loadTrip() {
    try {
      const raw  = this.homey.settings.get('ev_active_trip');
      this._trip = raw ? JSON.parse(raw) : null;
    } catch (_) { this._trip = null; }
  }

  _persistTrip() {
    this.homey.settings.set('ev_active_trip', this._trip ? JSON.stringify(this._trip) : null);
  }

}

module.exports = TripPlanner;
