import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stableHash, stableStringify, occurrenceKey, candidateSlotKey } from '../../src/domain/identity';
import { addDays, displayDate, isOverdue, parseDate, viewRange } from '../../src/domain/dates';
import { createCalendarContext } from '../../src/adapters/calendar';
import { definition } from '../fixtures/series';

const calendar = createCalendarContext();

test('portable SHA identity agrees with Node SHA-256 for ASCII, unicode, lone surrogate and block boundaries', () => {
  for (const text of ['', 'abc', '中文任务🌙', '\ud800', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000)]) {
    assert.equal(stableHash(text), createHash('sha256').update(text).digest('hex'), `length=${text.length}`);
  }
});

test('canonical JSON ignores key insertion order and rejects non-JSON/cyclic values', () => {
  assert.equal(stableStringify({ b: 2, a: { y: true, x: 1 } }), stableStringify({ a: { x: 1, y: true }, b: 2 }));
  assert.throws(() => stableStringify({ value: Number.NaN }));
  const cyclic: any = {}; cyclic.self = cyclic;
  assert.throws(() => stableStringify(cyclic));
});

test('logical occurrence identity is independent of forecast date/revision; slots are not', () => {
  const a = definition();
  const b = definition({ revisionId: 'revision2' });
  const first = occurrenceKey(a.seriesId);
  assert.notEqual(first, occurrenceKey(a.seriesId, first));
  assert.notEqual(first, occurrenceKey('different-series'));
  assert.notEqual(candidateSlotKey(a, a.anchor), candidateSlotKey(b, b.anchor));
  assert.notEqual(candidateSlotKey(a, a.anchor), candidateSlotKey(a, { ...a.anchor, date: '2024-02-29' }));
});

test('date-only arithmetic crosses leap/year boundaries without device timezone', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-12-31', 1), '2025-01-01');
  assert.throws(() => parseDate('2023-02-29'));
  assert.throws(() => parseDate('2024-13-01'));
  assert.deepEqual(viewRange('sevenDays', '2024-12-29'), { start: '2024-12-30', end: '2025-01-06' });
});

test('all-day date does not shift across date line and becomes overdue at its own next midnight', () => {
  const schedule = { kind: 'allDay', date: '2024-01-01', zone: 'Asia/Shanghai' } as const;
  assert.equal(displayDate(schedule, 'America/Los_Angeles', calendar.zone), '2024-01-01');
  assert.equal(displayDate(schedule, 'Pacific/Kiritimati', calendar.zone), '2024-01-01');
  assert.equal(isOverdue(schedule, Date.parse('2024-01-01T15:59:59.999Z'), calendar.zone), false);
  assert.equal(isOverdue(schedule, Date.parse('2024-01-01T16:00:00.000Z'), calendar.zone), true);
});
