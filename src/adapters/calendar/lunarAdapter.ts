import type { DateOnly, LunarCalendarPort, LunarDate } from '../../shared/models';
import { addDays, dateString, epochDay, parseDate } from '../../domain/dates';

let chineseFormatter: Intl.DateTimeFormat | undefined;
const yearCache = new Map<number, { month: number; leap: boolean; days: number; start: DateOnly }[]>();
function rawFromSolar(date: DateOnly): LunarDate {
  parseDate(date);
  chineseFormatter ??= new Intl.DateTimeFormat('en-US-u-ca-chinese-nu-latn', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' });
  if (chineseFormatter.resolvedOptions().calendar !== 'chinese') throw new Error('Chinese calendar is not supported by this runtime');
  const parts: Record<string, string> = {};
  for (const part of chineseFormatter.formatToParts(new Date(epochDay(date) * 86_400_000 + 4 * 3_600_000))) parts[part.type] = part.value;
  const year = Number(parts.relatedYear), month = Number.parseInt(parts.month ?? '', 10), day = Number(parts.day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 30) throw new Error('Unsupported Chinese calendar format parts');
  return { year, month, day, leap: /bis/i.test(parts.month ?? '') };
}
function checkSolarRange(date: DateOnly): void { if (date < '1901-01-01' || date > '2099-12-31') throw new Error('Lunar conversion supports solar dates 1901–2099'); }
export function solarToLunar(date: DateOnly): LunarDate { parseDate(date); checkSolarRange(date); return rawFromSolar(date); }
function months(year: number): { month: number; leap: boolean; days: number; start: DateOnly }[] {
  if (!Number.isInteger(year) || year < 1900 || year > 2099) throw new Error('Lunar year is outside supported range');
  const cached = yearCache.get(year); if (cached) return cached;
  const result: { month: number; leap: boolean; days: number; start: DateOnly }[] = [];
  // At most fourteen months; dates, not device-local Date objects, determine the table.
  const end = dateString(year + 1, 3, 1);
  for (let date = dateString(year, 1, 1); date < end; date = addDays(date, 1)) {
    const lunar = rawFromSolar(date);
    if (lunar.year !== year) continue;
    let row = result.find(item => item.month === lunar.month && item.leap === lunar.leap);
    if (!row) { row = { month: lunar.month, leap: lunar.leap, days: lunar.day, start: addDays(date, 1 - lunar.day) }; result.push(row); }
    row.days = Math.max(row.days, lunar.day);
  }
  if (result.length < 12 || result.some(row => row.days !== 29 && row.days !== 30)) throw new Error(`Incomplete lunar year table: ${year}`);
  yearCache.set(year, result); return result;
}
function lunarMonthsOfYear(year: number): { month: number; leap: boolean; days: number }[] { return months(year).map(({ month, leap, days }) => ({ month, leap, days })); }
function lunarMonthDays(year: number, month: number, leap = false): number {
  const item = months(year).find(row => row.month === month && row.leap === leap);
  if (!item) throw new Error(`Lunar month does not exist: ${year}/${leap ? 'leap ' : ''}${month}`);
  return item.days;
}
export function lunarToSolar(date: LunarDate): DateOnly {
  if (!Number.isInteger(date.day) || date.day < 1) throw new Error('Invalid lunar day');
  const month = months(date.year).find(row => row.month === date.month && row.leap === date.leap);
  if (!month || date.day > month.days) throw new Error('Invalid lunar date');
  const solar = addDays(month.start, date.day - 1); checkSolarRange(solar); return solar;
}
export const lunarAdapter: LunarCalendarPort = { fromSolar: solarToLunar, toSolar: lunarToSolar, monthDays: lunarMonthDays, monthsOfYear: lunarMonthsOfYear };
