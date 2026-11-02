import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceNativeFields } from '../../src/services/reminderService';
import { reminderInstant } from '../../src/domain/reminders';
import { createCalendarContext } from '../../src/adapters/calendar';
import type { Occurrence } from '../../src/shared/models';
import { definition } from '../fixtures/series';

const calendar = createCalendarContext();
const def = definition({ reminder: { enabled: true } });
const occurrence: Occurrence = {
  occurrenceId: 'root', seriesId: def.seriesId, originatingRevisionId: def.revisionId,
  originSlotKey: 'slot', suppressedSlotKeys: [], scheduled: def.anchor, resolution: 'open',
  consumed: false, carrierNoteId: 'note', carrierGeneration: 0, mode: 'continuous',
};

test('all-day reminder is opt-in and defaults to task-zone 09:00, never midnight', () => {
  assert.equal(reminderInstant(def.anchor, { enabled: false }, calendar), 0);
  assert.equal(reminderInstant(def.anchor, { enabled: true }, calendar), Date.parse('2024-01-31T01:00:00Z'));
});

test('snooze overrides a single native reminder and does not mutate schedule/anchor', () => {
  const before = JSON.stringify(occurrence);
  const later = Date.parse('2024-02-01T03:00:00Z');
  assert.equal(occurrenceNativeFields({ ...occurrence, reminderOverride: later }, def, calendar, true).todo_due, later);
  assert.equal(JSON.stringify(occurrence), before);
});

test('completed, skipped and historical open cycles do not keep an active native alarm', () => {
  const at = Date.parse('2024-01-31T05:00:00Z');
  assert.deepEqual(occurrenceNativeFields({ ...occurrence, resolution: 'completed', resolvedAt: at }, def, calendar, false),
    { is_todo: 1, todo_completed: at, todo_due: 0 });
  assert.deepEqual(occurrenceNativeFields({ ...occurrence, resolution: 'skipped' }, def, calendar, false),
    { is_todo: 1, todo_completed: 1, todo_due: 0 });
  assert.equal(occurrenceNativeFields({ ...occurrence, consumed: true }, def, calendar, false).todo_due, 0);
});
