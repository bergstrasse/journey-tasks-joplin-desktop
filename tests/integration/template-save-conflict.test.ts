import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { PanelController } from '../../src/panel/controller';
import { canRetryTemplateSave, sendTemplateCommand, PanelClientError } from '../../src/panel/client';
import { MemoryJoplin } from '../support/memory-joplin';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';

test('template save does not retry over a concurrent task title or series-rule edit', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  const app = new TaskApplication(host); await app.initialize();
  const originalApi = Object.getOwnPropertyDescriptor(globalThis, 'webviewApi');
  try {
    const created = await app.dispatch({ action: 'createTask', requestId: 'create', input: {
      title: 'Original title', notebookId: 'book', schedule: { kind: 'allDay', date: '2026-10-27', zone: 'Asia/Shanghai' },
      recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } }, mode: 'continuous',
    } });
    assert.equal(created.status, 'saved');
    const before = await app.snapshot();
    const command = { action: 'editTask' as const, requestId: 'save', noteId: created.noteId!, expectedSnapshotVersion: before.snapshotVersion, patch: { title: 'Original title' } };
    const rulesChanged = structuredClone(before);
    rulesChanged.series[0]!.definition!.rule.interval = 2;
    assert.equal(canRetryTemplateSave(command, before, rulesChanged), false);
    assert.equal(canRetryTemplateSave({ action: 'reviseSeries', requestId: 'revise', seriesId: created.seriesId!, revisionId: before.series[0]!.definition!.revisionId, definition: before.series[0]!.definition! }, before, rulesChanged), false);
    await host.data.put(['notes', created.noteId!], {}, { title: 'Changed elsewhere' });
    await app.dispatch({ action: 'refresh', requestId: 'host-refresh' });
    const controller = new PanelController({} as any, app);
    let commands = 0;
    Object.assign(globalThis, { webviewApi: { postMessage: async (message: any) => { if (message.action === 'command') commands++; return controller.handleMessage(message); } } });
    let receivedLatest = false;
    await assert.rejects(sendTemplateCommand(command, before, {}, () => { receivedLatest = true; }), (error: unknown) => error instanceof PanelClientError && error.code === 'STALE_SNAPSHOT');
    assert.equal(commands, 1, 'a real edit must not be automatically retried');
    assert.equal(receivedLatest, true, 'the panel still receives the latest snapshot');
    assert.equal(host.notes.get(created.noteId!)!.title, 'Changed elsewhere');
  } finally {
    app.dispose();
    if (originalApi) Object.defineProperty(globalThis, 'webviewApi', originalApi); else Reflect.deleteProperty(globalThis, 'webviewApi');
  }
});

test('date and completion retry on unrelated refresh only, never on a new current cycle', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID; host.notebooks.set('book', { id: 'book', title: 'Book' });
  const app = new TaskApplication(host, { now: () => Date.parse('2026-10-28T04:00:00Z') }); await app.initialize();
  try {
    const made = await app.dispatch({ action: 'createTask', requestId: 'create-retry', input: { title: 'Task', notebookId: 'book', schedule: { kind: 'allDay', date: '2026-10-28', zone: 'Asia/Shanghai' }, mode: 'continuous', recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } } } });
    const before = await app.snapshot();
    const complete = { action: 'complete' as const, requestId: 'complete', noteId: made.noteId!, seriesId: made.seriesId, occurrenceId: before.series[0]!.activeOccurrenceId };
    const date = { action: 'changeDate' as const, requestId: 'date', noteId: made.noteId!, schedule: before.tasks[0]!.schedule };
    await app.dispatch({ action: 'refresh', requestId: 'unrelated' });
    const unchanged = await app.snapshot();
    assert.equal(canRetryTemplateSave(complete, before, unchanged), true); assert.equal(canRetryTemplateSave(date, before, unchanged), true);
    await app.dispatch(complete);
    const next = await app.snapshot();
    assert.equal(canRetryTemplateSave(complete, before, next), false); assert.equal(canRetryTemplateSave(date, before, next), false);
  } finally { app.dispose(); }
});
