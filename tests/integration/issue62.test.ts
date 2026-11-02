import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TaskApplication } from '../../src/services/taskApplication';
import { MemoryJoplin } from '../support/memory-joplin';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { App } from '../../src/panel/App';
import { TaskList } from '../../src/panel/TaskViews';
import { TaskContextMenu } from '../../src/panel/TaskContextMenu';
import { PanelController } from '../../src/panel/controller';

async function setup(count = 2) {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  const app = new TaskApplication(host); await app.initialize();
  for (let i = 0; i < count; i++) {
    const result = await app.dispatch({ action: 'createTask', requestId: `create-${i}`, input: {
      title: `Task ${i}`, notebookId: 'book', schedule: { kind: 'none' },
    } });
    assert.equal(result.status, 'saved', result.message);
  }
  await app.dispatch({ action: 'savePreferences', requestId: 'inbox', preferences: { defaultView: 'inbox', startupMode: 'fixed' } });
  return { app, host };
}

test('issue62 pin/date/save/completion only access the affected task, independent of other tasks and old logs', async () => {
  const { app, host } = await setup(25);
  const task = (await app.snapshot()).tasks[0]!;
  for (let i = 0; i < 15; i++) await app.dispatch({ action: 'setFields', requestId: `history-${i}`, noteId: task.noteId, pinned: !!(i % 2) });
  const commands = [
    { action: 'setFields' as const, noteId: task.noteId, pinned: true },
    { action: 'changeDate' as const, noteId: task.noteId, schedule: { kind: 'allDay' as const, date: '2020-01-01', zone: 'UTC' } },
    { action: 'editTask' as const, noteId: task.noteId, patch: { title: 'Saved' } },
    { action: 'complete' as const, noteId: task.noteId },
  ];
  for (const [index, command] of commands.entries()) {
    host.calls.length = 0;
    const result = await app.dispatch({ ...command, requestId: `measured-${index}` });
    assert.equal(result.status, 'saved', result.message);
    assert.ok(!host.calls.some(call => ['notes', 'tags', 'folders'].includes(call.path[0]!) && call.path.length === 1), 'no global enumeration');
    assert.ok(host.calls.filter(call => call.path[0] === 'notes' && call.path[1]).every(call => call.path[1] === task.noteId), 'no reads of unrelated notes');
    assert.ok(host.calls.filter(call => call.method === 'userDataGet').every(call => call.path[0] === task.noteId), 'no replay of unrelated journals');
    assert.ok(host.calls.length < 50, `${command.action}: ${host.calls.length} IPC calls`);
  }
  const snapshot = await app.snapshot();
  assert.equal(snapshot.tasks.length, 25);
  assert.equal(snapshot.tasks.find(value => value.noteId === task.noteId)!.title, 'Saved');
  const version = snapshot.snapshotVersion;
  host.calls.length = 0;
  await app.dispatch({ action: 'refresh', requestId: 'self-event', noteIds: [task.noteId] });
  assert.equal(host.calls.length, 2, 'self event only checks the note and tags');
  assert.equal((await app.snapshot()).snapshotVersion, version);
  app.dispose();
});

test('issue62 cached journals still reject a synchronized edit to an existing operation', async () => {
  const { app, host } = await setup(1);
  const task = (await app.snapshot()).tasks[0]!;
  const namespace = JSON.parse(host.notes.get(task.noteId)!.user_data)[DEFAULT_PLUGIN_ID];
  const key = Object.keys(namespace).find(key => key.startsWith('v3:op:'))!;
  const operation = structuredClone(namespace[key].v); operation.payloadHash = 'corrupt';
  await host.data.userDataSet(1, task.noteId, key, operation);
  await app.dispatch({ action: 'refresh', requestId: 'sync-tamper', noteIds: [task.noteId] });
  assert.ok((await app.snapshot()).diagnostics.some(item => item.code === 'CONTROL_READ_ONLY'));
  app.dispose();
});

test('issue62 pin renders before acknowledgement, leaves other rows enabled and rolls back on failure', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { app } = await setup();
  const controller = new PanelController({} as any, app);
  const names = ['window', 'document', 'webviewApi'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const noop = () => {};
  Object.assign(globalThis, {
    window: { addEventListener: noop, removeEventListener: noop },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    webviewApi: { onMessage: noop, postMessage: async (message: any) => {
      if (message.command?.action === 'setFields') {
        await gate;
        return { ok: true, result: { status: 'error', code: 'COMMAND_FAILED', message: 'Rejected' } };
      }
      return controller.handleMessage(message);
    } },
  });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    const lists = () => renderer!.root.findAllByType(TaskList);
    const item = lists().flatMap(list => list.props.items)[0]!;
    await act(async () => lists()[0]!.props.onMenu(item, { preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } }));
    let saving: Promise<unknown>;
    await act(async () => { saving = renderer!.root.findByType(TaskContextMenu).props.onCommand([{ action: 'setFields', noteId: item.noteId, pinned: true }]); });
    assert.equal(lists().flatMap(list => list.props.items).find(value => value.noteId === item.noteId)!.pinned, true);
    const checkboxes = renderer!.root.findAllByType('input').filter(node => node.props.type === 'checkbox' && node.props['aria-label']);
    assert.equal(checkboxes.filter(node => node.props.disabled).length, 1);
    assert.equal(checkboxes.filter(node => !node.props.disabled).length, 1);
    const other = lists().flatMap(list => list.props.items).find(value => value.noteId !== item.noteId)!;
    let queued: Promise<unknown>;
    await act(async () => { queued = renderer!.root.findByType(TaskContextMenu).props.onCommand([{ action: 'complete', noteId: other.noteId }]); });
    await act(async () => { release(); await saving!; await queued!; });
    assert.ok((await app.snapshot()).tasks.find(value => value.noteId === other.noteId)!.completedAt, 'another row action is queued and saved even when the first action fails');
    assert.equal(lists().flatMap(list => list.props.items).find(value => value.noteId === item.noteId)!.pinned, false);
  } finally {
    release();
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

test('issue62 a successful incremental command clears the previous command failure', async () => {
  const { app } = await setup(1);
  const task = (await app.snapshot()).tasks[0]!;
  const failed = await app.dispatch({ action: 'setFields', requestId: 'missing', noteId: 'missing-note', pinned: true });
  assert.equal(failed.status, 'error');
  assert.ok((await app.snapshot()).diagnostics.some(item => item.code === failed.code));
  const saved = await app.dispatch({ action: 'setFields', requestId: 'recover-command', noteId: task.noteId, pinned: true });
  assert.equal(saved.status, 'saved');
  assert.deepEqual((await app.snapshot()).diagnostics, []);
  app.dispose();
});

test('issue62 incremental recovery clears series-only diagnostics and preserves unrelated warnings', async () => {
  const { app } = await setup(2);
  const tasks = (await app.snapshot()).tasks;
  const contexts = [...(app as any).singles.values()] as { noteId: string; meta: { seriesId: string } }[];
  const target = contexts.find(context => context.noteId === tasks[0]!.noteId)!;
  const other = contexts.find(context => context.noteId === tasks[1]!.noteId)!;
  // Inject the same diagnostic shape emitted by series reconciliation/overlap detection.
  (app as any).addDiagnostic('SERIES_RECONCILE', 'Recovered series warning', target.meta.seriesId);
  (app as any).addDiagnostic('OVERLAPPING_SERIES', 'Unrelated series warning', other.meta.seriesId);
  (app as any).addDiagnostic('CONTROL_READ_ONLY', 'Unrelated note warning', undefined, tasks[1]!.noteId);
  (app as any).singles.delete(target.meta.seriesId); // Failed discovery may have left no reduced context.
  await app.dispatch({ action: 'refresh', requestId: 'recover-series', noteIds: [tasks[0]!.noteId] });
  const diagnostics = (await app.snapshot()).diagnostics;
  assert.ok(!diagnostics.some(item => item.seriesId === target.meta.seriesId));
  assert.ok(diagnostics.some(item => item.seriesId === other.meta.seriesId));
  assert.ok(diagnostics.some(item => item.noteId === tasks[1]!.noteId));
  app.dispose();
});

test('issue62 focus checks discover background edits, creations and deletions with throttled metadata reads', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID; host.pageSize = 100;
  let now = 10000;
  for (let i = 0; i < 250; i++) host.seedNote({ id: `background-${i}` });
  const app = new TaskApplication(host, { now: () => now }); await app.initialize();
  host.calls.length = 0;
  const version = (await app.snapshot()).snapshotVersion;
  await app.dispatch({ action: 'refresh', requestId: 'focus-first', checkChanges: true });
  assert.equal((await app.snapshot()).snapshotVersion, version);
  assert.equal(host.calls.length, 4, 'unchanged focus reads three note metadata pages and the native notebook tree');
  assert.ok(host.calls.filter(call => call.path[0] === 'notes').every(call => call.query.fields.length === 5 && !call.query.fields.includes('body') && !call.query.fields.includes('user_data')));
  assert.equal(host.calls.find(call => call.path[0] === 'folders')?.query.as_tree, 1);
  await host.data.put(['notes', 'background-1'], {}, { title: 'External edit', todo_completed: now });
  host.seedNote({ id: 'external-created', title: 'External creation' });
  await host.data.delete(['notes', 'background-2']);
  host.calls.length = 0;
  await app.dispatch({ action: 'refresh', requestId: 'focus-throttled', checkChanges: true });
  assert.equal(host.calls.length, 0);
  now += 5000;
  await app.dispatch({ action: 'refresh', requestId: 'focus-after-throttle', checkChanges: true });
  const snapshot = await app.snapshot({ showCompleted: true });
  assert.equal(snapshot.tasks.find(task => task.noteId === 'background-1')!.title, 'External edit');
  assert.ok(snapshot.tasks.find(task => task.noteId === 'background-1')!.completedAt);
  assert.ok(snapshot.tasks.some(task => task.noteId === 'external-created'));
  assert.ok(!snapshot.tasks.some(task => task.noteId === 'background-2'));
  assert.ok(!host.calls.some(call => call.method === 'userDataGet'));
  assert.ok(host.calls.filter(call => call.path[0] === 'notes' && call.path[1]).every(call => ['background-1', 'background-2', 'external-created'].includes(call.path[1]!)));
  app.dispose();
});

test('issue62 batches share the single-command queue and reserve their rows until completion', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { app } = await setup(4);
  const controller = new PanelController({} as any, app);
  const names = ['window', 'document', 'webviewApi'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const listeners = new Map<string, () => void>();
  const commands: string[] = [];
  const replies: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const noop = () => {};
  Object.assign(globalThis, {
    window: { addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: noop },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    webviewApi: { onMessage: noop, postMessage: async (message: any) => {
      if (message.command) {
        commands.push(message.command.action + ':' + (message.command.noteId || ''));
        if (commands.length === 1) await gate;
      }
      const reply = await controller.handleMessage(message);
      if (message.command) replies.push(reply);
      return reply;
    } },
  });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    const lists = () => renderer!.root.findAllByType(TaskList);
    const items = lists().flatMap(list => list.props.items);
    await act(async () => lists()[0]!.props.onMenu(items[0], { preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } }));
    const menu = () => renderer!.root.findByType(TaskContextMenu);
    let first!: Promise<unknown>, batch!: Promise<unknown>, last!: Promise<unknown>;
    await act(async () => { first = menu().props.onCommand([{ action: 'setFields', noteId: items[0].noteId, pinned: true }]); });
    await act(async () => { batch = menu().props.onCommand(items.slice(1, 3).map(item => ({ action: 'setFields', noteId: item.noteId, pinned: true }))); });
    await act(async () => { last = menu().props.onCommand([{ action: 'complete', noteId: items[3].noteId }]); });
    assert.equal(lists().flatMap(list => list.props.items).find(item => item.noteId === items[3].noteId).completed, true, 'queued completion is immediately visible');
    assert.equal(commands.length, 1, 'batch waits for the in-flight single command');
    assert.equal(renderer!.root.findAllByType('input').filter(node => node.props.type === 'checkbox' && node.props['aria-label'] && node.props.disabled).length, 4);
    await act(async () => { release(); await first; await batch; await last; });
    assert.deepEqual(commands, items.map((item, index) => `${index === 3 ? 'complete' : 'setFields'}:${item.noteId}`));
    assert.ok(replies.every(reply => reply.result?.status === 'saved'), JSON.stringify(replies));
    const snapshot = await app.snapshot({ showCompleted: true });
    assert.equal(snapshot.tasks.filter(task => task.pinned).length, 3);
    assert.ok(snapshot.tasks.find(task => task.noteId === items[3].noteId)!.completedAt);
    await act(async () => { listeners.get('focus')!(); await new Promise(resolve => setTimeout(resolve, 180)); });
    assert.equal(commands.at(-1), 'refresh:', 'focus runs a native change check through the shared queue');
  } finally {
    release();
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});
