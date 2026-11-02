import { templateNote } from '../support/template-note';
import test from 'node:test';
import { buildArchiveBody } from '../support/body-template';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';
import { withoutAnchorNotice } from '../support/note-body';

const now = Date.parse('2026-10-24T02:00:00Z');
function appFor(host: MemoryJoplin, device: string) {
  host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: '工作' });
  let sequence = 0;
  return new TaskApplication(host, { now: () => now, randomId: () => device + String(++sequence).padStart(30, '0') });
}
/** Transfers an explicit union of immutable keys. This is NOT Joplin's real sync implementation. */
function merge(a: MemoryJoplin, b: MemoryJoplin) {
  const ids = new Set([...a.notes.keys(), ...b.notes.keys()]);
  for (const id of ids) {
    const left = a.notes.get(id), right = b.notes.get(id);
    const note = structuredClone(left || right!);
    const l = JSON.parse(left?.user_data || '{}'), r = JSON.parse(right?.user_data || '{}');
    for (const ns of new Set([...Object.keys(l), ...Object.keys(r)])) l[ns] = { ...l[ns], ...r[ns] };
    note.user_data = JSON.stringify(l);
    a.notes.set(id, structuredClone(note)); b.notes.set(id, structuredClone(note));
  }
  for (const [id, folder] of a.notebooks) if (!b.notebooks.has(id)) b.notebooks.set(id, structuredClone(folder));
  for (const [id, folder] of b.notebooks) if (!a.notebooks.has(id)) a.notebooks.set(id, structuredClone(folder));
}

test('offline devices completing same archived occurrence converge to one logical successor without discarding content', async () => {
  const a = new MemoryJoplin(), b = new MemoryJoplin();
  const aa = appFor(a, 'A'); await aa.initialize();
  const made = await aa.dispatch({ action: 'createTask', requestId: 'sync-create', input: {
    title: '周报', body: templateNote('本期已编辑记录'), notebookId: 'book', schedule: { kind: 'allDay', date: '2026-10-24', zone: 'Asia/Shanghai' },
    mode: 'archive',
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
  } });
  assert.equal(made.status, 'saved', made.message);
  await a.data.put(['notes', made.noteId!], {}, { body: buildArchiveBody('本期已编辑记录', '- [ ] 新周期') });
  const first = (await aa.snapshot()).series[0]!.activeOccurrenceId!;
  merge(a, b);
  const bb = appFor(b, 'B'); await bb.initialize();
  assert.equal((await aa.dispatch({ action: 'complete', requestId: 'a-done', seriesId: made.seriesId, occurrenceId: first })).status, 'saved');
  assert.equal((await bb.dispatch({ action: 'complete', requestId: 'b-done', seriesId: made.seriesId, occurrenceId: first })).status, 'saved');
  merge(a, b);
  await aa.dispatch({ action: 'refresh', requestId: 'a-sync' });
  await bb.dispatch({ action: 'refresh', requestId: 'b-sync' });
  const sa = await aa.snapshot({ view: 'month', date: '2026-10-24' }), sb = await bb.snapshot({ view: 'month', date: '2026-10-24' });
  assert.equal(sa.series[0]?.consumedCount, 1); assert.equal(sb.series[0]?.consumedCount, 1);
  assert.equal(sa.series[0]?.activeOccurrenceId, sb.series[0]?.activeOccurrenceId);
  assert.equal(sa.items.filter(i => i.kind === 'actual' && i.date === '2026-10-25').length, 1);
  assert.equal(withoutAnchorNotice(a.notes.get(made.noteId!)?.body), '本期已编辑记录\n');
  const childNotes = [...a.notes.values()].filter(n => n.id !== made.noteId);
  assert.equal(childNotes.length, 2, 'two offline physical candidates remain as recoverable data');
  assert.equal(childNotes.filter(n => n.is_todo).length, 1, 'unmodified noncanonical candidate is deactivated');
  assert.ok(childNotes.every(n => n.body === '- [ ] 新周期'));
});
