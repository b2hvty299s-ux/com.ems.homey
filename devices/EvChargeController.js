'use strict';

/**
 * EvChargeController
 * ──────────────────
 * Decides every tick what the Tesla should do based on:
 *   - Current solar surplus
 *   - Battery SoC
 *   - Active trip (deadline + target SoC)
 *   - EV charge mode + current profile settings
 *   - Day plan from PlanningEngine
 *   - Peak hour blocks and night charge window
 *
 * Charge modes:
 *   solar_only       — follows solar surplus, stops below IEC minimum
 *   solar_and_grid   — follows solar, falls back to grid when plan says so
 *   fixed            — always charges at a fixed current (regardless of surplus)
 *   fast_charge      — charges at max configured current
 *   off              — never charges
 *
 * Time-based rules (stored in Homey settings):
 *   ev_peak1_start / ev_peak1_end   — morning peak block (default 07–09)
 *   ev_peak2_start / ev_peak2_end   — evening peak block (default 17–21)
 *   ev_night_charge                 — enable grid charging in night window (default false)
 *   ev_night_start / ev_night_end   — night window (default 23–07)
 *   ev_bat_night_min_soc            — min battery SoC% before allowing night EV charge (default 0)
 *
 * During peak blocks:
 *   - EV charging is always blocked, EXCEPT when a trip deadline forces fast_charge
 *   - EmsManager will also command battery to max discharge during peak
 *
 * Night charging (solar_and_grid mode only):
 *   - Allowed if ev_night_charge = true AND batSoc >= ev_bat_night_min_soc
 *   - Charges at ev_min_current_a (minimum grid draw)
 *
 * Current profile settings (stored in Homey settings):
 *   ev_charge_mode        'solar_only' | 'solar_and_grid' | 'fixed' | 'fast_charge' | 'off'
 *   ev_fixed_current_a    number   — Ampères for fixed mode (default 8A)
 *   ev_max_current_a      number   — hard ceiling for solar/fast modes (default = hardware max)
 *   ev_min_current_a      number   — floor for solar following (default 6A = IEC minimum)
 *
 * Trip deadline logic:
 *   - If needed kWh cannot be delivered at current mode's rate before departure
 *     → upgrade to fast_charge regardless of mode setting
 *   - Threshold: TRIP_FALLBACK_HOURS before departure
 *   - Trip urgency also overrides peak block
 */

const IEC_MIN_CURRENT_A   = 5;     // hardware floor — IEC 61851 spec is 6A but many chargers support 5A
const HYSTERESIS_A        = 1;     // min current change before actually adjusting
const STOP_HYSTERESIS_A   = 2;     // when already charging, stop only when rawA drops this far below IEC min
const TRIP_FALLBACK_HOURS = 2;     // hours before departure to force fast_charge

class EvChargeController {

  constructor(app, teslaAdapter, tripPlanner) {
    this.app         = app;
    this.homey       = app.homey;
    this.tesla       = teslaAdapter;
    this.tripPlanner = tripPlanner;

    this._currentTargetA = 0;
    this._mode           = 'solar_only';
    this._evPhases       = 3;
    this._hardMaxA       = 16;   // hardware/installation ceiling
    this._maxCurrentA    = 16;   // soft max (user configured)
    this._minCurrentA    = 6;    // solar following floor
    this._fixedCurrentA  = 8;    // fixed mode current

    // Time-based settings (loaded each tick)
    this._peak1Start       = 7;
    this._peak1End         = 9;
    this._peak2Start       = 17;
    this._peak2End         = 21;
    this._nightCharge      = false;
    this._nightStart       = 23;
    this._nightEnd         = 7;
    this._batNightMinSoc   = 0;

    // Days the car is typically home (0=zo, 1=ma, ..., 6=za)
    // If tomorrow is a home day → skip night charging (car can charge on solar tomorrow)
    this._homeDays         = [0, 6]; // default: za + zo

    // Load-balance postpone: timestamp until which EV charging is blocked
    this._evPostponedUntil = 0;

  }

  // ─── Init & settings ──────────────────────────────────────────────────────

  init(config) {
    this._evPhases    = config.ev?.phases  ?? 3;
    this._hardMaxA    = config.ev?.maxAmps ?? 16;

    this._loadSettings();

    this.app.log(
      `[EvCtrl] mode: ${this._mode} | phases: ${this._evPhases} | ` +
      `max: ${this._maxCurrentA}A | min: ${this._minCurrentA}A | fixed: ${this._fixedCurrentA}A | ` +
      `peak1: ${this._peak1Start}–${this._peak1End}h | peak2: ${this._peak2Start}–${this._peak2End}h | ` +
      `night: ${this._nightCharge ? `${this._nightStart}–${this._nightEnd}h (min SoC ${this._batNightMinSoc}%)` : 'off'}`
    );
  }

  _loadSettings() {
    const s = this.homey.settings;

    this._mode          = s.get('ev_charge_mode')       ?? 'solar_only';
    this._maxCurrentA   = Math.min(
      s.get('ev_max_current_a') ?? this._hardMaxA,
      this._hardMaxA
    );
    this._minCurrentA   = Math.max(
      s.get('ev_min_current_a') ?? IEC_MIN_CURRENT_A,
      IEC_MIN_CURRENT_A
    );
    this._fixedCurrentA = Math.min(
      Math.max(s.get('ev_fixed_current_a') ?? 8, IEC_MIN_CURRENT_A),
      this._hardMaxA
    );

    // Peak blocks
    this._peak1Start     = s.get('ev_peak1_start')       ?? 7;
    this._peak1End       = s.get('ev_peak1_end')         ?? 9;
    this._peak2Start     = s.get('ev_peak2_start')       ?? 17;
    this._peak2End       = s.get('ev_peak2_end')         ?? 21;

    // Target grid import while solar-following (W).
    // A positive value means "aim for X W of import" rather than zero export.
    // Useful with asymmetric multi-inverter setups where phase imbalance makes
    // true-zero impossible without some phases exporting.
    this._targetImportW  = s.get('ev_target_import_w')   ?? 100;

    // Night charging
    this._nightCharge    = s.get('ev_night_charge')      ?? false;
    this._nightStart     = s.get('ev_night_start')       ?? 23;
    this._nightEnd       = s.get('ev_night_end')         ?? 7;
    this._batNightMinSoc = s.get('ev_bat_night_min_soc') ?? 0;

    // Home days — which weekdays is the car typically on the driveway?
    // 0=zo 1=ma 2=di 3=wo 4=do 5=vr 6=za
    const DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];
    this._homeDays = DAY_KEYS
      .map((d, i) => (s.get(`ev_home_${d}`) ?? (i === 0 || i === 6)) ? i : -1)
      .filter(i => i >= 0);
  }

  /**
   * Update a current profile setting and persist it.
   */
  setSetting(setting, value) {
    switch (setting) {
      case 'mode':
        this._mode = value;
        this.homey.settings.set('ev_charge_mode', value);
        break;
      case 'max':
        this._maxCurrentA = Math.min(Math.max(value, IEC_MIN_CURRENT_A), this._hardMaxA);
        this.homey.settings.set('ev_max_current_a', this._maxCurrentA);
        break;
      case 'min':
        this._minCurrentA = Math.min(Math.max(value, IEC_MIN_CURRENT_A), this._maxCurrentA);
        this.homey.settings.set('ev_min_current_a', this._minCurrentA);
        break;
      case 'fixed':
        this._fixedCurrentA = Math.min(Math.max(value, IEC_MIN_CURRENT_A), this._hardMaxA);
        this.homey.settings.set('ev_fixed_current_a', this._fixedCurrentA);
        break;
    }
    this.app.log(`[EvCtrl] Setting '${setting}' → ${value}`);
  }

  /**
   * Postpone EV charging for the given number of minutes.
   * Called by the 'postpone_ev_charging' flow action (load-balance trigger).
   */
  postponeCharging(minutes) {
    const ms = (minutes ?? 30) * 60_000;
    this._evPostponedUntil = Date.now() + ms;
    this.app.log(
      `[EvCtrl] EV charging postponed for ${minutes} min ` +
      `(until ${new Date(this._evPostponedUntil).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })})`
    );
  }

  getSettings() {
    return {
      mode:           this._mode,
      maxCurrentA:    this._maxCurrentA,
      minCurrentA:    this._minCurrentA,
      fixedCurrentA:  this._fixedCurrentA,
      hardMaxA:       this._hardMaxA,
      phases:         this._evPhases,
      fixedPowerW:    this._toWatts(this._fixedCurrentA),
      maxPowerW:      this._toWatts(this._maxCurrentA),
      minPowerW:      this._toWatts(this._minCurrentA),
      peak1:          { start: this._peak1Start, end: this._peak1End },
      peak2:          { start: this._peak2Start, end: this._peak2End },
      night:          { enabled: this._nightCharge, start: this._nightStart, end: this._nightEnd, minSoc: this._batNightMinSoc },
    };
  }

  getExpectedChargeW() {
    switch (this._mode) {
      case 'fixed':       return this._toWatts(this._fixedCurrentA);
      case 'fast_charge': return this._toWatts(this._maxCurrentA);
      case 'off':         return 0;
      default:            return this._toWatts(this._maxCurrentA);
    }
  }

  // ─── Time helpers ─────────────────────────────────────────────────────────

  /**
   * Returns true if the current hour falls inside a peak block.
   * Supports overnight wrap (start > end means it crosses midnight).
   */
  isPeakHour(now = new Date()) {
    const h = now.getHours();
    return this._inHourBlock(h, this._peak1Start, this._peak1End)
        || this._inHourBlock(h, this._peak2Start, this._peak2End);
  }

  _isNightWindow(now = new Date()) {
    const h = now.getHours();
    return this._inHourBlock(h, this._nightStart, this._nightEnd);
  }

  /**
   * Returns true if tomorrow is a configured "car at home" day.
   * When true, night charging is skipped — the car can charge on solar tomorrow.
   */
  _isTomorrowHomeDay(now = new Date()) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return this._homeDays.includes(tomorrow.getDay());
  }

  /**
   * Hour block check. When start < end: simple range [start, end).
   * When start > end: wraps midnight, e.g. 23–07 means h >= 23 OR h < 7.
   */
  _inHourBlock(h, start, end) {
    if (start === end) return false;        // zero-width block = disabled
    if (start < end)  return h >= start && h < end;
    return h >= start || h < end;           // overnight wrap
  }

  // ─── Main tick ────────────────────────────────────────────────────────────

  async tick(emsState, planSlot) {
    // Reload settings each tick so changes take effect immediately
    this._loadSettings();

    // ── Vehicle presence check ────────────────────────────────────────────
    if (!this.tesla.isVehiclePresent()) {
      if (this._currentTargetA !== 0) {
        this.app.log('[EvCtrl] No vehicle at charger — suspending EV control');
        this._currentTargetA = 0;
        this.tesla._isChargingByEms = false;
      }
      return;
    }

    const evState = await this.tesla.getState();

    if (!evState.connected) {
      this._currentTargetA = 0;
      return;
    }

    // ── Load-balance postpone check ───────────────────────────────────────
    // When a flow signals too-high phase current, EV charging is paused
    // for a configurable number of minutes (see postponeCharging()).
    if (Date.now() < this._evPostponedUntil) {
      const remaining = Math.ceil((this._evPostponedUntil - Date.now()) / 60_000);
      const action = { type: 'stop', reason: `load_balance(${remaining}min)` };
      await this._applyAction(action, evState, true);  // force: load-balance always wins
      this._logTick(evState, action, 'postponed');
      return;
    }

    // ── Peak block check ──────────────────────────────────────────────────
    // Always block EV during peak hours — EXCEPT when a trip deadline forces
    // fast_charge (departure imminent). Battery is discharged by EmsManager.
    const now          = new Date();
    const inPeak       = this.isPeakHour(now);
    const effectiveMode = this._getEffectiveMode(evState);
    const tripUrgent   = effectiveMode === 'fast_charge' && this.tripPlanner?.getActiveTrip();

    if (inPeak && !tripUrgent) {
      const action = { type: 'stop', reason: 'peak_block' };
      await this._applyAction(action, evState, true);  // force: stop regardless of who started
      this._logTick(evState, action, `peak(${effectiveMode})`);
      return;
    }

    const action = this._decideAction(emsState, evState, planSlot, effectiveMode, now);
    await this._applyAction(action, evState);
    this._logTick(evState, action, effectiveMode);
  }

  // ─── Mode resolution ──────────────────────────────────────────────────────

  _getEffectiveMode(evState) {
    if (this._mode === 'off') return 'off';

    const trip = this.tripPlanner?.getActiveTrip();
    if (trip) {
      const hoursLeft  = this.tripPlanner.getHoursUntilDeparture();
      const neededKwh  = this.tripPlanner.getNeededKwh(evState.soc ?? 50);
      const rateKwhH   = this._toWatts(this._effectiveCurrentForMode()) / 1000;
      const canDeliver = rateKwhH * (hoursLeft ?? 0);

      if ((hoursLeft ?? 99) <= TRIP_FALLBACK_HOURS || neededKwh > canDeliver) {
        this.app.log(
          `[EvCtrl] Trip deadline — ${hoursLeft?.toFixed(1)}h left, ` +
          `need ${neededKwh.toFixed(1)} kWh, can deliver ${canDeliver.toFixed(1)} kWh → fast_charge`
        );
        return 'fast_charge';
      }
    }

    return this._mode;
  }

  _effectiveCurrentForMode() {
    switch (this._mode) {
      case 'fixed':       return this._fixedCurrentA;
      case 'fast_charge': return this._maxCurrentA;
      default:            return this._maxCurrentA;
    }
  }

  // ─── SoC limit ────────────────────────────────────────────────────────────

  /**
   * Returns the active charge target:
   *   1. Active trip target SoC (TripPlanner)
   *   2. Default from settings (ev_default_soc, default 80%)
   */
  _getTargetSoc() {
    const trip = this.tripPlanner?.getActiveTrip();
    if (trip?.targetSoc) return trip.targetSoc;
    return this.homey.settings.get('ev_default_soc') ?? 80;
  }

  /**
   * Check SoC against the active target. Returns a stop action if reached,
   * null otherwise. Also notifies TripPlanner so it can fire ev_ready_for_departure.
   */
  _checkSocLimit(evState) {
    const soc   = evState.soc ?? 0;
    const limit = this._getTargetSoc();

    // Let TripPlanner fire ev_ready_for_departure when trip target is reached
    this.tripPlanner?.checkReadiness(soc);

    if (soc >= limit) {
      return { type: 'stop', reason: `soc_target(${soc}%>=${limit}%)` };
    }
    return null;
  }

  // ─── Decision ─────────────────────────────────────────────────────────────

  _decideAction(emsState, evState, planSlot, mode, now = new Date()) {
    // Always check SoC limit first — stops charging regardless of mode
    const limitStop = this._checkSocLimit(evState);
    if (limitStop) return limitStop;

    switch (mode) {

      case 'off':
        return { type: 'stop', reason: 'mode_off' };

      case 'fixed':
        return {
          type:     'charge',
          currentA: this._fixedCurrentA,
          reason:   'fixed_current',
          powerW:   this._toWatts(this._fixedCurrentA),
        };

      case 'fast_charge':
        return {
          type:     'charge',
          currentA: this._maxCurrentA,
          reason:   'fast_charge',
          powerW:   this._toWatts(this._maxCurrentA),
        };

      case 'solar_and_grid':
        return this._decideSolarOrGrid(emsState, evState, planSlot, now);

      case 'solar_only':
      default:
        return this._decideSolarOnly(emsState, evState);
    }
  }

  _decideSolarOnly(emsState, evState) {
    // Strategy B: fixed minimum current, threshold on/off — no dynamic stepping.
    //
    // surplusW already accounts for current EV load (see _calculateSurplus), so it
    // represents "what would be available if we charge at min current".
    //
    // Start condition: surplus >= min EV power  → solar clearly covers min charge rate
    // Stop condition:  surplus < -(minPower×0.25) → grid import > 25% of min power
    //   (small hysteresis band avoids chattering at the threshold boundary)
    const surplusW  = this._calculateSurplus(emsState, evState);
    const minPowerW = this._toWatts(this._minCurrentA);

    if (evState.charging) {
      // Stop when surplus is clearly negative (importing from grid to power the EV).
      // Small hysteresis of 200W prevents chattering on sensor jitter or brief clouds.
      if (surplusW < -200) {
        return { type: 'stop', reason: 'surplus_gone', surplusW };
      }
      // Always enforce minCurrentA — never leave a higher current from a previous session
      return { type: 'charge', currentA: this._minCurrentA, reason: 'surplus_ok', surplusW };
    }

    if (surplusW >= minPowerW) {
      return {
        type:     'charge',
        currentA: this._minCurrentA,
        reason:   'surplus_threshold',
        surplusW,
        powerW:   minPowerW,
      };
    }

    return { type: 'stop', reason: 'insufficient_surplus', surplusW };
  }

  _decideSolarOrGrid(emsState, evState, planSlot, now = new Date()) {
    // ── Solar path (same threshold strategy as solar_only) ──────────────
    const surplusW  = this._calculateSurplus(emsState, evState);
    const minPowerW = this._toWatts(this._minCurrentA);

    if (evState.charging) {
      if (surplusW >= -200) {
        // Enforce minCurrentA — never leave a higher current from a previous session
        return { type: 'charge', currentA: this._minCurrentA, reason: 'surplus_ok', surplusW };
      }
      // Fall through to night/plan paths when surplus is clearly gone
    } else if (surplusW >= minPowerW) {
      return { type: 'charge', currentA: this._minCurrentA, reason: 'surplus_threshold', surplusW };
    }

    // No sufficient solar surplus — stop unless a grid path applies below

    // ── Night-charge path ────────────────────────────────────────────────
    // No solar → check if night charging is allowed
    if (this._nightCharge && this._isNightWindow(now)) {
      // Skip night charging if tomorrow the car is home → charge on solar instead
      if (this._isTomorrowHomeDay(now)) {
        return {
          type:   'stop',
          reason: 'ev_home_tomorrow',
        };
      }
      const batSoc = emsState.batSoc ?? 100;
      if (batSoc >= this._batNightMinSoc) {
        return {
          type:     'charge',
          currentA: this._minCurrentA,
          reason:   'night_charge',
          powerW:   this._toWatts(this._minCurrentA),
        };
      } else {
        return {
          type:   'stop',
          reason: `night_bat_low(${batSoc.toFixed(0)}%<${this._batNightMinSoc}%)`,
        };
      }
    }

    // ── Plan path ────────────────────────────────────────────────────────
    if (planSlot?.evCharging) {
      return {
        type:     'charge',
        currentA: this._minCurrentA,
        reason:   'plan_grid',
        powerW:   this._toWatts(this._minCurrentA),
      };
    }

    return { type: 'stop', reason: 'no_solar_no_plan' };
  }

  // ─── Apply action ─────────────────────────────────────────────────────────

  async _applyAction(action, evState, force = false) {
    switch (action.type) {

      case 'stop':
        // force = true: hard rules (peak block, postpone) — stop regardless of who started,
        //               bypass rate limiter, send immediately.
        // force = false: soft stop (no surplus) — only stop EMS-owned sessions.
        if (evState.charging || force) {
          await this.tesla.stopCharging(force);
          this._currentTargetA = 0;
        }
        break;

      case 'hold':
        break;

      case 'charge':
        if (action.currentA !== this._currentTargetA) {
          await this.tesla.setChargeCurrent(action.currentA);
          this._currentTargetA = action.currentA;
          this.tesla._isChargingByEms = true;
        } else if (!evState.charging) {
          await this.tesla.startCharging();
          this.tesla._isChargingByEms = true;
        }
        break;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _applyBounds(rawA) {
    if (rawA < IEC_MIN_CURRENT_A) return 0;
    if (rawA < this._minCurrentA) return 0;
    return Math.min(rawA, this._maxCurrentA);
  }

  _toWatts(currentA) {
    return Math.round(currentA * 230 * this._evPhases);
  }

  _calculateSurplus(emsState, evState) {
    const gridW   = emsState.gridW ?? 0;   // positive = importing, negative = exporting
    const evLoadW = evState?.powerW
      ?? (this._currentTargetA > 0 ? this._toWatts(this._currentTargetA) : 0);

    // Available solar power for EV:
    //   surplus = evLoadW - gridW - targetImportW
    //
    // Examples:
    //   Exporting 500W, EV off:        0 - (-500) - 100 =  400W  → not enough for 5A yet
    //   Exporting 1500W, EV off:       0 - (-1500) - 100 = 1400W → start at 5A
    //   Exporting 500W, EV on 1150W:   1150 - (-500) - 100 = 1550W → keep charging ✓
    //   Importing 329W, EV on 3435W:   3435 - 3764 - 100 = -429W → stop ✓ (no real surplus)
    //   Brief cloud (-100W import):    1150 - 100 - 100 = 950W → keep going (hysteresis) ✓
    return evLoadW - gridW - this._targetImportW;
  }

  _logTick(evState, action, mode) {
    const status = evState.charging
      ? `${evState.powerW.toFixed(0)}W @ ${evState.currentA.toFixed(1)}A`
      : evState.connected ? 'idle' : 'not connected';

    const rawAStr = action.rawA !== undefined ? ` rawA: ${action.rawA.toFixed(2)}A` : '';
    const detail  = action.surplusW !== undefined
      ? ` surplus: ${action.surplusW.toFixed(0)}W${rawAStr}`
      : action.powerW !== undefined
        ? ` power: ${action.powerW}W`
        : '';

    this.app.log(
      `[EvCtrl] ${status} | ${action.type}/${action.reason}${detail} | ` +
      `mode: ${mode} | target: ${this._currentTargetA}A`
    );
  }

}

module.exports = EvChargeController;
