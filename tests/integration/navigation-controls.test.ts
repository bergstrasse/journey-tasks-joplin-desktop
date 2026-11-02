import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { App } from '../../src/panel/App';
import { defaultPreferences } from '../../src/adapters/joplin/localIntentStore';
import type { ApplicationSnapshot } from '../../src/services/applicationTypes';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test('navigation keeps header and quick-add controls enabled while reading and saving preferences', async () => {
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  const snapshot: ApplicationSnapshot = {
    snapshotVersion: 1, now: Date.now(), deviceZone: 'UTC', view: 'today',
    range: { start: '2026-10-27', end: '2026-10-28' }, items: [], warnings: [], truncated: false,
    tasks: [], series: [], folders: [{ id: 'book', title: 'Book' }], tags: [],
    preferences: { ...defaultPreferences, language: 'en' }, diagnostics: [], loading: false,
  };
  let hold = false;
  const pending: (() => void)[] = [];
  const savedViews: string[] = [];
  Object.assign(globalThis, {
    document: { documentElement: {}, addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    webviewApi: { onMessage() {}, async postMessage(message: any) {
      if (message.action === 'command') savedViews.push(message.command.preferences.lastView);
      if (hold) await new Promise<void>(resolve => pending.push(resolve));
      return message.action === 'snapshot' ? { ok: true, snapshot } :
        { ok: true, result: { status: 'saved', snapshotVersion: 1 } };
    } },
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    const controls = () => renderer.root.findAllByType('button').filter(node =>
      ['Refresh', 'Settings'].includes(node.props['aria-label']) || node.props.className === 'quick-add-options');
    const check = () => {
      assert.equal(controls().length, 3);
      for (const control of controls()) assert.equal(control.props.disabled, false);
    };
    check();
    const quickAdd = controls()[2];
    hold = true;
    for (const view of ['tomorrow', 'all', 'inbox']) {
      await act(async () => {
        renderer.root.findByType('nav').findAllByType('button').find(node =>
          node.children.includes(({ tomorrow: 'Tomorrow', all: 'All', inbox: 'Inbox' })[view]!))!.props.onClick();
      });
      check();
      assert.equal(controls()[2], quickAdd, 'quick-add remains mounted');
    }
    assert.deepEqual(savedViews, ['tomorrow', 'all', 'inbox']);
    await act(async () => { pending.splice(0).forEach(resolve => resolve()); });
    check();
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    for (const key of ['document', 'window', 'webviewApi']) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
