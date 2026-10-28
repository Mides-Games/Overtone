import { checkAttachment, download, DownloadError } from './attachment.js';
import { parseRef } from './commands.js';
import { analysisEmbed, compareEmbed, progressText, queueEmbed, recentEmbed } from './format.js';
import { stringsFor } from './strings.js';

/**
 * What each slash command does. Written against the few members of a
 * discord.js ChatInputCommandInteraction it uses (commandName, user, locale,
 * options, reply, deferReply, editReply, channel), so the tests drive it with
 * a plain object and a fake API and no Discord at all.
 */

/** Discord's "only you can see this" message flag. */
export const EPHEMERAL = 64;
/** An interaction's token lasts 15 minutes; after that its reply cannot be edited. */
export const EDIT_WINDOW_MS = 14 * 60_000;
/** How long a /time-song keeps waiting for its result at most. */
export const WAIT_MAX_MS = 3 * 3600_000;
/** How often the limits are read again from the API. */
const HEALTH_TTL_MS = 10 * 60_000;

/**
 * Analyses whose result the bot already gave in a channel, so the DM outbox
 * (notifier.js) does not send the same news twice. Bounded: the oldest go.
 */
export const createReported = (max = 2000) => {
  const ids = new Set();
  return {
    add(id) {
      ids.add(id);
      if (ids.size > max) ids.delete(ids.values().next().value);
    },
    has: (id) => ids.has(id),
  };
};

export const createHandlers = ({
  api,
  limits,
  reported = createReported(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  pollMs = 3000,
  fetch = globalThis.fetch,
  hosts,
  log = console,
}) => {
  let health = null;
  let healthAt = 0;
  const limitsNow = async () => {
    if (!health || now() - healthAt > HEALTH_TTL_MS) {
      health = await api.health();
      healthAt = now();
    }
    return health;
  };

  /** An API or download error as a sentence for the person who asked. */
  const errorText = (error, t) => {
    if (error instanceof DownloadError) {
      return error.reason === 'size' ? t.size(health?.maxUploadMb ?? '?') : error.reason === 'type' ? t.type : t.download;
    }
    const d = error.details ?? {};
    switch (error.code) {
      case 'QUOTA_EXCEEDED': return d.scope === 'account' ? t.quotaLinked(d.limit) : t.quotaAnon(d.limit);
      case 'PENDING_LIMIT': return t.pending(d.limit);
      case 'QUEUE_FULL': return t.queueFull;
      case 'SPOOL_FULL': return t.busy;
      case 'TOO_LARGE': return t.size(d.maxUploadMb ?? health?.maxUploadMb ?? '?');
      case 'UNSUPPORTED_FORMAT': return t.format((health?.extensions ?? []).map((e) => e.toUpperCase()).join(', '));
      case 'RATE_LIMITED': return t.rateLimited(60);
      case 'NOT_FOUND': return t.notFound;
      case 'BOT_OFF': return t.off;
      case 'DISCORD_NOT_LINKED': return t.needsLink;
      case 'BAD_LINK_CODE': return t.badCode;
      default:
        if (error.code === 'NETWORK' || error.status >= 500) return t.down;
        return t.error(error.message);
    }
  };

  // ── /time-song ──

  /** Asks again until the analysis ends, editing the reply while Discord allows it. */
  const waitFor = async (i, t, id) => {
    const user = i.user.id;
    const startedAt = now();
    let last = '';
    let warned = false;
    let misses = 0;
    let s = await api.analysis(user, id);
    while (s.status === 'queued' || s.status === 'running') {
      const elapsed = now() - startedAt;
      if (elapsed > WAIT_MAX_MS) return { s, editable: false };
      if (elapsed < EDIT_WINDOW_MS - 60_000) {
        const line = progressText(s, t);
        if (line !== last) {
          last = line;
          await i.editReply({ content: line }).catch(() => {});
        }
      } else if (!warned) {
        warned = true;
        await i.editReply({ content: t.stillWaiting }).catch(() => {});
      }
      await sleep(pollMs);
      try {
        s = await api.analysis(user, id);
        misses = 0;
      } catch (error) {
        // A restart of the API is not the end of the song: a few misses are waited out.
        if (error.status === 404 || ++misses > 20) throw error;
      }
    }
    return { s, editable: now() - startedAt < EDIT_WINDOW_MS };
  };

  /** The result where the person will see it: the reply, else the channel, else a DM. */
  const deliver = async (i, t, s, editable) => {
    const embed = analysisEmbed(s, t);
    reported.add(s.id);
    if (editable) {
      await i.editReply({ content: '', embeds: [embed] });
      return;
    }
    const message = { content: t.late(i.user.id), embeds: [embed], allowedMentions: { users: [i.user.id] } };
    try {
      await i.channel.send(message);
    } catch {
      await i.user.send({ embeds: [embed] }).catch((error) => log.warn(`[overtone-bot] a late result had nowhere to go: ${error.message}`));
    }
  };

  const timeSong = async (i, t) => {
    const user = i.user.id;
    const up = limits.upload.hit(user);
    if (!up.ok) return i.reply({ content: t.rateLimited(up.waitS), flags: EPHEMERAL });

    const att = i.options.getAttachment('audio', true);
    const h = await limitsNow();
    const maxBytes = h.maxUploadMb * 1_048_576;
    const check = checkAttachment(att, { maxBytes, extensions: h.extensions, ...(hosts ? { hosts } : {}) });
    if (!check.ok) {
      const content = {
        format: t.format(h.extensions.map((e) => e.toUpperCase()).join(', ')),
        type: t.type,
        size: t.size(h.maxUploadMb),
        host: t.host,
      }[check.reason];
      return i.reply({ content, flags: EPHEMERAL });
    }

    await i.deferReply();
    await i.editReply({ content: t.uploading });
    // The audio is held only between these two lines: downloaded, sent, dropped.
    let audio = await download(att.url, { maxBytes, fetch });
    let started;
    try {
      started = await api.upload(user, { audio, filename: att.name, hidden: i.options.getBoolean('private') ?? false });
    } finally {
      audio = null;
    }

    let { s, editable } = await waitFor(i, t, started.id);
    if (s.status === 'queued' || s.status === 'running') return undefined; // gave up after WAIT_MAX_MS
    if (s.status === 'done' && i.options.getBoolean('publish')) {
      try {
        s = await api.publish(user, s.id);
      } catch {
        await i.followUp?.({ content: t.publishFailed, flags: EPHEMERAL }).catch(() => {});
      }
    }
    return deliver(i, t, s, editable);
  };

  // ── The others ──

  const timing = async (i, t) => {
    const id = parseRef(i.options.getString('timing', true));
    if (!id) return i.reply({ content: t.badRef, flags: EPHEMERAL });
    await i.deferReply();
    const s = await api.timing(i.user.id, id);
    return i.editReply({ embeds: [analysisEmbed(s, t)] });
  };

  const compare = async (i, t) => {
    const a = parseRef(i.options.getString('a', true));
    const b = parseRef(i.options.getString('b', true));
    if (!a || !b) return i.reply({ content: t.badRef, flags: EPHEMERAL });
    await i.deferReply();
    const [sa, sb] = await Promise.all([api.timing(i.user.id, a), api.timing(i.user.id, b)]);
    return i.editReply({ embeds: [compareEmbed(sa, sb, t)] });
  };

  const queue = async (i, t) => {
    await i.deferReply();
    return i.editReply({ embeds: [queueEmbed(await api.queue(i.user.id), t)] });
  };

  const recent = async (i, t) => {
    const target = i.options.getUser('user') ?? i.user;
    await i.deferReply();
    const r = await api.recent(i.user.id, target.id);
    if (!r.linked) return i.editReply({ content: t.notLinkedUser });
    if (!r.timings.length) return i.editReply({ content: t.noRecent(r.username) });
    return i.editReply({ embeds: [recentEmbed(r.username, r.timings, t)] });
  };

  const link = async (i, t) => {
    await i.deferReply({ flags: EPHEMERAL });
    const r = await api.link(i.user.id, i.options.getString('code', true));
    return i.editReply({ content: t.linked(r.username) });
  };

  const notify = async (i, t) => {
    const on = i.options.getString('state', true) === 'on';
    await i.deferReply({ flags: EPHEMERAL });
    await api.notify(i.user.id, on);
    return i.editReply({ content: on ? t.notifyOn : t.notifyOff });
  };

  const HANDLERS = { 'time-song': timeSong, timing, compare, queue, recent, link, notify };

  /** One interaction, start to end. Never throws: whatever fails is said to the person. */
  const handle = async (i) => {
    const t = stringsFor(i.locale);
    const run = HANDLERS[i.commandName];
    if (!run) return;
    const any = limits.any.hit(i.user.id);
    if (!any.ok) {
      await i.reply({ content: t.rateLimited(any.waitS), flags: EPHEMERAL }).catch(() => {});
      return;
    }
    try {
      await run(i, t);
    } catch (error) {
      const content = errorText(error, t);
      if (!error.status && !(error instanceof DownloadError)) log.error(`[overtone-bot] /${i.commandName}:`, error);
      if (i.deferred || i.replied) await i.editReply({ content, embeds: [] }).catch(() => {});
      else await i.reply({ content, flags: EPHEMERAL }).catch(() => {});
    }
  };

  return { handle, errorText };
};
