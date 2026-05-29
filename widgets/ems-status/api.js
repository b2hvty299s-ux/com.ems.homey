'use strict';

module.exports = {
  async getState({ homey }) {
    return homey.app.ems.getPublicState();
  },
  async getPlan({ homey }) {
    return homey.app.ems.planningEngine
      ? homey.app.ems.planningEngine.getCurrentPlan()
      : null;
  },
};
