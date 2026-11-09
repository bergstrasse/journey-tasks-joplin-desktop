import { initializeArchiveBody } from '../../src/domain/bodyTemplate';
import { templateNote } from '../support/template-note';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { PanelController } from '../../src/panel/controller';
import type { RecurrenceRule, TaskMode } from '../../src/shared/models';
import type { ActionResult, SeriesSummary, ApplicationCommand, TaskInput } from '../../src/services/applicationTypes';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';
import { jsonRoundTrip, serializedJoplin } from '../support/serialized-joplin';
import { withoutAnchorNotice } from '../support/note-body';

const now = Date.parse('2026-10-25T02:00:00Z');
const daily: RecurrenceRule = { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } };
async function setup() {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: '目标笔记本' });
  const { api, writtenKeys } = serializedJoplin(host);
  let sequence = 0;
  let clock = now;
  const options = { now: () => clock, randomId: () => (++sequence).toString(16).padStart(32, '0') };
  const app = new TaskApplication(api, options); await app.initialize();
  const controller = new PanelController({} as any, app);
  const command = async (command: ApplicationCommand) => {
    const reply = jsonRoundTrip(await controller.handleMessage(jsonRoundTrip({ protocolVersion: 1,
      requestId: command.requestId, action: 'command', command })));
    assert.equal(reply.ok, true, reply.error);
    return reply.result;
  };
  return { host, api, app, command, options, writtenKeys, setTime: (at: number) => { clock = at; } };
}

for (const mode of ['continuous', 'archive'] as const) for (const enabled of [false, true]) {
  test(`full new-task form payload survives JSON IPC, native body-template storage, native API shape and restart (${mode}, reminder=${enabled})`, async () => {
    const { host, api, app, command, options, writtenKeys } = await setup();
    const body = '- [x] 本次记录\n- [ ] 用户步骤';
    const input: TaskInput = { title: '界面创建的重复任务', body: mode === 'archive' ? templateNote(body) : body, notebookId: 'book', priority: 'none', pinned: false,
      schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' },
      reminder: { enabled, allDayTime: '09:00' }, recurrence: daily, mode };
    const result = await command({ action: 'createTask', requestId: `ui:1761357600000:1:${mode}-${enabled}`, input });
    assert.equal(result.status, 'saved', `${result.code}: ${result.message}`);
    const snapshot = await app.snapshot({ view: 'today', deviceZone: 'Asia/Shanghai' });
    assert.equal(snapshot.series.length, 1);
    assert.equal(snapshot.series[0]!.definition!.modeForNext, mode);
    assert.equal(snapshot.items.filter(item => item.kind === 'actual').length, 1);
    assert.equal(withoutAnchorNotice(host.notes.get(result.noteId)!.body), mode === 'archive' ? body + '\n' : body);
    assert.equal(host.notes.size, 1); assert.equal(host.notebooks.size, 1);
    assert.ok(writtenKeys.length > 0 && writtenKeys.every(key => key.length <= 255));
    const restarted = new TaskApplication(api, options); await restarted.initialize();
    const after = await restarted.snapshot({ view: 'today', deviceZone: 'Asia/Shanghai' });
    assert.equal(after.series.length, 1); assert.equal(after.series[0]!.status, 'active');
    assert.equal(after.items.filter(item => item.kind === 'actual').length, 1);
    assert.equal(after.tasks.find(task => task.noteId === result.noteId)?.title, input.title);
  });
}

for (const mode of ['continuous', 'archive'] as const) {
  test(`existing undated native task becomes repeating through one complete edit-form payload (${mode})`, async () => {
    const { host, api, app, command, options, writtenKeys } = await setup();
    const body = '- [x] 原生任务已有记录\n- [ ] 不应被重置';
    host.seedNote({ id: 'nativeundated', parent_id: 'book', title: '已有无日期任务', body: mode === 'archive' ? templateNote(body) : body, todo_due: 0 });
    await command({ action: 'refresh', requestId: 'ui-discover-undated' });
    assert.equal((await app.snapshot()).tasks.find(task => task.noteId === 'nativeundated')!.schedule.kind, 'none');
    const result = await command({ action: 'editTask', requestId: `ui-convert-undated-${mode}`, noteId: 'nativeundated', patch: {
      title: '已有无日期任务', priority: 'none', pinned: false,
      schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' }, reminder: { enabled: false, allDayTime: '09:00' },
      recurrence: daily, mode,
    } });
    assert.equal(result.status, 'saved', `${result.code}: ${result.message}`);
    const snapshot = await app.snapshot({ view: 'today', deviceZone: 'Asia/Shanghai' });
    assert.equal(snapshot.series.length, 1); assert.equal(snapshot.items.filter(item => item.kind === 'actual').length, 1);
    assert.equal(snapshot.series[0]!.definition!.anchor.date, '2026-10-25');
    assert.equal(withoutAnchorNotice(host.notes.get('nativeundated')!.body), mode === 'archive' ? body + '\n' : body);
    assert.equal(host.notes.size, 1, 'conversion must not clone the existing native task');
    assert.ok(writtenKeys.every(key => key.length <= 255));
    const restarted = new TaskApplication(api, options); await restarted.initialize();
    assert.equal((await restarted.snapshot()).series[0]!.status, 'active');
    assert.equal(withoutAnchorNotice(host.notes.get('nativeundated')!.body), mode === 'archive' ? body + '\n' : body);
  });
}

test('the former undated-form month=0/day=0 payload explains INVALID_RULE without mutating the original note', async () => {
  const { host, app, command } = await setup();
  host.seedNote({ id: 'nativeundated', parent_id: 'book', title: '原始任务', body: '- [x] 保留原文', todo_due: 0 });
  await command({ action: 'refresh', requestId: 'legacy-discover' });
  const before = structuredClone(host.notes.get('nativeundated'));
  const rejected = await command({ action: 'editTask', requestId: 'legacy-hidden-zero-fields', noteId: 'nativeundated', patch: {
    schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' }, reminder: { enabled: false, allDayTime: '09:00' },
    recurrence: { ...daily, month: 0, monthDay: 0 }, mode: 'continuous',
  } });
  assert.equal(rejected.code, 'INVALID_RULE');
  assert.deepEqual(host.notes.get('nativeundated'), before);
  assert.equal((await app.snapshot()).series.length, 0);
});

test('existing-task template button command crosses panel IPC, preserves body and opens the note', async () => {
  const { host, app, command } = await setup();
  host.seedNote({ id: 'existing', parent_id: 'book', body: '- [x] 本期记录\n', title: '已有待办' });
  const first = await command({ action: 'insertTemplateBlock', noteId: 'existing', requestId: 'insert-existing-1' });
  assert.equal(first.status, 'saved', first.message);
  const body = host.notes.get('existing')!.body;
  assert.equal(body, '- [x] 本期记录\n<!-- template:start -->\n\n<!-- template:end -->');
  const second = await command({ action: 'insertTemplateBlock', noteId: 'existing', requestId: 'insert-existing-2' });
  assert.equal(second.status, 'saved', second.message);
  assert.equal(host.notes.get('existing')!.body, body);
  host.notes.get('existing')!.body = '<!-- template:start -->';
  const damaged = await command({ action: 'insertTemplateBlock', noteId: 'existing', requestId: 'insert-existing-3' });
  assert.equal(damaged.code, 'TEMPLATE_FORMAT');
  assert.equal(host.notes.get('existing')!.body, '<!-- template:start -->');
  app.dispose();
});

test('save note first, edit template natively, then save archive settings initializes the first execution exactly once', async () => {
  const { host, app, command } = await setup();
  try {
    const created = await command({ action: 'createTask', requestId: 'native-first-create', input: {
      title: '原生编辑模板', notebookId: 'book', schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' },
    } });
    assert.equal(created.status, 'saved', created.message);
    const noteId = created.noteId!;
    assert.equal(host.notes.get(noteId)!.body, '');
    assert.equal((await app.snapshot()).series.length, 0);
    const inserted = await command({ action: 'insertTemplateBlock', noteId, requestId: 'native-first-insert' });
    assert.equal(inserted.status, 'saved', inserted.message);
    assert.equal((await app.snapshot()).series.length, 0, 'inserting markers does not enable recurrence');
    // Joplin edits the existing native note after the plugin has inserted the pair.
    const execution = '- [ ] 原生编辑器中填写的步骤';
    const source = '本期已有记录\n' + templateNote(execution);
    await host.data.put(['notes', noteId], {}, { body: source });
    const enabled = await command({ action: 'editTask', noteId, requestId: 'native-first-enable', patch: { recurrence: daily, mode: 'archive' } });
    assert.equal(enabled.status, 'saved', enabled.message);
    assert.equal(host.notes.get(noteId)!.body, initializeArchiveBody(source));
    assert.equal((await app.snapshot()).series.length, 1);
    const initialized = host.notes.get(noteId)!.body;
    const retried = await command({ action: 'editTask', noteId, requestId: 'native-first-retry', patch: { recurrence: undefined } });
    assert.equal(retried.status, 'saved', retried.message);
    assert.equal(host.notes.get(noteId)!.body, initialized);
  } finally { app.dispose(); }
});

for (const body of ['', '- [x] 首篇独有记录', templateNote('')]) {
  for (const existing of [false, true]) {
    test(`optional archive template advances after restart (existing=${existing}, body=${JSON.stringify(body)})`, async () => {
      const { host, api, app, command, options, setTime } = await setup();
      let restarted: TaskApplication | undefined;
      try {
        const input: TaskInput = { title: '只重复标题', body, notebookId: 'book',
          schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' }, recurrence: daily, mode: 'archive' };
        let result;
        if (existing) {
          host.seedNote({ id: 'optional-template', parent_id: 'book', title: input.title, body });
          await command({ action: 'refresh', requestId: 'optional-discover' });
          result = await command({ action: 'editTask', requestId: 'optional-enable', noteId: 'optional-template', patch: {
            schedule: input.schedule, recurrence: daily, mode: 'archive',
          } });
        } else {
          result = await command({ action: 'createTask', requestId: 'optional-create', input });
        }
        assert.equal(result.status, 'saved', result.message);
        const rootId = existing ? 'optional-template' : result.noteId!;
        assert.equal(host.notes.get(rootId)!.body, body);
        app.dispose();
        restarted = new TaskApplication(api, options); await restarted.initialize();
        for (let period = 0; period < 2; period++) {
          setTime(now + period * 86400000);
          const series = (await restarted.snapshot()).series[0]!;
          const current = series.occurrences.find(row => row.occurrenceId === series.activeOccurrenceId)!;
          const completed: ActionResult = await restarted.dispatch({ action: 'complete', requestId: `optional-complete-${period}`, noteId: current.carrierNoteId });
          assert.equal(completed.status, 'saved', completed.message);
          assert.equal(completed.code, undefined);
          const next: SeriesSummary = (await restarted.snapshot()).series[0]!;
          const carrier = next.occurrences.find(row => row.occurrenceId === next.activeOccurrenceId)!;
          assert.notEqual(carrier.carrierNoteId, current.carrierNoteId);
          assert.equal(host.notes.get(carrier.carrierNoteId)!.title, input.title);
          assert.equal(host.notes.get(carrier.carrierNoteId)!.body, '');
          assert.equal(host.notes.get(rootId)!.body, body);
        }
      } finally { app.dispose(); restarted?.dispose(); }
    });
  }
}

test('issue 47: filling an initially empty archive template copies it on save only once, including after restart', async () => {
  const { host, api, app, command, options } = await setup();
  let restarted: TaskApplication | undefined;
  try {
    const created = await command({ action: 'createTask', requestId: '47-empty', input: {
      title: '首篇模板', body: templateNote(''), notebookId: 'book',
      schedule: { kind: 'allDay', date: '2026-10-25', zone: 'Asia/Shanghai' }, recurrence: daily, mode: 'archive',
    } });
    assert.equal(created.status, 'saved', created.message);
    const noteId = created.noteId!;
    await host.data.put(['notes', noteId], {}, { body: templateNote('times:') });
    const series = (await app.snapshot()).series[0]!;
    const save = await command({ action: 'reviseSeries', requestId: '47-filled', seriesId: series.seriesId, revisionId: series.definition!.revisionId, definition: series.definition! });
    assert.equal(save.status, 'saved', save.message);
    const expected = 'times:\n<!-- template:start -->\ntimes:\n<!-- template:end -->';
    assert.equal(host.notes.get(noteId)!.body, expected);
    app.dispose();
    restarted = new TaskApplication(api, options); await restarted.initialize();
    const afterRestart = (await restarted.snapshot()).series[0]!;
    const repeat = await restarted.dispatch({ action: 'reviseSeries', requestId: '47-repeat', seriesId: afterRestart.seriesId, revisionId: afterRestart.definition!.revisionId, definition: afterRestart.definition! });
    assert.equal(repeat.status, 'saved', repeat.message);
    assert.equal(host.notes.get(noteId)!.body, expected);
    await host.data.put(['notes', noteId], {}, { body: templateNote('new template', 'user execution\n') });
    const afterRepeat = (await restarted.snapshot()).series[0]!;
    const edit = await restarted.dispatch({ action: 'reviseSeries', requestId: '47-user-edited', seriesId: afterRepeat.seriesId, revisionId: afterRepeat.definition!.revisionId, definition: afterRepeat.definition! });
    assert.equal(edit.status, 'saved', edit.message);
    assert.equal(host.notes.get(noteId)!.body, templateNote('new template', 'user execution\n'));
  } finally { app.dispose(); restarted?.dispose(); }
});

for (const mode of ['continuous', 'archive'] as const) for (const basis of ['scheduled', 'completed'] as const) {
  test(`issue90 completed single converts without losing completion (${mode}, ${basis})`, async () => {
    const { host, api, app, command, options } = await setup();
    const completedAt = now - 86400000;
    const body = '- [x] 已完成记录';
    host.seedNote({ id: 'completed-single', parent_id: 'book', title: '已完成任务',
      body: mode === 'archive' ? templateNote(body) : body, todo_completed: completedAt,
      todo_due: Date.parse('2026-10-22T00:00:00Z') });
    await command({ action: 'refresh', requestId: 'discover-completed' });
    const result = await command({ action: 'editTask', requestId: 'convert-completed', noteId: 'completed-single', patch: {
      schedule: { kind: 'allDay', date: '2026-10-22', zone: 'Asia/Shanghai' },
      recurrence: { ...daily, basis }, mode,
    } });
    assert.equal(result.status, 'saved', `${result.code}: ${result.message}`);
    const verify = async (application: TaskApplication) => {
      const snapshot = await application.snapshot({ showCompleted: true });
      assert.equal(snapshot.series.length, 1);
      const series = snapshot.series[0]!;
      const occurrences = Object.values(series.occurrences);
      assert.equal(occurrences.length, 2);
      const completed = occurrences.find(row => row.resolution === 'completed')!;
      assert.equal(completed.resolvedAt, completedAt);
      assert.equal(completed.scheduled.date, '2026-10-22');
      assert.equal(completed.consumed, true);
      const active = occurrences.find(row => row.resolution === 'open')!;
      assert.equal(active.scheduled.date, basis === 'scheduled' ? '2026-10-23' : '2026-10-25');
      assert.equal(host.notes.get(active.carrierNoteId)!.todo_completed, 0);
      const log = snapshot.taskLogs![series.seriesId]!;
      assert.equal(log.filter(row => row.kind === 'completed').length, 1);
      assert.equal(log.find(row => row.kind === 'completed')!.at, completedAt);
      if (mode === 'archive') assert.equal(host.notes.get('completed-single')!.todo_completed, completedAt);
    };
    await verify(app);
    const restarted = new TaskApplication(api, options); await restarted.initialize();
    await verify(restarted);
  });
}

test('issue90 conversion respects count limit and keeps the completed final task', async () => {
  const { host, app, command } = await setup();
  const created = await command({ action: 'createTask', requestId: 'single-create', input: {
    title: '已完成的最后一期', notebookId: 'book', schedule: { kind: 'allDay', date: '2026-10-24', zone: 'Asia/Shanghai' },
  } });
  await command({ action: 'complete', requestId: 'single-complete', noteId: created.noteId });
  const converted = await command({ action: 'editTask', requestId: 'single-convert', noteId: created.noteId,
    patch: { recurrence: { ...daily, end: { kind: 'count', count: 1 } } } });
  assert.equal(converted.status, 'saved', converted.message);
  const series = (await app.snapshot({ showCompleted: true })).series[0]!;
  assert.equal(series.status, 'ended');
  assert.equal(Object.keys(series.occurrences).length, 1);
  assert.equal(Object.values(series.occurrences)[0]!.resolvedAt, now);
  assert.equal(host.notes.get(created.noteId)!.todo_completed, now);
});
