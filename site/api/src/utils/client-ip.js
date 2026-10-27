import { isIP } from 'node:net';

/**
 * The address a person is counted by: rate limits, the anonymous quota and
 * the queue's turns (2026-10-27).
 *
 * An IPv4 address is one subscriber at most. An IPv6 subscriber is usually
 * handed a whole /64 (often a /56 or /48), and picks any of its 2^64
 * addresses at will: counted per address, one person is endless people. So
 * IPv6 is counted by its /64, the smallest block a subscriber gets. A client
 * reaching a dual-stack socket over IPv4 arrives as `::ffff:a.b.c.d` and is
 * counted as `a.b.c.d`. Anything that is not an address is one shared bucket.
 */
export const clientKey = (ip) => {
  if (typeof ip !== 'string' || !ip.trim()) return 'unknown';
  let address = ip.trim();
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return 'unknown';
  return `${hextets(address).slice(0, 4).join(':')}::/64`;
};

/** The eight 16-bit groups of a valid IPv6 address, lower-case, without leading zeros. */
const hextets = (address) => {
  let text = address.toLowerCase();
  // A trailing dotted quad (::a.b.c.d, 64:ff9b::a.b.c.d) is the last two groups.
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number);
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((group) => parseInt(group, 16).toString(16));
};
