import { taskHistory } from './taskHistory';
import { initializeArchiveBody, insertTemplateBlock, parseArchiveBody } from '../domain/bodyTemplate';
import type { CalendarContext, DatedSchedule, DomainOperation, NativeFields, Occurrence, Priority,
  ProjectionPayload, Schedule, SeriesDefinition, SeriesSnapshot, Task } from '../shared/models';
import { candidateSlotKey, occurrenceKey, stableHash, stableStringify } from '../domain/identity';
import { effectiveSchedule, validateTime, validateSchedule } from '../domain/dates';
import { projectView } from '../domain/projections';
import { validateRule } from '../domain/recurrence';
import { reduceSeries } from '../domain/series';
import { planAdvance, ruleRevisionSchedule, snoozeCurrent, undoOccurrence } from '../domain/transitions';
import { createCalendarContext } from '../adapters/calendar';
import { JoplinApiLike, JoplinGateway, NativeNote, NativeTag, StorageError } from '../adapters/joplin/gateway';
import { REQUEST_RESULT_TTL_MS, LocalIntentStore, type LocalIntent } from '../adapters/joplin/localIntentStore';
import { CarrierMeta, ControlMeta, DEFAULT_PLUGIN_ID, JournalOperation, JournalRepository, operationHeads,
  reduceSingle, scopeKey, SingleOperation } from '../adapters/joplin/repositories';
import { TemplateRepository } from '../adapters/joplin/templateRepository';
import { createTranslator, resolveLanguage } from '../i18n';
import { readNamespace } from '../adapters/joplin/userDataStore';
import { nativeFields, ProjectionExecutor, sameNative } from './projectionExecutor';
import { occurrenceNativeFields, singleNativeFields } from './reminderService';
import { CleanupService } from './cleanupService';
import type { ActionResult, ApplicationCommand, ApplicationDiagnostic, ApplicationSnapshot, SeriesSummary, TaskInput, ViewQuery } from './applicationTypes';

interface SeriesContext { noteId: string; meta: ControlMeta; operations: DomainOperation[]; snapshot: SeriesSnapshot; warning?: string }
interface SingleContext { noteId: string; meta: ControlMeta; operations: SingleOperation[]; task: Task }
interface WaitingCarrier { note: NativeNote; meta: CarrierMeta }
interface PendingCompletion {
  schemaVersion: 3;
  pendingId: string;
  seriesId: string;
  anchorNoteId: string;
  noteId: string;
  occurrenceId: string;
  at: number;
  action?: 'complete' | 'skip';
  before: NativeFields;
  operationIdentity: { opId: string; deviceId: string; deviceSeq: number };
}
export interface ApplicationOptions {
  calendar?: CalendarContext;
  now?: () => number;
  randomId?: () => string;
  pluginId?: string;
  onChange?: () => void;
  onNotice?: (message: string) => void;
}
const priorities: Priority[] = ['high', 'medium', 'low', 'none'];
const randomId = (): string => {
  const values = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(values);
  else for (let i = 0; i < values.length; i++) values[i] = Math.floor(Math.random() * 256);
  return Array.from(values, value => value.toString(16).padStart(2, '0')).join('');
};
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Commands, persistence, recovery and native projections share this one local write queue. */
export class TaskApplication {
  readonly gateway: JoplinGateway;
  readonly journal: JournalRepository;
  readonly local: LocalIntentStore;
  readonly templates: TemplateRepository;
  private readonly calendar: CalendarContext;
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly projector: ProjectionExecutor;
  private readonly onChange?: () => void;
  private readonly cleanup: CleanupService;
  private readonly notice?: (message: string) => void;
  private series = new Map<string, SeriesContext>();
  private singles = new Map<string, SingleContext>();
  private native = new Map<string, NativeNote>();
  private waitingCarriers = new Map<string, WaitingCarrier[]>();
  private pending = new Map<string, { note: NativeNote; evidence: PendingCompletion }>();
  private diagnostics: ApplicationDiagnostic[] = [];
  private version = 0;
  private loading = true;
  private readOnlyNotes = new Set<string>();
  private systemLocale = 'en-US';
  private initialized = false;
  private dataReady = false;
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private requestResults = new Map<string, { result: ActionResult; at: number }>();

  constructor(api: JoplinApiLike, options: ApplicationOptions = {}) {
    this.notice = options.onNotice;
    this.now = options.now ?? Date.now;
    this.ids = options.randomId ?? randomId;
    this.calendar = options.calendar ?? createCalendarContext();
    this.gateway = new JoplinGateway(api);
    this.local = new LocalIntentStore(api, this.ids, this.now);
    this.journal = new JournalRepository(this.gateway, this.local, options.pluginId ?? DEFAULT_PLUGIN_ID, this.now);
    this.templates = new TemplateRepository(this.journal, this.now);
    this.projector = new ProjectionExecutor(this.gateway);
    this.cleanup = new CleanupService(this.gateway, this.local, options.pluginId ?? DEFAULT_PLUGIN_ID, this.now);
    this.onChange = options.onChange;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.local.initialize();
    // Joplin's API proxy mutates its path on property access. Call through the
    // full path once; probing/caching settings can duplicate the method segment.
    try {
      let locale: unknown;
      try { locale = (await this.gateway.api.settings.globalValues!(['locale']))[0]; }
      catch { locale = await this.gateway.api.settings.globalValue!('locale'); }
      if (typeof locale === 'string' && locale) this.systemLocale = locale;
    } catch { /* Use US English when the host locale is unavailable. */ }
    this.initialized = true;
    await this.serial(async () => {
      for (const intent of await this.local.all()) {
        if (intent.phase === 'request-saved' && intent.result) this.rememberResult(intent.id.slice(8), intent.result as ActionResult, intent.updatedAt);
      }
      await this.refreshInternal(true);
      // Commands that crashed before an acknowledgement retain the original stable
      // creation request. Replaying creation cannot invent a new root identity.
      if (!this.dataReady) { this.loading = false; return; }
      for (const intent of await this.local.all()) {
        const command = intent.command as ApplicationCommand | undefined;
        if (!['request-pending', 'root-create', 'root-created'].includes(intent.phase) || command?.action !== 'createTask') continue;
        try {
          const output = await this.executeCommand(command);
          await this.refreshInternal(true);
          const result: ActionResult = { requestId: command.requestId, status: 'saved', snapshotVersion: this.version, ...output };
          await this.local.put({ id: `request:${command.requestId}`, controlNoteId: '', phase: 'request-saved', result, updatedAt: this.now(), attempts: 0 });
          this.rememberResult(command.requestId, result);
        } catch (error) { this.addDiagnostic('CREATE_COMMAND_RECOVERY', errorMessage(error)); }
      }
      this.loading = false;
    });
  }

  async snapshot(query: ViewQuery = {}): Promise<ApplicationSnapshot> {
    if (!this.initialized) throw new StorageError('NOT_INITIALIZED', '插件尚未初始化。');
    const preferences = await this.local.preferences();
    this.defaultSeriesTitle = createTranslator(resolveLanguage(preferences.language, this.systemLocale || 'en-US'))('series.defaultTitle');
    const now = this.now();
    const deviceZone = query.deviceZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    if (!this.calendar.zone.isValidZone(deviceZone)) throw new StorageError('INVALID_ZONE', '当前设备时区不可用。');
    const view = query.view || (preferences.startupMode === 'restore' ? preferences.lastView : preferences.defaultView);
    const today = this.calendar.zone.localDate(now, deviceZone);
    const selected = ['today', 'tomorrow', 'sevenDays', 'inbox', 'all'].includes(view) ? today : query.date || today;
    const tasks = this.collectTasks(deviceZone).map(task => ({ ...task, tagIds: this.noteTagIds.get(task.noteId) || [] }));
    const selectedNotebooks = query.notebookIds ?? preferences.notebookIds ?? [];
    const notebookIds = new Set(selectedNotebooks);
    // Expand descendants to a fixed point; cycles and unordered folder responses are safe.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const folder of this.nativeFolders) if (folder.parent_id && notebookIds.has(folder.parent_id) && !notebookIds.has(folder.id)) {
        notebookIds.add(folder.id); expanded = true;
      }
    }
    const projected = projectView(tasks, [...this.series.values()].map(context => context.snapshot),
      { view, selectedDate: selected, deviceZone, now, defaultTitle: this.defaultSeriesTitle, showCompleted: query.showCompleted ?? preferences.showCompleted, notebookId: query.notebookId, notebookIds: [...notebookIds], search: query.search, tagId: query.tagId }, this.calendar);
    const { range, items, truncated } = projected;
    const warnings = [...this.diagnostics.map(item => item.message), ...projected.warnings];
    if (truncated) warnings.push('diagnostic.forecastBudget');
    const folders = this.nativeFolders.filter(folder => {
      try { const marker = readNamespace(folder.user_data, this.journal.pluginId).dataFolder; return !!marker?.d || marker?.v !== 1; }
      catch { return true; }
    });
    const taskLogs: NonNullable<ApplicationSnapshot['taskLogs']> = {};
    const singlesByNote = new Map([...this.singles.values()].map(context => [context.noteId, context]));
    const singlesByRoot = new Map<string, SingleOperation[]>();
    for (const single of this.singles.values()) singlesByRoot.set(single.meta.rootNoteId, [...(singlesByRoot.get(single.meta.rootNoteId) || []), ...single.operations]);
    for (const task of tasks) {
      if (task.seriesId) continue;
      const single = singlesByNote.get(task.noteId);
      taskLogs[task.noteId] = taskHistory(single?.operations || [], this.native.get(task.noteId));
    }
    for (const context of this.series.values()) {
      const priorSingles = singlesByRoot.get(context.meta.rootNoteId) || [];
      taskLogs[context.meta.seriesId] = taskHistory([...priorSingles, ...context.operations], this.native.get(context.meta.rootNoteId));
    }
    return { taskLogs, snapshotVersion: this.version, now, deviceZone, systemLocale: this.systemLocale, view, range, items, tasks, series: this.summaries(),
      folders, tags: this.nativeTags, preferences, diagnostics: clone(this.diagnostics), warnings: [...new Set(warnings)], truncated, loading: this.loading };
  }

  async dispatch(command: ApplicationCommand): Promise<ActionResult> {
    if (!this.initialized || this.disposed) throw new StorageError('NOT_INITIALIZED', '插件未运行。');
    if (!command || typeof command.requestId !== 'string' || !command.requestId || command.requestId.length > 200) throw new StorageError('INVALID_REQUEST', '无效请求编号。');
    return this.serial(async () => {
      if (command.action === 'previewCleanup' || command.action === 'executeCleanup') {
        try {
          if (command.action === 'previewCleanup') return { requestId: command.requestId, status: 'saved', snapshotVersion: this.version,
            cleanupPlan: await this.cleanup.preview() };
          const cleanupResult = await this.cleanup.execute(command.token, command.confirmation);
          this.series.clear(); this.singles.clear(); this.native.clear();
          this.waitingCarriers.clear(); this.pending.clear(); this.requestResults.clear(); this.diagnostics = [];
          await this.refreshInternal(true);
          this.onChange?.();
          return { requestId: command.requestId, status: 'saved', snapshotVersion: this.version, cleanupResult };
        } catch (error) {
          try {
            if (await this.local.cleanupPending()) await this.refreshInternal(false);
            else this.version++;
          } catch { this.dataReady = false; }
          this.onChange?.();
          return { requestId: command.requestId, status: 'error', snapshotVersion: this.version,
            code: error instanceof StorageError ? error.code : 'CLEANUP_FAILED', message: errorMessage(error) };
        }
      }
      if (command.action === 'refresh') {
        this.refreshNoteIds = command.noteIds;
        try {
          if (command.checkChanges && this.dataReady) {
            const now = this.now();
            if (this.lastChangeCheck !== undefined && now - this.lastChangeCheck < 5000)
              return { requestId: command.requestId, status: 'saved', snapshotVersion: this.version };
            const versions = await this.gateway.noteVersions();
            const visible = new Set(versions.map(note => note.id));
            const changed = versions.filter(note => {
              const previous = this.scanNotes.get(note.id);
              return !previous || ['updated_time', 'deleted_time', 'encryption_applied', 'is_conflict'].some(key =>
                (note[key as keyof typeof note] || 0) !== (previous[key as keyof NativeNote] || 0));
            }).map(note => note.id);
            for (const id of this.scanNotes.keys()) if (!visible.has(id)) changed.push(id);
            // Folder order/settings and hierarchy can change without any note edit.
            const folders = await this.gateway.folders();
            const foldersChanged = stableStringify(folders) !== stableStringify(this.nativeFolders);
            this.nativeFolders = folders;
            this.lastChangeCheck = now;
            if (!changed.length) {
              if (foldersChanged) { this.version++; this.onChange?.(); }
              return { requestId: command.requestId, status: 'saved', snapshotVersion: this.version };
            }
            this.refreshNoteIds = changed;
          }
          if (command.noteIds?.length && this.dataReady && !this.diagnostics.length) {
            const signature = (note: NativeNote | undefined | null) => note && stableStringify(Object.fromEntries(Object.entries(note).filter(([key]) => !['body', 'type_'].includes(key))));
            const notes = await Promise.all(command.noteIds.map(id => this.gateway.getNote(id, false)));
            const tags = await Promise.all(command.noteIds.map((id, index) => notes[index] && !notes[index]!.deleted_time ? this.gateway.noteTags(id) : Promise.resolve([])));
            if (notes.every((note, index) => signature(note) === signature(this.scanNotes.get(command.noteIds![index]!)) &&
                stableStringify(tags[index]!.sort()) === stableStringify(this.noteTagIds.get(command.noteIds![index]!) || [])))
              return { requestId: command.requestId, status: 'saved', snapshotVersion: this.version };
          }
          await this.refreshInternal(true);
        }
        catch (error) {
          if (command.checkChanges) this.lastChangeCheck = undefined;
          const code = error instanceof StorageError ? error.code : 'COMMAND_FAILED';
          this.addDiagnostic(code, errorMessage(error)); this.version++; this.onChange?.();
          return { requestId: command.requestId, status: 'error', snapshotVersion: this.version, code, message: errorMessage(error) };
        }
        finally { this.refreshNoteIds = undefined; }
        this.onChange?.();
        return { requestId: command.requestId, status: 'saved', snapshotVersion: this.version };
      }
      const cached = this.requestResults.get(command.requestId);
      if (cached && this.now() - cached.at <= REQUEST_RESULT_TTL_MS) return cached.result;
      if (cached) this.requestResults.delete(command.requestId);
      if (command.expectedSnapshotVersion !== undefined && command.expectedSnapshotVersion !== this.version &&
          !['refresh', 'openNote', 'savePreferences'].includes(command.action)) {
        return { requestId: command.requestId, status: 'conflict', snapshotVersion: this.version, code: 'STALE_SNAPSHOT', message: '任务已变化，请刷新后重试。' };
      }
      let result: ActionResult;
      try {
        if (!this.dataReady && !['refresh', 'openNote', 'savePreferences'].includes(command.action)) throw new StorageError('DATA_READ_ONLY', '数据尚未完整读取，已暂停写入。请先刷新成功后重试。');
        await this.local.put({ id: `request:${command.requestId}`, controlNoteId: '', phase: 'request-pending', command: clone(command), updatedAt: this.now(), attempts: 0 });
        const output = await this.executeCommand(command);
        if (!['openNote', 'savePreferences'].includes(command.action)) {
          const ids = new Set<string>();
          if ('noteId' in command && command.noteId) ids.add(command.noteId);
          if (output.noteId) ids.add(output.noteId);
          const seriesId = output.seriesId || ('seriesId' in command ? command.seriesId : undefined);
          if (seriesId) { const context = this.series.get(seriesId); if (context) ids.add(context.noteId); }
          this.refreshNoteIds = ids.size ? this.relatedNoteIds([...ids]) : undefined;
          try { await this.refreshInternal(true); }
          finally { this.refreshNoteIds = undefined; }
        }
        else if (command.action === 'savePreferences') this.version++;
        result = { requestId: command.requestId, status: 'saved', snapshotVersion: this.version, ...output };
      } catch (error) {
        const code = error instanceof StorageError ? error.code : 'COMMAND_FAILED';
        this.addDiagnostic(code, errorMessage(error));
        this.version++;
        result = { requestId: command.requestId, status: /CONFLICT|CHANGED|STALE|MISSING_PARENT/.test(code) ? 'conflict' : 'error',
          snapshotVersion: this.version, code, message: errorMessage(error) };
      }
      try {
        await this.local.put({ id: `request:${command.requestId}`, controlNoteId: '', phase: 'request-saved', result, updatedAt: this.now(), attempts: 0 });
        this.rememberResult(command.requestId, result);
      } catch (error) {
        const code = error instanceof StorageError ? error.code : 'COMMAND_FAILED';
        this.addDiagnostic(code, errorMessage(error));
        result = { requestId: command.requestId, status: 'error', snapshotVersion: this.version, code, message: errorMessage(error) };
      }
      this.onChange?.();
      return result;
    });
  }

  private rememberResult(requestId: string, result: ActionResult, at = this.now()): void {
    this.requestResults.set(requestId, { result, at });
    while (this.requestResults.size > 512) this.requestResults.delete(this.requestResults.keys().next().value!);
  }

  dispose(): void { this.disposed = true; }

  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(action);
    this.tail = next;
    return next;
  }
  private addDiagnostic(code: string, message: string, seriesId?: string, noteId?: string): void {
    if (!this.diagnostics.some(item => item.code === code && item.seriesId === seriesId && item.noteId === noteId && item.message === message))
      this.diagnostics.push({ code, message, seriesId, noteId });
  }

  private defaultSeriesTitle = createTranslator('en-US')('series.defaultTitle');

  private seriesTitle(context: SeriesContext, firstTitle = this.native.get(context.meta.rootNoteId)?.title): string {
    return context.snapshot.titleOperationId
      ? context.snapshot.definition?.title || firstTitle || this.defaultSeriesTitle
      : firstTitle || context.snapshot.definition?.title || this.defaultSeriesTitle;
  }

  private collectTasks(deviceZone: string): Task[] {
    const tasks: Task[] = [];
    const accounted = new Set<string>();
    for (const context of this.singles.values()) {
      accounted.add(context.meta.rootNoteId);
      const note = this.native.get(context.task.noteId);
      if (!note || note.deleted_time || note.encryption_applied || context.task.managed === false || this.findSeries(context.task.noteId)) continue;
      tasks.push({ ...context.task, createdAt: note.created_time || context.task.createdAt, nativeTitle: note.title, title: note.title, notebookId: note.parent_id });
    }
    for (const context of this.series.values()) {
      accounted.add(context.meta.rootNoteId);
      for (const op of context.operations) if (op.kind === 'BindCarrier') accounted.add(op.payload.noteId);
      const snapshot = context.snapshot;
      for (const occurrence of Object.values(snapshot.occurrences)) {
        accounted.add(occurrence.carrierNoteId);
        const note = this.native.get(occurrence.carrierNoteId);
        if (!note || note.deleted_time || note.encryption_applied) continue;
        if (occurrence.withdrawn || (occurrence.historyDeleted && occurrence.consumed && occurrence.occurrenceId !== snapshot.activeOccurrenceId)) continue;
        const definition = snapshot.definition;
        tasks.push({ createdAt: this.native.get(context.meta.rootNoteId)?.created_time, historical: occurrence.consumed && occurrence.occurrenceId !== snapshot.activeOccurrenceId, taskId: occurrence.occurrenceId, nativeTitle: note.title, noteId: note.id, title: this.seriesTitle(context), notebookId: note.parent_id,
          tagIds: definition?.sourceTagIds || [], schedule: effectiveSchedule(occurrence),
          completedAt: occurrence.resolution !== 'open' ? occurrence.resolvedAt || 1 : 0, priority: definition?.priority || 'none',
          pinned: occurrence.pinned || false, reminder: occurrence.occurrenceId === snapshot.activeOccurrenceId ? definition?.reminder || { enabled: false } : { enabled: false }, reminderOverride: occurrence.occurrenceId === snapshot.activeOccurrenceId ? occurrence.reminderOverride : 0,
          seriesId: snapshot.seriesId, occurrenceId: occurrence.occurrenceId, resolution: occurrence.resolution, managed: true });
      }
    }
    for (const carriers of this.waitingCarriers.values()) for (const carrier of carriers) {
      const { note, meta } = carrier;
      if (accounted.has(note.id) || note.deleted_time || note.encryption_applied) continue;
      accounted.add(note.id);
      const source = meta.snapshot;
      const pending = [...this.pending.values()].find(item => item.evidence.noteId === note.id && item.evidence.occurrenceId === meta.occurrenceId);
      if (!note.is_todo && !pending) continue;
      tasks.push({ ...this.importedTask(note, deviceZone), taskId: meta.occurrenceId, seriesId: meta.seriesId,
        occurrenceId: meta.occurrenceId, schedule: source?.schedule || this.importedTask(note, deviceZone).schedule,
        priority: source?.priority || 'none', pinned: !pending && !note.todo_completed && (source?.pinned || false), reminder: source?.reminder || { enabled: false },
        reminderOverride: source?.reminderOverride, completedAt: pending?.evidence.at || note.todo_completed || 0,
        resolution: pending?.evidence.action === 'skip' ? 'skipped' : pending || note.todo_completed ? 'completed' : 'open', managed: true });
    }
    for (const note of this.native.values()) {
      if (!note.is_todo || accounted.has(note.id) || note.deleted_time || note.encryption_applied || note.is_conflict) continue;
      tasks.push(this.importedTask(note, deviceZone));
    }
    return tasks;
  }
  private importedTask(note: NativeNote, zone: string): Task {
    const instant = note.todo_due || 0;
    const schedule: Schedule = instant ? { kind: 'timed', date: this.calendar.zone.localDate(instant, zone),
      time: this.calendar.zone.localTime(instant, zone), zone, instant } : { kind: 'none' };
    return { createdAt: note.created_time, nativeTitle: note.title, taskId: note.id, noteId: note.id, title: note.title, notebookId: note.parent_id, tagIds: [], schedule,
      completedAt: note.todo_completed || 0, priority: 'none', pinned: false, reminder: { enabled: !!instant }, managed: false };
  }
  private summaries(): SeriesSummary[] {
    const summaries: SeriesSummary[] = [...this.series.values()].map(context => ({ seriesId: context.meta.seriesId, controlNoteId: context.noteId,
      title: this.seriesTitle(context), status: context.snapshot.status,
      definition: context.snapshot.definition,
      revisionIds: context.snapshot.revisionHeads,
      revisionChoices: context.snapshot.operations.filter((op): op is Extract<DomainOperation, { kind: 'CreateSeries' | 'ReviseSeries' | 'ResolveSeriesConflict' }> =>
        ['CreateSeries', 'ReviseSeries', 'ResolveSeriesConflict'].includes(op.kind) && context.snapshot.revisionHeads.includes(op.opId)).map(op => op.payload.definition),
      activeOccurrenceId: context.snapshot.activeOccurrenceId, consumedCount: context.snapshot.consumedCount,
      occurrences: Object.values(context.snapshot.occurrences), conflicts: context.snapshot.conflicts, warning: context.warning,
      warningCode: context.warning ? this.diagnostics.find(item => item.seriesId === context.meta.seriesId && item.message === context.warning)?.code || 'SERIES_CONFLICT' : undefined,
      anchorNoteId: context.meta.rootNoteId, pendingCompletion: [...this.pending.values()].some(item => item.evidence.seriesId === context.meta.seriesId) }));
    for (const [seriesId, carriers] of this.waitingCarriers) {
      if (this.series.has(seriesId)) continue;
      const first = carriers[0]!;
      summaries.push({ seriesId, controlNoteId: first.meta.anchorNoteId, anchorNoteId: first.meta.anchorNoteId,
        title: first.note.title, status: 'waiting', revisionIds: [], revisionChoices: [], occurrences: [], conflicts: [], consumedCount: 0,
        activeOccurrenceId: first.meta.occurrenceId, pendingCompletion: [...this.pending.values()].some(item => item.evidence.seriesId === seriesId),
        warningCode: 'ANCHOR_MISSING', warning: '首篇任务缺失或尚未同步。请恢复同一篇任务后重试推进；不会自动创建替代首篇。' });
    }
    return summaries;
  }

  private nativeFolders: Awaited<ReturnType<JoplinGateway['folders']>> = [];
  private nativeTags: NativeTag[] = [];
  private scanNotes = new Map<string, NativeNote>();
  private refreshNoteIds?: string[];
  private lastChangeCheck?: number;
  private stateFingerprint = '';
  private noteTagIds = new Map<string, string[]>();

  private relatedNoteIds(ids: string[]): string[] {
    const related = new Set(ids);
    for (const id of ids) {
      const note = this.scanNotes.get(id);
      if (!note) continue;
      try {
        for (const [key, entry] of Object.entries(readNamespace(note.user_data, this.journal.pluginId))) {
          if (entry.d || (!key.startsWith('v3:scope:') && !key.startsWith('v3:carrier:'))) continue;
          const meta = entry.v as { anchorNoteId?: string; seriesId?: string; ancestorNoteIds?: string[] } | undefined;
          if (!meta || typeof meta !== 'object') continue;
          if (typeof meta.anchorNoteId === 'string') related.add(meta.anchorNoteId);
          if (typeof meta.seriesId === 'string') {
            const context = this.series.get(meta.seriesId);
            if (context) related.add(context.noteId);
            for (const candidate of this.scanNotes.values()) {
              if (candidate.user_data?.includes(JSON.stringify(scopeKey(meta.seriesId)))) related.add(candidate.id);
            }
          }
          if (Array.isArray(meta.ancestorNoteIds)) for (const ancestor of meta.ancestorNoteIds) if (typeof ancestor === 'string') related.add(ancestor);
        }
      } catch { /* Discovery reports malformed metadata and keeps it read-only. */ }
    }
    for (const context of this.series.values()) {
      const carriers = Object.values(context.snapshot.occurrences).map(occurrence => occurrence.carrierNoteId);
      const all = [context.noteId, context.meta.rootNoteId, ...(context.meta.ancestorNoteIds || []), ...carriers];
      if (all.some(id => related.has(id))) for (const id of all) related.add(id);
    }
    for (const carriers of this.waitingCarriers.values()) {
      const all = carriers.flatMap(carrier => [carrier.note.id, carrier.meta.anchorNoteId]);
      if (all.some(id => related.has(id))) for (const id of all) related.add(id);
    }
    return [...related];
  }

  private async loadState(reload = false): Promise<void> {
    const fullScan = !this.refreshNoteIds;
    if (this.refreshNoteIds) {
      const loaded = new Set<string>();
      for (let index = 0; index < this.refreshNoteIds.length; index++) {
        const id: string = this.refreshNoteIds[index]!;
        if (loaded.has(id)) continue;
        loaded.add(id);
        const note = await this.gateway.getNote(id, false);
        if (note) this.scanNotes.set(id, note); else this.scanNotes.delete(id);
        if (!reload) this.noteTagIds.delete(id);
        this.refreshNoteIds = [...new Set([...this.refreshNoteIds, ...this.relatedNoteIds([id])])];
      }
    } else {
      this.scanNotes = new Map((await this.gateway.allNotes()).map(note => [note.id, note]));
      this.nativeTags = await this.gateway.tags();
      this.nativeFolders = await this.gateway.folders();
      this.noteTagIds.clear();
    }
    this.native = new Map([...this.scanNotes].filter(([, note]) => note.is_todo || note.user_data?.includes(JSON.stringify(this.journal.pluginId))));
    if (fullScan) {
      for (const note of this.native.values()) if (note.is_todo && !note.deleted_time && !note.encryption_applied) this.noteTagIds.set(note.id, []);
      for (const tag of this.nativeTags) {
        for (const id of await this.gateway.tagNoteIds(tag.id)) this.noteTagIds.get(id)?.push(tag.id);
      }
    }
    const tagEntries = [...this.native.values()].filter(note => note.is_todo && !note.deleted_time && !note.encryption_applied && !this.noteTagIds.has(note.id));
    for (let offset = 0; offset < tagEntries.length; offset += 8) {
      await Promise.all(tagEntries.slice(offset, offset + 8).map(async note => this.noteTagIds.set(note.id, await this.gateway.noteTags(note.id))));
    }
    for (const ids of this.noteTagIds.values()) ids.sort();
    const affected = this.refreshNoteIds && new Set(this.refreshNoteIds);
    if (affected && !reload) {
      const seriesIds = new Set([...this.series.values(), ...this.singles.values()].filter(context => affected.has(context.noteId)).map(context => context.meta.seriesId));
      for (const [id, carriers] of this.waitingCarriers) if (carriers.some(carrier => affected.has(carrier.note.id) || affected.has(carrier.meta.anchorNoteId))) seriesIds.add(id);
      for (const id of affected) {
        const note = this.scanNotes.get(id);
        if (!note) continue;
        try {
          for (const [key, entry] of Object.entries(readNamespace(note.user_data, this.journal.pluginId))) {
            if (entry.d || (!key.startsWith('v3:scope:') && !key.startsWith('v3:carrier:'))) continue;
            const meta = entry.v as { seriesId?: string } | undefined;
            if (typeof meta?.seriesId === 'string') seriesIds.add(meta.seriesId);
          }
        } catch { /* Discovery below recreates diagnostics for invalid metadata. */ }
      }
      this.diagnostics = this.diagnostics.filter(item => !(item.noteId && affected.has(item.noteId)) && !(item.seriesId && seriesIds.has(item.seriesId)));
    }
    const discovered = await this.journal.discover([...this.native.values()].filter(note => !affected || affected.has(note.id)), true, !!affected);
    if (!affected) {
      this.series.clear(); this.singles.clear(); this.readOnlyNotes.clear(); this.waitingCarriers.clear(); this.pending.clear();
    } else {
      for (const [id, context] of this.series) if (affected.has(context.noteId)) this.series.delete(id);
      for (const [id, context] of this.singles) if (affected.has(context.noteId)) this.singles.delete(id);
      for (const id of affected) this.readOnlyNotes.delete(id);
      for (const [id, carriers] of this.waitingCarriers) if (carriers.some(carrier => affected.has(carrier.note.id))) this.waitingCarriers.delete(id);
      for (const [id, item] of this.pending) if (affected.has(item.note.id)) this.pending.delete(id);
    }
    for (const issue of discovered.issues) { this.readOnlyNotes.add(issue.rootNoteId || issue.noteId); this.addDiagnostic('CONTROL_READ_ONLY', issue.message, issue.seriesId, issue.noteId); }
    const rootBindings = new Map<string, string[]>();
    for (const entry of discovered.controls) {
      try {
        if (entry.meta.role === 'single') {
          const operations = await this.journal.operations<SingleOperation>(entry.note, entry.meta.seriesId);
          const task = reduceSingle(operations);
          if (task) this.singles.set(entry.meta.seriesId, { noteId: entry.note.id, meta: entry.meta, operations, task });
          continue;
        }
        const operations = await this.journal.operations<DomainOperation>(entry.note, entry.meta.seriesId);
        if (!operations.some(operation => operation.kind === 'CreateSeries')) continue;
        const snapshot = reduceSeries(operations);
        if (snapshot.definition && !snapshot.titleOperationId) snapshot.definition.title = entry.note.title;
        this.series.set(entry.meta.seriesId, { noteId: entry.note.id, meta: entry.meta, operations, snapshot });
        rootBindings.set(entry.meta.rootNoteId, [...(rootBindings.get(entry.meta.rootNoteId) || []), entry.meta.seriesId]);
      } catch (error) { this.readOnlyNotes.add(entry.meta.rootNoteId); this.addDiagnostic('CONTROL_READ_ONLY', errorMessage(error), entry.meta.seriesId, entry.note.id); }
    }
    for (const ids of rootBindings.values()) if (ids.length > 1) {
      for (const id of ids) {
        const context = this.series.get(id)!;
        context.snapshot.status = 'pausedConflict';
        context.warning = '同一原生任务被两个重复系列接管，请保留数据并解决冲突。';
        this.addDiagnostic('OVERLAPPING_SERIES', context.warning, id);
      }
    }
    const latestCarriers = new Map<string, WaitingCarrier>();
    for (const carrier of discovered.carriers) {
      const key = `${carrier.meta.seriesId}:${carrier.note.id}`;
      const previous = latestCarriers.get(key);
      if (!previous || (carrier.meta.snapshot?.carrierGeneration || 0) > (previous.meta.snapshot?.carrierGeneration || 0)) latestCarriers.set(key, carrier);
    }
    for (const carrier of latestCarriers.values()) {
      if (!this.series.has(carrier.meta.seriesId)) {
        const consumed = await this.journal.userData.get(carrier.note.id, this.consumedKey(carrier.meta.seriesId, carrier.meta.occurrenceId));
        if (consumed) continue;
        this.waitingCarriers.set(carrier.meta.seriesId, [...(this.waitingCarriers.get(carrier.meta.seriesId) || []), carrier]);
        this.addDiagnostic('ANCHOR_MISSING', '首篇任务缺失或尚未同步。请恢复同一篇任务后重试推进；不会自动创建替代首篇。', carrier.meta.seriesId, carrier.note.id);
      }
    }
    for (const note of this.native.values()) {
      if (affected && !affected.has(note.id)) continue;
      if (note.deleted_time || note.encryption_applied) continue;
      const keys = await this.journal.userData.keys(note);
      if (keys.some(key => key === 'meta' || key.startsWith('op:') || key.startsWith('v2:'))) this.addDiagnostic('LEGACY_DATA_IGNORED',
        '检测到旧版测试数据，当前版本不迁移或重放；可在设置中预览并清理旧版数据。', undefined, note.id);
      for (const key of keys.filter(value => value.startsWith('v3:pending:'))) {
        const evidence = await this.journal.userData.get<PendingCompletion>(note.id, key);
        if (!evidence || evidence.schemaVersion !== 3 || evidence.noteId !== note.id || !evidence.operationIdentity?.opId) {
          this.addDiagnostic('PENDING_INVALID', '当前任务的待推进记录无效，已保留原文并暂停。', undefined, note.id);
          continue;
        }
        if (await this.journal.userData.get(note.id, `v3:pending-imported:${evidence.pendingId}`)) continue;
        this.pending.set(evidence.pendingId, { note, evidence });
        const context = this.series.get(evidence.seriesId);
        if (context) { context.snapshot.status = 'waiting'; context.warning = '当前完成已保存，下一周期尚未生成。恢复首篇任务后，请点击重试推进。'; }
        this.addDiagnostic('ANCHOR_MISSING_PENDING', '当前完成已保存，下一周期尚未生成。恢复首篇任务后，请点击重试推进。', evidence.seriesId, note.id);
      }
    }
  }

  private async refreshInternal(reconcile: boolean): Promise<void> {
    this.dataReady = false;
    if (this.refreshNoteIds) this.refreshNoteIds = this.relatedNoteIds(this.refreshNoteIds);
    let affected = this.refreshNoteIds && new Set(this.refreshNoteIds);
    if (!affected) this.diagnostics = [];
    else this.diagnostics = this.diagnostics.filter(item => item.noteId || item.seriesId);
    if (await this.local.cleanupPending()) {
      this.addDiagnostic('CLEANUP_INCOMPLETE', '清理尚未完成，已暂停自动恢复和写入。请重试清理。');
      await this.loadState(); this.version++; return;
    }
    let replayReady = true;
    try { await this.journal.replayPending(); }
    catch (error) { replayReady = false; this.addDiagnostic('OUTBOX_REPLAY', errorMessage(error)); }
    if (replayReady) await this.recoverCreates();
    this.gateway.changedNoteIds.clear();
    await this.loadState();
    affected = this.refreshNoteIds && new Set(this.refreshNoteIds);
    if (replayReady) {
      for (const intent of await this.local.all()) {
        if (intent.phase !== 'series-move' || !intent.seriesMove) continue;
        const context = this.series.get(intent.seriesMove.seriesId);
        if (!context || !context.operations.some(op => op.opId === intent.sourceOpId)) continue;
        try { await this.finishSeriesMove(context, intent); }
        catch (error) { context.warning = errorMessage(error); this.addDiagnostic('SERIES_MOVE_PENDING', context.warning, context.meta.seriesId); }
      }
    }
    if (reconcile && replayReady) {
      for (const carriers of this.waitingCarriers.values()) for (const carrier of carriers) {
        if (!carrier.note.todo_completed && ![...this.pending.values()].some(item => item.evidence.noteId === carrier.note.id && item.evidence.occurrenceId === carrier.meta.occurrenceId)) continue;
        try { await this.savePendingCompletion(carrier); }
        catch (error) { this.addDiagnostic('PENDING_COMPLETION', errorMessage(error), carrier.meta.seriesId, carrier.note.id); }
      }
      for (const context of [...this.series.values()]) {
        if (affected && !affected.has(context.noteId)) continue;
        try { await this.reconcileSeries(context); }
        catch (error) { context.warning = errorMessage(error); this.addDiagnostic(error instanceof StorageError ? error.code : 'SERIES_RECONCILE', context.warning, context.meta.seriesId); }
      }
      for (const context of [...this.singles.values()]) {
        if (affected && !affected.has(context.noteId)) continue;
        try { await this.reconcileSingle(context); }
        catch (error) { this.addDiagnostic(error instanceof StorageError ? error.code : 'SINGLE_RECONCILE', errorMessage(error), context.meta.seriesId); }
      }
      const runtimeGuards = [...this.series.values()].filter(context => context.warning).map(context => ({ seriesId: context.meta.seriesId, warning: context.warning, status: context.snapshot.status }));
      const changed = [...this.gateway.changedNoteIds];
      if (changed.length) {
        this.refreshNoteIds = this.relatedNoteIds(changed);
        await this.loadState(true);
      }
      for (const guard of runtimeGuards) { const context = this.series.get(guard.seriesId); if (context) { context.warning = guard.warning; context.snapshot.status = guard.status === 'active' ? 'pausedConflict' : guard.status; } }
    }
    this.dataReady = replayReady;
    const fingerprint = stableStringify({ native: [...this.native.values()].map(note => Object.fromEntries(Object.entries(note).filter(([key]) => !['body', 'type_'].includes(key)))),
      series: [...this.series.values()], singles: [...this.singles.values()], diagnostics: this.diagnostics,
      folders: this.nativeFolders, tags: this.nativeTags, noteTags: [...this.noteTagIds].sort(([a], [b]) => a.localeCompare(b)), ready: this.dataReady });
    if (fingerprint !== this.stateFingerprint) { this.version++; this.stateFingerprint = fingerprint; }
    this.refreshNoteIds = undefined;
  }

  private async operation(context: SeriesContext, kind: DomainOperation['kind'],
    payload: DomainOperation['payload'], identity?: { opId: string; deviceId: string; deviceSeq: number }): Promise<DomainOperation> {
    identity ??= await this.local.nextId();
    const operation = { schemaVersion: 1, ...identity, seriesId: context.meta.seriesId, parents: operationHeads(context.operations),
      recordedAt: this.now(), kind, payload, payloadHash: stableHash(payload) } as DomainOperation;
    await this.journal.append(context.noteId, operation, context.meta.seriesId);
    context.operations.push(operation);
    context.snapshot = reduceSeries(context.operations);
    return operation;
  }
  private async singleOperation(context: SingleContext, kind: SingleOperation['kind'], payload: unknown): Promise<SingleOperation> {
    const identity = await this.local.nextId();
    const operation: SingleOperation = { schemaVersion: 1, ...identity, parents: operationHeads(context.operations), recordedAt: this.now(),
      kind, payload, payloadHash: stableHash(payload) };
    await this.journal.append(context.noteId, operation, context.meta.seriesId);
    context.operations.push(operation);
    context.task = reduceSingle(context.operations)!;
    return operation;
  }

  private normalizeSchedule(schedule: Schedule): Schedule {
    const errors = validateSchedule(schedule, this.calendar);
    if (errors.length) throw new StorageError('INVALID_SCHEDULE', errors.join('；'));
    if (schedule.kind !== 'timed') return clone(schedule);
    const resolved = this.calendar.zone.resolve(schedule.date, schedule.time, schedule.zone);
    return { ...schedule, instant: resolved.instant, offsetMinutes: resolved.offsetMinutes,
      ...(resolved.adjustment ? { adjustment: resolved.adjustment } : {}) };
  }
  private validateReminder(policy: import('../shared/models').ReminderPolicy | undefined, schedule: Schedule): void {
    if (!policy) return;
    if (typeof policy.enabled !== 'boolean') throw new StorageError('INVALID_REMINDER', '提醒开关必须是布尔值。');
    if (policy.allDayTime) validateTime(policy.allDayTime);
    if (policy.enabled && schedule.kind === 'none') throw new StorageError('REMINDER_DATE_REQUIRED', '开启提醒前请先设置任务日期。');
  }
  private assertPriority(priority: Priority | undefined): void {
    if (priority !== undefined && !priorities.includes(priority)) throw new StorageError('INVALID_PRIORITY', '无效优先级。');
  }
  private async interfaceLocale(): Promise<string> {
    const preferences = await this.local.preferences();
    return resolveLanguage(preferences.language, this.systemLocale);
  }
  private async prepareArchiveSource(seriesId: string): Promise<void> {
    await this.templates.ensureSource(seriesId);
  }
  private context(seriesId: string, allowConflict = false): SeriesContext {
    const context = this.series.get(seriesId);
    if (!context) throw new StorageError('SERIES_MISSING', '系列正在等待同步或已被删除。');
    if (!allowConflict && (context.warning || context.snapshot.status === 'pausedConflict' || context.snapshot.status === 'waiting'))
      throw new StorageError('SERIES_CONFLICT', context.warning || context.snapshot.conflicts.map(item => item.message).join('；') || '系列暂不可写。');
    return context;
  }
  private requireOccurrence(context: SeriesContext, id?: string): Occurrence {
    const occurrence = context.snapshot.occurrences[id || context.snapshot.activeOccurrenceId || ''];
    if (!occurrence) throw new StorageError('OCCURRENCE_MISSING', '任务周期不可用。');
    return occurrence;
  }
  private occurrenceForNote(context: SeriesContext, noteId: string): Occurrence {
    const occurrence = Object.values(context.snapshot.occurrences)
      .filter(item => item.carrierNoteId === noteId)
      .sort((a, b) => Number(b.occurrenceId === context.snapshot.activeOccurrenceId) - Number(a.occurrenceId === context.snapshot.activeOccurrenceId) || Number(!!a.withdrawn) - Number(!!b.withdrawn) || b.carrierGeneration - a.carrierGeneration)[0];
    if (!occurrence) throw new StorageError('OCCURRENCE_MISSING', '任务周期不可用。');
    return occurrence;
  }
  private findSeries(noteId: string): SeriesContext | undefined {
    return [...this.series.values()].find(context => (Object.values(context.snapshot.occurrences).some(item => item.carrierNoteId === noteId) || context.operations.some(op => op.kind === 'BindCarrier' && op.payload.noteId === noteId)));
  }
  private async requireNative(noteId: string): Promise<NativeNote> {
    const note = await this.gateway.getNote(noteId);
    if (!note || note.deleted_time || note.encryption_applied || note.is_conflict) throw new StorageError('NOTE_UNAVAILABLE', '笔记不存在、尚未解密或处于冲突状态。');
    return note;
  }
  private async adoptSingle(noteId: string): Promise<SingleContext> {
    if (this.readOnlyNotes.has(noteId)) throw new StorageError('READ_ONLY_CONTROL', '此任务的同步记录尚不完整或损坏，已暂停修改，不能重新接管。');
    const found = [...this.singles.values()].find(context => context.task.noteId === noteId);
    if (found) return found;
    if (this.findSeries(noteId)) throw new StorageError('SERIES_TASK', '此任务由重复系列管理。');
    const note = await this.requireNative(noteId);
    if (!note.is_todo) throw new StorageError('NOT_TODO', '只管理原生待办笔记，不会转换普通笔记。');
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const task = { ...this.importedTask(note, zone), managed: true };
    task.tagIds = await this.gateway.noteTags(noteId);
    const seriesId = stableHash(['journey-single', note.id]);
    const meta: ControlMeta = { schemaVersion: 3, role: 'single', seriesId, rootNoteId: note.id };
    this.journal.registerAnchor(seriesId, note.id);
    await this.journal.createControl(meta);
    const context: SingleContext = { noteId: this.journal.controlId(seriesId), meta, operations: [], task };
    await this.singleOperation(context, 'SingleCreate', { task, initialNative: nativeFields(note) });
    this.singles.set(seriesId, context);
    return context;
  }

  private async executeCommand(command: ApplicationCommand): Promise<Partial<ActionResult>> {
    switch (command.action) {
      case 'refresh': return {};
      case 'insertTemplateBlock': {
        const note = await this.requireNative(command.noteId);
        const body = insertTemplateBlock(note.body);
        if (body !== note.body) {
          const fresh = await this.requireNative(note.id);
          if (fresh.body !== note.body) throw new StorageError('TEMPLATE_SOURCE_CHANGED', '模板来源已变化，请刷新后重试；本期执行记录会保留。');
          await this.gateway.patchNote(note.id, { body });
        }
        await this.gateway.openNote(note.id);
        return { noteId: note.id };
      }
      case 'openNote': await this.gateway.openNote(command.noteId); return { noteId: command.noteId };
      case 'savePreferences': await this.local.savePreferences(command.preferences); return {};
      case 'createTask': return this.createTask(command.input, command.requestId);
      case 'changeDate': return this.changeTaskDate(command.noteId, command.schedule);
      case 'abandonTask': return this.abandonTask(command.noteId, command.requestId);
      case 'moveTask': {
        await this.validateNotebook(command.notebookId);
        await this.requireNative(command.noteId);
        await this.gateway.patchNote(command.noteId, { parent_id: command.notebookId });
        return { noteId: command.noteId };
      }
      case 'deleteNativeTask': {
        const series = this.findSeries(command.noteId);
        if (series) {
          const occurrence = command.occurrenceId
            ? this.requireOccurrence(series, command.occurrenceId) : this.occurrenceForNote(series, command.noteId);
          if (occurrence.carrierNoteId !== command.noteId) throw new StorageError('OCCURRENCE_MISSING', '任务周期不可用。');
          const historical = occurrence.consumed && occurrence.occurrenceId !== series.snapshot.activeOccurrenceId;
          if (historical) {
            await this.operation(series, 'ActOccurrence', { action: 'deleteHistory', occurrenceId: occurrence.occurrenceId });
            // Continuous history shares its carrier with other cycles. Keep that note intact,
            // including across mode changes; only remove this history row.
            if (Object.values(series.snapshot.occurrences).some(row => row.occurrenceId !== occurrence.occurrenceId && row.carrierNoteId === command.noteId))
              return { noteId: command.noteId };
          } else await this.operation(series, 'StopOrDelete', { scope: 'stop' });
        }
        else await this.singleOperation(await this.adoptSingle(command.noteId), 'SingleDelete', {});
        for (const intent of await this.local.all()) if (intent.create?.noteId === command.noteId) {
          const creating = intent.command as ApplicationCommand | undefined;
          if (creating?.action === 'createTask') await this.local.remove(`request:${creating.requestId}`);
          // Keep a body-free creation tombstone: a stale request can never authorize recreating a deleted root.
          await this.local.put({ ...intent, phase: intent.create.role === 'root' ? 'root-saved' : 'carrier-saved', create: undefined, command: undefined });
        }
        await this.gateway.deleteNote(command.noteId, false);
        return { noteId: command.noteId };
      }
      case 'editTask': {
        this.assertPriority(command.patch.priority);
        if (command.patch.reminder) {
          const native = await this.requireNative(command.noteId);
          const existing = this.collectTasks(Intl.DateTimeFormat().resolvedOptions().timeZone).find(t => t.noteId === native.id && !t.historical);
          this.validateReminder(command.patch.reminder, command.patch.schedule || existing?.schedule || { kind: 'none' });
        }
        if (command.patch.recurrence) {
          const errors = validateRule(command.patch.recurrence);
          if (errors.length) throw new StorageError('INVALID_RULE', errors.join('；'));
        }
        const series = this.findSeries(command.noteId);
        if (series) {
          this.context(series.meta.seriesId);
          if (command.patch.recurrence) throw new StorageError('SERIES_SCHEDULE', '已有重复任务请使用系列规则编辑。');
          if (command.patch.schedule) throw new StorageError('SERIES_SCHEDULE', '请通过任务菜单修改本期日期，或编辑系列规则。');
          if (command.patch.title !== undefined) {
            if (!command.patch.title.trim()) throw new StorageError('EMPTY_TITLE', '任务标题不能为空。');
            if (command.patch.title !== (series.snapshot.definition?.title || this.native.get(series.meta.rootNoteId)?.title))
              await this.operation(series, 'SetTaskFields', { title: command.patch.title });
          }
          if (command.patch.reminder && stableStringify(command.patch.reminder) !== stableStringify(series.snapshot.definition?.reminder)) {
            const definition = { ...series.snapshot.definition!, reminder: command.patch.reminder };
            await this.revise(series, definition);
            const current = this.requireOccurrence(series);
            await this.operation(series, 'ActOccurrence', { action: 'snooze', occurrenceId: current.occurrenceId, until: null });
          }
          if (command.patch.priority !== undefined || command.patch.pinned !== undefined)
            await this.operation(series, 'SetTaskFields', { occurrenceId: this.occurrenceForNote(series, command.noteId).occurrenceId, priority: command.patch.priority, pinned: command.patch.pinned });
        } else {
          const context = await this.adoptSingle(command.noteId);
          const patch: Partial<Task> = {};
          if (command.patch.schedule) patch.schedule = this.normalizeSchedule(command.patch.schedule);
          if (command.patch.priority !== undefined) patch.priority = command.patch.priority;
          if (command.patch.pinned !== undefined) patch.pinned = command.patch.pinned;
          if (command.patch.reminder) { patch.reminder = command.patch.reminder; patch.reminderOverride = undefined; }
          if (Object.keys(patch).length) await this.singleOperation(context, 'SinglePatch', { patch, ...(command.patch.reminder ? { clearReminderOverride: true } : {}) });
        }
        const nativePatch: { title?: string; body?: string; parent_id?: string } = {};
        if (command.patch.notebookId !== undefined) {
          await this.validateNotebook(command.patch.notebookId);
          nativePatch.parent_id = command.patch.notebookId;
        }
        if (!series && command.patch.title !== undefined) {
          if (!command.patch.title.trim()) throw new StorageError('EMPTY_TITLE', '任务标题不能为空。');
          nativePatch.title = command.patch.title;
        }
        if (command.patch.body !== undefined) nativePatch.body = command.patch.body;
        if (Object.keys(nativePatch).length) await this.gateway.patchNote(command.noteId, nativePatch);
        if (command.patch.recurrence) return this.configureRepeat(command.noteId, command.patch.recurrence, command.patch.mode || 'continuous', command.requestId);
        return { noteId: command.noteId };
      }
      case 'setFields': {
        this.assertPriority(command.priority);
        const series = this.findSeries(command.noteId);
        if (series) await this.operation(this.context(series.meta.seriesId), 'SetTaskFields', { occurrenceId: this.occurrenceForNote(series, command.noteId).occurrenceId, priority: command.priority, pinned: command.pinned });
        else await this.singleOperation(await this.adoptSingle(command.noteId), 'SinglePatch', { patch: { priority: command.priority, pinned: command.pinned } });
        return { noteId: command.noteId };
      }
      case 'complete': case 'skip': case 'reopen': {
        if (command.action === 'complete') {
          const association = await this.findCarrierAssociation(command.seriesId, command.occurrenceId, command.noteId);
          if (association) {
            const anchor = await this.gateway.getNote(association.meta.anchorNoteId);
            const awaiting = [...this.pending.values()].some(item => item.evidence.seriesId === association.meta.seriesId && item.evidence.occurrenceId === association.meta.occurrenceId);
            if (!anchor || anchor.deleted_time || anchor.encryption_applied || !this.series.has(association.meta.seriesId) || awaiting) return this.savePendingCompletion(association);
          }
        }
        const series = command.seriesId ? this.context(command.seriesId) : command.noteId ? this.findSeries(command.noteId) : undefined;
        if (series) {
          this.context(series.meta.seriesId);
          const occurrence = command.occurrenceId ? this.requireOccurrence(series, command.occurrenceId) : command.noteId ? this.occurrenceForNote(series, command.noteId) : this.requireOccurrence(series);
          if (command.noteId && command.noteId !== occurrence.carrierNoteId) throw new StorageError('STALE_TARGET', '任务周期已变化，请刷新。');
          await this.requireNative(occurrence.carrierNoteId);
          if (command.action === 'reopen') await this.reopenCycle(series, occurrence);
          else {
            await this.recordPeriodResolution(series, occurrence, command.action, this.now());
          }
          // Completion is durable and projected independently from source/template availability.
          const resolved = series.snapshot.occurrences[occurrence.occurrenceId]!;
          await this.projectOccurrence(series, resolved, false);
          try { await this.advanceIfNeeded(series); }
          catch (error) {
            const code = error instanceof StorageError ? error.code : 'SERIES_ADVANCE_PENDING';
            series.warning = errorMessage(error);
            this.addDiagnostic(code, series.warning, series.meta.seriesId, resolved.carrierNoteId);
            return { seriesId: series.meta.seriesId, code, message: series.warning };
          }
          return { seriesId: series.meta.seriesId };
        }
        if (!command.noteId) throw new StorageError('TARGET_MISSING', '任务目标不存在。');
        if (command.action === 'skip') throw new StorageError('NOT_REPEATING', '普通任务没有可放弃的重复周期。');
        const context = await this.adoptSingle(command.noteId);
        if (command.action === 'complete') this.assertNotFuture(context.task.schedule, this.now());
        await this.singleOperation(context, 'SinglePatch', { patch: { completedAt: command.action === 'complete' ? this.now() : 0, resolution: command.action === 'complete' ? 'completed' : 'open', reminderOverride: 0 } });
        return { noteId: command.noteId };
      }
      case 'snooze': {
        if (!Number.isFinite(command.until) || command.until <= this.now()) throw new StorageError('INVALID_SNOOZE', '稍后提醒必须晚于当前时间。');
        const context = this.findSeries(command.noteId);
        if (context) {
          this.context(context.meta.seriesId);
          await this.operation(context, 'ActOccurrence', snoozeCurrent(context.snapshot, command.until, this.now()));
        } else await this.singleOperation(await this.adoptSingle(command.noteId), 'SinglePatch', { patch: { reminderOverride: command.until } });
        return { noteId: command.noteId };
      }
      case 'reviseSeries': {
        const context = this.context(command.seriesId);
        if (context.snapshot.definition?.revisionId !== command.revisionId) throw new StorageError('STALE_REVISION', '系列规则已改变，请重新打开编辑。');
        await this.revise(context, command.definition, command.currentSchedule, command.moveSeries);
        return { seriesId: command.seriesId };
      }
      case 'switchMode': {
        const context = this.context(command.seriesId);
        if (context.snapshot.definition?.revisionId !== command.revisionId) throw new StorageError('STALE_REVISION', '系列规则已改变。');
        await this.revise(context, { ...context.snapshot.definition, modeForNext: command.mode }, undefined);
        return { seriesId: command.seriesId };
      }
      case 'resolveConflict': {
        const context = this.context(command.seriesId, true);
        const ids = context.snapshot.revisionHeads;
        if (stableStringify([...ids].sort()) !== stableStringify([...command.revisionIds].sort())) throw new StorageError('STALE_CONFLICT', '还有未选择的规则分支，请刷新后重新解决。');
        const identity = await this.local.nextId();
        const definition = { ...clone(command.definition), revisionId: identity.opId, parentRevisionIds: ids, seriesId: command.seriesId };
        this.checkDefinition(definition);
        const occurrence = this.requireOccurrence(context);
        const schedule = this.normalizeSchedule(command.currentSchedule || occurrence.scheduled) as DatedSchedule;
        await this.operation(context, 'ResolveSeriesConflict', { definition, resolvedRevisionIds: ids,
          current: { occurrenceId: occurrence.occurrenceId, schedule, slotKey: candidateSlotKey(definition, schedule) } }, identity);
        return { seriesId: command.seriesId };
      }
      case 'deleteTask': {
        const context = command.seriesId ? this.context(command.seriesId, true) : this.findSeries(command.noteId);
        if (context) {
          const scope = command.scope || 'current';
          const current = this.requireOccurrence(context);
          await this.operation(context, 'StopOrDelete', { scope, occurrenceId: current.occurrenceId });
          if (scope === 'stop') {
            await this.projectOccurrence(context, current, false);
          } else {
            const ids = scope === 'history' ? [...new Set(Object.values(context.snapshot.occurrences).map(item => item.carrierNoteId))] : [current.carrierNoteId];
            for (const id of ids) {
              const note = await this.gateway.getNote(id);
              if (note && !note.deleted_time) await this.gateway.deleteNote(id);
            }
          }
          return { seriesId: context.meta.seriesId };
        }
        const single = await this.adoptSingle(command.noteId);
        const beforeDelete = await this.requireNative(command.noteId);
        await this.singleOperation(single, 'SingleDelete', { noteId: command.noteId, nativeUpdatedTime: beforeDelete.updated_time });
        await this.gateway.deleteNote(command.noteId);
        return { noteId: command.noteId };
      }
      case 'restoreSeries': {
        const context = this.context(command.seriesId, true);
        const carrier = this.requireOccurrence(context).carrierNoteId;
        await this.requireNative(carrier);
        await this.operation(context, 'Restore', { targetOpIds: command.targetOpIds });
        return { seriesId: command.seriesId };
      }
      case 'retrySeries': return this.retrySeries(command.seriesId, command.noteId);
      case 'adoptNativeDate': {
        const note = await this.requireNative(command.noteId);
        if (!note.todo_due) throw new StorageError('NO_NATIVE_DATE', '原生提醒为空，不能作为计划日期。');
        if (this.findSeries(note.id)) throw new StorageError('SERIES_SCHEDULE', '请通过任务菜单修改本期日期，或编辑系列规则。');
        const context = await this.adoptSingle(note.id);
        const zone = context.task.schedule.kind !== 'none' ? context.task.schedule.zone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        const schedule: DatedSchedule = { kind: 'timed', date: this.calendar.zone.localDate(note.todo_due, zone),
          time: this.calendar.zone.localTime(note.todo_due, zone), zone, instant: note.todo_due };
        await this.singleOperation(context, 'SinglePatch', { patch: { schedule, reminderOverride: note.todo_due } });
        return { noteId: note.id };
      }
      case 'previewCleanup': case 'executeCleanup': throw new StorageError('CLEANUP_ROUTE', '清理必须通过专用确认入口执行。');
    }
  }

  private carrierMeta(context: SeriesContext, occurrence: Occurrence, creationHash: string): CarrierMeta {
    const definition = context.snapshot.definition;
    return { schemaVersion: 3, role: 'carrier', seriesId: context.meta.seriesId, anchorNoteId: context.meta.rootNoteId,
      occurrenceId: occurrence.occurrenceId, creationHash,
      snapshot: { schedule: effectiveSchedule(occurrence), priority: definition?.priority || 'none', pinned: occurrence.pinned || false,
        reminder: definition?.reminder || { enabled: false }, reminderOverride: occurrence.reminderOverride,
        carrierGeneration: occurrence.carrierGeneration } };
  }

  private async findCarrierAssociation(seriesId?: string, occurrenceId?: string, noteId?: string): Promise<WaitingCarrier | undefined> {
    const context = seriesId ? this.series.get(seriesId) : noteId ? this.findSeries(noteId) : undefined;
    if (context) {
      const occurrence = occurrenceId ? context.snapshot.occurrences[occurrenceId] : noteId ? Object.values(context.snapshot.occurrences).filter(o => o.carrierNoteId === noteId).sort((a,b) => Number(b.occurrenceId === context.snapshot.activeOccurrenceId) - Number(a.occurrenceId === context.snapshot.activeOccurrenceId) || b.carrierGeneration - a.carrierGeneration)[0] : context.snapshot.occurrences[context.snapshot.activeOccurrenceId || ''];
      if (occurrence) {
        const note = await this.requireNative(occurrence.carrierNoteId);
        return { note, meta: this.carrierMeta(context, occurrence, stableHash({ title: note.title, body: note.body })) };
      }
    }
    const all = [...this.waitingCarriers.values()].flat();
    return all.find(carrier => (!seriesId || carrier.meta.seriesId === seriesId) && (!occurrenceId || carrier.meta.occurrenceId === occurrenceId) && (!noteId || carrier.note.id === noteId));
  }

  private async savePendingCompletion(carrier: WaitingCarrier, completedAt = this.now(), action: 'complete' | 'skip' = 'complete'): Promise<Partial<ActionResult>> {
    let note = await this.requireNative(carrier.note.id);
    if (this.isFuture(carrier.meta.snapshot?.schedule, note.todo_completed || completedAt)) {
      if (note.todo_completed) await this.correctFuture(note);
      throw new StorageError('FUTURE_TASK', '未来任务不能完成，请先修改计划日期。');
    }
    let evidence: PendingCompletion | undefined;
    for (const key of (await this.journal.userData.keys(note)).filter(value => value.startsWith('v3:pending:'))) {
      const candidate = await this.journal.userData.get<PendingCompletion>(note.id, key);
      if (candidate?.seriesId === carrier.meta.seriesId && candidate.occurrenceId === carrier.meta.occurrenceId &&
          !await this.journal.userData.get(note.id, `v3:pending-imported:${candidate.pendingId}`)) { evidence = candidate; break; }
    }
    if (!evidence) {
      const identity = await this.local.nextId();
      const pendingId = stableHash(['journey-pending-completion-v3', carrier.meta.seriesId, carrier.meta.occurrenceId, identity.deviceId]);
      evidence = { schemaVersion: 3, pendingId, seriesId: carrier.meta.seriesId, anchorNoteId: carrier.meta.anchorNoteId,
        occurrenceId: carrier.meta.occurrenceId, noteId: note.id, at: note.todo_completed || completedAt, before: nativeFields(note), operationIdentity: identity, action };
      // Persist the evidence first. A crash after this point never loses the user's completion intent.
      await this.journal.userData.append(note.id, `v3:pending:${pendingId}`, evidence);
    }
    const after = { is_todo: 1, todo_due: 0, todo_completed: evidence.at };
    note = await this.requireNative(note.id);
    if (!sameNative(note, after)) {
      if (!sameNative(note, evidence.before)) throw new StorageError('PENDING_NATIVE_CHANGED', '任务在保存完成记录时被修改，已保留待推进证据，请检查原笔记后重试。');
      note = await this.gateway.patchNote(note.id, after);
      if (!sameNative(note, after)) throw new StorageError('PENDING_NATIVE_CHANGED', '当前完成状态读回不一致，已保留待推进证据。');
    }
    this.native.set(note.id, note);
    this.pending.set(evidence.pendingId, { note, evidence });
    return { noteId: note.id, seriesId: evidence.seriesId, code: 'ANCHOR_MISSING_PENDING',
      message: '当前完成已保存，下一周期尚未生成。恢复首篇任务后，请点击重试推进。' };
  }

  private async retrySeries(seriesId: string, noteId?: string): Promise<Partial<ActionResult>> {
    // Explicit retry is the only authority to merge validated late operations from retired anchors.
    await this.journal.mergeRetired(seriesId);
    // Reload explicitly; a restored anchor may not have appeared in an earlier UI snapshot.
    await this.loadState();
    const context = this.series.get(seriesId);
    if (!context) throw new StorageError('ANCHOR_MISSING', '首篇任务尚未恢复或未同步，当前完成已保留，不会创建替代首篇。');
    const anchor = await this.gateway.getNote(context.meta.rootNoteId);
    if (!anchor || anchor.deleted_time || anchor.encryption_applied) throw new StorageError('ANCHOR_MISSING', '请先恢复并同步原首篇任务，再重试推进。');
    context.snapshot = reduceSeries(context.operations);
    if (['waiting', 'pausedConflict'].includes(context.snapshot.status)) throw new StorageError('SERIES_CONFLICT', '系列依赖尚未完整或有冲突，请先解决后重试推进。');
    const pending = [...this.pending.values()].filter(item => item.evidence.seriesId === seriesId && (!noteId || item.evidence.noteId === noteId))
      .sort((a, b) => a.evidence.operationIdentity.opId.localeCompare(b.evidence.operationIdentity.opId));
    if (!pending.length) { await this.advanceIfNeeded(context); return { seriesId }; }
    for (const item of pending) {
      const { evidence } = item;
      if (!context.snapshot.occurrences[evidence.occurrenceId]) throw new StorageError('PENDING_OCCURRENCE_MISSING', '首篇中的周期记录与当前任务不匹配，已保留双方内容。');
      // Finish the native half if a prior crash happened immediately after persisting the evidence.
      const note = await this.requireNative(evidence.noteId);
      const after = { is_todo: 1, todo_due: 0, todo_completed: evidence.at };
      if (!context.snapshot.occurrences[evidence.occurrenceId]!.consumed) {
        if (sameNative(note, evidence.before)) await this.gateway.patchNote(note.id, after);
        else if (!sameNative(note, after)) throw new StorageError('PENDING_NATIVE_CHANGED', '待推进任务在完成后又被修改，请检查后重试。');
      }
      const key = `v3:pending-operation:${evidence.pendingId}`;
      let operation = await this.journal.userData.get<DomainOperation>(note.id, key);
      if (!operation) {
        const payload = { action: evidence.action || 'complete' as const, occurrenceId: evidence.occurrenceId, at: evidence.at };
        operation = { schemaVersion: 1, ...evidence.operationIdentity, seriesId, parents: operationHeads(context.operations),
          recordedAt: evidence.at, kind: 'ActOccurrence', payload, payloadHash: stableHash(payload) };
        await this.journal.userData.append(note.id, key, operation);
      }
      await this.journal.append(context.noteId, operation, seriesId);
      if (!context.operations.some(existing => existing.opId === operation!.opId)) context.operations.push(operation);
      context.snapshot = reduceSeries(context.operations);
      const occurrence = context.snapshot.occurrences[evidence.occurrenceId]!;
      const intentId = stableHash(['journey-pending-projection-v3', evidence.pendingId]);
      const projection: ProjectionPayload = { intentId, noteId: evidence.noteId, occurrenceId: evidence.occurrenceId,
        carrierGeneration: occurrence.carrierGeneration, sourceOpId: operation.opId, phase: 'pending-completion',
        before: evidence.before, after };
      if (!context.snapshot.projections.some(item => item.intentId === intentId && !item.readbackHash))
        await this.operation(context, 'ProjectionIntent', projection);
      if (!context.snapshot.projections.some(item => item.intentId === intentId && item.readbackHash))
        await this.operation(context, 'ProjectionReceipt', { ...projection, readbackHash: stableHash(after) });
    }
    await this.advanceIfNeeded(context);
    for (const item of pending) {
      await this.journal.userData.append(item.note.id, `v3:pending-imported:${item.evidence.pendingId}`, {
        schemaVersion: 3, pendingId: item.evidence.pendingId, opId: item.evidence.operationIdentity.opId,
      });
      this.pending.delete(item.evidence.pendingId);
    }
    context.warning = undefined;
    return { seriesId, code: 'SERIES_RETRY_SAVED', message: '待推进完成记录已恢复，下一周期按规则推进一次。' };
  }

  private checkDefinition(definition: SeriesDefinition): void {
    const errors = [...validateRule(definition.rule), ...validateSchedule(definition.anchor, this.calendar)];
    this.assertPriority(definition.priority);
    this.validateReminder(definition.reminder, definition.anchor);
    if (definition.rule.calendar === 'lunar') this.calendar.lunar.fromSolar(definition.anchor.date);
    if (!['continuous', 'archive'].includes(definition.modeForNext)) errors.push('Invalid repeat mode');
    if (errors.length) throw new StorageError('INVALID_RULE', errors.join('；'));
  }

  private async validateNotebook(notebookId: string): Promise<void> {
    if (!(await this.gateway.folders()).some(folder => folder.id === notebookId)) throw new StorageError('NOTEBOOK_MISSING', '请选择有效的目标笔记本。');
  }

  private isFuture(schedule: Schedule | undefined, at: number): boolean {
    return !!schedule && schedule.kind !== 'none' && schedule.date > this.calendar.zone.localDate(at, schedule.zone);
  }
  private assertNotFuture(schedule: Schedule, at: number): void {
    if (this.isFuture(schedule, at)) throw new StorageError('FUTURE_TASK', '未来任务不能完成或放弃，请先修改计划日期。');
  }
  private async correctFuture(note: NativeNote): Promise<void> {
    const latest = await this.requireNative(note.id);
    if (latest.todo_completed !== note.todo_completed) return;
    const updated = await this.gateway.patchNote(note.id, { todo_completed: 0 });
    if (updated.todo_completed) throw new StorageError('FUTURE_RESET_FAILED', '未来任务状态恢复失败，未生成下一期。');
    this.native.set(note.id, updated);
    const message = createTranslator(await this.interfaceLocale())('notice.futureTaskReset');
    this.notice?.(message);
  }
  private async reopenCycle(context: SeriesContext, occurrence: Occurrence): Promise<void> {
    if (occurrence.resolution === 'open') return;
    const snapshot = context.snapshot;
    const edge = snapshot.advances[occurrence.occurrenceId];
    const latest = edge && (!edge.next || edge.next.occurrenceId === snapshot.activeOccurrenceId);
    if (latest) {
      const targets = context.operations.filter(op => op.kind === 'Advance' && op.payload.predecessorId === occurrence.occurrenceId).map(op => op.opId);
      await this.operation(context, 'RewindAdvance', { targetOpIds: targets, occurrenceId: occurrence.occurrenceId, targetOpId: occurrence.terminalOpId! });
      if (edge.next) for (const intent of await this.local.all()) if (intent.create?.noteId === edge.next.carrierNoteId)
        await this.local.put({ ...intent, phase: 'carrier-saved', create: undefined });
    }
    if (!latest) await this.operation(context, 'ActOccurrence', undoOccurrence(context.snapshot, occurrence.occurrenceId));

  }

  private async changeTaskDate(noteId: string, input: Schedule): Promise<Partial<ActionResult>> {
    const schedule = this.normalizeSchedule(input);
    const series = this.findSeries(noteId);
    if (!series) {
      const single = await this.adoptSingle(noteId);
      await this.singleOperation(single, 'SinglePatch', { patch: { schedule } });
      return { noteId };
    }
    this.context(series.meta.seriesId);
    const occurrence = this.requireOccurrence(series);
    if (occurrence.carrierNoteId !== noteId || occurrence.resolution !== 'open') throw new StorageError('HISTORICAL_TASK', '只能修改当前未完成周期的日期。');
    if (schedule.kind === 'none') throw new StorageError('REPEAT_DATE_REQUIRED', '重复任务必须有计划日期。');
    // The active date editor still needs this occurrence-only log format: changing scheduled
    // would also move the recurrence cursor. Keep it while removing the unused defer commands.
    await this.operation(series, 'ActOccurrence', { action: 'defer', occurrenceId: occurrence.occurrenceId, schedule });
    return { noteId, seriesId: series.meta.seriesId };
  }

  private async recordPeriodResolution(context: SeriesContext, occurrence: Occurrence, action: 'complete' | 'skip', at: number): Promise<void> {
    if (occurrence.withdrawn) throw new StorageError('WITHDRAWN_TASK', '此周期已撤回，不能处理。');
    this.assertNotFuture(effectiveSchedule(occurrence), at);
    if (occurrence.resolution === (action === 'complete' ? 'completed' : 'skipped')) return;
    await this.operation(context, 'ActOccurrence', { action, occurrenceId: occurrence.occurrenceId, at });
  }

  private async abandonTask(noteId: string, _requestId: string): Promise<Partial<ActionResult>> {
    const note = await this.requireNative(noteId);
    if (!note.is_todo) throw new StorageError('NOT_A_TASK', '此笔记已不是待办任务。');
    const series = this.findSeries(noteId);
    if (series) this.context(series.meta.seriesId);
    const association = await this.findCarrierAssociation(undefined, undefined, noteId);
    const occurrence = series ? this.requireOccurrence(series) : undefined;
    if (occurrence && occurrence.carrierNoteId !== noteId) throw new StorageError('HISTORICAL_TASK', '只能放弃当前活动周期。');
    const at = this.now();
    if (association) {
      const anchor = await this.gateway.getNote(association.meta.anchorNoteId);
      if (!anchor || anchor.deleted_time || anchor.encryption_applied || !series) return this.savePendingCompletion(association, at, 'skip');
    }
    this.assertNotFuture(occurrence ? effectiveSchedule(occurrence) : (await this.adoptSingle(noteId)).task.schedule, at);
    if ((occurrence && occurrence.resolution !== 'open') || (!occurrence && note.todo_completed)) return { noteId };
    if (!series || !occurrence) {
      await this.singleOperation(await this.adoptSingle(noteId), 'SinglePatch', { patch: { completedAt: at, resolution: 'skipped', reminderOverride: 0 } });
      return { noteId };
    }
    await this.recordPeriodResolution(series, occurrence, 'skip', at);
    const resolved = series.snapshot.occurrences[occurrence.occurrenceId]!;
    await this.projectOccurrence(series, resolved, false);
    try { await this.advanceIfNeeded(series); }
    catch (error) {
      const code = error instanceof StorageError ? error.code : 'SERIES_ADVANCE_PENDING';
      this.addDiagnostic(code, errorMessage(error), series.meta.seriesId, noteId);
      return { noteId, seriesId: series.meta.seriesId, code, message: errorMessage(error) };
    }
    return { noteId, seriesId: series.meta.seriesId };
  }

  private async createTask(input: TaskInput, requestId: string): Promise<Partial<ActionResult>> {
    if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new StorageError('EMPTY_TITLE', '任务标题不能为空。');
    this.assertPriority(input.priority);
    if (input.recurrence) { const errors = validateRule(input.recurrence); if (errors.length) throw new StorageError('INVALID_RULE', errors.join('；')); }
    if (input.mode && !['continuous', 'archive'].includes(input.mode)) throw new StorageError('INVALID_MODE', '无效的重复模式。');
    const folders = await this.gateway.folders();
    if (!folders.some(folder => folder.id === input.notebookId)) throw new StorageError('NOTEBOOK_MISSING', '请选择有效的目标笔记本。');
    const schedule = this.normalizeSchedule(input.schedule);
    this.validateReminder(input.reminder, schedule);
    if (input.recurrence?.calendar === 'lunar' && schedule.kind !== 'none') this.calendar.lunar.fromSolar(schedule.date);
    if (input.recurrence && schedule.kind === 'none') throw new StorageError('REPEAT_DATE_REQUIRED', '重复任务必须有计划日期。');
    const noteId = stableHash(['journey-root-task', requestId]).slice(0, 32);
    const seriesId = stableHash(['journey-root-series', requestId]);
    this.journal.registerAnchor(seriesId, noteId);
    const priorControl = await this.gateway.getNote(noteId);
    if (priorControl && !priorControl.deleted_time && await this.journal.userData.get(priorControl.id, scopeKey(seriesId))) {
      const operations = await this.journal.operations<JournalOperation>(priorControl, seriesId);
      if (operations.some(op => op.kind === 'CreateSeries' || op.kind === 'SingleCreate')) {
        const rootIntent = (await this.local.all()).find(intent => intent.id === `root:${seriesId}`);
        if (rootIntent) await this.local.put({ ...rootIntent, phase: 'root-saved', create: undefined, command: undefined });
        return { noteId, ...(input.recurrence ? { seriesId } : {}) };
      }
    }
    const meta: ControlMeta = { schemaVersion: 3, role: input.recurrence ? 'series' : 'single', seriesId, rootNoteId: noteId };
    let body = input.body || '';
    const mode = input.mode || 'continuous';
    if (input.recurrence && mode === 'archive') {
      const parsed = parseArchiveBody(body);
      await this.templates.verifyReferences(parsed?.templateBody ?? '');
      body = initializeArchiveBody(body);
    }
    const create = { title: input.title, body: body, parent_id: input.notebookId, is_todo: 1, todo_due: 0, todo_completed: 0, created_time: this.now() };
    const createIntent = { id: `root:${seriesId}`, controlNoteId: this.journal.controlId(seriesId), phase: 'root-create',
      create: { noteId, input: create, role: 'root' }, command: { action: 'createTask', requestId, input: clone(input) }, updatedAt: this.now(), attempts: 0 };
    const earlierIntent = (await this.local.all()).find(intent => intent.id === createIntent.id);
    if (earlierIntent?.create?.input.created_time) create.created_time = Number(earlierIntent.create.input.created_time);
    if (earlierIntent && ['root-created', 'root-saved'].includes(earlierIntent.phase) && (!priorControl || priorControl.deleted_time)) throw new StorageError('ANCHOR_MISSING', '首篇任务已被删除，请恢复原笔记；不会自动重建。');
    await this.local.put(createIntent);
    await this.gateway.ensureNote(noteId, create);
    if (input.recurrence && mode === 'archive') await this.templates.markInitialized(seriesId);
    await this.local.put({ ...createIntent, phase: 'root-created' });
    await this.journal.createControl(meta);
    if (!input.recurrence) {
      const task: Task = { createdAt: create.created_time, taskId: noteId, noteId, title: input.title, notebookId: input.notebookId, tagIds: [], schedule,
        completedAt: 0, priority: input.priority || 'none', pinned: input.pinned || false, reminder: input.reminder || { enabled: false }, managed: true };
      const context: SingleContext = { noteId: this.journal.controlId(seriesId), meta, operations: [], task };
      await this.singleOperation(context, 'SingleCreate', { task, initialNative: nativeFields(create) });
      this.singles.set(seriesId, context);
    } else {
      await this.initializeRepeat(noteId, seriesId, schedule as DatedSchedule, input.recurrence, mode, {
        priority: input.priority || 'none', pinned: input.pinned || false, reminder: input.reminder || { enabled: false },
      });
    }
    await this.local.put({ ...createIntent, phase: 'root-saved', create: undefined, command: undefined });
    return { noteId, ...(input.recurrence ? { seriesId } : {}) };
  }

  private async configureRepeat(noteId: string, rule: import('../shared/models').RecurrenceRule,
    mode: import('../shared/models').TaskMode, requestId: string): Promise<Partial<ActionResult>> {
    if (this.findSeries(noteId)) throw new StorageError('ALREADY_REPEATING', '此笔记已有重复系列。');
    const single = await this.adoptSingle(noteId);
    if (single.task.schedule.kind === 'none' || single.task.completedAt) throw new StorageError('REPEAT_DATE_REQUIRED', '请先为未完成任务设置计划日期。');
    const seriesId = stableHash(['journey-convert-series', noteId]);
    await this.journal.replayPending();
    return this.initializeRepeat(noteId, seriesId, single.task.schedule, rule, mode, single.task);
  }

  /** All entry points initialize the same anchored series and first occurrence. */
  private async initializeRepeat(noteId: string, seriesId: string, schedule: DatedSchedule,
    rule: import('../shared/models').RecurrenceRule, mode: import('../shared/models').TaskMode,
    fields: Pick<Task, 'priority' | 'pinned' | 'reminder'>): Promise<Partial<ActionResult>> {
    let note = await this.requireNative(noteId);
    this.journal.registerAnchor(seriesId, noteId);
    if (await this.journal.userData.get(noteId, scopeKey(seriesId))) {
      const saved = await this.journal.operations<DomainOperation>(note, seriesId);
      if (saved.some(op => op.kind === 'CreateSeries')) return { noteId, seriesId };
    }
    if (mode === 'archive') {
      await this.prepareArchiveSource(seriesId);
      note = await this.requireNative(noteId);
    }
    const identity = await this.local.nextId();
    const meta: ControlMeta = { schemaVersion: 3, role: 'series', seriesId, rootNoteId: noteId };
    const definition: SeriesDefinition = { seriesId, title: note.title, revisionId: identity.opId, parentRevisionIds: [], rule: clone(rule),
      anchor: clone(schedule), priority: fields.priority, pinned: fields.pinned, modeForNext: mode, reminder: clone(fields.reminder),
      sourceNotebookId: note.parent_id, sourceTagIds: await this.gateway.noteTags(noteId) };
    this.checkDefinition(definition);
    await this.journal.createControl(meta);
    const first: Occurrence = { occurrenceId: occurrenceKey(seriesId), seriesId, originatingRevisionId: identity.opId,
      originSlotKey: candidateSlotKey(definition, schedule), suppressedSlotKeys: [], scheduled: clone(schedule),
      resolution: 'open', consumed: false, carrierNoteId: noteId, carrierGeneration: 0, mode };
    const context: SeriesContext = { noteId, meta, operations: [], snapshot: reduceSeries([]) };
    await this.operation(context, 'CreateSeries', { definition, first }, identity);
    const creationHash = stableHash({ title: note.title, body: note.body });
    await this.operation(context, 'BindCarrier', { occurrenceId: first.occurrenceId, noteId, creationHash, generation: 0 });
    await this.journal.writeCarrier(noteId, this.carrierMeta(context, first, creationHash));
    this.series.set(seriesId, context);
    return { seriesId, noteId };
  }

  private async revise(context: SeriesContext, input: SeriesDefinition, currentSchedule?: DatedSchedule, moveSeries = false): Promise<void> {
    const existing = context.snapshot.definition;
    if (!existing) throw new StorageError('SERIES_MISSING', '系列定义不可用。');
    const moving = moveSeries || input.sourceNotebookId !== existing.sourceNotebookId;
    if (moving) await this.validateNotebook(input.sourceNotebookId);
    const identity = await this.local.nextId();
    const definition = { ...clone(input), seriesId: context.meta.seriesId, revisionId: identity.opId, parentRevisionIds: [existing.revisionId] };
    definition.anchor = this.normalizeSchedule(definition.anchor) as DatedSchedule;
    this.checkDefinition(definition);
    delete definition.templateRevisionId;
    if (definition.modeForNext === 'archive') {
      await this.prepareArchiveSource(context.meta.seriesId);
    }
    const occurrence = this.requireOccurrence(context);
    const schedule = ruleRevisionSchedule(this.calendar,
      currentSchedule ? this.normalizeSchedule(currentSchedule) as DatedSchedule : undefined);
    // Save the exact membership before committing the rule so a crash can resume the move.
    const move: LocalIntent | undefined = moving ? {
      id: `series-move:${identity.opId}`, controlNoteId: context.noteId, phase: 'series-move',
      sourceOpId: identity.opId, updatedAt: this.now(), attempts: 0,
      seriesMove: { seriesId: context.meta.seriesId, notebookId: definition.sourceNotebookId,
        noteIds: [...new Set([context.meta.rootNoteId,
          ...Object.values(context.snapshot.occurrences).map(row => row.carrierNoteId),
          ...context.operations.flatMap(op => op.kind === 'BindCarrier' ? [op.payload.noteId] : [])])] },
    } : undefined;
    if (move) await this.local.put(move);
    await this.operation(context, 'ReviseSeries', { definition, ...(schedule ? { current: { occurrenceId: occurrence.occurrenceId, schedule, slotKey: candidateSlotKey(definition, schedule), clearDeferred: true } } : {}) }, identity);
    if (existing.reminder.enabled !== definition.reminder.enabled ||
      (existing.reminder.allDayTime || '09:00') !== (definition.reminder.allDayTime || '09:00')) {
      await this.operation(context, 'ActOccurrence', { action: 'snooze', occurrenceId: occurrence.occurrenceId, until: null });
    }
    if (move) await this.finishSeriesMove(context, move);
  }

  private async finishSeriesMove(context: SeriesContext, intent: LocalIntent): Promise<void> {
    const move = intent.seriesMove!;
    if (context.snapshot.conflicts.length) throw new StorageError('SERIES_MOVE_PENDING', '系列存在冲突，整组移动尚未完成，请解决冲突后刷新重试。');
    // A later destination edit supersedes unfinished work for the old destination.
    if (context.snapshot.definition?.sourceNotebookId !== move.notebookId) { await this.local.remove(intent.id); return; }
    try {
      await this.validateNotebook(move.notebookId);
      for (const noteId of move.noteIds) {
        const note = await this.gateway.getNote(noteId);
        if (!note) throw new Error('系列笔记缺失或尚未同步，请恢复或同步后刷新重试。');
        if (note.deleted_time) continue; // Never restore deleted history as part of a move.
        if (note.encryption_applied || note.is_conflict) throw new Error('系列笔记尚不可用，请同步后刷新重试。');
        if (note.parent_id !== move.notebookId) await this.gateway.patchNote(noteId, { parent_id: move.notebookId });
      }
      await this.local.remove(intent.id);
    } catch (error) {
      await this.local.put({ ...intent, attempts: intent.attempts + 1, lastError: errorMessage(error) });
      throw new StorageError('SERIES_MOVE_PENDING', `系列规则已保存，整组移动尚未完成；请刷新重试。${errorMessage(error)}`);
    }
  }

  private async recoverCreates(): Promise<void> {
    // Only current-schema, durable child-creation intents authorize POST. Never recreate a missing anchor.
    for (const intent of await this.local.all()) {
      if (intent.storageVersion !== 3 || !intent.create || !['carrier-create', 'carrier-created'].includes(intent.phase) || intent.create.role !== 'carrier' || !intent.sourceOpId) continue;
      if (intent.attempts >= 3) { this.addDiagnostic('RECOVERY_RETRY_LIMIT', '创建恢复已暂停，请检查同步或手动重试。', undefined, intent.create.noteId); continue; }
      try {
        const anchor = await this.gateway.getNote(intent.controlNoteId);
        if (!anchor || anchor.deleted_time || anchor.encryption_applied || anchor.is_conflict) continue;
        let context: SeriesContext | undefined;
        let advance: Extract<DomainOperation, { kind: 'Advance' }> | undefined;
        for (const entry of (await this.journal.discover([anchor])).controls) {
          if (entry.meta.role !== 'series') continue;
          let authority = entry;
          let operations = await this.journal.operations<DomainOperation>(anchor, entry.meta.seriesId);
          const firstId = operations.find((op): op is Extract<DomainOperation, {kind:'CreateSeries'}> => op.kind === 'CreateSeries')?.payload.first.carrierNoteId;
          if (firstId && firstId !== anchor.id) {
            const fixed = await this.journal.discover(await this.gateway.allNotes(), true);
            const restored = fixed.controls.find(row => row.meta.seriesId === entry.meta.seriesId);
            if (!restored) continue;
            authority = restored;
            operations = await this.journal.operations<DomainOperation>(authority.note, entry.meta.seriesId);
            intent.controlNoteId = authority.note.id;
            await this.local.put(intent);
          }
          const source = operations.find(operation => operation.opId === intent.sourceOpId && operation.kind === 'Advance');
          if (!source || source.kind !== 'Advance') continue;
          const snapshot = reduceSeries(operations);
          if (snapshot.status === 'waiting' || snapshot.status === 'pausedConflict') break;
          context = { noteId: authority.note.id, meta: authority.meta, operations, snapshot }; advance = source;
          break;
        }
        if (!context || !advance?.payload.next) continue;
        const liveEdge = context.snapshot.advances[advance.payload.predecessorId];
        if (context.snapshot.occurrences[advance.payload.next.occurrenceId]?.withdrawn || !liveEdge || liveEdge.terminalOpId !== advance.payload.terminalOpId || liveEdge.next?.carrierNoteId !== intent.create.noteId) { await this.local.put({ ...intent, phase: 'carrier-saved', create: undefined }); continue; }
        const { _tagIds, _creationHash, ...rawInput } = intent.create.input;
        const input = rawInput as { title: string; body: string; parent_id: string; is_todo?: number; todo_due?: number; todo_completed?: number };
        const recovered = intent.phase === 'carrier-created' ? await this.requireNative(intent.create.noteId) : await this.gateway.ensureNote(intent.create.noteId, input);
        const creationHash = typeof _creationHash === 'string' ? _creationHash : stableHash({ title: recovered.title, body: recovered.body });
        if (stableHash({ title: recovered.title, body: recovered.body }) !== creationHash) throw new StorageError('CREATION_CHANGED', '生成笔记已被修改，已保留内容并暂停恢复。');
        // A successful native readback ends the temporary body-bearing creation phase.
        const bodyFreeIntent = { ...intent, phase: 'carrier-created', create: { ...intent.create, input: { title: recovered.title, parent_id: recovered.parent_id, _creationHash: creationHash, ...(Array.isArray(_tagIds) ? { _tagIds } : {}) } } };
        await this.local.put(bodyFreeIntent);
        const next = advance.payload.next;
        await this.gateway.addTags(recovered.id, Array.isArray(_tagIds) ? _tagIds as string[] : context.snapshot.definition?.sourceTagIds || []);
        const meta = this.carrierMeta(context, next, stableHash({ title: recovered.title, body: recovered.body }));
        await this.journal.writeCarrier(recovered.id, meta);
        if (!context.operations.some(op => op.kind === 'BindCarrier' && op.payload.occurrenceId === next.occurrenceId && op.payload.noteId === recovered.id)) {
          await this.operation(context, 'BindCarrier', { occurrenceId: next.occurrenceId, noteId: recovered.id, creationHash: meta.creationHash, generation: next.carrierGeneration });
        }
        await this.local.put({ ...intent, phase: 'carrier-saved', create: undefined });
      } catch (error) {
        const latest = (await this.local.all()).find(item => item.id === intent.id) || intent;
        await this.local.put({ ...latest, attempts: latest.attempts + 1, lastError: errorMessage(error) });
        this.addDiagnostic('CREATE_RECOVERY', errorMessage(error), undefined, intent.create.noteId);
      }
    }
  }

  private async advanceIfNeeded(context: SeriesContext): Promise<void> {
    const snapshot = context.snapshot;
    if (snapshot.status !== 'active' || !snapshot.definition || !snapshot.activeOccurrenceId) return;
    const occurrence = snapshot.occurrences[snapshot.activeOccurrenceId];
    if (!occurrence || occurrence.consumed || occurrence.resolution === 'open') return;
    const identity = await this.local.nextId();
    const advance = planAdvance(snapshot, occurrence.resolvedAt || this.now(), this.calendar, identity.opId);
    if (advance.next && advance.candidateNoteId) {
      const retained = snapshot.occurrences[advance.next.occurrenceId];
      if (retained?.withdrawn && retained.mode === advance.next.mode && stableStringify(retained.scheduled) === stableStringify(advance.next.scheduled)) {
        const note = await this.gateway.getNote(retained.carrierNoteId);
        if (!note || note.deleted_time || !note.is_todo) throw new StorageError('RETAINED_CARRIER_MISSING', '已撤回的后继被删除或已转为普通笔记，请检查后重试。');
        advance.next.carrierNoteId = retained.carrierNoteId;
        advance.next.carrierGeneration = retained.carrierGeneration;
        delete advance.candidateNoteId;
      }
    }
    let createIntent: import('../adapters/joplin/localIntentStore').LocalIntent | undefined;
    if (advance.next && advance.candidateNoteId) {
      const verified = await this.templates.readSource(context.meta.seriesId);
      advance.templateSourceNoteId = verified.sourceNoteId;
      advance.templateContentHash = verified.sourceHash;
      const source = await this.requireNative(context.meta.rootNoteId);
      const tags = await this.gateway.noteTags(source.id);
      await this.validateNotebook(snapshot.definition.sourceNotebookId);
      const input = { title: this.seriesTitle(context, verified.title), body: verified.body, parent_id: snapshot.definition.sourceNotebookId, is_todo: 1, todo_due: 0, todo_completed: 0 };
      createIntent = { id: `create:${identity.opId}`, controlNoteId: context.noteId, phase: 'carrier-create', sourceOpId: identity.opId,
        create: { noteId: advance.candidateNoteId, input, role: 'carrier' }, updatedAt: this.now(), attempts: 0 };
      await this.local.put(createIntent);
      // Templates and tags come from the anchor; location is an explicit series setting.
      if (source.parent_id !== snapshot.definition.sourceNotebookId || stableStringify(tags) !== stableStringify(snapshot.definition.sourceTagIds)) {
        // Actual input and tag IDs are the durable creating intent, not a destructive rule edit.
        createIntent.create!.input = { ...input, _tagIds: tags };
        await this.local.put(createIntent);
      }
    }
    await this.operation(context, 'Advance', advance, identity);
    await this.markConsumed(context, occurrence);
    if (advance.next && createIntent?.create) {
      const input = createIntent.create.input;
      const { _tagIds, ...nativeInput } = input;
      const created = await this.gateway.ensureNote(createIntent.create.noteId, nativeInput as any);
      createIntent = { ...createIntent, phase: 'carrier-created', create: { ...createIntent.create, input: { title: created.title, parent_id: created.parent_id, _creationHash: stableHash({ title: created.title, body: created.body }), ...(Array.isArray(_tagIds) ? { _tagIds } : {}) } } };
      await this.local.put(createIntent);
      const tags = Array.isArray(_tagIds) ? _tagIds as string[] : snapshot.definition.sourceTagIds;
      await this.gateway.addTags(created.id, tags);
      const meta = this.carrierMeta(context, advance.next, stableHash({ title: created.title, body: created.body }));
      await this.journal.writeCarrier(created.id, meta);
      await this.operation(context, 'BindCarrier', { occurrenceId: advance.next.occurrenceId, noteId: created.id,
        creationHash: meta.creationHash, generation: advance.next.carrierGeneration });
      await this.local.put({ ...createIntent, phase: 'carrier-saved', create: undefined });
      this.native.set(created.id, created);
    } else if (advance.next) {
      const note = await this.requireNative(advance.next.carrierNoteId);
      if (!(await this.journal.readCarriers(note)).some(meta => meta.seriesId === context.meta.seriesId && meta.occurrenceId === advance.next!.occurrenceId))
        await this.journal.writeCarrier(note.id, this.carrierMeta(context, advance.next, stableHash({ title: note.title, body: note.body })));
    }
  }

  private semanticSource(context: SeriesContext): string {
    return [...context.operations].reverse().find(operation => !['ProjectionIntent', 'ProjectionReceipt', 'ObserveNative'].includes(operation.kind))?.opId || context.operations[0]!.opId;
  }
  private consumedKey(seriesId: string, occurrenceId: string): string {
    return `v3:consumed:${stableHash([seriesId, occurrenceId])}`;
  }
  private async markConsumed(context: SeriesContext, occurrence: Occurrence): Promise<void> {
    const existing = await this.gateway.getNote(occurrence.carrierNoteId);
    if (!existing || existing.deleted_time || existing.encryption_applied || existing.is_conflict) return;
    await this.journal.userData.append(occurrence.carrierNoteId, this.consumedKey(context.meta.seriesId, occurrence.occurrenceId), {
      schemaVersion: 3, seriesId: context.meta.seriesId, occurrenceId: occurrence.occurrenceId, consumed: true,
    });
  }
  private async projectOccurrence(context: SeriesContext, occurrence: Occurrence, active: boolean): Promise<void> {
    const definition = context.snapshot.definition;
    if (!definition) return;
    const carrierOwner = Object.values(context.snapshot.occurrences).filter(o => !o.withdrawn && o.carrierNoteId === occurrence.carrierNoteId)
      .sort((a,b) => Number(b.occurrenceId === context.snapshot.activeOccurrenceId) - Number(a.occurrenceId === context.snapshot.activeOccurrenceId) || b.carrierGeneration - a.carrierGeneration)[0];
    if (carrierOwner && carrierOwner.occurrenceId !== occurrence.occurrenceId && carrierOwner.carrierNoteId === occurrence.carrierNoteId) return;
    const after = occurrenceNativeFields(occurrence, definition, this.calendar, active);
    const native = await this.requireNative(occurrence.carrierNoteId);
    const known = context.snapshot.projections;
    if (sameNative(native, after) && known.some(projection => projection.noteId === native.id && projection.carrierGeneration === occurrence.carrierGeneration && sameNative(projection.after, after) && projection.readbackHash)) return;
    const updated = await this.projector.execute({ noteId: native.id, occurrenceId: occurrence.occurrenceId,
      carrierGeneration: occurrence.carrierGeneration, sourceOpId: this.semanticSource(context), phase: `occurrence:${occurrence.occurrenceId}:${stableHash(after)}:${stableHash(context.operations.filter(op => !['ProjectionIntent', 'ProjectionReceipt', 'ObserveNative'].includes(op.kind)).map(op => op.opId).sort())}`,
      knownProjections: known, append: async (kind, payload) => { await this.operation(context, kind, payload); } }, after);
    this.native.set(updated.id, updated);
  }

  private async syncSeriesTitle(context: SeriesContext): Promise<void> {
    const title = context.snapshot.definition?.title;
    const renameId = context.snapshot.titleOperationId;
    if (!title || !renameId) return;
    const noteIds = new Set([context.meta.rootNoteId, ...Object.values(context.snapshot.occurrences).map(o => o.carrierNoteId),
      ...context.operations.flatMap(op => op.kind === 'BindCarrier' ? [op.payload.noteId] : [])]);
    let pending = 0;
    for (const noteId of noteIds) {
      try {
        const key = `v3:title-applied:${stableHash([context.meta.seriesId, renameId, noteId])}`;
        if (await this.journal.userData.get(context.noteId, key)) continue;
        const note = await this.gateway.getNote(noteId);
        if (!note || note.deleted_time || note.encryption_applied || note.is_conflict) { pending++; continue; }
        const updated: NativeNote = note.title === title ? note : await this.gateway.patchNote(noteId, { title });
        if (updated.title !== title) throw new Error('标题保存结果不一致');
        await this.journal.userData.append(context.noteId, key, { schemaVersion: 3, seriesId: context.meta.seriesId, noteId, title, opId: renameId });
        this.native.set(noteId, updated);
      } catch { pending++; }
    }
    if (pending) this.addDiagnostic('SERIES_RENAME_PENDING', `系列名称已保存，仍有 ${pending} 篇笔记待更新；请同步或恢复可用状态后刷新重试。`, context.meta.seriesId);
  }
  private async reconcileSeries(context: SeriesContext): Promise<void> {
    if (context.warning || context.snapshot.status === 'waiting' || context.snapshot.status === 'pausedConflict') return;
    await this.syncSeriesTitle(context);
    const snapshot = context.snapshot;
    // Historical archive notes may be deleted without blocking the current task.
    const active = snapshot.activeOccurrenceId && snapshot.occurrences[snapshot.activeOccurrenceId];
    if (active && snapshot.status !== 'ended') {
      const note = await this.gateway.getNote(active.carrierNoteId);
      if (!note || note.deleted_time || note.encryption_applied || note.is_conflict) {
        context.snapshot.status = 'waiting';
        context.warning = '执行笔记尚未同步或已删除，不会自动重建。';
        this.addDiagnostic('MISSING_CARRIER', context.warning, snapshot.seriesId, active.carrierNoteId);
        return;
      }
    }
    await this.detectExternalSeriesChanges(context);
    if (['waiting', 'pausedConflict'].includes(context.snapshot.status)) return;
    await this.advanceIfNeeded(context);
    for (const occurrence of Object.values(context.snapshot.occurrences)) if (occurrence.consumed) await this.markConsumed(context, occurrence);
    await this.reconcileDuplicates(context);
    if (context.warning || ['waiting', 'pausedConflict'].includes(context.snapshot.status)) return;
    // A carrier can represent many historical cycles: only its latest binding may write native fields.
    const byCarrier = new Map<string, Occurrence>();
    for (const occurrence of Object.values(context.snapshot.occurrences)) {
      const previous = byCarrier.get(occurrence.carrierNoteId);
      if (!previous || occurrence.occurrenceId === context.snapshot.activeOccurrenceId || (previous.occurrenceId !== context.snapshot.activeOccurrenceId && previous.carrierGeneration < occurrence.carrierGeneration)) byCarrier.set(occurrence.carrierNoteId, occurrence);
    }
    for (const occurrence of byCarrier.values()) {
      const note = await this.gateway.getNote(occurrence.carrierNoteId);
      if (!note || note.deleted_time || note.encryption_applied || note.is_conflict) continue;
      await this.projectOccurrence(context, occurrence, context.snapshot.status === 'active' && context.snapshot.activeOccurrenceId === occurrence.occurrenceId);
    }
  }

  private async detectExternalSeriesChanges(context: SeriesContext): Promise<void> {
    const currentByNote = new Map<string, Occurrence>();
    for (const occurrence of Object.values(context.snapshot.occurrences)) {
      const prior = currentByNote.get(occurrence.carrierNoteId);
      if (!prior || occurrence.occurrenceId === context.snapshot.activeOccurrenceId || (prior.occurrenceId !== context.snapshot.activeOccurrenceId && prior.carrierGeneration < occurrence.carrierGeneration)) currentByNote.set(occurrence.carrierNoteId, occurrence);
    }
    for (const occurrence of currentByNote.values()) {
      const note = await this.gateway.getNote(occurrence.carrierNoteId);
      if (!note || note.deleted_time || note.encryption_applied || note.is_conflict) continue;
      if (occurrence.withdrawn) { if (note.todo_completed || note.todo_due) await this.gateway.patchNote(note.id, { todo_completed: 0, todo_due: 0 }); continue; }
      const projections = context.snapshot.projections.filter(projection => projection.noteId === note.id);
      const latestReceipt = [...projections].reverse().find(projection => projection.readbackHash);
      // A reused successor may still have receipts from before its rewind. Only the
      // latest confirmed write can identify the previous cycle's pending handoff.
      if (note.todo_completed && latestReceipt && latestReceipt.carrierGeneration < occurrence.carrierGeneration && sameNative(latestReceipt.after, note)) continue;
      if (note.todo_completed && occurrence.resolution === 'open' && this.isFuture(effectiveSchedule(occurrence), note.todo_completed)) { await this.correctFuture(note); continue; }
      const baseline = [...projections].reverse().find(projection => projection.carrierGeneration === occurrence.carrierGeneration && projection.readbackHash);
      if (!baseline) continue;
      if (sameNative(baseline.after, note)) continue;
      const afterHash = stableHash(nativeFields(note));
      await this.operation(context, 'ObserveNative', { noteId: note.id, occurrenceId: occurrence.occurrenceId,
        beforeHash: stableHash(baseline.after), afterHash });
      if (!note.is_todo && baseline.after.is_todo) {
        await this.operation(context, 'StopOrDelete', { scope: 'current', occurrenceId: occurrence.occurrenceId });
        this.addDiagnostic('NATIVE_DETACHED', '任务被转为普通笔记，已暂停系列；不会自动转回待办。', context.meta.seriesId, note.id);
        return;
      }
      if ((note.todo_completed || 0) !== baseline.after.todo_completed) {
        if (note.todo_completed) await this.recordPeriodResolution(context, occurrence, 'complete', note.todo_completed);
        else if (occurrence.terminalOpId) await this.reopenCycle(context, occurrence);
      }
      if ((note.todo_due || 0) !== baseline.after.todo_due && !note.todo_completed && occurrence.resolution === 'open')
        await this.operation(context, 'ActOccurrence', { action: 'snooze', occurrenceId: occurrence.occurrenceId, until: note.todo_due || 0 });
    }
  }

  private async reconcileDuplicates(context: SeriesContext): Promise<void> {
    if (context.snapshot.status === 'waiting' || context.snapshot.status === 'pausedConflict') return;
    for (const [occurrenceId, noteIds] of Object.entries(context.snapshot.bindings)) {
      if (noteIds.length < 2) continue;
      const occurrence = context.snapshot.occurrences[occurrenceId];
      if (!occurrence) continue;
      for (const noteId of noteIds) {
        if (noteId === occurrence.carrierNoteId) continue;
        const note = await this.requireNative(noteId);
        const meta = (await this.journal.readCarriers(note)).find(item => item.occurrenceId === occurrenceId && item.seriesId === context.meta.seriesId);
        if (!meta || meta.creationHash !== stableHash({ title: note.title, body: note.body }) || note.todo_completed) {
          context.warning = '重复候选含用户编辑或完成记录，已保留全部内容并暂停推进。';
          context.snapshot.status = 'pausedConflict';
          this.addDiagnostic('EDITED_DUPLICATE', context.warning, context.meta.seriesId, noteId);
          return;
        }
        await this.projector.execute({ noteId, occurrenceId, carrierGeneration: occurrence.carrierGeneration,
          sourceOpId: this.semanticSource(context), phase: `duplicate:${noteId}`, knownProjections: context.snapshot.projections,
          append: async (kind, payload) => { await this.operation(context, kind, payload); } }, { is_todo: 0, todo_due: 0, todo_completed: 0 });
      }
    }
  }

  private async reconcileSingle(context: SingleContext): Promise<void> {
    if (this.findSeries(context.task.noteId)) return;
    const note = await this.gateway.getNote(context.task.noteId);
    if (context.task.managed === false) {
      const deletion = [...context.operations].reverse().find(op => op.kind === 'SingleDelete');
      if (!note || !note.is_todo || note.deleted_time || note.encryption_applied ||
          typeof deletion?.payload.nativeUpdatedTime !== 'number' || note.updated_time <= deletion.payload.nativeUpdatedTime) return;
      // The user explicitly restored/reconverted the native note after deletion.
      // Merely seeing the unchanged pre-delete note after a failed DELETE is not restoration.
      await this.singleOperation(context, 'SinglePatch', { patch: { managed: true, completedAt: note.todo_completed || 0,
        reminderOverride: note.todo_due || 0 } });
    }
    if (!note || note.deleted_time || note.encryption_applied) { this.addDiagnostic('SINGLE_MISSING', '任务笔记正在等待同步或已删除，不会自动重建。', context.meta.seriesId, context.task.noteId); return; }
    if (note.todo_completed && !context.task.completedAt && this.isFuture(context.task.schedule, note.todo_completed)) { await this.correctFuture(note); return; }
    const projections = context.operations.filter(operation => operation.kind === 'SingleProjectionIntent' || operation.kind === 'SingleProjectionReceipt').map(operation => operation.payload as ProjectionPayload);
    const latest = [...projections].reverse().find(projection => projection.readbackHash);
    if (latest && !sameNative(latest.after, note)) {
      const afterHash = stableHash(nativeFields(note));
      const observed = context.operations.some(operation => operation.kind === 'SingleObserve' && operation.payload.afterHash === afterHash && operation.payload.beforeHash === stableHash(latest.after));
      if (!observed) {
        await this.singleOperation(context, 'SingleObserve', { beforeHash: stableHash(latest.after), afterHash });
        if (!note.is_todo) {
          await this.singleOperation(context, 'SingleDelete', { detached: true, nativeUpdatedTime: note.updated_time });
          return;
        }
        const patch: Partial<Task> = {};
        if ((note.todo_completed || 0) !== latest.after.todo_completed) { patch.completedAt = note.todo_completed || 0; patch.resolution = note.todo_completed ? 'completed' : 'open'; }
        if ((note.todo_due || 0) !== latest.after.todo_due) patch.reminderOverride = note.todo_due || 0;
        if (Object.keys(patch).length) await this.singleOperation(context, 'SinglePatch', { patch });
      }
    }
    const desired = singleNativeFields(context.task, this.calendar);
    if (latest && sameNative(note, desired) && sameNative(latest.after, desired)) return;
    const source = [...context.operations].reverse().find(operation => ['SingleCreate', 'SinglePatch', 'SingleDelete'].includes(operation.kind));
    if (!source) return;
    const updated = await this.projector.execute({ noteId: note.id, occurrenceId: context.task.taskId, carrierGeneration: 0,
      sourceOpId: source.opId, phase: `single-fields:${stableHash(context.operations.filter(op => ['SingleCreate', 'SinglePatch', 'SingleDelete'].includes(op.kind)).map(op => op.opId).sort())}`, knownProjections: projections,
      append: async (kind, payload) => { await this.singleOperation(context, kind === 'ProjectionIntent' ? 'SingleProjectionIntent' : 'SingleProjectionReceipt', payload); } }, desired);
    this.native.set(updated.id, updated);
  }
}
