import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from '../../src/i18n';
import { TranslationProvider } from '../../src/i18n/react';
import { CalendarDisplayContext, displayDate, lunarText } from '../../src/panel/calendarDisplay';
import { CalendarMonth, CalendarWeek, CalendarYear, GroupedList, TaskList } from '../../src/panel/TaskViews';
import type { PreviewItem } from '../../src/shared/models';
import { TaskApplication } from '../../src/services/taskApplication';
import { MemoryJoplin } from '../support/memory-joplin';

const t = createTranslator('zh-CN');
test('traditional lunar names cover leap months, month ends and all day naming boundaries', () => {
  for (const [date, label] of [
    ['2023-01-21', '腊月三十'], ['2023-01-22', '正月初一'],
    ['2023-03-22', '闰二月初一'], ['2023-04-19', '闰二月廿九'],
    ['2025-07-25', '闰六月初一'], ['2026-10-09', '八月廿九'],
    ['2026-10-10', '九月初一'], ['2026-10-19', '九月初十'],
    ['2026-10-20', '九月十一'], ['2026-10-27', '九月十八'],
    ['2026-10-29', '九月二十'], ['2026-10-30', '九月廿一'],
  ]) assert.equal(lunarText(date!, t), label);
  assert.equal(displayDate('1800-01-01', 'lunar', t, 'January 1'), 'January 1');
});

test('display preference changes list rows, date groups and week/month/year calendar cells', () => {
  const item: PreviewItem = { id: 'one', kind: 'actual', date: '2026-10-27', title: 'Task', priority: 'none', pinned: false, completed: false, overdue: false,
    schedule: { kind: 'allDay', date: '2026-10-27', zone: 'Asia/Shanghai' } };
  const noOp = () => {};
  const props = { date: item.date, selectedDate: item.date, items: [item], onSelect: noOp, renderList: () => null };
  for (const element of [
    React.createElement(TaskList, { items: [item], busy: false, onSelect: noOp, onComplete: noOp }),
    React.createElement(GroupedList, { items: [item], renderList: () => null }),
    React.createElement(CalendarWeek, props), React.createElement(CalendarMonth, props), React.createElement(CalendarYear, props),
  ]) {
    const render = (calendar: 'solar' | 'lunar') => renderToStaticMarkup(React.createElement(TranslationProvider, { locale: 'zh-CN',
      children: React.createElement(CalendarDisplayContext.Provider, { value: calendar, children: element }) }));
    assert.match(render('lunar'), /十八</);
    assert.doesNotMatch(render('lunar'), /九月十八</);
    assert.doesNotMatch(render('solar'), /九月十八</);
  }
});

test('display calendar persists independently of task input calendar and rejects invalid values', async () => {
  const host = new MemoryJoplin();
  const app = new TaskApplication(host); await app.initialize();
  assert.equal((await app.snapshot()).preferences.displayCalendar, 'solar');
  await app.dispatch({ action: 'savePreferences', requestId: 'display-lunar', preferences: { displayCalendar: 'lunar' } });
  const restarted = new TaskApplication(host); await restarted.initialize();
  const prefs = (await restarted.snapshot()).preferences;
  assert.equal(prefs.displayCalendar, 'lunar');
  assert.equal(prefs.defaultCalendar, 'solar');
  const invalid = await restarted.dispatch({ action: 'savePreferences', requestId: 'display-invalid', preferences: { displayCalendar: 'invalid' as any } });
  assert.equal(invalid.code, 'INVALID_CALENDAR');
  assert.equal((await restarted.snapshot()).preferences.displayCalendar, 'lunar');
});

test('lunar display includes the month only on the first day, while tooltips retain full dates', () => {
  assert.equal(displayDate('2026-10-10', 'lunar', t, '10'), '九月初一');
  assert.equal(displayDate('2026-10-27', 'lunar', t, '27'), '十八');
  assert.equal(displayDate('2023-03-22', 'lunar', t, '22'), '闰二月初一');
  assert.equal(lunarText('2026-10-27', t), '九月十八');
});

test('issue50 calendar task titles begin with a repeat marker for actual and projected series', () => {
  const base: PreviewItem = { id: 'single', kind: 'actual', date: '2026-10-30', title: 'Single task', priority: 'none', pinned: false, completed: false, overdue: false,
    schedule: { kind: 'allDay', date: '2026-10-30', zone: 'Asia/Shanghai' } };
  const items: PreviewItem[] = [base,
    { ...base, id: 'actual-repeat', title: 'Actual repeat', seriesId: 'series' },
    { ...base, id: 'projected-repeat', kind: 'projected', title: 'Projected repeat', seriesId: 'series' }];
  for (const props of [{ compact: true }, { hideDate: true }, {}]) {
    const html = renderToStaticMarkup(React.createElement(TranslationProvider, { locale: 'zh-CN', children:
      React.createElement(TaskList, { ...props, items, busy: false, onSelect() {}, onComplete() {} }) }));
    const rows = html.match(/<article\b[\s\S]*?<\/article>/g)!;
    assert.equal(rows.length, 3);
    assert.doesNotMatch(rows[0]!, /repeat-mark/);
    for (const row of rows.slice(1)) {
      assert.equal((row.match(/class="repeat-mark"/g) || []).length, 1);
      assert.match(row, /class="repeat-mark" role="img" aria-label="重复"/);
      const heading = row.match(/<span class="task-heading">([\s\S]*?)<span class="task-title">/)!;
      assert.equal(heading[1]!.includes('repeat-mark'), !!(props.compact || props.hideDate));
    }
  }
});
