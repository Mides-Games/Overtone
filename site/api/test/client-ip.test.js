import assert from 'node:assert/strict';
import { test } from 'node:test';

delete process.env.DATABASE_URL;
const { clientKey } = await import('../src/utils/client-ip.js');
const { guard } = await import('../src/middlewares/rate-limit.js');
const { ipHashOf } = await import('../src/routes/analyses.routes.js');

test('IPv4 is counted by its address, IPv6 by its /64', () => {
  assert.equal(clientKey('203.0.113.9'), '203.0.113.9');
  assert.equal(clientKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(clientKey('::FFFF:203.0.113.9'), '203.0.113.9');
  assert.equal(clientKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('2001:db8:0:0:1::'), '2001:db8:0:0::/64');
  assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
  assert.equal(clientKey('64:ff9b::192.0.2.33'), '64:ff9b:0:0::/64');
  for (const value of [undefined, null, '', 'unknown', 'not-an-ip', '1.2.3']) assert.equal(clientKey(value), 'unknown');
});

test('addresses in one /64 are one person to the rate limit, another /64 is another', () => {
  const limit = guard('test-v6', 2, 60_000);
  const hit = (ip) => {
    let passed;
    limit({ ip }, {}, (error) => {
      passed = error ? error.code : 'ok';
    });
    return passed;
  };
  assert.equal(hit('2001:db8:aa:bb::1'), 'ok');
  assert.equal(hit('2001:db8:aa:bb::2'), 'ok');
  assert.equal(hit('2001:db8:aa:bb:ffff::3'), 'RATE_LIMITED');
  assert.equal(hit('2001:db8:aa:bc::1'), 'ok');
});

test('the anonymous quota and the queue count an IPv6 client by its /64', () => {
  assert.equal(ipHashOf({ ip: '2001:db8:aa:bb::1' }), ipHashOf({ ip: '2001:db8:aa:bb:1234:5678:9abc:def0' }));
  assert.notEqual(ipHashOf({ ip: '2001:db8:aa:bb::1' }), ipHashOf({ ip: '2001:db8:aa:bc::1' }));
  assert.equal(ipHashOf({ ip: '::ffff:198.51.100.7' }), ipHashOf({ ip: '198.51.100.7' }));
  assert.notEqual(ipHashOf({ ip: '198.51.100.7' }), ipHashOf({ ip: '198.51.100.8' }));
});
