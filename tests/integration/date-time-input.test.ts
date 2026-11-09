import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DateTimeInput } from '../../src/panel/DateTimeInput';
import { TranslationProvider } from '../../src/i18n/react';

for (const type of ['date', 'time'] as const) {
  test(`${type} uses a localized stable picker and preserves input changes`, async context => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 29, 12).getTime() });
    const globals = { document: globalThis.document, window: globalThis.window, HTMLInputElement: globalThis.HTMLInputElement };
    const listeners = new Map<string, Function>();
    const handlers = new Map<string, Set<Function>>();
    const values: string[] = [];
    let validity = '';
    let renderer: ReactTestRenderer | undefined;
    class Input {
      private current = '';
      get value() { return this.current; }
      set value(value: string) { this.current = value; }
      setCustomValidity(value: string) { validity = value; }
      dispatchEvent() { values.push(this.value); }
    }
    Object.assign(globalThis, {
      document: {
        addEventListener: (name: string, fn: Function) => {
          if (!handlers.has(name)) handlers.set(name, new Set());
          handlers.get(name)!.add(fn);
          listeners.set(name, (event: unknown) => handlers.get(name)?.forEach(handler => handler(event)));
        },
        removeEventListener: (name: string, fn: Function) => handlers.get(name)?.delete(fn),
      },
      window: { innerWidth: 320, innerHeight: 568 }, HTMLInputElement: Input,
    });
    const render = (disabled = false, value = type === 'date' ? '2026-10-29' : '14:30') => React.createElement(TranslationProvider, { locale: 'en', children:
      React.createElement(DateTimeInput, { type, value, disabled, required: true, onChange: event => values.push(event.target.value) }) });
    try {
      await act(async () => { renderer = create(render(), { createNodeMock: element => element.type === 'input' ? new Input() : element.type === 'button' ? {
        focus() {}, getBoundingClientRect: () => ({ bottom: 300, right: 310 }),
      } : { focus() {}, scrollTop: 0, contains: (target: unknown) => target === 'inside' } }); });
      const trigger = () => renderer!.root.findAllByType('button').find(button => button.props.className === 'date-time-trigger')!;
      assert.equal(renderer!.root.findByType('input').props.type, 'text');
      assert.equal(validity, '');
      const click = () => trigger().props.onClick({ preventDefault() {}, stopPropagation() {} });
      await act(async () => click());
      assert.equal(trigger().props['aria-expanded'], true);
      const dialog = () => renderer!.root.findByProps({ role: 'dialog' });
      assert.equal(dialog().props['aria-label'], type === 'date' ? 'Choose date' : 'Time');
      await act(async () => listeners.get('pointerdown')!({ target: 'inside' }));
      assert.equal(trigger().props['aria-expanded'], true);
      if (type === 'date') {
        const today = () => renderer!.root.findByProps({ 'aria-label': '2026-10-29' });
        assert.equal(today().props['aria-current'], 'date');
        assert.equal(today().props['aria-pressed'], true, 'today can also retain the selected border');
        await act(async () => renderer!.update(render(false, '')));
        assert.equal(today().props['aria-current'], 'date', 'an undated task still marks today');
        assert.equal(renderer!.root.findAllByProps({ 'aria-pressed': true }).length, 0);
        await act(async () => renderer!.update(render(false, '2026-10-30')));
        assert.equal(today().props['aria-current'], 'date');
        const selected = renderer!.root.findByProps({ 'aria-label': '2026-10-30' });
        assert.equal(selected.props['aria-pressed'], true);
        assert.equal(selected.props['aria-current'], undefined, 'selected date and today remain distinct');
        await act(async () => renderer!.update(render()));
        const yearButton = () => renderer!.root.findAllByType('button').find(node => node.props['aria-label'] === 'Year')!;
        assert.equal(renderer!.root.findAllByProps({ 'aria-label': 'Previous year' }).length, 0);
        assert.equal(renderer!.root.findAllByProps({ 'aria-label': 'Next year' }).length, 0);
        const monthSelect = renderer!.root.findByProps({ 'aria-label': 'Month' });
        assert.equal(monthSelect.type, 'select');
        assert.equal(monthSelect.findAllByType('option').length, 12);
        await act(async () => monthSelect.props.onChange({ target: { value: '0' } }));
        assert.ok(renderer!.root.findByProps({ 'aria-label': '2026-01-01' }));
        await act(async () => monthSelect.props.onChange({ target: { value: '9' } }));
        assert.equal(renderer!.root.findByProps({ 'aria-label': '2026-09-30' }).props.className, 'outside');
        await act(async () => monthSelect.props.onChange({ target: { value: '10' } }));
        assert.equal(renderer!.root.findByProps({ 'aria-label': '2026-12-01' }).props.className, 'outside');
        await act(async () => monthSelect.props.onChange({ target: { value: '9' } }));
        await act(async () => yearButton().props.onClick());
        const list = () => renderer!.root.findByProps({ role: 'listbox' });
        const options = () => list().findAllByProps({ role: 'option' });
        assert.equal(options().length, 11);
        assert.equal(options()[0]!.children[0], '2021');
        assert.equal(options().at(-1)!.children[0], '2031');
        await act(async () => list().props.onScroll({ currentTarget: { scrollTop: 2497 * 32 } }));
        assert.equal(options().length, 11);
        assert.ok(options().some(node => node.children.includes('2500')));
        await act(async () => options().find(node => node.children.includes('2500'))!.props.onClick());
        assert.ok(renderer!.root.findByProps({ 'aria-label': '2500-10-01' }));
        await act(async () => yearButton().props.onClick());
        await act(async () => list().props.onScroll({ currentTarget: { scrollTop: 0 } }));
        assert.equal(options()[0]!.children[0], '1');
        await act(async () => list().props.onScroll({ currentTarget: { scrollTop: 9994 * 32 } }));
        assert.equal(options().at(-1)!.children[0], '9999');
        assert.equal(options().length, 11);
        await act(async () => list().props.onScroll({ currentTarget: { scrollTop: 2023 * 32 } }));
        await act(async () => options().find(node => node.children.includes('2026'))!.props.onClick());
        assert.ok(JSON.stringify(renderer!.toJSON()).includes('October'));
        await act(async () => renderer!.root.findByProps({ 'aria-label': 'Next month' }).props.onClick());
        assert.ok(JSON.stringify(renderer!.toJSON()).includes('November'));
        await act(async () => renderer!.root.findByProps({ 'aria-label': '2026-11-03' }).props.onClick());
        assert.deepEqual(values, ['2026-11-03']);
      } else {
        assert.ok(JSON.stringify(renderer!.toJSON()).includes('Minute'));
        await act(async () => renderer!.root.findAllByType('select')[0]!.props.onChange({ target: { value: '16' } }));
        assert.deepEqual(values, ['16:30']);
        await act(async () => renderer!.root.findAllByType('button').find(button => button.children.includes('Done'))!.props.onClick());
      }
      assert.equal(trigger().props['aria-expanded'], false);
      await act(async () => click());
      await act(async () => renderer!.root.findAllByType('button').find(button => button.children.includes('Clear'))!.props.onClick());
      assert.equal(values.at(-1), '', 'required date and time fields can both be cleared');
      assert.equal(renderer!.root.findByType('input').props.required, true, 'clearing preserves form validation');
      await act(async () => click());
      await act(async () => listeners.get('pointerdown')!({ target: 'outside' }));
      assert.equal(trigger().props['aria-expanded'], false);
      await act(async () => click());
      await act(async () => renderer!.root.findByProps({ className: 'date-time-input' }).props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }));
      assert.equal(trigger().props['aria-expanded'], false);
      await act(async () => renderer!.update(render(true)));
      assert.equal(trigger().props.disabled, true);
      await act(async () => renderer!.update(render(false, type === 'date' ? '2026-02-30' : '25:00')));
      assert.match(validity, /Enter a valid/);
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
      Object.assign(globalThis, globals);
    }
  });
}
