import test from 'node:test';
import assert from 'node:assert/strict';
import { JoplinGateway } from '../../src/adapters/joplin/gateway';
import { readNamespace, UserDataStore } from '../../src/adapters/joplin/userDataStore';
import { LocalIntentStore } from '../../src/adapters/joplin/localIntentStore';
import { MemoryJoplin } from '../support/memory-joplin';

test('gateway consumes all pages and never treats a failed later page as empty success', async () => {
  const host = new MemoryJoplin();
  for (let n = 0; n < 5; n++) host.seedNote({ id: `note${n}` });
  const gateway = new JoplinGateway(host);
  assert.equal((await gateway.allNotes()).length, 5);
  assert.equal(host.calls.filter(c => c.method === 'get' && c.path.length === 1).length, 3);
  const get = host.data.get;
  host.data.get = async (path, query) => {
    if (query?.page === 2) throw new Error('page unavailable');
    return get(path, query);
  };
  await assert.rejects(() => gateway.allNotes(), /page unavailable/);
});

test('POST timeout after commit recovers same candidate without duplicate or PUT', async () => {
  const host = new MemoryJoplin();
  host.failNext('post', 'notes', true);
  const gateway = new JoplinGateway(host);
  const input = { title: 'Recurring', body: '- [x] user step', parent_id: 'book', is_todo: 1 };
  assert.equal((await gateway.ensureNote('candidate', input)).id, 'candidate');
  assert.equal((await gateway.ensureNote('candidate', input)).body, input.body);
  assert.equal(host.notes.size, 1);
  assert.equal(host.calls.filter(c => c.method === 'post').length, 1);
  assert.equal(host.calls.filter(c => c.method === 'put').length, 0);
});

test('candidate collision preserves user edits rather than overwriting on retry', async () => {
  const host = new MemoryJoplin();
  host.seedNote({ id: 'candidate', parent_id: 'book', title: 'User edit', body: 'retain me' });
  const gateway = new JoplinGateway(host);
  await assert.rejects(() => gateway.ensureNote('candidate', {
    title: 'Template', body: 'new', parent_id: 'book', is_todo: 1,
  }), { code: 'NOTE_ID_COLLISION' });
  assert.equal(host.notes.get('candidate')?.body, 'retain me');
  assert.equal(host.mutations().length, 0);
});

test('minimal field projection preserves body and rejects arbitrary native fields', async () => {
  const host = new MemoryJoplin();
  host.seedNote({ id: 'task', body: '- [x] a\n- [ ] b' });
  const gateway = new JoplinGateway(host);
  await gateway.patchNote('task', { todo_due: 1234 });
  assert.equal(host.notes.get('task')?.body, '- [x] a\n- [ ] b');
  await assert.rejects(() => gateway.patchNote('task', { user_data: '{}' } as never), { code: 'UNSAFE_PATCH' });
});

test('unknown userData envelope fails closed; other plugin namespace is not inspected', () => {
  for (const raw of ['not json', 'null', '[]', '{"ours":[]}', '{"ours":{"op:1":{"v":1}}}'])
    assert.throws(() => readNamespace(raw, 'ours'), { code: 'USERDATA_FORMAT' });
  assert.deepEqual(readNamespace('{"other":{"unknown":"format"}}', 'ours'), {});
});

test('immutable appends are idempotent and preserve other plugin data', async () => {
  const host = new MemoryJoplin();
  host.seedNote({ id: 'control', is_todo: 0, user_data: '{"other":{"keep":{"v":"safe","t":1}}}' });
  const store = new UserDataStore(new JoplinGateway(host), host.namespace);
  await Promise.all([store.append('control', 'op:one', { id: 1 }), store.append('control', 'op:two', { id: 2 })]);
  await store.append('control', 'op:one', { id: 1 });
  await assert.rejects(() => store.append('control', 'op:one', { id: 3 }), { code: 'IMMUTABLE_KEY_CONFLICT' });
  assert.deepEqual(await store.entries(host.notes.get('control') as any, 'op:'), [{ id: 1 }, { id: 2 }]);
  assert.equal(JSON.parse(host.notes.get('control')!.user_data).other.keep.v, 'safe');
  assert.equal(host.calls.filter(c => c.method === 'userDataSet').length, 2);
});

test('enumerated-but-not-yet-readable operation is incomplete, not empty journal', async () => {
  const host = new MemoryJoplin();
  host.seedNote({ id: 'control', user_data: JSON.stringify({ [host.namespace]: { 'op:missing': { v: 1, t: 1 } } }) });
  host.data.userDataGet = async () => undefined;
  const store = new UserDataStore(new JoplinGateway(host), host.namespace);
  await assert.rejects(() => store.entries(host.notes.get('control') as any, 'op:'), { code: 'USERDATA_INCOMPLETE' });
  assert.equal(host.mutations().length, 0);
});

test('operation commit with lost response can be retried without replacing immutable data', async () => {
  const host = new MemoryJoplin();
  host.seedNote({ id: 'control' });
  const store = new UserDataStore(new JoplinGateway(host), host.namespace);
  host.failNext('userDataSet', 'control/op:one', true);
  await assert.rejects(() => store.append('control', 'op:one', { value: 'keep' }), /Injected/);
  await store.append('control', 'op:one', { value: 'keep' });
  assert.deepEqual(await store.get('control', 'op:one'), { value: 'keep' });
  assert.equal(host.calls.filter(c => c.method === 'userDataSet').length, 1);
});

test('local IDs serialize, persist across restart and do not depend on wall clock', async () => {
  const host = new MemoryJoplin();
  let random = 0;
  const make = () => new LocalIntentStore(host, () => `r${++random}`, () => -1234);
  const first = make();
  await first.initialize();
  const ids = await Promise.all(Array.from({ length: 10 }, () => first.nextId()));
  assert.equal(new Set(ids.map(id => id.opId)).size, 10);
  assert.deepEqual(ids.map(id => id.deviceSeq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const restarted = make();
  await restarted.initialize();
  const next = await restarted.nextId();
  assert.equal(next.deviceId, ids[0]!.deviceId);
  assert.equal(next.deviceSeq, 11);
});

test('local recovery intents survive restart and corrupt shards are not silently discarded', async () => {
  const host = new MemoryJoplin();
  const local = new LocalIntentStore(host, () => 'device', () => 42);
  await local.initialize();
  await local.put({ id: 'intent', controlNoteId: 'control', phase: 'create', attempts: 1, updatedAt: 0 });
  const restarted = new LocalIntentStore(host, () => 'ignored');
  assert.equal((await restarted.all())[0]?.updatedAt, 42);
  host.settingsValues.set('io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad.outbox.0', 'broken');
  await assert.rejects(() => restarted.all(), { code: 'LOCAL_OUTBOX' });
  assert.equal(host.settingsValues.get('io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad.outbox.0'), 'broken');
});

test('view preferences are per-device and restart preserves fixed versus restore choices', async () => {
  const a = new MemoryJoplin();
  const b = new MemoryJoplin();
  const localA = new LocalIntentStore(a, () => 'A');
  const localB = new LocalIntentStore(b, () => 'B');
  await localA.initialize(); await localB.initialize();
  await localA.savePreferences({ startupMode: 'restore', lastView: 'year' });
  assert.equal((await localA.preferences()).lastView, 'year');
  assert.equal((await localB.preferences()).lastView, 'today');
});

test('successful local recovery phases scrub creation bodies while unfinished creation retains recovery input', async () => {
  const host = new MemoryJoplin();
  const local = new LocalIntentStore(host, () => 'device', () => 10);
  await local.initialize();
  const secret = 'unique execution and template recovery text';
  const create = { noteId: 'native-task', input: { title: 'task', body: secret }, role: 'root' };
  await local.put({ id: 'unfinished', controlNoteId: 'native-task', phase: 'root-pending', attempts: 0, updatedAt: 0, create });
  assert.equal((await local.all()).find(row => row.id === 'unfinished')!.create!.input.body, secret);
  for (const phase of ['root-saved', 'carrier-saved', 'template-saved', 'control-saved']) {
    await local.put({ id: phase, controlNoteId: 'native-task', phase, attempts: 0, updatedAt: 0, create, ...(phase === 'root-saved' ? { command: { input: { body: secret } } } : {}) });
    assert.equal((await local.all()).find(row => row.id === phase)!.create, undefined, phase);
    if (phase === 'root-saved') assert.equal((await local.all()).find(row => row.id === phase)!.command, undefined);
  }
  await local.put({ id: 'request', controlNoteId: 'native-task', phase: 'request-saved', attempts: 0, updatedAt: 0,
    command: { action: 'createTask', input: { body: secret } }, result: { status: 'saved', noteId: 'native-task' } });
  const restarted = new LocalIntentStore(host, () => 'unused', () => 10);
  await restarted.initialize();
  const request = (await restarted.all()).find(row => row.id === 'request')!;
  assert.equal(request.command, undefined);
  assert.deepEqual(request.result, { status: 'saved', noteId: 'native-task' });
  await restarted.remove('unfinished');
  assert.ok(!JSON.stringify(await restarted.all()).includes(secret));
});

test('native tags paginate and attach to notes without creating plugin categories', async () => {
  const host = new MemoryJoplin(); host.seedNote({ id: 'task', parent_id: 'book' });
  for (let i = 0; i < 5; i++) host.tags.set(`tag-${i}`, { id: `tag-${i}`, title: `原生标签 ${i}` });
  const gateway = new JoplinGateway(host);
  assert.equal((await gateway.tags()).length, 5);
  await gateway.addTags('task', ['tag-0', 'tag-2', 'tag-4']);
  assert.deepEqual(await gateway.noteTags('task'), ['tag-0', 'tag-2', 'tag-4']);
  assert.equal(host.notes.size, 1); assert.equal(host.notebooks.size, 0);
  assert.equal(host.calls.filter(call => call.method === 'post' && call.path[0] === 'tags').length, 3);
});

test('all nine view preferences and completed visibility persist while old preferences receive safe defaults', async () => {
  const host = new MemoryJoplin(); const local = new LocalIntentStore(host, () => 'device'); await local.initialize();
  host.settingsValues.set('io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad.preferences', JSON.stringify({ lastView: 'month', overdueToday: false }));
  assert.equal((await local.preferences()).showCompleted, false);
  for (const view of ['today', 'tomorrow', 'sevenDays', 'inbox', 'all', 'day', 'week', 'month', 'year'] as const) {
    await local.savePreferences({ defaultView: view, lastView: view, showCompleted: true });
    const restarted = new LocalIntentStore(host, () => 'unused'); await restarted.initialize();
    const saved = await restarted.preferences();
    assert.equal(saved.defaultView, view); assert.equal(saved.lastView, view); assert.equal(saved.showCompleted, true); assert.equal(saved.overdueToday, false);
  }
  host.settingsValues.set('io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad.preferences', JSON.stringify({ showCompleted: 'true' }));
  await assert.rejects(() => local.preferences(), { code: 'LOCAL_PREFERENCES' });
  assert.equal(host.settingsValues.get('io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad.preferences'), JSON.stringify({ showCompleted: 'true' }));
});
