import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { JoplinGateway } from '../../src/adapters/joplin/gateway';
import { defaultPreferences } from '../../src/adapters/joplin/localIntentStore';
import { definition as seriesDefinition } from '../fixtures/series';
import { TaskApplication } from '../../src/services/taskApplication';
import { notebookRows } from '../../src/panel/notebookTree';
import { TaskContextMenu } from '../../src/panel/TaskContextMenu';
import { GroupedList } from '../../src/panel/TaskViews';
import { TaskFilters } from '../../src/panel/TaskFilters';
import { TaskForm, SeriesEditor } from '../../src/panel/App';
import { QuickAddTask } from '../../src/panel/QuickAddTask';
import { TranslationProvider } from '../../src/i18n/react';
import { groupListItems } from '../../src/panel/viewModel';
import { MemoryJoplin } from '../support/memory-joplin';
import type { Task, PreviewItem, SeriesDefinition } from '../../src/shared/models';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Deliberately reverse title order: the host can sort by updated date or reverse
// title order. Identical child names must stay under their respective parents.
const tree = [
  { id: 'z', title: '工作', children: [
    { id: 'z10', title: '项目 10', parent_id: 'z' },
    { id: 'z2', title: '项目 2', parent_id: 'z', children: [{ id: 'deep', title: '资料', parent_id: 'z2' }] },
    { id: 'same-b', title: '同名', parent_id: 'z' },
    { id: 'same-a', title: '同名', parent_id: 'z' },
  ] },
  { id: 'a', title: '个人', children: [{ id: 'a2', title: '项目 2', parent_id: 'a' }] },
];
const ids = ['z', 'z10', 'z2', 'deep', 'same-b', 'same-a', 'a', 'a2'];
const task: Task = { taskId: 'task', noteId: 'note', title: 'Task', notebookId: 'z2', tagIds: [], completedAt: 0, priority: 'none', pinned: false, reminder: { enabled: false }, schedule: { kind: 'allDay', date: '2026-10-31', zone: 'Asia/Shanghai' } };

async function nativeCatalog() {
  const host = new MemoryJoplin();
  const get = host.data.get;
  host.data.get = async (path, query) => {
    if (path.length === 1 && path[0] === 'folders') {
      assert.equal(query?.as_tree, 1, 'must delegate ordering to the native tree API');
      assert.ok((query?.fields as string[]).includes('user_updated_time'), 'native updated-date sorting needs the folder timestamp');
      return structuredClone(tree);
    }
    return get(path, query);
  };
  return { host, folders: await new JoplinGateway(host).folders() };
}

test('issue69 native tree order and parent links survive gateway and application snapshot', async () => {
  const { host, folders } = await nativeCatalog();
  assert.deepEqual(folders.map(f => f.id), ids);
  assert.ok(folders.every(f => !('children' in f)), 'flat transport should not duplicate nested trees');
  assert.equal(folders.find(f => f.id === 'z2')?.parent_id, 'z');
  const app = new TaskApplication(host);
  try {
    await app.initialize();
    assert.deepEqual((await app.snapshot()).folders.map(f => f.id), ids);
  } finally { app.dispose(); }
  const before = structuredClone(folders);
  const rows = notebookRows(folders);
  assert.deepEqual(rows.map(row => row.id), ids);
  assert.equal(rows.find(row => row.id === 'deep')?.path, '工作 / 项目 2 / 资料');
  assert.equal(rows.find(row => row.id === 'deep')?.depth, 2);
  assert.deepEqual(folders, before);
});

test('issue69 every notebook picker preserves native hierarchy regardless of plugin language', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.assign(globalThis, { document: { activeElement: null, addEventListener() {}, removeEventListener() {} } });
  const { folders } = await nativeCatalog();
  const expectedLabels = notebookRows(folders).map(row => row.title);
  const commands: any[] = [];
  let renderer: ReactTestRenderer | undefined;
  const render = async (element: React.ReactElement) => {
    if (renderer) await act(async () => renderer!.unmount());
    await act(async () => { renderer = create(React.createElement(TranslationProvider, { locale: 'en', children: element })); });
    return renderer!.root;
  };
  try {
    let root = await render(React.createElement(TaskContextMenu, { task, folders, x: 0, y: 0, busy: false, onClose() {}, onCommand: async inputs => { commands.push(...inputs); return undefined; } }));
    await act(async () => root.findByProps({ 'data-submenu': 'move' }).props.onClick());
    const buttons = () => root.findByProps({ className: 'menu-folder-list' }).findAllByProps({ className: 'notebook-choice' });
    assert.deepEqual(buttons().map(button => button.props.title), notebookRows(folders).map(row => row.path));
    assert.ok(root.findAllByProps({ role: 'treeitem' })[3].props.style.paddingInlineStart > root.findAllByProps({ role: 'treeitem' })[2].props.style.paddingInlineStart);
    assert.deepEqual(buttons().map(button => button.findByType('span').children.join('')), expectedLabels);
    const fold = () => root.findAllByProps({ className: 'notebook-toggle' }).find(button => button.props.title === '工作')!;
    assert.equal(fold().findByType('svg').props['aria-hidden'], 'true');
    await act(async () => fold().props.onClick());
    assert.deepEqual(buttons().map(button => button.props['data-notebook-id']), ['z', 'a', 'a2']);
    assert.equal(commands.length, 0, 'folding never moves the task');
    await act(async () => root.findByProps({ type: 'search' }).props.onChange({ target: { value: '资料' } }));
    assert.deepEqual(buttons().map(button => button.props.title), ['工作', '工作 / 项目 2', '工作 / 项目 2 / 资料']);
    await act(async () => root.findByProps({ type: 'search' }).props.onChange({ target: { value: '' } }));
    assert.deepEqual(buttons().map(button => button.props['data-notebook-id']), ['z', 'a', 'a2']);
    await act(async () => fold().props.onClick());
    await act(async () => root.findByProps({ type: 'search' }).props.onChange({ target: { value: '个人' } }));
    assert.deepEqual(buttons().map(button => button.props.title), ['个人', '个人 / 项目 2']);
    await act(async () => buttons()[1].props.onClick());
    assert.equal(commands[0].notebookId, 'a2');
    await act(async () => root.findByProps({ type: 'search' }).props.onChange({ target: { value: '工作 / 项目 2' } }));
    assert.deepEqual(buttons().map(button => button.props.title), ['工作', '工作 / 项目 2', '工作 / 项目 2 / 资料']);

    const definition: SeriesDefinition = seriesDefinition({ sourceNotebookId: 'z2' });
    for (const element of [
      React.createElement(TaskForm, { folders, initialDate: '2026-10-31', busy: false, onSubmit() {} }),
      React.createElement(TaskForm, { folders, task, initialDate: '2026-10-31', busy: false, onSubmit() {} }),
      React.createElement(SeriesEditor, { folders, definition, consumedCount: 0, busy: false, onInsertTemplate() {}, onSave() {} }),
      React.createElement(QuickAddTask, { folders, preferences: defaultPreferences, today: '2026-10-31', busy: false, onPreferences: async () => {}, onCreate: async () => {} }),
    ]) {
      root = await render(element);
      const quickOptions = root.findAllByProps({ className: 'quick-add-options' });
      if (quickOptions.length) await act(async () => quickOptions[0].props.onClick());
      await act(async () => root.findByProps({ className: 'notebook-picker-trigger' }).props.onClick());
      const choices = root.findAllByProps({ className: 'notebook-choice' });
      assert.deepEqual(choices.map(choice => choice.props['data-notebook-id']), ids);
      assert.deepEqual(choices.map(choice => choice.findByType('span').children.join('')), expectedLabels);
    }
    root = await render(React.createElement(TaskFilters, { folders, selected: [], busy: false, search: '', onSearch() {}, onChange() {} }));
    await act(async () => root.findByProps({ 'aria-expanded': false }).props.onClick());
    assert.deepEqual(root.findAllByProps({ className: 'notebook-choice' }).map(choice => choice.findByType('span').children.join('')), expectedLabels);

    const items = [...ids].reverse().map(id => ({ id, notebookId: id, title: id, date: '2026-10-31', schedule: task.schedule, pinned: false, completed: false, overdue: false }) as PreviewItem);
    const groups = groupListItems(items, 'notebook', 'nameAsc', folders, 'en');
    assert.deepEqual(groups.map(group => group.id), ids.map(id => `notebook:${id}`));
    assert.deepEqual(groups.map(group => group.title), notebookRows(folders).map(row => row.title));
    root = await render(React.createElement(GroupedList, { folders, items: items.filter(item => item.notebookId === 'deep'), grouping: 'notebook', renderList: () => React.createElement('p', {}, 'Task content') }));
    const summaries = root.findAllByType('summary');
    assert.deepEqual(summaries.map(summary => summary.props.title), ['工作', '工作 / 项目 2', '工作 / 项目 2 / 资料']);
    const outer = root.findAllByType('details')[0];
    assert.equal(outer.findAllByType('details').length, 3, 'parent details contains descendants so collapsing hides the entire subtree');
    assert.equal(root.findAllByProps({ className: 'notebook-group-children' }).length, 2);

  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('issue69 incomplete or cyclic parents never lose notebooks', () => {
  const rows = notebookRows([{ id: 'child', title: 'Child', parent_id: 'root' }, { id: 'root', title: 'Root' }, { id: 'orphan', title: 'Orphan', parent_id: 'missing' }, { id: 'x', title: 'X', parent_id: 'y' }, { id: 'y', title: 'Y', parent_id: 'x' }]);
  assert.deepEqual(rows.map(row => row.id), ['root', 'child', 'orphan', 'x', 'y']);
});

test('issue69 focus refresh picks up native sort changes without note changes', async () => {
  const { host, folders } = await nativeCatalog();
  const app = new TaskApplication(host);
  try {
    await app.initialize();
    const before = await app.snapshot();
    const get = host.data.get;
    host.data.get = async (path, query) => path.length === 1 && path[0] === 'folders'
      ? structuredClone([...folders].reverse()) : get(path, query);
    await app.dispatch({ action: 'refresh', requestId: 'sort-changed', checkChanges: true });
    const after = await app.snapshot();
    assert.ok(after.snapshotVersion > before.snapshotVersion);
    assert.deepEqual(notebookRows(after.folders).filter(row => !row.depth).map(row => row.id), ['a', 'z']);
  } finally { app.dispose(); }
});
