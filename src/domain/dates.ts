import type { CalendarContext, DateOnly, DateRange, DatedSchedule, Occurrence, Schedule, TimeZonePort, ViewKind } from '../shared/models';

const DAY = 86_400_000;
export function parseDate(date: DateOnly): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new Error(`Invalid date: ${date}`);
  return { year, month, day };
}
export function dateString(year: number, month: number, day: number): DateOnly {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  parseDate(value); return value;
}
export function daysInMonth(year: number, month: number): number {
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}
export function epochDay(date: DateOnly): number {
  const p = parseDate(date), d = new Date(0);
  d.setUTCFullYear(p.year, p.month - 1, p.day); d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / DAY);
}
function fromEpochDay(day: number): DateOnly {
  if (!Number.isInteger(day)) throw new Error('Day must be an integer');
  const d = new Date(day * DAY);
  return dateString(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
export function addDays(date: DateOnly, count: number): DateOnly { return fromEpochDay(epochDay(date) + count); }
export function differenceInDays(a: DateOnly, b: DateOnly): number { return epochDay(a) - epochDay(b); }
export function isoWeekday(date: DateOnly): number { return ((epochDay(date) + 3) % 7 + 7) % 7 + 1; }
function addMonths(date: DateOnly, count: number): DateOnly {
  const p = parseDate(date), n = p.year * 12 + p.month - 1 + count;
  const year = Math.floor(n / 12), month = ((n % 12) + 12) % 12 + 1;
  return dateString(year, month, Math.min(p.day, daysInMonth(year, month)));
}
export function validateTime(time: string): void {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? '0') > 59) throw new Error(`Invalid time: ${time}`);
}
export function validateSchedule(schedule: Schedule, calendar?: CalendarContext): string[] {
  try {
    if (schedule.kind === 'none') return [];
    parseDate(schedule.date);
    if (!schedule.zone || (calendar && !calendar.zone.isValidZone(schedule.zone))) throw new Error(`Invalid time zone: ${schedule.zone}`);
    if (schedule.kind === 'timed') {
      validateTime(schedule.time);
      if (!Number.isFinite(schedule.instant)) throw new Error('Invalid instant');
    }
    return [];
  } catch (error) { return [error instanceof Error ? error.message : String(error)]; }
}
export function scheduleForDate(anchor: DatedSchedule, date: DateOnly, calendar: CalendarContext): DatedSchedule {
  parseDate(date);
  if (anchor.kind === 'allDay') return { kind: 'allDay', date, zone: anchor.zone };
  const result = calendar.zone.resolve(date, anchor.time, anchor.zone);
  return { kind: 'timed', date, time: anchor.time, zone: anchor.zone, instant: result.instant, offsetMinutes: result.offsetMinutes, ...(result.adjustment ? { adjustment: result.adjustment } : {}) };
}
export function scheduleInstant(schedule: DatedSchedule, zone: TimeZonePort): number {
  return schedule.kind === 'timed' ? schedule.instant : zone.startOfDay(schedule.date, schedule.zone);
}
export function effectiveSchedule(occurrence: Occurrence): DatedSchedule { return occurrence.deferred ?? occurrence.scheduled; }
export function displayDate(schedule: DatedSchedule, deviceZone: string, zone: TimeZonePort): DateOnly {
  return schedule.kind === 'allDay' ? schedule.date : zone.localDate(schedule.instant, deviceZone);
}
export function isOverdue(schedule: Schedule, now: number, zone: TimeZonePort): boolean {
  if (schedule.kind === 'none') return false;
  return schedule.kind === 'timed' ? now >= schedule.instant : now >= zone.startOfDay(addDays(schedule.date, 1), schedule.zone);
}
export function viewRange(view: ViewKind, selected: DateOnly): DateRange {
  const p = parseDate(selected);
  if (view === 'today' || view === 'day' || view === 'inbox' || view === 'all') return { start: selected, end: addDays(selected, 1) };
  if (view === 'tomorrow') return { start: addDays(selected, 1), end: addDays(selected, 2) };
  if (view === 'sevenDays') return { start: addDays(selected, 1), end: addDays(selected, 8) };
  if (view === 'week') { const start = addDays(selected, -(isoWeekday(selected) % 7)); return {start, end: addDays(start, 7)}; }
  if (view === 'year') return { start: dateString(p.year, 1, 1), end: dateString(p.year + 1, 1, 1) };
  const first = dateString(p.year, p.month, 1), next = addMonths(first, 1);
  return { start: addDays(first, -(isoWeekday(first) % 7)), end: addDays(next, (7 - isoWeekday(next) % 7) % 7) };
}
export function containsDate(range: DateRange, date: DateOnly): boolean { return date >= range.start && date < range.end; }
