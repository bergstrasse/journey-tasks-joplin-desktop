import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { App, TaskForm } from '../../src/panel/App';
import manifest from '../../src/manifest.json';
import { SettingsPage } from '../../src/panel/SettingsPage';
import { CleanupSettings } from '../../src/panel/CleanupSettings';
import { TaskApplication } from '../../src/services/taskApplication';
import { PanelController } from '../../src/panel/controller';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { LOCAL_SETTINGS_PREFIX } from '../../src/shared/pluginIdentity';
import { MemoryJoplin } from '../support/memory-joplin';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test('settings isolate the page, stage edits, cancel without saving, save together, and initialize new task calendar', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  const app = new TaskApplication(host); await app.initialize();
  await app.dispatch({ action: 'savePreferences', requestId: 'english', preferences: { language: 'en' } });
  const opened: unknown[][] = [];
  let failOpen = false;
  const controller = new PanelController({ commands: { execute: async (...args: unknown[]) => {
    if (failOpen) throw new Error('Browser unavailable');
    opened.push(args);
  } } } as any, app);
  const names = ['window', 'document', 'webviewApi'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const noop = () => {};
  const commands: any[] = [];
  Object.assign(globalThis, {
    window: { addEventListener: noop, removeEventListener: noop },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    webviewApi: { onMessage: noop, postMessage: async (message: any) => { if (message.action === 'command') commands.push(message.command); return controller.handleMessage(message); } },
  });
  let renderer: ReactTestRenderer | undefined;
  const text = (node: any): string => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const button = (label: string) => renderer!.root.findAllByType('button').find(n => text(n) === label)!;
  const open = () => renderer!.root.findByProps({ 'aria-label': 'Settings' }).props.onClick();
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    const baseline = host.settingsValues.get(LOCAL_SETTINGS_PREFIX + 'preferences');
    await act(async () => open());
    assert.equal(renderer!.root.findAllByProps({ className: 'quick-add' }).length, 0);
    assert.equal(renderer!.root.findAllByProps({ className: 'view-options' }).length, 0);
    assert.equal(renderer!.root.findAllByProps({ className: 'task-list' }).length, 0);
    assert.equal(renderer!.root.findAllByType('input').filter(n => n.props.type === 'checkbox').length, 0);
    assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /scrolling diagnostics/);
    const settings = renderer!.root.findByType(SettingsPage);
    assert.match(text(settings.findByProps({ className: 'settings-about card' })), new RegExp(manifest.version.replace(/\./g, '\\.')));
    const issueLink = settings.findByProps({ href: 'https://github.com/tigerwoo/journey-tasks-joplin-desktop/issues' });
    assert.equal(issueLink.props.href, 'https://github.com/tigerwoo/journey-tasks-joplin-desktop/issues');
    let prevented = false;
    await act(async () => issueLink.props.onClick({ preventDefault() { prevented = true; } }));
    assert.equal(prevented, true);
    assert.deepEqual(opened, [['openItem', issueLink.props.href]]);
    const supportLink = settings.findByProps({ href: 'https://buymeacoffee.com/tigerwoo' });
    await act(async () => supportLink.props.onClick({ preventDefault() {} }));
    assert.deepEqual(opened.at(-1), ['openItem', supportLink.props.href]);
    failOpen = true;
    await act(async () => issueLink.props.onClick({ preventDefault() {} }));
    assert.match(text(settings.findByProps({ role: 'alert' })), /Browser unavailable/);
    failOpen = false;
    await act(async () => issueLink.props.onClick({ preventDefault() {} }));
    assert.equal(settings.findAllByProps({ role: 'alert' }).length, 0);
    assert.equal(settings.findAllByType('details').length, 0, 'support stays expanded');
    assert.equal(settings.findByProps({ role: 'img' }).props['aria-label'], 'Buy me a coffee QR code');
    let selects = renderer!.root.findByType(SettingsPage).findAllByType('select');
    const start = commands.length;
    await act(async () => selects[0]!.props.onChange({ target: { value: 'zh-CN' } }));
    await act(async () => selects[3]!.props.onChange({ target: { value: 'lunar' } }));
    assert.equal(host.settingsValues.get(LOCAL_SETTINGS_PREFIX + 'preferences'), baseline);
    assert.equal(commands.length, start);
    assert.ok(button('Save'), 'language does not change before save');
    await act(async () => button('Cancel').props.onClick());
    assert.equal(renderer!.root.findAllByType(SettingsPage).length, 0);
    await act(async () => open());
    selects = renderer!.root.findByType(SettingsPage).findAllByType('select');
    assert.equal(selects[0]!.props.value, 'en'); assert.equal(selects[3]!.props.value, 'solar');
    await act(async () => selects[0]!.props.onChange({ target: { value: 'zh-CN' } }));
    await act(async () => selects[1]!.props.onChange({ target: { value: 'restore' } }));
    await act(async () => selects[3]!.props.onChange({ target: { value: 'lunar' } }));
    const savesBefore = commands.filter(c => c.action === 'savePreferences').length;
    await act(async () => renderer!.root.findByType(SettingsPage).findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.equal(commands.filter(c => c.action === 'savePreferences').length, savesBefore + 1);
    assert.equal(renderer!.root.findAllByType(SettingsPage).length, 0);
    assert.equal((await app.snapshot()).preferences.defaultCalendar, 'lunar');
    assert.equal((await app.snapshot()).preferences.language, 'zh-CN');
    await act(async () => renderer!.root.findByProps({ className: 'primary new-task' }).props.onClick());
    const task = renderer!.root.findByType(TaskForm);
    assert.equal(task.findAllByType('select').find(n => n.props.value === 'lunar')?.props.value, 'lunar');
    assert.ok(task.findAllByType('fieldset').some(n => text(n).includes('农历')));
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, i) => { const descriptor = originals[i]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

test('cleanup is a separate modal, requires preview and exact phrase, and displays retry errors inside the dialog', async () => {
  const names = ['document']; const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.assign(globalThis, { document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null } });
  let renderer: ReactTestRenderer | undefined;
  const commands: any[] = []; let cleared = 0;
  const plan = { notes: [{ id: 'note', title: 'Task', inTrash: true }], folders: [], metadataKeys: 4,
    token: 'preview-token', confirmation: 'RESET', expiresAt: Date.now() + 10000, warnings: [], blocked: false };
  const props: React.ComponentProps<typeof CleanupSettings> = { busy: false, onCleared: () => { cleared++; },
    onCommand: async command => { commands.push(command); return { requestId: 'ui', status: 'saved', snapshotVersion: 1,
      ...(command.action === 'previewCleanup' ? { cleanupPlan: plan } : { cleanupResult: { cleanedNotes: 1, cleanedFolders: 0, removedKeys: 4 } }) }; } };
  const text = (node: any): string => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const button = (label: string) => renderer!.root.findAllByType('button').find(n => text(n) === label)!;
  try {
    await act(async () => { renderer = create(React.createElement(CleanupSettings, props)); });
    assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 0);
    await act(async () => button('清理本插件数据').props.onClick());
    assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 1);
    assert.equal(commands.length, 0);
    const overview = renderer!.root.findByProps({ role: 'dialog' });
    assert.match(text(overview), /包括在 Joplin 中手动设置的提醒/);
    assert.doesNotMatch(text(overview), /备份|5 分钟/);
    assert.equal(overview.findByType('h2').findAllByType('svg').length, 1);
    assert.equal(renderer!.root.findAllByType('details').length, 0, 'cleanup explanations stay expanded');
    assert.equal(renderer!.root.findAllByType('select').length, 0);
    assert.equal(renderer!.root.findAllByType('input').length, 0);
    await act(async () => button('预览清理范围').props.onClick());
    assert.equal(commands[0].action, 'previewCleanup');
    const previewDialog = renderer!.root.findByProps({ role: 'dialog' });
    assert.match(previewDialog.props.className, /cleanup-preview-dialog/);
    assert.doesNotMatch(text(previewDialog), /5 分钟/);
    assert.equal(text(previewDialog.findByType('h2')), '清理影响范围');
    assert.equal(previewDialog.findAllByProps({ className: 'cleanup-overview' }).length, 0);
    assert.equal(previewDialog.findAllByType('details').length, 0, 'affected items stay expanded');
    assert.match(text(previewDialog.findByProps({ className: 'cleanup-items' })), /Task/);
    const confirm = renderer!.root.findByType('input');
    const execute = () => button('确认执行清理');
    assert.equal(execute().props.disabled, true);
    await act(async () => confirm.props.onChange({ target: { value: 'DELETE' } }));
    assert.equal(execute().props.disabled, true);
    await act(async () => confirm.props.onChange({ target: { value: 'RESET' } }));
    assert.equal(execute().props.disabled, false);
    await act(async () => renderer!.update(React.createElement(CleanupSettings, { ...props, error: 'retry detail' })));
    assert.equal(renderer!.root.findByProps({ role: 'dialog' }).findByProps({ role: 'alert' }).children[0], 'retry detail');
    await act(async () => execute().props.onClick());
    assert.deepEqual(commands[1], { action: 'executeCleanup', token: 'preview-token', confirmation: 'RESET' });
    assert.equal(cleared, 1);
    assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 1, 'result stays visible in the dialog');
    assert.ok(renderer!.root.findByProps({ role: 'status' }));
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    names.forEach((name, i) => { const descriptor = originals[i]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

test('default calendar validates and persists; abandoned settings are neither loaded nor rewritten', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.settingsValues.set('journey.tasks.preferences', JSON.stringify({ defaultCalendar: 'lunar' }));
  const app = new TaskApplication(host); await app.initialize();
  assert.match(DEFAULT_PLUGIN_ID, /^io\.journey\.tasks\.[0-9a-f-]{36}$/);
  assert.equal((await app.snapshot()).preferences.defaultCalendar, 'solar');
  const invalid = await app.dispatch({ action: 'savePreferences', requestId: 'invalid-calendar', preferences: { defaultCalendar: 'bogus' as any } });
  assert.equal(invalid.code, 'INVALID_CALENDAR');
  assert.equal((await app.snapshot()).preferences.defaultCalendar, 'solar');
  await app.dispatch({ action: 'savePreferences', requestId: 'valid-calendar', preferences: { defaultCalendar: 'lunar' } });
  const restarted = new TaskApplication(host); await restarted.initialize();
  assert.equal((await restarted.snapshot()).preferences.defaultCalendar, 'lunar');
  assert.equal(host.settingsValues.get('journey.tasks.preferences'), JSON.stringify({ defaultCalendar: 'lunar' }));
});

test('cleanup refreshes the mounted panel and shows cleared tasks in the inbox without restart', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  const app = new TaskApplication(host); await app.initialize();
  await app.dispatch({ action: 'savePreferences', requestId: 'cleanup-language', preferences: { language: 'en' } });
  const made = await app.dispatch({ action: 'createTask', requestId: 'cleanup-panel-create', input: {
    title: 'Reset this task', body: 'Keep this content', notebookId: 'book',
    schedule: { kind: 'allDay', date: new Date().toISOString().slice(0, 10), zone: 'UTC' }, reminder: { enabled: true },
  } });
  assert.equal(made.status, 'saved', made.message);
  const controller = new PanelController({} as any, app);
  const names = ['window', 'document', 'webviewApi'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const queries: any[] = [];
  const noop = () => {};
  Object.assign(globalThis, {
    window: { addEventListener: noop, removeEventListener: noop },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    webviewApi: { onMessage: noop, postMessage: async (message: any) => {
      if (message.action === 'snapshot') queries.push(message.query);
      return controller.handleMessage(message);
    } },
  });
  let renderer: ReactTestRenderer | undefined;
  const text = (node: any): string => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const button = (label: string) => renderer!.root.findAllByType('button').find(n => text(n) === label)!;
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    await act(async () => renderer!.root.findByProps({ 'aria-label': 'Settings' }).props.onClick());
    await act(async () => button('Clear plugin data').props.onClick());
    await act(async () => button('Preview cleanup').props.onClick());
    const cleanup = renderer!.root.findByType(CleanupSettings);
    await act(async () => cleanup.findByType('input').props.onChange({ target: { value: 'RESET' } }));
    await act(async () => cleanup.findByProps({ role: 'dialog' }).findAllByType('button').find(n => n.props.className === 'danger')!.props.onClick());
    assert.equal(host.notes.get(made.noteId!)!.todo_due, 0);
    assert.equal(queries.at(-1).view, 'inbox');
    assert.equal(renderer!.root.findAllByType(TaskForm).length, 0);
    assert.ok(renderer!.root.findByProps({ role: 'status' }));
    await act(async () => renderer!.root.findByType(SettingsPage).props.onCancel());
    assert.match(JSON.stringify(renderer!.toJSON()), /Reset this task/);
    assert.equal(renderer!.root.findAllByType(SettingsPage).length, 0);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, i) => { const descriptor = originals[i]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});
