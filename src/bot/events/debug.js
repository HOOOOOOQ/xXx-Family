import { Events } from 'discord.js';

import { getLogger } from '../../utils/logger.js';

/** Gateway debug noise — only visible at LOG_LEVEL=debug/trace. */
export default {
  name: Events.Debug,
  async execute(client, message) {
    getLogger().child('gateway').debug(String(message));
  },
};
