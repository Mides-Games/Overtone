import { createApi } from './api.js';
import { loadConfig, offMessage } from './config.js';
import { createHandlers, createReported } from './handlers.js';
import { defaultLimits } from './limits.js';
import { createNotifier } from './notifier.js';

/**
 * The Overtone Discord bot (W9.3-W9.5): slash commands in, site/api's
 * /api/internal/bot out. docs/bot.md has the setup.
 *
 * OFF, and says why, when DISCORD_TOKEN, BOT_TOKEN or OVERTONE_API is
 * missing: it exits 0 without touching Discord, so a panel server without its
 * secrets yet is stopped, not crash-looping.
 *
 * Intents: Guilds only. Slash commands arrive as interactions, which need no
 * privileged intent; the bot never reads messages or member lists.
 */
const config = loadConfig();
if (!config.ok) {
  console.log(offMessage(config));
  process.exit(0);
}

// Loaded only when the bot runs, so a missing token never needs the library.
const { Client, Events, GatewayIntentBits } = await import('discord.js');

const api = createApi({ base: config.apiUrl, token: config.botToken });
const reported = createReported();
const handlers = createHandlers({ api, limits: defaultLimits(), reported, pollMs: config.pollMs });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  handlers.handle(interaction);
});

const notifier = createNotifier({
  api,
  reported,
  sendDm: (discordId, message) => client.users.send(discordId, message),
});
let timer = null;

client.once(Events.ClientReady, async (ready) => {
  try {
    const health = await api.health();
    console.log(`[overtone-bot] Overtone answers: uploads up to ${health.maxUploadMb} MB, ${health.siteUrl}`);
  } catch (error) {
    console.warn(`[overtone-bot] Overtone does not answer yet (${error.code ?? error.message}); commands will say so until it does.`);
  }
  timer = setInterval(() => notifier.tick(), config.dmPollMs);
  // The panel's "started" line (deploy/eggs/egg.py).
  console.log(`overtone-bot: ready as ${ready.user.tag}`);
});

const stop = async () => {
  clearInterval(timer);
  await client.destroy().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await client.login(config.discordToken);
