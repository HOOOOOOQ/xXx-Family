import { Events } from 'discord.js';

/**
 * Every interaction enters here and nowhere else. The handler itself owns
 * routing, locale resolution, guards and error reporting.
 */
export default {
  name: Events.InteractionCreate,
  async execute(client, interaction) {
    client.metrics.interactions += 1;
    await client.interactionHandler.handle(interaction);
  },
};
