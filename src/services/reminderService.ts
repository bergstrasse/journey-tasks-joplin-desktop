import { reminderInstant } from '../domain/reminders';
import type { CalendarContext, DatedSchedule, NativeFields, Occurrence, SeriesDefinition, Task } from '../shared/models';

function effectiveSchedule(occurrence: Occurrence): DatedSchedule { return occurrence.deferred ?? occurrence.scheduled; }


export function occurrenceNativeFields(occurrence: Occurrence, definition: SeriesDefinition, calendar: CalendarContext,
  active: boolean): NativeFields {
  if (occurrence.withdrawn) return { is_todo: 1, todo_completed: 0, todo_due: 0 };
  if (occurrence.resolution === 'skipped') return { is_todo: 1, todo_completed: occurrence.resolvedAt || 1, todo_due: 0 };
  if (occurrence.resolution === 'completed') return { is_todo: 1, todo_completed: occurrence.resolvedAt || 1, todo_due: 0 };
  return {
    is_todo: 1, todo_completed: 0,
    todo_due: active && !occurrence.consumed ? reminderInstant(effectiveSchedule(occurrence), definition.reminder, calendar, occurrence.reminderOverride) : 0,
  };
}

export function singleNativeFields(task: Task, calendar: CalendarContext): NativeFields {
  return { is_todo: 1, todo_completed: task.completedAt || 0,
    todo_due: task.completedAt ? 0 : reminderInstant(task.schedule, task.reminder, calendar, task.reminderOverride) };
}
