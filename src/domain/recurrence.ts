import type { CalendarContext, Candidate, DateOnly, DateRange, EnumerationResult, LunarDate, RecurrenceRule, SeriesDefinition } from '../shared/models';
import { addDays, dateString, daysInMonth, differenceInDays, epochDay, isoWeekday, parseDate, scheduleForDate, scheduleInstant, validateSchedule } from './dates';
import { candidateSlotKey } from './identity';

export function validateRule(rule: RecurrenceRule): string[] {
  const errors: string[] = [];
  if (!['gregorian', 'lunar'].includes(rule.calendar)) errors.push('Unknown recurrence calendar');
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(rule.frequency)) errors.push('Unknown recurrence frequency');
  if (!['scheduled', 'completed'].includes(rule.basis)) errors.push('Unknown recurrence basis');
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 1000) errors.push('Interval must be an integer from 1 to 1000');
  if (rule.weekdays && (!rule.weekdays.length || rule.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7))) errors.push('Invalid weekdays');
  if (rule.monthDay !== undefined && (!Number.isInteger(rule.monthDay) || rule.monthDay < 1 || rule.monthDay > (rule.calendar === 'lunar' ? 30 : 31))) errors.push('Invalid month day');
  if (rule.month !== undefined && (!Number.isInteger(rule.month) || rule.month < 1 || rule.month > 12)) errors.push('Invalid month');
  if (rule.calendar === 'lunar' && !['monthly', 'yearly'].includes(rule.frequency)) errors.push('Lunar recurrence supports months and years');
  if (rule.monthSelector === 'nthWeekday' && (!Number.isInteger(rule.nth) || rule.nth! < 1 || rule.nth! > 5 || !Number.isInteger(rule.weekday) || rule.weekday! < 1 || rule.weekday! > 7)) errors.push('Invalid nth weekday');
  if (rule.calendar === 'lunar' && rule.monthSelector === 'nthWeekday') errors.push('Nth weekday is a Gregorian selector');
  if (rule.end?.kind === 'count' && (!Number.isInteger(rule.end.count) || rule.end.count < 1)) errors.push('Invalid repeat count');
  if (rule.end?.kind === 'until') { try { parseDate(rule.end.date); } catch { errors.push('Invalid end date'); } }
  if (!rule.end || !['never', 'count', 'until'].includes(rule.end.kind)) errors.push('Invalid recurrence ending');
  return errors;
}
function monthDay(rule: RecurrenceRule, year: number, month: number, anchorDay: number): number {
  const last = daysInMonth(year, month);
  if (rule.monthSelector === 'lastDay') return last;
  if (rule.monthSelector === 'nthWeekday') {
    const day = 1 + ((rule.weekday! - isoWeekday(dateString(year, month, 1)) + 7) % 7) + (rule.nth! - 1) * 7;
    return Math.min(day, last);
  }
  return Math.min(rule.monthDay ?? anchorDay, last);
}
function lunarMonthDistance(anchor: LunarDate, current: LunarDate, context: CalendarContext): number {
  if (anchor.year === current.year) {
    const list = context.lunar.monthsOfYear(anchor.year);
    return list.findIndex(row => row.month === current.month && row.leap === current.leap) - list.findIndex(row => row.month === anchor.month && row.leap === anchor.leap);
  }
  let distance = 0;
  for (let year = anchor.year; year <= current.year; year++) {
    const list = context.lunar.monthsOfYear(year);
    const begin = year === anchor.year ? list.findIndex(row => row.month === anchor.month && row.leap === anchor.leap) : 0;
    const end = year === current.year ? list.findIndex(row => row.month === current.month && row.leap === current.leap) : list.length;
    distance += end - begin;
  }
  return distance;
}
function eligibleDate(definition: SeriesDefinition, date: DateOnly, context: CalendarContext): boolean {
  const { rule, anchor } = definition;
  if (date < anchor.date) return false;
  if (rule.end.kind === 'until' && date > rule.end.date) return false;
  if (rule.calendar === 'lunar') {
    const a = context.lunar.fromSolar(anchor.date), p = context.lunar.fromSolar(date);
    if (rule.monthSelector === 'lunarYearEnd') {
      const list = context.lunar.monthsOfYear(p.year), last = list[list.length - 1]!;
      return p.month === last.month && p.leap === last.leap && p.day === last.days && (p.year - a.year) % rule.interval === 0;
    }
    if (rule.frequency === 'monthly') {
      if (rule.interval !== 1 && lunarMonthDistance(a, p, context) % rule.interval !== 0) return false;
    } else {
      if ((p.year - a.year) % rule.interval !== 0 || p.month !== (rule.month ?? a.month)) return false;
      const wantsLeap = rule.lunarLeap ?? a.leap;
      const hasLeap = context.lunar.monthsOfYear(p.year).some(row => row.month === p.month && row.leap);
      if (p.leap !== (wantsLeap && hasLeap)) return false;
    }
    const last = context.lunar.monthDays(p.year, p.month, p.leap);
    return p.day === (rule.monthSelector === 'lastDay' ? last : Math.min(rule.monthDay ?? a.day, last));
  }
  const a = parseDate(anchor.date), p = parseDate(date);
  if (rule.frequency === 'daily') {
    return differenceInDays(date, anchor.date) % rule.interval === 0 && (!rule.weekdays || rule.weekdays.includes(isoWeekday(date)));
  }
  if (rule.frequency === 'weekly') {
    const startWeek = epochDay(anchor.date) - isoWeekday(anchor.date) + 1;
    const week = Math.floor((epochDay(date) - startWeek) / 7);
    return week % rule.interval === 0 && (rule.weekdays ?? [isoWeekday(anchor.date)]).includes(isoWeekday(date));
  }
  if (rule.frequency === 'monthly') {
    return ((p.year - a.year) * 12 + p.month - a.month) % rule.interval === 0 && p.day === monthDay(rule, p.year, p.month, a.day);
  }
  return (p.year - a.year) % rule.interval === 0 && p.month === (rule.month ?? a.month) && p.day === monthDay(rule, p.year, p.month, a.day);
}
export interface EnumerationOptions { consumedCount?: number; limit?: number; after?: number; maxDays?: number; cancelled?: () => boolean }
export function enumerateWindow(definition: SeriesDefinition, range: DateRange, context: CalendarContext, options: EnumerationOptions = {}): EnumerationResult {
  const errors = [...validateRule(definition.rule), ...validateSchedule(definition.anchor, context)];
  if (errors.length) return { candidates: [], truncated: false, error: errors.join('; ') };
  const candidates: Candidate[] = [];
  try {
    parseDate(range.start); parseDate(range.end);
    const limit = Math.max(1, Math.min(options.limit ?? 500, 20_000));
    const remaining = definition.rule.end.kind === 'count' ? Math.max(0, definition.rule.end.count - (options.consumedCount ?? 0)) : Infinity;
    if (!remaining) return { candidates, truncated: false };
    let day = range.start > definition.anchor.date ? range.start : definition.anchor.date;
    const maxDays = options.maxDays ?? 4000;
    let scanned = 0;
    for (; day < range.end; day = addDays(day, 1)) {
      if (options.cancelled?.() || scanned++ >= maxDays) return { candidates, truncated: true, nextCursor: day };
      if (definition.rule.end.kind === 'until' && day > definition.rule.end.date) break;
      if (definition.rule.calendar === 'lunar' && (day < '1901-01-01' || day > '2099-12-31')) return { candidates, truncated: false, error: 'Lunar date is outside 1901–2099' };
      if (!eligibleDate(definition, day, context)) continue;
      const schedule = scheduleForDate(definition.anchor, day, context);
      if (options.after !== undefined && scheduleInstant(schedule, context.zone) <= options.after) continue;
      if (candidates.length >= remaining) break;
      if (candidates.length >= limit) return { candidates, truncated: true, nextCursor: day };
      candidates.push({ candidateSlotKey: candidateSlotKey(definition, schedule), schedule, ruleRevisionId: definition.revisionId, provisional: true, ...(definition.rule.basis === 'completed' ? { assumption: '按如期完成估算' } : {}) });
    }
    return { candidates, truncated: false };
  } catch (error) { return { candidates, truncated: false, error: error instanceof Error ? error.message : String(error) }; }
}
export function nextCandidate(definition: SeriesDefinition, afterInstant: number, context: CalendarContext, consumedCount = 0): Candidate | null {
  if (!Number.isFinite(afterInstant)) throw new Error('Invalid processing instant');
  const errors = [...validateRule(definition.rule), ...validateSchedule(definition.anchor, context)];
  if (errors.length) throw new Error(errors.join('; '));
  if (definition.rule.end.kind === 'count' && consumedCount >= definition.rule.end.count) return null;
  let start = context.zone.localDate(afterInstant, definition.anchor.zone);
  if (start < definition.anchor.date) start = definition.anchor.date;
  const unitDays = { daily: 1, weekly: 7, monthly: 32, yearly: 366 }[definition.rule.frequency];
  // Search begins near the query, never by replaying every date from the original anchor.
  let horizon = Math.min(unitDays * definition.rule.interval + 400, 366_400);
  if (definition.rule.end.kind === 'until') horizon = Math.min(horizon, Math.max(0, differenceInDays(addDays(definition.rule.end.date, 1), start)));
  if (!horizon) return null;
  const result = enumerateWindow(definition, { start, end: addDays(start, horizon) }, context, { consumedCount, after: afterInstant, limit: 1, maxDays: horizon });
  if (result.candidates[0]) return result.candidates[0];
  if (result.error) throw new Error(result.error);
  if (result.truncated) throw new Error('Recurrence search budget exhausted');
  return null;
}
