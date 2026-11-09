import type { DomainOperation, NativeNote } from '../shared/models';
import { reduceSeries } from '../domain/series';
import { HistoryScheduleMap } from './historyScheduleMap';
import { stableStringify } from '../domain/identity';
import { reduceSingle, type JournalOperation, type SingleOperation } from '../adapters/joplin/repositories';

export interface TaskLogChange { field: string; before?: unknown; after?: unknown }
export interface TaskLogEntry { id: string; at: number; kind: string; occurrenceId?: string; changes: TaskLogChange[] }
const fields = ['title', 'schedule', 'rule', 'anchor', 'modeForNext', 'priority', 'pinned', 'notebookId', 'sourceNotebookId', 'reminder', 'reminderOverride'];
function changes(before: any, after: any): TaskLogChange[] {
  return fields.filter(field => after && Object.prototype.hasOwnProperty.call(after, field) &&
    stableStringify(before?.[field] ?? null) !== stableStringify(after[field] ?? null))
    .map(field => ({ field, before: before?.[field], after: after[field] }));
}
/** Use causal parents rather than wall-clock ordering to reconstruct the old values. */
export function taskHistory(operations: JournalOperation[], note?: NativeNote): TaskLogEntry[] {
  const byId = new Map(operations.map(op => [op.opId, op]));
  const ancestors = (op: JournalOperation): JournalOperation[] => {
    const seen = new Set<string>();
    const stack = [...op.parents];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id); stack.push(...(byId.get(id)?.parents || []));
    }
    return [...seen].flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  };
  // Persistent per-parent state keeps branches isolated without replaying a chain.
  type State = { definition?: any; single?: any; schedules: HistoryScheduleMap<any> };
  const states = new Map<string, State>();
  const visiting = new Set<string>();
  const ordered: JournalOperation[] = [];
  const beforeStates = new Map<string, State>();
  const visit = (root: JournalOperation) => {
    const stack: { op: JournalOperation; exit: boolean }[] = [{ op: root, exit: false }];
    while (stack.length) {
      const { op, exit } = stack.pop()!;
      if (states.has(op.opId)) continue;
      if (!exit) {
        if (visiting.has(op.opId)) continue;
        visiting.add(op.opId);
        stack.push({ op, exit: true });
        for (let i = op.parents.length - 1; i >= 0; i--) {
          const parent = byId.get(op.parents[i]!);
          if (parent && !states.has(parent.opId)) stack.push({ op: parent, exit: false });
        }
        continue;
      }
      let before: State = op.parents.length ? states.get(op.parents[0]!) || { schedules: new HistoryScheduleMap() } : { schedules: new HistoryScheduleMap() };
      if (op.parents.length > 1) {
        const prior = ancestors(op);
        const series = reduceSeries(prior.filter(row => !row.kind.startsWith('Single')) as DomainOperation[]);
        let single;
        try { single = reduceSingle(prior.filter(row => row.kind.startsWith('Single')) as SingleOperation[]); } catch { /* Incomplete sync. */ }
        before = { definition: series.definition, single, schedules: Object.values(series.occurrences).reduce((map, row) => map.set(row.occurrenceId, row.deferred ?? row.scheduled), new HistoryScheduleMap<any>()) };
      }
      beforeStates.set(op.opId, before);
      const state: State = { ...before, schedules: before.schedules };
      const p = op.payload;
      if (op.kind === 'SingleCreate') state.single = { ...p.task };
      if (op.kind === 'SinglePatch' && state.single) {
        state.single = { ...state.single, ...p.patch };
        if (state.single.completedAt) state.single.pinned = false;
        if (p.clearReminderOverride) delete state.single.reminderOverride;
      }
      if (op.kind === 'SingleDelete' && state.single) state.single = { ...state.single, managed: false };
      if (['CreateSeries', 'ReviseSeries', 'ResolveSeriesConflict'].includes(op.kind)) state.definition = p.definition;
      if (op.kind === 'SetTaskFields') state.definition = { ...state.definition, ...p };
      const occurrence = op.kind === 'CreateSeries' ? p.first : op.kind === 'Advance' ? p.next : undefined;
      const current = p.current;
      const id = occurrence?.occurrenceId || current?.occurrenceId || (op.kind === 'ActOccurrence' && p.action === 'defer' ? p.occurrenceId : undefined);
      if (id) {
        state.schedules = before.schedules.set(id, occurrence?.scheduled ?? current?.schedule ?? p.schedule);
      }
      states.set(op.opId, state); visiting.delete(op.opId); ordered.push(op);
    }
  };
  for (const op of byId.values()) visit(op);
  const entries: TaskLogEntry[] = [];
  for (const op of ordered) {
    const prior = beforeStates.get(op.opId)!;
    const entry: TaskLogEntry = { id: op.opId, at: op.recordedAt, kind: '', changes: [] };
    if (op.kind === 'SingleCreate') {
      // Adoption time is not the original note creation time.
      if (op.payload.task?.completedAt > 1) entries.push({ id: `${op.opId}:completed`, at: op.payload.task.completedAt, kind: op.payload.task.resolution === 'skipped' ? 'skipped' : 'completed', changes: [] });
      continue;
    } else if (op.kind === 'SinglePatch') {
      const before = prior.single;
      const patch = op.payload.patch;
      entry.changes = changes(before, patch);
      if (patch.completedAt !== undefined && patch.completedAt !== before?.completedAt) {
        entry.kind = patch.completedAt ? (patch.resolution === 'skipped' ? 'skipped' : 'completed') : 'reopened';
        entry.changes = entry.changes.filter(change => change.field !== 'reminderOverride');
        if (patch.completedAt) entry.at = patch.completedAt;
      } else if (entry.changes.length) entry.kind = op.payload.patch.reminderOverride ? 'snoozed' : 'modified';
    } else if (op.kind === 'CreateSeries') {
      entry.kind = 'seriesCreated'; entry.occurrenceId = op.payload.first.occurrenceId;
    } else if (op.kind === 'Advance' && op.payload.next) {
      entry.kind = 'scheduled'; entry.occurrenceId = op.payload.next.occurrenceId;
    } else if (op.kind === 'ReviseSeries' || op.kind === 'ResolveSeriesConflict') {
      const before = prior.definition;
      entry.kind = 'modified'; entry.changes = changes(before, op.payload.definition);
      if (op.payload.current) {
        const schedule = prior.schedules.get(op.payload.current.occurrenceId);
        entry.changes.push(...changes({ schedule }, { schedule: op.payload.current.schedule }));
      }
    } else if (op.kind === 'ActOccurrence') {
      entry.occurrenceId = op.payload.occurrenceId;
      const action = op.payload;
      entry.kind = ({ complete: 'completed', skip: 'skipped', reopen: 'reopened', defer: 'modified', snooze: 'snoozed', deleteHistory: 'deleted' })[action.action];
      if (action.action === 'complete' || action.action === 'skip') entry.at = action.at;
      if (action.action === 'defer') {
        const before = prior.schedules.get(action.occurrenceId);
        entry.changes = [{ field: 'schedule', before, after: action.schedule }];
      }
    } else if (op.kind === 'SetTaskFields') {
      const before = prior.definition;
      entry.kind = 'modified'; entry.changes = changes(before, op.payload);
    } else if (op.kind === 'StopOrDelete' || op.kind === 'SingleDelete') entry.kind = 'stopped';
    else if (op.kind === 'Restore') entry.kind = 'restored';
    if (entry.kind) entries.push(entry);
  }
  if (note?.created_time) entries.push({ id: `created:${note.id}`, at: note.created_time, kind: 'created', changes: [] });
  // Unmanaged/legacy tasks can still expose their native completion timestamp.
  if (note?.todo_completed && note.todo_completed > 1 && !entries.some(entry => ['completed', 'skipped'].includes(entry.kind) && entry.at === note.todo_completed))
    entries.push({ id: `completed:${note.id}`, at: note.todo_completed, kind: 'completed', changes: [] });
  // Conversion imports the single task's last resolution into its first occurrence.
  // Prefer that occurrence entry over the earlier unscoped copy of the same event.
  const occurrenceResolutions = new Set(entries.filter(entry => entry.occurrenceId && ['completed', 'skipped'].includes(entry.kind))
    .map(entry => JSON.stringify([entry.kind, entry.at])));
  const resolutions = new Set<string>();
  return entries.filter(entry => {
    if (!['completed', 'skipped'].includes(entry.kind)) return true;
    if (!entry.occurrenceId && occurrenceResolutions.has(JSON.stringify([entry.kind, entry.at]))) return false;
    const key = JSON.stringify([entry.kind, entry.at, entry.occurrenceId]);
    if (resolutions.has(key)) return false;
    resolutions.add(key); return true;
  }).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}
