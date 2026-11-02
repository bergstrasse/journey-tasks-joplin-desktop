import { isLanguagePreference, type LanguagePreference } from '../../i18n';
import { JoplinApiLike, StorageError } from './gateway';
import { LOCAL_SETTINGS_PREFIX } from '../../shared/pluginIdentity';
import { CURRENT_STORAGE_VERSION } from '../../shared/storageVersion';

export interface LocalIntent {
  storageVersion?: number;
  id: string;
  controlNoteId: string;
  phase: string;
  operation?: unknown;
  create?: { noteId: string; input: Record<string, unknown>; role: string };
  updatedAt: number;
  attempts: number;
  lastError?: string;
  result?: unknown;
  command?: unknown;
  sourceOpId?: string;
  seriesMove?: { seriesId: string; notebookId: string; noteIds: string[] };
}
export interface DeviceState { deviceId: string; nextSeq: number; }
export type ViewId = import('../../shared/models').ViewKind;
export type ListSort = 'nameAsc' | 'nameDesc' | 'createdAsc' | 'createdDesc' | 'scheduledAsc' | 'scheduledDesc';
export interface ViewPreferences {
  listSort?: ListSort;
  notebookIds?: string[];
  listGrouping?: 'time' | 'notebook';
  listOrder?: 'ascending' | 'descending';
  quickAddDate?: string;
  quickAddNotebookId?: string;
  displayCalendar?: 'solar' | 'lunar';
  defaultCalendar?: 'solar' | 'lunar';
  timeFormat?: '24h' | '12h';
  language: LanguagePreference;
  startupMode: 'fixed' | 'restore';
  defaultView: ViewId;
  lastView: ViewId;
  showCompleted: boolean;
  overdueToday: boolean;
  overdueTomorrow: boolean;
  overdueSeven: boolean;
}
export const defaultPreferences: ViewPreferences = {
  listSort: 'scheduledAsc', displayCalendar: 'solar', defaultCalendar: 'solar', timeFormat: '24h', showCompleted: false, language: 'auto', startupMode: 'fixed', defaultView: 'today', lastView: 'today', overdueToday: true, overdueTomorrow: true, overdueSeven: true,
};
const prefix = LOCAL_SETTINGS_PREFIX;
const shards = 16;
// Deduplication is a bounded window, separate from unfinished recovery intents.
const REQUEST_RESULTS_PER_SHARD = 32;
export const REQUEST_RESULT_TTL_MS = 24 * 60 * 60 * 1000;

export class LocalIntentStore {
  private readonly shardCache = new Map<string, string>();
  private deviceCache?: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly api: JoplinApiLike, private readonly randomId: () => string,
    private readonly now: () => number = Date.now) {}

  async initialize(): Promise<void> {
    const definitions: Record<string, any> = {
      [prefix + 'cleanup']: { value: '', type: 2, public: false, label: '数据清理恢复' },
      [prefix + 'device']: { value: '', type: 2, public: false, label: '设备身份' },
      [prefix + 'preferences']: { value: JSON.stringify(defaultPreferences), type: 2, public: false, label: '本机视图偏好' },
    };
    for (let i = 0; i < shards; i++) definitions[prefix + `outbox.${i}`] = { value: '{}', type: 2, public: false, label: `恢复日志 ${i}` };
    await this.api.settings.registerSettings(definitions);
    await this.run(async () => {
      const raw = await this.api.settings.value(prefix + 'device');
      const device = raw || JSON.stringify({ deviceId: this.randomId(), nextSeq: 1 });
      this.parseDevice(device);
      if (!raw) await this.api.settings.setValue(prefix + 'device', device);
      this.deviceCache = device;
      // Reclaim completed requests from older builds before admitting any command.
      for (let i = 0; i < shards; i++) {
        const key = prefix + `outbox.${i}`;
        const values = this.parseShard(await this.api.settings.value(key));
        if (this.pruneRequests(values)) await this.api.settings.setValue(key, JSON.stringify(values));
        this.shardCache.set(key, JSON.stringify(values));
      }
    });
  }
  async nextId(): Promise<{ opId: string; deviceId: string; deviceSeq: number }> {
    return this.run(async () => {
      const device = this.parseDevice(this.deviceCache ?? await this.api.settings.value(prefix + 'device'));
      const sequence = device.nextSeq;
      const saved = JSON.stringify({ ...device, nextSeq: sequence + 1 });
      await this.api.settings.setValue(prefix + 'device', saved);
      this.deviceCache = saved;
      return { opId: `${device.deviceId}:${sequence.toString().padStart(12, '0')}:${this.randomId().slice(0, 12)}`, deviceId: device.deviceId, deviceSeq: sequence };
    });
  }
  async put(intent: LocalIntent): Promise<void> {
    await this.run(async () => {
      const key = this.shardKey(intent.id);
      const values = this.parseShard(this.shardCache.get(key) ?? await this.api.settings.value(key));
      this.pruneRequests(values);
      if (!values[intent.id] && Object.keys(values).length >= 512) {
        // Recovery work takes precedence over even a recent deduplication receipt.
        const disposable = Object.values(values).filter(value => value.storageVersion === CURRENT_STORAGE_VERSION && value.phase === 'request-saved')
          .sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (disposable) delete values[disposable.id];
      }
      if (!values[intent.id] && Object.keys(values).length >= 512) throw new StorageError('OUTBOX_CAPACITY', '本机恢复日志已满，请先备份并处理同步诊断；不会静默删除恢复记录。');
      const saved = { ...intent, storageVersion: CURRENT_STORAGE_VERSION, updatedAt: this.now() };
      // Creation bodies are recovery input only, never a lasting template store.
      if (saved.phase === 'request-saved') delete saved.command;
      if (['root-saved', 'carrier-saved', 'template-saved', 'control-saved'].includes(saved.phase)) {
        delete saved.create;
        delete saved.command;
      }
      values[intent.id] = saved;
      this.pruneRequests(values, intent.id);
      await this.api.settings.setValue(key, JSON.stringify(values));
      this.shardCache.set(key, JSON.stringify(values));
    });
  }
  async remove(id: string): Promise<void> {
    await this.run(async () => {
      const key = this.shardKey(id);
      const values = this.parseShard(this.shardCache.get(key) ?? await this.api.settings.value(key));
      delete values[id];
      await this.api.settings.setValue(key, JSON.stringify(values));
      this.shardCache.set(key, JSON.stringify(values));
    });
  }
  async all(): Promise<LocalIntent[]> {
    return this.run(async () => {
      const result: LocalIntent[] = [];
      for (let i = 0; i < shards; i++) {
        const key = prefix + `outbox.${i}`;
        result.push(...Object.values(this.parseShard(this.shardCache.get(key) ?? await this.api.settings.value(key))));
      }
      return result.filter(intent => intent.storageVersion === CURRENT_STORAGE_VERSION).sort((a, b) => a.id.localeCompare(b.id));
    });
  }

  async preferences(): Promise<ViewPreferences> {
    const raw = await this.api.settings.value(prefix + 'preferences');
    try {
      const value = JSON.parse(raw || '{}');
      const validViews = ['today', 'tomorrow', 'sevenDays', 'inbox', 'all', 'day', 'week', 'month', 'year'];
      for (const key of ['showCompleted', 'overdueToday', 'overdueTomorrow', 'overdueSeven']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error();
      validateCalendarPreference(value);
      validateTimeFormat(value);
      validateQuickAddPreferences(value);
      validateListPreferences(value);
      if (value.language !== undefined && !isLanguagePreference(value.language)) throw new Error();
      if (value.startupMode && !['fixed', 'restore'].includes(value.startupMode)) throw new Error();
      if (value.defaultView && !validViews.includes(value.defaultView)) throw new Error();
      if (value.lastView && !validViews.includes(value.lastView)) throw new Error();
      return { ...defaultPreferences, ...value, listSort: value.listSort ?? (value.listOrder === 'descending' ? 'scheduledDesc' : 'scheduledAsc') };
    } catch { throw new StorageError('LOCAL_PREFERENCES', '本机视图偏好损坏，未自动覆盖。'); }
  }
  async savePreferences(patch: Partial<ViewPreferences>): Promise<ViewPreferences> {
    validateCalendarPreference(patch);
    validateTimeFormat(patch);
    validateQuickAddPreferences(patch);
    validateListPreferences(patch);
    if (patch.language !== undefined && !isLanguagePreference(patch.language)) throw new StorageError('INVALID_LANGUAGE', '不支持的界面语言。');
    const value = { ...await this.preferences(), ...patch };
    await this.api.settings.setValue(prefix + 'preferences', JSON.stringify(value));
    return this.preferences();
  }
  async cleanupPending(): Promise<boolean> { return !!await this.api.settings.value(prefix + 'cleanup'); }
  async cleanupState<T>(): Promise<T | undefined> {
    const raw = await this.api.settings.value(prefix + 'cleanup');
    if (!raw) return undefined;
    try { return JSON.parse(raw) as T; }
    catch { throw new StorageError('CLEANUP_STATE', '清理恢复记录无法解析，已暂停业务写入。'); }
  }
  async setCleanupState(value: unknown | undefined): Promise<void> {
    await this.api.settings.setValue(prefix + 'cleanup', value === undefined ? '' : JSON.stringify(value));
  }
  async clearOutbox(): Promise<void> {
    await this.run(async () => {
      for (let i = 0; i < shards; i++) {
        const key = prefix + `outbox.${i}`;
        await this.api.settings.setValue(key, '{}');
        this.shardCache.set(key, '{}');
      }
    });
  }
  async reset(): Promise<void> {
    await this.clearOutbox();
    await this.api.settings.setValue(prefix + 'preferences', JSON.stringify(defaultPreferences));
    const saved = JSON.stringify({ deviceId: this.randomId(), nextSeq: 1 });
    await this.api.settings.setValue(prefix + 'device', saved);
    this.deviceCache = saved;
  }
  private pruneRequests(values: Record<string, LocalIntent>, keepId?: string): boolean {
    const cutoff = this.now() - REQUEST_RESULT_TTL_MS;
    const completed = Object.values(values).filter(intent => intent.storageVersion === CURRENT_STORAGE_VERSION &&
      intent.phase === 'request-saved').reverse().sort((a, b) =>
        Number(b.id === keepId) - Number(a.id === keepId) || b.updatedAt - a.updatedAt);
    let changed = false, retained = 0;
    for (const intent of completed) {
      if (intent.id !== keepId && (intent.updatedAt < cutoff || retained >= REQUEST_RESULTS_PER_SHARD)) {
        delete values[intent.id]; changed = true;
      } else retained++;
    }
    return changed;
  }
  private parseDevice(raw: string): DeviceState {
    try {
      const value = JSON.parse(raw);
      if (typeof value.deviceId !== 'string' || !Number.isSafeInteger(value.nextSeq) || value.nextSeq < 1) throw new Error();
      return value;
    } catch { throw new StorageError('LOCAL_DEVICE', '本机恢复身份损坏，不能安全分配操作编号。'); }
  }
  private parseShard(raw: string): Record<string, LocalIntent> {
    try {
      const value = JSON.parse(raw || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      for (const [id, intent] of Object.entries(value) as [string, LocalIntent][]) {
        if (intent.id !== id || typeof intent.controlNoteId !== 'string' || typeof intent.phase !== 'string') throw new Error();
      }
      return value;
    } catch { throw new StorageError('LOCAL_OUTBOX', '本机恢复日志损坏，已暂停操作并保留原文。'); }
  }
  private shardKey(id: string): string {
    let value = 0;
    for (const char of id) value = ((value * 31) + char.charCodeAt(0)) >>> 0;
    return prefix + `outbox.${value % shards}`;
  }
  private async run<T>(action: () => Promise<T>): Promise<T> {
    const current = this.tail.catch(() => undefined).then(action);
    this.tail = current;
    return current;
  }
}

function validateQuickAddPreferences(value: Partial<ViewPreferences>): void {
  const date = value.quickAddDate;
  if (date !== undefined && (typeof date !== 'string' || (!['today', 'tomorrow', 'none'].includes(date) &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)))) {
    throw new StorageError('LOCAL_PREFERENCES', '本机视图偏好损坏，未自动覆盖。');
  }
  if (value.quickAddNotebookId !== undefined && typeof value.quickAddNotebookId !== 'string') {
    throw new StorageError('LOCAL_PREFERENCES', '本机视图偏好损坏，未自动覆盖。');
  }
}

function validateListPreferences(value: Partial<ViewPreferences>): void {
  if ((value.listSort !== undefined && !['nameAsc', 'nameDesc', 'createdAsc', 'createdDesc', 'scheduledAsc', 'scheduledDesc'].includes(value.listSort)) ||
      (value.notebookIds !== undefined && (!Array.isArray(value.notebookIds) || value.notebookIds.some(id => typeof id !== 'string')))) {
    throw new StorageError('LOCAL_PREFERENCES', '本机视图偏好损坏，未自动覆盖。');
  }
  if ((value.listGrouping !== undefined && !['time', 'notebook'].includes(value.listGrouping)) ||
      (value.listOrder !== undefined && !['ascending', 'descending'].includes(value.listOrder))) {
    throw new StorageError('LOCAL_PREFERENCES', '本机视图偏好损坏，未自动覆盖。');
  }
}

function validateCalendarPreference(value: Partial<ViewPreferences>): void {
  if (value.displayCalendar !== undefined && !['solar', 'lunar'].includes(value.displayCalendar))
    throw new StorageError('INVALID_CALENDAR', '不支持的默认日历。');
  if (value.defaultCalendar !== undefined && !['solar', 'lunar'].includes(value.defaultCalendar))
    throw new StorageError('INVALID_CALENDAR', '不支持的默认日历。');
}

function validateTimeFormat(value: Partial<ViewPreferences>): void {
  if (value.timeFormat !== undefined && !['24h', '12h'].includes(value.timeFormat))
    throw new StorageError('INVALID_TIME_FORMAT', '不支持的时间显示格式。');
}
