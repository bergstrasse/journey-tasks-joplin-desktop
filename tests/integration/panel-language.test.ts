import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarMonth, CalendarYear, DateNavigation, TaskList } from '../../src/panel/TaskViews';
import { TranslationProvider } from '../../src/i18n/react';
import { createTranslator, registry, type LocaleId } from '../../src/i18n';
import { CalendarViewPicker } from '../../src/panel/CalendarViewPicker';
import { SettingsPage } from '../../src/panel/SettingsPage';
import { defaultPreferences } from '../../src/adapters/joplin/localIntentStore';
import type { PreviewItem, Task } from '../../src/shared/models';

const noOp = () => {};
const render = (element: React.ReactElement, locale: LocaleId = 'en') =>
  renderToStaticMarkup(React.createElement(TranslationProvider, { locale, children: element }));
const item: PreviewItem = {
  id: 'native-one', noteId: 'native-one', date: '2026-10-25', title: '今日 <img src=x onerror=alert(1)>',
  kind: 'actual', priority: 'high', pinned: true,
  schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' }, overdue: false, completed: false,
};

test('English task rows translate controls, metadata and accessibility while preserving and escaping Chinese user titles', () => {
  const html = render(React.createElement(TaskList, { items: [item], busy: false, onSelect: noOp, onComplete: noOp }));

  assert.doesNotMatch(html, /High priority|priority-high/);
  assert.match(html, /aria-label="Complete 今日 &lt;img/);
  assert.match(html, /今日 &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html.replaceAll('今日', ''), /[\u3400-\u9fff]/, 'only the user title may remain Chinese');
  const keyTitle = render(React.createElement(TaskList, { items: [{ ...item, pinned: false, title: 'view.today' }], busy: false, onSelect: noOp, onComplete: noOp }));
  assert.match(keyTitle, /class="task-title">[^<]*view\.today</,
    'a user title matching a translation key must remain the literal title');
});

test('English forecast rows translate their completion assumption and remain visibly read-only', () => {
  const forecast: PreviewItem = { ...item, id: 'forecast', title: 'Task', kind: 'projected', seriesId: 'series',
    noteId: undefined, pinned: false, assumption: '按如期完成估算' };
  const html = render(React.createElement(TaskList, { items: [forecast], busy: false, onSelect: noOp, onComplete: noOp }));
  assert.match(html, /Forecast/);
  assert.match(html, /Repeating/);
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.doesNotMatch(html, /[\u3400-\u9fff]/, 'the forecast assumption is UI text, not user task content');
});


test('English calendar localizes weekdays, lunar labels, day accessibility and all twelve month names', () => {
  const props = { date: '2026-10-01', items: [item], selectedDate: '2026-10-25', onSelect: noOp };
  const month = render(React.createElement(CalendarMonth, props));
  for (const weekday of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) assert.match(month, new RegExp(`>${weekday}<`));
  assert.match(month, /aria-label="2026-10-25, 1 tasks"/);

  assert.doesNotMatch(month, /[\u3400-\u9fff]/);
  const year = render(React.createElement(CalendarYear, props));
  for (const name of ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'])
    assert.match(year, new RegExp(`>${name}</button>`));
  assert.doesNotMatch(year, /[\u3400-\u9fff]/);
});

test('English calendar navigation uses month/year semantics, while fixed views still have no arrows', () => {
  for (const view of ['month', 'year'] as const) {
    const html = render(React.createElement(DateNavigation, { view, label: 'October 2026', onNavigate: noOp, onToday: noOp }));
    assert.match(html, new RegExp(`aria-label="Previous ${view}"`));
    assert.match(html, new RegExp(`aria-label="Next ${view}"`));
    assert.match(html, new RegExp(`>This ${view}<`));
    assert.doesNotMatch(html, /[\u3400-\u9fff]/);
  }
  for (const view of ['today', 'sevenDays'] as const) {
    const html = render(React.createElement(DateNavigation, { view, label: 'Fixed range', onNavigate: noOp, onToday: noOp }));
    assert.doesNotMatch(html, /<button/);
  }
});

test('provider switching changes only UI strings; standalone components retain the Chinese default', () => {
  const element = React.createElement(TaskList, { items: [item], busy: false, onSelect: noOp, onComplete: noOp });
  assert.match(render(element, 'zh-CN'), /2026-10-25|今日/);
  assert.match(render(element, 'en'), /2026-10-25|Today/);
  assert.match(renderToStaticMarkup(element), /2026-10-25|今日/);
  assert.equal(item.title, '今日 <img src=x onerror=alert(1)>');
});

test('every registered language renders settings, native language choices and task actions', () => {
  for (const [locale, entry] of Object.entries(registry)) {
    const t = createTranslator(locale);
    const settings = render(React.createElement(SettingsPage, {
      preferences: { ...defaultPreferences, language: locale as LocaleId }, busy: false,
      onSave: async () => {}, onCancel: noOp, onCommand: async () => { throw new Error('render must not write'); }, onCleared: noOp,
    }), locale as LocaleId);
    const escaped = (value: string) => renderToStaticMarkup(React.createElement('span', null, value)).slice(6, -7);
    assert.ok(settings.includes(`<h1>${escaped(t('settings.title'))}</h1>`), locale);
    for (const language of Object.values(registry)) {
      assert.ok(settings.includes(`value="${language.id}"`), `${locale}: ${language.id} option`);
      assert.ok(settings.includes(escaped(language.nativeName)), language.id);
    }
    const row = render(React.createElement(TaskList, { items: [item], busy: false, onSelect: noOp, onComplete: noOp }), locale as LocaleId);
    assert.ok(row.includes(escaped(t('actions.completeTask', { title: item.title }))), entry.id);
    assert.ok(row.includes('今日 &lt;img'), 'user content remains intact');
    assert.doesNotMatch(row, /\{title\}|\{count\}/);
  }
});

// Issue 40: the screenshot showed “周” next to “本週” in the same toolbar.
test('Chinese calendar toolbars use consistent week terminology for each script', () => {
  for (const [locale, week, current, previous, next] of [
    ['zh-TW', '週', '本週', '上一週', '下一週'],
    ['zh-CN', '周', '本周', '上一周', '下一周'],
  ] as const) {
    const toolbar = render(React.createElement(DateNavigation, {
      view: 'week', label: '2026-10-25', onNavigate: noOp, onToday: noOp,
      viewSelector: React.createElement(CalendarViewPicker, { view: 'week', onChange: noOp }),
    }), locale);
    assert.ok(toolbar.includes(`<span>${week}</span>`), `${locale}: view picker`);
    assert.ok(toolbar.includes(`>${current}</button>`), `${locale}: current week`);
    assert.ok(toolbar.includes(`aria-label="${previous}"`), `${locale}: previous week`);
    assert.ok(toolbar.includes(`aria-label="${next}"`), `${locale}: next week`);
    assert.doesNotMatch(toolbar, locale === 'zh-TW' ? /周/ : /週/);
    const month = render(React.createElement(CalendarMonth, {
      date: '2026-10-01', items: [], selectedDate: '2026-10-25', onSelect: noOp,
    }), locale);
    assert.ok(month.includes(`<span>${week}</span>`), `${locale}: week number heading`);
    assert.ok(month.includes(`第 44 ${week}，2026-10-25 起`), `${locale}: week accessibility`);
    assert.doesNotMatch(month, locale === 'zh-TW' ? /周/ : /週/);
  }
});
