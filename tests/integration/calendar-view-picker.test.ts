import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { CalendarViewPicker } from '../../src/panel/CalendarViewPicker';
import { TranslationProvider } from '../../src/i18n/react';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test('view picker shows icons in all choices, selects a view and dismisses on Escape or outside click', async () => {
  const originals = ['document', 'window'].map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const listeners = new Map<string, (event: any) => void>();
  const changes: string[] = [];
  let focuses = 0;
  const focus = () => { focuses++; };
  Object.assign(globalThis, {
    document: { activeElement: null, addEventListener: (type: string, fn: any) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) },
    window: { innerWidth: 900, innerHeight: 600, addEventListener() {}, removeEventListener() {} },
  });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(TranslationProvider, {locale: 'en', children: React.createElement(CalendarViewPicker, {view: 'month', onChange: view => changes.push(view)})}), {
      createNodeMock: element => element.type === 'button' ? {focus, getBoundingClientRect: () => ({left: 700, bottom: 80})} :
        {contains: () => false, querySelector: () => ({focus}), querySelectorAll: () => []},
    }); });
    const trigger = () => renderer!.root.findByProps({'aria-haspopup': 'menu'});
    await act(async () => trigger().props.onClick());
    const choices = renderer!.root.findAllByProps({role: 'menuitemradio'});
    assert.equal(choices.length, 4);
    for (const choice of choices) assert.equal(choice.findAllByType('svg').length, 1);
    assert.equal(choices[2]!.props['aria-checked'], true);
    await act(async () => choices[0]!.props.onClick());
    assert.deepEqual(changes, ['day']);
    assert.equal(trigger().props['aria-expanded'], false);
    await act(async () => trigger().props.onClick());
    await act(async () => renderer!.root.findByProps({role: 'menu'}).props.onKeyDown({key: 'Escape', preventDefault() {}}));
    assert.equal(trigger().props['aria-expanded'], false);
    await act(async () => trigger().props.onClick());
    await act(async () => listeners.get('pointerdown')!({target: {}}));
    assert.equal(trigger().props['aria-expanded'], false);
    assert.ok(focuses >= 4, 'opening and selecting restore keyboard focus');
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    ['document', 'window'].forEach((name, index) => { if (originals[index]) Object.defineProperty(globalThis, name, originals[index]!); else Reflect.deleteProperty(globalThis, name); });
  }
});
