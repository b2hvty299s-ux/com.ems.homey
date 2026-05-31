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

    const notify = (msg) => this.app.notifications?.send(msg);

    this.homey.on('ems:modeChanged',          mode    => trigger('ems_mode_changed').trigger({ mode }));
    this.homey.on('ems:prio1NotFeasible',     ()      => { trigger('prio1_not_feasible').trigger(); notify('⚠️ EMS: Dagplan krap — onvoldoende zon voor alle prioriteiten'); });
    this.homey.on('ems:evReadyForDeparture',  data    => { trigger('ev_ready_for_departure').trigger(data); notify(`✅ EV klaar voor vertrek — ${data.soc?.toFixed(0) ?? '?'}% geladen`); });
    this.homey.on('ems:batteryBelowMinimum',  data    => { trigger('battery_below_minimum').trigger(data); notify(`🔋 Thuisaccu onder minimum — ${data.soc?.toFixed(0) ?? '?'}% SoC`); });
    this.homey.on('ems:dumpLoadActivated',    ()      => trigger('dump_load_activated').trigger());
    this.homey.on('ems:dumpLoadDeactivated',  ()      => trigger('dump_load_deactivated').trigger());
    this.homey.on('ems:heatpumpModeChanged',  mode    => { trigger('heatpump_mode_switched').trigger({ mode }); notify(`🌡️ Warmtepomp omgeschakeld naar ${mode === 'cooling' ? 'koelen' : 'verwarmen'}`); });

    // EV charging started/stopped
    this.homey.on('ems:evChargingStarted',    data    => notify(`🚗 EV laden gestart — ${data.powerW ? Math.round(data.powerW) + 'W' : '5A'} zonnestroom`));
    this.homey.on('ems:evChargingStopped',    data    => { const kwh = data.sessionKwh?.toFixed(1); notify(`🔌 EV laden gestopt${kwh ? ` — ${kwh} kWh geladen` : ''}`); });

    // EV charge control — user wires these trigger cards to Tesla flow actions
    // "When EMS wants to set EV charge current [current A] → Tesla: Stel laadstroom in op [current]"
    this.homey.on('ems:setEvChargeCurrent',   amps    => trigger('ev_set_charge_current').trigger({ current: amps }));
    // Two separate triggers for start and stop — simpler than a boolean token
    // "When EMS wants to start EV charging → Tesla: Start het opladen"
    // "When EMS wants to stop EV charging  → Tesla: Stop het opladen"
    this.homey.on('ems:setEvChargingOn', enabled => {
      if (enabled) trigger('ev_start_charging').trigger();
      else         trigger('ev_stop_charging').trigger();
      // Also keep the old combined trigger for backwards compat
      trigger('ev_set_charging_on').trigger({ enabled });
    });
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

    // Load-balance postpone — triggered when phase current is too high.
    // Duration is read from the 'ev_postpone_minutes' app setting (default 30).
    this.homey.flow.getActionCard('postpone_ev_charging')
      .registerRunListener(async () => {
        const minutes = this.homey.settings.get('ev_postpone_minutes') ?? 30;
        this.app.ems.evController?.postponeCharging(minutes);
        return true;
      });

  }
}

module.exports = FlowManager;
