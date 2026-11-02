import test from 'node:test';
import assert from 'node:assert/strict';
import { solarToLunar, lunarToSolar } from '../../src/adapters/calendar/lunarAdapter';

// A full-range internal invariant, not an independent astronomical oracle.
// Independent HKO examples are tested separately in calendar.test.ts.
test('every supported Gregorian date round-trips through the runtime Chinese calendar (1901–2099)', () => {
  const end = Date.parse('2100-01-01T00:00:00Z');
  let total = 0;
  for (let stamp = Date.parse('1901-01-01T00:00:00Z'); stamp < end; stamp += 86400000) {
    const date = new Date(stamp).toISOString().slice(0, 10);
    const lunar = solarToLunar(date);
    assert.equal(lunarToSolar(lunar), date);
    total++;
  }
  assert.equal(total, 72684);
});
