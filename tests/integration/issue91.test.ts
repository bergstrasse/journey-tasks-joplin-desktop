import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { App } from '../../src/panel/App';
import { TaskApplication } from '../../src/services/taskApplication';
import { PanelController } from '../../src/panel/controller';
import { TaskContextMenu } from '../../src/panel/TaskContextMenu';
import { NotebookTree } from '../../src/panel/NotebookPicker';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function setup(count: number) {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  for (const id of ['A', 'B']) host.notebooks.set(id, { id, title: id });
  for (let i = 0; i < count; i++) host.seedNote({ id: `t${i}`, title: `Task ${i}`, parent_id: 'A' });
  const app = new TaskApplication(host); await app.initialize();
  return { host, app };
}

test('#91 write commands skip the whole-state fingerprint but no-op refreshes stay version-stable', async () => {
  const { host, app } = await setup(3);
  const before = (await app.snapshot()).snapshotVersion;
  const probe = app as unknown as { fingerprint(): string };
  const measure = probe.fingerprint; let measured = 0;
  assert.equal(typeof measure, 'function');
  probe.fingerprint = function (this: unknown) { measured++; return measure.call(this); };
  const saved = await app.dispatch({ action: 'setFields', requestId: 'pin', noteId: 't0', pinned: true });
  assert.equal(saved.status, 'saved');
  assert.equal(measured, 0, 'a write does not serialize the whole state');
  assert.ok(saved.snapshotVersion > before, 'a write publishes a new version');
  assert.equal((await app.snapshot()).snapshotVersion, saved.snapshotVersion);
  // Nothing changed since the write: the deferred fingerprint must be taken before this refresh.
  const idle = await app.dispatch({ action: 'refresh', requestId: 'idle' });
  assert.equal(idle.snapshotVersion, saved.snapshotVersion, 'a no-op refresh after a write keeps the version');
  assert.equal((await app.dispatch({ action: 'refresh', requestId: 'idle-2' })).snapshotVersion, saved.snapshotVersion);
  host.notes.get('t1')!.title = 'Renamed elsewhere'; host.notes.get('t1')!.updated_time += 1;
  const external = await app.dispatch({ action: 'refresh', requestId: 'external' });
  assert.ok(external.snapshotVersion > saved.snapshotVersion, 'an outside change still publishes a new version');
  const chained = await app.dispatch({ action: 'moveTask', requestId: 'move', noteId: 't2', notebookId: 'B', expectedSnapshotVersion: external.snapshotVersion });
  assert.equal(chained.status, 'saved', 'the version a save returns is the one the next command may expect');
  const settled = measured;
  assert.equal((await app.dispatch({ action: 'setFields', requestId: 'next', noteId: 't1', pinned: true, expectedSnapshotVersion: chained.snapshotVersion })).status, 'saved');
  assert.equal(measured, settled, 'chained writes measure nothing either');
  app.dispose();
});

test('#91 a notebook added after a write still publishes a new version on a change check', async () => {
  const { host, app } = await setup(1);
  const saved = await app.dispatch({ action: 'setFields', requestId: 'pin', noteId: 't0', pinned: true });
  host.notebooks.set('C', { id: 'C', title: 'C' });
  // checkChanges replaces the cached folders before refreshing; the deferred baseline must predate that.
  const checked = await app.dispatch({ action: 'refresh', requestId: 'check', checkChanges: true });
  const snapshot = await app.snapshot();
  assert.ok(snapshot.folders.some(folder => folder.id === 'C'));
  assert.ok(checked.snapshotVersion > saved.snapshotVersion, 'new folder content is a new version');
  assert.equal(snapshot.snapshotVersion, checked.snapshotVersion);
  app.dispose();
});

test('#91 batch pin and move query two snapshots in total and settle selection once', async () => {
  const count = 6;
  const { app } = await setup(count);
  const controller = new PanelController({} as any, app);
  const names = ['window', 'document', 'navigator', 'webviewApi'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const noop = () => {};
  const requests: string[] = [];
  for (const [name, value] of Object.entries({
    window: { addEventListener: noop, removeEventListener: noop, innerWidth: 1000, innerHeight: 800 },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    navigator: { platform: 'MacIntel' },
    webviewApi: { onMessage: noop, postMessage: (message: any) => { requests.push(message.action === 'command' ? message.command.action : message.action); return controller.handleMessage(message); } },
  })) Object.defineProperty(globalThis, name, { configurable: true, value });
  let renderer: ReactTestRenderer | undefined;
  try {
    await app.dispatch({ action: 'savePreferences', requestId: 'prefs', preferences: { language: 'en', lastView: 'all', startupMode: 'restore' } } as any);
    await act(async () => { renderer = create(React.createElement(App)); });
    const rows = () => renderer!.root.findAllByType('article');
    assert.equal(rows().length, count);
    const selectAll = async () => {
      for (let i = 0; i < count; i++) await act(async () => rows()[i]!.props.onClickCapture({ metaKey: true, preventDefault: noop, stopPropagation: noop }));
      await act(async () => rows()[0]!.props.onContextMenu({ preventDefault: noop, clientX: 20, clientY: 20, currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } }));
    };

    await selectAll();
    requests.length = 0;
    await act(async () => renderer!.root.findAllByProps({ role: 'menuitem' })[0]!.props.onClick());
    assert.deepEqual(requests, ['snapshot', ...Array(count).fill('setFields'), 'snapshot'], 'one snapshot before and one after the batch');
    assert.equal((await app.snapshot()).tasks.filter(task => task.pinned).length, count);
    assert.equal(rows().filter(row => row.props['data-selected']).length, 0);

    await selectAll();
    requests.length = 0;
    await act(async () => renderer!.root.findAllByProps({ role: 'menuitem' }).find(item => item.props['data-submenu'] === 'move')!.props.onClick());
    const tree = renderer!.root.findByType(TaskContextMenu).findByType(NotebookTree);
    await act(async () => tree.props.onSelect('B'));
    assert.deepEqual(requests, ['snapshot', ...Array(count).fill('moveTask'), 'snapshot']);
    assert.deepEqual((await app.snapshot()).tasks.map(task => task.notebookId), Array(count).fill('B'));
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, i) => { const descriptor = originals[i]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

test('#91 a batch pin shows optimistically before the saves finish', async () => {
  const { app } = await setup(3);
  const controller = new PanelController({} as any, app);
  const names = ['window', 'document', 'navigator', 'webviewApi'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const noop = () => {};
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  for (const [name, value] of Object.entries({
    window: { addEventListener: noop, removeEventListener: noop, innerWidth: 1000, innerHeight: 800 },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    navigator: { platform: 'MacIntel' },
    webviewApi: { onMessage: noop, postMessage: async (message: any) => { if (message.action === 'command' && message.command.action === 'setFields') await gate; return controller.handleMessage(message); } },
  })) Object.defineProperty(globalThis, name, { configurable: true, value });
  let renderer: ReactTestRenderer | undefined;
  try {
    await app.dispatch({ action: 'savePreferences', requestId: 'prefs', preferences: { language: 'en', lastView: 'all', startupMode: 'restore' } } as any);
    await act(async () => { renderer = create(React.createElement(App)); });
    const rows = () => renderer!.root.findAllByType('article');
    for (let i = 0; i < 3; i++) await act(async () => rows()[i]!.props.onClickCapture({ metaKey: true, preventDefault: noop, stopPropagation: noop }));
    await act(async () => rows()[0]!.props.onContextMenu({ preventDefault: noop, clientX: 20, clientY: 20, currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } }));
    await act(async () => renderer!.root.findAllByProps({ role: 'menuitem' })[0]!.props.onClick());
    const pinned = () => renderer!.root.findAll(node => node.props?.item?.kind === 'actual' && 'selected' in node.props && node.props.item.pinned).length;
    assert.equal(pinned(), 3, 'pins render before any save returns');
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(pinned(), 3);
    assert.equal((await app.snapshot()).tasks.filter(task => task.pinned).length, 3);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, i) => { const descriptor = originals[i]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

async function mountGated(count: number, failAction?: string) {
  const { host, app } = await setup(count);
  const controller = new PanelController({} as any, app);
  const names = ['window', 'document', 'navigator', 'webviewApi'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const noop = () => {};
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  for (const [name, value] of Object.entries({
    window: { addEventListener: noop, removeEventListener: noop, innerWidth: 1000, innerHeight: 800 },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    navigator: { platform: 'MacIntel' },
    webviewApi: { onMessage: noop, postMessage: async (message: any) => {
      if (message.action !== 'command' || !['setFields', 'moveTask'].includes(message.command.action)) return controller.handleMessage(message);
      await gate;
      if (message.command.action === failAction) return { ok: false, code: 'COMMAND_FAILED', error: 'injected' };
      return controller.handleMessage(message);
    } },
  })) Object.defineProperty(globalThis, name, { configurable: true, value });
  await app.dispatch({ action: 'savePreferences', requestId: 'prefs', preferences: { language: 'en', lastView: 'all', startupMode: 'restore' } } as any);
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(App)); });
  const rows = () => renderer.root.findAllByType('article');
  const items = () => renderer.root.findAll(node => node.props?.item?.kind === 'actual' && 'selected' in node.props).map(node => node.props.item);
  const menus = () => renderer.root.findAllByType(TaskContextMenu);
  const openMenu = async (selection: number) => {
    if (selection > 1) for (let i = 0; i < selection; i++) await act(async () => rows()[i]!.props.onClickCapture({ metaKey: true, preventDefault: noop, stopPropagation: noop }));
    await act(async () => rows()[0]!.props.onContextMenu({ preventDefault: noop, clientX: 20, clientY: 20, currentTarget: { getBoundingClientRect: () => ({ left: 0, bottom: 0 }) } }));
  };
  const pin = async () => act(async () => renderer.root.findAllByProps({ role: 'menuitem' }).find(item => item.props.children?.[1] === 'Pin')!.props.onClick());
  const move = async (notebookId: string) => {
    await act(async () => renderer.root.findAllByProps({ role: 'menuitem' }).find(item => item.props['data-submenu'] === 'move')!.props.onClick());
    await act(async () => menus()[0]!.findByType(NotebookTree).props.onSelect(notebookId));
  };
  const settle = async () => act(async () => { release(); for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); });
  const dispose = async () => {
    await act(async () => renderer.unmount());
    app.dispose();
    names.forEach((name, i) => { const descriptor = originals[i]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  };
  return { host, app, renderer, rows, items, menus, openMenu, pin, move, settle, dispose };
}

for (const selection of [1, 3]) test(`#91 the menu closes at once while ${selection > 1 ? 'a batch' : 'a single'} pin and move are still saving`, async () => {
  const ui = await mountGated(3);
  try {
    await ui.openMenu(selection);
    await ui.pin();
    assert.equal(ui.menus().length, 0, 'pin closes the menu before its save returns');
    assert.equal(ui.items().filter(item => item.pinned).length, selection, 'pinned rows show immediately');
    await ui.settle();
    assert.equal((await ui.app.snapshot()).tasks.filter(task => task.pinned).length, selection);
  } finally { await ui.dispose(); }
  const moving = await mountGated(3);
  try {
    await moving.openMenu(selection);
    await moving.move('B');
    assert.equal(moving.menus().length, 0, 'move closes the menu before its save returns');
    assert.equal(moving.items().filter(item => item.notebookId === 'B').length, selection, 'moved rows show in the target notebook immediately');
    await moving.settle();
    assert.equal((await moving.app.snapshot()).tasks.filter(task => task.notebookId === 'B').length, selection);
    assert.equal(moving.items().filter(item => item.notebookId === 'B').length, selection);
  } finally { await moving.dispose(); }
});

test('#91 a failed move after the menu closed reverts the rows and reports in the panel', async () => {
  const ui = await mountGated(2, 'moveTask');
  try {
    await ui.openMenu(2);
    await ui.move('B');
    assert.equal(ui.menus().length, 0);
    assert.equal(ui.items().filter(item => item.notebookId === 'B').length, 2);
    await ui.settle();
    assert.equal(ui.items().filter(item => item.notebookId === 'B').length, 0, 'optimistic rows return to their notebook');
    assert.deepEqual((await ui.app.snapshot()).tasks.map(task => task.notebookId), ['A', 'A']);
    assert.ok(ui.renderer.root.findAll(node => node.props?.className === 'error' && node.props.role === 'alert').length > 0, 'the panel error bar shows the failure');
    assert.equal(ui.rows().filter(row => row.props['data-selected']).length, 0);
  } finally { await ui.dispose(); }
});
