/**
 * Registers the bot's slash commands with Discord (docs/bot.md).
 *
 *   pnpm --dir bot register
 *
 * Needs DISCORD_TOKEN and DISCORD_APP_ID; DISCORD_GUILD_ID registers them on
 * one server, at once, instead of globally. Run it after a change to
 * src/commands.js, not on every start: Discord rate-limits command updates.
 */
import { registerCommands } from '../src/register.js';

const token = (process.env.DISCORD_TOKEN ?? '').trim();
const appId = (process.env.DISCORD_APP_ID ?? '').trim();
const guildId = (process.env.DISCORD_GUILD_ID ?? '').trim();

const missing = [['DISCORD_TOKEN', token], ['DISCORD_APP_ID', appId]].filter(([, v]) => !v).map(([n]) => n);
if (missing.length) {
  console.error(`[overtone-bot] register: ${missing.join(' and ')} not set; nothing registered.`);
  process.exit(1);
}

try {
  const { scope, names } = await registerCommands({ token, appId, guildId, api: process.env.DISCORD_API || undefined });
  console.log(`[overtone-bot] registered ${names.length} commands (${scope}): ${names.map((n) => `/${n}`).join(' ')}`);
} catch (error) {
  console.error(`[overtone-bot] register: ${error.message}`);
  process.exit(1);
}
