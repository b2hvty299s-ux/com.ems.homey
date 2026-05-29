'use strict';

/**
 * TeslaEvAdapter
 * ──────────────
 * Dual-source EV management for Tesla + Gen 3 Wall Connector.
 *
 * READING  → Wall Connector local REST API (http://[ip]/api/1/vitals)
 *            Realtime, local, no rate limits, no cloud dependency.
 *            Falls back to Homey Tesla app capabilities if no Wall Connector IP set.
 *
 * COMMANDS → Tesla Homey app (com.tesla.car) device capabilities.
 *            Rate limited: max ~50 commands/day → we enforce min 10 min between commands.
 *
 * Wall Connector /api/1/vitals response:
 *   vehicle_connected    boolean  — cable plugged in
 *   contactor_closed     boolean  — relay closed = actively charging
 *   vehicle_current_a    number   — current flowing to car (A)
 *   currentA/B/C_a       number   — per-phase current (A)
 *   voltageA/B/C_v       number   — per-phase voltage (V)
 *   session_energy_wh    number   — energy delivered this session (Wh)
 *   evse_state           number   — see EVSE_STATES below
 *   grid_v               number   — grid voltage (V)
 *   grid_hz              number   — grid frequency (Hz)
 *
 * EVSE state codes (reverse engineered):
 *   1  = booting
 *   2  = not connected
 *   4  = connected, not charging (waiting)
 *   6  = charging
 *   7  = charging (reduced current)
 *   8  = fault
 *   9  = charging complete
 *   11 = negotiating
 */

const EVSE_STATES = {
  1:  'booting',
  2:  'disconnected',
  4:  'connected_idle',
  6:  'charging',
  7:  'charging_reduced',
  8:  'fault',
  9:  'complete',
  11: 'negotiating',
};

const MIN_COMMAND_INTERVAL_MS      = 3 * 60 * 1000;  // 3 min — start/stop (was 10 min, reduced)
const MIN_CURRENT_ADJUST_INTERVAL  = 2 * 60 * 1000;  // 2 min — set_charge_amps (car already awake)
const WC_POLL_URL             = (ip) => `http://${ip}/api/1/vitals`;

class TeslaEvAdapter {

  constructor(app) {
    this.app   = app;
    this.homey = app.homey;

    // Config
    this._wallConnectorIp  = null;  // local IP of Wall Connector Gen 3
    this._teslaDeviceId    = null;  // Homey device ID for Tesla car
    this._chargerDeviceId  = null;  // Homey device ID for the charger (laadpaal)
    this._evPhases         = 3;
    this._maxCurrentA      = 16;
    this._capacityKwh      = 75;
    this._defaultSocPct    = 80;
    this._chargerCapsLogged  = false;
    this._teslaCapsLogged    = false;

    // State
    this._lastVitals            = null;
    this._lastCommandTime       = 0;
    this._lastCurrentAdjustTime = 0;    // separate timer for set_charge_amps
    this._lastChargerPowerW     = 0;    // last measured EV charge power (W)
    this._vehiclePresent        = true; // assume present until charger says otherwise
    this._isChargingByEms       = false; // did EMS start this session?
    this._commandQueue          = null;  // pending command if rate limited
    this._chargingStartFired    = false;
    this._chargingStopFired     = false;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  init(config) {
    this._wallConnectorIp = config.wallConnectorIp  || null;
    this._teslaDeviceId   = config.ev?.deviceId     || null;
    this._chargerDeviceId = config.ev?.chargerId    || null;
    this._evPhases        = config.ev?.phases        ?? 3;
    this._maxCurrentA     = config.ev?.maxAmps       ?? 16;
    this._capacityKwh     = config.ev?.capacityKwh   ?? 75;
    this._defaultSocPct   = config.ev?.defaultSoc    ?? 80;

    if (this._wallConnectorIp) {
      this.app.log(`[Tesla] Wall Connector at ${this._wallConnectorIp}`);
    } else if (this._chargerDeviceId) {
      this.app.log(`[Tesla] Reading charger from Homey device: ${this._chargerDeviceId}`);
    } else {
      this.app.log('[Tesla] No Wall Connector IP — falling back to Homey Tesla app only');
    }
  }

  // ─── State reading ────────────────────────────────────────────────────────

  /**
   * Returns current EV state from Wall Connector (preferred) or Tesla Homey app.
   * Call this every EMS tick (60s).
   */
  async getState() {
    const [vitals, teslaState, chargerState] = await Promise.all([
      this._getWallConnectorVitals(),
      this._getTeslaAppState(),
      this._getChargerDeviceState(),
    ]);

    // Prefer Wall Connector data for power readings (no rate limit)
    const connected = vitals?.vehicle_connected
      ?? chargerState?.connected
      ?? teslaState?.connected
      ?? false;

    const charging = vitals
      ? [6, 7, 11].includes(vitals.evse_state)
      : chargerState?.charging
        ?? teslaState?.charging
        ?? false;

    // Power priority: 1) Wall Connector local API  2) Charger Homey device  3) calculated
    let powerW  = 0;
    let currentA = 0;
    let source  = 'tesla_app';

    if (vitals && charging) {
      source = 'wall_connector';
      if (this._evPhases === 3) {
        powerW = (
          (vitals.currentA_a * vitals.voltageA_v) +
          (vitals.currentB_a * vitals.voltageB_v) +
          (vitals.currentC_a * vitals.voltageC_v)
        );
      } else {
        powerW = vitals.vehicle_current_a * (vitals.grid_v || 230);
      }
      currentA = vitals.vehicle_current_a ?? 0;
    } else if (chargerState?.powerW > 0) {
      source   = 'charger_device';
      powerW   = chargerState.powerW;
      currentA = chargerState.currentA ?? 0;
    }

    const state = {
      connected,
      charging,
      powerW:     Math.max(0, powerW),
      currentA,
      sessionKwh: (vitals?.session_energy_wh ?? chargerState?.sessionKwh ?? 0),
      evseState:  EVSE_STATES[vitals?.evse_state] ?? (chargerState?.evseState ?? 'unknown'),
      soc:        teslaState?.soc ?? null,
      source,
    };

    this._lastVitals = vitals;
    this._detectChargingEvents(state);

    return state;
  }

  /**
   * Read live charge data from the laadpaal Homey device (e.g. Tesla Wall Connector app).
   * Tries common capability names used by EV charger Homey apps.
   *
   * Vehicle presence detection uses (in order of priority):
   *   1. vehicle_connected capability (explicit boolean)
   *   2. Pilot voltage: ~12V = no vehicle, <11V = vehicle present (IEC 61851)
   *   3. EVSE status string mapped to known "no vehicle" states
   *   4. Contactor state: Open + no power = no vehicle
   *   5. Power > 50W = vehicle present and charging
   */
  async _getChargerDeviceState() {
    if (!this._chargerDeviceId) return null;
    try {
      const device = await this.app.getDevice(this._chargerDeviceId);
      const caps   = device.capabilitiesObj;

      // Log capabilities once for debugging
      if (!this._chargerCapsLogged) {
        this._chargerCapsLogged = true;
        this.app.log('[Tesla] Charger device capabilities:', Object.keys(caps || {}).join(', '));
      }

      // Power — try multiple common capability names
      const powerW = caps?.measure_power?.value
        ?? caps?.['measure_power.active']?.value
        ?? caps?.charging_power?.value
        ?? 0;

      // Current — try multiple common capability names
      const currentA = caps?.measure_current?.value
        ?? caps?.['measure_current.offered']?.value
        ?? caps?.charging_current?.value
        ?? 0;

      // EVSE status string (used for charging & presence detection)
      const evseStatus = caps?.evse_state?.value
        ?? caps?.charging_status?.value
        ?? caps?.oplaadstatus?.value
        ?? null;

      // Known "no vehicle" EVSE status values (EN + NL)
      const NO_VEHICLE_STATES = [
        'available', 'Available', 'no ev', 'No EV', 'geen ev',
        'standby', 'Standby', 'idle', 'Idle',
        'wachten', 'Wachten', 'beschikbaar', 'Beschikbaar',
        'A', 'a', // IEC 61851 state A
      ];
      // Vehicle present but not yet charging (IEC 61851 state B)
      const CONNECTED_STATES = [
        'connected', 'Connected', 'plugged', 'Plugged',
        'verbonden', 'Verbonden', 'ingeplugd', 'Ingeplugd',
        'waiting for car', 'Waiting for car',
        'B', 'b', // IEC 61851 state B
      ];
      // Known "charging" EVSE status values (EN + NL)
      const CHARGING_STATES = [
        'charging', 'Charging', 'active', 'Active',
        'laden', 'Laden', 'opladen', 'Opladen',
        'C', 'D', // IEC 61851 state C/D
      ];

      // Pilot voltage — IEC 61851: ~12V = no vehicle, <11V = vehicle present
      // 'measure_twc_voltage.pilot_high_v' is the actual cap name on Gen 3 Wall Connector app
      const pilotHigh = caps?.['measure_twc_voltage.pilot_high_v']?.value
        ?? caps?.['pilot_high']?.value
        ?? caps?.['measure_voltage.pilot_high']?.value
        ?? caps?.['stuurpiloot_hoog']?.value
        ?? null;
      const pilotIndicatesPresent = pilotHigh !== null ? pilotHigh < 11 : null;

      // Contactor state — only used for charging detection, NOT presence
      // (contactor open = not charging, but car can still be plugged in)
      const contactor = caps?.contactor?.value ?? null;
      const contactorClosed = contactor !== null
        ? ['closed', 'Closed', true].includes(contactor)
        : null;

      // Determine vehicle present
      // Priority: explicit boolean → pilot voltage → known status strings → power
      // NOTE: contactor state is intentionally NOT used for presence detection —
      // contactor open just means not charging, car can still be plugged in.
      let vehiclePresent;
      if (caps?.vehicle_connected?.value !== undefined) {
        vehiclePresent = caps.vehicle_connected.value;           // explicit boolean
      } else if (pilotIndicatesPresent !== null) {
        vehiclePresent = pilotIndicatesPresent;                  // pilot voltage
      } else if (evseStatus && NO_VEHICLE_STATES.includes(evseStatus)) {
        vehiclePresent = false;                                  // known "no vehicle" status
      } else if (evseStatus && CONNECTED_STATES.includes(evseStatus)) {
        vehiclePresent = true;                                   // plugged in, not charging
      } else if (evseStatus && CHARGING_STATES.includes(evseStatus)) {
        vehiclePresent = true;                                   // charging = present
      } else {
        vehiclePresent = powerW > 50;                            // last resort: power flowing
      }

      // Determine charging
      const charging = evseStatus
        ? CHARGING_STATES.includes(evseStatus)
        : (powerW > 50 || contactorClosed === true);

      this._lastChargerPowerW = powerW;
      this._vehiclePresent    = vehiclePresent;

      return { powerW, currentA, charging, connected: vehiclePresent, evseState: evseStatus ?? 'unknown' };
    } catch (err) {
      this.app.error('[Tesla] _getChargerDeviceState error:', err.message);
      return null;
    }
  }

  /**
   * Returns true when a vehicle is confirmed present at the charger.
   * Used by EvChargeController to skip Tesla API calls when no car is home.
   */
  isVehiclePresent() {
    // If we have a charger device, use its last known state
    if (this._chargerDeviceId) {
      return this._vehiclePresent ?? true; // default true if not yet read
    }
    // Without charger device: assume present if we think we started a session,
    // or fall back to true (let the Tesla app handle it)
    return this._isChargingByEms || true;
  }

  /**
   * Returns current charge power in Watts — lightweight, called every tick.
   */
  async getCurrentPowerW() {
    const state = await this.getState();
    return state.powerW;
  }

  /**
   * Returns EV SoC — only via Tesla app, use sparingly (costs a reading).
   * Called by PlanningEngine once per planning cycle, not every tick.
   */
  async getSoc() {
    const state = await this._getTeslaAppState();
    return state?.soc ?? 50;
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  /**
   * Start EV charging.
   * Respects rate limit — queues if called too soon after last command.
   */
  async startCharging() {
    this.app.log('[Tesla] startCharging()');
    this._isChargingByEms = true;
    await this._sendCommand('start_charging');
  }

  /**
   * Stop EV charging.
   * @param {boolean} force  When true: bypass rate limit (execute immediately).
   *                         The EMS always manages charging when a car is present —
   *                         there is no longer a guard on _isChargingByEms for stops.
   */
  async stopCharging(force = false) {
    this.app.log(`[Tesla] stopCharging() force=${force}`);
    this._isChargingByEms = false;
    if (force) {
      await this._executeCommand('stop_charging');
    } else {
      await this._sendCommand('stop_charging');
    }
  }

  /**
   * Set charge current in Ampères (dynamic solar charging).
   * For Tesla this sets the charge limit current.
   * Min: 5A (below = stop), Max: configured maxAmps.
   * @param {number} targetA
   */
  async setChargeCurrent(targetA) {
    const clamped = Math.max(5, Math.min(this._maxCurrentA, Math.round(targetA)));

    // Below minimum meaningful current → stop charging
    if (clamped < 5 || targetA < 5) {
      await this.stopCharging();
      return;
    }

    // If car is already charging (detected from charger device or last vitals),
    // skip startCharging() — it would only waste a rate limit slot.
    const alreadyCharging = this._isCarAlreadyCharging();
    if (!this._isChargingByEms && !alreadyCharging) {
      await this.startCharging(); // only needed when car isn't charging yet
    } else if (!this._isChargingByEms) {
      // Claim control without sending start command
      this._isChargingByEms = true;
      this.app.log('[Tesla] setChargeCurrent — taking over existing session');
    }

    await this._sendCommand('set_charge_amps', { amps: clamped });
  }

  /**
   * Returns true if the car appears to be charging based on the last known state.
   * Used to avoid sending a redundant start_charging command.
   */
  _isCarAlreadyCharging() {
    // Check last Wall Connector vitals
    if (this._lastVitals) {
      return [6, 7, 11].includes(this._lastVitals.evse_state);
    }
    // Fall back to charger device state via powerW reading
    return this._lastChargerPowerW > 50;
  }

  /**
   * Set target SoC (charge limit) on the Tesla.
   * @param {number} targetPct  0–100
   */
  async setChargeLimit(targetPct) {
    const clamped = Math.max(50, Math.min(100, Math.round(targetPct)));
    await this._sendCommand('set_charge_limit', { limit: clamped });
  }

  /**
   * Calculate optimal charge current based on available solar surplus.
   * Accounts for phase configuration.
   * Returns the raw fractional Ampère value — the caller (EvChargeController)
   * decides whether to start, hold at minimum, or stop based on context.
   * @param {number} surplusW  available solar surplus in Watts
   * @returns {number} current in Ampères (may be below IEC minimum — caller decides)
   */
  calculateSolarCurrent(surplusW) {
    const voltage = 230; // V per phase
    const rawA    = surplusW / (voltage * this._evPhases);
    return Math.min(rawA, this._maxCurrentA);
  }

  // ─── Wall Connector local API ─────────────────────────────────────────────

  async _getWallConnectorVitals() {
    if (!this._wallConnectorIp) return null;

    try {
      const res  = await fetch(WC_POLL_URL(this._wallConnectorIp), {
        signal: AbortSignal.timeout(3000), // 3s timeout
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      this.app.error('[Tesla] Wall Connector poll error:', err.message);
      return null;
    }
  }

  // ─── Tesla Homey app ──────────────────────────────────────────────────────

  async _getTeslaAppState() {
    if (!this._teslaDeviceId) return null;

    try {
      const device = await this.app.getDevice(this._teslaDeviceId);
      const caps   = device.capabilitiesObj;

      // charging_state values: 'Charging', 'Complete', 'Disconnected', 'Stopped', 'NoPower', etc.
      const chargingState = caps?.charging_state?.value ?? null;

      // charging_on: boolean — true when charging is active
      const chargingOn = caps?.charging_on?.value ?? null;

      const charging = chargingOn !== null
        ? chargingOn === true
        : chargingState === 'Charging';

      const connected = chargingState !== null
        ? chargingState !== 'Disconnected'
        : null; // unknown without state

      // SoC: prefer measure_soc_usable (excludes buffer), fall back to measure_soc_level
      const soc = caps?.measure_soc_usable?.value
        ?? caps?.measure_soc_level?.value
        ?? null;

      return { soc, charging, connected };
    } catch (err) {
      this.app.error('[Tesla] App state error:', err.message);
      return null;
    }
  }

  async _sendCommand(command, args = {}) {
    const now = Date.now();

    // set_charge_amps has its own independent timer — car is already awake & charging,
    // so we don't need the full 10-minute start/stop cooldown.
    // start/stop share _lastCommandTime (10-min limit, can wake car from sleep).
    const isCurrentAdjust = command === 'set_charge_amps';
    const lastTime        = isCurrentAdjust ? this._lastCurrentAdjustTime : this._lastCommandTime;
    const interval        = isCurrentAdjust ? MIN_CURRENT_ADJUST_INTERVAL : MIN_COMMAND_INTERVAL_MS;

    if (now - lastTime < interval) {
      const waitMs = interval - (now - lastTime);
      this.app.log(`[Tesla] Rate limit — queuing ${command} (${Math.round(waitMs/1000)}s wait)`);
      this._commandQueue = { command, args };
      this._scheduleQueuedCommand(waitMs);
      return;
    }

    await this._executeCommand(command, args);
  }

  async _executeCommand(command, args = {}) {
    if (!this._teslaDeviceId) {
      this.app.log(`[Tesla] No Tesla device configured — cannot send ${command}`);
      return;
    }

    try {
      const device = await this.app.getDevice(this._teslaDeviceId);
      const caps   = device.capabilities; // string[]

      // Log all Tesla capabilities once so we can debug capability name mismatches
      if (!this._teslaCapsLogged) {
        this._teslaCapsLogged = true;
        this.app.log('[Tesla] Car device capabilities:', caps.join(', '));
      }

      const now = Date.now();
      let sent  = false;

      switch (command) {
        case 'start_charging':
          this._lastCommandTime = now;
          // Primary: fire flow trigger — user wires "EMS wants to start/stop EV charging"
          // to Tesla app action (same pattern as set_charge_amps / ev_set_charge_current).
          this.app.homey.emit('ems:setEvChargingOn', true);
          sent = true;
          // Fallback: also try direct capability in case user hasn't set up the flow
          if (caps.includes('charging_on')) {
            await device.setCapabilityValue('charging_on', true).catch(() => {});
          } else if (caps.includes('onoff')) {
            await device.setCapabilityValue('onoff', true).catch(() => {});
          }
          break;

        case 'stop_charging':
          this._lastCommandTime = now;
          // Primary: fire flow trigger — user wires to Tesla stop-charging action
          this.app.homey.emit('ems:setEvChargingOn', false);
          sent = true;
          // Fallback: also try direct capability
          if (caps.includes('charging_on')) {
            await device.setCapabilityValue('charging_on', false).catch(() => {});
          } else if (caps.includes('onoff')) {
            await device.setCapabilityValue('onoff', false).catch(() => {});
          }
          break;

        case 'set_charge_amps':
          this._lastCurrentAdjustTime = now;
          // The Tesla Homey app does not expose a settable capability for charge amps.
          // We fire our own trigger card 'ev_set_charge_current' (registered in FlowManager).
          // The user wires ONE flow: "When EMS wants to set EV charge current [current A]
          //   → Tesla: Stel laadstroom in op [current]"
          this.app.homey.emit('ems:setEvChargeCurrent', args.amps);
          sent = true;
          break;

        case 'set_charge_limit':
          this._lastCommandTime = now;
          if (caps.includes('measure_charge_limit_soc')) {
            await device.setCapabilityValue('measure_charge_limit_soc', args.limit);
            sent = true;
          } else if (caps.includes('charge_limit')) {
            await device.setCapabilityValue('charge_limit', args.limit);
            sent = true;
          }
          break;
      }

      if (sent) {
        this.app.log(`[Tesla] Command sent: ${command}`, args);
      }
    } catch (err) {
      this.app.error(`[Tesla] Command error (${command}):`, err.message);
    }
  }

  _scheduleQueuedCommand(waitMs) {
    // Clear any existing scheduled command
    if (this._queueTimer) {
      this.homey.clearTimeout(this._queueTimer);
    }
    this._queueTimer = this.homey.setTimeout(async () => {
      if (this._commandQueue) {
        const { command, args } = this._commandQueue;
        this._commandQueue = null;
        await this._executeCommand(command, args);
      }
    }, waitMs + 1000); // +1s buffer
  }

  // ─── Event detection ──────────────────────────────────────────────────────

  _detectChargingEvents(state) {
    if (state.charging && !this._chargingStartFired) {
      this._chargingStartFired = true;
      this._chargingStopFired  = false;
      this.homey.emit('ems:evChargingStarted', { powerW: state.powerW });
    }
    if (!state.charging && !this._chargingStopFired && this._chargingStartFired) {
      this._chargingStopFired  = true;
      this._chargingStartFired = false;
      this.homey.emit('ems:evChargingStopped', { sessionKwh: state.sessionKwh });
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  getStatus() {
    return {
      source:          this._wallConnectorIp ? 'wall_connector' : 'tesla_app',
      isChargingByEms: this._isChargingByEms,
      commandsPending: this._commandQueue !== null,
      lastVitals:      this._lastVitals,
    };
  }

}

module.exports = TeslaEvAdapter;
