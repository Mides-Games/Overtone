/**
 * Per Discord user limits, in this process's memory (the bot is one
 * process). The API counts too, and is the authority: this one only spares a
 * download and a round trip for someone already over.
 *
 * Keys are Discord ids, held while their window lasts and swept after.
 */
export const createLimiter = ({ max, windowMs, now = Date.now }) => {
  const hits = new Map();
  let lastSweep = now();
  return {
    /** `{ ok: true }`, or `{ ok: false, waitS }`. */
    hit(user) {
      const t = now();
      if (t - lastSweep >= 60_000) {
        lastSweep = t;
        for (const [key, hit] of hits) if (hit.resetAt <= t) hits.delete(key);
      }
      let hit = hits.get(user);
      if (!hit || hit.resetAt <= t) {
        hit = { count: 0, resetAt: t + windowMs };
        hits.set(user, hit);
      }
      hit.count += 1;
      return hit.count <= max ? { ok: true } : { ok: false, waitS: Math.max(1, Math.ceil((hit.resetAt - t) / 1000)) };
    },
  };
};

/** The bot's limits: any command, and /time-song (which downloads and uploads a file) more narrowly. */
export const defaultLimits = (now) => ({
  any: createLimiter({ max: 20, windowMs: 60_000, now }),
  upload: createLimiter({ max: 5, windowMs: 10 * 60_000, now }),
});
