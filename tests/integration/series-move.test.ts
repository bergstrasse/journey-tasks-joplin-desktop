import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';
import { templateNote } from '../support/template-note';

async function setup(mode: 'archive' | 'continuous' = 'archive') {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  for (const id of ['A', 'B', 'C', 'D']) host.notebooks.set(id, { id, title: id });
  let sequence = 0;
  let now = Date.parse('2026-10-25T04:00:00Z');
  const options = { now: () => now, randomId: () => (++sequence).toString(16).padStart(32, '0') };
  const app = new TaskApplication(host, options); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'create', input: {
    title: 'Series', body: templateNote('original template'), notebookId: 'A', mode,
    schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' },
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
  } });
  assert.equal(made.status, 'saved', made.message);
  const summary = async (target = app) => (await target.snapshot()).series[0]!;
  const active = async () => { const s = await summary(); return s.occurrences.find(o => o.occurrenceId === s.activeOccurrenceId)!; };
  const complete = async (requestId: string) => {
    now += 86400000;
    const result = await app.dispatch({ action: 'complete', requestId, noteId: (await active()).carrierNoteId });
    assert.equal(result.status, 'saved', result.message);
  };
  const move = async (noteId: string, notebookId: string, requestId: string) => {
    const result = await app.dispatch({ action: 'moveTask', requestId, noteId, notebookId });
    assert.equal(result.status, 'saved', result.message);
  };
  return { host, app, options, made, summary, active, complete, move };
}

test('single moves do not change archive destination or first-note template/tag source', async () => {
  const { host, app, made, complete, active, move, summary, options } = await setup();
  host.tags.set('root-tag', { id: 'root-tag', title: 'Root' });
  host.noteTagIds.set(made.noteId!, new Set(['root-tag']));
  await complete('first');
  const second = (await active()).carrierNoteId;
  await move(made.noteId!, 'C', 'move-root');
  await move(second, 'B', 'move-current');
  host.notes.get(made.noteId!)!.body = templateNote('edited first template');
  host.notes.get(second)!.body = 'current execution only';
  host.noteTagIds.set(second, new Set());
  await complete('second');
  const third = (await active()).carrierNoteId;
  assert.equal(host.notes.get(third)!.parent_id, 'A');
  assert.equal(host.notes.get(third)!.body, 'edited first template');
  assert.deepEqual([...host.noteTagIds.get(third)!], ['root-tag']);
  assert.equal(host.notes.get(made.noteId!)!.parent_id, 'C');
  assert.equal(host.notes.get(second)!.parent_id, 'B');
  assert.equal((await summary()).definition!.sourceNotebookId, 'A');
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal((await restarted.snapshot()).series[0]!.definition!.sourceNotebookId, 'A');
  assert.equal((await app.snapshot()).series[0]!.anchorNoteId, made.noteId);
});

test('series move gathers scattered history and current, preserving IDs/body/rule; same destination requires explicit opt-in', async () => {
  const { host, app, made, complete, active, move, summary } = await setup();
  await complete('first'); const second = (await active()).carrierNoteId;
  await complete('second'); const third = (await active()).carrierNoteId;
  await move(made.noteId!, 'B', 'root'); await move(second, 'C', 'history');
  await move(third, 'B', 'current');
  host.seedNote({ id: 'unrelated', parent_id: 'A', body: 'unrelated' });
  const before = new Map([...host.notes].map(([id, note]) => [id, note.body]));
  const s = await summary();
  const result = await app.dispatch({ action: 'reviseSeries', requestId: 'series-move', seriesId: s.seriesId,
    revisionId: s.definition!.revisionId, definition: { ...s.definition!, sourceNotebookId: 'D' }, moveSeries: true });
  assert.equal(result.status, 'saved', result.message);
  for (const id of [made.noteId!, second, third]) {
    assert.equal(host.notes.get(id)!.parent_id, 'D'); assert.equal(host.notes.get(id)!.body, before.get(id));
  }
  assert.equal(host.notes.size, before.size);
  assert.equal(host.notes.get('unrelated')!.parent_id, 'A');
  assert.deepEqual((await summary()).definition!.rule, s.definition!.rule);
  assert.deepEqual((await summary()).definition!.anchor, s.definition!.anchor);
  await move(second, 'B', 'move-history-again');
  let latest = await summary();
  assert.equal((await app.dispatch({ action: 'reviseSeries', requestId: 'other-edit', seriesId: latest.seriesId,
    revisionId: latest.definition!.revisionId, definition: { ...latest.definition!, priority: 'high' } })).status, 'saved');
  assert.equal(host.notes.get(second)!.parent_id, 'B');
  latest = await summary();
  assert.equal((await app.dispatch({ action: 'reviseSeries', requestId: 'gather-same', seriesId: latest.seriesId,
    revisionId: latest.definition!.revisionId, definition: latest.definition!, moveSeries: true })).status, 'saved');
  assert.equal(host.notes.get(second)!.parent_id, 'D');
  await complete('third'); assert.equal(host.notes.get((await active()).carrierNoteId)!.parent_id, 'D');
});

for (const afterCommit of [false, true]) test(`partial series move reports failure and resumes after restart (lost reply=${afterCommit})`, async () => {
  const { host, app, options, made, complete, active, summary } = await setup();
  await complete('first'); const second = (await active()).carrierNoteId;
  const s = await summary();
  host.failNext('put', `notes/${second}`, afterCommit);
  const result = await app.dispatch({ action: 'reviseSeries', requestId: 'interrupted-move', seriesId: s.seriesId,
    revisionId: s.definition!.revisionId, definition: { ...s.definition!, sourceNotebookId: 'D' }, moveSeries: true });
  assert.equal(result.status, 'error'); assert.equal(result.code, 'SERIES_MOVE_PENDING');
  assert.equal(host.notes.get(made.noteId!)!.parent_id, 'D');
  assert.ok((await app.local.all()).some(i => i.phase === 'series-move'));
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  for (const id of [made.noteId!, second]) assert.equal(host.notes.get(id)!.parent_id, 'D');
  assert.ok(!(await restarted.local.all()).some(i => i.phase === 'series-move'));
});

test('continuous series moves its shared note once without duplicating it', async () => {
  const { host, app, made, complete, summary } = await setup('continuous');
  await complete('first'); await complete('second');
  const s = await summary(); const start = host.calls.length;
  const result = await app.dispatch({ action: 'reviseSeries', requestId: 'move-continuous', seriesId: s.seriesId,
    revisionId: s.definition!.revisionId, definition: { ...s.definition!, sourceNotebookId: 'D' }, moveSeries: true });
  assert.equal(result.status, 'saved', result.message);
  assert.equal(host.notes.size, 1); assert.equal(host.notes.get(made.noteId!)!.parent_id, 'D');
  assert.equal(host.calls.slice(start).filter(c => c.method === 'put' && c.body?.parent_id === 'D').length, 1);
});

test('invalid series notebook is rejected before saving a revision or moving any note', async () => {
  const { app, host, made, summary } = await setup(); const s = await summary();
  const result = await app.dispatch({ action: 'reviseSeries', requestId: 'invalid', seriesId: s.seriesId,
    revisionId: s.definition!.revisionId, definition: { ...s.definition!, sourceNotebookId: 'missing' }, moveSeries: true });
  assert.equal(result.status, 'error'); assert.equal(result.code, 'NOTEBOOK_MISSING');
  assert.equal((await summary()).definition!.revisionId, s.definition!.revisionId);
  assert.equal(host.notes.get(made.noteId!)!.parent_id, 'A');
});

test('series move leaves trashed history in trash and does not recreate it', async () => {
  const { host, app, made, complete, active, summary } = await setup();
  await complete('first'); const second = (await active()).carrierNoteId;
  await complete('second'); const third = (await active()).carrierNoteId;
  host.notes.get(second)!.deleted_time = Date.parse('2026-10-28T00:00:00Z');
  const s = await summary(); const count = host.notes.size;
  const result = await app.dispatch({ action: 'reviseSeries', requestId: 'move-with-trash', seriesId: s.seriesId,
    revisionId: s.definition!.revisionId, definition: { ...s.definition!, sourceNotebookId: 'D' }, moveSeries: true });
  assert.equal(result.status, 'saved', result.message);
  assert.equal(host.notes.get(made.noteId!)!.parent_id, 'D'); assert.equal(host.notes.get(third)!.parent_id, 'D');
  assert.equal(host.notes.get(second)!.parent_id, 'A'); assert.ok(host.notes.get(second)!.deleted_time);
  assert.equal(host.notes.size, count);
});

test('missing series history remains pending instead of reporting a completed move', async () => {
  const { host, app, complete, active, summary } = await setup();
  await complete('first'); const second = (await active()).carrierNoteId;
  await complete('second'); const missing = structuredClone(host.notes.get(second)!); host.notes.delete(second);
  const s = await summary();
  const result = await app.dispatch({ action: 'reviseSeries', requestId: 'move-missing-history', seriesId: s.seriesId,
    revisionId: s.definition!.revisionId, definition: { ...s.definition!, sourceNotebookId: 'D' }, moveSeries: true });
  assert.equal(result.status, 'error'); assert.equal(result.code, 'SERIES_MOVE_PENDING');
  assert.equal(host.notes.has(second), false);
  host.notes.set(second, missing);
  await app.dispatch({ action: 'refresh', requestId: 'sync-history' });
  assert.equal(host.notes.get(second)!.parent_id, 'D');
  assert.ok(!(await app.local.all()).some(i => i.phase === 'series-move'));
});
