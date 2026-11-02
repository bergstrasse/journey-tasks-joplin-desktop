import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarContext } from '../../src/adapters/calendar';
import { enumerateWindow, nextCandidate } from '../../src/domain/recurrence';
import { definition } from '../fixtures/series';

const calendar = createCalendarContext();
const after = (date: string) => calendar.zone.startOfDay(date, 'Asia/Shanghai');
const dates = (def: ReturnType<typeof definition>, start: string, end: string) =>
  enumerateWindow(def, { start, end }, calendar).candidates.map(item => item.schedule.date);

test('month-end clamp preserves original 31-day anchor after February', () => {
  assert.deepEqual(dates(definition(), '2024-01-01', '2024-05-01'),
    ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
});

test('yearly leap-day clamp returns to February 29 in the next leap year', () => {
  const def = definition({ anchor: { kind: 'allDay', date: '2024-02-29', zone: 'Asia/Shanghai' } },
    { frequency: 'yearly', month: 2, monthDay: 29 });
  assert.deepEqual(dates(def, '2024-01-01', '2029-01-01'),
    ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
});

test('seven day window is start-inclusive, end-exclusive and survives year boundary', () => {
  const def = definition({ anchor: { kind: 'allDay', date: '2024-12-29', zone: 'Asia/Shanghai' } },
    { frequency: 'daily' });
  assert.deepEqual(dates(def, '2024-12-29', '2025-01-05'),
    ['2024-12-29', '2024-12-30', '2024-12-31', '2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04']);
});

test('ordinary workdays use weekdays only and do not masquerade as statutory holidays', () => {
  const def = definition({ anchor: { kind: 'allDay', date: '2024-09-27', zone: 'Asia/Shanghai' } },
    { frequency: 'weekly', weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(dates(def, '2024-09-27', '2024-10-03'), ['2024-09-27', '2024-09-30', '2024-10-01', '2024-10-02']);
});

test('every other week with multiple weekdays anchors to original ISO week', () => {
  const def = definition({ anchor: { kind: 'allDay', date: '2024-01-01', zone: 'Asia/Shanghai' } },
    { frequency: 'weekly', interval: 2, weekdays: [1, 3] });
  assert.deepEqual(dates(def, '2024-01-01', '2024-01-22'), ['2024-01-01', '2024-01-03', '2024-01-15', '2024-01-17']);
});

test('missing fifth weekday uses explicit last-day product policy', () => {
  const def = definition({ anchor: { kind: 'allDay', date: '2024-02-01', zone: 'Asia/Shanghai' } },
    { monthSelector: 'nthWeekday', nth: 5, weekday: 1 });
  assert.deepEqual(dates(def, '2024-02-01', '2024-03-01'), ['2024-02-29']);
});

test('until includes cutoff date; consumed count stops generation; preview budget is explicit', () => {
  const daily = definition({ anchor: { kind: 'allDay', date: '2024-01-01', zone: 'Asia/Shanghai' } },
    { frequency: 'daily', end: { kind: 'until', date: '2024-01-03' } });
  assert.deepEqual(dates(daily, '2024-01-01', '2024-01-05'), ['2024-01-01', '2024-01-02', '2024-01-03']);
  const finite = definition({}, { end: { kind: 'count', count: 2 } });
  assert.equal(nextCandidate(finite, after('2024-02-01'), calendar, 2), null);
  const budget = enumerateWindow(definition({}, { frequency: 'daily' }),
    { start: '2024-02-01', end: '2024-03-01' }, calendar, { limit: 3 });
  assert.equal(budget.candidates.length, 3);
  assert.equal(budget.truncated, true);
});

test('late completion takes next original planned position instead of flooding missed tasks', () => {
  const def = definition({ anchor: { kind: 'allDay', date: '2024-01-01', zone: 'Asia/Shanghai' } },
    { frequency: 'weekly', weekdays: [1] });
  assert.equal(nextCandidate(def, after('2024-01-17'), calendar)?.schedule.date, '2024-01-22');
});

test('lunar monthly sequence includes leap month, clamps day thirty, then restores thirty', () => {
  const def = definition({ anchor: { kind: 'allDay', date: '2023-03-21', zone: 'Asia/Shanghai' } },
    { calendar: 'lunar', frequency: 'monthly', monthDay: 30 });
  assert.deepEqual(dates(def, '2023-03-01', '2023-05-20'), ['2023-03-21', '2023-04-19', '2023-05-18']);
});

test('normal lunar birthday does not execute again in same-name leap month', () => {
  const def = definition({ anchor: { kind: 'allDay', date: '2023-02-20', zone: 'Asia/Shanghai' } },
    { calendar: 'lunar', frequency: 'yearly', month: 2, monthDay: 1, lunarLeap: false });
  assert.deepEqual(dates(def, '2023-01-01', '2024-01-01'), ['2023-02-20']);
});

test('leap lunar birthday falls back to normal month when leap month does not exist', () => {
  const def = definition({ anchor: { kind: 'allDay', date: '2023-03-22', zone: 'Asia/Shanghai' } },
    { calendar: 'lunar', frequency: 'yearly', month: 2, monthDay: 1, lunarLeap: true });
  assert.deepEqual(dates(def, '2023-01-01', '2025-01-01'), ['2023-03-22', '2024-03-10']);
});

test('enumeration is pure and does not mutate definitions while creating distinct forecast slots', () => {
  const def = definition();
  const before = JSON.stringify(def);
  const result = enumerateWindow(def, { start: '2024-01-01', end: '2025-01-01' }, calendar);
  assert.equal(JSON.stringify(def), before);
  assert.equal(new Set(result.candidates.map(c => c.candidateSlotKey)).size, result.candidates.length);
  assert.deepEqual(enumerateWindow(def, { start: '2024-01-01', end: '2025-01-01' }, calendar), result);
});
