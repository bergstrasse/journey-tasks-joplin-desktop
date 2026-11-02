import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarContext } from '../../src/adapters/calendar';
import { reduceSeries } from '../../src/domain/series';
import { planAdvance, snoozeCurrent } from '../../src/domain/transitions';
import { projectView } from '../../src/domain/projections';
import type { Task } from '../../src/shared/models';
import { initialSeries, operation } from '../fixtures/operations';
import { definition } from '../fixtures/series';

const calendar = createCalendarContext();
function taskFor(first: ReturnType<typeof initialSeries>['first']): Task {
  return { taskId: first.occurrenceId, noteId: first.carrierNoteId, title: 'Task', notebookId: 'notebook',
    tagIds: [], schedule: first.scheduled, completedAt: 0, priority: 'none', pinned: false,
    reminder: { enabled: false }, seriesId: first.seriesId, occurrenceId: first.occurrenceId };
}

test('advance planning refuses unresolved current but accepts explicit skip and keeps original anchor', () => {
  const { create, first, def } = initialSeries();
  const current = reduceSeries([create]);
  const at = Date.parse('2024-01-31T05:00:00Z');
  assert.throws(() => planAdvance(current, at, calendar, 'advance'));
  const skip = operation('skip', 'ActOccurrence', { action: 'skip', occurrenceId: first.occurrenceId, at });
  const skipped = reduceSeries([create, skip]);
  const payload = planAdvance(skipped, at, calendar, 'advance');
  assert.equal(payload.next?.scheduled.date, '2024-02-29');
  assert.equal(payload.next?.predecessorId, first.occurrenceId);
  assert.deepEqual(skipped.definition!.anchor, def.anchor);
});

test('snooze must be future', () => {
  const { create } = initialSeries();
  assert.throws(() => snoozeCurrent(reduceSeries([create]), 100, 100));
});

test('late plan-based resolution generates only the next planned period, including overdue periods', () => {
  const def = definition({ anchor: { kind: 'allDay', date: '2024-01-01', zone: 'Asia/Shanghai' } },
    { frequency: 'weekly', weekdays: [1] });
  const { create, first } = initialSeries(def);
  const at = Date.parse('2024-01-17T04:00:00Z');
  const done = operation('done', 'ActOccurrence', { action: 'complete', occurrenceId: first.occurrenceId, at });
  const payload = planAdvance(reduceSeries([create, done]), at, calendar, 'advance');
  assert.equal(payload.next?.scheduled.date, '2024-01-08');
});

test('count-one terminal ends without creating another carrier', () => {
  const { create, first } = initialSeries(definition({}, { end: { kind: 'count', count: 1 } }));
  const at = Date.parse('2024-01-31T05:00:00Z');
  const done = operation('done', 'ActOccurrence', { action: 'complete', occurrenceId: first.occurrenceId, at });
  const payload = planAdvance(reduceSeries([create, done]), at, calendar, 'advance');
  assert.equal(payload.next, null);
  assert.equal(payload.candidateNoteId, undefined);
});

test('current not completed still previews future calendar slots, with no actual note IDs or state mutation', () => {
  const { create, first } = initialSeries();
  const snapshot = reduceSeries([create]);
  const before = JSON.stringify(snapshot);
  const view = projectView([taskFor(first)], [snapshot], {
    view: 'year', selectedDate: '2024-01-31', deviceZone: 'Asia/Shanghai', now: Date.parse('2024-01-01T00:00:00Z'),
  }, calendar);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(view.items.filter(item => item.kind === 'actual').length, 1);
  assert.equal(view.items.filter(item => item.kind === 'projected').length, 11);
  for (const item of view.items.filter(item => item.kind === 'projected')) {
    assert.equal(item.noteId, undefined);
    assert.equal(item.occurrenceId, undefined);
    assert.ok(item.candidateSlotKey);
  }
});

test('temporary defer shows one actual at effective date, suppressing its original forecast slot', () => {
  const { create, first } = initialSeries();
  const defer = operation('defer', 'ActOccurrence', { action: 'defer', occurrenceId: first.occurrenceId,
    schedule: { ...first.scheduled, date: '2024-02-02' } });
  const snapshot = reduceSeries([create, defer]);
  const view = projectView([taskFor(first)], [snapshot], {
    view: 'month', selectedDate: '2024-02-01', deviceZone: 'Asia/Shanghai', now: Date.parse('2024-02-01T00:00:00Z'),
  }, calendar);
  const actual = view.items.filter(item => item.kind === 'actual');
  assert.equal(actual.length, 1);
  assert.equal(actual[0]?.date, '2024-02-02');
  assert.equal(view.items.filter(item => item.date === '2024-01-31').length, 0);
  assert.equal(view.items.filter(item => item.kind === 'projected' && item.date === '2024-02-29').length, 1);
});

test('completion-based future previews visibly expose their assumption', () => {
  const { create, first } = initialSeries(definition({}, { basis: 'completed' }));
  const view = projectView([taskFor(first)], [reduceSeries([create])], {
    view: 'year', selectedDate: '2024-01-01', deviceZone: 'Asia/Shanghai', now: 0,
  }, calendar);
  assert.ok(view.items.some(item => item.kind === 'projected'));
  assert.ok(view.items.filter(item => item.kind === 'projected').every(item => !!item.assumption));
});

test('fixed-zone timed forecasts are bounded by displayed device date, not task calendar date', () => {
  const resolved = calendar.zone.resolve('2023-12-30', '00:30', 'Asia/Shanghai');
  const def = definition({ anchor: { kind: 'timed', date: '2023-12-30', time: '00:30', zone: 'Asia/Shanghai', instant: resolved.instant } },
    { frequency: 'daily' });
  const { create, first } = initialSeries(def);
  const view = projectView([taskFor(first)], [reduceSeries([create])], {
    view: 'sevenDays', selectedDate: '2024-01-01', deviceZone: 'America/New_York', now: Date.parse('2024-01-01T05:00:00Z'),
  }, calendar);
  assert.deepEqual(view.items.filter(item => item.kind === 'actual').map(item => item.date), ['2023-12-29']);
  assert.ok(view.items.find(item => item.kind === 'actual')?.overdue);
  assert.deepEqual(view.items.filter(item => item.kind === 'projected').map(item => item.date),
    ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-06', '2024-01-07', '2024-01-08']);
});
