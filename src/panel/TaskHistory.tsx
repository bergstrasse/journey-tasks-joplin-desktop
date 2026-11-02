import type { TaskLogEntry } from '../services/taskHistory';
import type { Occurrence, RecurrenceRule, Schedule } from '../shared/models';
import { effectiveSchedule } from '../domain/dates';
import { useTranslation } from '../i18n/react';

interface TaskHistoryProps {
  entries: TaskLogEntry[];
  title: string;
  occurrences?: Occurrence[];
  folders: { id: string; title: string }[];
  busy?: boolean;
  onComplete?: (occurrence: Occurrence) => void;
  onReopen?: (occurrence: Occurrence) => void;
  onOpen?: (occurrence: Occurrence) => void;
}
export function TaskHistory({ entries, title, folders, occurrences = [], busy, onComplete, onReopen, onOpen }: TaskHistoryProps) {
  const { t, locale, formatTime } = useTranslation();
  const timestamp = (at: number) => `${new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at)} ${formatTime(at)}`;
  const value = (field: string, raw: unknown): string => {
    if (raw === undefined || raw === null) return t('history.unknown');
    if (field === 'schedule' || field === 'anchor') {
      const schedule = raw as Schedule;
      return schedule.kind === 'none' ? t('quickAdd.noDate') : `${schedule.date}${schedule.kind === 'timed' ? ' ' + schedule.time : ''}`;
    }
    if (field === 'rule') {
      const rule = raw as RecurrenceRule;
      return `${t(`rule.${rule.calendar === 'lunar' ? 'lunar' : 'gregorian'}`)} · ${t('rule.summary', { calendar: '', interval: rule.interval, unit: t(`rule.unit.${rule.frequency}.${rule.interval === 1 ? 'one' : 'other'}`) })}` +
        (rule.weekdays?.length ? ` · ${rule.weekdays.map(day => t(`weekday.${day}`)).join(' / ')}` : '') +
        (rule.month ? ` · ${t('rule.month')}: ${rule.month}` : '') +
        (rule.monthSelector ? ` · ${t(`rule.${rule.monthSelector}`)}` : '') +
        (rule.monthDay ? ` · ${t('field.day')}: ${rule.monthDay}` : '') +
        (rule.nth ? ` · ${t('rule.nth')}: ${rule.nth}` : '') +
        (rule.weekday ? ` · ${t(`weekday.${rule.weekday}`)}` : '') +
        (rule.lunarLeap ? ` · ${t('rule.leapDate')}` : '') +
        ` · ${t(rule.basis === 'completed' ? 'rule.completed' : 'rule.scheduled')}` +
        ` · ${rule.end.kind === 'never' ? t('rule.never') : rule.end.kind === 'count' ? `${t('rule.count')}: ${rule.end.count}` : rule.end.date}`;
    }
    if (field === 'reminderOverride') return typeof raw === 'number' && raw > 1 ? timestamp(raw) : t('priority.none');
    if (field === 'notebookId' || field === 'sourceNotebookId') return folders.find(folder => folder.id === raw)?.title || t('history.unknown');
    if (field === 'modeForNext') return t(raw === 'archive' ? 'field.archive' : 'field.continuous');
    if (field === 'priority') return t(`priority.${raw}`);
    if (field === 'pinned') return t(raw ? 'menu.pin' : 'menu.unpin');
    if (field === 'reminder') {
      const reminder = raw as { enabled: boolean; allDayTime?: string };
      return reminder.enabled ? `${t('history.field.reminder')}${reminder.allDayTime ? ' · ' + reminder.allDayTime : ''}` : t('priority.none');
    }
    return String(raw);
  };
  const visibleOccurrences = new Map(occurrences.filter(o => !o.withdrawn).map(o => [o.occurrenceId, o]));
  const rows = entries.filter(entry => entry.kind !== 'scheduled' || (visibleOccurrences.get(entry.occurrenceId || '')?.resolution === 'open' &&
    !entries.some(other => other.occurrenceId === entry.occurrenceId && !['scheduled', 'seriesCreated'].includes(other.kind))));
  // Retain controls when a legacy occurrence has no corresponding journal event.
  for (const occurrence of visibleOccurrences.values()) {
    if (rows.some(row => row.occurrenceId === occurrence.occurrenceId)) continue;
    rows.push({ id: `occurrence:${occurrence.occurrenceId}`, occurrenceId: occurrence.occurrenceId,
      kind: occurrence.resolution === 'open' ? 'scheduled' : occurrence.resolution === 'completed' ? 'completed' : 'skipped',
      at: occurrence.resolvedAt || 0, changes: [] });
  }
  rows.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  const latest = new Map<string, string>();
  for (const row of rows) if (row.occurrenceId && !latest.has(row.occurrenceId)) latest.set(row.occurrenceId, row.id);
  return <section className="task-history" aria-label={t('actions.history')}><h3>{title}</h3>
    {!rows.length && <p>{t('history.empty')}</p>}
    <ol className="history-timeline">{rows.map(entry => {
      const occurrence = visibleOccurrences.get(entry.occurrenceId || '');
      const showControls = occurrence && latest.get(occurrence.occurrenceId) === entry.id;
      return <li key={entry.id}>
        <div className="history-event"><strong>{t(`history.${entry.kind}`)}</strong>{entry.at > 1 && <time dateTime={new Date(entry.at).toISOString()}>{timestamp(entry.at)}</time>}</div>
        {occurrence && (showControls || !['seriesCreated', 'scheduled'].includes(entry.kind)) && <div className="history-detail">
          <span className="history-time">{t('history.field.schedule')}: {effectiveSchedule(occurrence).date}</span>
          {showControls && <div className="history-actions">
            {occurrence.resolution === 'open' && occurrence.consumed && onComplete && <button disabled={busy} onClick={() => onComplete(occurrence)}>{t('actions.completeTask', { title: '' })}</button>}
            {occurrence.resolution !== 'open' && onReopen && <button disabled={busy} onClick={() => onReopen(occurrence)}>{t('actions.undo')}</button>}
            {onOpen && <button disabled={busy} onClick={() => onOpen(occurrence)}>{t('actions.openNote')}</button>}
          </div>}
        </div>}
        {entry.kind !== 'seriesCreated' && entry.changes.map((change, i) => <div className="history-change" key={i}><span>{t(`history.field.${change.field}`)}: </span>{value(change.field, change.before)} <span aria-hidden="true">→</span> {value(change.field, change.after)}</div>)}
      </li>;
    })}</ol></section>;
}
