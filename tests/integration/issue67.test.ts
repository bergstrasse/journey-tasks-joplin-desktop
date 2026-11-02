import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { App } from '../../src/panel/App';
import { TaskContextMenu } from '../../src/panel/TaskContextMenu';
import { TaskApplication } from '../../src/services/taskApplication';
import { MemoryJoplin } from '../support/memory-joplin';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';

test('issue67: 2000 tasks retain untouched row renders during menu, pending command and cloned snapshots', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  const app = new TaskApplication(host); await app.initialize();
  const snapshot = await app.snapshot({ view: 'all' });
  snapshot.preferences.language = 'en';
  snapshot.items = Array.from({ length: 2000 }, (_, index) => ({
    id: `task-${index}`, taskId: `task-${index}`, noteId: `task-${index}`, kind: 'actual' as const,
    title: `Task ${index}`, notebookId: 'book', tagIds: [], schedule: { kind: 'none' as const },
    date: '', completed: false, completedAt: 0, overdue: false, priority: 'none' as const, pinned: false, reminder: { enabled: false },
  }));
  snapshot.tasks = snapshot.items.map(item => ({ ...item, taskId: item.id, noteId: item.noteId!, notebookId: 'book', tagIds: [], completedAt: 0, reminder: { enabled: false } }));
  const names = ['window', 'document', 'navigator', 'webviewApi', 'IS_REACT_ACT_ENVIRONMENT'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const noop = () => {};
  let invalidate!: (event: any) => void;
  let release!: () => void;
  let reject = false;
  let gate: Promise<void>;
  let snapshots = 0;
  const values = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { addEventListener: noop, removeEventListener: noop, innerWidth: 1000, innerHeight: 800 },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    navigator: { platform: 'MacIntel' },
    webviewApi: { onMessage: (handler: typeof invalidate) => { invalidate = handler; }, postMessage: async (message: any) => {
      if (message.action === 'snapshot') { snapshots++; return { ok: true, snapshot: structuredClone(snapshot) }; }
      await gate;
      if (reject) return { ok: false, code: 'WRITE_FAILED', error: 'write failed' };
      const command = message.command;
      if (command.action === 'changeDate') {
        snapshot.items[0] = { ...snapshot.items[0]!, date: command.schedule.date, schedule: command.schedule };
        snapshot.tasks[0] = { ...snapshot.tasks[0]!, schedule: command.schedule };
        snapshot.snapshotVersion++;
      }
      return { ok: true, result: { status: 'saved', requestId: command.requestId } };
    } },
  };
  Object.entries(values).forEach(([name, value]) => Object.defineProperty(globalThis, name, { configurable: true, value }));
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    const rows = () => renderer!.root.findAllByType('article');
    assert.equal(rows().length, 2000);
    const unchanged = rows().slice(1).map(row => row.props.onContextMenu);
    const assertUntouched = () => assert.deepEqual(rows().slice(1).map(row => row.props.onContextMenu), unchanged, 'unaffected rows must skip rendering');
    const open = async () => act(async () => rows()[0]!.props.onContextMenu({ preventDefault: noop, clientX: 20, clientY: 20, currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } }));
    await open(); assertUntouched();
    assert.equal(rows()[0]!.props['data-selected'], true);
    await act(async () => renderer!.root.findByType(TaskContextMenu).props.onClose()); assertUntouched();
    for (const fails of [false, true]) {
      reject = fails;
      await open();
      gate = new Promise<void>(resolve => { release = resolve; });
      snapshots = 0;
      let command!: Promise<unknown>;
      await act(async () => { command = renderer!.root.findByType(TaskContextMenu).props.onCommand([{ action: 'changeDate', noteId: 'task-0', schedule: { kind: 'allDay', date: '2026-10-31', zone: 'Asia/Shanghai' } }]); });
      assertUntouched();
      assert.equal(rows()[0]!.findByType('input').props.disabled, true);
      await act(async () => { release(); await command; });
      assertUntouched();
      assert.equal(snapshots, 1, 'successful and failed writes still refresh authoritatively');
      assert.equal(rows()[0]!.findByType('time').props.dateTime, '2026-10-31');
      if (fails) assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).some(node => node.children.includes('write failed')), true);
      await act(async () => renderer!.root.findByType(TaskContextMenu).props.onClose());
    }
    await act(async () => invalidate({ type: 'invalidate' })); assertUntouched();
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, index) => { const original = originals[index]; if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); });
  }
});
