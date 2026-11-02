import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { TaskApplication } from '../../src/services/taskApplication';
import { MemoryJoplin } from '../support/memory-joplin';

test('5000 notes/500 todos: scans omit bodies, unchanged refresh preserves version and refresh requests never fill outbox', async () => {
  const host = new MemoryJoplin(); host.pageSize = 100;
  for (let i = 0; i < 5000; i++) host.seedNote({ id: `note${i}`, is_todo: i < 500 ? 1 : 0, body: 'large body '.repeat(100) });
  const app = new TaskApplication(host); await app.initialize();
  const before = await app.snapshot();
  host.calls.length = 0;
  const start = performance.now();
  assert.equal((await app.dispatch({ action: 'refresh', requestId: 'benchmark' })).status, 'saved');
  const elapsed = performance.now() - start;
  const calls = host.calls.length;
  assert.equal(calls, 52);
  assert.ok(host.calls.filter(c => c.path.length === 1 && c.path[0] === 'notes').every(c => !c.query.fields.includes('body')));
  assert.equal((await app.snapshot()).snapshotVersion, before.snapshotVersion);
  assert.equal((await app.local.all()).filter(i => i.id.startsWith('request:')).length, 0);
  host.calls.length = 0;
  for (let i = 0; i < 10; i++) await app.snapshot();
  assert.equal(host.calls.length, 0, 'snapshot uses cached folders and tags');
  host.calls.length = 0;
  await app.dispatch({ action: 'refresh', requestId: 'incremental', noteIds: ['note1'] });
  assert.equal(host.calls.filter(c => c.path.length === 1 && c.path[0] === 'notes').length, 0);
  assert.equal(host.calls.length, 2);
  assert.equal((await app.snapshot()).snapshotVersion, before.snapshotVersion);
  host.notes.get('note1')!.title = 'Changed';
  await app.dispatch({ action: 'refresh', requestId: 'changed', noteIds: ['note1'] });
  assert.ok((await app.snapshot()).snapshotVersion > before.snapshotVersion);
  console.log(`issue54 refresh: ${calls} API calls, ${elapsed.toFixed(2)} ms`);
});

test('note selections preserve version and allow commands with the original snapshot', async () => {
  const { startPlugin } = await import('../../src/bootstrap');
  const host = new MemoryJoplin() as any;
  let selection = (_event?: { value?: string[] }) => {};
  host.workspace = { onNoteSelectionChange: async (fn: (event?: { value?: string[] }) => void) => { selection = fn; } };
  host.commands = { execute: async () => {}, register: async () => {} };
  host.views = { panels: { create: async () => 'panel', setHtml: async () => {}, addScript: async () => {}, onMessage: async () => {}, postMessage() {}, show: async () => {} } };
  host.notebooks.set('book', { id: 'book', title: 'Book' });
  host.seedNote({ id: 'selected', parent_id: 'book' });
  const runtime = await startPlugin(host);
  try {
    const version = (await runtime.app.snapshot()).snapshotVersion;
    host.calls.length = 0;
    for (let i = 0; i < 20; i++) selection({ value: ['selected'] });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(host.calls.length, 2);
    assert.ok(!host.calls.some((c: any) => c.path.length === 1 && c.path[0] === 'notes'));
    assert.equal((await runtime.app.snapshot()).snapshotVersion, version);
    const result = await runtime.app.dispatch({ action: 'createTask', requestId: 'selection-command', expectedSnapshotVersion: version, input: { title: 'After selection', notebookId: 'book', schedule: { kind: 'allDay', date: '2026-10-30', zone: 'UTC' } } });
    assert.equal(result.status, 'saved');
  } finally { runtime.dispose(); }
});

test('1000 causal series operations build history once and preserve branch before values', async () => {
  const { taskHistory } = await import('../../src/services/taskHistory');
  const { initialSeries, operation } = await import('../fixtures/operations');
  const { create } = initialSeries();
  const operations = [create] as any[];
  for (let i = 1; i <= 1000; i++) operations.push(operation(`edit${i}`, 'SetTaskFields', { title: `title${i}` }, [operations.at(-1).opId], i));
  const start = performance.now();
  const log = taskHistory(operations);
  console.log(`issue54 history 1000 operations: ${(performance.now() - start).toFixed(2)} ms`);
  assert.equal(log.length, 1001);
  assert.equal(log.find(row => row.id === 'edit1000')!.changes[0]!.before, 'title999');
  let reads = 0;
  for (const op of operations) {
    const payload = op.payload;
    Object.defineProperty(op, 'payload', { get: () => { reads++; return payload; } });
  }
  taskHistory(operations.slice(0, 501)); const halfReads = reads;
  reads = 0; taskHistory(operations);
  assert.ok(reads <= halfReads * 2.1, 'doubling a causal chain should double payload visits');
  const branch = operation('branch', 'SetTaskFields', { title: 'branch' }, ['edit1']);
  assert.equal(taskHistory([...operations, branch]).find(row => row.id === 'branch')!.changes[0]!.before, 'title1');
});

test('10000 distinct business commands retain a bounded deduplication window, including restart and expiry', { timeout: 60000 }, async () => {
  const { REQUEST_RESULT_TTL_MS } = await import('../../src/adapters/joplin/localIntentStore');
  const host = new MemoryJoplin();
  let now = Date.parse('2026-10-30T10:00:00Z');
  const options = { now: () => now };
  const app = new TaskApplication(host, options); await app.initialize();
  const start = performance.now();
  for (let i = 0; i < 10000; i++) {
    const result = await app.dispatch({ action: 'savePreferences', requestId: `business-${i}`, preferences: { showCompleted: !!(i % 2) } });
    assert.equal(result.status, 'saved', `command ${i}: ${result.code}`);
  }
  const records = await app.local.all();
  assert.ok(records.filter(row => row.phase === 'request-saved').length <= 512);
  const duplicate = { action: 'savePreferences' as const, requestId: 'business-9999', preferences: { showCompleted: false } };
  await app.dispatch(duplicate);
  assert.equal((await app.snapshot()).preferences.showCompleted, true, 'recent retry does not execute again');
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  await restarted.dispatch(duplicate);
  assert.equal((await restarted.snapshot()).preferences.showCompleted, true, 'deduplication survives restart');
  now += REQUEST_RESULT_TTL_MS + 1;
  await restarted.dispatch(duplicate);
  assert.equal((await restarted.snapshot()).preferences.showCompleted, false, 'expired request can execute again');
  const afterExpiry = new TaskApplication(host, options); await afterExpiry.initialize();
  assert.equal((await afterExpiry.local.all()).filter(row => row.phase === 'request-saved').length, 1, 'startup also removes expired stored results');
  console.log(`issue54 10000 commands: ${(performance.now() - start).toFixed(2)} ms, ${records.length} retained requests`);
});

test('startup reclaims a full legacy accumulation of completed requests but preserves recovery intents', async () => {
  const { LocalIntentStore } = await import('../../src/adapters/joplin/localIntentStore');
  const { LOCAL_SETTINGS_PREFIX } = await import('../../src/shared/pluginIdentity');
  const { CURRENT_STORAGE_VERSION } = await import('../../src/shared/storageVersion');
  const host = new MemoryJoplin();
  const local = new LocalIntentStore(host, () => 'device', () => 100000);
  const recovery: Record<string, any> = {};
  for (let shard = 0; shard < 16; shard++) {
    const rows: Record<string, any> = {};
    for (let i = 0; i < 510; i++) {
      const id = `request:old-${shard}-${i}`;
      rows[id] = { storageVersion: CURRENT_STORAGE_VERSION, id, phase: 'request-saved', controlNoteId: '', attempts: 0, updatedAt: i, result: { status: 'saved' } };
    }
    for (const phase of ['request-pending', 'root-create']) {
      const id = `${phase}-${shard}`;
      recovery[id] = rows[id] = { storageVersion: CURRENT_STORAGE_VERSION, id, phase, controlNoteId: '', updatedAt: 0, attempts: 1, command: { action: 'createTask' }, create: { noteId: 'original', input: { body: 'Recovery body' }, role: 'root' } };
    }
    host.settingsValues.set(`${LOCAL_SETTINGS_PREFIX}outbox.${shard}`, JSON.stringify(rows));
  }
  await local.initialize();
  const retained = await local.all();
  assert.equal(retained.filter(row => row.phase === 'request-saved').length, 512);
  for (const [id, original] of Object.entries(recovery)) assert.deepEqual(retained.find(row => row.id === id), original);
  await local.put({ id: 'request:after-cleanup', controlNoteId: '', phase: 'request-pending', attempts: 0, updatedAt: 0 });
});

test('capacity exhausted by unfinished recovery returns a structured error and preserves those records', async () => {
  const { LOCAL_SETTINGS_PREFIX } = await import('../../src/shared/pluginIdentity');
  const { CURRENT_STORAGE_VERSION } = await import('../../src/shared/storageVersion');
  const host = new MemoryJoplin(); let app = new TaskApplication(host); await app.initialize();
  const requestId = 'no-recovery-space';
  let hash = 0; for (const ch of `request:${requestId}`) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
  const key = `${LOCAL_SETTINGS_PREFIX}outbox.${hash % 16}`;
  const rows = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`pending-${i}`, {
    id: `pending-${i}`, storageVersion: CURRENT_STORAGE_VERSION, controlNoteId: '', phase: 'request-pending', updatedAt: 0, attempts: 0,
  }]));
  host.settingsValues.set(key, JSON.stringify(rows));
  app.dispose(); app = new TaskApplication(host); await app.initialize();
  const result = await app.dispatch({ action: 'savePreferences', requestId, preferences: { showCompleted: true } });
  assert.equal(result.status, 'error'); assert.equal(result.code, 'OUTBOX_CAPACITY');
  assert.deepEqual(JSON.parse(host.settingsValues.get(key) as string), rows);
  assert.equal((await app.snapshot()).preferences.showCompleted, false);
  delete rows['pending-0']; host.settingsValues.set(key, JSON.stringify(rows));
  app.dispose(); app = new TaskApplication(host); await app.initialize();
  assert.equal((await app.dispatch({ action: 'savePreferences', requestId, preferences: { showCompleted: true } })).status, 'saved');
});

test('full refresh reads tag membership by tag with pagination and incrementally updates changed membership', async () => {
  const host = new MemoryJoplin(); host.pageSize = 100;
  for (let i = 0; i < 500; i++) host.seedNote({ id: `todo-${i}` });
  host.seedNote({ id: 'ordinary', is_todo: 0 });
  host.tags.set('tag-b', { id: 'tag-b', title: 'A' });
  host.tags.set('tag-a', { id: 'tag-a', title: 'B' });
  for (let i = 0; i < 250; i++) host.noteTagIds.set(`todo-${i}`, new Set(['tag-a', ...(i === 0 ? ['tag-b'] : [])]));
  host.noteTagIds.set('ordinary', new Set(['tag-b']));
  const app = new TaskApplication(host); await app.initialize(); host.calls.length = 0;
  await app.dispatch({ action: 'refresh', requestId: 'tag-scan' });
  assert.equal(host.calls.filter(c => c.path[0] === 'notes' && c.path[2] === 'tags').length, 0);
  assert.equal(host.calls.filter(c => c.path[0] === 'tags' && c.path[2] === 'notes').length, 4);
  const snapshot = await app.snapshot();
  assert.deepEqual(snapshot.tasks.find(t => t.noteId === 'todo-0')!.tagIds, ['tag-a', 'tag-b']);
  assert.ok(!snapshot.tasks.some(t => t.noteId === 'ordinary'));
  await app.dispatch({ action: 'refresh', requestId: 'same-tags', noteIds: ['todo-0'] });
  assert.equal((await app.snapshot()).snapshotVersion, snapshot.snapshotVersion, 'membership ordering does not cause a stale snapshot');
  host.noteTagIds.set('todo-0', new Set(['tag-b']));
  await app.dispatch({ action: 'refresh', requestId: 'tag-change', noteIds: ['todo-0'] });
  assert.deepEqual((await app.snapshot()).tasks.find(t => t.noteId === 'todo-0')!.tagIds, ['tag-b']);
});

test('Advance/defer histories retain old occurrences across 1000 advances without deep prototypes or causal recursion', async () => {
  const { taskHistory } = await import('../../src/services/taskHistory');
  const { initialSeries, operation } = await import('../fixtures/operations');
  const { create, first } = initialSeries();
  const build = (count: number) => {
    const ops: any[] = [create];
    for (let i = 1; i <= count; i++) {
      const predecessorId = i === 1 ? first.occurrenceId : `occ-${i - 1}`;
      ops.push(operation(`terminal-${i}`, 'ActOccurrence', { action: 'complete', occurrenceId: predecessorId, at: i }, [ops.at(-1).opId], i));
      ops.push(operation(`advance-${i}`, 'Advance', {
        predecessorId, terminalOpId: `terminal-${i}`, ruleRevisionId: 'create',
        next: { ...first, predecessorId, occurrenceId: `occ-${i}`, scheduled: { ...first.scheduled, date: '2026-10-30' } },
      } as any, [ops.at(-1).opId], i));
    }
    for (let i = 1; i <= count; i++) ops.push(operation(`defer-${i}`, 'ActOccurrence', {
      action: 'defer', occurrenceId: `occ-${i}`, schedule: { ...first.scheduled, date: '2026-10-31' },
    } as any, [ops.at(-1).opId], count + i));
    return ops;
  };
  let visits = 0;
  const measure = (count: number) => {
    const ops = build(count);
    for (const op of ops) {
      const payload = op.payload;
      Object.defineProperty(op, 'payload', { get: () => { visits++; return payload; } });
    }
    visits = 0;
    const start = performance.now();
    const log = taskHistory(ops.reverse());
    const elapsed = performance.now() - start;
    for (let i = 1; i <= count; i++) {
      const entry = log.find(row => row.id === `defer-${i}`)!;
      assert.equal((entry.changes[0]!.before as any).date, '2026-10-30');
      assert.equal((entry.changes[0]!.after as any).date, '2026-10-31');
    }
    return { visits, elapsed };
  };
  const branch = operation('schedule-branch', 'ActOccurrence', {
    action: 'defer', occurrenceId: 'occ-1', schedule: { ...first.scheduled, date: '2026-11-01' },
  } as any, ['advance-1']);
  const branched = taskHistory([...build(1000), branch]);
  assert.equal((branched.find(row => row.id === 'schedule-branch')!.changes[0]!.before as any).date, '2026-10-30', 'later defers do not mutate a branch parent');
  const half = measure(500), full = measure(1000);
  assert.ok(full.visits <= half.visits * 2.1);
  assert.equal(taskHistory(build(10000).reverse()).length, 30001, 'reverse input traverses a 30000-deep chain without stack overflow');
  console.log(`issue54 Advance/defer: 1500 operations ${half.elapsed.toFixed(2)} ms; 3000 operations ${full.elapsed.toFixed(2)} ms`);
});
