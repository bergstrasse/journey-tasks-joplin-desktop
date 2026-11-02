import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTaskRule, normalizeTaskRule, scheduleDateRuleDefaults } from '../../src/panel/taskFormState';
import { validateRule } from '../../src/domain/recurrence';
import type { RecurrenceRule } from '../../src/shared/models';

test('an undated native task starts with a valid daily rule, not hidden zero month/day fields', () => {
  for (const date of ['', '2026-10-25']) {
    const rule = defaultTaskRule(date, '2026-10-25');
    assert.equal(rule.frequency, 'daily');
    assert.equal(Object.hasOwn(rule, 'month'), false);
    assert.equal(Object.hasOwn(rule, 'monthDay'), false);
    assert.deepEqual(validateRule(rule), []);
  }
});

test('selecting a date after an undated start supplies month/year defaults when switching frequency', () => {
  const date = '2026-10-25';
  const selected = scheduleDateRuleDefaults(defaultTaskRule(''), '', date);
  const monthly = normalizeTaskRule({ ...selected, frequency: 'monthly' }, date);
  const yearly = normalizeTaskRule({ ...selected, frequency: 'yearly' }, date);
  assert.equal(monthly.monthDay, 25); assert.equal(monthly.month, undefined);
  assert.equal(yearly.monthDay, 25); assert.equal(yearly.month, 10);
  assert.deepEqual(validateRule(monthly), []); assert.deepEqual(validateRule(yearly), []);
});

test('daily and weekly payloads discard inactive invalid selectors while retaining valid weekday choices', () => {
  for (const frequency of ['daily', 'weekly'] as const) {
    const rule: RecurrenceRule = { ...defaultTaskRule(), frequency, month: 0, monthDay: 0,
      monthSelector: 'nthWeekday', nth: 0, weekday: 0, lunarLeap: true, weekdays: [1, 3] };
    const clean = normalizeTaskRule(rule, '2026-10-25');
    for (const key of ['month', 'monthDay', 'monthSelector', 'nth', 'weekday', 'lunarLeap']) assert.equal(Object.hasOwn(clean, key), false, key);
    assert.deepEqual(clean.weekdays, [1, 3]); assert.deepEqual(validateRule(clean), []);
  }
  assert.equal(Object.hasOwn(normalizeTaskRule({ ...defaultTaskRule(), weekdays: [] }, '2026-10-25'), 'weekdays'), false);
});

test('changing a Gregorian date updates derived values but preserves user-customized month/day', () => {
  const defaults: RecurrenceRule = { ...defaultTaskRule(), frequency: 'yearly', month: 10, monthDay: 25 };
  const changed = scheduleDateRuleDefaults(defaults, '2026-10-25', '2026-11-30');
  assert.equal(changed.month, 11); assert.equal(changed.monthDay, 30);
  const custom = { ...defaults, month: 3, monthDay: 15 };
  assert.deepEqual(scheduleDateRuleDefaults(custom, '2026-10-25', '2026-11-30'), custom);
  assert.deepEqual(scheduleDateRuleDefaults(custom, '', '2026-11-30'), custom,
    'an empty old date cannot justify overriding legitimate custom values');
  const monthly = scheduleDateRuleDefaults({ ...defaults, frequency: 'monthly' }, '2026-10-25', '2026-11-30');
  assert.equal(monthly.month, undefined); assert.equal(monthly.monthDay, 30);
});

test('normalization drops inactive selector fields rather than sending validation-poisoning zeroes', () => {
  const rule: RecurrenceRule = { ...defaultTaskRule(), frequency: 'monthly', monthDay: 0, weekdays: [],
    monthSelector: 'lastDay', nth: 0, weekday: 0 };
  const last = normalizeTaskRule(rule, '2026-10-25');
  assert.equal(last.monthDay, undefined); assert.equal(last.nth, undefined); assert.equal(last.weekday, undefined);
  assert.deepEqual(validateRule(last), []);
  const nth = normalizeTaskRule({ ...rule, monthSelector: 'nthWeekday', nth: 2, weekday: 3 }, '2026-10-25');
  assert.equal(nth.monthDay, undefined); assert.equal(nth.nth, 2); assert.equal(nth.weekday, 3);
  assert.deepEqual(validateRule(nth), []);
});

test('lunar selectors are never derived from a Gregorian input date', () => {
  const lunar: RecurrenceRule = { ...defaultTaskRule(), calendar: 'lunar', frequency: 'yearly', month: 1, monthDay: 15, lunarLeap: true };
  assert.deepEqual(scheduleDateRuleDefaults(lunar, '2026-03-03', '2026-11-25'), lunar);
  assert.deepEqual(normalizeTaskRule(lunar, '2026-11-25'), lunar);
  const missing = normalizeTaskRule({ ...defaultTaskRule(), calendar: 'lunar', frequency: 'yearly' }, '2026-11-25');
  assert.equal(missing.month, undefined); assert.equal(missing.monthDay, undefined);
});

test('empty or malformed dates do not introduce zero selectors, and normalization does not mutate input', () => {
  const original: RecurrenceRule = { ...defaultTaskRule(), frequency: 'yearly', month: 3, monthDay: 15,
    interval: 3, basis: 'completed', end: { kind: 'count', count: 5 } };
  const before = structuredClone(original);
  for (const date of ['', 'invalid', '2026-00-00', '2026-13-01']) {
    const next = scheduleDateRuleDefaults(original, '', date);
    assert.deepEqual(next, original);
    normalizeTaskRule(original, date);
  }
  assert.deepEqual(original, before);
});
