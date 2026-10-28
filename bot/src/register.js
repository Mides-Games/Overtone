import { COMMANDS } from './commands.js';

/**
 * Registers the slash commands with Discord's REST API: one PUT that replaces
 * the application's whole list, so a command removed here disappears there.
 * With a guild id the commands land on that server only and at once (for
 * trying them); without, globally, which Discord may take a while to show.
 *
 * Plain fetch, no client: it runs once per change, from scripts/register.mjs.
 */
export const DISCORD_API = 'https://discord.com/api/v10';

export const registerCommands = async ({ token, appId, guildId = '', api = DISCORD_API, fetch: doFetch = globalThis.fetch }) => {
  if (!/^\d{17,20}$/.test(String(appId))) throw new Error('DISCORD_APP_ID is the application id, a number of 17 to 20 digits.');
  if (guildId && !/^\d{17,20}$/.test(String(guildId))) throw new Error('DISCORD_GUILD_ID is a server id, a number of 17 to 20 digits.');
  const path = guildId ? `/applications/${appId}/guilds/${guildId}/commands` : `/applications/${appId}/commands`;
  const response = await doFetch(`${api}${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(COMMANDS),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Discord refused the commands (${response.status}): ${JSON.stringify(body)?.slice(0, 500)}`);
  return { scope: guildId ? 'guild' : 'global', names: (body ?? []).map((c) => c.name) };
};
