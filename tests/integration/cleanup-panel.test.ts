import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CleanupSettings } from '../../src/panel/CleanupSettings';
import { PanelController } from '../../src/panel/controller';
import { TranslationProvider } from '../../src/i18n/react';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';

test('cleanup entry stays compact until an explicit dialog is opened', () => {
  let commands = 0;
  const panel = React.createElement(CleanupSettings, { busy: false,
    onCommand: async () => { commands++; throw new Error('render must not run cleanup'); }, onCleared: () => {} });
  const html = renderToStaticMarkup(React.createElement(TranslationProvider, { locale: 'en', children: panel }));
  assert.equal(commands, 0);
  assert.match(html, /Clear plugin data/);
  assert.doesNotMatch(html, /role="dialog"|cleanup-plan|deleteTasks|clearReminders|<details/);
  assert.doesNotMatch(html, /[\u3400-\u9fff]/);
});

test('cleanup panel bridge requires preview token and exact phrase before applying the explicitly returned plan', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: '用户笔记本' });
  let sequence = 0;
  const app = new TaskApplication(host, { randomId: () => String(++sequence).padStart(32, '0') }); await app.initialize();
  const made = await app.dispatch({ action: 'createTask', requestId: 'bridge-cleanup-task', input: {
    title: '保留用户标题', body: '- [x] 用户正文', notebookId: 'book', schedule: { kind: 'none' },
  } });
  assert.equal(made.status, 'saved', made.message);
  const controller = new PanelController({} as any, app);
  const command = (requestId: string, payload: Record<string, unknown>) => controller.handleMessage({
    protocolVersion: 1, requestId, action: 'command', command: { requestId, ...payload },
  });
  const before = structuredClone([...host.notes.entries()]);
  const noToken = await command('bridge-invalid-token', { action: 'executeCleanup', token: 'not-previewed', confirmation: 'RESET' });
  assert.equal(noToken.ok, true); assert.notEqual(noToken.result.status, 'saved');
  assert.deepEqual([...host.notes.entries()], before);
  const previewed = await command('bridge-preview', { action: 'previewCleanup' });
  assert.equal(previewed.ok, true); assert.equal(previewed.result.status, 'saved');
  const plan = previewed.result.cleanupPlan;
  assert.ok(plan?.notes.some((note: { id: string }) => note.id === made.noteId));
  assert.deepEqual([...host.notes.entries()], before);
  const mismatch = await command('bridge-wrong-phrase', { action: 'executeCleanup', token: plan.token, confirmation: 'DELETE' });
  assert.equal(mismatch.ok, true); assert.notEqual(mismatch.result.status, 'saved');
  assert.deepEqual([...host.notes.entries()], before);
  const executed = await command('bridge-execute', { action: 'executeCleanup', token: plan.token, confirmation: plan.confirmation });
  assert.equal(executed.ok, true); assert.equal(executed.result.status, 'saved', executed.result.message);
  assert.ok(executed.result.cleanupResult);
  assert.equal(host.notes.get(made.noteId!)!.title, '保留用户标题');
  assert.equal(host.notes.get(made.noteId!)!.body, '- [x] 用户正文');
  const entries = Object.values(JSON.parse(host.notes.get(made.noteId!)!.user_data)[host.namespace]) as Array<{ d?: number }>;
  assert.ok(entries.every(entry => entry.d), 'cleanup through the bridge removes active plugin metadata');
});
