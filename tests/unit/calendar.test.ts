import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarContext } from '../../src/adapters/calendar';
import { lunarOracle } from '../fixtures/lunar-oracle';

const calendar = createCalendarContext();

test('lunar conversion matches independently transcribed HKO leap-month/year-end fixtures', () => {
  for (const { solar, ...lunar } of lunarOracle) {
    assert.deepEqual(calendar.lunar.fromSolar(solar), lunar, solar);
    assert.equal(calendar.lunar.toSolar(lunar), solar, solar);
  }
});

test('lunar month lengths and leap sequence distinguish normal and leap months', () => {
  assert.equal(calendar.lunar.monthDays(2023, 2, false), 30);
  assert.equal(calendar.lunar.monthDays(2023, 2, true), 29);
  assert.equal(calendar.lunar.monthDays(2024, 12, false), 29);
  const months = calendar.lunar.monthsOfYear(2025);
  assert.equal(months.length, 13);
  const normalSix = months.findIndex(m => m.month === 6 && !m.leap);
  assert.deepEqual(months[normalSix + 1], { month: 6, leap: true, days: 29 });
});

test('lunar rejects invalid days, nonexistent leap months and unsupported range rather than normalizing', () => {
  for (const date of [
    { year: 2023, month: 2, day: 30, leap: true },
    { year: 2024, month: 2, day: 1, leap: true },
    { year: 2024, month: 13, day: 1, leap: false },
  ]) assert.throws(() => calendar.lunar.toSolar(date));
  assert.throws(() => calendar.lunar.fromSolar('1800-01-01'));
  assert.throws(() => calendar.lunar.fromSolar('2101-01-01'));
});

test('fixed task time is the same instant regardless of device display zone', () => {
  const instant = calendar.zone.resolve('2026-10-24', '09:00', 'Asia/Shanghai').instant;
  assert.equal(instant, Date.parse('2026-10-24T01:00:00Z'));
  assert.equal(calendar.zone.localTime(instant, 'Asia/Tokyo').slice(0, 5), '10:00');
  assert.equal(calendar.zone.localDate(instant, 'Asia/Shanghai'), '2026-10-24');
});

test('DST gap shifts by gap, fold chooses earlier instant, daily wall clock is not +24h', () => {
  const gap = calendar.zone.resolve('2024-03-10', '02:30', 'America/New_York');
  assert.equal(gap.instant, Date.parse('2024-03-10T07:30:00Z'));
  const fold = calendar.zone.resolve('2024-11-03', '01:30', 'America/New_York');
  assert.equal(fold.instant, Date.parse('2024-11-03T05:30:00Z'));
  const before = calendar.zone.resolve('2024-03-09', '09:00', 'America/New_York').instant;
  const after = calendar.zone.resolve('2024-03-10', '09:00', 'America/New_York').instant;
  assert.equal(after - before, 23 * 60 * 60 * 1000);
});

test('non-whole-hour offsets and DST gaps are not rounded to an hour', () => {
  assert.equal(calendar.zone.resolve('2024-01-01', '09:00', 'Asia/Kathmandu').instant,
    Date.parse('2024-01-01T03:15:00Z'));
  assert.equal(calendar.zone.resolve('2024-10-06', '02:15', 'Australia/Lord_Howe').instant,
    Date.parse('2024-10-05T15:45:00Z'));
});

test('invalid zone/date fails explicitly, not silently falling back to UTC or normalizing', () => {
  assert.equal(calendar.zone.isValidZone('Imaginary/Nowhere'), false);
  assert.throws(() => calendar.zone.resolve('2024-01-01', '09:00', 'Imaginary/Nowhere'));
  assert.throws(() => calendar.zone.resolve('2024-02-30', '09:00', 'Asia/Shanghai'));
});
