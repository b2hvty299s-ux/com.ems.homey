'use strict';

class FlowManager {
  constructor(app) { this.app = app; this.homey = app.homey; }

  async init() {
    this._registerTriggers();
    this._registerConditions();
    this._registerActions();
    this.app.log('[Flow] Flow cards registered');
  }

  _registerTriggers() {
    const trigger = (id) => this.homey.flow.getTriggerCard(id);

    this.homey.on('ems:modeChanged',          mode    => trigger('ems_mode_changed').trigger({ mode }));
    this.homey.on('ems:prio1NotFeasible',     ()      => trigger('prio1_not_feasible').trigger());
    this.homey.on('ems:evReadyForDeparture',  data    => trigger('ev_ready_for_departure').trigger(data));
    this.homey.on('ems:batteryBelowMinimum',  data    => trigger('battery_below_minimum').trigger(data));
    this.homey.on('ems:dumpLoadActivated',    ()      => trigger('dump_load_activated').trigger());
    this.homey.on('ems:dumpLoadDeactivated',  ()      => trigger('dump_load_deactivated').trigger());
    this.homey.on('ems:heatpumpModeChanged',  mode    => trigger('heatpump_mode_switched').trigger({ mode }));

    // EV charge control — user wires these trigger cards to Tesla flow actions
    // "When EMS wants to set EV charge current [current A] → Tesla: Stel laadstroom in op [current]"
    this.homey.on('ems:setEvChargeCurrent',   amps    => trigger('ev_set_charge_current').trigger({ current: amps }));
    // "When EMS wants to start/stop EV charging [enabled] → Tesla: Laden [aan/uit]"
    this.homey.on('ems:setEvChargingOn',      enabled => trigger('ev_set_charging_on').trigger({ enabled }));
  }

  _registerConditions() {
    this.homey.flow.getConditionCard('ems_mode_is')
      .registerRunListener(async (args) => this.app.ems.getMode() === args.mode);

    this.homey.flow.getConditionCard('battery_soc_above')
      .registerRunListener(async (args) => {
        const state = this.app.ems.getPublicState();
        return (state.batSoc ?? 0) >= args.threshold;
      });

    this.homey.flow.getConditionCard('trip_planned_today')
      .registerRunListener(async () => {
        const trip = this.app.ems.tripPlanner?.getActiveTrip();
        if (!trip) return false;
        const dep   = new Date(trip.departureTime);
        const today = new Date();
        return dep.toDateString() === today.toDateString();
      });

    this.homey.flow.getConditionCard('heatpump_in_mode')
      .registerRunListener(async (args) =>
        this.app.ems.thermostat?.getMode() === args.mode);

    this.homey.flow.getConditionCard('solar_producing')
      .registerRunListener(async () => {
        const state = this.app.ems.getPublicState();
        return (state.pvW ?? 0) > 0;
      });
  }

  _registerActions() {
    this.homey.flow.getActionCard('set_ems_mode')
      .registerRunListener(async (args) => this.app.ems.setMode(args.mode));

    this.homey.flow.getActionCard('set_ev_charge_profile')
      .registerRunListener(async (args) => {
        this.app.ems.evController?.setSetting('mode', args.mode);
      });

    this.homey.flow.getActionCard('set_ev_fixed_current')
      .registerRunListener(async (args) => {
        this.app.ems.evController?.setSetting('fixed', args.current_a);
      });

    this.homey.flow.getActionCard('set_ev_max_current')
      .registerRunListener(async (args) => {
        this.app.ems.evController?.setSetting('max', args.current_a);
      });

    this.homey.flow.getActionCard('plan_ev_trip')
      .registerRunListener(async (args) => {
        await this.app.ems.tripPlanner.setTrip(args.departure_time, args.target_soc);
        await this.app.ems.planningEngine.recalculate('trip_flow');
      });

    this.homey.flow.getActionCard('recalculate_plan')
      .registerRunListener(async () =>
        this.app.ems.planningEngine.recalculate('flow_action'));

    this.homey.flow.getActionCard('set_battery_target_soc')
      .registerRunListener(async (args) => {
        const soc = Math.min(100, Math.max(1, args.soc));
        this.homey.settings.set('battery_target_soc', soc);
      });

    this.homey.flow.getActionCard('set_dump_load')
      .registerRunListener(async (args) =>
        this.homey.emit('ems:dumpLoadOverride', args.enabled));

  }
}

module.exports = FlowManager;
