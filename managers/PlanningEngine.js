'use strict';

/**
 * PlanningEngine
 * ──────────────
 * Every evening at 22:00, calculates the energy plan for tomorrow.
 * Also called on-demand when a trip is planned or manually triggered.
 *
 * Output: hourly schedule with:
 *   - Expected PV production per hour (kWh)
 *   - Expected consumption per hour (kWh)
 *   - Battery charge/discharge plan
 *   - EV charge window
 *   - Thermostat mode
 *   - Prio 1/2/3 activation windows
 *   - Surplus or deficit per hour
 */

// Scheduled recalculation moments:
//   04:00 — fresh morning forecast for TODAY  (start of day with latest data)
//   12:00 — midday update for TODAY           (cloud cover re-assessed)
//   19:00 — evening forecast for TOMORROW     (plan the next day early)
//   22:00 — final plan for TOMORROW           (classic end-of-day plan)
const SCHEDULES = [
  { hour:  4, target: 'today',    reason: 'morning_update' },
  { hour: 12, target: 'today',    reason: 'midday_update'  },
  { hour: 19, target: 'tomorrow', reason: 'evening_plan'   },
  { hour: 22, target: 'tomorrow', reason: 'scheduled'      },
];

class PlanningEngine {

  constructor(app) {
    this.app          = app;
    this.homey        = app.homey;
    this._plan        = null;
    this._timer       = null;
  }

  init({ pvCurve, openMeteo, dayAheadPrices, consumptionLearner, tripPlanner, config }) {
    this.pvCurve           = pvCurve;
    this.openMeteo         = openMeteo;
    this.dayAheadPrices    = dayAheadPrices;
    this.consumptionLearner = consumptionLearner;
    this.tripPlanner       = tripPlanner;
    this.config            = config;

    this._scheduleNextRecalc();
    this.app.log('[Planning] Engine ready — recalc at 04:00(today), 12:00(today), 19:00(tomorrow), 22:00(tomorrow)');

    // Always recalculate on startup — determines target based on current time
    const startupTarget = new Date().getHours() >= 19 ? 'tomorrow' : 'today';
    this.app.log(`[Planning] Startup recalc (target: ${startupTarget})...`);
    this.recalculate('startup', startupTarget).catch(e =>
      this.app.error('[Planning] Startup recalc error:', e)
    );
  }

  destroy() {
    if (this._timer) { this.homey.clearTimeout(this._timer); this._timer = null; }
  }

  getCurrentPlan() { return this._plan; }

  // ─── Plan calculation ─────────────────────────────────────────────────────

  async recalculate(reason = 'scheduled', target = 'tomorrow') {
    this.app.log(`[Planning] Recalculating day plan (reason: ${reason}, target: ${target})...`);

    try {
      const targetDate = new Date();
      if (target === 'tomorrow') targetDate.setDate(targetDate.getDate() + 1);
      // 'today' keeps targetDate as today

      // 1. Fetch external data — individual catches so one failure doesn't abort the plan
      const [forecast, prices] = await Promise.all([
        this.openMeteo.getForecast().catch(err => {
          this.app.error('[Planning] Weather API failed, using fallback:', err.message);
          return this.openMeteo._fallback();
        }),
        this.dayAheadPrices
          ? this.dayAheadPrices.getTomorrowPrices().catch(err => {
              this.app.error('[Planning] Day-ahead prices API failed:', err.message);
              return null;
            })
          : null,
      ]);

      // 3. PV production curve (kWh per hour) — uses Open-Meteo radiation directly
      //    Cloud correction is already embedded in the shortwave_radiation values.
      const pvCurve  = this.pvCurve.generateCurveFromForecast(forecast, target);
      const pvHourly = pvCurve.map(h => ({ hour: h.hour, pvKwh: h.expectedKw }));
      const totalPvKwh = pvHourly.reduce((s, h) => s + h.pvKwh, 0);

      // 4. Expected consumption (from learner, kWh per hour)
      const dow = targetDate.getDay();
      const consumptionHourly = await this.consumptionLearner.getExpectedHourly(dow);
      const totalConsumptionKwh = consumptionHourly.reduce((s, h) => s + h.expectedKwh, 0);

      // 5. Battery params
      const batState    = await this.app.ems.battery.getState();
      const batCapKwh   = batState.totalCapacityKwh;
      // Battery manages its own SoC limits; for planning we use capacity from settings
      const batCapFromSettings = this.homey.settings.get('bat_capacity_kwh') ?? batCapKwh ?? 5;
      const batAvailKwh = batState.availableKwh;
      // Planning estimates: assume battery can absorb up to 90% and discharge down to 20%
      const batMaxKwh   = batCapFromSettings * 0.90;
      const batMinKwh   = batCapFromSettings * 0.20;
      // Max charge/discharge rate (kW) — limits how much can be moved per hour
      const batCfg          = this.config?.batteries?.[0];
      const batMaxChargeKw  = (batCfg?.maxChargeW  ?? this.homey.settings.get('bat_max_charge_w')  ?? 2500) / 1000;
      const batMaxDischargeKw = (batCfg?.maxDischargeW ?? this.homey.settings.get('bat_max_discharge_w') ?? 2500) / 1000;

      // 6. EV trip + charge profile
      const trip = this.tripPlanner ? this.tripPlanner.getActiveTrip() : null;
      const evConfig = this.config?.ev;
      let evNeededKwh = 0;
      let evFixedKwhPerHour = null; // set when mode is 'fixed' — planning uses it as constant

      // Fixed EV charge power for plan visualisation (strategy B: always 5A minimum)
      const evMinA      = this.homey.settings.get('ev_min_current_a') ?? 5;
      const evPhases    = evConfig?.phases ?? 3;
      const evMinPowerW = evMinA * evPhases * 230;  // W at minimum current
      const evMinKwhPerH = evMinPowerW / 1000;       // kWh per hour at min current

      if (evConfig) {
        const evCtrl = this.app.ems.evController;
        if (evCtrl) {
          const evSettings = evCtrl.getSettings();
          // Fixed mode: EV load is predictable
          if (evSettings.mode === 'fixed') {
            evFixedKwhPerHour = evSettings.fixedPowerW / 1000;
          }
        }

        const currentSoc = await this._getEvSoc();
        if (trip) {
          // Trip planned: charge to trip's target SoC
          evNeededKwh = Math.max(0, evConfig.capacityKwh * (trip.targetSoc - currentSoc) / 100);
        } else {
          // No trip: still plan to top up to default SoC from solar surplus.
          // This ensures the plan shows EV charging during sunny hours even without a trip.
          const defaultSoc = this.homey.settings.get('ev_default_soc') ?? 80;
          evNeededKwh = Math.max(0, evConfig.capacityKwh * (defaultSoc - currentSoc) / 100);
        }
      }

      // 7. Balance
      const netKwh       = totalPvKwh - totalConsumptionKwh;
      const canFillBatKwh = batMaxKwh - batAvailKwh;
      const surplusAfterBat = netKwh - canFillBatKwh;

      // 8. Prio feasibility
      const prio1Loads = this._calcPrio1Kwh(evNeededKwh, batMinKwh, batAvailKwh);
      const prio2Loads = this._calcPrio2Kwh(canFillBatKwh, evConfig);
      const prio1Feasible = totalPvKwh + batAvailKwh >= prio1Loads;

      // 9. Build hourly schedule
      const schedule = this._buildHourlySchedule({
        pvHourly, consumptionHourly, prices,
        batAvailKwh, batMaxKwh, batMinKwh,
        batCapKwh: batCapKwh ?? batCapFromSettings, // fallback if adapter doesn't expose totalCapacityKwh
        batMaxChargeKw, batMaxDischargeKw,
        evNeededKwh, evFixedKwhPerHour, trip, evConfig,
        surplusAfterBat,
      });

      // 10. Thermostat mode
      const nightMin    = forecast.tonight?.nightMin ?? 10;
      const targetDayMax = target === 'today'
        ? (forecast.today?.dayMax ?? 15)
        : (forecast.tomorrow?.dayMax ?? 15);
      const hpMode       = this.app.ems.thermostat
        ? this.app.ems.thermostat.evaluateMode(nightMin, targetDayMax)
        : 'heating';

      // 11. Assemble plan
      // Derived charge/discharge durations
      const hoursToFull  = batMaxChargeKw   > 0 ? +Math.max(0, (batMaxKwh - batAvailKwh) / batMaxChargeKw).toFixed(1)   : null;
      const hoursToEmpty = batMaxDischargeKw > 0 ? +Math.max(0, (batAvailKwh - batMinKwh) / batMaxDischargeKw).toFixed(1) : null;

      this._plan = {
        date:           targetDate.toISOString().substring(0, 10),
        target,
        calculatedAt:   new Date().toISOString(),
        reason,
        summary: {
          totalPvKwh:         +totalPvKwh.toFixed(2),
          totalConsumptionKwh: +totalConsumptionKwh.toFixed(2),
          netKwh:             +netKwh.toFixed(2),
          evNeededKwh:        +evNeededKwh.toFixed(2),
          batAvailKwh:        +batAvailKwh.toFixed(2),
          batMaxChargeKw:     +batMaxChargeKw.toFixed(2),
          batMaxDischargeKw:  +batMaxDischargeKw.toFixed(2),
          hoursToFull,       // how long to fully charge from current SoC at max charge rate
          hoursToEmpty,      // how long to fully discharge from current SoC at max discharge rate
          prio1Feasible,
          hpMode,
          hasCheapHours:      prices ? prices.some(p => p.isCheap) : false,
        },
        schedule,
      };

      this.app.log(`[Planning] Plan ready: PV ${totalPvKwh.toFixed(1)} kWh, consumption ${totalConsumptionKwh.toFixed(1)} kWh, net ${netKwh.toFixed(1)} kWh`);

      // Trigger Flow if prio 1 not feasible
      if (!prio1Feasible) {
        this.homey.emit('ems:prio1NotFeasible', this._plan.summary);
      }

      return this._plan;
    } catch (err) {
      this.app.error('[Planning] recalculate error:', err);
      return null;
    }
  }

  // ─── Hourly schedule builder ──────────────────────────────────────────────

  _buildHourlySchedule({ pvHourly, consumptionHourly, prices, batAvailKwh, batMaxKwh,
                          batMinKwh, batCapKwh, batMaxChargeKw, batMaxDischargeKw,
                          evNeededKwh, evFixedKwhPerHour,
                          trip, evConfig, surplusAfterBat }) {
    const schedule = [];
    let batKwh     = batAvailKwh;
    let evCharged  = 0;
    const isDynamic = this.homey.settings.get('contract_type') === 'dynamic';

    // Solar-first: if total PV can cover EV needs + expected consumption, don't force
    // night/deadline charging — wait for solar surplus instead.
    const totalPvKwh      = pvHourly.reduce((s, h) => s + (h.pvKwh ?? 0), 0);
    const totalConsumKwh  = consumptionHourly.reduce((s, h) => s + (h.expectedKwh ?? 0), 0);
    const solarCoversEv   = evNeededKwh > 0 &&
                            (totalPvKwh - totalConsumKwh) >= evNeededKwh;

    for (let h = 0; h < 24; h++) {
      const pvKwh      = pvHourly[h]?.pvKwh           ?? 0;
      const consumKwh  = consumptionHourly[h]?.expectedKwh ?? 0;
      const price      = prices ? prices.find(p => p.hour === h) : null;
      const isCheap    = price ? price.isCheap : true;
      const isExpensive = isDynamic && price ? price.isExpensive : false;

      // If EV is in fixed mode, treat it as a known house load during car-home hours
      const evIsHome   = this._isEvHome(h, evConfig);
      const evFixedLoad = (evFixedKwhPerHour && evIsHome) ? evFixedKwhPerHour : 0;

      let netKwh     = pvKwh - consumKwh - evFixedLoad;
      let batAction  = 'idle';    // 'charge' | 'discharge' | 'idle'
      let evAction   = false;
      let dumpAction = false;
      let batDelta   = 0;

      // Surplus: charge battery, then EV, then dump
      if (netKwh > 0 && !isExpensive) {
        // Cap by both available headroom and max charge rate (kW = kWh over 1 hour)
        const canCharge = Math.min(netKwh, batMaxKwh - batKwh, batMaxChargeKw ?? Infinity);
        if (canCharge > 0.05) {
          batAction = 'charge';
          batDelta  = canCharge;
          batKwh    = Math.min(batMaxKwh, batKwh + canCharge);
          netKwh   -= canCharge;
        }

        // Remaining surplus → EV
        if (netKwh > 0 && evNeededKwh > evCharged && evConfig) {
          evAction  = true;
          evCharged = Math.min(evNeededKwh, evCharged + netKwh);
          netKwh    = 0;
        }

        // Still surplus → dump load (prio 3)
        if (netKwh > 0.1) {
          dumpAction = true;
        }
      }

      // Deficit: discharge battery — but NOT during solar hours when EV is also charging.
      //
      // When the EV is active and there is expected PV production, a deficit is a
      // cloud dip: the solar will return and the EV should keep using it at 5A.
      // Discharging the battery at the same time would deplete it needlessly and
      // take away capacity needed for the evening.
      //
      // When the EV is NOT charging, the battery may discharge as normal to cover
      // house consumption even during solar hours (e.g. a very cloudy morning).
      const isSolarHour = pvKwh >= 0.1;
      const blockDischarge = isSolarHour && evAction;   // cloud-dip guard: solar + EV charging
      if (netKwh < -0.05 && !blockDischarge) {
        const canDischarge = Math.min(Math.abs(netKwh), batKwh - batMinKwh, batMaxDischargeKw ?? Infinity);
        if (canDischarge > 0.05) {
          batAction = 'discharge';
          batDelta  = -canDischarge;
          batKwh    = Math.max(batMinKwh, batKwh - canDischarge);
          netKwh   += canDischarge;
        }
      }

      // Cheap grid hour + battery not full → charge from grid (dynamic only)
      if (isDynamic && isCheap && pvKwh < 0.1 && batKwh < batMaxKwh) {
        batAction = 'grid_charge';
        // Also cap grid charging by max charge rate
        batDelta  = Math.min(batMaxChargeKw ?? 0.5, batMaxKwh - batKwh);
        batKwh   += batDelta;
      }

      // EV must charge before departure — but only if solar won't cover it.
      // When solarCoversEv=true we trust the surplus hours to do the job;
      // forced night charging only kicks in when the sun really can't deliver enough.
      if (trip && !evAction && evNeededKwh > evCharged && !solarCoversEv) {
        const depH = new Date(trip.departureTime).getHours();
        const hoursLeft = depH - h;
        if (hoursLeft <= 3 && isCheap) {
          evAction  = true;
          evCharged += 0.5; // estimate
        }
      }

      schedule.push({
        hour:       h,
        pvKwh:      +pvKwh.toFixed(3),
        consumKwh:  +consumKwh.toFixed(3),
        netKwh:     +netKwh.toFixed(3),
        batAction,
        batDeltaKwh: +batDelta.toFixed(3),
        batSocPct:  +(batKwh / batCapKwh * 100).toFixed(1),
        evCharging: evAction,
        evPowerW:   evAction ? evMinPowerW : 0,  // flat block at min current (strategy B)
        dumpLoad:   dumpAction,
        priceEur:   price?.price ?? null,
        isCheap,
        isExpensive,
        isSolarHour: pvKwh >= 0.1,
      });
    }

    return schedule;
  }

  // ─── Prio calculations ────────────────────────────────────────────────────

  _isEvHome(hour, evConfig) {
    if (!evConfig) return false;
    const dow = new Date().getDay(); // tomorrow's dow
    const isWeekend = dow === 0 || dow === 6;
    if (isWeekend && evConfig.homeWeekend) return true;
    const homeFromH = evConfig.homeWeekday
      ? parseInt(evConfig.homeWeekday.split(':')[0])
      : 17;
    return hour >= homeFromH;
  }

  _calcPrio1Kwh(evNeededKwh, batMinKwh, batAvailKwh) {
    const batDeficit = Math.max(0, batMinKwh - batAvailKwh);
    return evNeededKwh + batDeficit;
  }

  _calcPrio2Kwh(canFillBatKwh, evConfig) {
    const evExtra = evConfig ? evConfig.capacityKwh * 0.2 : 0; // 20% buffer
    return canFillBatKwh + evExtra;
  }

  async _getEvSoc() {
    try {
      if (this.app.ems.tesla) {
        const state = await this.app.ems.tesla.getState();
        return state.soc ?? 50;
      }
    } catch (_) {}
    return 50;
  }

  // ─── Scheduling ───────────────────────────────────────────────────────────

_scheduleNextRecalc() {
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // Find the next scheduled slot (today or tomorrow)
    let nextSlot = null;
    let msUntil  = Infinity;

    for (const slot of SCHEDULES) {
      const slotMinutes = slot.hour * 60;
      let diff = (slotMinutes - nowMinutes) * 60_000 - now.getSeconds() * 1000;
      if (diff <= 0) diff += 24 * 60 * 60_000; // schedule for tomorrow if already past
      if (diff < msUntil) {
        msUntil  = diff;
        nextSlot = slot;
      }
    }

    if (!nextSlot) return;

    this.app.log(
      `[Planning] Next recalc: ${String(nextSlot.hour).padStart(2,'0')}:00 ` +
      `(${nextSlot.target}, ${Math.round(msUntil / 60000)} min)`
    );

    if (this._timer) this.homey.clearTimeout(this._timer);
    this._timer = this.homey.setTimeout(async () => {
      await this.recalculate(nextSlot.reason, nextSlot.target);
      this._scheduleNextRecalc(); // schedule next slot
    }, msUntil);
  }

}

module.exports = PlanningEngine;
