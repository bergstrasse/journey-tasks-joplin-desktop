import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { readNamespace } from '../../src/adapters/joplin/userDataStore';
import type { CleanupPlan } from '../../src/services/cleanupTypes';
import { MemoryJoplin } from '../support/memory-joplin';

const time = Date.parse('2026-10-25T02:00:00Z');
function setup() {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: '用户笔记本' });
  let sequence = 0;
  const options = { now: () => time, randomId: () => String(++sequence).padStart(32, '0') };
  return { host, options, app: new TaskApplication(host, options) };
}
async function create(app: TaskApplication, requestId: string) {
  const made = await app.dispatch({ action: 'createTask', requestId, input: { title: requestId,
    body: '- [x] 原始用户步骤', notebookId: 'book', reminder: { enabled: true },
    schedule: { kind: 'allDay', date: '2026-10-26', zone: 'Asia/Shanghai' } } });
  assert.equal(made.status, 'saved', made.message);
  return made.noteId!;
}
async function preview(app: TaskApplication, requestId: string): Promise<CleanupPlan> {
  const result = await app.dispatch({ action: 'previewCleanup', requestId });
  assert.equal(result.status, 'saved', result.message);
  assert.ok(result.cleanupPlan);
  return result.cleanupPlan;
}
const activeKeys = (host: MemoryJoplin, id: string) => Object.entries(readNamespace(host.notes.get(id)?.user_data, host.namespace))
  .filter(([, entry]) => !entry.d).map(([key]) => key);

test('cleanup preview is non-destructive and invalid confirmation/token cannot mutate host data', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'preview-single');
  const before = structuredClone([...host.notes.entries()]);
  const folders = structuredClone([...host.notebooks.entries()]);
  const plan = await preview(app, 'cleanup-preview');
  assert.equal(plan.confirmation, 'RESET');
  assert.ok(plan.notes.some(note => note.id === id));
  assert.ok(plan.metadataKeys > 0);
  assert.deepEqual([...host.notes.entries()], before);
  assert.deepEqual([...host.notebooks.entries()], folders);
  for (const [index, command] of [
    { token: 'unknown-token', confirmation: 'RESET' },
    { token: plan.token, confirmation: 'DELETE' },
    { token: plan.token, confirmation: '' },
  ].entries()) {
    const rejected = await app.dispatch({ action: 'executeCleanup', requestId: `bad-confirm-${index}`, ...command });
    assert.notEqual(rejected.status, 'saved');
    assert.deepEqual([...host.notes.entries()], before);
    assert.deepEqual([...host.notebooks.entries()], folders);
  }
});

test('cleanup resets task dates, preserves user content/other namespace, and cannot replay old outbox', async () => {
  const { host, app, options } = setup(); await app.initialize();
  const id = await create(app, 'detach-single');
  host.seedNote({ id: 'unrelated', parent_id: 'book', title: '普通用户笔记', body: '完全不触碰', is_todo: 0 });
  const envelope = JSON.parse(host.notes.get(id)!.user_data);
  envelope.otherPlugin = { keep: { v: { important: true }, t: 1 } };
  host.notes.get(id)!.user_data = JSON.stringify(envelope);
  const originalBody = host.notes.get(id)!.body;
  const originalOther = structuredClone(envelope.otherPlugin);
  const plan = await preview(app, 'detach-preview');
  const cleaned = await app.dispatch({ action: 'executeCleanup', requestId: 'detach-execute', token: plan.token, confirmation: plan.confirmation });
  assert.equal(cleaned.status, 'saved', cleaned.message);
  assert.equal(host.notes.get(id)!.body, originalBody);
  assert.equal(host.notes.get(id)!.is_todo, 1);
  assert.equal(host.notes.get(id)!.todo_due, 0);
  assert.equal(activeKeys(host, id).length, 0);
  assert.deepEqual(JSON.parse(host.notes.get(id)!.user_data).otherPlugin, originalOther);
  assert.equal(host.notes.get('unrelated')!.body, '完全不触碰');
  assert.deepEqual([...host.notebooks.keys()], ['book']);
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  await restarted.dispatch({ action: 'refresh', requestId: 'no-replay-after-detach' });
  assert.equal(activeKeys(host, id).length, 0);
  assert.equal(host.notes.size, 2);
  assert.equal((await restarted.local.all()).filter(intent => intent.operation || intent.create).length, 0);
});

test('cleanup clears native alarms and immediately moves tasks into the inbox', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'keep-alarm');
  const due = host.notes.get(id)!.todo_due;
  assert.ok(due > 0);
  const plan = await preview(app, 'keep-alarm-plan');
  const result = await app.dispatch({ action: 'executeCleanup', requestId: 'keep-alarm-execute', token: plan.token, confirmation: plan.confirmation });
  assert.equal(result.status, 'saved', result.message);
  assert.equal(host.notes.get(id)!.todo_due, 0);
  const snapshot = await app.snapshot({ view: 'inbox', deviceZone: 'Asia/Shanghai' });
  const task = snapshot.tasks.find(task => task.noteId === id)!;
  assert.deepEqual(task.schedule, { kind: 'none' });
  assert.equal(task.reminder.enabled, false);
  assert.ok(snapshot.items.some(item => item.noteId === id));
  assert.equal((await app.snapshot({ view: 'tomorrow', deviceZone: 'Asia/Shanghai' })).items.length, 0);
  assert.equal(activeKeys(host, id).length, 0);
});

test('cleanup refuses a stale preview after concurrent user content changes', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'changed-after-preview');
  const plan = await preview(app, 'stale-plan');
  assert.equal(plan.confirmation, 'RESET');
  await host.data.put(['notes', id], {}, { body: '预览后新增的用户记录' });
  const result = await app.dispatch({ action: 'executeCleanup', requestId: 'stale-execute', token: plan.token, confirmation: plan.confirmation });
  assert.notEqual(result.status, 'saved');
  assert.equal(host.notes.get(id)!.body, '预览后新增的用户记录');
  assert.ok(activeKeys(host, id).length > 0);
});

test('partial metadata cleanup failure keeps a durable guard and does not replay removed keys before an explicit retry', async () => {
  const { host, app, options } = setup(); await app.initialize();
  const id = await create(app, 'partial-cleanup');
  const plan = await preview(app, 'partial-plan');
  const keys = activeKeys(host, id).sort(); assert.ok(keys.length > 1);
  const remove = host.data.userDataDelete;
  let removals = 0;
  host.data.userDataDelete = async (...args) => {
    if (++removals === 2) throw new Error('Injected second metadata deletion failure');
    await remove(...args);
  };
  const result = await app.dispatch({ action: 'executeCleanup', requestId: 'partial-execute', token: plan.token, confirmation: plan.confirmation });
  assert.notEqual(result.status, 'saved');
  const afterFailure = activeKeys(host, id).sort();
  assert.ok(afterFailure.length > 0);
  assert.ok(await app.local.cleanupPending());
  const removed = keys.filter(key => !afterFailure.includes(key));
  assert.ok(removed.length > 0, 'fault should exercise a genuinely partial cleanup');
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  for (const key of removed) assert.ok(!activeKeys(host, id).includes(key), 'outbox replay must not resurrect already removed metadata');
  const retryPlan = await preview(restarted, 'retry-partial-plan');
  const retried = await restarted.dispatch({ action: 'executeCleanup', requestId: 'retry-partial-execute', token: retryPlan.token, confirmation: retryPlan.confirmation });
  assert.equal(retried.status, 'saved', retried.message);
  assert.equal(activeKeys(host, id).length, 0);
  assert.equal(await restarted.local.cleanupPending(), false);
});

test('a documentation note quoting the anchor marker without plugin metadata is not a managed task to delete', async () => {
  const { host, app } = setup();
  const body = '插件开发文档示例\n```html\n<!-- journey-series-anchor:v2 -->\nexample\n<!-- /journey-series-anchor:v2 -->\n```';
  host.seedNote({ id: 'documentation', parent_id: 'book', is_todo: 0, title: '用户自己的技术文档', body });
  await app.initialize();
  const plan = await preview(app, 'quoted-marker-plan');
  assert.ok(!plan.notes.some(note => note.id === 'documentation'), 'a quoted marker alone is not ownership evidence');
  assert.equal(host.notes.get('documentation')!.body, body);
});

test('cleanup tolerates single-note type metadata that is absent in paginated rows', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'host-response-shape');
  const originalGet = host.data.get;
  host.data.get = async (path, query) => {
    const value = await originalGet(path, query);
    return path[0] === 'notes' && path.length === 2 ? { ...value, type_: 1 } : value;
  };
  const plan = await preview(app, 'shape-preview');
  const result = await app.dispatch({ action: 'executeCleanup', requestId: 'shape-execute', token: plan.token, confirmation: plan.confirmation });
  assert.equal(result.status, 'saved', result.message);
  assert.deepEqual(activeKeys(host, id), []);
});

test('cleanup verifies deletion from user_data tombstones when an IPC boundary returns null for absent values', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'host-null-readback');
  const plan = await preview(app, 'null-preview');
  const originalGet = host.data.userDataGet;
  host.data.userDataGet = (async (...args: Parameters<typeof originalGet>) => (await originalGet(...args)) ?? null) as typeof originalGet;
  const result = await app.dispatch({ action: 'executeCleanup', requestId: 'null-execute', token: plan.token, confirmation: plan.confirmation });
  assert.equal(result.status, 'saved', result.message);
  assert.deepEqual(activeKeys(host, id), []);
});

test('metadata-only host timestamps do not invalidate a cleanup preview while actual content changes remain protected', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'host-time-only');
  const plan = await preview(app, 'timestamp-preview');
  host.notes.get(id)!.updated_time += 100;
  const result = await app.dispatch({ action: 'executeCleanup', requestId: 'timestamp-execute', token: plan.token, confirmation: plan.confirmation });
  assert.equal(result.status, 'saved', result.message);
  assert.deepEqual(activeKeys(host, id), []);
});

test('incomplete cleanup exposes its failing step on the next preview and resumes rather than losing the failure', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'failure-step');
  const plan = await preview(app, 'failure-step-preview');
  host.failNext('userDataDelete', `${id}/${activeKeys(host, id).sort()[0]}`);
  const failed = await app.dispatch({ action: 'executeCleanup', requestId: 'failure-step-execute', token: plan.token, confirmation: plan.confirmation });
  assert.equal(failed.status, 'error');
  assert.match(failed.message!, /remove-note-metadata/);
  const next = await preview(app, 'failure-step-again');
  assert.equal(next.lastFailure?.stage, 'remove-note-metadata');
  assert.equal(next.lastFailure?.itemId, id);
  const resumed = await app.dispatch({ action: 'executeCleanup', requestId: 'failure-step-resume', token: next.token, confirmation: next.confirmation });
  assert.equal(resumed.status, 'saved', resumed.message);
});

test('same-value userData timestamp changes are tolerated but changed plugin values require a fresh preview', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'semantic-userdata');
  const first = await preview(app, 'semantic-first');
  const raw = JSON.parse(host.notes.get(id)!.user_data);
  for (const entry of Object.values(raw[host.namespace]) as Array<{ t: number }>) entry.t += 10;
  host.notes.get(id)!.user_data = JSON.stringify(raw);
  const okay = await app.dispatch({ action: 'executeCleanup', requestId: 'semantic-clock-only', token: first.token, confirmation: first.confirmation });
  assert.equal(okay.status, 'saved', okay.message);
  await app.dispatch({ action: 'setFields', requestId: 'semantic-adopt-again', noteId: id, priority: 'high' });
  const next = await preview(app, 'semantic-next');
  await host.data.userDataSet(1, id, 'new-concurrent-business-value', { changed: true });
  const changed = await app.dispatch({ action: 'executeCleanup', requestId: 'semantic-new-value', token: next.token, confirmation: next.confirmation });
  assert.equal(changed.code, 'CLEANUP_CHANGED');
  assert.ok(activeKeys(host, id).includes('new-concurrent-business-value'));
});

test('an edit during metadata deletion stops cleanup and preserves the edited note', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'cleanup-late-edit');
  const plan = await preview(app, 'late-edit-preview');
  const originalDelete = host.data.userDataDelete;
  let changed = false;
  host.data.userDataDelete = async (...args) => {
    await originalDelete(...args);
    if (!changed) { host.notes.get(id)!.body = '清理期间用户刚刚保存的新正文'; changed = true; }
  };
  const result = await app.dispatch({ action: 'executeCleanup', requestId: 'late-edit-execute', token: plan.token, confirmation: plan.confirmation });
  assert.equal(result.code, 'CLEANUP_INCOMPLETE');
  assert.match(result.message!, /CLEANUP_CHANGED/);
  assert.equal(host.notes.get(id)!.body, '清理期间用户刚刚保存的新正文');
});

test('cleanup preserves content, completion, templates, trash and tags, and isolates exact UUID namespace', async () => {
  const { host, app, options } = setup(); await app.initialize();
  const id = await create(app, 'strict-cleanup');
  const { buildArchiveBody } = await import('../support/body-template');
  host.notes.get(id)!.body = buildArchiveBody('execution stays', 'template stays');
  host.notes.get(id)!.deleted_time = 123;
  host.notes.get(id)!.todo_completed = 456;
  host.noteTagIds.set(id, new Set(['tag-one']));
  const oldNamespace = { meta: { v: { schemaVersion: 1, rootNoteId: id }, t: 1 } };
  const raw = JSON.parse(host.notes.get(id)!.user_data);
  raw['io.journey.tasks'] = oldNamespace;
  raw[`${DEFAULT_PLUGIN_ID}.similar`] = { key: { v: 'foreign', t: 1 } };
  host.notes.get(id)!.user_data = JSON.stringify(raw);
  host.seedNote({ id: 'old-control', is_todo: 0, user_data: JSON.stringify({ 'io.journey.tasks': oldNamespace }) });
  host.settingsValues.set('journey.tasks.preferences', 'old-test-value');
  host.notebooks.set('with-metadata', { id: 'with-metadata', title: 'keep folder', parent_id: 'book',
    user_data: JSON.stringify({ [DEFAULT_PLUGIN_ID]: { marker: { v: 1, t: 1 } }, foreign: { key: { v: 'keep', t: 1 } } }) });
  const before = structuredClone(host.notes.get(id)!);
  const old = structuredClone(host.notes.get('old-control')!);
  const plan = await preview(app, 'strict-plan');
  assert.ok(plan.notes.find(n => n.id === id)?.inTrash);
  assert.ok(!plan.notes.find(n => n.id === 'old-control'));
  const callStart = host.calls.length;
  const result = await app.dispatch({ action: 'executeCleanup', requestId: 'strict-execute', token: plan.token, confirmation: plan.confirmation });
  assert.equal(result.status, 'saved', result.message);
  const after = host.notes.get(id)!;
  for (const key of ['body', 'title', 'parent_id', 'is_todo', 'todo_completed', 'deleted_time']) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(host.noteTagIds.get(id), new Set(['tag-one']));
  assert.deepEqual(host.notes.get('old-control'), old);
  assert.deepEqual(JSON.parse(after.user_data)['io.journey.tasks'], oldNamespace);
  assert.deepEqual(JSON.parse(after.user_data)[`${DEFAULT_PLUGIN_ID}.similar`], raw[`${DEFAULT_PLUGIN_ID}.similar`]);
  assert.equal(host.settingsValues.get('journey.tasks.preferences'), 'old-test-value');
  assert.equal(host.notebooks.get('with-metadata')!.title, 'keep folder');
  assert.equal(host.notebooks.get('with-metadata')!.parent_id, 'book');
  assert.deepEqual(JSON.parse(host.notebooks.get('with-metadata')!.user_data).foreign, { key: { v: 'keep', t: 1 } });
  assert.equal(after.todo_due, 0);
  const writes = host.calls.slice(callStart).filter(call => ['put', 'post', 'delete'].includes(call.method));
  assert.deepEqual(writes.map(call => ({ method: call.method, path: call.path, body: call.body })),
    [{ method: 'put', path: ['notes', id], body: { todo_due: 0 } }]);
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal(activeKeys(host, id).length, 0);
});

test('unreadable and encrypted notes block cleanup before metadata changes', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'encrypted-test');
  host.seedNote({ id: 'encrypted', encryption_applied: 1, is_todo: 0 });
  const before = structuredClone([...host.notes.entries()]);
  const plan = await preview(app, 'encrypted-plan');
  assert.equal(plan.blocked, true);
  const rejected = await app.dispatch({ action: 'executeCleanup', requestId: 'encrypted-execute', token: plan.token, confirmation: plan.confirmation });
  assert.equal(rejected.code, 'CLEANUP_ENCRYPTED');
  assert.deepEqual([...host.notes.entries()], before);
  host.notes.delete('encrypted');
  host.failNext('get', 'notes');
  const failed = await app.dispatch({ action: 'previewCleanup', requestId: 'unreadable-preview' });
  assert.equal(failed.status, 'error'); assert.ok(activeKeys(host, id).length);
});

test('expired previews do not authorize deletion and a cleaned token cannot be replayed', async () => {
  const { host } = setup(); let clock = time;
  const app = new TaskApplication(host, { now: () => clock }); await app.initialize();
  const id = await create(app, 'expiry');
  const plan = await preview(app, 'expire-plan');
  clock += 5 * 60_000 + 1;
  const expired = await app.dispatch({ action: 'executeCleanup', requestId: 'expired', token: plan.token, confirmation: plan.confirmation });
  assert.equal(expired.code, 'CLEANUP_EXPIRED'); assert.ok(activeKeys(host, id).length);
  const next = await preview(app, 'fresh-plan');
  assert.equal((await app.dispatch({ action: 'executeCleanup', requestId: 'fresh-clean', token: next.token, confirmation: next.confirmation })).status, 'saved');
  assert.equal((await app.dispatch({ action: 'executeCleanup', requestId: 'replay-clean', token: next.token, confirmation: next.confirmation })).code, 'CLEANUP_EXPIRED');
});

test('cleanup stops if a remaining metadata value changes during deletion', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'concurrent-meta');
  const keys = activeKeys(host, id).sort();
  const plan = await preview(app, 'concurrent-plan');
  const remove = host.data.userDataDelete; let once = false;
  host.data.userDataDelete = async (...args) => {
    await remove(...args);
    if (!once) { once = true; await host.data.userDataSet(1, id, keys[1]!, { concurrent: true }); }
  };
  const result = await app.dispatch({ action: 'executeCleanup', requestId: 'concurrent-clean', token: plan.token, confirmation: plan.confirmation });
  assert.equal(result.code, 'CLEANUP_INCOMPLETE');
  assert.deepEqual(await host.data.userDataGet(1, id, keys[1]!), { concurrent: true });
  assert.equal(await app.local.cleanupPending(), true);
});

test('encrypted notebook metadata also blocks cleanup before any deletion', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'encrypted-folder-test');
  host.notebooks.set('encrypted-folder', { id: 'encrypted-folder', title: '', encryption_applied: 1 });
  const plan = await preview(app, 'encrypted-folder-plan');
  assert.equal(plan.blocked, true);
  const result = await app.dispatch({ action: 'executeCleanup', requestId: 'encrypted-folder-execute', token: plan.token, confirmation: plan.confirmation });
  assert.equal(result.code, 'CLEANUP_ENCRYPTED');
  assert.ok(activeKeys(host, id).length > 0);
});

test('cleanup repairs tombstoned legacy alarms without touching unrelated native tasks', async () => {
  const { host, app, options } = setup(); await app.initialize();
  const id = await create(app, 'legacy-alarm');
  const due = host.notes.get(id)!.todo_due;
  for (const key of activeKeys(host, id)) await host.data.userDataDelete(1, id, key);
  host.seedNote({ id: 'native-alarm', parent_id: 'book', todo_due: due });
  host.seedNote({ id: 'foreign-alarm', parent_id: 'book', todo_due: due,
    user_data: JSON.stringify({ [`${DEFAULT_PLUGIN_ID}.other`]: { marker: { t: 1, d: 1 } } }) });
  const plan = await preview(app, 'legacy-plan');
  assert.deepEqual(plan.notes.map(note => note.id), [id]);
  assert.equal(plan.metadataKeys, 0);
  const cleaned = await app.dispatch({ action: 'executeCleanup', requestId: 'legacy-execute', token: plan.token, confirmation: 'RESET' });
  assert.equal(cleaned.status, 'saved', cleaned.message);
  assert.equal(host.notes.get(id)!.todo_due, 0);
  for (const other of ['native-alarm', 'foreign-alarm']) assert.equal(host.notes.get(other)!.todo_due, due);
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  for (const application of [app, restarted]) {
    const snapshot = await application.snapshot({ view: 'inbox' });
    assert.deepEqual(snapshot.tasks.find(task => task.noteId === id)!.schedule, { kind: 'none' });
    assert.equal(snapshot.tasks.find(task => task.noteId === id)!.reminder.enabled, false);
    assert.ok(snapshot.items.some(item => item.noteId === id));
  }
  assert.equal((await preview(restarted, 'legacy-empty')).notes.length, 0);
});

test('failed native alarm cleanup keeps recovery paused and can resume after restart', async () => {
  const { host, app, options } = setup(); await app.initialize();
  const id = await create(app, 'alarm-failure');
  const plan = await preview(app, 'alarm-failure-plan');
  host.failNext('put', `notes/${id}`);
  const failed = await app.dispatch({ action: 'executeCleanup', requestId: 'alarm-failure-execute', token: plan.token, confirmation: 'RESET' });
  assert.equal(failed.code, 'CLEANUP_INCOMPLETE');
  assert.match(failed.message!, /clear-note-reminder/);
  assert.ok(host.notes.get(id)!.todo_due > 0);
  assert.ok(activeKeys(host, id).length > 0);
  assert.equal(await app.local.cleanupPending(), true);
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  const retry = await preview(restarted, 'alarm-retry-plan');
  const result = await restarted.dispatch({ action: 'executeCleanup', requestId: 'alarm-retry', token: retry.token, confirmation: 'RESET' });
  assert.equal(result.status, 'saved', result.message);
  assert.equal(host.notes.get(id)!.todo_due, 0);
  assert.equal(await restarted.local.cleanupPending(), false);
});

test('a host that ignores alarm reset cannot report successful cleanup', async () => {
  const { host, app } = setup(); await app.initialize();
  const id = await create(app, 'alarm-readback');
  const plan = await preview(app, 'alarm-readback-plan');
  const put = host.data.put;
  host.data.put = async (path, query, body) => body?.todo_due === 0 ? undefined : put(path, query, body);
  const failed = await app.dispatch({ action: 'executeCleanup', requestId: 'alarm-readback-execute', token: plan.token, confirmation: 'RESET' });
  assert.equal(failed.code, 'CLEANUP_INCOMPLETE');
  assert.match(failed.message!, /CLEANUP_READBACK/);
  assert.ok(activeKeys(host, id).length > 0);
});

test('an alarm restored while cleaning another task prevents successful cleanup', async () => {
  const { host, app } = setup(); await app.initialize();
  const first = await create(app, 'alarm-restore-first');
  const second = await create(app, 'alarm-restore-second');
  const due = host.notes.get(first)!.todo_due;
  const plan = await preview(app, 'alarm-restore-plan');
  const remove = host.data.userDataDelete;
  host.data.userDataDelete = async (...args) => {
    await remove(...args);
    if (args[1] === second) host.notes.get(first)!.todo_due = due;
  };
  const failed = await app.dispatch({ action: 'executeCleanup', requestId: 'alarm-restore-execute', token: plan.token, confirmation: 'RESET' });
  assert.equal(failed.code, 'CLEANUP_INCOMPLETE');
  assert.match(failed.message!, /verify-cleanup/);
  assert.equal(await app.local.cleanupPending(), true);
});

for (const mode of ['continuous', 'archive'] as const) {
  test(`cleanup removes ${mode} recurrence and forecasts immediately and across restart`, async () => {
    const { host, app, options } = setup(); await app.initialize();
    const made = await app.dispatch({ action: 'createTask', requestId: `repeat-cleanup-${mode}`, input: {
      title: 'Repeating task', body: 'Keep the body', notebookId: 'book', mode,
      schedule: { kind: 'allDay', date: '2026-10-26', zone: 'Asia/Shanghai' }, reminder: { enabled: true },
      recurrence: { calendar: 'gregorian', frequency: 'daily', basis: 'scheduled', interval: 1, end: { kind: 'never' } },
    } });
    assert.equal(made.status, 'saved', made.message);
    const before = await app.snapshot({ view: 'month', date: '2026-10-26' });
    assert.ok(before.items.some(item => item.kind === 'projected'));
    const body = host.notes.get(made.noteId!)!.body;
    const plan = await preview(app, `repeat-plan-${mode}`);
    const result = await app.dispatch({ action: 'executeCleanup', requestId: `repeat-execute-${mode}`, token: plan.token, confirmation: 'RESET' });
    assert.equal(result.status, 'saved', result.message);
    const restarted = new TaskApplication(host, options); await restarted.initialize();
    for (const application of [app, restarted]) {
      const snapshot = await application.snapshot({ view: 'inbox' });
      assert.equal(snapshot.series.length, 0);
      assert.ok(snapshot.items.some(item => item.noteId === made.noteId));
      assert.ok(snapshot.tasks.every(task => task.schedule.kind === 'none' && !task.reminder.enabled));
      assert.equal((await application.snapshot({ view: 'month', date: '2026-10-26' })).items.length, 0);
    }
    assert.equal(host.notes.get(made.noteId!)!.body, body);
    assert.equal(host.notes.size, 1);
  });
}
