import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { CalendarDay, TaskList, DateNavigation, CalendarWeek, CalendarYear } from '../../src/panel/TaskViews';
import { TranslationProvider } from '../../src/i18n/react';
import type { PreviewItem } from '../../src/shared/models';
const noop = () => {};
const render = (element: React.ReactElement) => renderToStaticMarkup(React.createElement(TranslationProvider, { locale: 'en', children: element }));
const base: PreviewItem = { id: 'a', noteId: 'a', title: 'Completed task', date: '2026-10-25', kind: 'actual', pinned: false, priority: 'none', overdue: false, completed: true,
  schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' }, notebookId: 'book', tagIds: ['tag'] };
const list = (items: PreviewItem[]) => React.createElement(TaskList, { items, busy: false, onSelect: noop, onComplete: noop });

test('completed rows retain normal text markup and title/tag share the same inline heading', () => {
  const html = render(React.createElement(TaskList, { items: [base], busy: false, onSelect: noop, onComplete: noop,
    tags: [{ id: 'tag', title: 'Native tag' }], folders: [{ id: 'book', title: 'Native notebook' }] }));
  assert.match(html, /completed/); assert.match(html, /checked=""/);
  assert.doesNotMatch(html, /<del\b|<s\b|line-through/);
  assert.match(html, /class="task-heading"[\s\S]*class="task-title"[\s\S]*Completed task[\s\S]*class="task-tags"/);
  assert.ok(html.indexOf('Native tag') < html.indexOf('task-notebook'));
});

test('calendar header order is date then type selector then navigation controls', () => {
  const selector = React.createElement('select', { className: 'calendar-view-select', defaultValue: 'day' }, React.createElement('option', { value: 'day' }, 'Day'));
  const html = render(React.createElement(DateNavigation, { view: 'day', label: 'Date range', viewSelector: selector, onNavigate: noop, onToday: noop }));
  assert.ok(html.indexOf('date-label') < html.indexOf('calendar-view-select'));
  assert.ok(html.indexOf('calendar-view-select') < html.indexOf('period-navigation'));
});

test('each all-day and timed task has its own timeline entry and node even at the same time', () => {
  const timed: PreviewItem = { ...base, id: 'timed-1', noteId: 'timed-1', completed: false, schedule: { kind: 'timed', date: base.date, time: '10:00', zone: 'Asia/Shanghai', instant: Date.parse('2026-10-25T02:00:00Z') } };
  const html = render(React.createElement(CalendarDay, { items: [base, { ...base, id: 'b', noteId: 'b' }, timed, { ...timed, id: 'timed-2', noteId: 'timed-2' }], renderList: list }));
  assert.equal((html.match(/class="timeline-entry/g) || []).length, 4);
  assert.equal((html.match(/class="timeline-node/g) || []).length, 4);
  assert.equal((html.match(/timeline-entry all-day/g) || []).length, 2);
});

test('week and year preserve seven columns and twelve month panels before viewport CSS applies', () => {
  const week = render(React.createElement(CalendarWeek, { date: base.date, items: [], onSelect: noop, renderList: list }));
  assert.equal((week.match(/class="week-column/g) || []).length, 7);
  const year = render(React.createElement(CalendarYear, { date: base.date, selectedDate: base.date, items: [], onSelect: noop }));
  assert.equal((year.match(/class="year-month"/g) || []).length, 12);
});

test('PPT layout CSS retains fixed grids at every breakpoint and never strikes or fades completed text', () => {
  const css = readFileSync(new URL('../../src/panel/panel.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /line-through/);
  const rules = Array.from(css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g), match => ({ selector: match[1]!.trim(), body: match[2]! }));
  for (const [selector, count] of [['.week-board', 7], ['.year-grid', 4]] as const) {
    const grids = rules.filter(rule => rule.selector.split(',').some(part => part.trim() === selector) && rule.body.includes('grid-template-columns'));
    assert.ok(grids.length, selector);
    for (const rule of grids) assert.match(rule.body, new RegExp(`grid-template-columns:\\s*repeat\\(${count}\\s*,`), selector);
  }
  for (const rule of rules.filter(rule => rule.selector.includes('completed'))) {
    const opacity = /(?:^|;)\s*opacity:\s*([\d.]+)/.exec(rule.body);
    if (opacity) assert.equal(Number(opacity[1]), 1, rule.selector);
    assert.doesNotMatch(rule.body, /color:\s*var\(--muted\)|filter:\s*(?:opacity|brightness)/);
  }
  assert.match(css, /\.task-heading\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.calendar-summary\s*\{[^}]*justify-content:\s*flex-end/);
});

test('calendar and list share quick add and completed filter while sorting stays list-only', () => {
  const source = readFileSync(new URL('../../src/panel/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /className="calendar-summary"/); assert.match(source, /className="task-total"/);
  assert.match(source, /className="options-label"/);
  assert.match(source, /\{data && <QuickAddTask/);
  assert.match(source, /<div className="view-options">/);
  assert.doesNotMatch(source, /!isCalendar && <div className="view-options"/);
  assert.match(source, /!isCalendar && <ListSortMenu/);
  assert.match(source, /isCalendar && data && <div className="calendar-summary"/);
  assert.doesNotMatch(source, /list\.showOverdue|checked=\{showOverdue\}/);
  assert.doesNotMatch(source, /isCalendar && data && <GroupedList/);
  assert.doesNotMatch(source, /data\.items\.filter\(item => !item\.overdue\)/);
});

test('day view collapses empty periods by default while keeping task rows visible', () => {
  const timed: PreviewItem = {...base, id: 'afternoon', title: 'Visible afternoon task', schedule: {kind: 'timed', date: base.date, time: '14:00', zone: 'UTC', instant: new Date(2026, 9, 25, 14).getTime()}};
  const html = render(React.createElement(CalendarDay, {items: [base, timed], renderList: list}));
  assert.match(html, /<details class="timeline-gap">/);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
  assert.match(html, /Free time/);
  assert.match(html, /Visible afternoon task/);
  assert.match(html, /Completed task/);
});
