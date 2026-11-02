import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { MemoryJoplin } from '../support/memory-joplin';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import type { TaskInput } from '../../src/services/applicationTypes';
const start = Date.parse('2026-10-24T10:00:00Z');
const schedule = { kind: 'allDay' as const, date: '2026-10-24', zone: 'UTC' };
const input: TaskInput = { title: 'Log test', notebookId: 'book', schedule };
function setup() {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  let now = start, id = 0;
  const options = { now: () => now, randomId: () => String(++id).padStart(32, '0') };
  return { host, options, app: new TaskApplication(host, options), tick: () => { now += 60000; return now; } };
}
test('single task log preserves date changes and actual completion/reopen across restart', async () => {
  const { host, options, app, tick } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'create', input });
  assert.equal(created.status, 'saved', created.message);
  const noteId = created.noteId!;
  tick();
  const changed = await app.dispatch({ action: 'changeDate', requestId: 'date', noteId, schedule: { ...schedule, date: '2026-10-23' } });
  assert.equal(changed.status, 'saved', changed.message);
  const completedAt = tick();
  assert.equal((await app.dispatch({ action: 'complete', requestId: 'complete', noteId })).status, 'saved');
  tick();
  assert.equal((await app.dispatch({ action: 'reopen', requestId: 'reopen', noteId })).status, 'saved');
  const log = (await app.snapshot()).taskLogs![noteId]!;
  assert.equal(log.filter(e => e.kind === 'created').length, 1);
  assert.equal(log.find(e => e.kind === 'completed')?.at, completedAt);
  assert.ok(log.some(e => e.kind === 'reopened'));
  const change = log.flatMap(e => e.changes).find(c => c.field === 'schedule')!;
  assert.equal((change.before as typeof schedule).date, '2026-10-24');
  assert.equal((change.after as typeof schedule).date, '2026-10-23');
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.deepEqual((await restarted.snapshot()).taskLogs![noteId], log);
});
test('series log includes rule before/after and actual occurrence completion', async () => {
  const { app, tick } = setup(); await app.initialize();
  const recurrence = { calendar: 'gregorian' as const, frequency: 'daily' as const, basis: 'scheduled' as const, interval: 1, end: { kind: 'never' as const } };
  const created = await app.dispatch({ action: 'createTask', requestId: 'repeat', input: { ...input, recurrence } });
  assert.equal(created.status, 'saved', created.message);
  const before = (await app.snapshot()).series[0]!;
  tick();
  const changed = await app.dispatch({ action: 'reviseSeries', requestId: 'rule', seriesId: before.seriesId, revisionId: before.definition!.revisionId,
    definition: { ...before.definition!, rule: { ...recurrence, interval: 2 } } });
  assert.equal(changed.status, 'saved', changed.message);
  const completedAt = tick();
  const done = await app.dispatch({ action: 'complete', requestId: 'done', seriesId: before.seriesId, occurrenceId: before.activeOccurrenceId });
  assert.equal(done.status, 'saved', done.message);
  const log = (await app.snapshot()).taskLogs![before.seriesId]!;
  const ruleChange = log.filter(e => e.kind === 'modified').flatMap(e => e.changes).find(c => c.field === 'rule')!;
  assert.equal((ruleChange.before as typeof recurrence).interval, 1);
  assert.equal((ruleChange.after as typeof recurrence).interval, 2);
  assert.equal(log.find(e => e.kind === 'completed')?.at, completedAt);
  assert.equal(log.find(e => e.kind === 'completed')?.occurrenceId, before.activeOccurrenceId);
});
test('legacy native task exposes known creation/completion times without invented edits', async () => {
  const { host, app } = setup();
  host.seedNote({ id: 'legacy', parent_id: 'book', created_time: start - 100000, todo_completed: start - 1000 });
  await app.initialize();
  const log = (await app.snapshot({ showCompleted: true })).taskLogs!.legacy!;
  assert.deepEqual(log.map(e => [e.kind, e.at]), [['completed', start - 1000], ['created', start - 100000]]);
});
test('converting a single task to recurring retains its earlier date changes in the series log', async () => {
  const { app, tick } = setup(); await app.initialize();
  const created = await app.dispatch({ action: 'createTask', requestId: 'convert-source', input });
  tick();
  await app.dispatch({ action: 'changeDate', requestId: 'source-date', noteId: created.noteId!, schedule: { ...schedule, date: '2026-10-23' } });
  tick();
  const converted = await app.dispatch({ action: 'editTask', requestId: 'convert', noteId: created.noteId!, patch: {
    recurrence: { calendar: 'gregorian', frequency: 'daily', basis: 'scheduled', interval: 1, end: { kind: 'never' } }, mode: 'continuous',
  } });
  assert.equal(converted.status, 'saved', converted.message);
  const snapshot = await app.snapshot();
  const log = snapshot.taskLogs![snapshot.series[0]!.seriesId]!;
  assert.ok(log.some(e => e.kind === 'seriesCreated'));
  assert.ok(log.some(e => e.kind === 'modified' && e.changes.some(c => c.field === 'schedule' && (c.before as typeof schedule)?.date === '2026-10-24')));
});
