import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dynamicTranslationKeys, unusedTranslationKeys } from '../support/translation-usage';

test('every locale key has a source literal or a registered dynamic caller', () => {
  for (const { caller } of dynamicTranslationKeys) assert.ok(existsSync(caller), caller);
  for (const file of readdirSync('src/i18n/locales').filter(file => file.endsWith('.json'))) {
    const dictionary = JSON.parse(readFileSync(`src/i18n/locales/${file}`, 'utf8'));
    assert.deepEqual(unusedTranslationKeys(Object.keys(dictionary)), [], file);
  }
});

test('unregistered keys and invalid dynamic suffixes are rejected', () => {
  assert.deepEqual(unusedTranslationKeys(['unused.example', 'weekday.99', 'month.13', 'sort.unused']),
    ['unused.example', 'weekday.99', 'month.13', 'sort.unused']);
});
