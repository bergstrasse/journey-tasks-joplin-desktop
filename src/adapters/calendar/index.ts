import type { CalendarContext } from '../../shared/models';
import { lunarAdapter } from './lunarAdapter';
import { timezoneAdapter } from './timezoneAdapter';
export function createCalendarContext(): CalendarContext { return { zone: timezoneAdapter, lunar: lunarAdapter }; }
