import { JoplinGateway, NativeNote, NOTE_TYPE, StorageError } from './gateway';

export interface UserDataEntry { v: unknown; t: number; d?: number; }

/** Read only this plugin's namespace. Unknown envelopes fail closed, never as an empty journal. */
export function readNamespace(raw: string | undefined, pluginId: string): Record<string, UserDataEntry> {
  if (!raw) return {};
  let root: unknown;
  try { root = JSON.parse(raw); }
  catch { throw new StorageError('USERDATA_FORMAT', '插件数据无法解析，已停止写入。'); }
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new StorageError('USERDATA_FORMAT', '插件数据封装格式未知。');
  const namespace = (root as Record<string, unknown>)[pluginId];
  if (namespace === undefined) return {};
  if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) throw new StorageError('USERDATA_FORMAT', '插件命名空间格式未知。');
  for (const [key, entry] of Object.entries(namespace)) {
    if (!entry || typeof entry !== 'object' || !('t' in entry) || typeof (entry as UserDataEntry).t !== 'number' ||
        (!('v' in entry) && !(entry as UserDataEntry).d)) {
      throw new StorageError('USERDATA_FORMAT', '插件数据键格式未知。', { key });
    }
  }
  return namespace as Record<string, UserDataEntry>;
}

export class UserDataStore {
  private namespaces = new Map<string, { raw: string | undefined; entries: Record<string, UserDataEntry> }>();
  private namespace(note: NativeNote): Record<string, UserDataEntry> {
    const previous = this.namespaces.get(note.id);
    if (previous && previous.raw === note.user_data) return previous.entries;
    const entries = readNamespace(note.user_data, this.pluginId);
    this.namespaces.set(note.id, { raw: note.user_data, entries });
    return entries;
  }
  private cache = new Map<string, { envelope: string; value: unknown }>();
  private queues = new Map<string, Promise<unknown>>();
  constructor(private readonly gateway: JoplinGateway, readonly pluginId: string,
    private readonly canonical: (value: unknown) => string = JSON.stringify) {}

  async get<T>(id: string, key: string): Promise<T | undefined> {
    return this.gateway.api.data.userDataGet<T>(NOTE_TYPE, id, key);
  }
  /** Cache against the complete host envelope, so sync edits/tombstones invalidate it. */
  async fromNote<T>(note: NativeNote, key: string): Promise<T | undefined> {
    const entry = this.namespace(note)[key];
    const cacheKey = JSON.stringify([note.id, key]);
    if (!entry || entry.d) { this.cache.delete(cacheKey); return undefined; }
    const envelope = this.canonical(entry);
    const cached = this.cache.get(cacheKey);
    if (cached?.envelope === envelope) return JSON.parse(JSON.stringify(cached.value)) as T;
    const value = await this.get<T>(note.id, key);
    // A concurrent host edit is retried on the next snapshot, never cached as this envelope.
    if (value !== undefined && this.canonical(value) === this.canonical(entry.v)) {
      this.cache.set(cacheKey, { envelope, value: JSON.parse(JSON.stringify(value)) });
    }
    return value;
  }
  async keys(note: NativeNote): Promise<string[]> {
    return Object.entries(this.namespace(note)).filter(([, entry]) => !entry.d).map(([key]) => key);
  }
  async entries<T>(note: NativeNote, prefix: string): Promise<T[]> {
    const values: T[] = [];
    for (const key of (await this.keys(note)).filter(key => key.startsWith(prefix)).sort()) {
      const value = await this.fromNote<T>(note, key);
      if (value === undefined) throw new StorageError('USERDATA_INCOMPLETE', '插件日志在枚举后发生变化，请等待同步并重试。', { noteId: note.id, key });
      values.push(value);
    }
    return values;
  }
  /** Immutable append, with same-ID same-content readback. Does not claim a cross-device CAS. */
  async append(id: string, key: string, value: unknown): Promise<void> {
    return this.serial(id, async () => {
      const before = await this.get(id, key);
      if (before !== undefined && this.canonical(before) !== this.canonical(value)) {
        throw new StorageError('IMMUTABLE_KEY_CONFLICT', '同一日志键包含不同内容，已保留原数据并停止。', { noteId: id, key });
      }
      if (before === undefined) {
        this.gateway.changedNoteIds.add(id);
        await this.gateway.api.data.userDataSet(NOTE_TYPE, id, key, value);
      }
      const after = await this.get(id, key);
      if (after === undefined || this.canonical(after) !== this.canonical(value)) throw new StorageError('USERDATA_READBACK', '日志写入读回不一致，保留本机恢复记录。', { noteId: id, key });
    });
  }
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.queues.set(key, current);
    try { return await current; }
    finally { if (this.queues.get(key) === current) this.queues.delete(key); }
  }
}
