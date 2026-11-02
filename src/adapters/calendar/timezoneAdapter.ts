import type { DateOnly, ResolvedTime, TimeOnly, TimeZonePort } from '../../shared/models';
import { dateString, epochDay, parseDate, validateTime } from '../../domain/dates';

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-GB-u-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(zone, value);
  }
  return value;
}
function parts(instant: number, zone: string): { date: DateOnly; time: TimeOnly; wall: number; offsetMinutes: number } {
  if (!Number.isFinite(instant)) throw new Error('Invalid instant');
  const values: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(new Date(instant))) values[part.type] = part.value;
  const date = dateString(Number(values.year), Number(values.month), Number(values.day));
  const time = `${values.hour}:${values.minute}:${values.second}`;
  const wall = epochDay(date) * 86_400_000 + Number(values.hour) * 3_600_000 + Number(values.minute) * 60_000 + Number(values.second) * 1000;
  return { date, time, wall, offsetMinutes: (wall - Math.floor(instant / 1000) * 1000) / 60_000 };
}
/** Explicit compatible policy: earlier fold, forward by the gap; never silently skip an entire date. */
export function resolveZonedTime(date: DateOnly, time: TimeOnly, zone: string): ResolvedTime {
  parseDate(date); validateTime(time); formatter(zone);
  const t = time.split(':').map(Number), desired = epochDay(date) * 86_400_000 + t[0]! * 3_600_000 + t[1]! * 60_000 + (t[2] ?? 0) * 1000;
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) offsets.add(parts(desired + hours * 3_600_000, zone).offsetMinutes);
  const candidates = [...offsets].map(offset => desired - offset * 60_000).map(instant => ({ instant, ...parts(instant, zone) }));
  const exact = candidates.filter(candidate => candidate.wall === desired).sort((a, b) => a.instant - b.instant);
  if (exact.length) {
    const first = exact[0]!;
    return { instant: first.instant, date: first.date, time: first.time, offsetMinutes: first.offsetMinutes, ...(exact.length > 1 ? { adjustment: 'fold-earlier' } : {}) };
  }
  const forward = candidates.filter(candidate => candidate.wall > desired).sort((a, b) => a.wall - b.wall)[0];
  if (!forward || forward.wall - desired >= 86_400_000 || forward.date !== date) throw new Error(`Local date/time cannot be resolved without changing date: ${date} ${time} ${zone}`);
  return { instant: forward.instant, date: forward.date, time: forward.time, offsetMinutes: forward.offsetMinutes, adjustment: 'gap-forward' };
}
function isValidZone(zone: string): boolean { try { formatter(zone); return true; } catch { return false; } }
export const timezoneAdapter: TimeZonePort = {
  resolve: resolveZonedTime,
  localDate: (instant, zone) => parts(instant, zone).date,
  localTime: (instant, zone) => parts(instant, zone).time,
  isValidZone,
  startOfDay: (date, zone) => resolveZonedTime(date, '00:00', zone).instant,
};
