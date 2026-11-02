import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskForm } from '../../src/panel/App';
import { TranslationProvider } from '../../src/i18n/react';
import type { Task } from '../../src/shared/models';

test('backend submission errors are rendered inside the open task form beside the explicit submit button', () => {
  let submitted = 0;
  const error = 'INVALID_RULE: Invalid month day <img src=x onerror=alert(1)>';
  const form = React.createElement(TaskForm, { folders: [{ id: 'book', title: '目标笔记本' }], initialDate: '2026-10-25',
    busy: false, submitError: error, onSubmit: () => { submitted++; } });
  const html = renderToStaticMarkup(React.createElement(TranslationProvider, { locale: 'en', children: form }));
  assert.equal(submitted, 0, 'SSR is not a real user submit');
  assert.match(html, /^<form[\s>]/);
  assert.match(html, /role="alert">INVALID_RULE: Invalid month day &lt;img/);
  assert.match(html, /role="alert">[^<]*<\/p><button type="submit"/);
  assert.match(html, />Save and open note<\/button>/);
  assert.doesNotMatch(html, /<img/);
});

test('editing an undated native task retains an empty date field and can display server errors without assigning today', () => {
  const task: Task = { taskId: 'native', noteId: 'native', title: '已有任务', notebookId: 'book', tagIds: [],
    schedule: { kind: 'none' }, completedAt: 0, priority: 'none', pinned: false, reminder: { enabled: false } };
  const html = renderToStaticMarkup(React.createElement(TaskForm, { folders: [{ id: 'book', title: '目标笔记本' }], task,
    initialDate: '2026-10-25', busy: false, submitError: '保存失败，请检查重复规则', onSubmit() {} }));
  assert.match(html, /placeholder="YYYY-MM-DD"[^>]*value=""/);
  assert.match(html, /role="alert">保存失败，请检查重复规则<\/p>/);
  assert.match(html, /type="submit"/);
});
