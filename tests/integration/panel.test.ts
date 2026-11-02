import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarMonth, CalendarYear, TaskList } from '../../src/panel/TaskViews';
import { PanelController } from '../../src/panel/controller';
import type { PreviewItem } from '../../src/shared/models';

const forecast: PreviewItem = { id: 'preview', date: '2026-10-25', title: '<img src=x onerror=alert(1)>', kind: 'projected',
  priority: 'high', pinned: false, schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' }, overdue: false, completed: false };

test('forecast rows escape task text and never expose a real completion checkbox', () => {
  const html = renderToStaticMarkup(React.createElement(TaskList, { items: [forecast], busy: false, onSelect() {}, onComplete() {} }));
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/); assert.doesNotMatch(html, /type="checkbox"/);
  assert.match(html, /预计/); assert.doesNotMatch(html, /高优先级|priority-high/);
});

test('month grid has seven-day rows and accessible daily task counts; year renders all twelve months', () => {
  const props = { date: '2026-10-01', items: [forecast], selectedDate: '2026-10-25', onSelect() {} };
  const month = renderToStaticMarkup(React.createElement(CalendarMonth, props));
  const cells = (month.match(/class="calendar-day/g) || []).length;
  assert.ok(cells >= 28 && cells <= 42 && cells % 7 === 0);
  assert.match(month, /2026-10-25，1项任务/);
  const year = renderToStaticMarkup(React.createElement(CalendarYear, props));
  assert.equal((year.match(/class="calendar compact"/g) || []).length, 12);
});

test('panel bridge rejects unversioned messages, arbitrary API actions and mismatched request IDs', async () => {
  let dispatched = 0;
  const controller = new PanelController({} as any, { dispatch: async () => { dispatched++; return { status: 'saved' }; }, snapshot: async () => ({ view: 'today' }) } as any);
  for (const message of [{}, { protocolVersion: 1, requestId: 'x', action: 'executeAnyApi' },
    { protocolVersion: 1, requestId: 'x', action: 'command', command: { requestId: 'wrong', action: 'deleteTask' } },
    { protocolVersion: 1, requestId: 'x', action: 'snapshot', query: { view: '__proto__' } },
    { protocolVersion: 1, requestId: 'x', action: 'command', command: { requestId: 'x', action: 'defer' } },
    { protocolVersion: 1, requestId: 'x', action: 'command', command: { requestId: 'x', action: 'deferTask' } }]) {
    assert.equal((await controller.handleMessage(message)).ok, false);
  }
  assert.equal(dispatched, 0);
  assert.equal((await controller.handleMessage({ protocolVersion: 1, requestId: 'x', action: 'snapshot', query: { view: 'today' } })).ok, true);
});


test('panel refresh command rescans native notes before reading the next snapshot', async () => {
  const { TaskApplication } = await import('../../src/services/taskApplication');
  const { MemoryJoplin } = await import('../support/memory-joplin');
  const { DEFAULT_PLUGIN_ID } = await import('../../src/adapters/joplin/repositories');
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  const app = new TaskApplication(host); await app.initialize();
  const controller = new PanelController({} as any, app);
  host.seedNote({ id: 'created-after-panel', title: '刷新发现' });
  const globalHost = globalThis as any;
  globalHost.webviewApi = { postMessage: (message: unknown) => controller.handleMessage(message) };
  try {
    const { sendCommand, querySnapshot } = await import('../../src/panel/client');
    await sendCommand({ action: 'refresh', requestId: 'panel-real-refresh' });
    const snapshot = await querySnapshot({});
    assert.ok(snapshot.tasks.some(t => t.noteId === 'created-after-panel'));
  } finally { delete globalHost.webviewApi; app.dispose(); }
});

test('fixed today and seven-day views expose no unusable date arrows; calendars expose enabled period controls', async () => {
  const { DateNavigation } = await import('../../src/panel/TaskViews');
  for (const view of ['today', 'sevenDays'] as const) {
    const html = renderToStaticMarkup(React.createElement(DateNavigation, { view, label: '固定今日范围', onNavigate() { throw new Error('fixed view must not navigate'); }, onToday() {} }));
    assert.match(html, /固定今日范围/); assert.doesNotMatch(html, /<button/);
  }
  for (const view of ['month', 'year'] as const) {
    const html = renderToStaticMarkup(React.createElement(DateNavigation, { view, label: '当前期间', onNavigate() {}, onToday() {} }));
    const unit = view === 'month' ? '月' : '年';
    assert.match(html, new RegExp(`aria-label="上一${unit}"`));
    assert.match(html, new RegExp(`aria-label="下一${unit}"`));
    assert.match(html, new RegExp(`本${unit}`)); assert.doesNotMatch(html, /disabled/);
  }
});


test('calendar navigation crosses year and leap-month boundaries with month and year steps', async () => {
  const { shiftMonth } = await import('../../src/panel/App');
  assert.equal(shiftMonth('2024-12-31', 1), '2025-01-01');
  assert.equal(shiftMonth('2024-03-31', -1), '2024-02-01');
  assert.equal(shiftMonth('2024-02-29', 12), '2025-02-01');
  assert.equal(shiftMonth('2024-02-29', -12), '2023-02-01');
});

test('drawer scroll lock restores root scrolling and its previous position on cleanup', async () => {
  const { lockPanelScroll } = await import('../../src/panel/scroll');
  const root = { style: { overflowY: '' }, scrollTop: 375 } as HTMLElement;
  const unlock = lockPanelScroll(root);
  assert.equal(root.style.overflowY, 'hidden');
  root.scrollTop = 0;
  unlock();
  assert.equal(root.style.overflowY, '');
  assert.equal(root.scrollTop, 375);
  const custom = { style: { overflowY: 'scroll' }, scrollTop: 54 } as HTMLElement;
  lockPanelScroll(custom)();
  assert.equal(custom.style.overflowY, 'scroll');
  assert.equal(custom.scrollTop, 54);
  assert.doesNotThrow(() => lockPanelScroll(null)());
});
