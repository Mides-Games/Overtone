/**
 * The bot's configuration, from the environment. Every value is needed for
 * the bot to run; with any missing it is OFF, and says which, rather than
 * half-starting. No secret has a default.
 *
 *   DISCORD_TOKEN    the bot user's token (Discord developer portal -> Bot)
 *   BOT_TOKEN        the bearer of site/api's /api/internal/bot, the same value as the API's
 *   OVERTONE_API     the API reached directly, http://<allocation>:<port>, never through overtone-web
 *
 * And for scripts/register.mjs only:
 *
 *   DISCORD_APP_ID   the application id the commands belong to
 *   DISCORD_GUILD_ID optional: register on one server (instant) instead of globally
 */

const text = (env, name) => String(env[name] ?? '').trim();

/** `{ ok, missing, problems, ... }`: `ok` only when the bot can run. */
export const loadConfig = (env = process.env) => {
  const config = {
    discordToken: text(env, 'DISCORD_TOKEN'),
    botToken: text(env, 'BOT_TOKEN'),
    apiUrl: text(env, 'OVERTONE_API').replace(/\/+$/, ''),
    // How often a waiting /time-song asks the API, and the outbox is read.
    pollMs: Number(text(env, 'BOT_POLL_MS')) || 3000,
    dmPollMs: Number(text(env, 'BOT_DM_POLL_MS')) || 15_000,
  };
  const missing = [
    ['DISCORD_TOKEN', config.discordToken],
    ['BOT_TOKEN', config.botToken],
    ['OVERTONE_API', config.apiUrl],
  ].filter(([, value]) => !value).map(([name]) => name);

  const problems = [];
  if (config.botToken && config.botToken.length < 32) problems.push('BOT_TOKEN must be at least 32 characters.');
  if (config.apiUrl) {
    try {
      const url = new URL(config.apiUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    } catch {
      problems.push(`OVERTONE_API must be an http(s) URL (got "${config.apiUrl}").`);
    }
  }
  return { ...config, missing, problems, ok: missing.length === 0 && problems.length === 0 };
};

/** The one line that says why the bot is not running. */
export const offMessage = ({ missing, problems }) =>
  [
    missing.length ? `[overtone-bot] OFF: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set (docs/bot.md).` : null,
    ...problems.map((p) => `[overtone-bot] OFF: ${p}`),
  ]
    .filter(Boolean)
    .join('\n');
