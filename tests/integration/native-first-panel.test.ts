import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { App, TaskForm } from '../../src/panel/App';
import { TaskApplication } from '../../src/services/taskApplication';
import { PanelController } from '../../src/panel/controller';
import { MemoryJoplin } from '../support/memory-joplin';
import { parseArchiveBody } from '../../src/domain/bodyTemplate';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test('actual panel saves a native note, opens it and transitions from creation to editable recurrence settings', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  const opened: string[] = [];
  const api = Object.assign(host, { commands: { execute: async (name: string, ...args: any[]) => { if (name === 'openNote') opened.push(args[0]); } } });
  const app = new TaskApplication(api); await app.initialize();
  await app.dispatch({ action: 'savePreferences', requestId: 'english', preferences: { language: 'en' } });
  const controller = new PanelController({} as any, app);
  const names = ['window', 'document', 'webviewApi'];
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const noop = () => {};
  const replies: any[] = [];
  Object.assign(globalThis, {
    window: { addEventListener: noop, removeEventListener: noop },
    document: { documentElement: {}, addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null, activeElement: null },
    webviewApi: { onMessage: noop, postMessage: async (message: any) => { const reply = await controller.handleMessage(message); if (message.action === 'command') replies.push({ action: message.command.action, result: reply.result }); return reply; } },
  });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    await act(async () => renderer!.root.findByProps({ className: 'primary new-task' }).props.onClick());
    const backdrop = renderer!.root.findByProps({ className: 'modal-backdrop' });
    const backdropTarget = {};
    await act(async () => backdrop.props.onClick({ target: {}, currentTarget: backdropTarget }));
    assert.equal(renderer!.root.findAllByType(TaskForm).length, 1, 'clicking inside the drawer keeps it open');
    await act(async () => backdrop.props.onClick({ target: backdropTarget, currentTarget: backdropTarget }));
    assert.equal(renderer!.root.findAllByType(TaskForm).length, 0, 'clicking outside the drawer closes it');
    await act(async () => renderer!.root.findByProps({ className: 'primary new-task' }).props.onClick());
    assert.equal(renderer!.root.findByType(TaskForm).props.task, undefined);
    assert.equal(renderer!.root.findAllByType('textarea').length, 0);
    const title = renderer!.root.findByType(TaskForm).findAllByType('input').find(node => node.props.maxLength === 1000)!;
    await act(async () => title.props.onChange({ target: { value: 'Save first' } }));
    await act(async () => renderer!.root.findByType(TaskForm).findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.equal(host.notes.size, 1);
    const note = [...host.notes.values()][0]!;
    assert.equal(note.title, 'Save first'); assert.equal(note.body, '');
    assert.deepEqual(opened, [note.id]);
    const form = renderer!.root.findByType(TaskForm);
    assert.equal(form.props.task.noteId, note.id, 'the form now targets the persisted note');
    const repeating = form.findAllByType('label').find(node => node.children.includes('Repeating task'))!.findByType('input');
    assert.equal(repeating.props.disabled, false);
    assert.equal((await app.snapshot()).series.length, 0);
    await act(async () => repeating.props.onChange({ target: { checked: true } }));
    const mode = renderer!.root.findByType(TaskForm).findAllByType('select').find(node => node.props.value === 'continuous')!;
    await act(async () => mode.props.onChange({ target: { value: 'archive' } }));
    const insert = renderer!.root.findAllByType('button').find(node => node.children.includes('Insert template block'))!;
    await act(async () => insert.props.onClick());
    assert.equal(parseArchiveBody(host.notes.get(note.id)!.body)!.templateBody, '');
    await host.data.put(['notes', note.id], {}, { body: '<!-- template:start -->\n- [ ] Native step\n<!-- template:end -->' });
    // Reproduce Joplin's asynchronous note-change refresh before the panel receives its invalidation.
    await act(async () => { await app.dispatch({ action: 'refresh', requestId: 'host-refresh-after-template' }); });
    await act(async () => renderer!.root.findByType(TaskForm).findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.equal(renderer!.root.findAllByType(TaskForm).length, 0, 'one save click completes and closes the form');
    const saves = replies.filter(reply => reply.action === 'editTask');
    assert.equal(saves.length, 2, 'the stale rejection is retried within the same user click');
    assert.equal(saves[0].result.code, 'STALE_SNAPSHOT');
    assert.equal(saves[1].result.status, 'saved');
    assert.equal((await app.snapshot()).series.length, 1);
    assert.equal(host.notes.get(note.id)!.body, '- [ ] Native step\n<!-- template:start -->\n- [ ] Native step\n<!-- template:end -->');
    assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0);

  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    app.dispose();
    names.forEach((name, index) => { const descriptor = originals[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});
