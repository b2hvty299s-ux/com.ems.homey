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

const PLAN_HOUR = 22; // hour of day to recalculate (22:00)

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

    this._scheduleDailyRecalc();
    this.app.log('[Planning] Engine ready, daily recalc at 22:00');
  }

  destroy() {
    if (this._timer) { this.homey.clearTimeout(this._timer); this._timer = null; }
  }

  getCurrentPlan() { return this._plan; }

  // ─── Plan calculation ─────────────────────────────────────────────────────

  async recalculate(reason = 'scheduled') {
    this.app.log(`[Planning] Recalculating day plan (reason: ${reason})...`);

    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

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
      const pvCurve  = this.pvCurve.generateCurveFromForecast(forecast, 'tomorrow');
      const pvHourly = pvCurve.map(h => ({ hour: h.hour, pvKwh: h.expectedKw }));
      const totalPvKwh = pvHourly.reduce((s, h) => s + h.pvKwh, 0);

      // 4. Expected consumption (from learner, kWh per hour)
      const dow = tomorrow.getDay();
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

      if (evConfig) {
        const evCtrl = this.app.ems.evController;
        if (evCtrl) {
          const evSettings = evCtrl.getSettings();
          // Fixed mode: EV load is predictable
          if (evSettings.mode === 'fixed') {
            evFixedKwhPerHour = evSettings.fixedPowerW / 1000;
          }
        }

        if (trip) {
          const currentSoc = await this._getEvSoc();
          const targetSoc  = trip.targetSoc;
          evNeededKwh = Math.max(0, evConfig.capacityKwh * (targetSoc - currentSoc) / 100);
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

      // 10. Thermostat mode for tomorrow
      const nightMin     = forecast.tonight.nightMin;
      const tomorrowMax  = forecast.tomorrow.dayMax;
      const hpMode       = this.app.ems.thermostat
        ? this.app.ems.thermostat.evaluateMode(nightMin, tomorrowMax)
        : 'heating';

      // 11. Assemble plan
      // Derived charge/discharge durations
      const hoursToFull  = batMaxChargeKw   > 0 ? +Math.max(0, (batMaxKwh - batAvailKwh) / batMaxChargeKw).toFixed(1)   : null;
      const hoursToEmpty = batMaxDischargeKw > 0 ? +Math.max(0, (batAvailKwh - batMinKwh) / batMaxDischargeKw).toFixed(1) : null;

      this._plan = {
        date:           tomorrow.toISOString().substring(0, 10),
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

      // Deficit: discharge battery if above minimum
      if (netKwh < -0.05) {
        // Cap by both available energy and max discharge rate
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

      // EV must charge before departure
      if (trip && !evAction && evNeededKwh > evCharged) {
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
        dumpLoad:   dumpAction,
        priceEur:   price?.price ?? null,
        isCheap,
        isExpensive,
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

  _scheduleDailyRecalc() {
    const now        = new Date();
    const nextRun    = new Date();
    nextRun.setHours(PLAN_HOUR, 0, 0, 0);
    if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);

    const msUntil = nextRun - now;
    this.app.log(`[Planning] Next scheduled recalc in ${Math.round(msUntil / 60000)} minutes`);

    this._timer = this.homey.setTimeout(async () => {
      await this.recalculate('scheduled');
      this._scheduleDailyRecalc(); // reschedule for next day
    }, msUntil);
  }

}

module.exports = PlanningEngine;
