import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TranslationProvider, useTranslation } from '../../src/i18n/react';
import { LocalIntentStore, defaultPreferences } from '../../src/adapters/joplin/localIntentStore';
import { SettingsPage } from '../../src/panel/SettingsPage';
import { LOCAL_SETTINGS_PREFIX } from '../../src/shared/pluginIdentity';
import { MemoryJoplin } from '../support/memory-joplin';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test('time format defaults for old preferences, persists, and rejects invalid values without overwriting', async () => {
  const host = new MemoryJoplin();
  const key = LOCAL_SETTINGS_PREFIX + 'preferences';
  host.settingsValues.set(key, JSON.stringify({ language: 'en', lastView: 'month' }));
  const store = new LocalIntentStore(host, () => 'device');
  await store.initialize();
  assert.equal((await store.preferences()).timeFormat, '24h');
  assert.equal((await store.preferences()).lastView, 'month');
  await store.savePreferences({ timeFormat: '12h' });
  const saved = host.settingsValues.get(key);
  const restarted = new LocalIntentStore(host, () => 'other');
  await restarted.initialize();
  assert.equal((await restarted.preferences()).timeFormat, '12h');
  for (const timeFormat of ['auto', '', null, 24]) {
    await assert.rejects(() => store.savePreferences({ timeFormat } as any), { code: 'INVALID_TIME_FORMAT' });
    assert.equal(host.settingsValues.get(key), saved);
  }
});

test('both languages default to 24 hours including midnight and honor the 12-hour choice', async () => {
  const Clock = () => {
    const { formatTime } = useTranslation();
    return React.createElement('span', null, [0, 12, 13, 23].map(hour => formatTime(new Date(2026, 9, 29, hour, 5))).join('|'));
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    for (const locale of ['en', 'zh-CN'] as const) {
      await act(async () => { renderer = create(React.createElement(TranslationProvider, { locale, children: React.createElement(Clock) })); });
      assert.equal(renderer!.root.findByType('span').children.join(''), '00:05|12:05|13:05|23:05');
      await act(async () => renderer!.update(React.createElement(TranslationProvider, { locale, timeFormat: '12h', children: React.createElement(Clock) })));
      const output = renderer!.root.findByType('span').children.join('');
      assert.match(output, /12:05/);
      assert.match(output, /01:05/);
      assert.doesNotMatch(output, /13:05|23:05/);
      if (locale === 'en') assert.match(output, /AM.*PM/);
      await act(async () => renderer!.unmount()); renderer = undefined;
    }
  } finally { if (renderer) await act(async () => renderer!.unmount()); }
});

test('settings stage the time format until Save', async () => {
  let saved: any;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(SettingsPage, {
      preferences: defaultPreferences, busy: false, onSave: async patch => { saved = patch; },
      onCancel: () => {}, onCommand: async () => ({} as any), onCleared: () => {},
    })); });
    const select = renderer!.root.findAllByType('select').find(node => node.props.value === '24h')!;
    await act(async () => select.props.onChange({ target: { value: '12h' } }));
    assert.equal(saved, undefined);
    await act(async () => renderer!.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.equal((saved as any).timeFormat, '12h');
  } finally { if (renderer) await act(async () => renderer!.unmount()); }
});
