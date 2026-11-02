import test from 'node:test';
import assert from 'node:assert/strict';
import { dayTimelineGroups, DAY_TIMELINE_HEIGHT } from '../../src/panel/viewModel';
import type { PreviewItem } from '../../src/shared/models';
const task = (id: string, hour: number, minute = 0): PreviewItem => ({
  id, title: id, date: '2026-10-27', kind: 'actual', priority: 'none', pinned: false, completed: false, overdue: false,
  schedule: {kind: 'timed', date: '2026-10-27', time: `${hour}:${minute}`, zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    instant: new Date(2026, 9, 27, hour, minute).getTime()},
});
test('civil-day positions are proportional and independent of task count or input order', () => {
  const groups = dayTimelineGroups([task('evening', 18), task('morning', 6), task('noon', 12)]);
  assert.deepEqual(groups.map(group => group.top), [.25, .5, .75].map(ratio => DAY_TIMELINE_HEIGHT * ratio));
  assert.deepEqual(groups.map(group => group.items[0]!.id), ['morning', 'noon', 'evening']);
});
test('dense, simultaneous and end-of-day tasks remain reachable within the fixed day', () => {
  const items = [task('start', 0), ...Array.from({length: 200}, (_, i) => task(`dense-${i}`, 12, i % 60)), task('late', 23, 59)];
  const groups = dayTimelineGroups(items);
  assert.equal(groups.flatMap(group => group.items).length, items.length);
  assert.equal(new Set(groups.flatMap(group => group.items.map(item => item.id))).size, items.length);
  assert.equal(groups[1]!.items.length, 200);
  for (const [index, group] of groups.entries()) {
    assert.ok(group.top >= 0 && group.top + group.height <= DAY_TIMELINE_HEIGHT);
    if (index) assert.ok(groups[index - 1]!.top + groups[index - 1]!.height <= group.top);
  }
});
