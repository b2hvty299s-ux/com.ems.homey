'use strict';

const { Driver }          = require('homey');
const { HomeyAPIV3Local } = require('homey-api');

/**
 * EmsControllerDriver
 * ───────────────────
 * Pair wizard: just creates the virtual device (1 step, list_devices template).
 * All device selection and configuration is done via the app settings page.
 */
class EmsControllerDriver extends Driver {

  async onInit() {
    this.log('[EmsDriver] Initialised');
  }

  // ─── Pair wizard ──────────────────────────────────────────────────────────

  async onPair(session) {
    // Device configuration (meters, battery, EV, heat pump) is done via the
    // app settings page after pairing — Homey.api() works there but not in wizard views.
    session.setHandler('list_devices', async () => {
      if (this.getDevices().length > 0) return []; // prevent double pairing
      this.log('[EmsDriver] Pair: creating EMS Controller device');
      return [{
        name:     'EMS Controller',
        data:     { id: 'ems-controller-1' },
        store:    {},
        settings: {},
      }];
    });
  }

  // ─── Repair (re-configuration) ────────────────────────────────────────────

  async onRepair(session, device) {
    this.log('[EmsDriver] Repair session started for device:', device.getName());

    const currentStore = device.getStore() || {};

    const pairData = {
      gridMeterId:  currentStore.gridMeterId  ?? null,
      pvMeterIds:   currentStore.pvMeterIds   ?? [],
      hasBattery:   currentStore.hasBattery   ?? false,
      batteryId:    currentStore.batteryId    ?? null,
      hasEv:        currentStore.hasEv        ?? false,
      evDeviceId:   currentStore.evDeviceId   ?? null,
      hasEvCharger: currentStore.hasEvCharger ?? false,
      evChargerId:  currentStore.evChargerId  ?? null,
      hasHeatPump:  currentStore.hasHeatPump  ?? false,
      heatPumpId:   currentStore.heatPumpId   ?? null,
    };

    session.setHandler('getDevices', async () => {
      try {
        const api        = await HomeyAPIV3Local.createAppAPI({ homey: this.homey });
        const devicesObj = await api.devices.getDevices();
        return Object.values(devicesObj).map(d => ({
          id: d.id, name: d.name, driverUri: d.driverUri, capabilities: d.capabilities || [],
        }));
      } catch (err) { return []; }
    });

    session.setHandler('getCurrentData',  async () => pairData);
    session.setHandler('saveMeters',      async (data) => { Object.assign(pairData, data); });
    session.setHandler('saveDevices1',    async (data) => { Object.assign(pairData, data); });

    session.setHandler('saveDevices2', async (data) => {
      Object.assign(pairData, data);

      // Apply updated device IDs to the device store and restart EMS
      const newStore = {
        configured:   true,
        gridMeterId:  pairData.gridMeterId,
        pvMeterIds:   pairData.pvMeterIds,
        hasBattery:   pairData.hasBattery,
        batteryId:    pairData.batteryId,
        hasEv:        pairData.hasEv,
        evDeviceId:   pairData.evDeviceId,
        hasEvCharger: pairData.hasEvCharger,
        evChargerId:  pairData.evChargerId,
        hasHeatPump:  pairData.hasHeatPump,
        heatPumpId:   pairData.heatPumpId,
      };

      for (const [k, v] of Object.entries(newStore)) {
        await device.setStoreValue(k, v);
      }
      await device._startEms();

      this.log('[EmsDriver] Repair: config applied');
    });

    session.setHandler('disconnect', async () => {
      this.log('[EmsDriver] Repair session ended');
    });
  }

}

module.exports = EmsControllerDriver;
