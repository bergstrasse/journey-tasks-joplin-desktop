import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StorageError } from '../../src/adapters/joplin/gateway';
import { defaultPreferences } from '../../src/adapters/joplin/localIntentStore';
import { createTranslator, translateMessage } from '../../src/i18n';
import { TranslationProvider } from '../../src/i18n/react';
import { TaskForm } from '../../src/panel/App';
import { SettingsPage } from '../../src/panel/SettingsPage';
import { CleanupSettings } from '../../src/panel/CleanupSettings';
import { TaskContextMenu } from '../../src/panel/TaskContextMenu';
import { PanelController } from '../../src/panel/controller';
import { PanelClientError, querySnapshot, sendCommand } from '../../src/panel/client';
import type { TaskApplication } from '../../src/services/taskApplication';
import type { Task } from '../../src/shared/models';

const t = createTranslator('en-US');
const detail = '内部开发日志：笔记状态已改变';
const wrap = (children: React.ReactNode) => React.createElement(TranslationProvider, { locale: 'en-US', children });
const noop = () => {};

test('bridge and client retain snapshot and command failure codes through thrown errors', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'webviewApi');
  const controller = new PanelController({} as any, {
    snapshot: async () => { throw new StorageError('OUTBOX_CAPACITY', detail); },
    dispatch: async () => ({ status: 'conflict', code: 'STALE_SNAPSHOT', message: detail }),
  } as unknown as TaskApplication);
  Object.assign(globalThis, { webviewApi: { postMessage: (message: unknown) => controller.handleMessage(message) } });
  try {
    for (const [operation, code] of [
      [() => querySnapshot({}), 'OUTBOX_CAPACITY'],
      [() => sendCommand({ action: 'refresh', requestId: 'issue53' }), 'STALE_SNAPSHOT'],
    ] as const) {
      await assert.rejects(operation, error => {
        assert.ok(error instanceof PanelClientError);
        assert.equal(error.code, code);
        assert.equal(translateMessage(error.message, 'en-US', error.code), t(`backend.${code}`));
        return true;
      });
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'webviewApi', original);
    else Reflect.deleteProperty(globalThis, 'webviewApi');
  }
});

test('English form, settings and task menu translate coded errors without backend prose', () => {
  const task: Task = { taskId: 'task', noteId: 'task', title: 'Task', notebookId: 'book', tagIds: [], schedule: { kind: 'none' }, completedAt: 0,
    priority: 'none', pinned: false, reminder: { enabled: false } };
  const elements = [
    React.createElement(TaskForm, { folders: [], initialDate: '', busy: false, submitError: detail, submitErrorCode: 'STALE_SNAPSHOT', onSubmit: noop }),
    React.createElement(SettingsPage, { preferences: defaultPreferences, busy: false, error: detail, errorCode: 'CLEANUP_INCOMPLETE', onSave: async () => {}, onCancel: noop, onCommand: async () => undefined, onCleared: noop }),
    React.createElement(TaskContextMenu, { task, x: 0, y: 0, folders: [], busy: false, error: detail, errorCode: 'FUTURE_TASK', onCommand: async () => undefined, onClose: noop }),
  ];
  for (const element of elements) {
    const html = renderToStaticMarkup(wrap(element));
    const alerts = [...html.matchAll(/role="alert">([^<]+)</g)].map(match => match[1]!);
    assert.ok(alerts.length);
    for (const alert of alerts) assert.doesNotMatch(alert, /[\u3400-\u9fff]/);
    assert.ok(!html.includes(detail));
  }
});

test('cleanup dialog translates both command errors and persisted failure details', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, document: { addEventListener: noop, removeEventListener: noop, getElementById: () => null } });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(wrap(React.createElement(CleanupSettings, {
      busy: false, error: detail, errorCode: 'CLEANUP_INCOMPLETE', onCleared: noop,
      onCommand: async () => ({ requestId: 'preview', status: 'saved' as const, snapshotVersion: 1, cleanupPlan: {
        token: 'token', confirmation: 'RESET', expiresAt: Date.now() + 10000, notes: [], folders: [], metadataKeys: 0, warnings: [], blocked: false,
        lastFailure: { stage: 'verify-cleanup', code: 'CLEANUP_NOTE_CHANGED', detail },
      } }),
    }))); });
    await act(async () => renderer!.root.findByProps({ className: 'danger' }).props.onClick());
    await act(async () => renderer!.root.findAllByType('button').find(node => node.children.includes(t('cleanup.preview')))!.props.onClick());
    const output = JSON.stringify(renderer!.toJSON());
    assert.ok(output.includes(t('backend.CLEANUP_INCOMPLETE')));
    assert.ok(output.includes(t('backend.CLEANUP_NOTE_CHANGED')));
    assert.ok(!output.includes(detail));
    assert.doesNotMatch(output, /[\u3400-\u9fff]/);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
