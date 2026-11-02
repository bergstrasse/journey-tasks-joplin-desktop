import { templateNote } from '../support/template-note';
import test from 'node:test';
import { initializeArchiveBody, parseArchiveBody } from '../../src/domain/bodyTemplate';
import { buildArchiveBody } from '../support/body-template';
import assert from 'node:assert/strict';
import { JoplinGateway } from '../../src/adapters/joplin/gateway';
import { LocalIntentStore } from '../../src/adapters/joplin/localIntentStore';
import { DEFAULT_PLUGIN_ID, JournalRepository, operationPrefix, scopeKey, type SingleOperation } from '../../src/adapters/joplin/repositories';
import { TemplateRepository } from '../../src/adapters/joplin/templateRepository';
import { stableHash } from '../../src/domain/identity';
import { initialSeries, operation } from '../fixtures/operations';
import { MemoryJoplin } from '../support/memory-joplin';

async function setup() {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  const local = new LocalIntentStore(host, () => 'device', () => 123);
  await local.initialize();
  const gateway = new JoplinGateway(host);
  const journal = new JournalRepository(gateway, local);
  const templates = new TemplateRepository(journal);
  return { host, local, gateway, journal, templates };
}

test('journal refuses absent first task instead of creating auxiliary notes or folders', async () => {
  const { host, journal } = await setup();
  await assert.rejects(() => journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series-one', rootNoteId: 'absent' }), { code: 'ANCHOR_UNAVAILABLE' });
  assert.equal(host.notes.size, 0); assert.equal(host.notebooks.size, 0);
  assert.equal(host.calls.filter(call => call.method === 'post').length, 0);
});

test('one real task carries isolated single and series scopes, including immutable operation recovery', async () => {
  const { host, gateway, journal } = await setup();
  host.seedNote({ id: 'root', title: '用户任务', body: '- [x] 执行正文' });
  await journal.createControl({ schemaVersion: 3, role: 'single', seriesId: 'single-one', rootNoteId: 'root' });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series-one', rootNoteId: 'root' });
  const payload = { patch: { priority: 'high' } };
  const single: SingleOperation = { schemaVersion: 1, opId: 'single-op', deviceId: 'A', deviceSeq: 1, parents: [], recordedAt: 1,
    kind: 'SinglePatch', payload, payloadHash: stableHash(payload) };
  const { create } = initialSeries();
  await journal.append('root', single, 'single-one');
  await journal.append('root', create, 'series-one');
  const note = (await gateway.getNote('root'))!;
  assert.deepEqual((await journal.operations(note, 'single-one')).map(op => op.opId), ['single-op']);
  assert.deepEqual((await journal.operations(note, 'series-one')).map(op => op.opId), ['create']);
  await assert.rejects(() => journal.operations(note), { code: 'SCOPE_REQUIRED' });
  await assert.rejects(() => journal.append('root', create, 'single-one'), { code: 'OPERATION_SCOPE' });
  await journal.replayPending();
  assert.equal(host.notes.size, 1); assert.equal(host.notebooks.size, 0);
  assert.equal(host.notes.get('root')!.body, '- [x] 执行正文');
  const keys = Object.keys(JSON.parse(host.notes.get('root')!.user_data)[host.namespace]);
  assert.ok(keys.includes(scopeKey('single-one')) && keys.includes(scopeKey('series-one')));
  assert.equal(keys.filter(key => key.startsWith(operationPrefix('series-one'))).length, 1);
});

test('native first-task template is initialized once, read fresh, and never persisted in userData', async () => {
  const { host, journal, templates } = await setup();
  const original = '- [x] 用户原文\n尾行\n';
  host.seedNote({ id: 'root', title: '第一期', body: templateNote(original) });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series-one', rootNoteId: 'root' });
  await templates.ensureSource('series-one');
  assert.equal(host.notes.get('root')!.body, initializeArchiveBody(templateNote(original)));
  assert.equal((await templates.readSource('series-one')).body, original);
  const template = '- [x] 新模板独特内容\n- [ ] 不重置';
  await host.data.put(['notes', 'root'], {}, { title: '原生新标题', body: buildArchiveBody('执行日志已改', template) });
  await templates.ensureSource('series-one');
  const source = await templates.readSource('series-one');
  assert.equal(source.title, '原生新标题'); assert.equal(source.body, template); assert.equal(source.sourceNoteId, 'root');
  assert.notEqual(source.sourceHash, (await (async () => {
    await host.data.put(['notes', 'root'], {}, { body: buildArchiveBody('执行日志已改', template + '\n更改') });
    return templates.readSource('series-one');
  })()).sourceHash);
  assert.equal(host.notes.size, 1); assert.equal(host.notebooks.size, 0);
  assert.ok(!host.notes.get('root')!.user_data.includes(original));
  assert.ok(!host.notes.get('root')!.user_data.includes('新模板独特内容'));
});

test('missing or malformed native source never becomes an empty generated template or a recreated root', async () => {
  const { host, journal, templates } = await setup();
  host.seedNote({ id: 'root', body: templateNote('original') });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series-one', rootNoteId: 'root' });
  await templates.ensureSource('series-one');
  host.notes.get('root')!.body = buildArchiveBody('original').replace('template:end', 'template:bad');
  await assert.rejects(() => templates.readSource('series-one'), { code: 'TEMPLATE_FORMAT' });
  host.notes.delete('root');
  await assert.rejects(() => templates.readSource('series-one'));
  assert.equal(host.notes.size, 0); assert.equal(host.calls.filter(call => call.method === 'post').length, 0);
});

test('legacy auxiliary notes and unversioned outbox records are ignored rather than migrated or replayed', async () => {
  const { host, journal, local } = await setup();
  host.seedNote({ id: 'legacy-control', is_todo: 0, user_data: JSON.stringify({ [host.namespace]: {
    meta: { v: { schemaVersion: 1, role: 'series', seriesId: 'old-series', rootNoteId: 'old-root' }, t: 1 },
  } }) });
  const { create } = initialSeries();
  host.settingsValues.set('io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad.outbox.0', JSON.stringify({ legacy: { id: 'legacy', controlNoteId: 'legacy-control',
    phase: 'journal-pending', operation: create, updatedAt: 1, attempts: 0 } }));
  const before = structuredClone([...host.notes.entries()]);
  assert.equal((await local.all()).length, 0);
  const found = await journal.discover([...host.notes.values()] as any);
  assert.equal(found.controls.length, 0); assert.equal(found.templates.length, 0);
  await journal.replayPending();
  assert.deepEqual([...host.notes.entries()], before);
});

test('encoded scope prefixes cannot read a different scope whose ID extends the first with a colon', async () => {
  const { host, journal, gateway } = await setup(); host.seedNote({ id: 'root' });
  for (const seriesId of ['scope', 'scope:child']) {
    await journal.createControl({ schemaVersion: 3, role: 'single', seriesId, rootNoteId: 'root' });
    const payload = { patch: { title: seriesId } };
    const op: SingleOperation = { schemaVersion: 1, opId: `op-${seriesId}`, deviceId: 'A', deviceSeq: 1,
      parents: [], recordedAt: 1, kind: 'SinglePatch', payload, payloadHash: stableHash(payload) };
    await journal.append('root', op, seriesId);
  }
  const note = (await gateway.getNote('root'))!;
  assert.deepEqual((await journal.operations(note, 'scope')).map(op => op.opId), ['op-scope']);
  assert.deepEqual((await journal.operations(note, 'scope:child')).map(op => op.opId), ['op-scope:child']);
});

test('template code examples and escaped external image syntax are literal text, not attachment embeds', async () => {
  const { templates } = await setup();
  for (const body of ['Data: notes about tasks', '`![example](:/0123456789abcdef0123456789abcdef)`',
    '```markdown\n![example](:/0123456789abcdef0123456789abcdef)\n```', '\\![literal](https://example.com/image.png)'])
    assert.deepEqual(await templates.verifyReferences(body), [], body);
  for (const body of ['![shortcut]', '\\\\![image](https://example.com/image.png)'])
    await assert.rejects(() => templates.verifyReferences(body), { code: 'TEMPLATE_ATTACHMENTS_UNSUPPORTED' });
});

test('validating a template performs no native body writes', async () => {
  const { host, journal, templates } = await setup();
  const body = templateNote('initial text');
  host.seedNote({ id: 'root', title: 'task', body });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series-one', rootNoteId: 'root' });
  const count = host.mutations().length;
  await templates.readSource('series-one');
  assert.equal(host.notes.get('root')!.body, body);
  assert.equal(host.mutations().length, count);
});

for (const phase of ['prepare', 'partial-operations', 'commit'] as const) test(`reanchor ${phase} failure never exposes an incomplete new authority and resumes idempotently`, async () => {
  const { host, gateway, journal, local } = await setup();
  host.seedNote({ id: 'old-root', body: 'old execution' });
  host.seedNote({ id: 'new-root', body: 'new execution' });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series-one', rootNoteId: 'old-root' });
  const { create } = initialSeries();
  await journal.append('old-root', create, 'series-one');
  const patch = operation('later-patch', 'SetTaskFields', { priority: 'high' });
  await journal.append('old-root', patch, 'series-one');
  const set = host.data.userDataSet;
  let failed = false;
  host.data.userDataSet = async (type, id, key, value) => {
    const hit = phase === 'prepare' ? key === scopeKey('series-one') : phase === 'partial-operations' ? key === operationPrefix('series-one') + patch.opId : key.startsWith('v3:anchor-commit:');
    if (id === 'new-root' && hit && !failed) { failed = true; throw new Error(`interrupted ${phase}`); }
    return set(type, id, key, value);
  };
  await assert.rejects(() => journal.reanchor('series-one', 'new-root', 'transfer-one'));
  const restarted = new JournalRepository(gateway, local);
  const partial = await restarted.discover(await gateway.allNotes());
  assert.equal(partial.controls.length, 1);
  assert.equal(partial.controls[0]!.note.id, 'old-root');
  await restarted.reanchor('series-one', 'new-root', 'transfer-one');
  await restarted.reanchor('series-one', 'new-root', 'transfer-one');
  host.notes.delete('old-root');
  const final = await restarted.discover(await gateway.allNotes());
  assert.equal(final.controls.length, 1);
  assert.equal(final.controls[0]!.note.id, 'new-root');
  assert.equal((await restarted.operations(final.controls[0]!.note, 'series-one')).length, 2);
  assert.equal(host.notes.get('new-root')!.body, 'new execution');
});

test('a committed transfer with a not-yet-synced operation waits even after the old root disappears', async () => {
  const { host, gateway, journal, local } = await setup();
  host.seedNote({ id: 'old-root', body: 'old' }); host.seedNote({ id: 'new-root', body: 'new' });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series-one', rootNoteId: 'old-root' });
  const { create } = initialSeries(); await journal.append('old-root', create, 'series-one');
  await journal.reanchor('series-one', 'new-root', 'transfer-partial-sync');
  const envelope = JSON.parse(host.notes.get('new-root')!.user_data);
  const key = operationPrefix('series-one') + create.opId;
  const entry = envelope[host.namespace][key]; delete envelope[host.namespace][key];
  host.notes.get('new-root')!.user_data = JSON.stringify(envelope);
  host.notes.delete('old-root');
  const fresh = new JournalRepository(gateway, local);
  const waiting = await fresh.discover(await gateway.allNotes());
  assert.equal(waiting.controls.length, 0); assert.ok(waiting.issues.length);
  envelope[host.namespace][key] = entry; host.notes.get('new-root')!.user_data = JSON.stringify(envelope);
  const restored = await fresh.discover(await gateway.allNotes());
  assert.equal(restored.controls.length, 1); assert.equal(restored.controls[0]!.note.id, 'new-root');
  assert.equal(host.notes.get('new-root')!.body, 'new');
  assert.equal(host.notes.size, 1);
});

test('late retired-root operations require explicit compatible merge and never rewrite either body', async () => {
  const { host, gateway, journal, local } = await setup();
  host.seedNote({ id: 'old-root', body: '- [x] retired user log' }); host.seedNote({ id: 'new-root', body: '- [ ] current user log' });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series-one', rootNoteId: 'old-root' });
  const { create } = initialSeries(); await journal.append('old-root', create, 'series-one');
  await journal.reanchor('series-one', 'new-root', 'late-transfer');
  const late = operation('late-field', 'SetTaskFields', { priority: 'high' });
  const offline = new JournalRepository(gateway, local); offline.registerAnchor('series-one', 'old-root');
  await offline.append('old-root', late, 'series-one');
  const fresh = new JournalRepository(gateway, local);
  const paused = await fresh.discover(await gateway.allNotes());
  assert.equal(paused.controls.length, 0); assert.ok(paused.issues.length);
  assert.ok(!(await journal.operations((await gateway.getNote('new-root'))!, 'series-one')).some(op => op.opId === late.opId));
  await fresh.mergeRetired('series-one');
  const merged = await fresh.discover(await gateway.allNotes());
  assert.equal(merged.controls.length, 1); assert.equal(merged.controls[0]!.note.id, 'new-root');
  assert.ok((await fresh.operations(merged.controls[0]!.note, 'series-one')).some(op => op.opId === late.opId));
  assert.equal(host.notes.get('old-root')!.body, '- [x] retired user log');
  assert.equal(host.notes.get('new-root')!.body, '- [ ] current user log');
  const before = host.mutations().length; await fresh.mergeRetired('series-one');
  assert.equal(host.mutations().length, before, 'a second compatible merge must not append duplicate metadata');
});

test('retired-root merge rejects conflicting operation identities without changing metadata or user bodies', async () => {
  const { host, gateway, journal, local } = await setup();
  host.seedNote({ id: 'old-root', body: 'retired' }); host.seedNote({ id: 'new-root', body: 'current' });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series-one', rootNoteId: 'old-root' });
  const { create } = initialSeries(); await journal.append('old-root', create, 'series-one');
  const patch = operation('same-id', 'SetTaskFields', { priority: 'high' });
  await journal.append('old-root', patch, 'series-one');
  await journal.reanchor('series-one', 'new-root', 'conflict-transfer');
  const altered = operation('same-id', 'SetTaskFields', { priority: 'low' });
  const raw = JSON.parse(host.notes.get('old-root')!.user_data);
  raw[host.namespace][operationPrefix('series-one') + patch.opId].v = altered;
  host.notes.get('old-root')!.user_data = JSON.stringify(raw);
  const before = structuredClone([...host.notes.entries()]);
  const fresh = new JournalRepository(gateway, local);
  await assert.rejects(() => fresh.mergeRetired('series-one'));
  assert.deepEqual([...host.notes.entries()], before);
});

test('concurrent committed heads cannot be chosen implicitly by retired-root merge', async () => {
  const { host, gateway, journal, local } = await setup();
  for (const id of ['root', 'head-A', 'head-B']) host.seedNote({ id, body: `user ${id}` });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series-one', rootNoteId: 'root' });
  const { create } = initialSeries(); await journal.append('root', create, 'series-one');
  await journal.reanchor('series-one', 'head-A', 'branch-A');
  const offline = new JournalRepository(gateway, local); offline.registerAnchor('series-one', 'root');
  await offline.reanchor('series-one', 'head-B', 'branch-B');
  const before = structuredClone([...host.notes.entries()]);
  await assert.rejects(() => new JournalRepository(gateway, local).mergeRetired('series-one'));
  assert.deepEqual([...host.notes.entries()], before);
});


test('a corrupt series journal is isolated while healthy scopes remain discoverable', async () => {
  const { host, gateway, journal, local } = await setup();
  for (const id of ['corrupt-root', 'healthy-root']) {
    host.seedNote({ id, body: `original ${id}` });
    await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: id, rootNoteId: id });
  }
  const { create } = initialSeries();
  const bad = { ...create, seriesId: 'corrupt-root', payloadHash: 'corrupt-hash' };
  await host.data.userDataSet(1, 'corrupt-root', operationPrefix('corrupt-root') + bad.opId, bad);
  const before = host.mutations().length;
  const fresh = new JournalRepository(gateway, local);
  const result = await fresh.discover(await gateway.allNotes());
  assert.deepEqual(result.controls.map(row => row.meta.seriesId), ['healthy-root']);
  assert.ok(result.issues.some(issue => issue.seriesId === 'corrupt-root' && issue.noteId === 'corrupt-root'));
  assert.equal(fresh.controlId('healthy-root'), 'healthy-root');
  assert.equal(host.mutations().length, before, 'corrupt discovery must not repair or overwrite any notes');
});

test('template initialization runs once across restart and reads fresh user edits', async () => {
  const { host, gateway, journal, templates, local } = await setup();
  const original = templateNote('- [x] raw template', 'execution prefix\n', '\nuser suffix');
  host.seedNote({ id: 'once-root', title: 'same native title', body: original });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'once-series', rootNoteId: 'once-root' });
  await templates.ensureSource('once-series');
  assert.equal(host.notes.get('once-root')!.body, initializeArchiveBody(original));
  const restartedJournal = new JournalRepository(gateway, local); restartedJournal.registerAnchor('once-series', 'once-root');
  const restarted = new TemplateRepository(restartedJournal);
  await restarted.ensureSource('once-series');
  assert.equal(host.notes.get('once-root')!.body, initializeArchiveBody(original));
  const edited = 'arbitrary execution log\n' + templateNote('- [ ] future native edit') + '\nuser suffix';
  await host.data.put(['notes', 'once-root'], {}, { body: edited });
  await restarted.ensureSource('once-series');
  assert.equal(host.notes.get('once-root')!.body, edited);
  assert.equal((await restarted.readSource('once-series')).body, '- [ ] future native edit');
});

for (const afterCommit of [false, true]) test(`archive execution initialization retries a failed body write exactly once (committed=${afterCommit})`, async () => {
  const { host, journal, templates, gateway, local } = await setup();
  const original = templateNote('times:', 'existing log\n', '\nsuffix');
  const expected = 'existing log\ntimes:\n' + templateNote('times:') + '\nsuffix';
  host.seedNote({ id: 'root', body: original });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series', rootNoteId: 'root' });
  host.failNext('put', 'notes/root', afterCommit);
  await assert.rejects(() => templates.ensureSource('series'));
  assert.equal(host.notes.get('root')!.body, afterCommit ? expected : original);
  const restartedJournal = new JournalRepository(gateway, local);
  restartedJournal.registerAnchor('series', 'root');
  const restarted = new TemplateRepository(restartedJournal);
  await restarted.ensureSource('series');
  await restarted.ensureSource('series');
  assert.equal(host.notes.get('root')!.body, expected);
});

test('archive initialization survives a lost done receipt without copying again and protects concurrent edits', async () => {
  const { host, journal, templates } = await setup();
  host.seedNote({ id: 'root', body: templateNote('times:') });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'series', rootNoteId: 'root' });
  const set = host.data.userDataSet;
  let failed = false;
  host.data.userDataSet = async (type, id, key, value) => {
    if (!failed && key.startsWith('v3:archive-init:') && key.endsWith(':done')) { failed = true; throw new Error('lost done'); }
    return set(type, id, key, value);
  };
  await assert.rejects(() => templates.ensureSource('series'));
  const expected = 'times:\n' + templateNote('times:');
  assert.equal(host.notes.get('root')!.body, expected);
  await templates.ensureSource('series');
  assert.equal(host.notes.get('root')!.body, expected);

  host.seedNote({ id: 'other', body: templateNote('times:') });
  await journal.createControl({ schemaVersion: 3, role: 'series', seriesId: 'other-series', rootNoteId: 'other' });
  host.failNext('put', 'notes/other');
  await assert.rejects(() => templates.ensureSource('other-series'));
  const edited = templateNote('user changed template', 'new execution\n');
  await host.data.put(['notes', 'other'], {}, { body: edited });
  await assert.rejects(() => templates.ensureSource('other-series'), { code: 'TEMPLATE_SOURCE_CHANGED' });
  assert.equal(host.notes.get('other')!.body, edited);
});
