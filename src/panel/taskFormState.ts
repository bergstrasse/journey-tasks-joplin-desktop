import type { RecurrenceRule } from '../shared/models';

function dateParts(date: string): { month: number; day: number } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const month = Number(date.slice(5, 7)), day = Number(date.slice(8));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { month, day } : undefined;
}
/** Daily rules have no month fields, especially when an imported native task has no date. */
export function defaultTaskRule(_date = '', _fallbackDate = ''): RecurrenceRule {
  return { calendar: 'gregorian', frequency: 'daily', interval: 1, basis: 'scheduled', end: { kind: 'never' } };
}
export function scheduleDateRuleDefaults(rule: RecurrenceRule, oldDate: string, newDate: string): RecurrenceRule {
  const next = { ...rule };
  if (rule.frequency === 'daily' || rule.frequency === 'weekly') {
    delete next.month; delete next.monthDay; delete next.monthSelector;
    delete next.nth; delete next.weekday; delete next.lunarLeap;
    return next;
  }
  if (rule.calendar !== 'gregorian') return next;
  const current = dateParts(newDate), before = dateParts(oldDate);
  if (!current) return next;
  if (rule.frequency === 'monthly') delete next.month;
  else if (next.month === undefined || (before && next.month === before.month)) next.month = current.month;
  if (!next.monthSelector || next.monthSelector === 'day') {
    if (next.monthDay === undefined || (before && next.monthDay === before.day)) next.monthDay = current.day;
  }
  return next;
}
/** Serialize only fields that are active in the chosen frequency and selector. */
export function normalizeTaskRule(rule: RecurrenceRule, date: string): RecurrenceRule {
  const next = scheduleDateRuleDefaults(rule, date, date);
  if (!next.weekdays?.length) delete next.weekdays;
  if (next.frequency === 'monthly' || next.frequency === 'yearly') {
    delete next.weekdays;
    if (next.frequency === 'monthly') delete next.month;
    if (next.monthSelector === 'lastDay' || next.monthSelector === 'lunarYearEnd') {
      delete next.monthDay; delete next.nth; delete next.weekday;
      if (next.monthSelector === 'lunarYearEnd') { delete next.month; delete next.lunarLeap; }
    } else if (next.monthSelector === 'nthWeekday') delete next.monthDay;
    else { delete next.nth; delete next.weekday; }
  }
  if (next.calendar === 'gregorian') delete next.lunarLeap;
  return next;
}
