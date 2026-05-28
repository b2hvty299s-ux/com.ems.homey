'use strict';

class NotificationManager {
  constructor(app) { this.app = app; this.homey = app.homey; }

  async send(message) {
    try {
      await this.homey.notifications.createNotification({ excerpt: message });
    } catch (err) {
      this.app.error('[Notify] Error:', err.message);
    }
  }
}

module.exports = NotificationManager;
