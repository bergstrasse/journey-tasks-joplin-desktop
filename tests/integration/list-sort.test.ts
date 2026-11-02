import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalIntentStore } from '../../src/adapters/joplin/localIntentStore';
import { MemoryJoplin } from '../support/memory-joplin';

test('list sorting preferences survive restart and reject invalid patches before writing', async () => {
  const host = new MemoryJoplin();
  const store = new LocalIntentStore(host, () => 'device');
  await store.initialize();
  await store.savePreferences({ listGrouping: 'notebook', listOrder: 'descending' });
  const restarted = new LocalIntentStore(host, () => 'device');
  const saved = await restarted.preferences();
  assert.equal(saved.listGrouping, 'notebook');
  assert.equal(saved.listOrder, 'descending');
  for (const patch of [{ listGrouping: 'invalid' }, { listOrder: null }]) {
    await assert.rejects(() => store.savePreferences(patch as any));
    assert.deepEqual(await store.preferences(), saved);
  }
});
