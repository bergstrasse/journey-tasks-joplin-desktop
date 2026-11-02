import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalIntentStore } from '../../src/adapters/joplin/localIntentStore';
import { MemoryJoplin } from '../support/memory-joplin';

test('issue64 warm outbox reads avoid IPC and failed writes preserve durable cache', async () => {
  const host = new MemoryJoplin();
  const local = new LocalIntentStore(host, () => 'device');
  await local.initialize();
  let reads = 0;
  const read = host.settings.value;
  host.settings.value = async key => { reads++; return read(key); };
  const intent = { id: 'pending', controlNoteId: '', phase: 'request-pending', updatedAt: 0, attempts: 0 };
  await local.put(intent);
  await local.all(); await local.all(); await local.nextId(); await local.nextId();
  assert.equal(reads, 0, 'warm outbox and device operations never reread settings');
  const write = host.settings.setValue;
  host.settings.setValue = async () => { throw new Error('disk full'); };
  await assert.rejects(local.remove(intent.id), /disk full/);
  assert.equal((await local.all()).length, 1);
  await assert.rejects(local.put({ ...intent, id: 'failed' }), /disk full/);
  assert.equal((await local.all()).length, 1);
  host.settings.setValue = write;
  const restarted = new LocalIntentStore(host, () => 'unused');
  await restarted.initialize();
  assert.deepEqual(await restarted.all(), await local.all());
  assert.equal((await restarted.nextId()).deviceSeq, 3);
  await local.clearOutbox();
  assert.deepEqual(await local.all(), []);
  await local.reset();
  assert.equal((await local.nextId()).deviceSeq, 1);
});

test('issue64 completing and reopening acknowledge immediately and roll back rejected commands with one snapshot', async () => {
  const React = await import('react');
  const { act, create } = await import('react-test-renderer');
  const { App } = await import('../../src/panel/App');
  const { TaskList } = await import('../../src/panel/TaskViews');
  const { TaskApplication } = await import('../../src/services/taskApplication');
  const { PanelController } = await import('../../src/panel/controller');
  const host = new MemoryJoplin();
  host.namespace = (await import('../../src/adapters/joplin/repositories')).DEFAULT_PLUGIN_ID;
  host.seedNote({ id: 'task', title: 'Task', is_todo: 1 });
  const app = new TaskApplication(host); await app.initialize();
  await app.dispatch({ action: 'savePreferences', requestId: 'view', preferences: { defaultView: 'inbox', showCompleted: true } });
  const controller = new PanelController({} as any, app);
  const names = ['window', 'document', 'webviewApi', 'IS_REACT_ACT_ENVIRONMENT'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  let invalidate!: (message: any) => void;
  let snapshots = 0;
  let release!: () => void;
  let reject = false;
  let gate: Promise<void>;
  const noop = () => {};
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { addEventListener: noop, removeEventListener: noop },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null },
    webviewApi: { onMessage: (fn: typeof invalidate) => { invalidate = fn; }, postMessage: async (message: any) => {
      if (message.action === 'snapshot') snapshots++;
      if (message.command) {
        await gate;
        invalidate({ type: 'invalidate' });
        if (reject) return { ok: false, code: 'WRITE_FAILED', error: 'write failed' };
      }
      return controller.handleMessage(message);
    } },
  });
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    const list = () => renderer!.root.findByType(TaskList);
    for (const fails of [false, true, false]) {
      reject = fails;
      gate = new Promise<void>(resolve => { release = resolve; });
      const before = list().props.items[0];
      snapshots = 0;
      await act(async () => { list().props.onComplete(before); });
      assert.equal(list().props.items[0].completed, !before.completed);
      await act(async () => { release(); });
      assert.equal(list().props.items[0].completed, fails ? before.completed : !before.completed);
      assert.equal(snapshots, 1, 'invalidation during command is coalesced into final snapshot');
    }
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

test('issue64 completing a native or managed task never rereads outbox shards', async () => {
  const { TaskApplication } = await import('../../src/services/taskApplication');
  const { DEFAULT_PLUGIN_ID } = await import('../../src/adapters/joplin/repositories');
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID; host.pageSize = 100;
  for (let i = 0; i < 2000; i++) host.seedNote({ id: `note-${i}`, is_todo: 0 });
  for (let i = 0; i < 300; i++) host.seedNote({ id: `task-${i}` });
  const app = new TaskApplication(host); await app.initialize();
  let reads = 0, writes = 0, outboxReads = 0;
  const read = host.settings.value, write = host.settings.setValue;
  host.settings.value = async key => { reads++; if (key.includes('outbox.')) outboxReads++; return read(key); };
  host.settings.setValue = async (key, value) => { writes++; return write(key, value); };
  try {
    for (const [index, action] of (['complete', 'reopen', 'complete'] as const).entries()) {
      reads = 0; writes = 0; outboxReads = 0; host.calls.length = 0;
      const result = await app.dispatch({ action, requestId: `measure-${index}`, noteId: 'task-0' });
      assert.equal(result.status, 'saved', result.message);
      assert.equal(outboxReads, 0);
      assert.ok(reads <= 12, `settings reads regressed: ${reads}`);
      console.log(`issue64 ${action} #${index}: settings ${reads} reads / ${writes} writes; data ${host.calls.length}; total ${reads + writes + host.calls.length}`);
    }
  } finally { app.dispose(); }
});
