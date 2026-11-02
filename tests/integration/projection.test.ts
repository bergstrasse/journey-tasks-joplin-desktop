import test from 'node:test';
import assert from 'node:assert/strict';
import { JoplinGateway } from '../../src/adapters/joplin/gateway';
import { ProjectionExecutor, type ProjectionContext } from '../../src/services/projectionExecutor';
import type { ProjectionPayload } from '../../src/shared/models';
import { MemoryJoplin } from '../support/memory-joplin';

function setup() {
  const host = new MemoryJoplin();
  host.seedNote({ id: 'carrier', body: '- [x] preserve\n![attachment](:/resource)' });
  const shared: Array<{ kind: string; payload: ProjectionPayload }> = [];
  const context: ProjectionContext = {
    noteId: 'carrier', occurrenceId: 'occurrence', carrierGeneration: 2,
    sourceOpId: 'advance:2', phase: 'activate', knownProjections: [],
    append: async (kind, payload) => { shared.push({ kind, payload: structuredClone(payload) }); },
  };
  return { host, shared, context, executor: new ProjectionExecutor(new JoplinGateway(host)) };
}

test('native projection publishes intent before writing and receipt after readback without touching body', async () => {
  const { host, shared, context, executor } = setup();
  const originalPut = host.data.put;
  host.data.put = async (...args) => {
    assert.equal(shared.at(-1)?.kind, 'ProjectionIntent');
    return originalPut(...args);
  };
  const result = await executor.execute(context, { is_todo: 1, todo_completed: 0, todo_due: 123 });
  assert.equal(result.body, '- [x] preserve\n![attachment](:/resource)');
  assert.deepEqual(shared.map(record => record.kind), ['ProjectionIntent', 'ProjectionReceipt']);
  assert.equal(shared[1]!.payload.carrierGeneration, 2);
  assert.equal(host.calls.find(c => c.method === 'put')?.body.body, undefined);
});

test('failed durable intent never changes original native fields', async () => {
  const { host, context, executor } = setup();
  context.append = async () => { throw new Error('shared store unavailable'); };
  await assert.rejects(() => executor.execute(context, { is_todo: 1, todo_completed: 0, todo_due: 123 }), /shared store unavailable/);
  assert.equal(host.notes.get('carrier')!.todo_due, 0);
  assert.equal(host.calls.filter(c => c.method === 'put').length, 0);
});

test('native user edit arriving after intent is preserved and stops projection', async () => {
  const { host, shared, context, executor } = setup();
  context.append = async (kind, payload) => {
    shared.push({ kind, payload });
    host.notes.get('carrier')!.todo_due = 999;
  };
  await assert.rejects(() => executor.execute(context, { is_todo: 1, todo_completed: 0, todo_due: 123 }), { code: 'NATIVE_CHANGED' });
  assert.equal(host.notes.get('carrier')!.todo_due, 999);
  assert.equal(host.calls.filter(c => c.method === 'put').length, 0);
});

test('native PUT commit with lost response resumes from shared intent without duplicate write', async () => {
  const { host, shared, context, executor } = setup();
  host.failNext('put', 'notes/carrier', true);
  const after = { is_todo: 1, todo_completed: 0, todo_due: 123 };
  await assert.rejects(() => executor.execute(context, after), /Injected/);
  assert.equal(host.notes.get('carrier')!.todo_due, 123);
  context.knownProjections = shared.map(entry => entry.payload);
  await executor.execute(context, after);
  assert.equal(host.calls.filter(c => c.method === 'put').length, 1);
  assert.equal(shared.at(-1)?.kind, 'ProjectionReceipt');
});

test('conflicting recovered intent pauses and cannot overwrite with a different desired value', async () => {
  const { host, shared, context, executor } = setup();
  await executor.execute(context, { is_todo: 1, todo_completed: 0, todo_due: 123 });
  context.knownProjections = shared.map(entry => entry.payload);
  await assert.rejects(() => executor.execute(context, { is_todo: 1, todo_completed: 0, todo_due: 456 }), { code: 'PROJECTION_CONFLICT' });
  assert.equal(host.notes.get('carrier')!.todo_due, 123);
});

test('post-write mismatch records failure and does not fight concurrent native edits in a retry loop', async () => {
  const { host, context, executor } = setup();
  const originalPut = host.data.put;
  host.data.put = async (...args) => {
    const result = await originalPut(...args);
    host.notes.get('carrier')!.todo_due = 999;
    return result;
  };
  await assert.rejects(() => executor.execute(context, { is_todo: 1, todo_completed: 0, todo_due: 123 }), { code: 'PROJECTION_READBACK' });
  assert.equal(host.notes.get('carrier')!.todo_due, 999);
  assert.equal(host.calls.filter(c => c.method === 'put').length, 1);
});
