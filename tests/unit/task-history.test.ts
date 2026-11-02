import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { taskHistory } from '../../src/services/taskHistory';
import { TaskHistory } from '../../src/panel/TaskHistory';
import type { SingleOperation } from '../../src/adapters/joplin/repositories';
const op = (opId: string, kind: SingleOperation['kind'], payload: any, parents: string[] = [], recordedAt = 100): SingleOperation =>
  ({ schemaVersion: 1, opId, deviceId: 'device', deviceSeq: 1, kind, payload, parents, recordedAt, payloadHash: '' });
test('old values follow causal ancestry despite duplicate input, clock skew and a concurrent branch', () => {
  const create = op('create', 'SingleCreate', { task: { title: 'Original', completedAt: 0 } });
  const first = op('first', 'SinglePatch', { patch: { title: 'First' } }, ['create'], 300);
  const second = op('second', 'SinglePatch', { patch: { title: 'Second' } }, ['first'], 200);
  const branch = op('branch', 'SinglePatch', { patch: { title: 'Branch' } }, ['create'], 400);
  const log = taskHistory([second, branch, create, first, second]);
  assert.equal(log.length, 3);
  assert.deepEqual(log.find(e => e.id === 'second')?.changes, [{ field: 'title', before: 'First', after: 'Second' }]);
  assert.equal(log.find(e => e.id === 'branch')?.changes[0]?.before, 'Original');
});
test('adopting a completed legacy task preserves its completion after reopen without calling adoption creation', () => {
  const create = op('adopt', 'SingleCreate', { task: { title: 'Old', completedAt: 50 } });
  const reopen = op('reopen', 'SinglePatch', { patch: { completedAt: 0 } }, ['adopt']);
  const log = taskHistory([create, reopen]);
  assert.deepEqual(log.map(e => [e.kind, e.at]), [['reopened', 100], ['completed', 50]]);
});
test('internal projections are hidden and skipped native timestamp is not mislabeled as completed', () => {
  const create = op('create', 'SingleCreate', { task: { completedAt: 0 } });
  const skip = op('skip', 'SinglePatch', { patch: { completedAt: 200, resolution: 'skipped' } }, ['create']);
  const internal = op('receipt', 'SingleProjectionReceipt', {}, ['skip']);
  const log = taskHistory([internal, skip, create], { id: 'note', todo_completed: 200 } as any);
  assert.equal(log.length, 1); assert.equal(log[0]?.kind, 'skipped');
});
test('history markup shows human-readable old/new schedule, actual completion and escapes user text', () => {
  const html = renderToStaticMarkup(React.createElement(TaskHistory, { title: '<script>unsafe</script>', folders: [], entries: [
    { id: 'date', kind: 'modified', at: 1700000000000, changes: [{ field: 'schedule', before: { kind: 'allDay', date: '2026-10-24', zone: 'UTC' }, after: { kind: 'none' } }] },
    { id: 'done', kind: 'completed', at: 1700000060000, changes: [] },
  ] }));
  assert.match(html, /2026-10-24/); assert.match(html, /→/); assert.match(html, /实际完成/);
  assert.match(html, /<time dateTime=/); assert.doesNotMatch(html, /\[object Object\]|<script>/);
});

test('one descending timeline replaces the old execution list and omits initial configuration', async () => {
  const { initialSeries, nextOccurrence } = await import('../fixtures/operations');
  const { first, def } = initialSeries();
  const next = nextOccurrence(first, def);
  const entries = [
    { id: 'created', kind: 'created', at: 100, changes: [] },
    { id: 'enabled', kind: 'seriesCreated', occurrenceId: first.occurrenceId, at: 200, changes: [{ field: 'priority', after: 'none' }, { field: 'title', after: 'Unnecessary initial dump' }] },
    { id: 'skip', kind: 'skipped', occurrenceId: first.occurrenceId, at: 300, changes: [] },
    { id: 'advance', kind: 'scheduled', occurrenceId: next.occurrenceId, at: 400, changes: [] },
  ];
  const html = renderToStaticMarkup(React.createElement(TaskHistory, { title: 'Breakfast', folders: [], entries,
    occurrences: [{ ...first, resolution: 'skipped', resolvedAt: 300, consumed: true }, next], onReopen() {}, onOpen() {},
  }));
  assert.equal((html.match(/<ol/g) || []).length, 1);
  assert.equal((html.match(/<li/g) || []).length, 4);
  assert.ok(html.indexOf('待执行') < html.indexOf('放弃任务'));
  assert.ok(html.indexOf('放弃任务') < html.indexOf('启用重复任务'));
  assert.ok(html.indexOf('启用重复任务') < html.indexOf('创建任务'));
  assert.equal((html.match(/撤销状态/g) || []).length, 1);
  assert.equal((html.match(/打开笔记/g) || []).length, 2);
  assert.doesNotMatch(html, /Unnecessary initial dump|优先级|按时间倒序|已处理|已推进|history-row/);
  assert.equal((html.match(/Breakfast/g) || []).length, 1);
});
test('reopened occurrence retains its completion action once, while old pending rows are hidden', async () => {
  const { initialSeries } = await import('../fixtures/operations');
  const { first } = initialSeries();
  const html = renderToStaticMarkup(React.createElement(TaskHistory, { title: 'Task', folders: [],
    occurrences: [{ ...first, consumed: true }], onComplete() {}, onOpen() {}, entries: [
      { id: 'pending', kind: 'scheduled', at: 100, occurrenceId: first.occurrenceId, changes: [] },
      { id: 'completed', kind: 'completed', at: 200, occurrenceId: first.occurrenceId, changes: [] },
      { id: 'reopened', kind: 'reopened', at: 300, occurrenceId: first.occurrenceId, changes: [] },
    ],
  }));
  assert.doesNotMatch(html, /待执行/);
  assert.equal((html.match(/打开笔记/g) || []).length, 1);
  assert.equal((html.match(/<button/g) || []).length, 2);
  assert.ok(html.indexOf('取消完成') < html.indexOf('实际完成'));
});
