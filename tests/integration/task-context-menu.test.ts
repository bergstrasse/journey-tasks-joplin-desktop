import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TaskContextMenu } from '../../src/panel/TaskContextMenu';
import type { Task } from '../../src/shared/models';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
test('context menu clears batch dates and searches notebook submenu before moving', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.assign(globalThis, { document: { activeElement: null, addEventListener() {}, removeEventListener() {} } });
  const task: Task = { taskId: 'a', noteId: 'a', title: 'A', notebookId: 'one', tagIds: [], completedAt: 0, priority: 'none', pinned: true, reminder: { enabled: false }, schedule: { kind: 'allDay', date: '2026-10-28', zone: 'Asia/Shanghai' } };
  const folders = [{ id: '99', title: 'Alpha' }, { id: 'one', title: 'Personal' }, { id: 'two', title: 'work projects 2' }, { id: '00', title: 'WORK projects 10' }];
  const originalFolders = folders.map(folder => ({ ...folder }));
  const commands: any[][] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(TaskContextMenu, { task, tasks: [task, { ...task, noteId: 'b' }], x: 0, y: 0, busy: false, folders, onClose() {}, onCommand: async inputs => { commands.push(inputs); return { status: 'saved', requestId: 'test', snapshotVersion: 1 }; } })); });
    const root = renderer!.root;
    const clear = root.findAllByType('button').find(button => button.findAllByProps({ name: 'clearDate' }).length)!;
    assert.ok(clear.props.title);
    assert.equal(clear.props.title, clear.props['aria-label']);
    await act(async () => clear.props.onClick());
    assert.deepEqual(commands[0]!.map(command => [command.noteId, command.schedule]), [['a', { kind: 'none' }], ['b', { kind: 'none' }]]);
    assert.equal(root.findAllByProps({ name: 'unpin' }).length, 1);
    await act(async () => root.findByProps({ 'data-submenu': 'move' }).props.onMouseEnter());
    assert.equal(root.findByProps({ className: 'menu-submenu' }).props.role, 'dialog');
    for (const submenu of ['move']) {
      for (const index of [0, 1, 3]) {
        await act(async () => root.findByProps({ 'data-submenu': submenu }).props.onMouseEnter());
        assert.equal(root.findAllByProps({ className: 'menu-submenu' }).length, 1);
        await act(async () => root.findAllByProps({ role: 'menuitem' })[index]!.props.onMouseEnter());
        assert.equal(root.findAllByProps({ className: 'menu-submenu' }).length, 0);
      }
      await act(async () => root.findByProps({ 'data-submenu': submenu }).props.onMouseEnter());
      await act(async () => root.findByProps({ className: 'menu-date-options' }).props.onMouseEnter());
      assert.equal(root.findAllByProps({ className: 'menu-submenu' }).length, 0);
    }
    await act(async () => root.findByProps({ 'data-submenu': 'move' }).props.onClick());
    const folderTitles = () => root.findByProps({ className: 'menu-folder-list' }).findAllByProps({ className: 'notebook-choice' }).map(button => button.findAllByType('span')[0].children.join(''));
    assert.deepEqual(folderTitles(), ['Alpha', 'Personal', 'work projects 2', 'WORK projects 10']);
    assert.deepEqual(folders, originalFolders, 'sorting must not mutate the snapshot');
    await act(async () => root.findByProps({ type: 'search' }).props.onChange({ target: { value: ' work ' } }));
    assert.deepEqual(folderTitles(), ['work projects 2', 'WORK projects 10']);
    const folderList = root.findByProps({ className: 'menu-folder-list' });
    assert.equal(folderList.findAllByProps({ className: 'notebook-choice' }).length, 2);
    await act(async () => folderList.findAllByProps({ className: 'notebook-choice' })[0].props.onClick());
    assert.deepEqual(commands[1]!.map(command => [command.noteId, command.notebookId]), [['a', 'two'], ['b', 'two']]);
    await act(async () => root.findByProps({ type: 'search' }).props.onChange({ target: { value: 'missing' } }));
    assert.equal(root.findAllByProps({ role: 'status' }).length, 1);
    await act(async () => root.findByProps({ 'data-submenu': 'date' }).props.onClick());
    assert.equal(root.findByProps({ className: 'menu-submenu' }).props.role, 'dialog');
    assert.equal(root.findAllByProps({ className: 'menu-picker' }).length, 0);
    await act(async () => root.findByProps({ className: 'menu-date-options' }).props.onMouseEnter());
    assert.equal(root.findAllByProps({ className: 'menu-submenu' }).length, 1);
    const dateInput = () => root.findAllByType('input').find(input => input.props.placeholder === 'YYYY-MM-DD')!;
    const timeInput = () => root.findAllByType('input').find(input => input.props.placeholder === 'HH:mm')!;
    await act(async () => dateInput().props.onChange({ target: { value: '2026-11-02' } }));
    await act(async () => timeInput().props.onChange({ target: { value: '14:30' } }));
    await act(async () => root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.ok(commands.at(-1)!.every(command => command.action === 'changeDate' && command.schedule.kind === 'timed' && command.schedule.date === '2026-11-02' && command.schedule.time === '14:30:00' && command.schedule.instant === Date.parse('2026-11-02T06:30:00Z') && command.schedule.zone === 'Asia/Shanghai'));
    await act(async () => timeInput().props.onChange({ target: { value: '' } }));
    await act(async () => root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.ok(commands.at(-1)!.every(command => command.schedule.kind === 'allDay'));
    assert.equal(root.findAllByProps({ 'data-submenu': 'defer' }).length, 0);

  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('mixed history deletion sends each occurrence identity even when the carrier is shared', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalConfirm = Object.getOwnPropertyDescriptor(globalThis, 'confirm');
  Object.assign(globalThis, { document: { activeElement: null, addEventListener() {}, removeEventListener() {} }, confirm: () => true });
  const current: Task = { taskId: 'current', occurrenceId: 'current', seriesId: 'series', noteId: 'shared', title: 'Shared', notebookId: 'one', tagIds: [], completedAt: 0, priority: 'none', pinned: false, reminder: { enabled: false }, schedule: { kind: 'allDay', date: '2026-10-28', zone: 'Asia/Shanghai' } };
  const history: Task = { ...current, taskId: 'old', occurrenceId: 'old', historical: true, completedAt: 1 };
  let renderer: ReactTestRenderer | undefined;
  let commands: any[] = [];
  try {
    await act(async () => { renderer = create(React.createElement(TaskContextMenu, { task: history, tasks: [history, current], x: 0, y: 0, busy: false, folders: [], onClose() {}, onCommand: async inputs => { commands = inputs; return { status: 'saved', requestId: 'test', snapshotVersion: 1 }; } })); });
    const deletion = renderer!.root.findAllByType('button').find(button => button.findAllByProps({ name: 'trash' }).length)!;
    assert.equal(deletion.props.disabled, false);
    await act(async () => deletion.props.onClick());
    assert.deepEqual(commands.map(command => [command.action, command.noteId, command.occurrenceId]), [
      ['deleteNativeTask', 'shared', 'old'], ['deleteNativeTask', 'shared', 'current'],
    ]);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    for (const [key, descriptor] of [['document', originalDocument], ['confirm', originalConfirm]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('single-task menu opens the original note above the icon-labelled history action', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.assign(globalThis, { document: { activeElement: null, addEventListener() {}, removeEventListener() {} } });
  const task: Task = { taskId: 'task', noteId: 'source-note', title: 'Task', notebookId: 'book', tagIds: [], completedAt: 0, priority: 'none', pinned: false, reminder: { enabled: false }, schedule: { kind: 'none' } };
  const commands: unknown[] = [];
  let closed = 0;
  let histories = 0;
  let renderer: ReactTestRenderer | undefined;
  const props = { task, x: 0, y: 0, busy: false, folders: [], onClose: () => { closed++; }, onHistory: () => { histories++; }, onCommand: async (inputs: unknown[]) => { commands.push(...inputs); return { status: 'saved' as const, requestId: 'open', snapshotVersion: 1 }; } };
  try {
    await act(async () => { renderer = create(React.createElement(TaskContextMenu, props)); });
    const items = renderer!.root.findAllByProps({ role: 'menuitem' });
    assert.equal(items[0]!.findAllByProps({ name: 'openNote' }).length, 1);
    assert.equal(items[1]!.findAllByProps({ name: 'list' }).length, 1);
    assert.equal(items[0]!.findAllByType('svg').length, 1);
    assert.equal(items[1]!.findAllByType('svg').length, 1);
    await act(async () => items[1]!.props.onClick());
    assert.equal(histories, 1);
    await act(async () => items[0]!.props.onClick());
    assert.deepEqual(commands, [{ action: 'openNote', noteId: 'source-note' }]);
    assert.equal(closed, 1);
    await act(async () => renderer!.update(React.createElement(TaskContextMenu, { ...props, busy: true })));
    assert.equal(renderer!.root.findAllByProps({ role: 'menuitem' })[0]!.props.disabled, true);
    await act(async () => renderer!.update(React.createElement(TaskContextMenu, { ...props, tasks: [task, { ...task, noteId: 'other' }] })));
    assert.equal(renderer!.root.findAllByProps({ name: 'openNote' }).length, 0);
    assert.equal(renderer!.root.findAllByProps({ name: 'list' }).length, 0);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');
  }
});
