/** Persist only these JSON values, never Temporal/library instances. */
export const SCHEMA_VERSION = 1;
export type DateOnly = string;
export type TimeOnly = string;
export type Priority = 'high' | 'medium' | 'low' | 'none';
export type TaskMode = 'continuous' | 'archive';
export type ViewKind = 'today' | 'tomorrow' | 'sevenDays' | 'inbox' | 'all' | 'day' | 'week' | 'month' | 'year';
export interface NativeTag { id: string; title: string }
export type Schedule =
  | { kind: 'none' }
  | { kind: 'allDay'; date: DateOnly; zone: string }
  | { kind: 'timed'; date: DateOnly; time: TimeOnly; zone: string; instant: number; offsetMinutes?: number; adjustment?: string };
export type DatedSchedule = Exclude<Schedule, { kind: 'none' }>;
export interface DateRange { start: DateOnly; end: DateOnly }
export interface LunarDate { year: number; month: number; day: number; leap: boolean }
export interface ResolvedTime { instant: number; date: DateOnly; time: TimeOnly; offsetMinutes: number; adjustment?: string }
export interface TimeZonePort {
  resolve(date: DateOnly, time: TimeOnly, zone: string): ResolvedTime;
  localDate(instant: number, zone: string): DateOnly;
  localTime(instant: number, zone: string): TimeOnly;
  isValidZone(zone: string): boolean;
  startOfDay(date: DateOnly, zone: string): number;
}
export interface LunarCalendarPort {
  fromSolar(date: DateOnly): LunarDate;
  toSolar(date: LunarDate): DateOnly;
  monthDays(year: number, month: number, leap: boolean): number;
  monthsOfYear(year: number): { month: number; leap: boolean; days: number }[];
}
export interface CalendarContext { zone: TimeZonePort; lunar: LunarCalendarPort }
export type EndCondition = { kind: 'never' } | { kind: 'until'; date: DateOnly } | { kind: 'count'; count: number };
export interface RecurrenceRule {
  calendar: 'gregorian' | 'lunar';
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  basis: 'scheduled' | 'completed';
  /** ISO weekdays, Monday=1. Used by weekly and ordinary workday rules. */
  weekdays?: number[];
  monthDay?: number;
  month?: number;
  monthSelector?: 'day' | 'lastDay' | 'nthWeekday' | 'lunarYearEnd';
  nth?: number;
  weekday?: number;
  lunarLeap?: boolean;
  end: EndCondition;
}
export interface ReminderPolicy { enabled: boolean; allDayTime?: TimeOnly }
export interface SeriesDefinition {
  title?: string;
  seriesId: string;
  revisionId: string;
  parentRevisionIds: string[];
  rule: RecurrenceRule;
  anchor: DatedSchedule;
  priority: Priority;
  pinned: boolean;
  modeForNext: TaskMode;
  reminder: ReminderPolicy;
  templateRevisionId?: string;
  sourceNotebookId: string;
  sourceTagIds: string[];
}
export interface Occurrence {
  historyDeleted?: boolean;
  withdrawn?: boolean;
  pinned?: boolean;
  occurrenceId: string;
  seriesId: string;
  predecessorId?: string;
  originatingRevisionId: string;
  originSlotKey: string;
  suppressedSlotKeys: string[];
  scheduled: DatedSchedule;
  deferred?: DatedSchedule;
  resolution: 'open' | 'completed' | 'skipped';
  resolvedAt?: number;
  terminalOpId?: string;
  consumed: boolean;
  carrierNoteId: string;
  carrierGeneration: number;
  mode: TaskMode;
  reminderOverride?: number;
}
export interface TemplateRevision {
  schemaVersion: number;
  templateRevisionId: string;
  seriesId: string;
  parentRevisionId?: string;
  noteId: string;
  title: string;
  body: string;
  resourceIds: string[];
  contentHash: string;
}
export interface NativeFields { is_todo: number; todo_due: number; todo_completed: number }
export interface NativeNote extends NativeFields {
  id: string; parent_id: string; title: string; body: string;
  updated_time: number; created_time?: number; deleted_time?: number;
  is_conflict?: number; user_data?: string; encryption_applied?: number;
}
export interface Task {
  createdAt?: number;
  nativeTitle?: string;
  historical?: boolean;
  taskId: string;
  noteId: string;
  title: string;
  notebookId: string;
  tagIds: string[];
  schedule: Schedule;
  completedAt: number;
  priority: Priority;
  pinned: boolean;
  reminder: ReminderPolicy;
  reminderOverride?: number;
  seriesId?: string;
  occurrenceId?: string;
  resolution?: Occurrence['resolution'];
  managed?: boolean;
}
export interface AdvancePayload {
  predecessorId: string;
  terminalOpId: string;
  next: Occurrence | null;
  ruleRevisionId: string;
  templateRevisionId?: string;
  templateSourceNoteId?: string;
  templateContentHash?: string;
  candidateNoteId?: string;
  omittedFrom?: DateOnly;
  omittedUntil?: DateOnly;
}
export interface ProjectionPayload {
  intentId: string;
  noteId: string;
  occurrenceId: string;
  carrierGeneration: number;
  sourceOpId: string;
  phase: string;
  before: NativeFields;
  after: NativeFields;
  readbackHash?: string;
}
export interface OpBase<K extends string, P> {
  schemaVersion: number;
  opId: string;
  deviceId: string;
  deviceSeq: number;
  seriesId: string;
  parents: string[];
  recordedAt: number;
  kind: K;
  payload: P;
  payloadHash: string;
}
export type OccurrenceAction =
  | { action: 'deleteHistory'; occurrenceId: string }
  | { action: 'complete' | 'skip'; occurrenceId: string; at: number }
  | { action: 'reopen'; occurrenceId: string; targetOpId: string }
  | { action: 'defer'; occurrenceId: string; schedule: DatedSchedule }
  | { action: 'snooze'; occurrenceId: string; until: number | null };
export type DomainOperation =
  | OpBase<'CreateSeries', { definition: SeriesDefinition; first: Occurrence }>
  | OpBase<'ReviseSeries', { definition: SeriesDefinition; current?: { occurrenceId: string; schedule: DatedSchedule; slotKey: string; clearDeferred?: boolean } }>
  | OpBase<'ResolveSeriesConflict', { definition: SeriesDefinition; resolvedRevisionIds: string[]; current?: { occurrenceId: string; schedule: DatedSchedule; slotKey: string; clearDeferred?: boolean } }>
  | OpBase<'ActOccurrence', OccurrenceAction>
  | OpBase<'SetTaskFields', { occurrenceId?: string; title?: string; priority?: Priority; pinned?: boolean }>
  | OpBase<'Advance', AdvancePayload>
  | OpBase<'RewindAdvance', { targetOpIds: string[]; occurrenceId: string; targetOpId: string }>
  | OpBase<'BindCarrier', { occurrenceId: string; noteId: string; creationHash: string; generation: number }>
  | OpBase<'ProjectionIntent' | 'ProjectionReceipt', ProjectionPayload>
  | OpBase<'StopOrDelete', { scope: 'stop' | 'current' | 'series' | 'history'; occurrenceId?: string }>
  | OpBase<'Restore', { targetOpIds: string[] }>
  | OpBase<'ObserveNative', { noteId: string; occurrenceId: string; beforeHash: string; afterHash: string }>;
export type OperationKind = DomainOperation['kind'];
export interface DomainConflict {
  code: 'duplicate-operation' | 'missing-parent' | 'cycle' | 'invalid-operation' | 'series-definition' | 'advance' | 'binding' | 'deleted' | 'missing-template';
  message: string;
  opIds: string[];
}
export interface SeriesSnapshot {
  titleOperationId?: string;
  seriesId: string;
  definition?: SeriesDefinition;
  revisionHeads: string[];
  operationHeads: string[];
  occurrences: Record<string, Occurrence>;
  activeOccurrenceId?: string;
  consumedCount: number;
  advances: Record<string, AdvancePayload>;
  bindings: Record<string, string[]>;
  projections: ProjectionPayload[];
  conflicts: DomainConflict[];
  status: 'active' | 'ended' | 'pausedConflict' | 'waiting';
  operations: DomainOperation[];
}
export interface Candidate {
  candidateSlotKey: string;
  schedule: DatedSchedule;
  ruleRevisionId: string;
  provisional: boolean;
  assumption?: string;
}
export interface EnumerationResult { candidates: Candidate[]; truncated: boolean; nextCursor?: DateOnly; error?: string }
export interface PreviewItem {
  createdAt?: number;
  nativeTitle?: string;
  resolution?: Occurrence['resolution'];
  historical?: boolean;
  /** Effective native reminder time; zero or absent means no reminder. */
  reminderAt?: number;
  id: string;
  date: DateOnly;
  title: string;
  kind: 'actual' | 'projected';
  priority: Priority;
  pinned: boolean;
  schedule: Schedule;
  overdue: boolean;
  completed: boolean;
  seriesId?: string;
  occurrenceId?: string;
  noteId?: string;
  notebookId?: string;
  tagIds?: string[];
  candidateSlotKey?: string;
  assumption?: string;
}
export interface ViewSnapshot {
  view: ViewKind;
  range: DateRange;
  items: PreviewItem[];
  warnings: string[];
  truncated: boolean;
}
