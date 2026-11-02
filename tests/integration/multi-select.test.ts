import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { App } from '../../src/panel/App';
import { TaskContextMenu } from '../../src/panel/TaskContextMenu';
import { TaskApplication } from '../../src/services/taskApplication';
import { PanelController } from '../../src/panel/controller';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) test(`multi-selection and batch pin across list/day/week/month on ${platform}`, async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  const app = new TaskApplication(host); await app.initialize();
  const controller = new PanelController({} as any, app);
  const date = new Date().toLocaleDateString('sv-SE');
  for (const title of ['One', 'Two', 'Three']) await app.dispatch({ action: 'createTask', requestId: title, input: { title, notebookId: 'book', schedule: { kind: 'allDay', date, zone: 'Asia/Shanghai' } } });
  const names = ['window', 'document', 'navigator', 'webviewApi'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const noop = () => {};
  let clickOutside: ((event: any) => void) | undefined;
  for (const [name, value] of Object.entries({
    window: { addEventListener: noop, removeEventListener: noop, innerWidth: 1000, innerHeight: 800 },
    document: { documentElement: {}, addEventListener: (type: string, handler: any) => { if (type === 'click') clickOutside = handler; }, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    navigator: { platform },
    webviewApi: { onMessage: noop, postMessage: (message: any) => controller.handleMessage(message) },
  })) Object.defineProperty(globalThis, name, { configurable: true, value });
  let renderer: ReactTestRenderer | undefined;
  try {
    for (const view of ['today', 'day', 'week', 'month'] as const) {
      await app.dispatch({ action: 'savePreferences', requestId: view, preferences: { language: 'en', lastView: view, startupMode: 'restore' } } as any);
      await act(async () => { renderer = create(React.createElement(App)); });
      const rows = () => renderer!.root.findAllByType('article');
      assert.equal(rows().length, 3, view);
      for (const index of [0, 1, 0, 0]) await act(async () => rows()[index]!.props.onClickCapture({ metaKey: platform === 'MacIntel', ctrlKey: platform !== 'MacIntel', preventDefault: noop, stopPropagation: noop }));
      assert.equal(rows().filter(row => row.props['data-selected']).length, 2);
      if (view === 'day') {
        const entries = renderer!.root.findAll(node => node.type === 'div' && node.props.className?.startsWith('timeline-entry'));
        assert.equal(entries.length, 3);
        assert.equal(entries.filter(entry => entry.props['data-selected']).length, 2, 'day selection includes the time and timeline node');
      }

      assert.ok(clickOutside);
      for (const selector of ['.task-row', '.task-menu']) {
        await act(async () => clickOutside!({ target: { closest: () => ({ className: selector }) } }));
        assert.equal(rows().filter(row => row.props['data-selected']).length, 2);
      }
      for (const area of ['blank', 'toolbar', 'calendar-cell']) {
        await act(async () => clickOutside!({ target: { className: area, closest: () => null } }));
        assert.equal(rows().filter(row => row.props['data-selected']).length, 0);
        for (const index of [0, 1]) await act(async () => rows()[index]!.props.onClickCapture({ metaKey: platform === 'MacIntel', ctrlKey: platform !== 'MacIntel', preventDefault: noop, stopPropagation: noop }));
      }

      await act(async () => rows()[0]!.props.onContextMenu({ preventDefault: noop, clientX: 20, clientY: 20, currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } }));
      assert.equal(renderer!.root.findByType(TaskContextMenu).props.tasks.length, 2);
      await act(async () => renderer!.root.findByType(TaskContextMenu).props.onClose());
      assert.equal(rows().filter(row => row.props['data-selected']).length, 0, 'cancelling the menu clears selection');
      for (const index of [0, 1]) await act(async () => rows()[index]!.props.onClickCapture({ metaKey: platform === 'MacIntel', ctrlKey: platform !== 'MacIntel', preventDefault: noop, stopPropagation: noop }));
      await act(async () => rows()[0]!.props.onContextMenu({ preventDefault: noop, clientX: 20, clientY: 20, currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } }));

      await act(async () => renderer!.root.findAllByProps({ role: 'menuitem' })[0]!.props.onClick());
      assert.equal(renderer!.root.findAllByType(TaskContextMenu).length, 0);
      assert.equal(rows().filter(row => row.props['data-selected']).length, 0, 'successful operation clears selection');
      const snapshot = await app.snapshot({ view });
      assert.equal(snapshot.tasks.filter(task => task.pinned).length, 2);
      for (const task of snapshot.tasks) await app.dispatch({ action: 'setFields', requestId: view + task.noteId, noteId: task.noteId, pinned: false });
      await act(async () => renderer!.unmount()); renderer = undefined;
    }
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, i) => { const descriptor = originals[i]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

test('batch date preserves each task clock and zone, mixed pins converge, and deletion confirms the count', async () => {
  const names = ['document', 'window', 'confirm'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  let confirmation = '';
  Object.assign(globalThis, { document: { addEventListener() {}, removeEventListener() {}, activeElement: null }, window: { innerWidth: 1000, innerHeight: 800 }, confirm: (text: string) => { confirmation = text; return true; } });
  const base = { taskId: 'a', noteId: 'a', title: 'A', notebookId: 'book', tagIds: [], completedAt: 0, priority: 'none' as const, pinned: true, reminder: { enabled: false } };
  const tasks = [
    { ...base, schedule: { kind: 'timed' as const, date: '2026-10-28', time: '09:30', zone: 'Asia/Shanghai', instant: 0 } },
    { ...base, taskId: 'b', noteId: 'b', pinned: false, schedule: { kind: 'timed' as const, date: '2026-10-28', time: '15:45', zone: 'America/New_York', instant: 0 } },
  ];
  let renderer: ReactTestRenderer | undefined;
  const commands: any[][] = [];
  try {
    await act(async () => { renderer = create(React.createElement(TaskContextMenu, { task: tasks[0]!, tasks, x: 0, y: 0, folders: [], busy: false, onClose() {}, onCommand: async inputs => { commands.push(inputs); return { status: 'saved', requestId: 'test', snapshotVersion: 1 }; } })); });
    await act(async () => renderer!.root.findAllByType('button').find(button => button.props.title && /^\d{4}-/.test(button.props.title))!.props.onClick());
    assert.deepEqual(commands[0]!.map(command => [command.noteId, command.schedule.time, command.schedule.zone]), [['a', '09:30:00', 'Asia/Shanghai'], ['b', '15:45:00', 'America/New_York']]);
    await act(async () => renderer!.root.findAllByProps({ role: 'menuitem' })[0]!.props.onClick());
    assert.deepEqual(commands[1]!.map(command => command.pinned), [true, true]);
    await act(async () => renderer!.root.findAllByProps({ role: 'menuitem' })[3]!.props.onClick());
    assert.match(confirmation, /2/);
    assert.deepEqual(commands[2]!.map(command => command.noteId), ['a', 'b']);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    names.forEach((name, i) => { const descriptor = originals[i]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});
