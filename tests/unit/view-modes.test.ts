import test from 'node:test';
import assert from 'node:assert/strict';
import { projectView } from '../../src/domain/projections';
import { viewRange } from '../../src/domain/dates';
import { createCalendarContext } from '../../src/adapters/calendar';
import { groupListItems, calendarWeeks, isoWeekNumber, actualCount, projectedCount } from '../../src/panel/viewModel';
import type { Task, ViewKind, PreviewItem } from '../../src/shared/models';

const calendar = createCalendarContext();
const now = Date.parse('2026-10-25T02:00:00Z');
function task(id: string, date?: string, extra: Partial<Task> = {}): Task {
  return { taskId: id, noteId: id, title: id, notebookId: 'book', tagIds: ['tag'],
    schedule: date ? { kind: 'allDay', date, zone: 'Asia/Shanghai' } : { kind: 'none' },
    completedAt: 0, priority: 'none', pinned: false, reminder: { enabled: false }, ...extra };
}
const tasks = [task('past', '2026-10-24', { pinned: true }), task('today', '2026-10-25'), task('tomorrow', '2026-10-26'),
  task('last-of-seven', '2026-10-31'), task('outside-seven', '2026-11-01'), task('done', '2026-10-25', { completedAt: now }), task('inbox')];
function items(view: ViewKind, extra = {}) {
  return projectView(tasks, [], { view, selectedDate: '2026-10-25', deviceZone: 'Asia/Shanghai', now, ...extra }, calendar).items;
}
for (const [view, expected] of Object.entries({ today: ['past', 'today'], tomorrow: ['past', 'tomorrow'], sevenDays: ['past', 'tomorrow', 'last-of-seven', 'outside-seven'],
  inbox: ['inbox'], all: ['past', 'today', 'tomorrow', 'last-of-seven', 'outside-seven', 'inbox'], day: ['today'],
  week: ['today', 'tomorrow', 'last-of-seven'], month: ['past', 'today', 'tomorrow', 'last-of-seven'],
  year: ['past', 'today', 'tomorrow', 'last-of-seven', 'outside-seven'] })) {
  test(`${view} selects only matching actual tasks by default`, () => {
    assert.deepEqual(items(view as ViewKind).map(row => row.noteId).sort(), [...expected].sort());
  });
}

test('date lists always include overdue tasks while completed tasks remain optional', () => {
  assert.deepEqual(items('today', { showCompleted: true }).map(row => row.noteId).sort(), ['done', 'past', 'today']);
  assert.deepEqual(items('today').map(row => row.noteId).sort(), ['past', 'today']);
  assert.ok(items('sevenDays').some(row => row.noteId === 'past'));
  assert.ok(items('tomorrow').some(row => row.noteId === 'past'));
  assert.ok(!items('inbox').some(row => row.noteId === 'past'));
  assert.ok(items('all', { showCompleted: true }).some(row => row.noteId === 'done'));
  const doneInbox = task('done-inbox', undefined, { completedAt: now });
  assert.equal(projectView([doneInbox], [], { view: 'inbox', selectedDate: '2026-10-25', deviceZone: 'Asia/Shanghai', now }, calendar).items.length, 0);
});

test('inbox only includes undated tasks regardless of overdue, pinning and completion options', () => {
  const rows = [...tasks, task('pinned-inbox', undefined, { pinned: true }),
    task('done-inbox', undefined, { completedAt: now }),
    task('done-past', '2026-10-24', { completedAt: now }),
    task('elapsed', undefined, { pinned: true, schedule: { kind: 'timed', date: '2026-10-25', time: '09:00', zone: 'Asia/Shanghai', instant: now - 3600000 } })];
  for (const showCompleted of [true, false]) {
    const result = projectView(rows, [], { view: 'inbox', selectedDate: '2026-10-25', deviceZone: 'Asia/Shanghai', now, showCompleted }, calendar);
    assert.deepEqual(result.items.map(row => row.noteId).sort(), [...(showCompleted ? ['done-inbox'] : []), 'inbox', 'pinned-inbox']);
    assert.ok(result.items.every(row => row.schedule.kind === 'none' && !row.overdue));
  }
});

test('native notebook/tag filters apply before grouping and metadata is retained', () => {
  const filtered = projectView([...tasks, task('other', '2026-10-25', { notebookId: 'other', tagIds: ['other-tag'] })], [],
    { view: 'all', selectedDate: '2026-10-25', deviceZone: 'Asia/Shanghai', now, notebookId: 'book', tagId: 'tag' }, calendar).items;
  assert.ok(filtered.every(row => row.notebookId === 'book' && row.tagIds?.includes('tag')));
  assert.ok(!filtered.some(row => row.noteId === 'other'));
});

test('pinned overdue/date/inbox groups are exclusive and counts distinguish real tasks from forecasts', () => {
  const rows = items('all'); const groups = groupListItems([...rows, rows[0]!]);
  const ids = groups.flatMap(group => group.items.map(row => row.id));
  assert.equal(new Set(ids).size, ids.length); assert.equal(ids.length, rows.length);
  assert.equal(groups[0]!.kind, 'pinned'); assert.equal(groups[0]!.items[0]!.noteId, 'past');
  assert.ok(!groups.find(group => group.kind === 'overdue')?.items.some(row => row.noteId === 'past'));
  const forecast: PreviewItem = { ...rows[0]!, id: 'forecast', kind: 'projected', noteId: undefined };
  assert.equal(actualCount([...rows, rows[0]!, forecast]), rows.length);
  assert.equal(projectedCount([forecast, forecast]), 1);
});

test('calendar weeks start Sunday, cross years correctly, and use the row Thursday ISO week number', () => {
  assert.deepEqual(viewRange('week', '2027-01-01'), { start: '2026-12-27', end: '2027-01-03' });
  assert.deepEqual(viewRange('day', '2027-01-01'), { start: '2027-01-01', end: '2027-01-02' });
  assert.equal(isoWeekNumber('2027-01-01'), 53); assert.equal(isoWeekNumber('2027-01-04'), 1);
  const weeks = calendarWeeks('2027-01-01');
  assert.equal(weeks[0]!.start, '2026-12-27'); assert.equal(weeks[0]!.weekNumber, 53);
  assert.deepEqual(weeks[0]!.dates, ['2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.ok(weeks.every(row => row.dates.length === 7)); assert.equal(weeks[1]!.weekNumber, 1);
});

test('legacy priority never changes ordering of otherwise identical tasks', () => {
  const high = task('z-high', '2026-10-25', { priority: 'high' });
  const none = task('a-none', '2026-10-25');
  const result = projectView([high, none], [], { view: 'today', selectedDate: '2026-10-25', deviceZone: 'Asia/Shanghai', now }, calendar);
  assert.deepEqual(result.items.map(row => row.noteId), ['a-none', 'z-high']);
});

test('list modes never fabricate forecast tasks and calendar forecasts inherit native source filters', async () => {
  const { initialSeries } = await import('../fixtures/operations');
  const { definition } = await import('../fixtures/series');
  const { reduceSeries } = await import('../../src/domain/series');
  const def = definition({ anchor: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' }, sourceNotebookId: 'native-book', sourceTagIds: ['native-tag'] }, { frequency: 'daily' });
  const { create } = initialSeries(def); const series = reduceSeries([create]);
  for (const view of ['today', 'tomorrow', 'inbox', 'all'] as const) {
    const snapshot = projectView([], [series], { view, selectedDate: '2026-10-25', deviceZone: 'Asia/Shanghai', now }, calendar);
    assert.equal(snapshot.items.length, 0, view);
  }
  const match = projectView([], [series], { view: 'week', selectedDate: '2026-10-25', deviceZone: 'Asia/Shanghai', now, notebookId: 'native-book', tagId: 'native-tag' }, calendar);
  assert.ok(match.items.length > 0);
  assert.ok(match.items.every(row => row.kind === 'projected' && row.notebookId === 'native-book' && row.tagIds?.includes('native-tag')));
  const excluded = projectView([], [series], { view: 'week', selectedDate: '2026-10-25', deviceZone: 'Asia/Shanghai', now, notebookId: 'other' }, calendar);
  assert.equal(excluded.items.length, 0);
});

test('tomorrow overdue includes only genuinely overdue unfinished tasks, including elapsed times today', () => {
  const timed = (id: string, time: string, completedAt = 0) => task(id, '2026-10-25', { completedAt, schedule: {
    kind: 'timed', date: '2026-10-25', time, zone: 'Asia/Shanghai', instant: Date.parse(`2026-10-25T${time}:00+08:00`),
  } });
  const rows = [task('old-open', '2026-10-24'), task('old-done', '2026-10-24', { completedAt: now }),
    task('today-all-day', '2026-10-25'), timed('today-elapsed', '09:00'), timed('today-future', '11:00'), task('tomorrow-target', '2026-10-26')];
  const query = { view: 'tomorrow' as const, selectedDate: '2026-10-25', deviceZone: 'Asia/Shanghai', now, showCompleted: true };
  assert.deepEqual(projectView(rows, [], { ...query }, calendar).items.map(row => row.noteId).sort(), ['old-open', 'today-elapsed', 'tomorrow-target']);
  assert.deepEqual(projectView(rows, [], { ...query }, calendar).items.map(row => row.noteId), ['old-open', 'today-elapsed', 'tomorrow-target']);
});

for (const view of ['today', 'tomorrow', 'sevenDays', 'all'] as const) {
  test(`${view} includes overdue tasks outside its date range`, () => {
    const result = projectView([task('old', '2025-01-01'), task('old-done', '2025-01-01', { completedAt: now })], [],
      { view, selectedDate: '2027-01-01', deviceZone: 'Asia/Shanghai', now, showCompleted: true }, calendar);
    assert.ok(result.items.some(row => row.noteId === 'old' && row.overdue));
    if (view !== 'all') assert.ok(!result.items.some(row => row.noteId === 'old-done'));
  });
}

test('issue31: pinning respects today, future list and inbox filters before grouping', () => {
  const rows = [task('pinned-today', '2026-10-28', { pinned: true }),
    task('pinned-past', '2026-10-27', { pinned: true }),
    task('pinned-tomorrow', '2026-10-29', { pinned: true }),
    task('pinned-future', '2026-12-01', { pinned: true }),
    task('pinned-inbox', undefined, { pinned: true }),
    task('done-pin', '2026-12-01', { pinned: true, completedAt: now }),
    task('other-book', '2026-10-28', { pinned: true, notebookId: 'other' })];
  const query = { selectedDate: '2026-10-28', deviceZone: 'Asia/Shanghai', now: Date.parse('2026-10-28T02:00:00Z'), notebookId: 'book' };
  for (const showCompleted of [false, true]) {
    for (const [view, expected] of [
      ['today', ['pinned-past', 'pinned-today']],
      ['tomorrow', ['pinned-past', 'pinned-tomorrow']],
      ['sevenDays', ['pinned-past', 'pinned-tomorrow']],
      ['inbox', ['pinned-inbox']],
      ['all', [...(showCompleted ? ['done-pin'] : []), 'pinned-future', 'pinned-inbox', 'pinned-past', 'pinned-today', 'pinned-tomorrow']],
    ] as [ViewKind, string[]][]) {
      const result = projectView(rows, [], { ...query, view, showCompleted }, calendar);
      assert.deepEqual(result.items.map(row => row.noteId).sort(), expected, view);
      const grouped = groupListItems(result.items).flatMap(group => group.items.map(row => row.id));
      assert.equal(grouped.length, result.items.length);
      assert.equal(new Set(grouped).size, grouped.length);
    }
  }
});

test('seven days starts tomorrow and includes exactly seven dates across a year boundary', () => {
  const rows = ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05', '2027-01-06', '2027-01-07']
    .map(date => task(date, date));
  const result = projectView(rows, [], { view: 'sevenDays', selectedDate: '2026-12-30', deviceZone: 'Asia/Shanghai', now: Date.parse('2026-12-30T02:00:00Z') }, calendar);
  assert.deepEqual(result.range, { start: '2026-12-31', end: '2027-01-07' });
  assert.deepEqual(result.items.map(row => row.date), rows.slice(1, 8).map(row => row.title));
});

for (const view of ['day', 'week', 'month', 'year'] as const) {
  test(`${view} keeps overdue tasks on their dates and excludes tasks outside its calendar range`, () => {
    const result = projectView([task('in-range', '2026-10-25', { pinned: true }), task('outside', '2025-01-01', { pinned: true }), task('undated', undefined, { pinned: true })], [],
      { view, selectedDate: '2026-10-25', deviceZone: 'Asia/Shanghai', now: Date.parse('2026-10-27T02:00:00Z') }, calendar);
    assert.deepEqual(result.items.map(row => row.noteId), ['in-range']);
    assert.equal(result.items[0]?.date, '2026-10-25');
    assert.equal(result.items[0]?.overdue, true);
  });
}

test('list sorting keeps group categories fixed and reverses only dates and primary keys', () => {
  const rows = items('all');
  const pinned = { ...rows.find(row => row.pinned)!, id: 'second-pin', date: '2026-12-01', schedule: { kind: 'allDay' as const, date: '2026-12-01', zone: 'Asia/Shanghai' } };
  const ascending = groupListItems([...rows, pinned]);
  const descending = groupListItems([...rows, pinned], 'time', 'descending');
  assert.equal(descending[0]!.kind, 'pinned');
  assert.deepEqual(descending[0]!.items.map(row => row.id), ascending[0]!.items.map(row => row.id).reverse());
  assert.deepEqual(descending.filter(group => group.kind === 'date').map(group => group.id), ascending.filter(group => group.kind === 'date').map(group => group.id).reverse());
  assert.equal(descending.at(-1)!.kind, 'inbox');
});

test('notebook grouping preserves native notebook order, reverses chronological order within notebooks, and never duplicates pinned tasks', () => {
  const rows = items('all').map((row, i) => ({ ...row, notebookId: i % 2 ? 'a' : 'z' }));
  const folders = [{ id: 'a', title: 'Zulu' }, { id: 'z', title: 'Alpha' }];
  const ascending = groupListItems(rows, 'notebook', 'ascending', folders);
  const descending = groupListItems([...rows, rows[0]!], 'notebook', 'descending', folders);
  assert.deepEqual(ascending.map(group => group.title ?? group.kind), ['pinned', 'Zulu', 'Alpha']);
  assert.deepEqual(descending.map(group => group.title ?? group.kind), ['pinned', 'Zulu', 'Alpha']);
  for (const group of descending.slice(1)) {
    const dated = group.items.filter(row => row.schedule.kind !== 'none');
    assert.deepEqual(dated.map(row => row.date), [...dated.map(row => row.date)].sort().reverse());
    if (group.items.some(row => row.schedule.kind === 'none')) assert.equal(group.items.at(-1)!.schedule.kind, 'none');
  }
  assert.equal(descending.flatMap(group => group.items).length, rows.length);
});
