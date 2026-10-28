import { analysisEmbed } from './format.js';
import { STRINGS } from './strings.js';

/**
 * W9.4, DMs when an analysis ends. The API keeps an outbox of finished
 * analyses whose account linked Discord and asked for DMs (`/notify on`, or
 * the profile's switch); every tick takes what is there, at most once, and
 * sends each as a DM.
 *
 * At most once on purpose: a notice lost to a crash between the claim and the
 * send is cheaper than the same DM twice. A DM refused by the person's privacy
 * settings is logged without the id and dropped. Analyses the bot already
 * answered in a channel (`reported`) are not sent again.
 *
 * A DM has no locale to read: it is written in English, the bot's default.
 */
export const createNotifier = ({ api, sendDm, reported, log = console }) => {
  let running = false;
  const tick = async () => {
    if (running) return 0;
    running = true;
    let sent = 0;
    try {
      const { dms } = await api.claimDms();
      for (const { discordId, analysis } of dms) {
        if (reported?.has(analysis.id)) continue;
        try {
          await sendDm(discordId, { embeds: [analysisEmbed(analysis, STRINGS.en)] });
          sent += 1;
        } catch (error) {
          log.warn(`[overtone-bot] a DM was not delivered (${error.code ?? error.message})`);
        }
      }
    } catch (error) {
      if (error.code !== 'BOT_OFF') log.warn(`[overtone-bot] the DM outbox could not be read: ${error.message}`);
    } finally {
      running = false;
    }
    return sent;
  };
  return { tick };
};
