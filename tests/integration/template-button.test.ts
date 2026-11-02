import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { NotebookPicker } from '../../src/panel/NotebookPicker';
import { TaskForm, SeriesEditor } from '../../src/panel/App';
import { TranslationProvider } from '../../src/i18n/react';
import type { SeriesDefinition, Task } from '../../src/shared/models';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const label = (root: ReactTestInstance, text: string) => root.findAllByType('label').find(node => node.children.includes(text))!;
const button = (root: ReactTestInstance) => root.findAllByType('button').find(node => node.children.includes('Insert template block'))!;
const task: Task = { taskId: 'task', noteId: 'note', title: 'Existing', notebookId: 'book', tagIds: [], schedule: { kind: 'none' }, completedAt: 0, priority: 'none', pinned: false, reminder: { enabled: false } };

test('existing task shows an actionable template button immediately below archive hint', async () => {
  let renderer!: ReactTestRenderer;
  let inserted = 0;
  let submitted = 0;
  await act(async () => { renderer = create(React.createElement(TranslationProvider, { locale: 'en', children: React.createElement(TaskForm, {
    folders: [{ id: 'book', title: 'Book' }], initialDate: '2026-10-27', busy: false, task,
    onInsertTemplate: () => { inserted++; }, onSubmit: () => { submitted++; },
  }) })); });
  try {
    await act(async () => { label(renderer.root, 'Repeating task').findByType('input').props.onChange({ target: { checked: true } }); });
    await act(async () => { label(renderer.root, 'Note mode').findByType('select').props.onChange({ target: { value: 'archive' } }); });
    const insert = button(renderer.root);
    assert.ok(insert, 'archive mode must show the button for an existing task');
    assert.equal(insert.props.type, 'button');
    const siblings = renderer.root.findByType('form').findAll(node => node.parent?.type === 'form');
    const index = siblings.indexOf(insert);
    assert.match(siblings[index - 1]!.children.join(''), /Templates are optional/);
    await act(async () => { insert.props.onClick(); });
    assert.equal(submitted, 0);
    assert.equal(inserted, 1);
    await act(async () => { label(renderer.root, 'Note mode').findByType('select').props.onChange({ target: { value: 'continuous' } }); });
    assert.equal(button(renderer.root), undefined);
    await act(async () => { label(renderer.root, 'Note mode').findByType('select').props.onChange({ target: { value: 'archive' } }); });
    assert.ok(button(renderer.root), 'button returns after switching back to archive');
  } finally { await act(async () => renderer.unmount()); }
});

test('series editor archive mode keeps the template action visible and wired', async () => {
  const definition: SeriesDefinition = { seriesId: 'series', revisionId: 'revision', parentRevisionIds: [], rule: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } }, anchor: { kind: 'allDay', date: '2026-10-27', zone: 'Asia/Shanghai' }, priority: 'none', pinned: false, modeForNext: 'archive', reminder: { enabled: false }, sourceNotebookId: 'book', sourceTagIds: [] };
  let renderer!: ReactTestRenderer;
  let inserted = 0;
  await act(async () => { renderer = create(React.createElement(TranslationProvider, { locale: 'en', children: React.createElement(SeriesEditor, { definition, consumedCount: 0, busy: false, onSave() {}, onInsertTemplate: () => { inserted++; } }) })); });
  try {
    assert.ok(button(renderer.root));
    await act(async () => button(renderer.root).props.onClick());
    assert.equal(inserted, 1);
  } finally { await act(async () => renderer.unmount()); }
});


test('new task has no body editor and cannot configure recurrence until the note exists', async () => {
  let renderer!: ReactTestRenderer;
  let input: any;
  const props = { folders: [{ id: 'book', title: 'Book' }], initialDate: '2026-10-27', busy: false, onSubmit: (value: any) => { input = value; } };
  await act(async () => { renderer = create(React.createElement(TranslationProvider, { locale: 'en', children: React.createElement(TaskForm, props) })); });
  try {
    assert.equal(renderer.root.findAllByType('textarea').length, 0);
    assert.equal(label(renderer.root, 'Repeating task').findByType('input').props.disabled, true);
    assert.equal(button(renderer.root), undefined);
    assert.equal(renderer.root.findAllByType('select').some(node => node.props.value === 'continuous'), false);
    assert.ok(renderer.root.findAllByType('button').some(node => node.children.includes('Save and open note')));
    await act(async () => label(renderer.root, 'Title').findByType('input').props.onChange({ target: { value: 'New native note' } }));
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.equal(input.title, 'New native note');
    assert.equal('body' in input, false);
    assert.equal('recurrence' in input, false);
    assert.equal('mode' in input, false);
    await act(async () => { renderer.update(React.createElement(TranslationProvider, { locale: 'en', children: React.createElement(TaskForm, { ...props, task }) })); });
    assert.equal(label(renderer.root, 'Repeating task').findByType('input').props.disabled, false);
    assert.equal(renderer.root.findAllByType('textarea').length, 0);
  } finally { await act(async () => renderer.unmount()); }
});

test('series reminder controls load the policy and submit changed all-day time and disabled state', async () => {
  const definition: SeriesDefinition = { seriesId: 'series', revisionId: 'revision', parentRevisionIds: [], rule: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } }, anchor: { kind: 'allDay', date: '2026-10-27', zone: 'Asia/Shanghai' }, priority: 'none', pinned: false, modeForNext: 'continuous', reminder: { enabled: true, allDayTime: '08:00' }, sourceNotebookId: 'book', sourceTagIds: [] };
  let renderer!: ReactTestRenderer;
  let saved!: SeriesDefinition;
  await act(async () => { renderer = create(React.createElement(TranslationProvider, { locale: 'en', children: React.createElement(SeriesEditor, { definition, consumedCount: 0, busy: false, onSave: value => { saved = value; }, onInsertTemplate() {} }) })); });
  try {
    const reminder = renderer.root.findAllByType('input').find(node => node.props.type === 'checkbox' && node.props.checked === true)!;
    const times = () => renderer.root.findAllByType('input').filter(node => node.props.placeholder === 'HH:mm');
    assert.equal(times().at(-1)!.props.value, '08:00');
    await act(async () => times().at(-1)!.props.onChange({ target: { value: '10:30' } }));
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.deepEqual(saved.reminder, { enabled: true, allDayTime: '10:30' });
    await act(async () => reminder.props.onChange({ target: { checked: false } }));
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    assert.equal(saved.reminder.enabled, false);
    assert.equal(definition.reminder.allDayTime, '08:00');
  } finally { await act(async () => renderer.unmount()); }
});

test('series editor moves the series through the notebook selector without an extra checkbox', async () => {
  const definition: SeriesDefinition = { seriesId: 'series', revisionId: 'revision', parentRevisionIds: [],
    rule: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
    anchor: { kind: 'allDay', date: '2026-10-27', zone: 'Asia/Shanghai' }, priority: 'none', pinned: false,
    modeForNext: 'archive', reminder: { enabled: false }, sourceNotebookId: 'A', sourceTagIds: [] };
  let renderer!: ReactTestRenderer;
  let saved!: { definition: SeriesDefinition; move?: boolean };
  await act(async () => { renderer = create(React.createElement(TranslationProvider, { locale: 'en',
    children: React.createElement(SeriesEditor, { definition, folders: [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }],
      consumedCount: 0, busy: false, onInsertTemplate() {}, onSave: (definition, _schedule, move) => { saved = { definition, move }; } }) })); });
  const submit = async () => act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  try {
    await submit(); assert.equal(saved.move, false); assert.equal(saved.definition.sourceNotebookId, 'A');
    await act(async () => renderer.root.findByType(NotebookPicker).props.onChange('B'));
    await submit(); assert.equal(saved.move, true); assert.equal(saved.definition.sourceNotebookId, 'B');
    assert.equal(definition.sourceNotebookId, 'A');
    await act(async () => renderer.root.findByType(NotebookPicker).props.onChange('A'));
    await submit(); assert.equal(saved.move, true); assert.equal(saved.definition.sourceNotebookId, 'A');
  } finally { await act(async () => renderer.unmount()); }
});
