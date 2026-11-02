import english from '../i18n/locales/en.json';
import { reminderInstant } from './reminders';
import type { CalendarContext, Candidate, DateOnly, Occurrence, PreviewItem, SeriesSnapshot, Task, ViewKind, ViewSnapshot } from '../shared/models';
import { addDays, containsDate, displayDate, effectiveSchedule, isOverdue, viewRange } from './dates';
import { enumerateWindow } from './recurrence';
import { nextPeriodBasis } from './transitions';

function mergeActualAndProjected(actual: readonly PreviewItem[], projected: readonly PreviewItem[]): PreviewItem[] {
  const actualKeys = new Set(actual.map(item => item.candidateSlotKey).filter(Boolean));
  const values = new Map<string, PreviewItem>(), actualNotes = new Set<string>();
  for (const item of [...actual, ...projected.filter(item => !actualKeys.has(item.candidateSlotKey))]) {
    if (values.has(item.id) || (item.kind === 'actual' && item.noteId && actualNotes.has(item.occurrenceId || item.noteId))) continue;
    values.set(item.id, item);
    if (item.kind === 'actual' && item.noteId) actualNotes.add(item.occurrenceId || item.noteId);
  }
  return [...values.values()].sort((a,b) => a.date.localeCompare(b.date) || Number(b.pinned) - Number(a.pinned) || (a.schedule.kind === 'timed' && b.schedule.kind === 'timed' ? a.schedule.instant - b.schedule.instant : Number(a.schedule.kind === 'timed') - Number(b.schedule.kind === 'timed')) || a.id.localeCompare(b.id));
}
export interface ProjectViewOptions { defaultTitle?: string; view: ViewKind; selectedDate: DateOnly; deviceZone: string; now: number; limit?: number; includeCompleted?: boolean; showCompleted?: boolean; notebookId?: string; notebookIds?: string[]; search?: string; tagId?: string }
export function projectView(tasks: readonly Task[], series: readonly SeriesSnapshot[], options: ProjectViewOptions, calendar: CalendarContext): ViewSnapshot {
  const range = viewRange(options.view, options.selectedDate), actual: PreviewItem[] = [], projected: PreviewItem[] = [], warnings: string[] = [];
  const notebooks = new Set(options.notebookIds ?? []);
  const keywords = (options.search ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (notebookId: string | undefined, title: string, nativeTitle?: string) =>
    (!notebooks.size || notebooks.has(notebookId ?? '')) && keywords.every(word =>
      title.toLocaleLowerCase().includes(word) || (nativeTitle ?? '').toLocaleLowerCase().includes(word));
  const limit = Math.max(1, options.limit ?? 20_000);
  const index = new Map(series.map(snapshot => [snapshot.seriesId, snapshot]));
  let truncated = false;
  for (const task of tasks) {
    if ((options.notebookId && task.notebookId !== options.notebookId) || (options.tagId && !task.tagIds.includes(options.tagId))) continue;
    if (!matches(task.notebookId, task.title, task.nativeTitle)) continue;
    const snapshot = task.seriesId ? index.get(task.seriesId) : undefined;
    const occurrence = task.occurrenceId ? snapshot?.occurrences[task.occurrenceId] : undefined;
    const schedule = occurrence ? effectiveSchedule(occurrence) : task.schedule;
    if (schedule.kind === 'none') {
      if ((options.view === 'inbox' || options.view === 'all') && (!task.completedAt || (options.includeCompleted ?? options.showCompleted))) actual.push({createdAt: task.createdAt, nativeTitle: task.nativeTitle, id: `actual:${task.occurrenceId ?? task.taskId}`, date: '', resolution: task.resolution, title: task.title, kind: 'actual', priority: task.priority, pinned: task.pinned && !task.completedAt, schedule, reminderAt: reminderInstant(schedule, task.reminder, calendar, task.reminderOverride), overdue: false, completed: task.completedAt > 0, noteId: task.noteId, notebookId: task.notebookId, tagIds: [...task.tagIds], ...(task.seriesId ? {seriesId: task.seriesId} : {})});
      continue;
    }
    if (options.view === 'inbox') continue;
    const completed = occurrence ? occurrence.resolution !== 'open' : task.completedAt > 0;
    if (completed && !(options.includeCompleted ?? options.showCompleted)) continue;
    try {
      const date = displayDate(schedule, options.deviceZone, calendar.zone), overdue = isOverdue(schedule, options.now, calendar.zone);
      const listView = ['today', 'tomorrow', 'sevenDays', 'all'].includes(options.view);
      const alwaysVisible = listView && !completed && overdue;
      if (!alwaysVisible && (options.view !== 'all' && !containsDate(range, date))) continue;
      actual.push({ createdAt: task.createdAt, nativeTitle: task.nativeTitle, resolution: task.resolution, historical: task.historical, id: `actual:${task.occurrenceId ?? task.taskId}`, date, title: task.title, kind: 'actual', priority: task.priority, pinned: task.pinned && !task.completedAt, schedule, reminderAt: reminderInstant(schedule, task.reminder, calendar, task.reminderOverride), overdue: overdue && !completed, completed, noteId: task.noteId, notebookId: task.notebookId, tagIds: [...task.tagIds], ...(task.seriesId ? { seriesId: task.seriesId } : {}), ...(task.occurrenceId ? { occurrenceId: task.occurrenceId } : {}), ...(occurrence ? { candidateSlotKey: occurrence.originSlotKey } : {}) });
    } catch (error) { warnings.push('backend.INVALID_SCHEDULE'); }
  }
  // Lists show actual current tasks; both calendar views and seven-day planning may show read-only future slots.
  if (['sevenDays', 'day', 'week', 'month', 'year'].includes(options.view)) for (const snapshot of series) {
    if (!snapshot.definition) { warnings.push('diagnostic.missingDefinition'); continue; }
    if (snapshot.status === 'ended') continue;
    if (snapshot.status !== 'active') { warnings.push(...snapshot.conflicts.map(conflict => `diagnostic.${conflict.code}`)); continue; }
    const current = snapshot.activeOccurrenceId ? snapshot.occurrences[snapshot.activeOccurrenceId] : undefined;
    if (!current) continue;
    const task = tasks.find(row => row.seriesId === snapshot.seriesId && row.occurrenceId === current.occurrenceId) ?? tasks.find(row => row.seriesId === snapshot.seriesId);
    const notebookId = task?.notebookId ?? snapshot.definition.sourceNotebookId, tagIds = task?.tagIds ?? snapshot.definition.sourceTagIds;
    if ((options.notebookId && notebookId !== options.notebookId) || (options.tagId && !tagIds.includes(options.tagId))) continue;
    if (!matches(notebookId, snapshot.definition.title || task?.title || options.defaultTitle || english['series.defaultTitle'], task?.nativeTitle)) continue;
    const suppressed = new Set(Object.values(snapshot.occurrences).filter(occurrence => !occurrence.withdrawn).flatMap(occurrence => [occurrence.originSlotKey, ...occurrence.suppressedSlotKeys]));
    const basis = nextPeriodBasis(snapshot.definition, current.scheduled, options.now, calendar);
    const after = basis.after;
    // Date grids belong to the viewing zone, while recurrence rules belong to the task zone.
    const queryRange = snapshot.definition.anchor.kind === 'timed' ? {
      start: calendar.zone.localDate(calendar.zone.startOfDay(range.start, options.deviceZone), snapshot.definition.anchor.zone),
      end: addDays(calendar.zone.localDate(calendar.zone.startOfDay(range.end, options.deviceZone) - 1, snapshot.definition.anchor.zone), 1),
    } : range;
    const forecastDefinition = basis.definition;
    const result = enumerateWindow(forecastDefinition, queryRange, calendar, { limit: Math.min(500, limit), consumedCount: snapshot.consumedCount + 1, after });
    truncated ||= result.truncated;
    if (result.error) warnings.push('diagnostic.futureUnavailable');
    for (const candidate of result.candidates) {
      if (suppressed.has(candidate.candidateSlotKey)) continue;
      if (!containsDate(range, displayDate(candidate.schedule, options.deviceZone, calendar.zone))) continue;
      if (actual.length + projected.length >= limit) { truncated = true; break; }
      projected.push({...projectCandidate(candidate, snapshot, current, snapshot.definition.title || task?.title || options.defaultTitle || english['series.defaultTitle'], options.deviceZone, calendar), notebookId, tagIds: [...tagIds], createdAt: task?.createdAt, nativeTitle: task?.nativeTitle});
    }
  }
  return { view: options.view, range, items: mergeActualAndProjected(actual, projected), warnings: [...new Set(warnings)], truncated };
}
function projectCandidate(candidate: Candidate, snapshot: SeriesSnapshot, _current: Occurrence, title: string, deviceZone: string, calendar: CalendarContext): PreviewItem {
  return { id: `projected:${candidate.candidateSlotKey}`, date: displayDate(candidate.schedule, deviceZone, calendar.zone), title, kind: 'projected', priority: snapshot.definition!.priority, pinned: false, schedule: candidate.schedule, overdue: false, completed: false, seriesId: snapshot.seriesId, candidateSlotKey: candidate.candidateSlotKey, ...(candidate.assumption ? { assumption: candidate.assumption } : {}) };
}
