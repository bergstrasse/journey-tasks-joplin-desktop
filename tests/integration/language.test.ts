import { initializeArchiveBody } from '../../src/domain/bodyTemplate';
import { templateNote } from '../support/template-note';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registry } from '../../src/i18n';
import { LocalIntentStore } from '../../src/adapters/joplin/localIntentStore';
import { TaskApplication } from '../../src/services/taskApplication';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import { MemoryJoplin } from '../support/memory-joplin';
import { withoutAnchorNotice } from '../support/note-body';

const preferencesKey = 'io.journey.tasks.97d1cd8a-5ed4-4cc9-9bf8-f0b287db6cad.preferences';

test('old device preferences without language load as auto without losing existing view choices', async () => {
  const host = new MemoryJoplin();
  const old = { startupMode: 'restore', defaultView: 'month', lastView: 'year', overdueToday: false, overdueSeven: true };
  host.settingsValues.set(preferencesKey, JSON.stringify(old));
  const local = new LocalIntentStore(host, () => 'device');
  await local.initialize();
  assert.deepEqual(await local.preferences(), { ...old, listSort: 'scheduledAsc', displayCalendar: 'solar', defaultCalendar: 'solar', timeFormat: '24h', language: 'auto', showCompleted: false, overdueTomorrow: true });
  assert.deepEqual(JSON.parse(host.settingsValues.get(preferencesKey) as string), old,
    'reading an old preference must not rewrite it or reset the view');
});

test('language choice persists across local store restart and remains independent for each device', async () => {
  const a = new MemoryJoplin();
  const b = new MemoryJoplin();
  const storeA = new LocalIntentStore(a, () => 'A');
  const storeB = new LocalIntentStore(b, () => 'B');
  await storeA.initialize(); await storeB.initialize();
  for (const language of ['auto', ...Object.keys(registry)] as Array<'auto' | keyof typeof registry>) {
    await storeA.savePreferences({ language });
    const restarted = new LocalIntentStore(a, () => 'ignored');
    await restarted.initialize();
    assert.equal((await restarted.preferences()).language, language);
    assert.equal((await storeB.preferences()).language, 'auto');
  }
});

test('invalid language is rejected before overwriting valid saved preferences', async () => {
  const host = new MemoryJoplin();
  const local = new LocalIntentStore(host, () => 'device');
  await local.initialize();
  await local.savePreferences({ language: 'en', lastView: 'year' });
  const before = host.settingsValues.get(preferencesKey);
  for (const language of ['unsupported', '', null, ['en'], { language: 'en' }]) {
    await assert.rejects(() => local.savePreferences({ language } as never));
    assert.equal(host.settingsValues.get(preferencesKey), before);
  }
  assert.equal((await local.preferences()).language, 'en');
});

test('corrupt stored language is diagnosed without silently replacing the original data', async () => {
  const host = new MemoryJoplin();
  const raw = JSON.stringify({ language: 'unsupported', defaultView: 'year' });
  host.settingsValues.set(preferencesKey, raw);
  const local = new LocalIntentStore(host, () => 'device');
  await local.initialize();
  await assert.rejects(() => local.preferences(), { code: 'LOCAL_PREFERENCES' });
  assert.equal(host.settingsValues.get(preferencesKey), raw);
});

test('application language changes persist while user task, notebook and template content remain unchanged', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  host.notebooks.set('book', { id: 'book', title: '今日 / Today / 自定义笔记本' });
  let id = 0;
  const now = () => Date.parse('2026-10-24T02:00:00Z');
  const options = { now, randomId: () => String(++id).padStart(32, '0') };
  const app = new TaskApplication(host, options); await app.initialize();
  const title = '今日 · Today · 重复规则';
  const body = '- [x] 用户内容\nToday / 无日期 / <b>保留原文</b>';
  const created = await app.dispatch({ action: 'createTask', requestId: 'language-task', input: {
    title, body: templateNote(body), notebookId: 'book', schedule: { kind: 'allDay', date: '2026-10-24', zone: 'Asia/Shanghai' },
    recurrence: { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } },
    mode: 'archive',
  } });
  assert.equal(created.status, 'saved', created.message);
  const notesBefore = structuredClone([...host.notes.entries()]);
  const notebooksBefore = structuredClone([...host.notebooks.entries()]);
  for (const language of ['auto', ...Object.keys(registry)] as Array<'auto' | keyof typeof registry>) {
    const changed = await app.dispatch({ action: 'savePreferences', requestId: `set-language-${language}`, preferences: { language } });
    assert.equal(changed.status, 'saved', changed.message);
    const snapshot = await app.snapshot({ view: 'today', deviceZone: 'Asia/Shanghai' });
    assert.equal(snapshot.preferences.language, language);
    assert.equal(snapshot.tasks.find(task => task.noteId === created.noteId)?.title, title);
    assert.deepEqual([...host.notes.entries()], notesBefore, 'language preference must not mutate task/template/control notes');
    assert.deepEqual([...host.notebooks.entries()], notebooksBefore);
  }
  await app.dispatch({ action: 'savePreferences', requestId: 'persist-English', preferences: { language: 'en' } });
  const restarted = new TaskApplication(host, options); await restarted.initialize();
  assert.equal((await restarted.snapshot()).preferences.language, 'en');
  assert.equal(host.notes.get(created.noteId!)?.body, initializeArchiveBody(templateNote(body)));
});

test('snapshot exposes Joplin locale ahead of runtime locale without changing the auto preference', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  let legacyCalls = 0;
  Object.assign(host.settings, {
    globalValues: async (keys: string[]) => { assert.deepEqual(keys, ['locale']); return ['en_GB']; },
    globalValue: async () => { legacyCalls++; return 'zh-CN'; },
  });
  const app = new TaskApplication(host); await app.initialize();
  const snapshot = await app.snapshot();
  assert.equal(snapshot.systemLocale, 'en_GB');
  assert.equal(snapshot.preferences.language, 'auto');
  assert.equal(legacyCalls, 0, 'legacy getter should not override the modern host locale');
});

test('legacy-only Joplin locale API and unavailable host locale retain a usable language hint', async () => {
  const legacy = new MemoryJoplin(); legacy.namespace = DEFAULT_PLUGIN_ID;
  Object.assign(legacy.settings, { globalValue: async (key: string) => { assert.equal(key, 'locale'); return 'zh_TW'; } });
  const oldApp = new TaskApplication(legacy); await oldApp.initialize();
  assert.equal((await oldApp.snapshot()).systemLocale, 'zh_TW');

  const missing = new MemoryJoplin(); missing.namespace = DEFAULT_PLUGIN_ID;
  Object.assign(missing.settings, { globalValues: async () => { throw new Error('unsupported host setting'); } });
  const fallbackApp = new TaskApplication(missing); await fallbackApp.initialize();
  assert.equal((await fallbackApp.snapshot()).systemLocale, 'en-US');
});

test('startup reads locale once through a fresh Joplin proxy path and reloads it after restart', async () => {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID;
  const settings = host.settings;
  let path: string[] = [];
  let locale = 'en_US';
  let calls = 0;
  const proxy: any = new Proxy(() => {}, {
    get(_target, key: string) { path.push(key); return proxy; },
    apply(_target, _this, args) {
      assert.deepEqual(path, ['globalValues'], 'cached/probed proxy paths must not duplicate method names');
      assert.deepEqual(args, [['locale']]);
      calls++;
      return Promise.resolve([locale]);
    },
  });
  Object.defineProperty(host, 'settings', { get() {
    path = [];
    return new Proxy(settings, { get(target, key: string) {
      if (key.startsWith('global')) { path.push(key); return proxy; }
      return Reflect.get(target, key);
    } });
  } });
  const first = new TaskApplication(host); await first.initialize();
  assert.equal((await first.snapshot()).systemLocale, 'en_US');
  await first.snapshot();
  assert.equal(calls, 1, 'snapshots must not poll the host locale');
  first.dispose();
  locale = 'zh_CN';
  const restarted = new TaskApplication(host); await restarted.initialize();
  assert.equal((await restarted.snapshot()).systemLocale, 'zh_CN');
  assert.equal(calls, 2);
  restarted.dispose();
});
