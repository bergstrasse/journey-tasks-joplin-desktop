import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TaskForm } from '../../src/panel/App';
import { DateTimeInput } from '../../src/panel/DateTimeInput';
import type { Task } from '../../src/shared/models';
import type { TaskInput } from '../../src/services/applicationTypes';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

for (const scenario of ['new', 'existing', 'undated'] as const) {
  test(`task form keeps its automatic time zone read-only (${scenario})`, async () => {
    const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const savedZone = deviceZone === 'America/New_York' ? 'Asia/Shanghai' : 'America/New_York';
    const task: Task | undefined = scenario === 'new' ? undefined : {
      taskId: 'task', noteId: 'note', title: 'Task', notebookId: 'book', tagIds: [], completedAt: 0,
      priority: 'none', pinned: false, reminder: { enabled: false },
      schedule: scenario === 'undated' ? { kind: 'none' } : { kind: 'allDay', date: '2026-10-25', zone: savedZone },
    };
    let submitted: TaskInput | undefined;
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => { renderer = create(React.createElement(TaskForm, {
        task, folders: [{ id: 'book', title: 'Book' }], initialDate: '2026-10-25', busy: false,
        onSubmit: input => { submitted = input; },
      })); });
      const zoneFields = () => renderer!.root.findAllByType('input').filter(node => node.props.readOnly);
      if (scenario === 'undated') {
        assert.equal(zoneFields().length, 0);
        await act(async () => renderer!.root.findByType('form').props.onSubmit({ preventDefault() {} }));
        assert.deepEqual(submitted!.schedule, { kind: 'none' });
        const date = renderer!.root.findAllByType(DateTimeInput).find(node => node.props.type === 'date')!;
        await act(async () => date.props.onChange({ target: { value: '2026-10-26' } }));
      }
      assert.equal(zoneFields().length, 1);
      const zone = zoneFields()[0]!;
      assert.equal(zone.props.value, scenario === 'existing' ? savedZone : deviceZone);
      assert.equal(zone.props.onChange, undefined);
      await act(async () => renderer!.root.findByType('form').props.onSubmit({ preventDefault() {} }));
      assert.deepEqual(submitted!.schedule, { kind: 'allDay', date: scenario === 'undated' ? '2026-10-26' : '2026-10-25',
        zone: scenario === 'existing' ? savedZone : deviceZone });
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
    }
  });
}
