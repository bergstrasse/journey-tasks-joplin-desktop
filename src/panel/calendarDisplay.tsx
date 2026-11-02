import { createContext, useContext } from 'react';
import { solarToLunar } from '../adapters/calendar/lunarAdapter';
import type { Translator } from '../i18n';

export type DisplayCalendar = 'solar' | 'lunar';
export const CalendarDisplayContext = createContext<DisplayCalendar>('solar');
export const useDisplayCalendar = () => useContext(CalendarDisplayContext);
export function lunarText(date: string, t: Translator): string {
  try {
    const d = solarToLunar(date);
    return t('calendar.lunarLabel', { leap: d.leap ? t('calendar.leapPrefix') : '',
      month: t('calendar.lunarMonths').split(',')[d.month - 1]!, day: t('calendar.lunarDays').split(',')[d.day - 1]! });
  } catch { return ''; }
}
export function displayDate(date: string, calendar: DisplayCalendar, t: Translator, solar: string): string {
  if (calendar !== 'lunar') return solar;
  try {
    const d = solarToLunar(date);
    return d.day === 1 ? lunarText(date, t) : t('calendar.lunarDays').split(',')[d.day - 1]!;
  } catch { return solar; }
}
