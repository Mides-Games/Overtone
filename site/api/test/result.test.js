import assert from 'node:assert/strict';
import { test } from 'node:test';

delete process.env.DATABASE_URL;
const { validResult } = await import('../src/routes/internal.routes.js');
const { csvCell, timingCsv } = await import('../src/utils/upload.js');

/** A result as worker/timing_result.py builds one, two red lines. */
const good = () => ({
  format: 'timing-result', version: 1, engine: 'v3', engine_mode: 'precision', engine_hash: '0123456789abcdef',
  app_version: '3.0', beat_vote: false, params: {}, duration_s: 24.0, refused: false, refusal: null,
  global_bpm: 128, offset_ms: 400, meter: '4/4', stability: 0.98, residual_ms: 0.4,
  red_lines: [
    { time_ms: 400, bpm: 128, beat_length_ms: 468.75, meter: 4, meter_known: true },
    { time_ms: 12_000, bpm: 142, beat_length_ms: 422.535211, meter: 4, meter_known: false },
  ],
  sections: [
    { index: 0, start_ms: 400, end_ms: 12_000, bpm: 128, confidence: 0.99, level: 'high', residual_ms: 0.3, coverage: 0.9 },
    { index: 1, start_ms: 12_000, end_ms: 24_000, bpm: 142, confidence: 0.8, level: 'medium', residual_ms: null, coverage: null },
  ],
  findings: [], osu_timing: '400,468.75,4,1,0,100,1,0', future_field: { anything: true },
});

const refused = () => ({
  ...good(), refused: true, refusal: { code: 'no_pulse', message: 'No pulse.' }, global_bpm: null, offset_ms: null,
  meter: null, stability: null, residual_ms: null, engine_mode: null, red_lines: [], sections: [], osu_timing: '',
});

const broken = (mutate) => {
  const result = good();
  mutate(result);
  return validResult(result);
};

test('a result the worker builds passes, refused or not, with fields this API does not know', () => {
  assert.equal(validResult(good()), true);
  assert.equal(validResult(refused()), true);
});

test('red-line and section numbers must be finite and in range', () => {
  assert.equal(broken((r) => { r.red_lines[0].bpm = Number.NaN; }), false);
  assert.equal(broken((r) => { r.red_lines[0].bpm = 0; }), false);
  assert.equal(broken((r) => { r.red_lines[0].bpm = 1e9; }), false);
  assert.equal(broken((r) => { r.red_lines[0].time_ms = '400'; }), false);
  assert.equal(broken((r) => { r.red_lines[0].time_ms = 1e12; }), false);
  assert.equal(broken((r) => { r.red_lines[0].meter = 4.5; }), false);
  assert.equal(broken((r) => { r.red_lines[0].meter = 99; }), false);
  assert.equal(broken((r) => { r.red_lines[0].beat_length_ms = -1; }), false);
  assert.equal(broken((r) => { r.sections[0].confidence = 1.5; }), false);
  assert.equal(broken((r) => { r.sections[0].end_ms = 100; }), false);
  assert.equal(broken((r) => { r.sections[0].residual_ms = Number.POSITIVE_INFINITY; }), false);
  assert.equal(broken((r) => { r.sections[0].coverage = -0.1; }), false);
  assert.equal(broken((r) => { r.global_bpm = Number.NaN; }), false);
  assert.equal(broken((r) => { r.duration_s = -1; }), false);
  // A negative offset is a real thing in osu! timing.
  assert.equal(broken((r) => { r.red_lines[0].time_ms = -25; r.sections[0].start_ms = -25; }), true);
});

test('the level is one of the three the site shows', () => {
  assert.equal(broken((r) => { r.sections[0].level = '=HYPERLINK("x")'; }), false);
  assert.equal(broken((r) => { r.sections[0].level = undefined; }), false);
});

test('arrays and strings are capped', () => {
  assert.equal(broken((r) => { r.red_lines = Array(2001).fill(r.red_lines[0]); }), false);
  assert.equal(broken((r) => { r.sections = Array(2001).fill(r.sections[0]); }), false);
  assert.equal(broken((r) => { r.osu_timing = 'x'.repeat(256 * 1024 + 1); }), false);
  assert.equal(broken((r) => { r.meter = '4'.repeat(17); }), false);
  assert.equal(broken((r) => { r.findings = Array(2001).fill({}); }), false);
  const long = refused();
  long.refusal.message = 'x'.repeat(1001);
  assert.equal(validResult(long), false);
  const code = refused();
  code.refusal.code = 'No Pulse!';
  assert.equal(validResult(code), false);
});

test('CSV text cells cannot start a formula; numbers, negative ones included, stay numbers', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+cmd'), "'+cmd");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\t=1'), "'\t=1");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(-25.5), '-25.5');
  assert.equal(csvCell(Number.NaN), '');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('high'), 'high');
  const csv = timingCsv({ red_lines: [{ time_ms: -25, bpm: 128, beat_length_ms: 468.75, meter: 4 }],
    sections: [{ confidence: 0.9, level: '=cmd|"/c calc"!A1' }] });
  assert.equal(csv.split('\r\n')[1], `-25,128,468.75,4,0.9,"'=cmd|""/c calc""!A1"`);
});
