import { Events } from 'discord.js';

import { getLogger } from '../../utils/logger.js';

export default {
  name: Events.Warn,
  async execute(client, message) {
    getLogger().child('client-warn').warn(String(message));
    client.metrics.increment('clientWarnings');
  },
};
