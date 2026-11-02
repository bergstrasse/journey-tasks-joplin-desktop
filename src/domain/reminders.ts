import type { CalendarContext, ReminderPolicy, Task } from '../shared/models';

export function reminderInstant(schedule: Task['schedule'], policy: ReminderPolicy, calendar: CalendarContext, override?: number): number {
  if (override !== undefined) return Math.max(0, override);
  if (!policy.enabled || schedule.kind === 'none') return 0;
  if (schedule.kind === 'timed') return schedule.instant;
  return calendar.zone.resolve(schedule.date, policy.allDayTime || '09:00', schedule.zone).instant;
}

