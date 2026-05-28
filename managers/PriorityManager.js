'use strict';

/**
 * PriorityManager
 * ───────────────
 * Called every EMS tick. Decides which devices get energy and in what order.
 *
 * Priority layers:
 *
 *   Prio 1 — Critical (must always be satisfied)
 *     - Battery above minimum SoC
 *     - EV trip deadline (ensure car is charged before departure)
 *
 *   Prio 2 — Desired (when enough solar is available)
 *     - Battery to target SoC
 *     - EV standard charging
 *     - Thermostat offset (heat pump boost/reduce)
 *
 *   Prio 3 — Dump load (only when prio 1+2 fully satisfied AND surplus remains)
 *     - Hot water boiler, extra heating, etc.
 *
 * Decision flow each tick:
 *   1. Read current state (PV, grid, battery, EV)
 *   2. Calculate available surplus after house load
 *   3. Allocate surplus to prio 1 first, then 2, then 3
 *   4. Issue commands to adapters
 *   5. Emit events when transitions happen
 *
 * The EmsManager calls this after it has followed the day plan.
 * PriorityManager acts as a real-time safety net and surplus allocator.
 */

const SURPLUS_THRESHOLD_W = 200; // W — minimum to consider "surplus"

class PriorityManager {

  constructor(app) {
    this.app   = app;
    this.homey = app.homey;
    this._dumpActive = false;
  }

  init(config) {
    this._surplusThreshold = config.surplusThreshold ?? SURPLUS_THRESHOLD_W;
    this.app.log('[Priority] Manager ready');
  }

  /**
   * Main evaluation — called every tick by EmsManager.
   * @param {object} state   current EMS state from _readState()
   * @param {object} planSlot current hour's plan (may be null)
   */
  async evaluate(state, planSlot) {
    const ems = this.app.ems;

    // ── Prio 1: Battery minimum ──────────────────────────────────────────
    const minSoc    = this.homey.settings.get('battery_min_soc') ?? 20;
    const batCritical = state.batSoc < minSoc;

    if (batCritical) {
      this.app.log(`[Priority] Prio 1: battery critical (${state.batSoc.toFixed(0)}% < ${minSoc}%)`);
      await ems.battery.setCharging(true);
      await ems.battery.setDischarging(false);
      // Suspend EV and dump load during critical battery recovery
      if (ems.evController) await ems.tesla?.stopCharging?.();
      if (ems.dumpLoad)     await ems.dumpLoad.deactivate();
      return; // prio 1 takes full control
    }

    // ── Prio 1: EV trip deadline ─────────────────────────────────────────
    if (ems.tripPlanner) {
      const trip = ems.tripPlanner.getActiveTrip();
      if (trip) {
        const hoursLeft  = ems.tripPlanner.getHoursUntilDeparture();
        const evSoc      = state.evSoc ?? 50;
        const neededKwh  = ems.tripPlanner.getNeededKwh(evSoc);

        ems.tripPlanner.checkReadiness(evSoc);

        if (hoursLeft <= 2 && neededKwh > 0.5) {
          this.app.log(`[Priority] Prio 1: EV trip deadline — ${hoursLeft.toFixed(1)}h left, need ${neededKwh.toFixed(1)} kWh`);
          // Trip deadline forces fast charge regardless of surplus
          await ems.evController?.tesla?.setChargeCurrent(ems.evController._maxCurrentA);
        }
      }
    }

    // ── Calculate surplus after house load and prio 1 battery ────────────
    // gridW negative = exporting = surplus available
    const surplusW = Math.max(0, -(state.gridW ?? 0));
    const hasSurplus = surplusW > this._surplusThreshold;

    // ── Prio 2: Battery to target ────────────────────────────────────────
    const targetSoc = this.homey.settings.get('battery_target_soc') ?? 90;
    if (hasSurplus && state.batSoc < targetSoc) {
      // Battery charging is handled by EmsManager following the plan
      // Here we just ensure it's active when there's surplus and battery needs it
    }

    // ── Prio 2: Thermostat offset ────────────────────────────────────────
    if (ems.thermostat) {
      const energyState = hasSurplus ? 'surplus'
        : surplusW < -this._surplusThreshold ? 'deficit'
        : 'normal';
      await ems.thermostat.applyOffset(energyState);
    }

    // ── Prio 3: Dump load ────────────────────────────────────────────────
    if (ems.dumpLoad) {
      // Activate dump load only when:
      // - Battery is at or near target SoC (prio 2 satisfied)
      // - There is still meaningful surplus
      // - No trip deadline pressure
      const batReady    = state.batSoc >= targetSoc - 5;
      const tripUrgent  = this._isTripUrgent();
      const shouldDump  = hasSurplus && batReady && !batCritical && !tripUrgent;

      if (shouldDump && !this._dumpActive) {
        this._dumpActive = true;
        await ems.dumpLoad.activate();
      } else if (!shouldDump && this._dumpActive) {
        this._dumpActive = false;
        await ems.dumpLoad.deactivate();
      }
    }

    this.app.log(
      `[Priority] surplus: ${surplusW.toFixed(0)}W | bat: ${state.batSoc.toFixed(0)}% | ` +
      `dump: ${this._dumpActive ? 'ON' : 'off'}`
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _isTripUrgent() {
    const trip = this.app.ems.tripPlanner?.getActiveTrip();
    if (!trip) return false;
    const hoursLeft = this.app.ems.tripPlanner.getHoursUntilDeparture();
    return (hoursLeft ?? 99) <= 3;
  }

}

module.exports = PriorityManager;
